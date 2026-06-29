// Walrus mode — local cluster.
//
// Distilled-doc reference (06-walrus.md §"Lifecycle: Startup —
// local cluster"). Eight ordered phases:
//
//   0. Yield deps (Sui, Identity, ChainProbe, faucet strategy opt).
//   1. Image build — upstream cargo image (bootstrap asset) +
//                    wrapper image (inline; content-addressed on
//                    the upstream tag + suiVersion).
//  1b. Docker network create — per-stack `/24` via
//      `Docker.networkCreate(networkName, {subnet})`.
//   2. Deploy contracts — via `ArtifactPublisher`. The
//                          publisher folds chainId into the cache
//                          key; verify probes BOTH the on-disk
//                          `deploy` file AND on-chain object
//                          existence; produce runs the deploy
//                          one-shot.
//   3. Register committee — omitted entirely (no placeholder).
//   4. Storage nodes — parallel boot of N storage-node containers.
//   5. Exchange resolution — on-chain getObject + parse type.
//                             Degrades to undefined on
//                             OBJECT_NOT_FOUND.
//   6. Storage-node fallback URL pick — nodes[0].rpcUrl is kept as an
//                                      implementation/debug handle only.
//  7a. WAL faucet strategy register — opt-in when an exchange exists.
//   8. Registries — package + endpoint + walrus-state.
//
// What this file owns: the dispatch shape + the typed options
// surface + the synchronous factory-time validation.
//
// What this file delegates: container/Move heavy paths live in
// `storage-nodes.ts`, `deploy.ts`, and the `ArtifactPublisher`
// primitive.

import { Effect, FileSystem, Path, type Scope } from 'effect';

import type {
	ArtifactPublishError,
	ArtifactPublisher,
} from '../../../primitives/artifact-publisher.ts';
import type { ChainProbe } from '../../../contracts/chain-probe.ts';
import type { ContainerRuntime } from '../../../contracts/container-runtime.ts';
import type { SuiProbeKey } from '../../sui/index.ts';
import { contentHash as brandContentHash } from '../../../substrate/brand.ts';
import { expectPort, expectPositiveInteger } from '../../../substrate/runtime/config-validation.ts';
import { setCurrentPluginPhase } from '../../../substrate/runtime/current-plugin.ts';
import { walrusConfigError, walrusPluginError, type WalrusError } from '../errors.ts';
import { WALRUS_MAX_NODE_COUNT } from '../routable.ts';
import type { WalrusStorageNode } from '../storage-nodes.ts';
import {
	DEFAULT_NODE_READY_TIMEOUT_MS,
	DEFAULT_CONTAINER_API_PORT,
	WALRUS_NODE_IP_BASE,
	computePublicHostname,
	startStorageNodes,
} from '../storage-nodes.ts';
import { deployWalrusContracts, type CachedDeployState } from '../deploy.ts';
import {
	DEFAULT_SUI_VERSION,
	DEFAULT_WALRUS_REF,
	resolveCargoImage,
} from '../bootstrap-assets/cargo-image.ts';
import {
	makeWalFaucetStrategy,
	walPackageIdFromCoinType,
	resolveWalCoinType,
	type WalFaucetStrategy,
} from '../faucet-strategy.ts';
import { resolveWalExchange, type WalExchangeHandle, type WalSwapSdk } from '../wal-swap.ts';

/** Options for the local-cluster mode (06-walrus.md
 *  §"Configuration"). */
