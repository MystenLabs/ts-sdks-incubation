// Sui plugin — barrel + factories.
//
// Architecture: Sui is the most-depended-on plugin in the stack.
// Every consumer (Account/Coin/Wallet/Faucet/Package; Walrus/Seal/
// Deepbook fork variants) reads its resolved `SuiClient` via the
// `suiResource`. The factory at this file folds the four modes behind:
//
//   - `sui(opts?)`         — local shorthand. Defaults to an in-stack
//                              local validator; pass a typed `opts`
//                              record to select a different mode.
//   - `suiFor(network)`    — mode-narrowed factory namespace (per
//                              architecture Tension 11). Returns
//                              `{ local: …, live: …, fork: … }`
//                              narrowed to the network's mode.
//
// The plugin emits FIVE capability decls:
//
//   1. `chain-probe:<chainId>` strategy contributor — the
//      schema-validated read surface (`makeSuiChainProbe`).
//   2. `gate:funds-ready` strategy contributor — the funds-
//      transferable gate. No-op on faucet-less networks.
//   3. `sui:seed-objects` strategy contributor — the per-instance
//      seed-objects accumulator (fork mode only; emits an empty
//      accumulator on other modes for shape uniformity).
//   4. Snapshotable — mode-aware container + bind-mount capture.
//   5. Codegenable — `sui-network` bindings (chain id, rpc, etc.).
//
// Routable contributions are MODE-DEPENDENT (local + fork yes;
// local-rpc + live no — the caller fronts their own RPC). They land
// in the per-mode builder under `mode/*.ts`; this barrel composes
// them into the plugin capability array.

import { Effect } from 'effect';

import { defineModeNamespace } from '../../api/mode-narrowed-factory.ts';
import { definePlugin, resource } from '../../api/define-plugin.ts';
import { pluginErrorContributions } from '../../api/plugin-errors.ts';
import type { ChainProbe } from '../../contracts/chain-probe.ts';
import type { CodegenableDecl } from '../../contracts/codegenable.ts';
import type { SnapshotableDecl } from '../../contracts/snapshotable.ts';
import type { StrategyContributorDecl } from '../../contracts/strategy-contributor.ts';
import { FUNDS_READY_GATE_KEY } from '../../contracts/network-resolver.ts';
import type { AcquireContext } from '../../substrate/plugin.ts';

import { chainProbeCapabilityKey } from '../../contracts/chain-probe.ts';
import { ContainerRuntimeService } from '../../runtime/docker/service.ts';
import { IdentityContext, StackPathsService } from '../../substrate/runtime/paths.ts';
import {
	LeaseBrokerService,
	type LeaseBroker,
} from '../../substrate/runtime/lease-broker/index.ts';
import { PortBrokerService } from '../../substrate/runtime/port-broker/index.ts';
import { makeCodegenable } from './codegen.ts';
import type { SuiProbeKey } from './chain-probe.ts';
import { makeSnapshotable } from './snapshot.ts';
import {
	makeSeedObjectsAccumulator,
	SEED_OBJECTS_CAPABILITY_KEY,
	type SeedObjectsAccumulator,
} from './seed-objects.ts';
import { bootSuiService } from './service.ts';
import { SUI_ERROR_TAGS, type SuiPluginError } from './errors.ts';
import { makeSuiForkRoutables, makeSuiLocalRoutables } from './routable.ts';
import { faucetCapabilityKey } from '../faucet/index.ts';
import { suiLocalStrategy } from './local-faucet-strategy.ts';
import type { SuiClient } from './mode/shared.ts';
import type {
	SuiForkOptions,
	SuiLiveOptions,
	SuiLocalRpcOptions,
	SuiLocalOptions,
	SuiOptions,
} from './mode/spec.ts';

// ---------------------------------------------------------------------------
// Resource identity
// ---------------------------------------------------------------------------

type SuiResolved = SuiClient & {
	readonly mode: SuiOptions['mode'];
	readonly seedObjects: SeedObjectsAccumulator;
};

const fundingFaucetLeaseBrokerSymbol: unique symbol = Symbol(
	'@mysten-incubation/devstack/sui/fundingFaucetLeaseBroker',
);

type SuiResolvedRuntime = SuiResolved & {
	readonly [fundingFaucetLeaseBrokerSymbol]: LeaseBroker;
};

/** The Sui plugin's resource identity. The id is `'sui'` (singular). */
export const suiResource = resource<'sui', SuiResolved>('sui');
const suiErrorContributions = pluginErrorContributions(SUI_ERROR_TAGS);

// ---------------------------------------------------------------------------
// Plugin construction (internal — used by sui() + suiFor())
// ---------------------------------------------------------------------------

