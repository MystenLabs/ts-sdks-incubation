import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../engine/class.js';
import { dockerContainer, type DockerContainerState } from './docker-container.js';
import {
	dockerNetwork,
	dockerNetworkOctet,
	type DockerNetworkState,
} from './docker-network.js';

const dockerAvailable = (() => {
	try {
		execFileSync('docker', ['info'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
})();

let appDir: string;
let env: { appName: string; appDir: string; network: string; stack: string };
const trackedNetworks = new Set<string>();
const trackedContainers = new Set<string>();

beforeEach(() => {
	appDir = mkdtempSync(join(tmpdir(), 'docker-network-'));
	// A unique appName per test run keeps the deterministic-octet hash
	// from colliding with another developer's stack on the same host.
	env = {
		appName: `dn-test-${Math.random().toString(36).slice(2, 8)}`,
		appDir,
		network: 'localnet',
		stack: 'main',
	};
});

afterEach(() => {
	for (const id of trackedContainers) {
		try {
			execFileSync('docker', ['rm', '-f', id], { stdio: 'ignore' });
		} catch {
			// best-effort
		}
	}
	trackedContainers.clear();
	for (const name of trackedNetworks) {
		try {
			execFileSync('docker', ['network', 'rm', name], { stdio: 'ignore' });
		} catch {
			// best-effort
		}
	}
	trackedNetworks.clear();
	rmSync(appDir, { recursive: true, force: true });
});

function track(state: DockerNetworkState | undefined): void {
	if (state) trackedNetworks.add(state.name);
}

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

describe('dockerNetworkOctet (pure)', () => {
	it('produces a stable octet in [1, 250]', () => {
		const octet = dockerNetworkOctet('foo', 'main');
		expect(octet).toBeGreaterThanOrEqual(1);
		expect(octet).toBeLessThanOrEqual(250);
	});

	it('is deterministic for the same (app, stack) pair', () => {
		const a = dockerNetworkOctet('app-x', 'default');
		const b = dockerNetworkOctet('app-x', 'default');
		expect(a).toBe(b);
	});

	it('differs across distinct (app, stack) pairs', () => {
		// Two carefully picked names whose hash modulo lands in different
		// buckets — pin a regression so a future hash tweak doesn't
		// silently collapse all stacks onto one octet.
		const a = dockerNetworkOctet('alpha', 'main');
		const b = dockerNetworkOctet('beta', 'main');
		expect(a).not.toBe(b);
	});
});

describe('dockerNetwork (graph shape — no docker required)', () => {
	it('is exported as a singleton — same `__id` across imports', () => {
		expect(dockerNetwork.name).toBe('docker.network');
		expect(typeof dockerNetwork.get).toBe('function');
	});

	it('appears in the graph when a consumer Deps on `name`', () => {
		const consumer = dockerContainer({
			name: 'consumer',
			image: 'alpine:3.19',
			args: ['sleep', '60'],
			network: dockerNetwork.get('name'),
		});
		const engine = new Engine({ stack: [consumer] }, { env });
		const state = engine.getState();
		expect(state.nodes.has('docker.network')).toBe(true);
		expect(state.nodes.has('consumer')).toBe(true);
	});
});

describe('dockerNetwork (run — docker required)', () => {
	itDocker(
		'creates a per-(app, stack) network with the deterministic /24 subnet',
		async () => {
			const engine = new Engine({ stack: [dockerNetwork] }, { env });
			const result = await engine.runOnce();
			expect(result.errored).toEqual([]);

			const state = engine.getState().nodes.get('docker.network')?.state as
				| DockerNetworkState
				| undefined;
			track(state);
			expect(state).toBeDefined();
			expect(state!.name).toBe(`${env.appName}-main`);
			const expectedOctet = dockerNetworkOctet(env.appName, 'main');
			expect(state!.subnet).toBe(`10.${expectedOctet}.0.0/24`);
			expect(state!.octet).toBe(expectedOctet);

			// Network actually exists in docker.
			const probe = execFileSync(
				'docker',
				['network', 'inspect', '--format', '{{json .IPAM.Config}}', state!.name],
				{ encoding: 'utf8' },
			);
			expect(probe).toContain(`"Subnet":"10.${expectedOctet}.0.0/24"`);

			await engine.stop();
			// After stop, the network should be gone.
			let exists = true;
			try {
				execFileSync('docker', ['network', 'inspect', state!.name], { stdio: 'ignore' });
			} catch {
				exists = false;
			}
			expect(exists).toBe(false);
			trackedNetworks.delete(state!.name);
		},
		60_000,
	);

	itDocker(
		'sibling containers reach each other by `--network-alias` over the network',
		async () => {
			// Two alpine containers on the same network. Sibling A binds
			// `--network-alias=peer-a`; sibling B has the same alias for
			// itself. Verify that B can ping A by alias from inside its
			// network namespace via `docker exec`.
			const a = dockerContainer({
				name: 'peer-a',
				image: 'alpine:3.19',
				args: ['sleep', '60'],
				network: dockerNetwork.get('name'),
				networkAlias: 'peer-a',
			});
			const b = dockerContainer({
				name: 'peer-b',
				image: 'alpine:3.19',
				args: ['sleep', '60'],
				network: dockerNetwork.get('name'),
				networkAlias: 'peer-b',
			});
			const engine = new Engine({ stack: [a, b] }, { env });
			const result = await engine.runOnce();
			expect(result.errored).toEqual([]);

			const aState = engine.getState().nodes.get('peer-a')?.state as
				| DockerContainerState
				| undefined;
			const bState = engine.getState().nodes.get('peer-b')?.state as
				| DockerContainerState
				| undefined;
			const netState = engine.getState().nodes.get('docker.network')?.state as
				| DockerNetworkState
				| undefined;
			track(netState);
			trackContainer(aState?.containerId);
			trackContainer(bState?.containerId);

			expect(aState?.network).toBe(netState?.name);
			expect(bState?.network).toBe(netState?.name);

			// `getent hosts peer-a` resolves the network-alias DNS that the
			// per-stack docker bridge serves. Picked over `ping` because
			// alpine:3.19 ships getent in busybox without raising the
			// CAP_NET_RAW question that ping in some envs does.
			const lookup = execFileSync(
				'docker',
				['exec', bState!.containerId, 'getent', 'hosts', 'peer-a'],
				{ encoding: 'utf8' },
			).trim();
			// Subnet is `10.<octet>.0.0/24`; alias resolves into that range.
			expect(lookup).toMatch(new RegExp(`^10\\.${netState!.octet}\\.\\d+\\.\\d+\\s+peer-a`));

			await engine.stop();
			trackedNetworks.delete(netState!.name);
		},
		120_000,
	);

	itDocker(
		'reuses an existing network across warm restarts',
		async () => {
			// First cycle creates the network.
			const engine = new Engine({ stack: [dockerNetwork] }, { env });
			await engine.runOnce();
			const first = engine.getState().nodes.get('docker.network')?.state as
				| DockerNetworkState
				| undefined;
			track(first);
			const firstCreatedAt = first!.createdAt;

			// Force a second cycle. The network already exists with the
			// matching subnet → reuse, createdAt should NOT advance.
			engine.invalidate('docker.network');
			await engine.runOnce();
			const second = engine.getState().nodes.get('docker.network')?.state as
				| DockerNetworkState
				| undefined;
			expect(second!.name).toBe(first!.name);
			expect(second!.createdAt).toBe(firstCreatedAt);

			await engine.stop();
			trackedNetworks.delete(first!.name);
		},
		60_000,
	);
});
