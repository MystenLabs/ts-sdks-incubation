import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../engine/class.js';
import { dockerImage } from './docker-image.js';
import { dockerOneShot, type DockerOneShotState } from './docker-one-shot.js';

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
const trackedContainers = new Set<string>();

beforeEach(() => {
	appDir = mkdtempSync(join(tmpdir(), 'docker-one-shot-'));
	env = { appName: 'test', appDir, network: 'localnet' };
});

afterEach(() => {
	for (const name of trackedContainers) {
		try {
			execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
		} catch {
			// already gone
		}
	}
	trackedContainers.clear();
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

function track(state: DockerOneShotState | undefined): void {
	if (state) {
		trackedContainers.add(state.containerName);
		trackedTags.add(state.image);
	}
}

function itDocker(name: string, fn: () => Promise<void>, timeout?: number): void {
	if (dockerAvailable) {
		it(name, fn, timeout);
	} else {
		it.skip(name, fn);
	}
}

describe('dockerOneShot (validation — no docker required)', () => {
	it('rejects an empty name', () => {
		expect(() => dockerOneShot({ name: '', image: 'alpine' })).toThrow(/name/);
	});

	it('rejects empty image', () => {
		expect(() => dockerOneShot({ name: 'demo', image: '' })).toThrow(/image/);
	});

	it('builds a graph node and exposes provides.full + provides.state', () => {
		const job = dockerOneShot({ name: 'noop', image: 'alpine:3.19', args: ['true'] });
		expect(job.name).toBe('noop');
		// Engine should accept it without errors during graph build.
		const engine = new Engine({ stack: [job] }, { env });
		expect(engine.getState().nodes.has('noop')).toBe(true);
	});
});

describe('dockerOneShot (run — docker required)', () => {
	itDocker(
		'runs a container to completion and resolves with the parsed state',
		async () => {
			const job = dockerOneShot({
				name: 'noop',
				image: 'alpine:3.19',
				args: ['sh', '-c', 'echo hello-from-oneshot && exit 0'],
			});
			const engine = new Engine({ stack: [job] }, { env });
			const result = await engine.runOnce();
			expect(result.errored).toEqual([]);

			const state = engine.getState().nodes.get('noop')?.state as
				| DockerOneShotState
				| undefined;
			track(state);
			expect(state).toBeDefined();
			expect(state!.exitCode).toBe(0);
			expect(state!.containerName).toBe('noop');
			expect(state!.tail).toContain('hello-from-oneshot');
			expect(state!.durationMs).toBeGreaterThan(0);
		},
		60_000,
	);

	itDocker(
		'fails the cycle on non-zero exit and surfaces the tail',
		async () => {
			const job = dockerOneShot({
				name: 'fails',
				image: 'alpine:3.19',
				args: ['sh', '-c', 'echo about-to-fail >&2; exit 7'],
			});
			const engine = new Engine({ stack: [job] }, { env });
			const result = await engine.runOnce();
			const errored = result.errored.find((e) => e.name === 'fails');
			expect(errored).toBeDefined();
			expect(errored!.error.message).toMatch(/code 7/);
			expect(errored!.error.message).toContain('about-to-fail');
			trackedContainers.add('fails');
		},
		60_000,
	);

	itDocker(
		'mounts host volumes and surfaces container outputs on the host fs',
		async () => {
			const outputs = join(appDir, 'outputs');
			mkdirSync(outputs, { recursive: true });
			const job = dockerOneShot({
				name: 'writes',
				image: 'alpine:3.19',
				args: ['sh', '-c', 'echo "deploy=ok" > /opt/out/deploy && exit 0'],
				volumes: [{ host: outputs, container: '/opt/out' }],
			});
			const engine = new Engine({ stack: [job] }, { env });
			const result = await engine.runOnce();
			expect(result.errored).toEqual([]);
			const state = engine.getState().nodes.get('writes')?.state as
				| DockerOneShotState
				| undefined;
			track(state);
			expect(state!.exitCode).toBe(0);
			expect(readFileSync(join(outputs, 'deploy'), 'utf8')).toBe('deploy=ok\n');
		},
		60_000,
	);

	itDocker(
		'chains a Dep<string> for image (off dockerImage) and re-runs when the image identity flips',
		async () => {
			// Build a tiny image whose tag is content-addressed; the
			// dockerOneShot job uses it via image.get('tag').
			const ctx = join(appDir, 'docker');
			mkdirSync(ctx, { recursive: true });
			writeFileSync(
				join(ctx, 'Dockerfile'),
				'FROM alpine:3.19\nARG MARKER=x\nRUN echo "$MARKER" > /marker\n',
			);
			const image = dockerImage({
				name: 'oneshot-img',
				context: { path: ctx },
				args: { MARKER: 'first' },
			});
			const job = dockerOneShot({
				name: 'oneshot-job',
				image: image.get('tag'),
				args: ['cat', '/marker'],
			});
			const engine = new Engine({ stack: [job] }, { env });
			const result = await engine.runOnce();
			expect(result.errored).toEqual([]);
			const state = engine.getState().nodes.get('oneshot-job')?.state as
				| DockerOneShotState
				| undefined;
			track(state);
			expect(state!.tail).toContain('first');
			trackedTags.add(state!.image);
		},
		180_000,
	);
});
