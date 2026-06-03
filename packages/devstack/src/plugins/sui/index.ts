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
// During `start`, the plugin emits (via the typed `ctx.*` verbs):
//
//   1. `ctx.provides` — `chain-probe:<chainId>` strategy contributor,
//      the schema-validated read surface (`makeSuiChainProbe`).
//   2. `ctx.snapshotExtra` — mode-aware container + bind-mount capture.
//   3. `ctx.codegen` — `sui-network` bindings (chain id, rpc, etc.).
//   4. `ctx.provides` — faucet strategy contributor, local-coin
//      dispensing for the mode's chain id.
//
// `ctx.endpoint` contributions are MODE-DEPENDENT (local + fork yes;
// local-rpc + live no — the caller fronts their own RPC). They land
// in the per-mode builder under `mode/*.ts`; this barrel emits them
// alongside the rest during `start`.

import { Effect } from 'effect';

import { defineModeNamespace } from '../../api/mode-narrowed-factory.ts';
import { definePlugin, resource } from '../../api/define-plugin.ts';
import { pluginErrorContributions } from '../../api/plugin-errors.ts';
import type { ChainProbe } from '../../contracts/chain-probe.ts';
import type { StrategyContributorDecl } from '../../contracts/strategy-contributor.ts';
import { emitContributions, PluginContext } from '../../substrate/plugin-ctx.ts';

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
import { bootSuiService } from './service.ts';
import { SUI_ERROR_TAGS, type SuiPluginError } from './errors.ts';
import { makeSuiForkRoutables, makeSuiLocalRoutables } from './routable.ts';
import { faucetCapabilityKey, type FaucetStrategy } from '../faucet/index.ts';
import { suiLocalStrategy } from './local-faucet-strategy.ts';
import { suiForkFaucetStrategy } from './fork-faucet-strategy.ts';
import { selectSufficientForkCoin } from './fork-transaction.ts';
import { FORK_FAUCET_WHALE_MIN_COIN_MIST, resolveForkWhale } from './mode/fork.ts';
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
};

/** Internal extension of `SuiResolved` carrying the pre-built funding
 *  faucet strategy. `start` owns the `LeaseBrokerService` instance for
 *  serialization; building the strategy at start-time (where the broker
 *  is reachable) lets the capabilities factory consume a flat value
 *  without threading the broker through a side channel. Local/live wrap
 *  the HTTP faucet; fork impersonates a whale; `null` on networks with
 *  no faucet (live-mainnet, external-rpc-without-faucet, faucet-disabled
 *  fork). */
type SuiResolvedRuntime = SuiResolved & {
	readonly fundingFaucetStrategy: FaucetStrategy | null;
};

/** The Sui plugin's resource identity. The id is `'sui'` (singular). */
export const suiResource = resource<'sui', SuiResolved>('sui');
const suiErrorContributions = pluginErrorContributions(SUI_ERROR_TAGS);

// ---------------------------------------------------------------------------
// Plugin construction (internal — used by sui() + suiFor())
// ---------------------------------------------------------------------------

/** Build the funds-ready faucet strategy for the resolved network, or
 *  `null` when the network has none. Local/live wrap the HTTP faucet;
 *  fork mode impersonates a whale (resolved + validated here). */
const resolveFundingFaucetStrategy = (
	opts: SuiOptions,
	client: SuiClient,
	broker: LeaseBroker,
): Effect.Effect<FaucetStrategy | null, SuiPluginError> => {
	if (opts.mode === 'fork') {
		return resolveForkFaucetStrategy(opts, client, broker);
	}
	if (client.fundingFaucetUrl === null) {
		return Effect.succeed(null);
	}
	return Effect.succeed(
		suiLocalStrategy({
			faucetUrl: client.fundingFaucetUrl,
			serialization: {
				broker,
				key: `sui-faucet:${client.chain}`,
				owner: `sui-faucet:${client.chain}`,
			},
		}),
	);
};

