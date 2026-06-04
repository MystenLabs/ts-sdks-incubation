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
import {
	credentialedUrl,
	withDatabase,
	type Postgres,
	type PostgresRef,
} from '../postgres/index.ts';
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
import { suiPluginError, SUI_ERROR_TAGS, type SuiPluginError } from './errors.ts';
import { makeSuiForkRoutables, makeSuiLocalRoutables } from './routable.ts';
import { faucetCapabilityKey, type FaucetStrategy } from '../faucet/index.ts';
import { suiLocalStrategy } from './local-faucet-strategy.ts';
import { suiForkFaucetStrategy } from './fork-faucet-strategy.ts';
import { selectSufficientForkCoin } from './fork-transaction.ts';
import { FORK_FAUCET_WHALE_MIN_COIN_MIST, resolveForkWhale } from './mode/fork.ts';
import type { LocalIndexer } from './mode/local.ts';
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

/** Default name for sui's GraphQL-indexer database. */
const DEFAULT_INDEXER_DATABASE = 'sui_indexer';

/** Compose the external-indexer wiring from a resolved postgres handle.
 *  The URL dials the postgres `networkAlias` (NOT `url(db)`, whose host is
 *  the per-stack container DNS name) because the sui container reaches
 *  postgres only after joining its network. The indexer database MUST be
 *  declared on the postgres plugin (`postgres({ databases: [...] })`) — the
 *  handle exposes no runtime ensure-database method. */
export const resolveLocalIndexer = (
	postgres: Postgres,
	database: string,
): Effect.Effect<LocalIndexer, SuiPluginError> => {
	if (!postgres.databases.includes(database)) {
		return Effect.fail(
			suiPluginError(
				'container-start',
				`sui local mode: GraphQL indexer database '${database}' is not declared on the ` +
					`postgres plugin (databases: [${postgres.databases.join(', ')}]). Declare it via ` +
					`postgres({ databases: ['${database}'] }) (or set indexerDb.database).`,
			),
		);
	}
	const base = credentialedUrl({
		user: postgres.user,
		password: postgres.password,
		host: postgres.networkAlias,
		port: postgres.port,
	});
	return Effect.succeed({
		url: withDatabase(base, database),
		network: postgres.containerNetwork,
	});
};

/** Shared boot + inline contribution emission, parameterised by the
 *  resolved external-indexer wiring (`undefined` = no GraphQL, the
 *  zero-config / non-local case). */
const bootAndEmit = (opts: SuiOptions, indexer: LocalIndexer | undefined) =>
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
		const { client } = yield* bootSuiService(runtime, identity, portBroker, paths, opts, indexer);

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
						// GraphQL routes only when the external indexer is wired.
						includeGraphql: indexer !== undefined,
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
	});

/** Build the local-with-external-indexer plugin. GraphQL is gated on the
 *  external indexer (sui-tools ships no embedded Postgres), so supplying
 *  `indexerDb` turns it on: this branch declares a typed `dependsOn` on
 *  the postgres ref and composes the indexer DSN from the resolved
 *  handle. Mirrors seal's mode-specific-dependsOn pattern. */
const buildLocalIndexedPlugin = (
	opts: SuiLocalOptions,
	postgres: PostgresRef,
	database: string,
) => {
	return definePlugin({
		id: suiResource.id,
		dependsOn: { postgres },
		role: 'service',
		section: 'service',
		// `deps.postgres` is the resolved `Postgres` handle; the substrate
		// auto-infers it from `dependsOn`. `ctx` arrives via `PluginContext`.
		start: (deps) =>
			Effect.gen(function* () {
				const indexer = yield* resolveLocalIndexer(deps.postgres, database);
				return yield* bootAndEmit(opts, indexer);
			}),
		errorContributions: suiErrorContributions,
	});
};

/** Build the zero-dep plugin: non-local modes, and local mode WITHOUT
 *  `indexerDb` (RPC + faucet only, GraphQL gated off — no postgres dep,
 *  zero-config). */
const buildZeroDepPlugin = (opts: SuiOptions) => {
	return definePlugin({
		id: suiResource.id,
		role: 'service',
		section: 'service',
		// No `dependsOn`, so `start` is zero-arg. `undefined` indexer =
		// GraphQL gated off.
		start: () => bootAndEmit(opts, undefined),
		errorContributions: suiErrorContributions,
	});
};

/** Concrete plugin types for the two construction paths. */
type IndexedSuiPlugin = ReturnType<typeof buildLocalIndexedPlugin>;
type ZeroDepSuiPlugin = ReturnType<typeof buildZeroDepPlugin>;

/** Resolve the plugin TYPE per options: a defined `indexerDb` (local
 *  mode only) carries the postgres dependency; everything else is
 *  zero-dep. Keeping the public factories conditionally typed (rather
 *  than returning the union) means a plain `sui()` does NOT demand a
 *  postgres provider from the stack. */
type SuiPluginFor<O extends SuiOptions> = O extends { readonly indexerDb: object }
	? IndexedSuiPlugin
	: ZeroDepSuiPlugin;

const buildPlugin = <const O extends SuiOptions>(opts: O): SuiPluginFor<O> => {
	if (opts.mode === 'local' && opts.indexerDb !== undefined) {
		// GraphQL gated ON: declare the postgres dep + compose the DSN.
		return buildLocalIndexedPlugin(
			opts,
			opts.indexerDb.postgres,
			opts.indexerDb.database ?? DEFAULT_INDEXER_DATABASE,
		) as SuiPluginFor<O>;
	}
	return buildZeroDepPlugin(opts) as SuiPluginFor<O>;
};

// ---------------------------------------------------------------------------
// User-facing factories
// ---------------------------------------------------------------------------

/** Local Sui shorthand. Network/env selection belongs to the CLI or
 *  `defineDevstackWith(...)`; plain `sui()` always means an in-stack
 *  local validator. */
export const sui = <const O extends SuiOptions = { mode: 'local' }>(
	opts: O = { mode: 'local' } as O,
): SuiPluginFor<O> => buildPlugin(opts);

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
		local: <const O extends Omit<SuiLocalOptions, 'mode'>>(opts: O = {} as O) =>
			buildPlugin({ mode: 'local', ...opts }),
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
	NetworkConfig,
	NetworkMode,
	DevstackNetworkModeRegistry,
	DefaultNetwork,
} from './network-config.ts';
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
// `package` (publish-to-fork + Move-build orchestration). Consumer
// plugins import these barrel entries rather than internal modules.
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
// Consumed by Account/Action/Coin/Deepbook/Package/Seal/Walrus. These
// barrel entries route those consumers through the sibling plugin's
// barrel per the `plugin-boundary` invariant, rather than reaching into
// the deep `sui/exec`, `sui/move`, and `sui/ledger` internal modules.
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
	type BuildOutput,
	type MoveBuildContainer,
	type MoveBuildError,
} from './move/index.ts';
export { currentLedgerObjectRef } from './ledger/object-ref.ts';
