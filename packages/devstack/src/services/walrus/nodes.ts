// Walrus phase 4 — storage-node committee.
//
// N detached containers, each on a pinned in-network IP. No per-node
// host port any more: each node carries a traefik label set so the
// shared `devstack-router` exposes it on the well-known walrus
// entrypoint port (9185) via the stack-scoped hostname the deploy
// phase registered on chain.
//
// Span: `walrus.nodes` (preserved).

import { Effect, Scope } from 'effect';
import * as Docker from '../../engine/docker.js';
import { StopFinalizerScope } from '../../engine/docker/sweep.js';
import { EngineHandle } from '../../engine/engine.js';
import type { IdentityShape } from '../../engine/identity.js';
import { routerHostname } from '../../engine/router-hostname.js';
import { runDockerContainer } from '../../advanced/plugin-author/docker-container.js';
import { WalrusError } from '../../engine/errors.js';
import type { NodeState } from './internal.js';
import { WALRUS_NODE_IP_BASE } from './internal.js';

// Per-level ranking for the min-level filter below. info < warn < error,
// so a min='warn' threshold suppresses INFO and lets WARN+ERROR through.
const LEVEL_RANK: Record<Docker.OutputLineLevel, number> = { info: 0, warn: 1, error: 2 };

// Walrus storage nodes emit ~5–20 INFO lines per second per node (checkpoint
// downloader, garbage collector phases, sync progress) — totally normal
// runtime narration that's useful in `docker logs <node>` for debugging
// but noise in the TUI log panel where it pushes more important lines off
// screen. Default min-level = 'warn' suppresses INFO from the supervisor's
// sink WITHOUT silencing the container itself — the stderr stream still
// flows freely, and `docker logs private-content-walrus-walrus-node-0`
// shows everything. Override with `DEVSTACK_LOG_LEVEL=info` (or trace /
// debug — both map to info) when you actively want the firehose in the TUI.
const resolveMinLevel = (defaultMin: Docker.OutputLineLevel): Docker.OutputLineLevel => {
	const env = process.env.DEVSTACK_LOG_LEVEL?.toLowerCase();
	if (env === 'trace' || env === 'debug' || env === 'info') return 'info';
	if (env === 'warn' || env === 'warning') return 'warn';
	if (env === 'error' || env === 'fatal') return 'error';
	return defaultMin;
};

// Per-line sink: tag each line with the storage-node label so the
// TUI tail makes attribution obvious. No-op when no engine is wired
// into the context (standalone callers / tests).
const makeNodeOutputSink = (label: string): Effect.Effect<Docker.OutputLineCallback> =>
	Effect.gen(function* () {
		const engineOpt = yield* Effect.serviceOption(EngineHandle);
		const minRank = LEVEL_RANK[resolveMinLevel('warn')];
		return (level, line) => {
			if (LEVEL_RANK[level] < minRank) return Effect.void;
			return engineOpt._tag === 'None'
				? Effect.void
				: engineOpt.value
						.appendLog({ ts: Date.now(), level, message: `[${label}] ${line}` })
						.pipe(Effect.ignore);
		};
	});

