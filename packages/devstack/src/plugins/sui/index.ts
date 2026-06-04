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
import { definePlugin, resource } from '../../api/define-plugin.ts';
import { bootPostgresSidecar, credentialedUrl, withDatabase } from '../postgres/index.ts';
import type { ChainProbe } from '../../contracts/chain-probe.ts';
import type { StrategyContributorDecl } from '../../contracts/strategy-contributor.ts';
import { emitContributions, PluginContext } from '../../substrate/plugin-ctx.ts';

import { chainProbeCapabilityKey } from '../../contracts/chain-probe.ts';
import { ContainerRuntimeService } from '../../runtime/docker/service.ts';
import type { ContainerRuntime, ImageRef } from '../../contracts/container-runtime.ts';
import type { Identity } from '../../substrate/identity.ts';
import { IdentityContext, StackPathsService } from '../../substrate/runtime/paths.ts';
import { sanitizeAlias } from '../../substrate/runtime/managed-container.ts';
import {
	LeaseBrokerService,
	type LeaseBroker,
} from '../../substrate/runtime/lease-broker/index.ts';
import { PortBrokerService } from '../../substrate/runtime/port-broker/index.ts';
import { makeCodegenable } from './codegen.ts';
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

/** In-network DNS alias siblings dial the indexer-db sidecar by. */
const SUI_INDEXER_DB_ALIAS = 'sui-indexer-db';

/** Compose the indexer-db sidecar's `configHash` from the re-genesis-
 *  determining inputs of the validator container. Stamped as the sidecar's
 *  `devstack.config-hash` label; `decideRunAction` does a `===` on the
 *  read-back label, so a match resumes (rows preserved) and a mismatch
 *  recreates the mount-less PGDATA-in-writable-layer sidecar (⇒ empty DB).
 *
 *  The token folds EXACTLY the inputs that make `decideRunAction` recreate
 *  the VALIDATOR (a validator recreate = fresh writable layer = re-genesis
 *  = NEW chain, so the sidecar must reset in lockstep):
 *
 *    - `chain` — the validator's pre-boot DISPOSITION (`readValidator-
 *      ChainConfig`): absent OR present-but-exited-137 ⇒ `fresh` (the two
 *      dispositions on which the runtime recreates an `on-failure` validator);
 *      `present` otherwise (running / clean / non-137 exit ⇒ resume).
 *    - `img` — the validator's resolved image ref (`<tag>` or `<digest>`
 *      fallback — the SAME string `decideRunAction` compares `facts.image`
 *      against). A pinned-image bump (or a build-context change that moves
 *      the content-addressed tag) recreates the validator on `image-mismatch`
 *      WHILE it is still present + non-137 — a disposition that reads
 *      `present`. Folding the image ref makes that bump flip the sidecar's
 *      token too, so it resets in lockstep instead of holding stale rows
 *      against the new chain.
 *
 *  Restore-safe: a snapshot/restore runs the committed validator whose
 *  resolved image ref is the SAME content-addressed value (and whose
 *  disposition reads `present`), so both segments are unchanged ⇒ resume
 *  (rows intact). The image ref changes ONLY on a real image bump, never on
 *  restore — that is why it is the correct input to fold.
 *
 *  Residual (NOT folded): the validator's published host ports + secondary
 *  network attachment. `decideRunAction` also recreates on a bare port or
 *  network-attachment change, but those are allocated/joined AFTER this
 *  sidecar is created (the validator joins the sidecar's network and brokers
 *  its host ports inside `bootLocalMode`, which runs after `provisionLocal-
 *  Indexer`), so they are not knowable at sidecar-hash time without
 *  reordering port allocation ahead of the sidecar. A bare port/network
 *  change with NO image change is a rare, dev-initiated config edit; it would
 *  recreate the validator (re-genesis) while the sidecar resumes stale rows.
 *  Folding it is deferred — it needs port allocation reordered ahead of the
 *  sidecar. Seal-idiom pipe-join (readable, deterministic). */
export const composeIndexerConfigHash = (chainId: string | null, imageRef: string): string =>
	['indexer-db', `chain=${chainId ?? 'fresh'}`, `img=${imageRef}`].join('|');

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

