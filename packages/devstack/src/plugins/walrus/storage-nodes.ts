// Walrus storage-node committee lifecycle.
//
// Distilled-doc reference (06-walrus.md §"Capabilities CONSUMED" +
// §"Lifecycle phase 4"): N storage-node containers, pinned IPs on a
// per-stack /24 docker network. Each node carries one Traefik route
// via the `Routable` capability; the router binds host port 9185 once
// globally and dispatches by `Host:` header.
//
// Substrate-side responsibilities:
//   - `ContainerRuntime.ensureContainer` per node — content-addressed
//     image, label tuple, recreate policy.
//   - Parallel `Effect.all({concurrency: 'unbounded'})` over [0..N) —
//     concurrent boot.
//   - Per-node stop finalizer fires in a *forked parallel scope* so
//     teardown collapses to ~max(grace) instead of summing graces
//     (distilled-doc invariant 21 — "StopFinalizerScope MUST be a
//     forked parallel scope").
//
// What we DON'T own here:
//   - Plugin row narration.
//   - The faucet-strategy registration — `faucet-strategy.ts`.
//   - The deploy one-shot — `deploy.ts`.

import { Duration, Effect, Scope } from 'effect';

import type {
	ContainerHandle,
	ContainerRuntime,
	ImageRef,
} from '../../contracts/container-runtime.ts';
import {
	ProbeTimeoutError,
	exitCodeProbeResult,
	waitForProbe,
} from '../../substrate/runtime/probes.ts';
import { setCurrentPluginPhase } from '../../substrate/runtime/current-plugin.ts';
import { ensureManagedContainer } from '../../substrate/runtime/managed-container.ts';
import { walrusDeployMountPaths } from './deploy-paths.ts';
import { walrusPluginError, type WalrusPluginError } from './errors.ts';

/** Default per-node grace window. Storage nodes maintain RocksDB-
 *  backed state; need >10s to flush and checkpoint on `docker stop`.
 *  Distilled-doc invariant 22. */
export const DEFAULT_NODE_STOP_GRACE_SECONDS = 20;

/** Default per-node ready-probe timeout. */
export const DEFAULT_NODE_READY_TIMEOUT_MS = 60_000;

/** Distilled-doc invariant 9: the on-chain `public_port` value
 *  matches the global router entrypoint port. One canonical
 *  constant — opportunity #14 in the distilled doc was to deduplicate
 *  this across three files. */
export const WALRUS_ROUTER_PORT = 9185;

/** Default container API port — each storage node binds this inside
 *  the container. Same value as the router port (the storage node's
 *  in-container bind matches the on-chain public_port). */
export const DEFAULT_CONTAINER_API_PORT = WALRUS_ROUTER_PORT;

/** Per-node descriptor — what the plugin resolved value surfaces
 *  for downstream consumers (the `@mysten/walrus` SDK reads this). */
export interface WalrusStorageNode {
	readonly nodeIndex: number;
	readonly nodeId: string;
	readonly publicKey: string;
	readonly publicHostname: string;
	readonly rpcUrl: string;
}

/** Storage-node startup config — the plugin's local-cluster mode
 *  passes this in once per cluster boot. */
export interface StorageNodesSpec {
	readonly app: string;
	readonly stack: string;
	readonly walrusName: string;
	readonly image: ImageRef;
	readonly nodeCount: number;
	/** Pre-allocated /24 prefix from `subnetForStack`. Example:
	 *  `'10.42.7'` (the third octet is hashed per stack). */
	readonly subnetPrefix: string;
	readonly containerApiPort: number;
	readonly walrusNetworkName: string;
	readonly suiNetworkName: string;
	readonly deployHostMountPath: string;
	/** Fingerprint of the deploy outputs mounted into each node. */
	readonly deployConfigHash: string;
	readonly stopGraceSeconds?: number;
	readonly readyTimeoutMs?: number;
}