export const startStorageNodes = (args: {
	name: string;
	image: string;
	nodeCount: number;
	containerApiPort: number;
	routerEntrypointPort: number;
	readyTimeoutMs: number;
	deployDir: string;
	network: string;
	/**
	 * Per-stack sui docker network the storage nodes attach to as a
	 * secondary network so docker DNS resolves `sui-localnet`. The
	 * primary network (`args.network`) keeps the pinned IPs walrus
	 * requires; this additional attachment is what gives the node's
	 * `WALRUS_FAUCET_URL` a working hostname. Undefined when sui is
	 * an externally-managed RPC with no in-network alias.
	 */
	suiNetwork: string | undefined;
	subnetPrefix: string;
	identity: IdentityShape;
	faucetUrl: string;
	/** Engine row key all node stop-finalizers target so per-row teardown
	 * progress (✓ ready → ⊘ stopping → ⊠ stopped) lands on the single
	 * `walrus.cluster` row instead of spawning N phantom rows in the
	 * TUI's "Other" section. Passed by the caller (walrus/local-cluster.ts)
	 * because that file builds its tag via `Layer.effectContext` directly,
	 * which means `withEngineLifecycle` never runs and the usual
	 * `CurrentTagKey` ambient default isn't available. */
	engineTagKey: string;
}) =>
	Effect.fn('walrus.nodes')(function* () {
		// HIGH-V4: boot all N storage nodes in parallel instead of
		// serially. A 4-node committee previously paid `N × perNode`
		// wall-clock for the ready probe loop; running the
		// docker-run + network-attach + ready-probe per node as a
		// single Effect inside `Effect.all({concurrency: 'unbounded'})`
		// brings cold cluster boot down to ~max(perNode). Each node's
		// pipeline is independent (separate container name, IP, ready
		// probe); the result order is preserved by `Effect.all` on an
		// indexed array.
		//
		// Parallel stop-scope for symmetric teardown: at shutdown, each
		// node's docker-stop finalizer would otherwise fire in series
		// on this composite primitive's single layer scope (~N × 20s
		// grace = 80s for a 4-node cluster, dominating perceived
		// shutdown wall time). Forking a parallel-strategy child here
		// and providing it as `StopFinalizerScope` for the per-node
		// `Docker.run` calls below routes their stop finalizers to a
		// sibling-fanout scope — `docker stop`s fire concurrently when
		// the cluster's outer scope closes. Acquire stays serial within
		// each node; only teardown parallelizes.
		const clusterScope = yield* Effect.scope;
		const nodeStopScope = yield* Scope.fork(clusterScope, 'parallel');
		const indices = Array.from({ length: args.nodeCount }, (_, i) => i);
		const bootOne = (i: number) =>
			Effect.gen(function* () {
				const containerIp = `${args.subnetPrefix}.${WALRUS_NODE_IP_BASE + i}`;
				const containerName = `walrus-${args.name}-node-${i}`;
				const nodeHostname = `dryrun-node-${i}`;
				const publicHostname = routerHostname(args.identity, `walrus-node-${i}`);
				const onOutputLine = yield* makeNodeOutputSink(`walrus.node-${i}`);

				// Container readiness is probed in-network (we exec `wget` /
				// `nc` into the container) instead of via a host port —
				// nothing on the host loopback maps to this storage node any
				// more. The router binds 9185 once on the host and routes
				// by `Host:` header.
				//
				// Network attach is multi-step: the primary network is
				// `args.network` (walrus-net, where the pinned `--ip` lives);
				// after `docker run` returns, the container additionally
				// joins `devstack-router` (via `traefik:` materializer) AND
				// `args.suiNetwork` (via `Docker.networkConnect` below) so
				// the in-container `WALRUS_FAUCET_URL` (`http://sui-localnet
				// :9123/v1/gas`) resolves via docker DNS.
				// `runDockerContainer({tag})` reuses the pre-built walrus
				// wrapper image — the image was materialized once in
				// `internal.ts::acquireLocalCluster` (via `buildWrapperImage`)
				// and threaded through here as `args.image`. Routing
				// `name: 'walrus-node-N'` keeps the per-node hostname
				// stable for the chain-registered committee record.
				const runResult = yield* runDockerContainer(containerName, {
					image: { tag: args.image },
					args: ['/bin/bash', '-c', '/opt/walrus/scripts/run-walrus.sh'],
					mounts: [{ source: args.deployDir, target: '/opt/walrus/outputs' }],
					// `--hostname` so the container's actual hostname matches
					// the chain-registered name. `WALRUS_FAUCET_URL` is the
					// docker-DNS sui-localnet faucet URL (see
					// `walrus/internal.ts` for the URL assembly).
					env: { HOSTNAME: nodeHostname, WALRUS_FAUCET_URL: args.faucetUrl },
					network: args.network,
					ip: containerIp,
					hostname: nodeHostname,
					networkAlias: `walrus-node-${i}.localhost`,
					routing: [
						{
							name: `walrus-node-${i}`,
							entrypoint: 'walrus',
							servicePort: args.containerApiPort,
							// Walrus storage-node REST API doesn't emit CORS
							// headers. v3 setup relied on the now-deleted
							// nginx walrus-proxy to inject them; here, route
							// through the global `devstack-cors` middleware
							// so browser-side blob fetches from vite work.
							cors: true,
						},
					],
					// Stream the storage node's docker-logs to the supervisor
					// for the lifetime of the reuseScope. Useful for diagnosing
					// peer-config / WAL-fund mishaps that surface as recurring
					// log lines rather than container exits.
					onOutputLine,
					// Storage nodes maintain RocksDB-backed state at
					// `/opt/walrus/outputs/<node>/storage` — needs >10s to
					// flush + checkpoint on `docker stop`. Without this they
					// get SIGKILL'd and the next start runs RocksDB
					// log-replay before serving, slowing committee readiness.
					stopGraceSeconds: 20,
					// All 4 storage-node stop finalizers target the SAME
					// engine row (the `walrus.cluster` aggregate the user
					// sees). `runDockerContainer`'s usual default — read
					// `CurrentTagKey` from the enclosing `withEngineLifecycle`
					// wrapper — doesn't fire here because walrus-local-cluster
					// is composed via `Layer.effectContext` directly (not via
					// `tag()`/`provide()`), so the wrapper never runs and
					// `CurrentTagKey` stays at its empty-string default.
					// Without this explicit pass-through the fallback would
					// hand the container name through, creating 4 phantom
					// `walrus-walrus-node-N` rows in the TUI's "Other"
					// section AND leaving the real `walrus.cluster` row
					// stuck on `ready` through teardown. The last node's
					// `markStopped` wins so the row's final state matches
					// the actual container set.
					engineTagKey: args.engineTagKey,
				}).effect.pipe(
					Effect.catchTag('DockerError', (cause) =>
						Effect.fail(
							new WalrusError({
								phase: 'nodes',
								message: `walrus.nodes: failed to start storage node ${i}: ${cause.message}`,
								cause,
							}),
						),
					),
					Effect.catchTag('ReadyProbeError', (cause) =>
						Effect.fail(
							new WalrusError({
								phase: 'nodes',
								message: `walrus.nodes: storage node ${i} failed ready probe: ${cause.message}`,
								cause,
							}),
						),
					),
				);

				// Dual-home onto the per-stack sui network so docker DNS
				// resolves `sui-localnet` for the storage node's faucet
				// dialer. Skipped when sui is externally managed (no
				// docker-side network to join).
				if (args.suiNetwork !== undefined) {
					yield* Docker.networkConnect(args.suiNetwork, runResult.containerId).pipe(
						Effect.catchTag('DockerError', (cause) =>
							Effect.fail(
								new WalrusError({
									phase: 'nodes',
									message: `walrus.nodes: failed to attach storage node ${i} to sui network '${args.suiNetwork}': ${cause.message}`,
									cause,
								}),
							),
						),
					);
				}

				// Router-fronted ready probe. Dial the public hostname (which
				// resolves to 127.0.0.1) on the well-known walrus
				// entrypoint port (9185); traefik forwards to this node by
				// `Host:` header. Proves both that the router has indexed
				// the container's labels AND that the storage node is
				// serving — no host-port mapping required. Races against
				// `docker wait` so a crashed node surfaces its stderr
				// rather than timing out blind.
				yield* Docker.awaitContainerReady({
					containerName,
					probe: {
						kind: 'tcp',
						host: publicHostname,
						port: args.routerEntrypointPort,
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

				return {
					index: i,
					containerIp,
					// Router-fronted URL on the well-known walrus entrypoint
					// port (9185). The SDK and any host process dialing the
					// storage node lands here; traefik forwards to the
					// per-stack container by `Host:` header.
					rpcUrl: `http://${publicHostname}:${args.routerEntrypointPort}`,
					publicHostname,
				} satisfies NodeState;
			});

		const nodes = yield* Effect.all(indices.map(bootOne), { concurrency: 'unbounded' }).pipe(
			Effect.provideService(StopFinalizerScope, nodeStopScope),
		);
		return nodes;
	})();
