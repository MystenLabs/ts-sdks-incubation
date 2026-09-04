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

import { Effect, type Scope } from 'effect';

import { defineModeNamespace } from '../../api/mode-narrowed-factory.ts';
import { definePlugin, resource, staticInputIdentity } from '../../api/define-plugin.ts';
import {
	bootPostgresSidecar,
	credentialedUrl,
	withDatabase,
} from '../internal/postgres-sidecar/index.ts';
import type { ChainProbe } from '../../contracts/chain-probe.ts';
import type { StrategyContributorDecl } from '../../contracts/strategy-contributor.ts';
import { emitContributions, PluginContext } from '../../substrate/plugin-ctx.ts';

import { chainProbeCapabilityKey } from '../../contracts/chain-probe.ts';
import { ContainerRuntimeService } from '../../runtime/docker/service.ts';
import type {
	ContainerRuntime,
	ContainerRuntimeError,
	ImageRef,
} from '../../contracts/container-runtime.ts';
import type { Identity } from '../../substrate/identity.ts';
import { IdentityContext, StackPathsService } from '../../substrate/runtime/paths.ts';
import { sanitizeAlias } from '../../substrate/runtime/managed-container.ts';
import {
	LeaseBrokerService,
	type LeaseBroker,
} from '../../substrate/runtime/lease-broker/index.ts';
import { PortBrokerService } from '../../substrate/runtime/port-broker/index.ts';
import { makeCodegenable, makeStaticCodegen } from './codegen.ts';
import { liveMoveToolchain, suiMoveToolchain } from './move-toolchain.ts';
import { configuredSuiToolsRef } from './move/index.ts';
import type { SuiProbeKey } from './chain-probe.ts';
import { makeSnapshotable } from './snapshot.ts';
import { bootSuiService } from './service.ts';
import { suiPluginError, type SuiPluginError } from './errors.ts';
import { makeSuiForkRoutables, makeSuiLocalRoutables } from './routable.ts';
import { faucetCapabilityKey, type FaucetStrategy } from '../faucet/index.ts';
import { suiLocalStrategy } from './local-faucet-strategy.ts';
import { suiForkFaucetStrategy } from './fork-faucet-strategy.ts';
import { selectSufficientForkCoin } from './fork-transaction.ts';
import { FORK_FAUCET_WHALE_MIN_COIN_MIST, resolveForkWhale } from './mode/fork.ts';
import { resolveImage, SUI_INDEXER_DB_ROLE, type LocalIndexer } from './mode/local.ts';
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
				key: `sui-faucet:${client.chainId}`,
				owner: `sui-faucet:${client.chainId}`,
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
				key: `sui-fork-faucet:${client.chainId}`,
				owner: `sui-fork-faucet:${client.chainId}`,
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

/** In-network DNS alias siblings dial the indexer-db sidecar by. */
const SUI_INDEXER_DB_ALIAS = 'sui-indexer-db';

export const suiInputIdentity = (opts: SuiOptions): unknown => {
	const { readyTimeout: _readyTimeout, ...authored } = opts;
	if (authored.mode === 'live' || authored.mode === 'local-rpc') {
		return { plugin: 'sui', ...authored };
	}
	// The EFFECTIVE sui-tools ref (config, then env) is part of the identity
	// so flipping DEVSTACK_SUI_TOOLS_REF marks snapshots stale instead of
	// letting a restore resume state built by another binary. `image.pull`
	// names the whole image, so no ref applies there (matches planning).
	const suiToolsRef =
		authored.image !== undefined && 'pull' in authored.image
			? undefined
			: configuredSuiToolsRef(authored.suiToolsRef);
	if (authored.mode === 'fork') {
		return { plugin: 'sui', ...authored, suiToolsRef };
	}
	return {
		plugin: 'sui',
		...authored,
		suiToolsRef,
		indexer: authored.indexer !== false,
		indexerDb:
			authored.indexerDb === undefined
				? undefined
				: {
						...authored.indexerDb,
						database: authored.indexerDb.database ?? DEFAULT_INDEXER_DATABASE,
					},
	};
};

/** Compose the indexer-db sidecar's stable `configHash` from validator
 *  inputs known before local mode starts. A validator image change recreates
 *  the validator, so the sidecar's mount-less PGDATA must reset with it.
 *
 *  Validator data-layer resets that are not config values (absent validator
 *  or last exit `137`) are handled by `validatorNeedsIndexerReset`, which
 *  removes the sidecar before this hash is applied. */
