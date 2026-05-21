// Walrus plugin — barrel + factories.
//
// Architecture: Walrus is the canonical composite primitive — one
// engine row, many children (deploy one-shot + N storage nodes + 2
// lifted siblings). The factory at this file folds the four modes
// behind:
//
//   - `walrus(opts?)`           — env-driven mode selection. Defaults
//                                  to local; overridable via the typed
//                                  `opts.local` pass-through.
//   - `walrusFor(network)`      — mode-narrowed factory namespace
//                                  (architecture Tension 11). Returns
//                                  `{ local: …, known: … }` narrowed
//                                  to the network's mode. Crucially,
//                                  the fork branch exposes ONLY
//                                  `.known` — `.local` is a compile
//                                  error on a fork-mode network.
//
// The plugin emits FOUR capability decls (per mode):
//
//   Local mode (4 of 4 tags + admin signer):
//     1. `composite-primitive` — one engine row + N child members +
//                                 2 lifted siblings.
//     2. `snapshotable`        — runtime/walrus/<name>/deploy/ subtree
//                                 + storage-node managed containers.
//     3. `codegenable`         — `walrus-network` bindings.
//     4. `routable` × (N + 2)  — per-node + aggregator + publisher.
//     5. `strategy-contributor:walrus-state-registry`  — local entry.
//     6. `strategy-contributor:endpoint-registry`      — N+2 entries.
//     7. `strategy-contributor:package-registry`       — `walrus.<name>`.
//     8. `strategy-contributor:coinType:WAL`           — WAL faucet
//                                                         strategy
//                                                         (when seed
//                                                         accounts + exchange).
//
//   Known mode (3 of 4 tags — NO admin):
//     1. `snapshotable`        — identity-guard only; no subtrees.
//     2. `codegenable`         — `walrus-network` bindings (mode='known').
//     3. `strategy-contributor:walrus-state-registry` — known entry.
//
// Tag id: `'walrus'` (singular). The plugin's substrate-level plugin
// key is the same string.

import { Effect, FileSystem, Path } from 'effect';

import { capabilities } from '../../api/define-capabilities.ts';
import { consumeMembers } from '../../api/consume-members.ts';
import { defineModeNamespace } from '../../api/mode-narrowed-factory.ts';
import { defineNodePlugin } from '../../api/define-plugin.ts';
import { defineTag } from '../../api/tag.ts';
import type { CodegenableDecl } from '../../contracts/codegenable.ts';
import type { RoutableDecl } from '../../contracts/routable.ts';
import type { SnapshotableDecl } from '../../contracts/snapshotable.ts';
import type { StrategyContributorDecl } from '../../contracts/strategy-contributor.ts';
import { ContainerRuntimeService } from '../../runtime/docker/service.ts';
import { IdentityContext, StackPathsService } from '../../substrate/runtime/paths.ts';
import { OnChainArtifactPublisherService } from '../../substrate/runtime/on-chain-artifact/index.ts';
import type { AcquireContext } from '../../substrate/plugin.ts';
import type { AccountValue } from '../account/service.ts';
import type { SuiProbeKey } from '../sui/chain-probe.ts';
import { SuiTag } from '../sui/index.ts';
import type { SuiClient } from '../sui/index.ts';

import {
	StrategyRegistryService,
	chainProbeFor,
} from '../../substrate/runtime/strategy-registry/index.ts';

