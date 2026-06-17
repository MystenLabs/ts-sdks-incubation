// Walrus plugin — barrel + factories.
//
// Architecture: Walrus is a service plugin that owns a local cluster
// or describes a known deployment. The factory at this file folds the
// four modes behind:
//
//   - `walrus(opts?)`           — local-cluster shorthand. No env
//                                  defaulting; use `walrusFor(...)`
//                                  for known deployments.
//   - `walrusFor(network)`  — mode-narrowed factory namespace
//                                  (architecture Tension 11). Returns
//                                  `{ local: …, known: … }` narrowed
//                                  to the network's mode. Crucially,
//                                  the fork branch exposes ONLY
//                                  `.known` — `.local` is a compile
//                                  error on a fork-mode network.
//
// During `start`, the plugin emits (via the typed `ctx.*` verbs, per mode):
//
//   Local mode (full local cluster):
//     1. `ctx.snapshotExtra`   — runtime/walrus/<name>/deploy/ subtree
//                                 + storage-node managed containers.
//     2. `ctx.codegen`         — `walrus-network` bindings.
//     3. `ctx.endpoint` × (N+2) — per-node + aggregator + publisher.
//     4. `ctx.provides` walrus-state-registry          — local entry.
//     5. `ctx.provides` endpoint-registry              — N+2 entries.
//     6. `ctx.provides` package-registry               — `walrus.<name>`.
//     7. `ctx.provides` coinType:<WAL fullCoinType>    — WAL faucet
//                                                        strategy
//                                                        (when exchange exists).
//
//   Known mode (read-only deployment):
//     1. `ctx.snapshotExtra`   — identity-guard only; no subtrees.
//     2. `ctx.codegen`         — `walrus-network` bindings (mode='known').
//     3. `ctx.provides` walrus-state-registry — known entry.
//
// Resource id: `'walrus'` (singular). The plugin's substrate-level
// plugin key is the same string.

import { Effect, Path } from 'effect';

import { defineModeNamespace } from '../../api/mode-narrowed-factory.ts';
import { definePlugin, resource, type ResourceRef } from '../../api/define-plugin.ts';
import type { ContainerRuntime } from '../../contracts/container-runtime.ts';
import type { RoutableDecl } from '../../contracts/routable.ts';
import type { StrategyContributorDecl } from '../../contracts/strategy-contributor.ts';
import { emitContributions, PluginContext } from '../../substrate/plugin-ctx.ts';
import { ContainerRuntimeService } from '../../runtime/docker/service.ts';
import { IdentityContext, StackPathsService } from '../../substrate/runtime/paths.ts';
import { CacheService } from '../../substrate/runtime/cache/index.ts';
import { deriveSubnetPrefix, withSubnetAddressing } from '../../substrate/runtime/subnet-broker.ts';
import type { AccountFundingCoinValue } from '../account/index.ts';
import { coinResourceId, type CoinResourceId } from '../coin/index.ts';
import { suiResource, type SuiProbeKey } from '../sui/index.ts';

import { chainProbeFor } from '../../substrate/runtime/strategy-registry/index.ts';

import { makeCodegenable, makeWalrusStaticCodegen } from './codegen.ts';
import { LOCAL_NETWORK_NAME } from '../../api/inference-network.ts';
import { walrusPluginKey } from './plugin-key.ts';
import { walrusPluginError, type WalrusPluginError } from './errors.ts';
import { makeWalFaucetContribution, type WalFaucetStrategy } from './faucet-strategy.ts';
import { bootWalrusService, type WalrusMode } from './service.ts';
import {
	resolveLocalClusterOptions,
	type WalrusLocalClusterOptions,
} from './mode/local-cluster.ts';
import {
	resolveKnownDeploymentOptions,
	type WalrusKnownDeploymentOptions,
} from './mode/known-deploy.ts';
import { makeSnapshotable, type WalrusSnapshotMode } from './snapshot.ts';
import { makeLocalRoutables } from './routable.ts';
import { WALRUS_STATE_REGISTRY_KEY, type WalrusStateEntry } from './registry-publish.ts';
import { buildWalrusNetworkName, type WalrusStorageNode } from './storage-nodes.ts';