export const composeIndexerConfigHash = (imageRef: string): string =>
	['indexer-db', `validator-img=${imageRef}`].join('|');

/** Append a database segment to a BYO DSN only when it has no path (so a
 *  caller-supplied `.../mydb` is respected). Rebuilds via the URL object
 *  so the db slots into `pathname` BEFORE `?search` — a naive string
 *  append on a `host:5432?sslmode=require` DSN (path-less but with a
 *  query) would wrongly yield `...?sslmode=require/sui_indexer`. The
 *  catch fallback (non-URL-parseable DSN) splits the query off first. */
const appendDatabaseIfMissing = (url: string, database: string): string => {
	try {
		const parsed = new URL(url);
		const hasPath = parsed.pathname !== '' && parsed.pathname !== '/';
		if (hasPath) return url;
		parsed.pathname = `/${database}`;
		return parsed.toString();
	} catch {
		const queryAt = url.indexOf('?');
		const base = queryAt === -1 ? url : url.slice(0, queryAt);
		const query = queryAt === -1 ? '' : url.slice(queryAt);
		const afterScheme = base.replace(/^postgres(ql)?:\/\//, '');
		if (/\/[^/]+$/.test(afterScheme)) return url;
		return `${base.replace(/\/$/, '')}/${encodeURIComponent(database)}${query}`;
	}
};

/** Whether the Sui-owned indexer DB must be deleted before boot.
 *
 *  The validator's chain identity lives in its writable layer. If the
 *  validator container is absent, the next boot creates a new layer and a
 *  new chain. If it last exited `137`, the runtime's `on-failure` policy
 *  also recreates it. Both cases make any existing indexer DB stale. */
export const validatorNeedsIndexerReset = (
	runtime: ContainerRuntime,
	identity: Identity,
): Effect.Effect<boolean, ContainerRuntimeError> =>
	runtime
		.inspectByLabels({
			app: identity.app,
			stack: identity.stack,
			plugin: 'sui',
			role: 'validator',
		})
		.pipe(
			Effect.map((handles) => {
				const validator = handles[0];
				return validator === undefined || validator.lastExitCode === 137;
			}),
		);

/** Provision the GraphQL-indexer DB wiring for local mode.
 *
 *  Default: sui OWNS a postgres sidecar (labelled under sui) — boot it on
 *  a per-stack network and compose the DSN from its in-network alias (NOT
 *  the per-stack container DNS host, which isn't parallel-stack-portable).
 *  The sidecar resets on the same validator inputs that can make its rows
 *  stale: absent/exited-`137` validator state removes the sidecar before
 *  boot, and validator image identity is folded into its `configHash`.
 *
 *  `validatorImage` is the SAME `ImageRef` the barrel hands `bootLocalMode`
 *  for the validator container, so the image the sidecar hashed and the image
 *  the validator runs cannot drift.
 *
 *  BYO: when `indexerDb` is set, no sidecar — pass the caller's DSN +
 *  network straight through (appending the default db iff the DSN has no
 *  path). The caller owns that DB's lifecycle. */
export const provisionLocalIndexer = (
	runtime: ContainerRuntime,
	identity: Identity,
	opts: SuiLocalOptions,
	validatorImage: ImageRef,
): Effect.Effect<LocalIndexer, SuiPluginError, Scope.Scope> => {
	const database = opts.indexerDb?.database ?? DEFAULT_INDEXER_DATABASE;
	if (opts.indexerDb !== undefined) {
		return Effect.succeed({
			url: appendDatabaseIfMissing(opts.indexerDb.url, database),
			network: opts.indexerDb.network,
		});
	}
	const network = sanitizeAlias(`devstack-${identity.app}-${identity.stack}-sui-indexer`);
	return Effect.gen(function* () {
		const resetExistingSidecar = yield* validatorNeedsIndexerReset(runtime, identity);
		if (resetExistingSidecar) {
			yield* runtime.removeManagedContainers({
				app: identity.app,
				stack: identity.stack,
				plugin: 'sui',
				role: SUI_INDEXER_DB_ROLE,
			});
		}
		const imageRef = validatorImage.tag ?? validatorImage.digest;
		const { handle } = yield* bootPostgresSidecar(runtime, identity, {
			network,
			alias: SUI_INDEXER_DB_ALIAS,
			role: SUI_INDEXER_DB_ROLE,
			database,
			configHash: composeIndexerConfigHash(imageRef),
		});
		return {
			url: withDatabase(
				credentialedUrl({
					user: handle.user,
					password: handle.password,
					host: handle.networkAlias,
					port: handle.port,
				}),
				database,
			),
			network: handle.containerNetwork,
		} satisfies LocalIndexer;
	}).pipe(
		// Postgres / runtime-domain failures wrap into the sui error channel
		// — the sidecar is a sui implementation detail. Nothing in the gen
		// body produces a `SuiPluginError` directly, so we wrap every cause.
		Effect.mapError((cause) =>
			suiPluginError(
				'container-start',
				`sui local mode: failed to provision the GraphQL indexer postgres sidecar (${cause._tag})`,
				cause,
			),
		),
	);
};

/** Shared boot + inline contribution emission, parameterised by the
 *  resolved external-indexer wiring (`undefined` = no GraphQL, the
 *  zero-config / non-local case) and, for local mode, the validator image
 *  the barrel pre-resolved (so the sidecar's `configHash` and the validator
 *  container share one `ImageRef`; `undefined` on the no-sidecar paths,
 *  where `bootLocalMode` resolves it inline). */
const bootAndEmit = (
	opts: SuiOptions,
	indexer: LocalIndexer | undefined,
	prebuiltImage?: ImageRef,
) =>
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
		const { client } = yield* bootSuiService(
			runtime,
			identity,
			portBroker,
			paths,
			opts,
			indexer,
			prebuiltImage,
		);

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
		// (the genesis-digest chain id, not the network name).
		// (`value` is the just-resolved runtime; `identity` from
		// `IdentityContext`, NOT re-fetched). The shared
		// `emitContributions` routes each by `kind`. Faucet (conditional
		// on a resolved strategy) and routables (mode-dependent) are the
		// only optional members; order is load-bearing.
		const realChainId = value.chainId;
		// Funding-faucet gate: a FIXED policy — ON for every network EXCEPT
		// live `mainnet`, where the funding faucet must NEVER run.
		// `identity.network` is the resolved network name. There is NO
		// per-network override surface for this gate: the override RECORD
		// (`networkOptions`) is an orchestrator-level concern that the
		// name-blind substrate does not forward into plugins (this plugin
		// only receives the closed `IdentityContext` tuple), so a per-network
		// `{ <network>: { faucet: false } }` toggle could never reach here —
		// `NetworkScopedOptions` therefore deliberately omits a `faucet`
		// field rather than advertise a silent no-op (see
		// `orchestrators/network-options.ts`). The mainnet exclusion is
		// load-bearing: a resolved strategy on `mainnet` (none of the live
		// modes build one today, but a future faucet-bearing mainnet config
		// could) is suppressed and the strategy registry never exposes
		// `faucet:request:<mainnet-chain-id>`; account funding then surfaces
		// the actionable "no faucet strategy" error rather than silently
		// faucet-funding against a production network.
		const faucetEnabled = identity.network !== 'mainnet';
		const faucetContribution: ReadonlyArray<StrategyContributorDecl> =
			!faucetEnabled || value.fundingFaucetStrategy === null
				? []
				: [
						{
							kind: 'strategy-contributor',
							capabilityKey: faucetCapabilityKey(realChainId),
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
			// `hasIndexer` (local only) folds the sui-owned indexer-db
			// sidecar into the captured containers; `indexer !== undefined`
			// is the same gate `bootAndEmit`'s caller resolved GraphQL on.
			makeSnapshotable(opts.mode, identity.app, identity.stack, realChainId, indexer !== undefined),
			makeCodegenable(
				{
					mode: opts.mode,
					chainId: realChainId,
					rpc: value.rpcUrl,
					source: 'default',
					...(value.faucetUrl !== null ? { faucet: value.faucetUrl } : {}),
					...(value.graphqlUrl !== null ? { graphql: value.graphqlUrl } : {}),
				},
				liveMoveToolchain(value.buildImage, opts),
			),
			{
				kind: 'strategy-contributor',
				capabilityKey: chainProbeCapabilityKey(realChainId),
				strategy: value.chainProbe,
				autoMounted: true,
			} satisfies StrategyContributorDecl<`chain-probe:${string}`, ChainProbe<SuiProbeKey>>,
			...faucetContribution,
			...localRoutables,
			...forkRoutables,
		]);
		return value;
	});