import { makeCodegenable, type WalrusBindings } from './codegen.ts';
import { makeWalrusComposite } from './composite.ts';
import { WALRUS_ERROR_TAGS, walrusPluginError } from './errors.ts';
import { defaultWalrusCargoImageSiblingKey } from './lifted-siblings/cargo-image.ts';
import { defaultWalrusSourceSiblingKey } from './lifted-siblings/source-fetch.ts';
import { WAL_FAUCET_STRATEGY_KEY } from './faucet-strategy.ts';
import { bootWalrusService, refuseLocalClusterOnFork, type WalrusMode } from './service.ts';
import {
	resolveLocalClusterOptions,
	type WalrusAccountMember,
	type WalrusAccountTags,
	type WalrusLocalClusterOptions,
} from './mode/local-cluster.ts';
import {
	resolveKnownDeploymentOptions,
	type WalrusKnownDeploymentOptions,
	type WalrusKnownNetwork,
} from './mode/known-deploy.ts';
import { makeSnapshotable, type WalrusSnapshotMode } from './snapshot.ts';
import { makeLocalRoutables } from './routable.ts';
import { WALRUS_STATE_REGISTRY_KEY, type WalrusStateEntry } from './registry-publish.ts';
import type { WalrusStorageNode } from './storage-nodes.ts';
import { swapSuiForWal, type WalExchangeHandle, type WalSwapSdk } from './seed-wal.ts';

// ---------------------------------------------------------------------------
// Tag — the resolved value all consumers read
// ---------------------------------------------------------------------------

/** The Walrus admin surface — local-mode only (distilled-doc
 *  invariant 14). `seedWal` swaps SUI for WAL on a registered seed
 *  account using the first seedAccount as the exchange signer.
 *
 *  Fails with `WalrusPluginError` when no seed accounts were wired
 *  (the admin signer is the first seedAccount; without one there is
 *  no signer to dispatch the swap). */
export interface WalrusAdmin {
	readonly seedWal: (args: {
		readonly address: string;
		readonly amount: bigint;
	}) => Effect.Effect<{ readonly digest: string }, import('./errors.ts').WalrusPluginError>;
}

/** The Walrus resolved value carried by the tag. Mode-asymmetric:
 *  `admin` is `null` for known-deployment mode (distilled-doc
 *  invariant 14). */
export interface WalrusResolved {
	readonly mode: 'local' | 'known';
	readonly chain: string;
	/** SDK-ready `packageConfig` — structurally compatible with
	 *  `@mysten/walrus`'s `WalrusPackageConfig`. */
	readonly packageConfig: {
		readonly systemObjectId: string;
		readonly stakingPoolId: string;
		readonly exchangeIds?: ReadonlyArray<string>;
	};
	readonly nodes: ReadonlyArray<WalrusStorageNode>;
	readonly proxyUrl: string | null;
	readonly aggregatorUrl: string | null;
	readonly publisherUrl: string | null;
	/** Admin surface — `null` in known-deployment mode. */
	readonly admin: WalrusAdmin | null;
}

/** Walrus plugin tag. */
export const WalrusTag = defineTag<'walrus', WalrusResolved>('walrus', 'walrus');

// ---------------------------------------------------------------------------
// Default option resolution (env-driven)
// ---------------------------------------------------------------------------

/** Read `DEVSTACK_NETWORK` env. Walrus's env mapping:
 *
 *   - undefined / 'localnet'  → local cluster
 *   - 'testnet'               → known(testnet)
 *   - 'mainnet'               → known(mainnet)
 *   - 'devnet'                → known(devnet)
 *   - '<x>-fork'              → known(<x>) — auto-route per
 *                                distilled-doc invariant 13
 *
 *  The fork → known auto-routing means `walrus()` on a fork stack
 *  is NEVER a refusal; only the explicit `walrusLocalCluster(...)`
 *  composition on a fork network refuses. */
type EnvMode =
	| { readonly mode: 'local' }
	| { readonly mode: 'known'; readonly network: WalrusKnownNetwork };

const resolveDefaultMode = (): EnvMode => {
	const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
		?.env?.DEVSTACK_NETWORK;
	switch (env) {
		case undefined:
		case 'localnet':
			return { mode: 'local' };
		case 'testnet':
			return { mode: 'known', network: 'testnet' };
		case 'mainnet':
			return { mode: 'known', network: 'mainnet' };
		case 'devnet':
			return { mode: 'known', network: 'devnet' };
		case 'mainnet-fork':
			return { mode: 'known', network: 'mainnet' };
		case 'testnet-fork':
			return { mode: 'known', network: 'testnet' };
		case 'devnet-fork':
			return { mode: 'known', network: 'devnet' };
		default:
			return { mode: 'local' };
	}
};

