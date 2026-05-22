// Walrus mode — local cluster.
//
// Distilled-doc reference (06-walrus.md §"Lifecycle: Startup —
// local cluster"). Eight ordered phases:
//
//   0. Yield deps (Sui, Identity, ChainProbe, faucet strategy opt,
//                  seed accounts).
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
//   3. Register committee — currently a typed no-op (distilled-doc
//                            opportunity #3: drop the cargo-culted
//                            placeholder). We omit it entirely in
//                            v3 rewrite.
//   4. Storage nodes — parallel boot of N storage-node containers.
//   5. Exchange resolution — on-chain getObject + parse type.
//                             Degrades to undefined on
//                             OBJECT_NOT_FOUND.
//   6. Proxy URL pick — nodes[0].rpcUrl is the representative
//                        aggregator/publisher.
//  7a. WAL faucet strategy register — opt-in, only when exchange +
//      seed accounts exist.
//  7b. Admin seed surface — exposes the same SDK swap path for
//      explicit post-boot WAL grants.
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
import type { SuiProbeKey } from '../../sui/chain-probe.ts';
import { contentHash as brandContentHash } from '../../../substrate/brand.ts';
import type { ChainId } from '../../../substrate/brand.ts';
import type { ResourceRef } from '../../../api/define-plugin.ts';
import { expectPositiveInteger } from '../../../substrate/runtime/config-validation.ts';
import { setCurrentPluginPhase } from '../../../substrate/runtime/current-plugin.ts';
import type { AccountResourceId } from '../../account/index.ts';
import type { AccountValue } from '../../account/service.ts';
import { walrusConfigError, walrusPluginError, type WalrusError } from '../errors.ts';
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
import { makeWalFaucetStrategy, walCoinType, type WalFaucetStrategy } from '../faucet-strategy.ts';
import {
	resolveWalExchange,
	seedWalAccounts,
	type WalExchangeHandle,
	type WalSwapSdk,
} from '../seed-wal.ts';

/** A user-supplied seed account ref. The user passes the result of
 *  `account('publisher')` — NOT a magic-string token. Generic over the
 *  literal account name so the walrus dependency tuple preserves each
 *  per-account resource id. */
export type WalrusAccountMember<Name extends string = string> = ResourceRef<
	AccountResourceId<Name>,
	AccountValue
>;

/** Options for the local-cluster mode. Mirrors v3
 *  `WalrusLocalClusterOptions<Name>` (06-walrus.md §"Configuration"). */
export interface WalrusLocalClusterOptions<
	Accounts extends ReadonlyArray<WalrusAccountMember> = ReadonlyArray<WalrusAccountMember>,
> {
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
	/** SUI MIST to spend per seed account on SUI → WAL swap. */
	readonly seedPaymentMist?: bigint;
	/** Seed account refs that should receive WAL. Each entry is the
	 *  plugin/resource ref returned by `account('name')`. The ref is
	 *  threaded through `dependsOn` so the walrus
	 *  local service waits for each seed account's acquire (keypair mint +
	 *  funding) before the WAL faucet strategy registers.
	 *
	 *  The FIRST entry doubles as the WAL-exchange admin signer
	 *  (distilled-doc §"Configuration"). Omitted / empty array → no
	 *  WAL faucet strategy registers. */
	readonly seedAccounts?: Accounts;
}

/** Resolved local-cluster boot artifacts. */
export interface LocalClusterBootResult {
	readonly mode: 'local';
	readonly deploy: CachedDeployState;
	readonly nodes: ReadonlyArray<WalrusStorageNode>;
	readonly aggregatorUrl: string;
	readonly publisherUrl: string;
	readonly proxyUrl: string;
	readonly exchangeObjectId: string | undefined;
	readonly exchange: WalExchangeHandle | null;
	/** WAL faucet strategy — present only when the local cluster has
	 *  BOTH a non-empty exchange object AND at least one seed account.
	 *  The barrel registers this onto the `coinType:<fullCoinType>`
	 *  strategy contributor decl. `null` otherwise. */
	readonly walFaucetStrategy: WalFaucetStrategy | null;
	readonly walCoinType: string | null;
	/** Admin signer for the WAL exchange — the first entry of
	 *  `seedAccounts` when supplied; `null` when no seed accounts
	 *  were wired. The barrel projects this into `WalrusAdmin.seedWal`
	 *  so admin calls route through a real signer. */
	readonly adminSigner: AccountValue | null;
}

/** Defaults applied to options. `seedAccountCount` is the count of
 *  the user-supplied member tuple; the resolved `AccountValue`s flow
 *  through `LocalClusterDeps` at acquire-time. */
export interface ResolvedLocalClusterOptions {
	readonly name: string;
	readonly nodeCount: number;
	readonly shards: number;
	readonly version: string;
	readonly suiVersion: string;
	readonly containerApiPort: number;
	readonly epochDuration: string;
	readonly readyTimeoutMs: number;
	readonly seedPaymentMist: bigint;
	readonly seedAccountCount: number;
}