/** The single sui plugin builder. No sibling `dependsOn`: in local mode
 *  with the indexer on (the default), `start` provisions the GraphQL
 *  indexer DB itself — a sui-owned postgres sidecar — inside the boot
 *  scope BEFORE the boot-time validator (so the validator can join its
 *  network), then boots + emits. Resolution order:
 *    - `indexerDb` present  → BYO DB (no sidecar)
 *    - `indexer === false`  → opt out (RPC + faucet only, GraphQL off)
 *    - else (local default) → sui-owned sidecar
 *  Non-local modes never touch the indexer (GraphQL off). */
const buildSuiPlugin = (opts: SuiOptions) =>
	definePlugin({
		id: suiResource.id,
		role: 'service',
		section: 'service',
		inputIdentity: staticInputIdentity(suiInputIdentity(opts)),
		// Stack-free codegen: the `codegen` verb derives the committed
		// `config.ts`'s `network`/`networks` from this hook. Both are
		// environment/live data (dynamic local rpc port; a real deployment
		// names a different network), so the committed tree carries
		// `dep.network`/`Object.fromEntries(networkNames.map(forNetwork))` raw
		// expressions off the loaded deployment that resolve
		// at app build/dev time via the injected `__DEVSTACK_DEPLOYMENT__` global —
		// never literal values. No id-resolver input needed.
		staticCodegen: makeStaticCodegen(suiMoveToolchain(opts)),
		// Zero-arg `start` (no `dependsOn`); the substrate supplies the
		// container runtime + identity via the plugin runtime context.
		start: () =>
			Effect.gen(function* () {
				// Resolution order: BYO `indexerDb` wins; then an explicit
				// `indexer: false` opt-out; then the sui-owned sidecar default.
				// Non-local modes never wire the indexer.
				if (opts.mode !== 'local' || (opts.indexerDb === undefined && opts.indexer === false)) {
					return yield* bootAndEmit(opts, undefined);
				}
				const runtime = yield* ContainerRuntimeService;
				const identity = yield* IdentityContext;
				// Resolve the validator image ONCE, before the sidecar — single
				// source for both the sidecar's configHash (it folds the resolved
				// image ref so an image bump resets the indexer DB) and the
				// validator container `bootAndEmit` boots below. `resolveImage`
				// is deterministic (content-addressed build/pull) so this is the
				// SAME ref the validator runs; resolving it here, not twice,
				// avoids a redundant build AND any drift from `decideRunAction`.
				const validatorImage = yield* resolveImage(runtime, identity, opts);
				// The sidecar boots first; if the validator boot below fails, the
				// sidecar's finalizer lingers on the plugin acquire scope until
				// teardown/retry. Benign and intentional — the stable name +
				// labels mean a retry ADOPTS the existing sidecar container
				// (no scope-threading machinery needed).
				const indexer = yield* provisionLocalIndexer(runtime, identity, opts, validatorImage);
				return yield* bootAndEmit(opts, indexer, validatorImage);
			}),
	});

const buildPlugin = <O extends SuiOptions>(opts: O) => buildSuiPlugin(opts);

// ---------------------------------------------------------------------------
// User-facing factories
// ---------------------------------------------------------------------------

/** Local Sui shorthand. Network/env selection belongs to the CLI or
 *  `defineDevstackWith(...)`; plain `sui()` always means an in-stack
 *  local validator (GraphQL/indexer/Postgres on by default via a
 *  sui-owned sidecar). */
export const sui = <const O extends SuiOptions = { mode: 'local' }>(
	opts: O = { mode: 'local' } as O,
) => buildPlugin(opts);

/** Mode-narrowed factory namespace.
 *
 *  Usage:
 *      const network = { mode: 'local' } as const;
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
export { SuiLogAttr } from './log-attrs.ts';

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
	withMoveBuildLock,
	DEFAULT_MOVE_BUILD_ENV,
	type BuildOutput,
	type MoveBuildEnv,
	type MoveBuildContainer,
	type MoveBuildError,
	type MoveBuildOptions,
} from './move/index.ts';
export { currentLedgerObjectRef } from './ledger/object-ref.ts';