// ---------------------------------------------------------------------------
// Plugin construction (internal — used by walrus() + walrusFor())
// ---------------------------------------------------------------------------

/** Walrus `consumes:` shape — Sui (hard upstream for ordering) plus
 *  the per-seed-account-tag tuple projected from the user-supplied
 *  seedAccounts member tuple. Mirrors wallet's `WalletConsumes` —
 *  preserving each literal `account/${Name}` is load-bearing for the
 *  stack-composition `MissingProviders` check. */
type WalrusConsumes<Accounts extends ReadonlyArray<WalrusAccountMember>> = readonly [
	typeof SuiTag,
	...WalrusAccountTags<Accounts>,
];

const buildLocalPlugin = <const Accounts extends ReadonlyArray<WalrusAccountMember>>(
	opts: WalrusLocalClusterOptions<Accounts>,
) => {
	// Synchronous factory-time validation (distilled-doc invariants
	// 11 — `nodeCount >= 1` + `shards >= nodeCount`).
	const resolved = resolveLocalClusterOptions(opts);

	// Lifted siblings — declared at factory time so the topo scheduler
	// places them at level 0 (parallel with sui's boot). Two siblings:
	//   1. cargo-image  — upstream cargo build (key includes walrus
	//                      ref + sui version + rust toolchain).
	//   2. move-source  — git checkout of the walrus Move package
	//                      subdirectory (key includes repo@ref/subdir).
	const cargoImageKey = defaultWalrusCargoImageSiblingKey();
	const moveSourceKey = defaultWalrusSourceSiblingKey();
	const siblingKeys = resolved.movePackagePath
		? [cargoImageKey] // skip the move-source sibling if user pinned a path
		: [cargoImageKey, moveSourceKey];

	const compositeKey = `walrus:${resolved.name}`;

	const composite = makeWalrusComposite({
		compositeKey,
		liftedSiblings: siblingKeys,
		// `innerParticipants` is empty at factory time — the substrate's
		// composite scheduler synthesises the N storage-node + 1 deploy
		// child members from the composite's acquire return value.
		innerParticipants: [],
	});

	// `consumes` MUST include every seed-account tag's key so the
	// substrate's topological scheduler waits for each seed account's
	// acquire (keypair mint + funding) before the walrus composite
	// dispatches WAL swaps via the first-account-doubles-as-admin-signer
	// path. Without this edge, the first WAL swap could race the
	// account's funding and fail with `address-not-found`. (Mirrors
	// wallet's `consumes: [SuiTag, ...accountTags]`.)
	const seedAccountMembers: ReadonlyArray<WalrusAccountMember> = opts.seedAccounts ?? [];
	const consumedSeedAccounts = consumeMembers(seedAccountMembers);
	const consumes = [
		SuiTag,
		...consumedSeedAccounts.consumesTags,
	] as unknown as WalrusConsumes<Accounts>;

	return defineNodePlugin({
		provides: WalrusTag,
		consumes,
		kind: 'composite',
		rebootCost: 'heavy',
		acquire: (ctx) =>
			Effect.gen(function* () {
				// Substrate-context primitives:
				//   - `ContainerRuntimeService` + `IdentityContext` arrive
				//     via the supervisor's plugin runtime context.
				//   - `OnChainArtifactPublisher` is the substrate-level
				//     publisher (cache → verify → produce → register cycle).
				//   - `ChainProbe<SuiProbeKey>` is looked up via the
				//     StrategyRegistry under `chain-probe:<chainId>`;
				//     Sui registered itself there at its own acquire.
				//   - `StackPathsService` resolves the per-stack on-disk
				//     root so the deploy-output bind-mount source is a
				//     real path (not the `<runtime>/...` template).
				const runtime = yield* ContainerRuntimeService;
				const identity = yield* IdentityContext;
				const stackPaths = yield* StackPathsService;
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;

				// `ctx.get(SuiTag)` widens when `Consumes` carries a
				// template-literal-generic tag id (each `account/${Name}`
				// from `opts.seedAccounts`) — TS cannot narrow `T extends
				// Provided` and the SuiTag read returns the union of
				// every provided value type. Localize a typed-cast for
				// the one SuiTag read (mirrors account / package — same
				// `__MemberNotConsumedError` reduction limitation,
				// STYLE_GUIDE §14 + Open slot O10).
				const sui = (ctx as { readonly get: (t: typeof SuiTag) => SuiClient }).get(SuiTag);
				const publisher = yield* OnChainArtifactPublisherService;
				const probe = yield* chainProbeFor<SuiProbeKey>(sui.chain);

				// Resolve each seed account upstream via direct member
				// refs. `consumes` above pins `m.provides` for each `m` in
				// `opts.seedAccounts`, so the runtime BuildContext walker
				// is guaranteed to find the entry. The §14 cast lives
				// inside `consumeMembers` — call site reads the resolved
				// tuple directly.
				const resolvedSeedAccounts: ReadonlyArray<AccountValue> =
					consumedSeedAccounts.projectInScope(ctx);

				// Resolve the deploy-output bind-mount source from the
				// per-stack paths bundle. The dir must exist before the
				// deploy one-shot's bind-mount; create it recursively.
				const deployHostMountPath = path.join(
					stackPaths.stackRoot,
					'walrus',
					resolved.name,
					'deploy',
				);
				yield* fs
					.makeDirectory(deployHostMountPath, { recursive: true })
					.pipe(Effect.catch(() => Effect.void));

				// Cross-container DNS: walrus containers (deploy one-shot
				// + N storage nodes) dial sui RPC + faucet via
				// `host.docker.internal`. The sui plugin binds brokered
				// host ports — no shared docker network needed.
				//
				// Architectural decision (B5): walrus owns its OWN docker
				// network (`walrus-${name}-net`) for storage-node ↔ deploy
				// connectivity; sui-side hops go through the host gateway.
				// On Linux this requires Docker Desktop or the
				// `host.docker.internal:host-gateway` runtime hint (the
				// established devstack convention — see plugins/deepbook
				// which uses the same pattern).
				const walrusNetworkName = `walrus-${resolved.name}-net`;
				const suiRpcUrlInNetwork = sui.hostGateway.rpcUrl;
				// sui-faucet v2 endpoint — `/v2/gas` is the supported path
				// on devnet-v1.71.0+ (the binary still answers `/v1/gas`
				// for backwards-compat but new code targets v2).
				const suiFaucetUrlInNetwork = sui.hostGateway.faucetUrl;
				if (suiFaucetUrlInNetwork === null) {
					return yield* Effect.fail(
						walrusPluginError(
							'deploy',
							'walrus local-cluster requires a Sui faucet URL for deploy funding.',
						),
					);
				}
				const walrusFaucetUrlInNetwork = `${suiFaucetUrlInNetwork}/v2/gas`;

				const mode: WalrusMode = { mode: 'local', opts: resolved };
				const boot = yield* bootWalrusService(
					{
						runtime,
						publisher,
						probe,
						suiSdk: sui.sdk,
						suiChainId: sui.chain,
						suiRpcUrlInNetwork,
						walrusFaucetUrlInNetwork,
						app: identity.app,
						stack: identity.stack,
						subnetPrefix: '10.42.7',
						walrusNetworkName,
						// Walrus has no `sui-net` to attach to (sui binds
						// host ports). Reuse the walrus network so the
						// deploy one-shot + storage nodes land on a single
						// network and reach sui via `host.docker.internal`.
						suiNetworkName: walrusNetworkName,
						deployHostMountPath,
						seedAccounts: resolvedSeedAccounts,
					},
					mode,
				);

				if (boot.mode !== 'local') {
					// Should be unreachable — dispatch is by mode. Defense.
					return yield* Effect.die('walrus: mode mismatch in local plugin');
				}

				// Dynamic WAL faucet strategy registration. The factory-time
				// capability decls can't carry the resolved exchange id,
				// so the contributor registers directly with the per-stack
				// StrategyRegistry. The scope-local finalizer drops the
				// entry on teardown.
				if (boot.walFaucetStrategy) {
					const registry = yield* StrategyRegistryService;
					yield* registry.register(WAL_FAUCET_STRATEGY_KEY, boot.walFaucetStrategy, {
						autoMounted: true,
					});
				}

				const resolvedValue: WalrusResolved = {
					mode: 'local',
					chain: sui.chain,
					packageConfig: {
						systemObjectId: boot.deploy.systemObject,
						stakingPoolId: boot.deploy.stakingObject,
						exchangeIds: boot.exchangeObjectId ? [boot.exchangeObjectId] : undefined,
					},
					nodes: boot.nodes,
					proxyUrl: boot.proxyUrl,
					aggregatorUrl: boot.aggregatorUrl,
					publisherUrl: boot.publisherUrl,
					admin: makeAdminShape(boot.adminSigner, sui.sdk, boot.exchange),
				};
				return resolvedValue;
			}),
		capabilities: (resolvedValue, acquireCtx) =>
			makeLocalCapabilities({
				name: resolved.name,
				nodeCount: resolved.nodeCount,
				containerApiPort: resolved.containerApiPort,
				compositeKey,
				composite,
				resolved: resolvedValue,
				acquireCtx,
			}),
		errorContributions: [{ _tag: 'PluginErrorContribution', errorTags: WALRUS_ERROR_TAGS }],
		liftedSiblings: siblingKeys,
	});
};