/** Fork-mode faucet: resolve the whale, validate it holds a large enough
 *  SUI coin, then build the impersonation strategy. A whale the user set
 *  explicitly that fails validation hard-fails the boot; a per-upstream
 *  default whale only warns and disables the faucet so the fork still
 *  comes up (account funding then surfaces the "no faucet strategy"
 *  error only if something actually needs SUI). */
const resolveForkFaucetStrategy = (
	opts: SuiForkOptions,
	client: SuiClient,
	broker: LeaseBroker,
): Effect.Effect<FaucetStrategy | null, SuiPluginError> =>
	Effect.gen(function* () {
		const resolved = resolveForkWhale(opts);
		const fork = client.fork;
		if (resolved === null || fork === null) {
			return null;
		}
		const strategy = suiForkFaucetStrategy({
			whale: resolved.whale,
			fork,
			sdk: client.sdk,
			perRequestCapMist: resolved.perRequestCapMist,
			serialization: {
				broker,
				key: `sui-fork-faucet:${client.chain}`,
				owner: `sui-fork-faucet:${client.chain}`,
			},
		});
		return yield* selectSufficientForkCoin(
			client.sdk.core,
			resolved.whale,
			FORK_FAUCET_WHALE_MIN_COIN_MIST,
		).pipe(
			Effect.as(strategy),
			Effect.catchTag('SuiPluginError', (cause) =>
				resolved.explicit
					? Effect.fail(cause)
					: Effect.logWarning(
							`sui fork mode: default faucet whale ${resolved.whale} is unusable ` +
								`(${cause.message}); disabling the fork faucet. Set faucet.whale to override.`,
						).pipe(Effect.as(null)),
			),
		);
	});