/** ONE of the two re-genesis-determining inputs the indexer-db sidecar's
 *  `configHash` folds: the validator container's DISPOSITION — read BEFORE
 *  the sidecar (and so the validator) boots. The OTHER input, the validator's
 *  resolved image ref, is folded by `composeIndexerConfigHash`'s caller (the
 *  barrel resolves it before this sidecar so an image bump resets the sidecar
 *  too). This function covers only the disposition segment.
 *
 *  Why disposition (presence + last-exit-code), the correct no-exec,
 *  restore-safe source for the chain segment:
 *    - The genesis-minted chain id is born INSIDE the validator post-boot,
 *      so it is not knowable at sidecar-create time (the sidecar is created
 *      first, so the validator can join its network + receive the DSN).
 *    - The chain id is invariant for exactly as long as the validator's
 *      writable layer (its genesis) persists. The runtime's `decideRunAction`
 *      RECREATES the validator (→ fresh layer → re-genesis → NEW chain) on
 *      two DISPOSITION signals: the container being ABSENT (`wipe`/`rm -f`/
 *      cold), or PRESENT but exited `137` — an unclean SIGKILL/OOM (the
 *      validator runs `recreate: 'on-failure'`). Both ⇒ "fresh chain
 *      incoming". Every other disposition — running, or a clean/non-137 exit
 *      (0/130/…) — keeps the writable layer → "same chain as before". (The
 *      runtime ALSO recreates on image-mismatch — that trigger is covered by
 *      the separately-folded image ref, not by this disposition probe.)
 *    - Presence alone is NOT enough: a 137-crashed validator is still PRESENT
 *      across the boot, yet the runtime re-genesises it, so a presence-only
 *      key would resume STALE rows against the new chain. Keying on the SAME
 *      137 signal the runtime recreates on closes that gap. Note: ONLY 137 —
 *      the runtime does not recreate on other non-zero exits, so neither do we.
 *    - Snapshot/restore replays the committed validator container running, so
 *      it reads `present` post-restore → same token the restored sidecar's
 *      label was committed with → resume (rows intact). Cross-chain restore is
 *      refused by the snapshot identity-guard before any mutation.
 *
 *  Returns `null` when the validator is absent OR present-but-137 (both ⇒
 *  re-genesis incoming → `chain=fresh`); the fixed `present` token otherwise. */
export const readValidatorChainConfig = (
	runtime: ContainerRuntime,
	identity: Identity,
): Effect.Effect<string | null, SuiPluginError> =>
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
				// Absent → re-genesis. Present + 137 (SIGKILL/OOM) → the runtime
				// recreates it → re-genesis. Else (running / clean / non-137
				// exit) → same chain. Gate on EXACTLY 137, mirroring the runtime.
				if (validator === undefined || validator.lastExitCode === 137) return null;
				return 'present';
			}),
			Effect.mapError((cause) =>
				suiPluginError(
					'container-start',
					`sui local mode: failed to inspect the validator container: ${cause.reason}: ${cause.detail}`,
					cause,
				),
			),
		);

/** Provision the GraphQL-indexer DB wiring for local mode.
 *
 *  Default: sui OWNS a postgres sidecar (labelled under sui) — boot it on
 *  a per-stack network and compose the DSN from its in-network alias (NOT
 *  the per-stack container DNS host, which isn't parallel-stack-portable).
 *  The sidecar's `configHash` folds the validator's re-genesis-determining
 *  inputs (`composeIndexerConfigHash`): its pre-boot disposition
 *  (`readValidatorChainConfig`: absent or exited-`137` ⇒ `chain=fresh`) AND
 *  its resolved image ref (`validatorImage` — a pinned-image bump flips the
 *  token while the disposition still reads `present`). Any change recreates
 *  the mount-less PGDATA-in-writable-layer sidecar — an EMPTY DB the fresh
 *  embedded indexer re-indexes — entirely via `decideRunAction`. No marker /
 *  dropdb machinery.
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
	stackRoot: string,
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
		// Pre-boot chain identity — read BEFORE the sidecar is created so the
		// configHash reflects the validator's PRIOR chain, not the post-genesis
		// value (the validator boots AFTER the sidecar). Absent OR exited-137
		// (crash-recreate ⇒ re-genesis) ⇒ `fresh`. Folded alongside the
		// validator's resolved image ref (`<tag>` or `<digest>` fallback — the
		// exact string `decideRunAction` compares), so an image bump that
		// recreates the validator while it still reads `present` also flips this
		// sidecar's token ⇒ reset instead of stale rows against the new chain.
		const chainConfig = yield* readValidatorChainConfig(runtime, identity);
		const imageRef = validatorImage.tag ?? validatorImage.digest;
		const { handle } = yield* bootPostgresSidecar(runtime, identity, stackRoot, {
			network,
			alias: SUI_INDEXER_DB_ALIAS,
			role: SUI_INDEXER_DB_ROLE,
			database,
			configHash: composeIndexerConfigHash(chainConfig, imageRef),
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
			// `hasIndexer` (local only) folds the sui-owned indexer-db
			// sidecar into the captured containers; `indexer !== undefined`
			// is the same gate `bootAndEmit`'s caller resolved GraphQL on.
			makeSnapshotable(opts.mode, identity.app, identity.stack, realChain, indexer !== undefined),
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
				const paths = yield* StackPathsService;
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
				const indexer = yield* provisionLocalIndexer(
					runtime,
					identity,
					paths.stackRoot,
					opts,
					validatorImage,
				);
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
	type BuildOutput,
	type MoveBuildContainer,
	type MoveBuildError,
} from './move/index.ts';
export { currentLedgerObjectRef } from './ledger/object-ref.ts';