const buildKnownPlugin = (opts: WalrusKnownDeploymentOptions) => {
	// Synchronous factory-time validation (distilled-doc invariants
	// 14 + 16 — required systemObjectId/stakingPoolId/nodes; no admin).
	const resolved = resolveKnownDeploymentOptions(opts);

	return defineNodePlugin({
		provides: WalrusTag,
		consumes: [SuiTag] as const,
		// Known deployment is a pure value-producer — no containers,
		// no long-running children.
		kind: 'leaf-one-shot',
		rebootCost: 'cheap',
		acquire: () =>
			Effect.succeed({
				mode: 'known',
				chain: resolved.chain,
				packageConfig: {
					systemObjectId: resolved.systemObjectId,
					stakingPoolId: resolved.stakingPoolId,
					exchangeIds: resolved.exchangeIds.length > 0 ? resolved.exchangeIds : undefined,
				},
				nodes: resolved.nodes,
				proxyUrl: resolved.proxyUrl,
				aggregatorUrl: resolved.aggregatorUrl,
				publisherUrl: resolved.publisherUrl,
				// Distilled-doc invariant 14: NO admin tag in known mode.
				admin: null,
			} satisfies WalrusResolved),
		capabilities: (resolvedValue, acquireCtx) =>
			makeKnownCapabilities({
				resolved: resolvedValue,
				acquireCtx,
			}),
		errorContributions: [{ _tag: 'PluginErrorContribution', errorTags: WALRUS_ERROR_TAGS }],
	});
};