export interface WalrusLocalClusterOptions {
	/** Engine row name + on-disk dir suffix + registry key.
	 *  Default `'walrus'`. */
	readonly name?: string;
	/** Number of storage-node containers. Must be `>= 1` (synchronous
	 *  factory-time guard). Default `1`. */
	readonly nodeCount?: number;
	/** Total shards distributed across the committee. Must be
	 *  `>= nodeCount`. Default `100` (distilled-doc default block). */
	readonly shards?: number;
	/** Pinned walrus release — drives the wrapper image build.
	 *  Default `'testnet-v1.49.1'`. */
	readonly version?: string;
	/** Sui release whose binary the wrapper image bakes (distilled-
	 *  doc invariant 24). Default `'devnet-v1.71.0'`. */
	readonly suiVersion?: string;
	/** Port each storage node binds inside the container. Default
	 *  9185 (same as the router entrypoint — invariant 9). */
	readonly containerApiPort?: number;
	/** Walrus epoch length passed to `walrus-deploy --epoch-duration`.
	 *  Default `'24h'`. */
	readonly epochDuration?: string;
	/** Per-node TCP ready-probe timeout (ms). Defaults to
	 *  `DEFAULT_NODE_READY_TIMEOUT_MS`. */
	readonly readyTimeoutMs?: number;
	/** Local app-facing aggregator service. Defaults to enabled. Set
	 *  `false` to expose only storage-node routes. */
	readonly aggregator?: boolean | WalrusLocalServiceOptions;
	/** Local app-facing publisher service. Defaults to enabled. Set
	 *  `false` to run storage nodes without the simple publish API. */
	readonly publisher?: boolean | WalrusLocalPublisherOptions;
}

export interface WalrusLocalServiceOptions {
	/** Preferred host-process port. The port broker forward-scans when
	 *  this port is already held by another process. */
	readonly port?: number;
	/** NIC the host-process HTTP server binds. Defaults to `0.0.0.0`
	 *  because the Docker-hosted router reaches host services through
	 *  the host-gateway address. */
	readonly bindAddress?: string;
}

export interface WalrusLocalPublisherOptions extends WalrusLocalServiceOptions {
	/** Default retention epochs when `PUT /v1/blobs` omits `epochs`.
	 *  Matches the upstream simple publisher example. */
	readonly defaultEpochs?: number;
	/** Default deletability when `PUT /v1/blobs` omits `deletable`. */
	readonly defaultDeletable?: boolean;
	/** Maximum accepted request body in bytes. */
	readonly maxBlobBytes?: number;
	/** SUI MIST requested from the local faucet whenever the publisher
	 *  signer needs more gas/swap funds. The local faucet currently
	 *  grants a fixed amount; this value is used as the requested floor
	 *  and for diagnostics. */
	readonly suiTopUpMist?: number | bigint;
	/** SUI MIST spent at the local WAL exchange when topping up WAL.
	 *  The write-specific storage cost can force a larger swap. */
	readonly walTopUpMist?: number | bigint;
}

/** Resolved local-cluster boot artifacts. */
export interface LocalClusterBootResult {
	readonly mode: 'local';
	readonly deploy: CachedDeployState;
	readonly walrusPackageId: string;
	readonly walPackageId: string;
	readonly nodes: ReadonlyArray<WalrusStorageNode>;
	readonly storageNodeProxyUrl: string;
	readonly aggregatorUrl: string | null;
	readonly publisherUrl: string | null;
	readonly proxyUrl: string;
	readonly exchangeObjectId: string | undefined;
	readonly exchange: WalExchangeHandle | null;
	/** WAL faucet strategy — present only when the local cluster has a
	 *  non-empty exchange object. The barrel registers this onto the
	 *  `coinType:<fullCoinType>` strategy contributor decl. `null`
	 *  otherwise. */
	readonly walFaucetStrategy: WalFaucetStrategy | null;
	readonly walCoinType: string;
}

/** Defaults applied to options. */
export interface ResolvedLocalClusterOptions {
	readonly name: string;
	readonly nodeCount: number;
	readonly shards: number;
	readonly version: string;
	readonly suiVersion: string;
	readonly containerApiPort: number;
	readonly epochDuration: string;
	readonly readyTimeoutMs: number;
	readonly aggregator: ResolvedWalrusLocalServiceOptions | null;
	readonly publisher: ResolvedWalrusLocalPublisherOptions | null;
}

export interface ResolvedWalrusLocalServiceOptions {
	readonly port?: number;
	readonly bindAddress: string;
}

export interface ResolvedWalrusLocalPublisherOptions extends ResolvedWalrusLocalServiceOptions {
	readonly defaultEpochs: number;
	readonly defaultDeletable: boolean;
	readonly maxBlobBytes: number;
	readonly suiTopUpMist: bigint;
	readonly walTopUpMist: bigint;
}