// ---------------------------------------------------------------------------
// Resource — the resolved value all consumers read
// ---------------------------------------------------------------------------

/** The Walrus resolved value carried by the resource. */
export interface WalrusResolved {
	readonly mode: 'local' | 'known';
	/** Network name the walrus deployment targets (`localnet`/`testnet`/…). */
	readonly network: string;
	readonly walrusPackageId: string | null;
	readonly walPackageId: string | null;
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
	readonly walFaucetStrategy: WalFaucetStrategy | null;
	readonly walCoinType: string | null;
}

/** Walrus plugin resource. */
export const walrusResource = resource<'walrus', WalrusResolved>('walrus');

export interface WalrusNetworkIdentity {
	readonly app: string;
	readonly stack: string;
	readonly walrusName: string;
}

/** Walrus deploy records storage-node listening IPs under this /24.
 *  Docker network create requests the matching subnet explicitly, with
 *  the prefix derived from the Walrus network identity so parallel
 *  stacks don't all claim the same Docker IPAM range. Walrus claims
 *  the `10.64.*` – `10.127.*` band; see substrate/runtime/subnet-broker.ts
 *  for the algorithm and band coordination with seal. */
export const deriveWalrusSubnetPrefix = (identity: WalrusNetworkIdentity): string =>
	deriveSubnetPrefix(`${identity.app}\0${identity.stack}\0${identity.walrusName}`, 64);

const withWalrusNetworkAddressing = (
	runtime: ContainerRuntime,
	walrusNetworkName: string,
	subnetPrefix: string,
): ContainerRuntime => ({
	...runtime,
	ensureNetwork: (spec) =>
		runtime.ensureNetwork(
			spec.name === walrusNetworkName ? withSubnetAddressing(spec, subnetPrefix) : spec,
		),
});

// ---------------------------------------------------------------------------
// Plugin construction (internal — used by walrus() + walrusFor())
// ---------------------------------------------------------------------------