const makeLocalCapabilities = (parts: {
	readonly name: string;
	readonly nodeCount: number;
	readonly containerApiPort: number;
	readonly compositeKey: string;
	readonly composite: ReturnType<typeof makeWalrusComposite>;
	readonly resolved: WalrusResolved;
	readonly acquireCtx: AcquireContext;
}) => {
	const { name, nodeCount, containerApiPort, compositeKey, composite, resolved, acquireCtx } =
		parts;
	const snap: SnapshotableDecl = makeSnapshotable(
		'local' satisfies WalrusSnapshotMode,
		acquireCtx.identity.app,
		acquireCtx.identity.stack,
		name,
		resolved.chain,
		nodeCount,
	);
	const codegen: CodegenableDecl<WalrusBindings, 'walrus-network'> = makeCodegenable({
		mode: 'local',
		chain: resolved.chain,
		systemObjectId: resolved.packageConfig.systemObjectId,
		stakingPoolId: resolved.packageConfig.stakingPoolId,
		exchangeIds: resolved.packageConfig.exchangeIds ? [...resolved.packageConfig.exchangeIds] : [],
		proxyUrl: resolved.proxyUrl,
		aggregatorUrl: resolved.aggregatorUrl,
		publisherUrl: resolved.publisherUrl,
		nodes: resolved.nodes,
	});
	const stateRegistry: StrategyContributorDecl<
		typeof WALRUS_STATE_REGISTRY_KEY,
		{ readonly noteName: string }
	> = {
		kind: 'strategy-contributor',
		capabilityKey: WALRUS_STATE_REGISTRY_KEY,
		strategy: { noteName: name },
		autoMounted: true,
	};
	const routables = makeLocalRoutables({
		app: acquireCtx.identity.app,
		stack: acquireCtx.identity.stack,
		walrusName: name,
		compositeKey,
		nodeCount,
		containerApiPort,
	});
	// Variadic builder needs literal-typed inputs — we spread the
	// routables tuple explicitly so the `Caps` generic preserves
	// the per-decl narrow types.
	return capabilities(
		composite,
		snap,
		codegen,
		stateRegistry,
		...(routables as readonly RoutableDecl[]),
	);
};