const WALRUS_LOCAL_SERVICE_DEFAULT_BIND_ADDRESS = '0.0.0.0';
const DEFAULT_PUBLISHER_EPOCHS = 3;
const DEFAULT_PUBLISHER_MAX_BLOB_BYTES = 64 * 1024 * 1024;
const DEFAULT_PUBLISHER_SUI_TOP_UP_MIST = 2_000_000_000n;
const DEFAULT_PUBLISHER_WAL_TOP_UP_MIST = 1_000_000_000n;

/** Synchronous factory-time validation. Throws (NOT Effect-fail) so
 *  misconfiguration trips at the `defineDevstack` call site rather
 *  than at deferred Layer.build time. Distilled-doc invariant 11. */
export const resolveLocalClusterOptions = (
	opts: WalrusLocalClusterOptions,
): ResolvedLocalClusterOptions => {
	const nodeCount = expectPositiveInteger(opts.nodeCount ?? 1, {
		field: 'nodeCount',
		mkError: ({ field, message, hint }) =>
			walrusConfigError(
				field,
				`walrusLocalCluster: nodeCount must be >= 1 (got ${String(opts.nodeCount ?? 1)})`,
				hint ?? message,
			),
		hint: 'set nodeCount to a positive integer (default 1)',
	});
	if (nodeCount > WALRUS_MAX_NODE_COUNT) {
		throw walrusConfigError(
			'nodeCount',
			`walrusLocalCluster: nodeCount (${nodeCount}) exceeds the maximum ${WALRUS_MAX_NODE_COUNT} ` +
				`pre-declared Traefik entrypoints (walrus-node-0..${WALRUS_MAX_NODE_COUNT - 1}).`,
			`reduce nodeCount or raise WALRUS_MAX_NODE_COUNT in plugins/walrus/routable.ts`,
		);
	}
	const shards = expectPositiveInteger(opts.shards ?? 100, {
		field: 'shards',
		mkError: ({ field, message, hint }) =>
			walrusConfigError(
				field,
				`walrusLocalCluster: shards must be a positive integer (got ${String(opts.shards ?? 100)})`,
				hint ?? message,
			),
		hint: 'set shards to a positive integer (default 100)',
	});
	if (shards < nodeCount) {
		throw walrusConfigError(
			'shards',
			`walrusLocalCluster: shards (${shards}) must be >= nodeCount (${nodeCount})`,
			`set shards >= ${nodeCount} (default 100)`,
		);
	}
	return {
		name: opts.name ?? 'walrus',
		nodeCount,
		shards,
		version: opts.version ?? DEFAULT_WALRUS_REF,
		suiVersion: opts.suiVersion ?? DEFAULT_SUI_VERSION,
		containerApiPort: opts.containerApiPort ?? DEFAULT_CONTAINER_API_PORT,
		epochDuration: opts.epochDuration ?? '24h',
		readyTimeoutMs: opts.readyTimeoutMs ?? DEFAULT_NODE_READY_TIMEOUT_MS,
		...resolveLocalServicesOptions(opts),
	};
};

const configError = (field: string, message: string, hint?: string): never => {
	throw walrusConfigError(field, message, hint);
};

const expectOptionalPort = (value: number | undefined, field: string): number | undefined =>
	value === undefined
		? undefined
		: expectPort(value, {
				field,
				mkError: ({ field: f, message, hint }) =>
					walrusConfigError(f, `walrusLocalCluster: ${f} ${message}`, hint),
			});

const expectPositiveBigInt = (
	value: number | bigint | undefined,
	fallback: bigint,
	field: string,
): bigint => {
	if (value === undefined) return fallback;
	if (typeof value === 'bigint' && value > 0n) return value;
	if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
		return BigInt(value);
	}
	return configError(
		field,
		`walrusLocalCluster: ${field} must be a positive safe integer or bigint`,
	);
};