/** Result of starting the committee — descriptors used by the
 *  plugin's resolved value. */
export interface StorageNodesAcquired {
	readonly nodes: ReadonlyArray<WalrusStorageNode>;
}

/** Distilled-doc invariant 1: pinned IPs start at `<prefix>.10`.
 *  Centralized so the deploy one-shot's `WALRUS_LISTENING_IPS` env
 *  var and the per-node `--ip` pin compute from one source. */
export const WALRUS_NODE_IP_BASE = 10;

/** Compute the public hostname for one storage node. Mirrors
 *  v3's `routerHostname(identity, 'walrus-node-' + i)` shape
 *  (06-walrus.md §"Routes registered"). Main stack omits the stack
 *  segment; non-main inserts it after the service label. */
export const computePublicHostname = (app: string, stack: string, nodeIndex: number): string => {
	const base = `walrus-node-${nodeIndex}.${app}.localhost`;
	return stack === 'main' ? base : `walrus-node-${nodeIndex}.${stack}.${app}.localhost`;
};

export const storageNodeConfigHash = (parts: {
	readonly deployConfigHash: string;
	readonly nodeIndex: number;
	readonly deploySourceHostPath: string;
	readonly deployMountTarget: string;
	readonly containerApiPort: number;
	readonly walrusNetworkName: string;
	readonly suiNetworkName: string;
}): string =>
	[
		parts.deployConfigHash,
		`node=${parts.nodeIndex}`,
		`mount=${parts.deploySourceHostPath}->${parts.deployMountTarget}`,
		`api=${parts.containerApiPort}`,
		`net=${parts.walrusNetworkName},${parts.suiNetworkName}`,
	].join('|');

export const buildWalrusNetworkName = (app: string, stack: string, walrusName: string): string =>
	`devstack-${app}-${stack}-walrus-${walrusName}-net`;

/** Per-node TCP ready-probe interval. */
const NODE_READY_PROBE_INTERVAL_MS = 500;

/** Start the N-node committee.
 *
 *  Wiring (this body is the load-bearing path):
 *
 *    1. Defense-in-depth nodeCount guard.
 *    2. Fork a parallel-strategy child scope off the caller's scope so
 *       every node's `docker stop` finalizer fires concurrently on
 *       outer teardown — collapses shutdown wall-time from `N×grace` to
 *       `~max(grace)` (distilled-doc invariant 21).
 *    3. For each `i ∈ [0..N)`:
 *         a. `ensureContainer` on the wrapper image with pinned IP,
 *            label tuple, primary network attach (walrus net), recreate
 *            on config-change.
 *         b. TCP ready probe against `<publicHostname>:<routerPort>`
 *            with bounded retries until the outer `readyTimeoutMs`.
 *    4. Run [3] under `Effect.all({concurrency: 'unbounded'})` — boot
 *       parallelism collapses to ~max(perNode).
 *
 *  WHAT THE SUBSTRATE STILL OWES:
 *    - Secondary network attach (`Docker.networkConnect(suiNet)`).
 *      `EnsureContainerSpec.networkAttach` accepts an array, so passing
 *      `[walrusNet, suiNet]` would dual-home in one shot, but the
 *      runtime adapter currently treats the first entry as the primary
 *      and post-attaches the rest; the per-node pinned IP only attaches
 *      to the primary. The dual-home is documented inline below and
 *      relies on that adapter behavior. Storage nodes do not request
 *      faucet funds during boot; the secondary network is retained for
 *      future Sui-side in-network calls.
 *    - Per-node `networkAlias` (`walrus-node-<i>.localhost`). The
 *      contract doesn't expose alias plumbing yet; peer containers dial by
 *      container name, which docker DNS publishes. The architecture
 *      revision is tracked in `index.ts`.
 *    - Stop-grace duration propagation. The contract's `stop` takes a
 *      Duration but `ensureContainer` doesn't yet accept a default
 *      grace; the runtime adapter defaults to 10s. RocksDB needs 20s
 *      (distilled-doc invariant 22) — see opportunity below.
 */