const buildPlugin = (opts: SuiOptions) => {
	return definePlugin({
		id: suiResource.id,
		role: 'service',
		section: 'service',
		// Sui has no `dependsOn`, so `start` is zero-arg. `ctx` is the
		// typed plugin-authoring surface the contribution emission below
		// drives (Stage B inversion — replaced the legacy `capabilities`
		// second-closure); it arrives via the `PluginContext` service.
		start: () =>
			Effect.gen(function* () {
				const ctx = yield* PluginContext;
				// The substrate threads `ContainerRuntime` + `IdentityContext`
				// via the plugin runtime context; the supervisor provides
				// these before this body runs.
				const runtime = yield* ContainerRuntimeService;
				const identity = yield* IdentityContext;
				const paths = yield* StackPathsService;
				const portBroker = yield* PortBrokerService;
				const fundingFaucetLeaseBroker = yield* LeaseBrokerService;
				const { client } = yield* bootSuiService(runtime, identity, portBroker, paths, opts);

				const fundingFaucetStrategy = yield* resolveFundingFaucetStrategy(
					opts,
					client,
					fundingFaucetLeaseBroker,
				);
				const value = {
					...client,
					mode: opts.mode,
					fundingFaucetStrategy,
				} satisfies SuiResolvedRuntime;
				// Emit the resolved contributions inline, top-to-bottom: the
				// decls stamp REAL chain ids / rpc URLs / container names
				// (`value` is the just-resolved runtime; `identity` from
				// `IdentityContext`, NOT re-fetched). The shared
				// `emitContributions` routes each by `kind`. Faucet (conditional
				// on a resolved strategy) and routables (mode-dependent) are the
				// only optional members; order is load-bearing.
				const realChain = value.chain;
				const faucetContribution: ReadonlyArray<StrategyContributorDecl> =
					value.fundingFaucetStrategy === null
						? []
						: [
								{
									kind: 'strategy-contributor',
									capabilityKey: faucetCapabilityKey(realChain),
									strategy: value.fundingFaucetStrategy,
									autoMounted: true,
								} satisfies StrategyContributorDecl<
									`faucet:request:${string}`,
									ReturnType<typeof suiLocalStrategy>
								>,
							];
				const localRoutables =
					opts.mode === 'local'
						? makeSuiLocalRoutables({
								containerName: `devstack-${identity.app}-${identity.stack}-sui-validator`,
								includeGraphql: true,
							})
						: [];
				const forkRoutables =
					opts.mode === 'fork'
						? makeSuiForkRoutables({
								containerName: `devstack-${identity.app}-${identity.stack}-sui-fork`,
							})
						: [];
				emitContributions(ctx, [
					makeSnapshotable(opts.mode, identity.app, identity.stack, realChain),
					makeCodegenable({
						mode: opts.mode,
						chain: realChain,
						rpc: value.rpcUrl,
						source: 'default',
						...(value.faucetUrl !== null ? { faucet: value.faucetUrl } : {}),
						...(value.graphqlUrl !== null ? { graphql: value.graphqlUrl } : {}),
					}),
					{
						kind: 'strategy-contributor',
						capabilityKey: chainProbeCapabilityKey(realChain),
						strategy: value.chainProbe,
						autoMounted: true,
					} satisfies StrategyContributorDecl<`chain-probe:${string}`, ChainProbe<SuiProbeKey>>,
					...faucetContribution,
					...localRoutables,
					...forkRoutables,
				]);
				return value;
			}),
		errorContributions: suiErrorContributions,
	});
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
export type { SuiNetworkConfigEntry } from './codegen.ts';
export type {
	SuiError,
	SuiPluginError,
	SuiCliError,
	SuiConfigError,
	ForkUnsupportedError,
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
	FORK_UNSUPPORTED_SURFACES,
	wrapWithForkGuard,
	type ForkLockHolder,
} from './fork-orchestration.ts';
export type { SuiProbeKey, SuiSdkShim } from './chain-probe.ts';
export { SuiSpans } from './spans.ts';

/** The shape `Transaction.build({ client })` and every `sdk.core.*` call
 *  accepts. Re-exported from `@mysten/sui/client` so callers cast
 *  `sui.sdk.client as ClientWithCoreApi` without each having to know the
 *  SDK subpath. */
export type { ClientWithCoreApi } from '@mysten/sui/client';
// Cross-plugin seams: fork impersonation + chain-build container.
// Consumed by `action` (Move-call execution against fork) and
// `package` (publish-to-fork + Move-build orchestration). Wave 2
// switches consumer plugins from internal-module imports to these
// barrel entries.
export {
	buildForkImpersonationTransactionBytes,
	prepareForkImpersonationTransaction,
	verifyForkImpersonationSender,
	selectSufficientForkCoin,
	FORK_IMPERSONATION_GAS_BUDGET,
	FORK_IMPERSONATION_GAS_PRICE,
	type ForkGasCoin,
	type ForkImpersonationGasClient,
} from './fork-transaction.ts';
export {
	suiForkFaucetStrategy,
	type SuiForkFaucetStrategyOptions,
	type SuiForkFaucetSerialization,
} from './fork-faucet-strategy.ts';
export {
	acquireChainBuildContainer,
	containerNameForApp,
	moveBuildLockPathFor,
	MOVE_BUILD_LOCK_TIMEOUT_MS,
	type ChainBuildContainer,
	type ChainBuildContainerSpec,
} from './chain-build-container.ts';

// Cross-plugin seams: hoisted exec / move / ledger helpers.
// Consumed by Account/Action/Coin/Deepbook/Package/Seal/Walrus, which
// previously reached into the deep `sui/exec`, `sui/move`, and
// `sui/ledger` internal modules. These barrel entries route those
// consumers through the sibling plugin's barrel per the
// `plugin-boundary` invariant.
export {
	extractExecuteDigest,
	formatExecutedFailure,
	executeSuiTx,
	isSuiStaleObjectVersionError,
	type ResolvedSigner,
	type ExecutedFailure,
	type ExecutedReceipt,
	type TransactionSignerScope,
} from './exec/index.ts';
export { signAndDispatch } from './exec/sign-and-dispatch.ts';
export {
	hashMoveSources,
	runMoveBuild,
	scrubLocksHost,
	containerInnerScript,
	extractTrailingJson,
	parseBuildOutput,
	stripPinnedSections,
	type BuildOutput,
	type MoveBuildContainer,
	type MoveBuildError,
	type MoveBuildPhase,
	type MoveBuildInput,
	type MoveBuildOutput,
} from './move/index.ts';
export { currentLedgerObjectRef } from './ledger/object-ref.ts';