const resolveLocalServiceBase = (
	value: boolean | WalrusLocalServiceOptions | undefined,
	fieldPrefix: 'aggregator' | 'publisher',
): ResolvedWalrusLocalServiceOptions | null => {
	if (value === false) return null;
	const authored = value === undefined || value === true ? {} : value;
	const port = expectOptionalPort(authored.port, `${fieldPrefix}.port`);
	return {
		...(port === undefined ? {} : { port }),
		bindAddress: authored.bindAddress ?? WALRUS_LOCAL_SERVICE_DEFAULT_BIND_ADDRESS,
	};
};

const resolveLocalServicesOptions = (
	opts: WalrusLocalClusterOptions,
): Pick<ResolvedLocalClusterOptions, 'aggregator' | 'publisher'> => {
	const aggregator = resolveLocalServiceBase(opts.aggregator, 'aggregator');
	const publisherBase = resolveLocalServiceBase(opts.publisher, 'publisher');
	if (publisherBase === null) {
		return { aggregator, publisher: null };
	}
	const publisherOpts = opts.publisher;
	const authored: WalrusLocalPublisherOptions =
		publisherOpts === undefined || publisherOpts === true || publisherOpts === false
			? {}
			: publisherOpts;
	const defaultEpochs = expectPositiveInteger(authored.defaultEpochs ?? DEFAULT_PUBLISHER_EPOCHS, {
		field: 'publisher.defaultEpochs',
		mkError: ({ field, message, hint }) =>
			walrusConfigError(field, `walrusLocalCluster: ${field} ${message}`, hint),
	});
	const maxBlobBytes = expectPositiveInteger(
		authored.maxBlobBytes ?? DEFAULT_PUBLISHER_MAX_BLOB_BYTES,
		{
			field: 'publisher.maxBlobBytes',
			mkError: ({ field, message, hint }) =>
				walrusConfigError(field, `walrusLocalCluster: ${field} ${message}`, hint),
		},
	);
	return {
		aggregator,
		publisher: {
			...publisherBase,
			defaultEpochs,
			defaultDeletable: authored.defaultDeletable ?? false,
			maxBlobBytes,
			suiTopUpMist: expectPositiveBigInt(
				authored.suiTopUpMist,
				DEFAULT_PUBLISHER_SUI_TOP_UP_MIST,
				'publisher.suiTopUpMist',
			),
			walTopUpMist: expectPositiveBigInt(
				authored.walTopUpMist,
				DEFAULT_PUBLISHER_WAL_TOP_UP_MIST,
				'publisher.walTopUpMist',
			),
		},
	};
};

/** Dependencies the local service consumes at acquire-time. */
export interface LocalClusterDeps {
	readonly runtime: ContainerRuntime;
	readonly publisher: ArtifactPublisher;
	readonly probe: ChainProbe<SuiProbeKey>;
	readonly suiSdk: WalSwapSdk;
	readonly suiChainId: string;
	readonly suiRpcUrlInNetwork: string;
	readonly walrusFaucetUrlInNetwork: string;
	readonly waitForFundsReady: Effect.Effect<void, unknown>;
	readonly app: string;
	readonly stack: string;
	/** Pre-allocated /24 prefix from `subnetForStack`. */
	readonly subnetPrefix: string;
	readonly walrusNetworkName: string;
	readonly suiNetworkName: string;
	readonly deployHostMountPath: string;
	/** On-disk per-stack root from `StackPathsService.stackRoot`. The
	 *  walrus bind-mount is computed off this; `deployHostMountPath`
	 *  MUST live under it. */
	readonly stackRoot: string;
}

/** Boot the local cluster. Returns the resolved value the plugin
 *  projects onto its tags.
 *
 *  Steps:
 *    - Image build — `resolveCargoImage` (bootstrap asset).
 *      Honors `WALRUS_CARGO_IMAGE_OVERRIDE` for the pre-baked path.
 *    - Docker network ensure — `runtime.ensureNetwork(walrusNet)`.
 *      The sui network is owned by the sui plugin; we attach to it
 *      as a secondary network on each storage node.
 *    - Deploy contracts — `deployWalrusContracts` dispatches through
 *      the artifact publisher primitive; the produce body runs the walrus deploy
 *      one-shot.
 *    - Storage nodes — parallel boot via `startStorageNodes`.
 *    - Storage-node fallback URL pick — `nodes[0].rpcUrl`.
 *    - WAL faucet strategy — constructed if `state.exchangeObject`
 *      exists. Surfaced on the boot result; the barrel registers
 *      the contributor decl.
 *
 *  Per-step failures surface as `WalrusPluginError` with the phase
 *  vocabulary from `errors.ts`; artifact publisher failures pass through as
 *  `ArtifactPublishError`. The plugin narration vocabulary anchors
 *  on these phase tags.
 */
