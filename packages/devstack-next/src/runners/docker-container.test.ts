import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { Engine } from '../engine/class.js';
import { dockerContainer, type DockerContainerState } from './docker-container.js';
import { dockerImage, type DockerImageState } from './docker-image.js';

// Determine docker availability synchronously at module load — `itDocker`
// is called during suite definition, before any beforeAll hooks fire.
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
const trackedContainers = new Set<string>();

beforeEach(() => {
	appDir = mkdtempSync(join(tmpdir(), 'docker-runner-'));
	env = { appName: 'test', appDir, network: 'localnet' };
});

afterEach(async () => {
	for (const id of trackedContainers) {
		try {
			execFileSync('docker', ['rm', '-f', id], { stdio: 'ignore' });
		} catch {
			// already gone
		}
	}
	trackedContainers.clear();
	rmSync(appDir, { recursive: true, force: true });
});

function trackContainer(id: string | undefined): void {
	if (id) trackedContainers.add(id);
}

function itDocker(name: string, fn: () => Promise<void>, timeout?: number): void {
	if (dockerAvailable) {
		it(name, fn, timeout);
	} else {
		it.skip(name, fn);
	}
}

describe('dockerContainer', () => {
	itDocker(
		'spawns a container, captures id + image into state',
		async () => {
			const node = dockerContainer({
				name: 'sleeper',
				image: 'alpine:latest',
				args: ['sleep', '60'],
			});

			const engine = new Engine({ stack: [node] }, { env });
			await engine.runOnce();

			const view = engine.getState().nodes.get('sleeper');
			const state = view?.state as DockerContainerState | undefined;
			expect(state).toBeDefined();
			expect(state?.containerId).toMatch(/^[0-9a-f]{12,}$/);
			expect(state?.image).toBe('alpine:latest');
			trackContainer(state?.containerId);

			await engine.stop();
			// After stop, the container should be removed.
			if (state?.containerId) {
				const isRunning = await checkRunning(state.containerId);
				expect(isRunning).toBe(false);
			}
		},
		60_000,
	);

	itDocker(
		'auto-injects port deps and exposes hostPorts in state',
		async () => {
			const node = dockerContainer({
				name: 'echo-server',
				image: 'alpine:latest',
				args: ['sleep', '60'],
				ports: [{ slot: 'echo.tcp', containerPort: 7000 }],
			});

			const engine = new Engine({ stack: [node] }, { env });
			await engine.runOnce();

			const state = engine.getState().nodes.get('echo-server')?.state as
				| DockerContainerState
				| undefined;
			trackContainer(state?.containerId);

			expect(state?.hostPorts['echo.tcp']).toBeGreaterThan(0);
			expect(state?.hostPorts['echo.tcp']).toBeLessThan(65536);

			// `ports` standard node should also have an entry for this slot.
			const portsView = engine.getState().nodes.get('ports');
			const portsState = portsView?.state as { map: Record<string, number> } | undefined;
			expect(portsState?.map['echo.tcp']).toBe(state?.hostPorts['echo.tcp']);

			await engine.stop();
		},
		60_000,
	);

	itDocker(
		'reuses prior container on warm restart if it is still running',
		async () => {
			const node = dockerContainer({
				name: 'reuse',
				image: 'alpine:latest',
				args: ['sleep', '60'],
			});

			const engine = new Engine({ stack: [node] }, { env });
			await engine.runOnce();
			const firstId = (engine.getState().nodes.get('reuse')?.state as DockerContainerState)
				.containerId;
			trackContainer(firstId);

			engine.invalidate('reuse');
			await engine.runOnce();
			const secondId = (engine.getState().nodes.get('reuse')?.state as DockerContainerState)
				.containerId;

			expect(secondId).toBe(firstId);

			await engine.stop();
		},
		60_000,
	);

	itDocker(
		'accepts a Dep<string> for image (chains off dockerImage)',
		async () => {
			// Build a tiny image, then chain a container onto it via the
			// dockerImage producer's `tag` Dep.
			const ctx = join(appDir, 'docker');
			execFileSync('mkdir', ['-p', ctx]);
			writeFileSync(join(ctx, 'Dockerfile'), 'FROM alpine:3.19\n');
			const img = dockerImage({ name: 'depchain', context: { path: 'docker' } });
			const container = dockerContainer({
				name: 'depchain.container',
				image: img.get('tag'),
				args: ['sleep', '60'],
			});

			const engine = new Engine({ stack: [container] }, { env });
			const result = await engine.runOnce();
			expect(result.errored).toEqual([]);

			const imgState = engine.getState().nodes.get('depchain')?.state as
				| DockerImageState
				| undefined;
			const cState = engine.getState().nodes.get('depchain.container')?.state as
				| DockerContainerState
				| undefined;
			expect(imgState?.tag).toMatch(/^devstack\/depchain:[0-9a-f]{12}$/);
			expect(cState?.image).toBe(imgState?.tag);
			trackContainer(cState?.containerId);
			// Track the image too so afterEach cleans it up.
			if (imgState?.tag) {
				try {
					execFileSync('docker', ['image', 'rm', '-f', imgState.tag], { stdio: 'ignore' });
				} catch {
					// best-effort
				}
			}

			await engine.stop();
		},
		120_000,
	);

	itDocker(
		'errors and removes the container when readyProbe times out',
		async () => {
			const node = dockerContainer({
				name: 'never-ready',
				image: 'alpine:latest',
				args: ['sleep', '60'],
				readyProbe: () => false,
				readyTimeoutMs: 250,
				readyPollIntervalMs: 50,
			});

			const engine = new Engine({ stack: [node] }, { env });
			const result = await engine.runOnce();

			const errored = result.errored.find((e) => e.name === 'never-ready');
			expect(errored).toBeDefined();
			expect(errored?.error.message).toMatch(/readyProbe did not return true/);
		},
		60_000,
	);
});

async function checkRunning(containerId: string): Promise<boolean> {
	try {
		const out = execFileSync('docker', ['inspect', '-f', '{{.State.Running}}', containerId], {
			encoding: 'utf8',
		}).trim();
		return out === 'true';
	} catch {
		return false;
	}
}
