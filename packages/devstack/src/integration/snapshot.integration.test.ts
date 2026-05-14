import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { expect } from 'vitest';
import { Engine } from '../engine/class.js';
import { sui, type SuiState } from '../plugins/sui.js';
import type { DockerContainerState } from '../runners/index.js';
import { describeIntegration, itIntegration } from './_helpers.js';

const exec = promisify(execFile);

// End-to-end exercise of chunk 6a (`dockerContainer.snapshot`).
//
// Goal: prove that `engine.saveSnapshot()` captures sui-localnet's
// chain state via `docker commit`, and that loading that
// SnapshotRecord into a fresh engine — after `docker rm`'ing the
// original container — boots the new container from the committed
// tag with chain state intact.
//
// Verification probe: write a marker via `docker exec` into a known
// path inside the writable layer, save, kill, restore, read back.
// We use a probe path the sui binary doesn't touch (under `/var`)
// so the assertion isolates "did the writable layer round-trip"
// from sui-specific concerns.

describeIntegration('snapshot save → reset → restore (sui-localnet, 6a)', () => {
	itIntegration(
		'committed tag preserves writable-layer state across docker rm',
		async ({ env, track }) => {
			const node = sui.create({ network: 'localnet' });

			// --- session 1: write marker, save snapshot --------------
			const engine1 = new Engine({ stack: [node] }, { env });
			let committedTag: string | undefined;
			let netName: string | undefined;
			let session1ContainerId: string | undefined;
			try {
				const result = await engine1.runOnce();
				expect(result.errored).toEqual([]);
				const view = engine1.getState();

				const networkState = view.nodes.get('docker.network')?.state as
					| { name: string }
					| undefined;
				netName = networkState?.name;
				track.network(netName);

				const c1 = view.nodes.get('sui.localnet.container')?.state as
					| DockerContainerState
					| undefined;
				expect(c1).toBeDefined();
				session1ContainerId = c1!.containerId;
				track.container(session1ContainerId);
				const indexerDb = view.nodes.get('sui.indexer-db')?.state as
					| DockerContainerState
					| undefined;
				track.container(indexerDb?.containerId);

				// Write a deterministic marker into the writable layer.
				// `/var/devstack-snapshot-marker` is writable and not
				// touched by sui's daemon.
				execFileSync('docker', [
					'exec',
					session1ContainerId,
					'sh',
					'-c',
					'echo session-1-marker > /var/devstack-snapshot-marker',
				]);

				const snapshot = await engine1.saveSnapshot();
				const snapState = snapshot.nodeStates['sui.localnet.container']?.state as
					| DockerContainerState
					| undefined;
				expect(snapState?.committedTag).toMatch(
					/^devstack-snapshot\/sui\.localnet\.container:c\d{8}T\d{6}$/,
				);
				committedTag = snapState!.committedTag!;

				// engine.stop tears down the container. The committed
				// tag persists in `docker images` — that's the whole
				// point.
			} finally {
				await engine1.stop();
			}

			// Sanity: the prior container is actually gone.
			expect(await containerExists(session1ContainerId!)).toBe(false);

			// --- session 2: restore from snapshot --------------------
			// Build a SnapshotRecord by re-saving from the prior engine
			// before stop. We already did that above; reload by calling
			// saveSnapshot a second time would re-commit. Use a fresh
			// engine seeded with the committed tag in its prior.

			// Re-save the snapshot via tryReadSnapshot would also work,
			// but we still have the committedTag in memory. Build a
			// minimal SnapshotRecord for engine2.
			const engine2 = new Engine(
				{ stack: [node] },
				{
					env,
					initialSnapshot: {
						createdAt: Date.now(),
						env: { appName: env.appName, network: env.network, stack: env.stack },
						nodeStates: {
							'sui.localnet.container': {
								state: {
									containerId: 'stale-id',
									startedAt: 0,
									image: 'stale',
									args: [],
									hostPorts: {},
									committedTag,
									committedAt: Date.now(),
								},
							},
						},
						meta: { devstackVersion: '0.0.0-dev' },
					},
				},
			);

			try {
				const result = await engine2.runOnce();
				expect(result.errored).toEqual([]);
				const view = engine2.getState();

				const c2 = view.nodes.get('sui.localnet.container')?.state as
					| DockerContainerState
					| undefined;
				expect(c2).toBeDefined();
				track.container(c2!.containerId);
				expect(c2!.containerId).not.toBe(session1ContainerId);
				expect(c2!.image).toBe(committedTag);
				expect(c2!.committedTag).toBe(committedTag);

				// Read the marker back — proof the writable layer
				// round-tripped through the commit.
				const markerOut = execFileSync(
					'docker',
					['exec', c2!.containerId, 'cat', '/var/devstack-snapshot-marker'],
					{ encoding: 'utf8' },
				).trim();
				expect(markerOut).toBe('session-1-marker');

				// And the new container is still serving RPC.
				const sui2 = view.nodes.get('sui.localnet')?.state as SuiState | undefined;
				expect(sui2).toBeDefined();
				const chainOk = await probeRpc(sui2!.rpcUrl, 30_000);
				expect(chainOk).toBe(true);

				const indexerDb2 = view.nodes.get('sui.indexer-db')?.state as
					| DockerContainerState
					| undefined;
				track.container(indexerDb2?.containerId);
			} finally {
				await engine2.stop();
				if (committedTag !== undefined) {
					try {
						execFileSync('docker', ['image', 'rm', '-f', committedTag], {
							stdio: 'ignore',
						});
					} catch {
						// best-effort
					}
				}
			}
		},
	);
});

async function containerExists(id: string): Promise<boolean> {
	try {
		await exec('docker', ['inspect', id]);
		return true;
	} catch {
		return false;
	}
}

async function probeRpc(rpcUrl: string, timeoutMs: number): Promise<boolean> {
	const body = JSON.stringify({
		jsonrpc: '2.0',
		method: 'sui_getChainIdentifier',
		params: [],
		id: 1,
	});
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const { stdout } = await exec('curl', [
				'-sf',
				'-X',
				'POST',
				'-H',
				'Content-Type: application/json',
				'-d',
				body,
				rpcUrl,
			]);
			if (stdout.includes('result')) return true;
		} catch {
			// keep polling
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	return false;
}
