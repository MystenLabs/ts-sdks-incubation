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
// The plugin emits FOUR capability decls (per mode):
//
//   Local mode (full local cluster):
//     1. `snapshotable`        — runtime/walrus/<name>/deploy/ subtree
//                                 + storage-node managed containers.
//     2. `codegenable`         — `walrus-network` bindings.
//     3. `routable` × (N + 2)  — per-node + aggregator + publisher.
//     4. `strategy-contributor:walrus-state-registry`  — local entry.
//     5. `strategy-contributor:endpoint-registry`      — N+2 entries.
//     6. `strategy-contributor:package-registry`       — `walrus.<name>`.
//     7. `strategy-contributor:coinType:<WAL fullCoinType>`
//                                                      — WAL faucet
//                                                        strategy
//                                                        (when exchange exists).
//
//   Known mode (read-only deployment):
//     1. `snapshotable`        — identity-guard only; no subtrees.
//     2. `codegenable`         — `walrus-network` bindings (mode='known').
//     3. `strategy-contributor:walrus-state-registry` — known entry.
//
// Resource id: `'walrus'` (singular). The plugin's substrate-level
// plugin key is the same string.

import { Effect, Path } from 'effect';

import { defineModeNamespace } from '../../api/mode-narrowed-factory.ts';
import { definePlugin, resource, type ResourceRef } from '../../api/define-plugin.ts';
import { pluginErrorContributions } from '../../api/plugin-errors.ts';
import type { CodegenableDecl } from '../../contracts/codegenable.ts';
import type { ContainerRuntime, EnsureNetworkSpec } from '../../contracts/container-runtime.ts';
import type { RoutableDecl } from '../../contracts/routable.ts';
import type { SnapshotableDecl } from '../../contracts/snapshotable.ts';
import type { StrategyContributorDecl } from '../../contracts/strategy-contributor.ts';
import { ContainerRuntimeService } from '../../runtime/docker/service.ts';
import { IdentityContext, StackPathsService } from '../../substrate/runtime/paths.ts';
import { ArtifactPublisherService } from '../../substrate/runtime/artifact-publisher/index.ts';
import type { AcquireContext } from '../../substrate/plugin.ts';
import type { AccountFundingCoinValue } from '../account/index.ts';
import { coinResourceId, type CoinResourceId } from '../coin/index.ts';
import { suiResource, type SuiProbeKey } from '../sui/index.ts';

import { chainProbeFor } from '../../substrate/runtime/strategy-registry/index.ts';

import { makeCodegenable } from './codegen.ts';
import { walrusPluginKey } from './plugin-key.ts';
import { WALRUS_ERROR_TAGS, walrusPluginError, type WalrusPluginError } from './errors.ts';
import { walFaucetStrategyKey, type WalFaucetStrategy } from './faucet-strategy.ts';
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
	readonly chain: string;
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
const walrusErrorContributions = pluginErrorContributions(WALRUS_ERROR_TAGS);

export interface WalrusNetworkIdentity {
	readonly app: string;
	readonly stack: string;
	readonly walrusName: string;
}

/** Walrus deploy records storage-node listening IPs under this /24.
 *  Docker network create requests the matching subnet explicitly, with
 *  the prefix derived from the Walrus network identity so parallel
 *  stacks don't all claim the same Docker IPAM range. */