const buildLocalPlugin = (opts: WalrusLocalClusterOptions) => {
	// Synchronous factory-time validation (distilled-doc invariants
	// 11 — `nodeCount >= 1` + `shards >= nodeCount`).
	const resolved = resolveLocalClusterOptions(opts);

	const walrusKey = walrusPluginKey(resolved.name);

	return definePlugin({
		id: walrusResource.id,
		dependsOn: [suiResource] as const,
		role: 'service',
		section: 'service',
		pluginKey: walrusKey,
		// Stack-free codegen: a local walrus cluster's deploy ids / endpoint
		// URLs are LOADED CONFIG DATA -- the committed `walrus.ts` stub emits
		// `resolveValue('walrus', '<key>')`, never a baked object id / URL.
		staticCodegen: () => [makeWalrusStaticCodegen({ mode: 'local', network: LOCAL_NETWORK_NAME })],
		// `deps` auto-infers the resolved `[sui]` tuple from the
		// `[suiResource] as const` dependency. `ctx` arrives via the
		// `PluginContext` service.
		start: (deps) =>
			Effect.gen(function* () {
				const ctx = yield* PluginContext;
				const [sui] = deps;

				// Substrate-context primitives:
				//   - `ContainerRuntimeService` + `IdentityContext` arrive
				//     via the supervisor's plugin runtime context.
				//   - `ArtifactPublisher` is the substrate-level
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
				const path = yield* Path.Path;
				const publisher = yield* CacheService;
				const probe = yield* chainProbeFor<SuiProbeKey>(sui.chainId);

				// Resolve the deploy-output bind-mount source from the
				// per-stack paths bundle. The deploy one-shot owns preparing
				// the directory immediately before its Docker bind mount.
				const deployHostMountPath = path.join(
					stackPaths.stackRoot,
					'walrus',
					resolved.name,
					'deploy',
				);

				// Cross-container DNS: walrus containers (deploy one-shot
				// + N storage nodes) dial sui RPC + faucet via
				// `host.docker.internal`. The sui plugin binds brokered
				// host ports — no shared docker network needed.
				//
				// Architectural decision (B5): walrus owns its OWN docker
				// network for storage-node ↔ deploy connectivity; sui-side
				// hops go through the host gateway.
				// On Linux this requires Docker Desktop or the
				// `host.docker.internal:host-gateway` runtime hint (the
				// established devstack convention — see plugins/deepbook
				// which uses the same pattern).
				const walrusNetworkName = buildWalrusNetworkName(
					identity.app,
					identity.stack,
					resolved.name,
				);
				const walrusSubnetPrefix = deriveWalrusSubnetPrefix({
					app: identity.app,
					stack: identity.stack,
					walrusName: resolved.name,
				});
				const walrusRuntime = withWalrusNetworkAddressing(
					runtime,
					walrusNetworkName,
					walrusSubnetPrefix,
				);
				const suiRpcUrlInNetwork = sui.hostGateway.rpcUrl;
				// sui-faucet v2 endpoint — `/v2/gas` is the supported path
				// on devnet-v1.71.0+.
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
						runtime: walrusRuntime,
						publisher,
						probe,
						suiSdk: sui.sdk,
						suiChainId: sui.chainId,
						suiRpcUrlInNetwork,
						walrusFaucetUrlInNetwork,
						waitForFundsReady: sui.waitForTransactionsReady.wait,
						app: identity.app,
						stack: identity.stack,
						subnetPrefix: walrusSubnetPrefix,
						walrusNetworkName,
						// Walrus has no `sui-net` to attach to (sui binds
						// host ports). Reuse the walrus network so the
						// deploy one-shot + storage nodes land on a single
						// network and reach sui via `host.docker.internal`.
						suiNetworkName: walrusNetworkName,
						deployHostMountPath,
						stackRoot: stackPaths.stackRoot,
					},
					mode,
				);

				if (boot.mode !== 'local') {
					// Should be unreachable — dispatch is by mode. Defense.
					return yield* Effect.die('walrus: mode mismatch in local plugin');
				}

				const resolvedValue: WalrusResolved = {
					mode: 'local',
					network: identity.network,
					walrusPackageId: boot.walrusPackageId,
					walPackageId: boot.walPackageId,
					packageConfig: {
						systemObjectId: boot.deploy.systemObject,
						stakingPoolId: boot.deploy.stakingObject,
						exchangeIds: boot.exchangeObjectId ? [boot.exchangeObjectId] : undefined,
					},
					nodes: boot.nodes,
					proxyUrl: boot.proxyUrl,
					aggregatorUrl: boot.aggregatorUrl,
					publisherUrl: boot.publisherUrl,
					walFaucetStrategy: boot.walFaucetStrategy,
					walCoinType: boot.walCoinType,
				};
				// Emit the resolved contributions inline: snapshot → codegen →
				// state-registry → (optional WAL faucet) → routables. `identity`
				// (from `IdentityContext`) stamps the snapshot + routable
				// container names. ID-stability surfaces (deploy/blob ids via
				// ArtifactPublisher) live OUTSIDE this emission and are untouched.
				const walFaucetContribution: ReadonlyArray<StrategyContributorDecl> =
					resolvedValue.walFaucetStrategy === null || resolvedValue.walCoinType === null
						? []
						: [
								makeWalFaucetContribution(
									resolvedValue.walFaucetStrategy,
									resolvedValue.walCoinType,
								),
							];
				emitContributions(ctx, [
					makeSnapshotable(
						'local' satisfies WalrusSnapshotMode,
						identity.app,
						identity.stack,
						resolved.name,
						resolvedValue.network,
						resolved.nodeCount,
					),
					makeCodegenable({
						mode: 'local',
						network: resolvedValue.network,
						walrusPackageId: resolvedValue.walrusPackageId,
						walPackageId: resolvedValue.walPackageId,
						walCoinType: resolvedValue.walCoinType,
						systemObjectId: resolvedValue.packageConfig.systemObjectId,
						stakingPoolId: resolvedValue.packageConfig.stakingPoolId,
						exchangeIds: resolvedValue.packageConfig.exchangeIds
							? [...resolvedValue.packageConfig.exchangeIds]
							: [],
						proxyUrl: resolvedValue.proxyUrl,
						aggregatorUrl: resolvedValue.aggregatorUrl,
						publisherUrl: resolvedValue.publisherUrl,
						nodes: resolvedValue.nodes,
					}),
					{
						kind: 'strategy-contributor',
						capabilityKey: WALRUS_STATE_REGISTRY_KEY,
						strategy: { noteName: resolved.name },
						autoMounted: true,
					} satisfies StrategyContributorDecl<
						typeof WALRUS_STATE_REGISTRY_KEY,
						{ readonly noteName: string }
					>,
					...walFaucetContribution,
					...(makeLocalRoutables({
						app: identity.app,
						stack: identity.stack,
						walrusName: resolved.name,
						serviceKey: String(walrusKey),
						nodeCount: resolved.nodeCount,
						containerApiPort: resolved.containerApiPort,
					}) as readonly RoutableDecl[]),
				]);
				return resolvedValue;
			}),
	});
};