const buildPlugin = (opts: SuiOptions) => {
	return definePlugin({
		id: suiResource.id,
		role: 'service',
		start: () =>
			Effect.gen(function* () {
				// The substrate threads `ContainerRuntime` + `IdentityContext`
				// via the plugin runtime context; the supervisor provides
				// these before this body runs.
				const runtime = yield* ContainerRuntimeService;
				const identity = yield* IdentityContext;
				const paths = yield* StackPathsService;
				const portBroker = yield* PortBrokerService;
				const fundingFaucetLeaseBroker = yield* LeaseBrokerService;
				const { client } = yield* bootSuiService(runtime, identity, portBroker, paths, opts);

				const seedObjects = yield* makeSeedObjectsAccumulator();
				return {
					...client,
					mode: opts.mode,
					seedObjects,
					[fundingFaucetLeaseBrokerSymbol]: fundingFaucetLeaseBroker,
				} satisfies SuiResolvedRuntime;
			}),
		capabilities: ({ value, runtime }) => makePluginCapabilities(opts, value, runtime),
		errorContributions: suiErrorContributions,
	});
};

/** Construct the capability tuple POST-acquire. Receives the resolved
 *  `SuiClient` + acquire context so decls can stamp REAL chain ids /
 *  rpc URLs into their fields instead of factory-time placeholders.
 *
 *  StrategyContributor declarations here carry real post-acquire
 *  strategy values. The generic strategy sink registers them on the
 *  scope-local `StrategyRegistry`. */
const makePluginCapabilities = (
	opts: SuiOptions,
	resolved: SuiResolved,
	acquireCtx: AcquireContext,
) => {
	const realChain = resolved.chain;
	const resolvedRuntime = resolved as SuiResolvedRuntime;
	const snap: SnapshotableDecl = makeSnapshotable(
		opts.mode,
		acquireCtx.identity.app,
		acquireCtx.identity.stack,
		realChain,
	);
	const codegen: CodegenableDecl<'sui-network'> = makeCodegenable({
		mode: opts.mode,
		chain: realChain,
		rpc: resolved.rpcUrl,
		source: 'default',
		...(resolved.faucetUrl !== null ? { faucet: resolved.faucetUrl } : {}),
		...(resolved.graphqlUrl !== null ? { graphql: resolved.graphqlUrl } : {}),
	});

	const chainProbeContribution: StrategyContributorDecl<
		`chain-probe:${string}`,
		ChainProbe<SuiProbeKey>
	> = {
		kind: 'strategy-contributor',
		capabilityKey: chainProbeCapabilityKey(realChain),
		strategy: resolved.chainProbe,
		autoMounted: true,
	};

	const fundsReadyContribution: StrategyContributorDecl<
		typeof FUNDS_READY_GATE_KEY,
		{
			readonly waitFundsReady: Effect.Effect<void, SuiPluginError>;
		}
	> = {
		kind: 'strategy-contributor',
		capabilityKey: FUNDS_READY_GATE_KEY,
		strategy: { waitFundsReady: resolved.waitForTransactionsReady.wait },
		autoMounted: true,
	};

	const seedObjectsContribution: StrategyContributorDecl<
		typeof SEED_OBJECTS_CAPABILITY_KEY,
		SeedObjectsAccumulator
	> = {
		kind: 'strategy-contributor',
		capabilityKey: SEED_OBJECTS_CAPABILITY_KEY,
		strategy: resolved.seedObjects,
		autoMounted: true,
	};

	const faucetContribution =
		resolved.fundingFaucetUrl === null
			? []
			: [
					{
						kind: 'strategy-contributor',
						capabilityKey: faucetCapabilityKey(realChain),
						strategy: suiLocalStrategy({
							faucetUrl: resolved.fundingFaucetUrl,
							serialization: {
								broker: resolvedRuntime[fundingFaucetLeaseBrokerSymbol],
								key: `sui-faucet:${realChain}`,
								owner: `sui-faucet:${realChain}`,
							},
						}),
						autoMounted: true,
					} satisfies StrategyContributorDecl<
						`faucet:request:${string}`,
						ReturnType<typeof suiLocalStrategy>
					>,
				];

	const localRoutables =
		opts.mode === 'local'
			? makeSuiLocalRoutables({
					containerName: `devstack-${acquireCtx.identity.app}-${acquireCtx.identity.stack}-sui-validator`,
					includeGraphql: true,
				})
			: [];
	const forkRoutables =
		opts.mode === 'fork'
			? makeSuiForkRoutables({
					containerName: `devstack-${acquireCtx.identity.app}-${acquireCtx.identity.stack}-sui-fork`,
				})
			: [];

	return [
		snap,
		codegen,
		chainProbeContribution,
		...faucetContribution,
		fundsReadyContribution,
		seedObjectsContribution,
		...localRoutables,
		...forkRoutables,
	] as const;
};

// ---------------------------------------------------------------------------
// User-facing factories
// ---------------------------------------------------------------------------

/** Local Sui shorthand. Network/env selection belongs to the CLI or
 *  `defineDevstackWith(...)`; plain `sui()` always means an in-stack
 *  local validator. */
