import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../engine/class.js';
import { dockerImage, type DockerImageState } from './docker-image.js';

const dockerAvailable = (() => {
	try {
		execFileSync('docker', ['info'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
})();

let appDir: string;
let env: { appName: string; appDir: string; network: string };
const trackedTags = new Set<string>();

beforeEach(() => {
	appDir = mkdtempSync(join(tmpdir(), 'docker-image-'));
	env = { appName: 'test', appDir, network: 'localnet' };
});

afterEach(() => {
	for (const tag of trackedTags) {
		try {
			execFileSync('docker', ['image', 'rm', '-f', tag], { stdio: 'ignore' });
		} catch {
			// already gone
		}
	}
	trackedTags.clear();
	rmSync(appDir, { recursive: true, force: true });
});

function trackTag(tag: string | undefined): void {
	if (tag) trackedTags.add(tag);
}

function itDocker(name: string, fn: () => Promise<void>, timeout?: number): void {
	if (dockerAvailable) {
		it(name, fn, timeout);
	} else {
		it.skip(name, fn);
	}
}

function writeMinimalDockerfile(dir: string, body = 'FROM alpine:3.19\nRUN echo hi\n'): string {
	const ctx = join(appDir, dir);
	mkdirSync(ctx, { recursive: true });
	writeFileSync(join(ctx, 'Dockerfile'), body);
	return ctx;
}

describe('dockerImage (validation — no docker required)', () => {
	it('rejects an empty name', () => {
		expect(() => dockerImage({ name: '', context: { path: 'docker' } })).toThrow(/name/);
	});

	it('rejects an invalid name (uppercase, slashes)', () => {
		expect(() => dockerImage({ name: 'Foo/Bar', context: { path: 'docker' } })).toThrow(/name/);
	});

	it('rejects an invalid imagePrefix', () => {
		expect(() =>
			dockerImage({ name: 'demo', imagePrefix: 'BAD/PREFIX', context: { path: 'docker' } }),
		).toThrow(/imagePrefix/);
	});

	it('requires `context`', () => {
		// @ts-expect-error — context is required at the type level
		expect(() => dockerImage({ name: 'demo' })).toThrow(/context/);
	});
});

describe('dockerImage (build)', () => {
	itDocker(
		'builds a local-context image and exposes a content-addressed tag',
		async () => {
			writeMinimalDockerfile('docker');
			const img = dockerImage({ name: 'demo', context: { path: 'docker' } });
			const engine = new Engine({ stack: [img] }, { env });
			const result = await engine.runOnce();
			expect(result.errored).toEqual([]);

			const state = engine.getState().nodes.get('demo')?.state as DockerImageState | undefined;
			expect(state).toBeDefined();
			expect(state!.tag).toMatch(/^devstack\/demo:[0-9a-f]{12}$/);
			trackTag(state!.tag);

			// Image should actually exist locally.
			const probe = execFileSync('docker', ['image', 'inspect', state!.tag], {
				stdio: ['ignore', 'pipe', 'ignore'],
				encoding: 'utf8',
			});
			expect(probe).toContain('"Id":');
		},
		120_000,
	);

	itDocker(
		'reuses tag on warm restart when content unchanged',
		async () => {
			writeMinimalDockerfile('docker');
			const img = dockerImage({ name: 'reuse', context: { path: 'docker' } });

			const engine = new Engine({ stack: [img] }, { env });
			await engine.runOnce();
			const first = engine.getState().nodes.get('reuse')?.state as DockerImageState;
			trackTag(first.tag);
			const firstBuiltAt = first.builtAt;

			// Force a second cycle. inputs match → identity unchanged → engine
			// should skip start. Even if start fires, prior.tag matches → reuse.
			engine.invalidate('reuse');
			await engine.runOnce();
			const second = engine.getState().nodes.get('reuse')?.state as DockerImageState;
			expect(second.tag).toBe(first.tag);
			// builtAt should not advance — start saw prior tag still alive.
			expect(second.builtAt).toBe(firstBuiltAt);
		},
		120_000,
	);

	itDocker(
		'rebuilds with a new tag when build args change',
		async () => {
			const ctx = writeMinimalDockerfile(
				'docker',
				'FROM alpine:3.19\nARG MARKER=default\nRUN echo "$MARKER"\n',
			);
			void ctx;

			let marker = 'one';
			const img = dockerImage({
				name: 'argbump',
				context: { path: 'docker' },
				args: () => ({ MARKER: marker }),
			});

			const engine = new Engine({ stack: [img] }, { env });
			await engine.runOnce();
			const first = engine.getState().nodes.get('argbump')?.state as DockerImageState;
			trackTag(first.tag);

			marker = 'two';
			engine.invalidate('argbump');
			await engine.runOnce();
			const second = engine.getState().nodes.get('argbump')?.state as DockerImageState;
			trackTag(second.tag);

			expect(second.tag).not.toBe(first.tag);
			// Different tags → different content hashes → must have actually
			// rebuilt (builtAt advances).
			expect(second.builtAt).toBeGreaterThanOrEqual(first.builtAt);
		},
		180_000,
	);

	itDocker(
		'rebuilds with a new tag when context content changes',
		async () => {
			writeMinimalDockerfile('docker');
			const img = dockerImage({ name: 'cbump', context: { path: 'docker' } });

			const engine = new Engine({ stack: [img] }, { env });
			await engine.runOnce();
			const first = engine.getState().nodes.get('cbump')?.state as DockerImageState;
			trackTag(first.tag);

			// Change context content. Local-tree hash flips → tag flips.
			writeFileSync(join(appDir, 'docker/extra.txt'), 'new file added\n');

			engine.invalidate('cbump');
			await engine.runOnce();
			const second = engine.getState().nodes.get('cbump')?.state as DockerImageState;
			trackTag(second.tag);

			expect(second.tag).not.toBe(first.tag);
		},
		180_000,
	);

	itDocker(
		'buildContexts feed BuildKit named contexts and fold into the tag',
		async () => {
			writeMinimalDockerfile(
				'docker',
				'FROM alpine:3.19\nCOPY --from=extras /payload.txt /payload.txt\nRUN cat /payload.txt\n',
			);
			const extrasA = join(appDir, 'extras-a');
			const extrasB = join(appDir, 'extras-b');
			mkdirSync(extrasA, { recursive: true });
			mkdirSync(extrasB, { recursive: true });
			writeFileSync(join(extrasA, 'payload.txt'), 'payload version A\n');
			writeFileSync(join(extrasB, 'payload.txt'), 'payload version B\n');

			let extras = extrasA;
			const img = dockerImage({
				name: 'bctx',
				context: { path: 'docker' },
				buildContexts: { extras: { path: extras } },
			});
			void img;

			// Rebuild explicitly per cycle by closing over `extras` via a
			// fresh dockerImage producer each time — `buildContexts` is
			// evaluated at producer-construction, not per-start.
			const first = await runOnce({ extras: extrasA });
			trackTag(first.tag);
			const second = await runOnce({ extras: extrasB });
			trackTag(second.tag);

			expect(second.tag).not.toBe(first.tag);

			async function runOnce(opts: { extras: string }): Promise<DockerImageState> {
				const producer = dockerImage({
					name: 'bctx',
					context: { path: 'docker' },
					buildContexts: { extras: { path: opts.extras } },
				});
				const eng = new Engine({ stack: [producer] }, { env });
				const result = await eng.runOnce();
				expect(result.errored).toEqual([]);
				return eng.getState().nodes.get('bctx')!.state as DockerImageState;
			}
		},
		180_000,
	);
});
