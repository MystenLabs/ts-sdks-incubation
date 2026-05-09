import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect } from 'vitest';
import { Engine } from '../engine/class.js';
import { sui } from '../plugins/sui.js';
import {
	walrus,
	type WalrusDeployState,
	type WalrusExchangeState,
	type WalrusNodeState,
	type WalrusRegisterState,
} from '../plugins/walrus.js';
import type { DockerContainerState } from '../runners/index.js';
import { describeIntegration, itIntegration } from './_helpers.js';

const exec = promisify(execFile);

// End-to-end happy path for a real walrus committee on top of a real
// sui-localnet:
//
//   - walrus.image.upstream + walrus.image build (cargo compile of
//     walrus + walrus-node + walrus-deploy from upstream).
//   - walrus.deploy.container runs deploy-walrus.sh against the live
//     localnet, writes per-node yaml + a `deploy` summary file.
//   - walrus.deploy reads the summary, parses package + system +
//     staking + exchange object ids.
//   - walrus.register projects them into a Package shape.
//   - walrus.exchange does the on-chain getObject lookup and resolves
//     the wal_exchange package id.
//   - walrus.node-* storage nodes come up on the per-stack network
//     with their fixed `10.<octet>.0.<10+i>` IPs.
//   - walrus.app-network aggregator publishes per-node URLs.
//
// `slow:true` — the walrus upstream image's first build is a multi-
// minute cargo compile. Once cached, subsequent runs are quick. Opt
// in via `RUN_SLOW_INTEGRATION=1 pnpm test:integration`.
//
// Uses `nodeCount: 1` for speed; production-realistic walrus
// committees use 4+ for shard quorum. The wiring exercise is the
// same — the deploy script honors `WALRUS_COMMITTEE_SIZE` and the
// aggregator fan-in works for any N.

describeIntegration('walrus (committee + deploy + register, 5e/5f, slow)', () => {
	itIntegration(
		'sui localnet → walrus.image build → deploy → register → committee up',
		async ({ env, track }) => {
			const w = walrus({ nodeCount: 1 });
			const engine = new Engine(
				{ stack: [sui.create({ network: 'localnet' }), w.appNetwork, w.exchange!] },
				{ env },
			);

			try {
				const result = await engine.runOnce();
				expect(result.errored).toEqual([]);

				const view = engine.getState();

				// --- track all containers + the network for cleanup ------
				const networkState = view.nodes.get('docker.network')?.state as
					| { name: string }
					| undefined;
				track.network(networkState?.name);
				for (const name of [
					'sui.indexer-db',
					'sui.localnet.container',
					'walrus.node-0.container',
				]) {
					const s = view.nodes.get(name)?.state as DockerContainerState | undefined;
					track.container(s?.containerId);
				}

				// --- walrus.image chain built ---------------------------
				const upstream = view.nodes.get('walrus.image.upstream')?.state as
					| { tag: string }
					| undefined;
				const wrapper = view.nodes.get('walrus.image')?.state as
					| { tag: string }
					| undefined;
				expect(upstream?.tag).toMatch(/^devstack\/walrus\.image\.upstream:[0-9a-f]{12}$/);
				expect(wrapper?.tag).toMatch(/^devstack\/walrus\.image:[0-9a-f]{12}$/);

				// --- deploy parsed -------------------------------------
				const deploy = view.nodes.get('walrus.deploy')?.state as
					| WalrusDeployState
					| undefined;
				expect(deploy).toBeDefined();
				expect(deploy!.walrusPackageId).toMatch(/^0x[0-9a-f]+$/);
				expect(deploy!.systemObject).toMatch(/^0x[0-9a-f]+$/);
				expect(deploy!.stakingObject).toMatch(/^0x[0-9a-f]+$/);
				expect(deploy!.exchangeObject).toMatch(/^0x[0-9a-f]+$/);

				// --- register projects into Package + register state ---
				const register = view.nodes.get('walrus.register')?.state as
					| WalrusRegisterState
					| undefined;
				expect(register).toBeDefined();
				expect(register!.package.name).toBe('walrus');
				expect(register!.package.packageId).toBe(deploy!.walrusPackageId);
				expect(register!.package.mvrPlaceholder).toBe('@local/walrus');

				// --- exchange resolves the wal_exchange package id -----
				const exchange = view.nodes.get('walrus.exchange')?.state as
					| WalrusExchangeState
					| undefined;
				expect(exchange).toBeDefined();
				expect(exchange!.objectId).toBe(deploy!.exchangeObject);
				expect(exchange!.packageId).toMatch(/^0x[0-9a-f]+$/);
				expect(exchange!.walType).toBe(`${deploy!.walrusPackageId}::wal::WAL`);

				// --- storage node up on per-stack network --------------
				const node0 = view.nodes.get('walrus.node-0')?.state as
					| WalrusNodeState
					| undefined;
				expect(node0).toBeDefined();
				expect(node0!.rpcUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
				const containerNode0 = view.nodes.get('walrus.node-0.container')
					?.state as DockerContainerState | undefined;
				expect(containerNode0!.network).toBe(networkState!.name);
				// 1-node committee → first node in the /24 subnet's
				// reserved storage-node slot.
				const octetMatch = networkState!.name.match(/-main$/);
				expect(octetMatch).not.toBeNull();
				expect(containerNode0!.ip).toMatch(/^10\.\d+\.0\.10$/);

				// --- aggregator urls -----------------------------------
				const appNetwork = view.nodes.get('walrus.app-network')?.state as
					| { nodeCount: number; urls: string[] }
					| undefined;
				expect(appNetwork?.nodeCount).toBe(1);
				expect(appNetwork?.urls).toEqual([node0!.rpcUrl]);

				// --- node responds to a basic API probe ----------------
				const reachable = await probeWalrusNode(node0!.rpcUrl, 30_000);
				expect(reachable).toBe(true);
			} finally {
				await engine.stop();
			}
		},
		// Slow because of the cargo compile. Cached across runs in
		// docker's build cache.
		{ slow: true },
	);
});

// Walrus storage nodes serve `/v1/api` (REST) and `/v1/health` paths
// — anything that returns < 500 means the daemon is live.
async function probeWalrusNode(url: string, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			await exec('curl', ['-sS', '-o', '/dev/null', '--max-time', '2', url]);
			return true;
		} catch {
			await new Promise((r) => setTimeout(r, 500));
		}
	}
	return false;
}