export const sui = (opts: SuiOptions = { mode: 'local' }) => buildPlugin(opts);

/** Mode-narrowed factory namespace.
 *
 *  Usage:
 *      const network = { mode: 'local', chain: 'sui:localnet' } as const;
 *      suiFor(network).local({...})    // OK
 *      suiFor(network).fork({...})     // type error: 'fork' not in 'local' branch
 *
 *  The namespace MIRRORS the four mode option records: `local`,
 *  `localRpc` (mapped onto the substrate `'local'` branch),
 *  `live`, `fork`. */
export const suiFor = defineModeNamespace({
	local: {
		local: (opts: Omit<SuiLocalOptions, 'mode'> = {}) => buildPlugin({ mode: 'local', ...opts }),
		localRpc: (opts: Omit<SuiLocalRpcOptions, 'mode'>) =>
			buildPlugin({ mode: 'local-rpc', ...opts }),
	},
	live: {
		testnet: (opts: Omit<SuiLiveOptions, 'mode' | 'network'> = {}) =>
			buildPlugin({ mode: 'live', network: 'testnet', ...opts }),
		mainnet: (opts: Omit<SuiLiveOptions, 'mode' | 'network'> = {}) =>
			buildPlugin({ mode: 'live', network: 'mainnet', ...opts }),
		devnet: (opts: Omit<SuiLiveOptions, 'mode' | 'network'> = {}) =>
			buildPlugin({ mode: 'live', network: 'devnet', ...opts }),
		custom: (opts: Omit<SuiLiveOptions, 'mode' | 'network'>) =>
			buildPlugin({ mode: 'live', network: 'custom', ...opts }),
	},
	fork: {
		mainnet: (opts: Omit<SuiForkOptions, 'mode' | 'upstream'> = {}) =>
			buildPlugin({ mode: 'fork', upstream: 'mainnet', ...opts }),
		testnet: (opts: Omit<SuiForkOptions, 'mode' | 'upstream'> = {}) =>
			buildPlugin({ mode: 'fork', upstream: 'testnet', ...opts }),
		devnet: (opts: Omit<SuiForkOptions, 'mode' | 'upstream'> = {}) =>
			buildPlugin({ mode: 'fork', upstream: 'devnet', ...opts }),
	},
});

// ---------------------------------------------------------------------------
// Re-exports for advanced callers (Account/Coin/Wallet/etc.) and for
// the sibling plugins (Walrus/Seal/Deepbook fork variants).
// ---------------------------------------------------------------------------

export type { SuiClient, ForkAdminSurface, WaitForTransactionsReady } from './mode/shared.ts';
export type { ResolvedSuiNetwork } from './network-resolver.ts';
export type {
	SuiOptions,
	SuiLocalOptions,
	SuiLocalRpcOptions,
	SuiLiveOptions,
	SuiForkOptions,
	SuiPluginMode,
} from './mode/spec.ts';
export type { SuiNetworkBindings } from './codegen.ts';
export type {
	SuiError,
	SuiPluginError,
	SuiCliError,
	SuiConfigError,
	ForkUnsupportedError,
	SeedManifestMismatchError,
	SuiFundsReadyError,
} from './errors.ts';
export { SUI_ERROR_TAGS } from './errors.ts';

// Cross-plugin seams (consumed by Walrus/Seal/Deepbook fork variants
// and by Account/Coin/Wallet/Package).
export {
	chainProbeCapabilityKey,
	type ChainProbe,
	type ChainProbeError,
	type ChainProbeMode,
} from '../../contracts/chain-probe.ts';
export {
	FUNDS_READY_GATE_KEY,
	type FundsReadyStrategy,
	type FundsReadyError,
} from '../../contracts/network-resolver.ts';
export { SEED_OBJECTS_CAPABILITY_KEY, type SeedObjectsAccumulator } from './seed-objects.ts';
export {
	FORK_UNSUPPORTED_SURFACES,
	wrapWithForkGuard,
	type ForkMeta,
	type ForkLockHolder,
} from './fork-orchestration.ts';
export type { SuiProbeKey, SuiSdkShim } from './chain-probe.ts';
// Cross-plugin seams: fork impersonation + chain-build container.
// Consumed by `action` (Move-call execution against fork) and
// `package` (publish-to-fork + Move-build orchestration). Wave 2
// switches consumer plugins from internal-module imports to these
// barrel entries.
export {
	buildForkImpersonationTransactionBytes,
	prepareForkImpersonationTransaction,
	verifyForkImpersonationSender,
	FORK_IMPERSONATION_GAS_BUDGET,
	FORK_IMPERSONATION_GAS_PRICE,
} from './fork-transaction.ts';
export {
	acquireChainBuildContainer,
	containerNameForApp,
	moveBuildLockPathFor,
	MOVE_BUILD_LOCK_TIMEOUT_MS,
	type ChainBuildContainer,
	type ChainBuildContainerSpec,
} from './chain-build-container.ts';