/** Synchronous factory-time validation. Mirrors v3's
 *  `local-cluster.ts:101-121` guards. Throws (NOT Effect-fail) so
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
		seedPaymentMist: opts.seedPaymentMist ?? 500_000_000n,
		seedAccountCount: opts.seedAccounts?.length ?? 0,
	};
};

/** Dependencies the local service consumes at acquire-time. */
export interface LocalClusterDeps {
	readonly runtime: ContainerRuntime;
	readonly publisher: ArtifactPublisher;
	readonly probe: ChainProbe<SuiProbeKey>;
	readonly suiSdk: WalSwapSdk;
	readonly suiChainId: ChainId;
	readonly suiRpcUrlInNetwork: string;
	readonly walrusFaucetUrlInNetwork: string;
	readonly app: string;
	readonly stack: string;
	/** Pre-allocated /24 prefix from `subnetForStack`. */
	readonly subnetPrefix: string;
	readonly walrusNetworkName: string;
	readonly suiNetworkName: string;
	readonly deployHostMountPath: string;
	/** Resolved seed account values — projected from
	 *  `WalrusLocalClusterOptions.seedAccounts` by the barrel from
	 *  resolved dependencies. The first entry (when present) is the WAL
	 *  exchange admin signer. Empty array → no WAL faucet strategy
	 *  registers + admin surface raises a typed startup error. */
	readonly seedAccounts: ReadonlyArray<AccountValue>;
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
 *    - Proxy URL pick — `nodes[0].rpcUrl`.
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
			suiRpcUrlInNetwork: deps.suiRpcUrlInNetwork,
			walrusFaucetUrlInNetwork: deps.walrusFaucetUrlInNetwork,
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

		// ---- storage nodes — parallel boot ----------------------
		yield* setCurrentPluginPhase(
			`starting ${opts.nodeCount} Walrus storage node${opts.nodeCount === 1 ? '' : 's'}`,
		);
		const { nodes } = yield* startStorageNodes(deps.runtime, {
			app: deps.app,
			stack: deps.stack,
			walrusName: opts.name,
			image: walrusImage,
			nodeCount: opts.nodeCount,
			subnetPrefix: deps.subnetPrefix,
			containerApiPort: opts.containerApiPort,
			walrusNetworkName: deps.walrusNetworkName,
			suiNetworkName: deps.suiNetworkName,
			walrusFaucetUrl: deps.walrusFaucetUrlInNetwork,
			deployHostMountPath: deps.deployHostMountPath,
			deployConfigHash,
			readyTimeoutMs: opts.readyTimeoutMs,
		});

		// ---- proxy URL pick — nodes[0].rpcUrl -------------------
		// `nodeCount >= 1` is enforced synchronously already; this is
		// defense-in-depth.
		if (nodes.length === 0) {
			return yield* Effect.fail(
				walrusPluginError('proxy', 'walrus: at least one storage node is required'),
			);
		}
		const proxyUrl = nodes[0]!.rpcUrl;

		// ---- exchange resolution + WAL seed/faucet strategy ------
		// Seed each configured account with WAL and register a
		// `coinType:<fullCoinType>` strategy that swaps SUI → WAL on demand iff BOTH:
		//   - the deploy produced a WAL exchange object, AND
		//   - at least one seed account was wired through opts.
		// The first seed account doubles as the admin signer
		// (distilled-doc §"Configuration"). The dispatch site (faucet
		// plugin) sees a context-free `(req) => Effect.Effect<...>`.
		yield* setCurrentPluginPhase('resolving WAL exchange');
		const exchange = yield* resolveWalExchange(deps.probe, state.exchangeObject);
		const adminSigner = deps.seedAccounts[0];
		if (exchange && deps.seedAccounts.length > 0) {
			yield* setCurrentPluginPhase(`seeding WAL for ${deps.seedAccounts.length} account(s)`);
			yield* seedWalAccounts({
				exchange,
				sdk: deps.suiSdk,
				signers: deps.seedAccounts,
				paymentMist: opts.seedPaymentMist,
			});
		}
		const walFaucetStrategy: WalFaucetStrategy | null =
			exchange && adminSigner
				? makeWalFaucetStrategy({
						exchange,
						sdk: deps.suiSdk,
						signer: adminSigner,
						defaultPaymentMist: opts.seedPaymentMist,
					})
				: null;
		const resolvedWalCoinType = walFaucetStrategy === null ? null : walCoinType(state.walrusPackageId);

		return {
			mode: 'local' as const,
			deploy: state,
			nodes,
			aggregatorUrl: proxyUrl,
			publisherUrl: proxyUrl,
			proxyUrl,
			exchangeObjectId: state.exchangeObject,
			exchange,
			walFaucetStrategy,
			walCoinType: resolvedWalCoinType,
			adminSigner: adminSigner ?? null,
		};
	}).pipe(
		Effect.withSpan('devstack.plugin.walrus.localCluster.boot', {
			attributes: {
				'devstack.plugin': 'walrus',
				'walrus.name': opts.name,
				'walrus.nodeCount': opts.nodeCount,
				'walrus.shards': opts.shards,
			},
		}),
	);