const buildKnownPlugin = (opts: WalrusKnownDeploymentOptions) => {
	// Synchronous factory-time validation for required deployment ids.
	const resolved = resolveKnownDeploymentOptions(opts);

	return definePlugin({
		id: walrusResource.id,
		dependsOn: [suiResource] as const,
		// Known deployment is a pure value-producer — no containers,
		// no long-running children.
		role: 'task',
		section: 'service',
		// Stack-free codegen: a known deployment's ids / URLs are DECLARED
		// config (not loaded-at-runtime data) — bake them as literals in the
		// committed `walrus.ts` (mirrors `knownPackage`). `walrusPackageId` /
		// `walPackageId` / `walCoinType` are null for a known deployment.
		staticCodegen: () => [
			makeWalrusStaticCodegen({
				mode: 'known',
				network: resolved.network,
				known: {
					walrusPackageId: null,
					walPackageId: null,
					walCoinType: null,
					packageConfig: {
						systemObjectId: resolved.systemObjectId,
						stakingPoolId: resolved.stakingPoolId,
						...(resolved.exchangeIds.length > 0
							? { exchangeIds: [...resolved.exchangeIds] }
							: {}),
					},
					proxyUrl: resolved.proxyUrl,
					aggregatorUrl: resolved.aggregatorUrl,
					publisherUrl: resolved.publisherUrl,
					nodes: resolved.nodes,
				},
			}),
		],
		// Known mode is a pure value-producer — `sui` is unused (the value
		// reads `resolved.chain` from the deployment options) but the
		// `dependsOn` edge still orders boot, so `start` is zero-arg.
		// `ctx` arrives via the `PluginContext` service.
		start: () =>
			Effect.gen(function* () {
				const ctx = yield* PluginContext;
				const identity = yield* IdentityContext;
				const resolvedValue = {
					mode: 'known',
					network: resolved.network,
					walrusPackageId: null,
					walPackageId: null,
					packageConfig: {
						systemObjectId: resolved.systemObjectId,
						stakingPoolId: resolved.stakingPoolId,
						exchangeIds: resolved.exchangeIds.length > 0 ? resolved.exchangeIds : undefined,
					},
					nodes: resolved.nodes,
					proxyUrl: resolved.proxyUrl,
					aggregatorUrl: resolved.aggregatorUrl,
					publisherUrl: resolved.publisherUrl,
					walFaucetStrategy: null,
					walCoinType: null,
				} satisfies WalrusResolved;
				// Emit inline: snapshot → codegen → state-registry. Known mode
				// emits no routable. `identity` (from `IdentityContext`) stamps
				// the snapshot scoping.
				ctx.snapshotExtra(
					makeSnapshotable(
						'known' satisfies WalrusSnapshotMode,
						identity.app,
						identity.stack,
						'walrusKnownDeployment',
						resolvedValue.network,
					),
				);
				ctx.codegen(
					makeCodegenable({
						mode: 'known',
						network: resolvedValue.network,
						walrusPackageId: resolvedValue.walrusPackageId,
						walPackageId: resolvedValue.walPackageId,
						walCoinType: resolvedValue.walCoinType,
						systemObjectId: resolvedValue.packageConfig.systemObjectId,
						stakingPoolId: resolvedValue.packageConfig.stakingPoolId,
						exchangeIds: resolvedValue.packageConfig.exchangeIds
							? [...resolvedValue.packageConfig.exchangeIds]
							: [],
						proxyUrl: resolvedValue.proxyUrl,
						aggregatorUrl: resolvedValue.aggregatorUrl,
						publisherUrl: resolvedValue.publisherUrl,
						nodes: resolvedValue.nodes,
					}),
				);
				ctx.provides({
					kind: 'strategy-contributor',
					capabilityKey: WALRUS_STATE_REGISTRY_KEY,
					strategy: {
						name: 'walrusKnownDeployment',
						systemObjectId: resolvedValue.packageConfig.systemObjectId,
						stakingObjectId: resolvedValue.packageConfig.stakingPoolId,
						network: resolvedValue.network,
					},
					autoMounted: true,
				} satisfies StrategyContributorDecl<typeof WALRUS_STATE_REGISTRY_KEY, WalrusStateEntry>);
				return resolvedValue;
			}),
	});
};