const makeKnownCapabilities = (parts: {
	readonly resolved: WalrusResolved;
	readonly acquireCtx: AcquireContext;
}) => {
	const { resolved, acquireCtx } = parts;
	const snap: SnapshotableDecl = makeSnapshotable(
		'known' satisfies WalrusSnapshotMode,
		acquireCtx.identity.app,
		acquireCtx.identity.stack,
		'walrusKnownDeployment',
		resolved.chain,
	);
	const codegen: CodegenableDecl<WalrusBindings, 'walrus-network'> = makeCodegenable({
		mode: 'known',
		chain: resolved.chain,
		systemObjectId: resolved.packageConfig.systemObjectId,
		stakingPoolId: resolved.packageConfig.stakingPoolId,
		exchangeIds: resolved.packageConfig.exchangeIds ? [...resolved.packageConfig.exchangeIds] : [],
		proxyUrl: resolved.proxyUrl,
		aggregatorUrl: resolved.aggregatorUrl,
		publisherUrl: resolved.publisherUrl,
		nodes: resolved.nodes,
	});
	const stateRegistry: StrategyContributorDecl<typeof WALRUS_STATE_REGISTRY_KEY, WalrusStateEntry> =
		{
			kind: 'strategy-contributor',
			capabilityKey: WALRUS_STATE_REGISTRY_KEY,
			strategy: {
				name: 'walrusKnownDeployment',
				systemObjectId: resolved.packageConfig.systemObjectId,
				stakingObjectId: resolved.packageConfig.stakingPoolId,
				chain: resolved.chain,
			},
			autoMounted: true,
		};
	return capabilities(snap, codegen, stateRegistry);
};

/** Build the admin shape. `seedWal` dispatches via the first
 *  seedAccount (the WAL exchange admin signer per distilled-doc
 *  §"Configuration"). When no admin signer was wired OR no exchange
 *  was produced, the surface fails with a typed `WalrusPluginError`
 *  that names the missing input. */
const makeAdminShape = (
	adminSigner: AccountValue | null,
	sdk: WalSwapSdk,
	exchange: WalExchangeHandle | null,
): WalrusAdmin => ({
	seedWal: (args) => {
		if (!adminSigner) {
			return Effect.fail(
				walrusPluginError(
					'seed-wal',
					'walrus.admin.seedWal: no seed account wired — pass `seedAccounts: [account(...)]` to the walrus options to enable the admin signer.',
				),
			);
		}
		if (!exchange) {
			return Effect.fail(
				walrusPluginError(
					'seed-wal',
					'walrus.admin.seedWal: no WAL exchange object resolved — admin swaps require a live exchange.',
				),
			);
		}
		return Effect.scoped(
			swapSuiForWal({
				signer: adminSigner,
				sdk,
				exchange,
				recipientAddress: args.address,
				paymentMist: args.amount,
			}),
		);
	},
});

// ---------------------------------------------------------------------------
// User-facing factories
// ---------------------------------------------------------------------------