export const deriveWalrusSubnetPrefix = (identity: WalrusNetworkIdentity): string => {
	const key = `${identity.app}\0${identity.stack}\0${identity.walrusName}`;
	let hash = 0x811c9dc5;
	for (let i = 0; i < key.length; i += 1) {
		hash ^= key.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	const bucket = hash % (64 * 256);
	const secondOctet = 64 + Math.floor(bucket / 256);
	const thirdOctet = bucket % 256;
	return `10.${secondOctet}.${thirdOctet}`;
};

export const walrusNetworkCreateSpec = <Spec extends EnsureNetworkSpec>(
	spec: Spec,
	subnetPrefix: string,
): Spec & Required<Pick<EnsureNetworkSpec, 'subnet' | 'gateway'>> => ({
	...spec,
	subnet: `${subnetPrefix}.0/24`,
	gateway: `${subnetPrefix}.1`,
});

const withWalrusNetworkAddressing = (
	runtime: ContainerRuntime,
	walrusNetworkName: string,
	subnetPrefix: string,
): ContainerRuntime => ({
	...runtime,
	ensureNetwork: (spec) =>
		runtime.ensureNetwork(
			spec.name === walrusNetworkName ? walrusNetworkCreateSpec(spec, subnetPrefix) : spec,
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
		pluginKey: walrusKey,
		start: (deps) =>
			Effect.gen(function* () {
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
				const publisher = yield* ArtifactPublisherService;
				const probe = yield* chainProbeFor<SuiProbeKey>(sui.chain);

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
						runtime: walrusRuntime,
						publisher,
						probe,
						suiSdk: sui.sdk,
						suiChainId: sui.chain,
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
					},
					mode,
				);

				if (boot.mode !== 'local') {
					// Should be unreachable — dispatch is by mode. Defense.
					return yield* Effect.die('walrus: mode mismatch in local plugin');
				}

				const resolvedValue: WalrusResolved = {
					mode: 'local',
					chain: sui.chain,
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
				return resolvedValue;
			}),
		capabilities: ({ value: resolvedValue, runtime: acquireCtx }) =>
			makeLocalCapabilities({
				name: resolved.name,
				nodeCount: resolved.nodeCount,
				containerApiPort: resolved.containerApiPort,
				serviceKey: String(walrusKey),
				resolved: resolvedValue,
				acquireCtx,
			}),
		errorContributions: walrusErrorContributions,
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
		start: () =>
			Effect.succeed({
				mode: 'known',
				chain: resolved.chain,
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
			} satisfies WalrusResolved),
		capabilities: ({ value: resolvedValue, runtime: acquireCtx }) =>
			makeKnownCapabilities({
				resolved: resolvedValue,
				acquireCtx,
			}),
		errorContributions: walrusErrorContributions,
	});
};

const makeLocalCapabilities = (parts: {
	readonly name: string;
	readonly nodeCount: number;
	readonly containerApiPort: number;
	readonly serviceKey: string;
	readonly resolved: WalrusResolved;
	readonly acquireCtx: AcquireContext;
}) => {
	const { name, nodeCount, containerApiPort, serviceKey, resolved, acquireCtx } = parts;
	const snap: SnapshotableDecl = makeSnapshotable(
		'local' satisfies WalrusSnapshotMode,
		acquireCtx.identity.app,
		acquireCtx.identity.stack,
		name,
		resolved.chain,
		nodeCount,
	);
	const codegen: CodegenableDecl<'walrus-network'> = makeCodegenable({
		mode: 'local',
		chain: resolved.chain,
		walrusPackageId: resolved.walrusPackageId,
		walPackageId: resolved.walPackageId,
		walCoinType: resolved.walCoinType,
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
	const walFaucetContribution =
		resolved.walFaucetStrategy === null || resolved.walCoinType === null
			? []
			: [
					{
						kind: 'strategy-contributor',
						capabilityKey: walFaucetStrategyKey(resolved.walCoinType),
						strategy: resolved.walFaucetStrategy,
						autoMounted: true,
					} satisfies StrategyContributorDecl<
						ReturnType<typeof walFaucetStrategyKey>,
						WalFaucetStrategy
					>,
				];
	const routables = makeLocalRoutables({
		app: acquireCtx.identity.app,
		stack: acquireCtx.identity.stack,
		walrusName: name,
		serviceKey,
		nodeCount,
		containerApiPort,
	});
	return [
		snap,
		codegen,
		stateRegistry,
		...walFaucetContribution,
		...(routables as readonly RoutableDecl[]),
	] as const;
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
	const codegen: CodegenableDecl<'walrus-network'> = makeCodegenable({
		mode: 'known',
		chain: resolved.chain,
		walrusPackageId: resolved.walrusPackageId,
		walPackageId: resolved.walPackageId,
		walCoinType: resolved.walCoinType,
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
	return [snap, codegen, stateRegistry] as const;
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
		errorContributions: walrusErrorContributions,
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
export { WALRUS_ERROR_TAGS } from './errors.ts';
export {
	walCoinType,
	walFaucetStrategyKey,
	type WalFaucetStrategy,
	type WalFaucetRequest,
} from './faucet-strategy.ts';
export {
	WALRUS_STATE_REGISTRY_KEY,
	type WalrusStateEntry,
	type WalrusLocalStateEntry,
	type WalrusKnownStateEntry,
} from './registry-publish.ts';
export { WALRUS_ROUTER_PORT } from './storage-nodes.ts';
export { WalrusSpans } from './spans.ts';