export interface WalCoinValue extends AccountFundingCoinValue {
	readonly symbol: 'WAL';
	readonly fullCoinType: `${string}::wal::WAL`;
	readonly decimals: 9;
	readonly source: 'walrus';
}

/** Resolve the local Walrus deployment's WAL coin as an account-funding
 *  coin ref. Accounts that need WAL should use:
 *
 *      funding: [{ coin: walCoin(localWalrus), amount }]
 *
 *  The funding strategy itself is contributed by the Walrus service
 *  once its local exchange exists. */
export const walCoin = (walrusMember: ResourceRef<'walrus', WalrusResolved>) => {
	const coinRef = resource<CoinResourceId<'wal'>, WalCoinValue>(coinResourceId('wal'));

	return definePlugin({
		id: coinRef.id,
		dependsOn: walrusMember,
		role: 'task',
		section: 'action',
		start: (resolved): Effect.Effect<WalCoinValue, WalrusPluginError> =>
			Effect.gen(function* () {
				if (resolved.walCoinType === null) {
					return yield* Effect.fail(
						walrusPluginError(
							'exchange',
							'walCoin(...) requires a local Walrus deployment with a WAL package.',
						),
					);
				}
				return {
					symbol: 'WAL',
					fullCoinType: resolved.walCoinType as `${string}::wal::WAL`,
					decimals: 9,
					source: 'walrus',
				} satisfies WalCoinValue;
			}),
	});
};

// ---------------------------------------------------------------------------
// User-facing factories
// ---------------------------------------------------------------------------

/** Local-cluster shorthand. Known deployments are selected through
 *  `walrusFor(network).known(...)` so network choice stays explicit. */
export const walrus = (opts?: { readonly local?: WalrusLocalClusterOptions }) => {
	return buildLocalPlugin(opts?.local ?? {});
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
 *  call site (distilled-doc invariant 12 — type-level refusal). */
export const walrusFor = defineModeNamespace({
	local: {
		local: (opts: WalrusLocalClusterOptions = {}) => buildLocalPlugin(opts),
		known: (opts: WalrusKnownDeploymentOptions) => buildKnownPlugin(opts),
	},
	live: {
		known: (opts: WalrusKnownDeploymentOptions) => buildKnownPlugin(opts),
	},
	fork: {
		// `.local` is intentionally absent — calling
		// `walrusFor(forkNetwork).local(...)` is a compile error.
		known: (opts: WalrusKnownDeploymentOptions) => buildKnownPlugin(opts),
	},
});

// ---------------------------------------------------------------------------
// Re-exports for advanced callers
// ---------------------------------------------------------------------------

export type { WalrusLocalClusterOptions } from './mode/local-cluster.ts';
export type { WalrusKnownDeploymentOptions, WalrusKnownNetwork } from './mode/known-deploy.ts';
export type { WalrusStorageNode } from './storage-nodes.ts';
export type { WalrusBindings, WalrusNodeBinding } from './codegen.ts';
export type { WalrusError, WalrusPluginError, WalrusConfigError, WalrusPhase } from './errors.ts';
export { walCoinType, walFaucetStrategyKey, type WalFaucetStrategy } from './faucet-strategy.ts';
export {
	WALRUS_STATE_REGISTRY_KEY,
	type WalrusStateEntry,
	type WalrusLocalStateEntry,
	type WalrusKnownStateEntry,
} from './registry-publish.ts';