/** Env-driven factory. Defaults to local mode; reads `DEVSTACK_NETWORK`
 *  for non-local defaults. On a fork network, auto-routes to the
 *  known-deployment branch with the upstream network's record.
 *
 *  Distilled-doc invariant 13: `walrus()` on `*-fork` MUST auto-route
 *  to known-deployment with the wrapped upstream's `KnownNetwork`. */
export const walrus = <
	const Accounts extends ReadonlyArray<WalrusAccountMember> = readonly [],
>(opts?: {
	readonly local?: WalrusLocalClusterOptions<Accounts>;
}) => {
	const mode = resolveDefaultMode();
	switch (mode.mode) {
		case 'local':
			return buildLocalPlugin(opts?.local ?? ({} as WalrusLocalClusterOptions<Accounts>));
		case 'known':
			return buildKnownPlugin({ network: mode.network });
	}
};

/** Mode-narrowed factory namespace.
 *
 *  Usage:
 *      const network = { mode: 'local', chain: 'sui:localnet' } as const;
 *      walrusFor(network).local({...})    // OK
 *      walrusFor(network).known({...})    // type error: 'known' not in 'local' branch
 *
 *  Critically, the fork branch exposes ONLY `.known` — calling
 *  `.local` on a fork-mode network is a **compile error** at the
 *  call site (distilled-doc invariant 12 — type-level refusal).
 *  Runtime defense-in-depth: see `mode/fork-refusal.ts`. */
export const walrusFor = defineModeNamespace({
	local: {
		local: <const Accounts extends ReadonlyArray<WalrusAccountMember> = readonly []>(
			opts: WalrusLocalClusterOptions<Accounts> = {} as WalrusLocalClusterOptions<Accounts>,
		) => buildLocalPlugin(opts),
		known: (opts: WalrusKnownDeploymentOptions) => buildKnownPlugin(opts),
	},
	live: {
		known: (opts: WalrusKnownDeploymentOptions) => buildKnownPlugin(opts),
	},
	fork: {
		// `.local` is intentionally absent — calling
		// `walrusFor(forkNetwork).local(...)` is a compile error.
		known: (opts: WalrusKnownDeploymentOptions) => buildKnownPlugin(opts),
		// Defense-in-depth runtime refusal for callers that bypass
		// the typed namespace (e.g. via dynamic dispatch). The
		// factory throws synchronously with `ForkIncompatibleError`.
		_localRefused: (network: string): never => refuseLocalClusterOnFork(network),
	},
});

// ---------------------------------------------------------------------------
// Re-exports for advanced callers
// ---------------------------------------------------------------------------

export type {
	WalrusLocalClusterOptions,
	WalrusAccountMember,
	WalrusAccountTags,
} from './mode/local-cluster.ts';
export type { WalrusKnownDeploymentOptions, WalrusKnownNetwork } from './mode/known-deploy.ts';
export type { WalrusStorageNode } from './storage-nodes.ts';
export type { WalrusBindings, WalrusNodeBinding } from './codegen.ts';
export type { WalrusError, WalrusPluginError, WalrusConfigError, WalrusPhase } from './errors.ts';
// `ForkIncompatibleError` is the cross-cutting composite shape owned
// by `substrate/runtime/composite-errors.ts`; seal re-exports it
// under its canonical name from its barrel, so walrus exposes the
// SAME class under a walrus-namespaced alias to avoid a collision
// when a downstream consumer imports both plugin barrels in the same
// scope (STYLE_GUIDE §2 — one `_tag` literal per logical error type).
export type { ForkIncompatibleError as WalrusForkIncompatible } from './errors.ts';
export { WALRUS_ERROR_TAGS } from './errors.ts';
export {
	WAL_FAUCET_STRATEGY_KEY,
	type WalFaucetStrategy,
	type WalFaucetRequest,
	type WalSwapError,
} from './faucet-strategy.ts';
export {
	WALRUS_STATE_REGISTRY_KEY,
	type WalrusStateEntry,
	type WalrusLocalStateEntry,
	type WalrusKnownStateEntry,
} from './registry-publish.ts';
export { WALRUS_ROUTER_PORT } from './storage-nodes.ts';