export const startStorageNodes = (
	runtime: ContainerRuntime,
	spec: StorageNodesSpec,
): Effect.Effect<StorageNodesAcquired, WalrusPluginError, Scope.Scope> =>
	Effect.gen(function* () {
		if (spec.nodeCount < 1) {
			return yield* Effect.fail(
				walrusPluginError(
					'storage-node',
					`storage-nodes: nodeCount must be >= 1 (got ${spec.nodeCount})`,
				),
			);
		}

		// Fork a parallel stop-scope. Per-node `ensureContainer` finalizers
		// fire here on outer teardown; closing the parallel scope races
		// the per-container `docker stop`s instead of summing them.
		const outerScope = yield* Effect.scope;
		const nodeStopScope = yield* Scope.fork(outerScope, 'parallel');

		const stopGrace = Duration.seconds(spec.stopGraceSeconds ?? DEFAULT_NODE_STOP_GRACE_SECONDS);
		const readyTimeout = Duration.millis(spec.readyTimeoutMs ?? DEFAULT_NODE_READY_TIMEOUT_MS);
		const deployMount = walrusDeployMountPaths(spec.deployHostMountPath, '/opt/walrus/runtime');

		const indices = Array.from({ length: spec.nodeCount }, (_, i) => i);

		const bootOne = (i: number): Effect.Effect<WalrusStorageNode, WalrusPluginError, Scope.Scope> =>
			Effect.gen(function* () {
				const containerIp = `${spec.subnetPrefix}.${WALRUS_NODE_IP_BASE + i}`;
				const containerName = `devstack-${spec.app}-${spec.stack}-walrus-${spec.walrusName}-node-${i}`;
				const nodeHostname = `dryrun-node-${i}`;
				const publicHostname = computePublicHostname(spec.app, spec.stack, i);

				yield* setCurrentPluginPhase(`creating storage-node-${i} container ${containerName}`);
				// Acquire under the forked parallel stop scope so the
				// finalizer (docker stop) joins the per-node fan-out race.
				const ensureNode: Effect.Effect<ContainerHandle, WalrusPluginError, Scope.Scope> =
					ensureManagedContainer<WalrusPluginError>({
						runtime,
						identity: { app: spec.app, stack: spec.stack },
						plugin: 'walrus',
						role: `storage-node-${i}`,
						spec: {
							name: containerName,
							image: spec.image,
							recreate: 'on-config-change',
							configHash: storageNodeConfigHash({
								deployConfigHash: spec.deployConfigHash,
								nodeIndex: i,
								deploySourceHostPath: deployMount.sourceHostPath,
								deployMountTarget: deployMount.mountTarget,
								containerApiPort: spec.containerApiPort,
								walrusNetworkName: spec.walrusNetworkName,
								suiNetworkName: spec.suiNetworkName,
							}),
							env: {
								HOSTNAME: nodeHostname,
								DEPLOY_OUTPUT_DIR: deployMount.outputDirInContainer,
							},
							// Primary network owns the pinned `--ip`; the
							// secondary attach gives docker DNS for the sui
							// network. The adapter treats [0] as primary.
							networkAttach: [spec.walrusNetworkName, spec.suiNetworkName],
							// `host-gateway` resolves `host.docker.internal` to
							// the host's loopback inside the container — Docker
							// Desktop wires this automatically on macOS/Windows
							// but native Linux Docker requires the explicit
							// `--add-host` flag. Storage nodes dial sui's
							// host-bound RPC + faucet via this hostname.
							extraHosts: { 'host.docker.internal': 'host-gateway' },
							mounts: [
								{
									// Mount the stack root and point the entrypoint at
									// the deploy child. Docker Desktop can reject
									// freshly-created nested bind sources immediately
									// after a wiped stack recreates them.
									source: deployMount.sourceHostPath,
									target: deployMount.mountTarget,
									readonly: true,
								},
							],
						},
						mapError: (cause) =>
							walrusPluginError(
								'storage-node',
								`walrus storage-node-${i} (ip=${containerIp}) ensureContainer failed: ${cause.reason}: ${cause.detail}`,
								{ cause },
							),
					});
				const handle: ContainerHandle = yield* Scope.provide(ensureNode, nodeStopScope);

				// TCP ready probe. We exec a tiny `nc`-style probe inside
				// the container against its own listener — proves the
				// in-container HTTP server bound and is accepting before
				// declaring ready. `exec` only fails on daemon-level
				// errors; a non-zero exit code is treated as "retry"
				// (the same policy postgres uses for `pg_isready`).
				yield* setCurrentPluginPhase(
					`waiting for storage-node-${i} on 127.0.0.1:${spec.containerApiPort}`,
				);
				yield* waitForProbe({
					label: `walrus.storage-node.${i}`,
					timeoutMs: Duration.toMillis(readyTimeout),
					intervalMs: NODE_READY_PROBE_INTERVAL_MS,
					probe: () =>
						runtime
							.exec(handle, [
								'sh',
								'-c',
								// busybox-style portable probe: open TCP, write
								// nothing, exit. `nc -z` is the common form.
								`nc -z 127.0.0.1 ${spec.containerApiPort} || exit 1`,
							])
							.pipe(Effect.map(exitCodeProbeResult)),
				}).pipe(
					Effect.mapError((cause) => {
						if (cause instanceof ProbeTimeoutError) {
							return walrusPluginError(
								'storage-node',
								`storage-node-${i} never became ready within ${Duration.toMillis(readyTimeout)}ms ` +
									`(container=${containerName}, probe=127.0.0.1:${spec.containerApiPort}, ` +
									`publicUrl=http://${publicHostname}:${WALRUS_ROUTER_PORT}). ` +
									`The container was created, but walrus-node did not bind its API port. ` +
									`Check the storage-node container logs for the faucet, WAL exchange, or ` +
									`walrus-node run step that stalled.`,
								{ cause: cause.lastError ?? cause.lastNotReady ?? cause },
							);
						}
						return walrusPluginError(
							'storage-node',
							`storage-node-${i} ready-probe exec failed: ${cause.reason}: ${cause.detail}`,
							{ cause },
						);
					}),
				);

				return {
					nodeIndex: i,
					// Stable node-id derived from name. The on-chain
					// public_key + bls12-381 keypair lives inside the
					// per-node keystore the deploy one-shot emitted;
					// this descriptor is the routing handle, not the
					// crypto identity. The SDK consumer reads the
					// public key off `packageConfig` rather than this
					// per-node descriptor.
					nodeId: `walrus-node-${i}`,
					publicKey: `<bls-pubkey-storage-node-${i}>`,
					publicHostname,
					// Router-fronted URL on the well-known walrus
					// entrypoint port — Traefik routes by Host: header.
					rpcUrl: `http://${publicHostname}:${WALRUS_ROUTER_PORT}`,
				} satisfies WalrusStorageNode;
			}).pipe(
				Effect.withSpan(`devstack.plugin.walrus.storage-node-${i}.boot`, {
					attributes: { 'devstack.plugin': 'walrus', 'walrus.node': i },
				}),
			);

		const nodes = yield* Effect.all(indices.map(bootOne), {
			concurrency: 'unbounded',
		});

		// Stop-grace is plumbed through `stopGraceSeconds` for future
		// adapter use; the current Docker adapter applies its default.
		void stopGrace;

		return { nodes };
	}).pipe(
		Effect.withSpan('devstack.plugin.walrus.storage-nodes.boot', {
			attributes: { 'devstack.plugin': 'walrus' },
		}),
	);