export const bootLocalCluster = (
	deps: LocalClusterDeps,
	opts: ResolvedLocalClusterOptions,
): Effect.Effect<
	LocalClusterBootResult,
	WalrusError | ArtifactPublishError,
	Scope.Scope | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		// ---- cargo image (bootstrap asset) -----------------------
		// The cargo image is content-addressed; the resolver owns the
		// cache check + the registry-tag override fast path.
		yield* setCurrentPluginPhase(`resolving Walrus image ${opts.version}`);
		const walrusImage = yield* resolveCargoImage(deps.runtime, {
			walrusRef: opts.version,
			suiVersion: opts.suiVersion,
			owner: { app: deps.app, stack: deps.stack },
		});

		// ---- docker network ensure ------------------------------
		yield* setCurrentPluginPhase(`ensuring Walrus network ${deps.walrusNetworkName}`);
		yield* deps.runtime
			.ensureNetwork({
				name: deps.walrusNetworkName,
				app: deps.app,
				stack: deps.stack,
			})
			.pipe(
				Effect.catch((cause) =>
					Effect.fail(
						walrusPluginError(
							'cluster-network',
							`walrus: ensureNetwork('${deps.walrusNetworkName}') failed: ${cause.reason}: ${cause.detail}`,
							{ cause },
						),
					),
				),
			);

		// ---- deploy via ArtifactPublisher ----------------
		// The deploy one-shot needs the walrus image + sui network so it
		// can dial the per-stack sui RPC + faucet over docker DNS.
		//
		// Per-node IP CSV is derived from the subnet prefix; per-node
		// hostnames likewise. Both must be in lockstep with the
		// storage-node boot below — the deploy step writes per-node
		// committee records on chain using these.
		const publicHosts = Array.from({ length: opts.nodeCount }, (_, i) =>
			computePublicHostname(deps.app, deps.stack, i),
		).join(',');
		const listeningIps = Array.from(
			{ length: opts.nodeCount },
			(_, i) => `${deps.subnetPrefix}.${WALRUS_NODE_IP_BASE + i}`,
		).join(',');

		yield* setCurrentPluginPhase(
			`deploying Walrus contracts (${opts.nodeCount} node${opts.nodeCount === 1 ? '' : 's'}, ${opts.shards} shards)`,
		);
		const { state } = yield* deployWalrusContracts(deps.publisher, deps.probe, deps.runtime, {
			walrusName: opts.name,
			chainId: deps.suiChainId,
			contentHash: brandContentHash(
				`walrus|${opts.version}|${opts.suiVersion}|${opts.nodeCount}|${opts.shards}|${opts.epochDuration}`,
			),
			outputDirHostPath: deps.deployHostMountPath,
			stackRoot: deps.stackRoot,
			suiRpcUrlInNetwork: deps.suiRpcUrlInNetwork,
			walrusFaucetUrlInNetwork: deps.walrusFaucetUrlInNetwork,
			waitForFundsReady: deps.waitForFundsReady,
			committeeSize: opts.nodeCount,
			shards: opts.shards,
			epochDuration: opts.epochDuration,
			publicHostsCsv: publicHosts,
			listeningIpsCsv: listeningIps,
			walrusImage,
			suiNetworkName: deps.suiNetworkName,
		});
		const deployConfigHash = [
			'walrus-deploy',
			state.walrusPackageId,
			state.systemObject,
			state.stakingObject,
			state.exchangeObject ?? 'no-exchange',
		].join('|');

		// Per-node image tags. Each storage node runs under its OWN tag (a cheap
		// re-tag of the one content-cached cargo build) so its committed writable
		// layer — the RocksDB holding that node's slivers — promotes to a DISTINCT
		// image on snapshot restore. A single shared tag would make the restore
		// image-promote collapse all N committed layers onto one tag
		// (last-write-wins): N-1 nodes boot on the wrong layer and every
		// pre-snapshot blob is orphaned. The tag is scoped by the deployed
		// `walrusPackageId` — stable across boot1 -> restore -> boot2 (the deploy
		// cache reuses the same id, so the restore's promote target matches what
		// boot2 requests), but DISTINCT per fresh deployment, so a later cold boot
		// on a new chain never inherits a prior run's committed node layers (which
		// carry a stale committee and would reject writes). The base `walrusImage`
		// (shared) still backs the transient deploy one-shot (`--rm`, unsnapshotted).
		const nodeImageScope = state.walrusPackageId.replace(/^0x/, '').slice(0, 12);
		const nodeImages = yield* Effect.forEach(
			Array.from({ length: opts.nodeCount }, (_, i) => i),
			(i) =>
				resolveCargoImage(
					deps.runtime,
					{
						walrusRef: opts.version,
						suiVersion: opts.suiVersion,
						owner: { app: deps.app, stack: deps.stack },
					},
					`${walrusImage.tag}-${nodeImageScope}-node-${i}`,
				),
		);

		// ---- storage nodes — parallel boot ----------------------
		yield* setCurrentPluginPhase(
			`starting ${opts.nodeCount} Walrus storage node${opts.nodeCount === 1 ? '' : 's'}`,
		);
		const { nodes } = yield* startStorageNodes(deps.runtime, {
			app: deps.app,
			stack: deps.stack,
			walrusName: opts.name,
			images: nodeImages,
			nodeCount: opts.nodeCount,
			subnetPrefix: deps.subnetPrefix,
			containerApiPort: opts.containerApiPort,
			walrusNetworkName: deps.walrusNetworkName,
			suiNetworkName: deps.suiNetworkName,
			deployHostMountPath: deps.deployHostMountPath,
			stackRoot: deps.stackRoot,
			deployConfigHash,
			readyTimeoutMs: opts.readyTimeoutMs,
		});

		// ---- storage-node fallback URL pick — nodes[0].rpcUrl ----
		// `nodeCount >= 1` is enforced synchronously already; this is
		// defense-in-depth.
		if (nodes.length === 0) {
			return yield* Effect.fail(
				walrusPluginError('proxy', 'walrus: at least one storage node is required'),
			);
		}
		const storageNodeProxyUrl = nodes[0]!.rpcUrl;

		// ---- exchange resolution + WAL funding strategy ------
		// Register a `coinType:<fullCoinType>` strategy that swaps the
		// requesting account's SUI into WAL on demand. Accounts opt in via
		// their normal `funding` list.
		yield* setCurrentPluginPhase('resolving WAL exchange');
		const exchange = yield* resolveWalExchange(deps.probe, state.exchangeObject);
		const walFaucetStrategy: WalFaucetStrategy | null = exchange
			? makeWalFaucetStrategy({
					exchange,
					sdk: deps.suiSdk,
				})
			: null;
		const resolvedWalCoinType = yield* resolveWalCoinType({
			probe: deps.probe,
			treasuryObjectId: state.treasuryObject,
			deployPackageId: state.walrusPackageId,
			requireTreasuryObject: exchange !== null,
		});
		const resolvedWalPackageId = walPackageIdFromCoinType(resolvedWalCoinType);

		return {
			mode: 'local' as const,
			deploy: state,
			walrusPackageId: state.walrusPackageId,
			walPackageId: resolvedWalPackageId,
			nodes,
			storageNodeProxyUrl,
			aggregatorUrl: null,
			publisherUrl: null,
			proxyUrl: storageNodeProxyUrl,
			exchangeObjectId: state.exchangeObject,
			exchange,
			walFaucetStrategy,
			walCoinType: resolvedWalCoinType,
		};
	});
