// Walrus phase 4 — storage-node committee.
//
// N detached containers, each on a pinned in-network IP and a
// `PortAllocator`-issued host port. Per-node host ports are released
// on scope teardown so the allocator's held-set doesn't grow
// monotonically across primitive restarts.
//
// Span: `walrus.nodes` (preserved).

import { Effect } from 'effect';
import * as Docker from '../../internal/docker.js';
import { PortAllocator } from '../../internal/port-allocator.js';
import { WalrusError } from '../errors.js';
import type { NodeState } from './internal.js';
import { WALRUS_NODE_IP_BASE } from './internal.js';
// Note: `Scope` is yielded inline via `Effect.scope` per node so the
// `onPortConflict` callback's release finalizers attach to the same
// scope as `Effect.addFinalizer` for the original allocate.

export const startStorageNodes = (args: {
	name: string;
	image: string;
	nodeCount: number;
	containerApiPort: number;
	readyTimeoutMs: number;
	deployDir: string;
	network: string;
	subnetPrefix: string;
	portAllocator: typeof PortAllocator.Service;
	faucetUrl: string;
}) =>
	Effect.fn('walrus.nodes')(function* () {
		const nodes: Array<NodeState> = [];
		// Capture once outside the loop — same scope hosts every node's
		// allocate finalizer, so `onPortConflict`'s release finalizers
		// land symmetrically.
		const nodesScope = yield* Effect.scope;
		for (let i = 0; i < args.nodeCount; i++) {
			// Per-node host port for our supervisor-side ready probe + as
			// a debug surface. Skip `containerApiPort` itself (9185) so
			// the proxy can claim it — the on-chain committee tells SDK
			// clients to reach the nodes at `walrus-node-N.localhost:9185`
			// (resolves to 127.0.0.1), and that traffic must hit the
			// proxy's Host-header vhost router, not node-0's raw port.
			// `+ 1 + i` gives node-0=9186, node-1=9187, …; the allocator
			// scans forward if a sibling stack already holds them.
			const hostPort = yield* args.portAllocator.allocate(args.containerApiPort + 1 + i).pipe(
				Effect.mapError(
					(cause) =>
						new WalrusError({
							phase: 'nodes',
							message: `walrus.nodes: could not allocate host port for node ${i}: ${cause.message}`,
							cause,
						}),
				),
			);
			// Release on scope teardown so the allocator's held-set
			// doesn't grow monotonically across primitive restarts —
			// otherwise subsequent runs probe from `preferred+N` rather
			// than reusing the slot this cycle just freed. Registered
			// immediately after allocate so a failure later in the build
			// path still triggers release on scope close.
			yield* Effect.addFinalizer(() => args.portAllocator.release(hostPort).pipe(Effect.ignore));
			const containerIp = `${args.subnetPrefix}.${WALRUS_NODE_IP_BASE + i}`;
			const containerName = `walrus-${args.name}-node-${i}`;

			const nodeHostname = `dryrun-node-${i}`;
			yield* Docker.run({
				name: containerName,
				image: args.image,
				args: ['/bin/bash', '-c', '/opt/walrus/scripts/run-walrus.sh'],
				ports: { [hostPort]: args.containerApiPort },
				mounts: [{ host: args.deployDir, container: '/opt/walrus/outputs' }],
				// `--hostname` so the container's actual hostname matches
				// the chain-registered name (walrus-node reads its own
				// hostname when self-identifying to peers). The redundant
				// HOSTNAME env var is preserved as a belt-and-braces
				// signal for run.sh which historically read it.
				// `WALRUS_FAUCET_URL` overrides run.sh's legacy default of
				// `http://sui-localnet:9123/gas` (a docker-DNS path that
				// only worked in v3) with the host-gateway URL we use to
				// reach the host-side sui localnet from this network.
				env: { HOSTNAME: nodeHostname, WALRUS_FAUCET_URL: args.faucetUrl },
				network: args.network,
				ip: containerIp,
				hostname: nodeHostname,
				networkAlias: `walrus-node-${i}.localhost`,
				detach: true,
				// On a resume port-conflict (another stack snapped up our
				// node's host port while we were paused), shift forward
				// to the next free preferred port instead of an ephemeral.
				// Note: only the supervisor-side ready probe and the
				// debug surface use this port — the SDK reaches each node
				// via `walrus-node-N.localhost:9185` through the proxy
				// container on the shared docker network, so a host-port
				// shift is invisible to SDK clients.
				onPortConflict: Docker.reallocatePortsOnConflict(
					args.portAllocator,
					nodesScope,
					`walrus.nodes[${i}]`,
				),
			}).pipe(
				Effect.catchTag('DockerError', (cause) =>
					Effect.fail(
						new WalrusError({
							phase: 'nodes',
							message: `walrus.nodes: failed to start storage node ${i}: ${cause.message}`,
							cause,
						}),
					),
				),
			);

			// Wait for the node's API port to answer something — same
			// "any HTTP response means alive" semantics as before.
			// `awaitContainerReady` races the probe against the storage-
			// node container's exit, so a node that crashes (run.sh
			// faucet failure, walrus-deploy schema mismatch, …) surfaces
			// its stderr in the error instead of timing out blind.
			yield* Docker.awaitContainerReady({
				containerName,
				probe: {
					kind: 'tcp',
					host: '127.0.0.1',
					port: hostPort,
					timeoutMs: args.readyTimeoutMs,
				},
			}).pipe(
				Effect.catchTag('ReadyProbeError', (cause) =>
					Effect.fail(
						new WalrusError({
							phase: 'nodes',
							message: `walrus.nodes: storage node ${i} never became ready: ${cause.message}`,
							stderr: cause.detail,
							cause,
						}),
					),
				),
			);

			nodes.push({
				index: i,
				hostPort,
				containerIp,
				rpcUrl: `http://127.0.0.1:${hostPort}`,
			});
		}
		return nodes;
	})();
