// `deepbookLocalDeploy(opts)` — publish the deepbook-v3 Move package +
// create the requested whitelisted pools. Provides all three interface
// tags (`DeepbookCoreTag`, `DeepbookAdminTag`, `DeepbookMarketMaker`) because
// the local deploy owns the admin cap and can mint a BalanceManager.
//
// Migrated to the canonical `onChainArtifact` substrate per
// `notes/integration-contract-redesign.md` §4.2. The cache key resolves
// to `deepbook/pools/<chainId>/<contentHash({packageId, signer, poolsHash})>`,
// the verify probe goes through the typed `ChainProbe.objectsMatchTypes`
// accessor (Schema-validated SDK response shape), and `register` runs on
// every cycle so PackageRegistry + DeepbookStateRegistry stay populated
// on resume.
//
// Two-tag pattern: `CachedDeepbookPools` is the lean, JSON-roundtrippable
// payload that lives in `StateStore`. `DeepbookLocalDeployShape` is the
// richer consumer-facing shape (a `Map<string, string>` of pool ids, the
// `findPool` closure, the `packageIds` derived view); those derived
// fields are attached in `register` so the cache-hit and cache-miss
// paths converge on the same observable shape — mirrors `publishMove`'s
// host-local-field-mutation pattern.

/* eslint-disable @typescript-eslint/no-explicit-any */

import * as crypto from 'node:crypto';
import { Effect, Layer } from 'effect';
import { Transaction } from '@mysten/sui/transactions';
import { provide, type LayeredTag } from '../../advanced/tag.js';
import { publishMove, type Package } from '../package/internal.js';
import { moveTypeEquals, moveTypeStartsWith, pickCreatedByType } from '../../engine/sui-helpers.js';
import { publishDeepbookState, publishPackage } from '../../engine/registries.js';
import { onChainArtifact } from '../../engine/on-chain-artifact.js';
import { DeepbookError } from '../../engine/errors.js';
import {
	DeepbookAdminTag,
	DeepbookCoreTag,
	DeepbookMarketMakerTag,
	type DeepbookCore,
} from '../deepbook.js';
import type { Account, SuiObjectChange } from '../../engine/shared.js';
import {
	DEEPBOOK_ADMIN_CAP_TYPE_SUFFIX,
	DEEPBOOK_REGISTRY_TYPE_SUFFIX,
	ORDER_TYPE_POST_ONLY,
	SELF_MATCHING_ALLOWED,
	SUI_CLOCK_OBJECT_ID,
	makeFindPool,
	resolveCoinRef,
	type AnyCoinTag,
	type DeepbookPool,
	type DeepbookPoolSpec,
} from './internal.js';

// State-store namespace for the cached create-pools output. The
// `onChainArtifact` substrate folds `chainId` and the hashed `inputs`
// (`{packageId, signer, poolsHash}`) into the full cache key:
//
//   `deepbook/pools/<chainId>/<contentHash({packageId, signer, poolsHash})>`
//
// Per §8.5 of the redesign the namespace stays bare — no version
// segment. `chainId` (regenesis ⇒ miss), `packageId` (republish ⇒ miss),
// and `poolsHash` (reconfigure ⇒ miss) all fold into the inputs hash.
// Without this cache, `pool::create_pool_admin` aborts in
// `registry::register_pool` on every resume because (base, quote) was
// already registered by the previous boot — chain state survives
// `pnpm dev` restarts but the primitive didn't know it.
const DEEPBOOK_POOLS_NAMESPACE = 'deepbook/pools';

// Subset of `DeepbookPool` we persist into `StateStore`. The captured
// `poolId` is the load-bearing piece (it's what `register_pool` would
// re-mint), the `tick/lot/min` fields go in because consumers
// (`market-maker`, `findPool`'s table) read them off the cached pool
// record on resume. `bigint` round-trips through `state-store` via the
// BigInt-tagging JSON reviver/replacer.
interface CachedDeepbookPool {
	readonly name: string;
	readonly poolId: string;
	readonly base: string;
	readonly quote: string;
	readonly tickSize: bigint;
	readonly lotSize: bigint;
	readonly minSize: bigint;
}

// Lean cached payload — JSON-roundtrippable. The consumer-facing
// `DeepbookLocalDeployShape` adds derived fields (poolIds Map,
// findPool closure, packageIds) in `register`, see below.
interface CachedDeepbookPools {
	readonly packageId: string;
	readonly registryId: string;
	readonly adminCapId: string;
	readonly deepTreasuryId: string | undefined;
	readonly pools: ReadonlyArray<CachedDeepbookPool>;
}

// Stable hash over the resolved pool specs. Keys sorted so JSON
// stringify order doesn't bleed into the cache key. `tickSize` /
// `lotSize` / `minSize` are bigints — JSON.stringify rejects them by
// default, so they're rendered as decimal strings here. `name` /
// `base` / `quote` are the (base, quote)-pair identity the chain
// would otherwise reject on second-boot.
const hashPoolSpecs = (
	specs: ReadonlyArray<{
		readonly name: string;
		readonly base: string;
		readonly quote: string;
		readonly tickSize: bigint;
		readonly lotSize: bigint;
		readonly minSize: bigint;
		readonly whitelisted: boolean;
		readonly stable: boolean;
	}>,
): string => {
	const canonical = specs
		.slice()
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
		.map((s) => ({
			name: s.name,
			base: s.base,
			quote: s.quote,
			tickSize: s.tickSize.toString(),
			lotSize: s.lotSize.toString(),
			minSize: s.minSize.toString(),
			whitelisted: s.whitelisted,
			stable: s.stable,
		}));
	return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);
};

export interface DeepbookLocalDeployOptions<
	Name extends string,
	TPools extends ReadonlyArray<DeepbookPoolSpec>,
> {
	readonly name?: Name;
	readonly signer: LayeredTag<any, Account, any, any>;
	/** Filesystem path to a vendored deepbook-v3 Move package. The
	 *  `@mysten/deepbook-v3` npm package does not currently ship compiled
	 *  bytecode + dependency manifest in a form we can submit directly via
	 *  `Transaction.publish`, so callers vendor the source themselves
	 *  (typically via a monorepo-level `gitFetch` step or a checked-in
	 *  submodule).
	 *
	 *  Mutually exclusive with `vendor`. */
	readonly movePackagePath?: string;
	/** A vendored sources ref from `vendorDeepbook(...)`. When set, the
	 *  factory reads `(yield* vendor).deepbook` as the package source. */
	readonly vendor?: LayeredTag<any, { readonly deepbook: string }, any, any>;
	readonly pools?: TPools;
	readonly dependsOn?: ReadonlyArray<LayeredTag<any, any, any, any>>;
}

// Local-deploy carries the rich per-pool record (tick/lot/min) so the
// composite tag can satisfy `yield* db` for consumers projecting pools
// into manifest extras. The interface `DeepbookCoreTag` itself only
// surfaces poolIds + findPool.
export interface DeepbookLocalDeployShape<
	TPools extends Record<string, DeepbookPool> = Record<string, DeepbookPool>,
> extends DeepbookCore {
	readonly adminCapId: string;
	readonly pools: TPools;
}

type PoolsRecord<T extends ReadonlyArray<DeepbookPoolSpec>> = {
	readonly [K in T[number]['name']]: DeepbookPool;
};

// Build the SDK-aligned `packageIds` view from a resolved deepbook
// payload. Same logic on hit + miss; lifted out so both paths converge.
const buildPackageIds = (input: {
	readonly packageId: string;
	readonly registryId: string;
	readonly deepTreasuryId: string | undefined;
}): DeepbookCore['packageIds'] => ({
	DEEPBOOK_PACKAGE_ID: input.packageId,
	REGISTRY_ID: input.registryId,
	// SDK-aligned view. `DEEP_TREASURY_ID` is the locally-minted DEEP
	// token's `TreasuryCap` — the vendored deepbook-v3 Move source
	// declares the `deep::DEEP` coin, so the publish tx creates a
	// `TreasuryCap<{pkg}::deep::DEEP>` that we capture via the
	// `publishMove({capture})` callback. Falls back to `''` if the
	// vendored source ever drops the DEEP module (we don't fail loudly
	// because consumers that don't need DEEP fees on localnet shouldn't
	// be forced to vendor a specific Move version).
	DEEP_TREASURY_ID: input.deepTreasuryId ?? '',
	MARGIN_PACKAGE_ID: undefined,
	MARGIN_REGISTRY_ID: undefined,
	LIQUIDATION_PACKAGE_ID: undefined,
});

// Build the per-pool Map<name → poolId> from a cached payload. Same
// logic on hit + miss.
const buildPoolIds = (
	pools: ReadonlyArray<CachedDeepbookPool>,
): ReadonlyMap<string, string> => new Map(pools.map((p) => [p.name, p.poolId]));

// Lift a cached payload's pool array back into the rich
// `Record<name, DeepbookPool>` shape that consumers read off
// `.pools`. Same logic on hit + miss.
const buildPoolsRecord = (
	pools: ReadonlyArray<CachedDeepbookPool>,
): Record<string, DeepbookPool> => {
	const out: Record<string, DeepbookPool> = {};
	for (const p of pools) {
		out[p.name] = {
			name: p.name,
			poolId: p.poolId,
			base: p.base,
			quote: p.quote,
			tickSize: p.tickSize,
			lotSize: p.lotSize,
			minSize: p.minSize,
		};
	}
	return out;
};

// Captured shape from publishMove's `capture` callback. Pulled out so
// the upstream record carries an explicit type — `publishMove` returns
// `Package<unknown>` otherwise and the produce/register bodies have to
// cast.
type DeepbookCapture = {
	readonly registryId: string | undefined;
	readonly adminCapId: string | undefined;
	readonly deepTreasuryId: string | undefined;
};

/**
 * Publish a vendored deepbook-v3 package, create whitelisted pools, and
 * surface `DeepbookCoreTag`, `DeepbookAdminTag`, and `DeepbookMarketMaker`
 * interfaces for downstream consumers. The factory's own composite tag
 * yields the rich shape (incl. `adminCapId` + per-pool record) so
 * configs that read `.pools` for manifest projection keep working.
 */
export const deepbookLocalDeploy = <
	const TPools extends ReadonlyArray<DeepbookPoolSpec> = [],
	const Name extends string = 'deepbook',
>(
	options: DeepbookLocalDeployOptions<Name, TPools>,
) => {
	const name = (options.name ?? 'deepbook') as Name;
	const specs = options.pools ?? ([] as ReadonlyArray<DeepbookPoolSpec>);

	if (options.movePackagePath !== undefined && options.vendor !== undefined) {
		throw new TypeError(
			`deepbookLocalDeploy: \`movePackagePath\` and \`vendor\` are mutually exclusive`,
		);
	}

	// Pool-spec validation at config-load time. Surfaces a clear typed
	// error with the user's `Deepbook({ local: { pools: [...] } })` site
	// in the stack trace instead of an inscrutable Move-side abort
	// when the create-pool tx fires against an out-of-range argument.
	// The Move side enforces these same invariants downstream
	// (`tickSize > 0`, `lotSize > 0`, `minSize >= lotSize`); catching
	// them up front saves a chain round-trip + an unclear MoveAbort
	// message. Pool name must be non-empty + unique within the array.
	const seenNames = new Set<string>();
	for (const spec of specs) {
		if (spec.name.length === 0) {
			throw new TypeError(`deepbookLocalDeploy: pool name must be non-empty`);
		}
		if (seenNames.has(spec.name)) {
			throw new TypeError(
				`deepbookLocalDeploy: duplicate pool name '${spec.name}' — each pool must have a unique name`,
			);
		}
		seenNames.add(spec.name);
		if (spec.tickSize <= 0n) {
			throw new TypeError(
				`deepbookLocalDeploy: pool '${spec.name}' tickSize must be > 0 (got ${spec.tickSize})`,
			);
		}
		if (spec.lotSize <= 0n) {
			throw new TypeError(
				`deepbookLocalDeploy: pool '${spec.name}' lotSize must be > 0 (got ${spec.lotSize})`,
			);
		}
		if (spec.minSize < spec.lotSize) {
			throw new TypeError(
				`deepbookLocalDeploy: pool '${spec.name}' minSize must be >= lotSize (got minSize=${spec.minSize}, lotSize=${spec.lotSize})`,
			);
		}
	}

	// The publish tag is a sibling primitive; we yield it inside our
	// scoped acquire to chain its package id + captured registry/admin-cap
	// ids forward into the create-pool transactions. Built lazily so the
	// producer fails at start (not at module-eval) when neither
	// `movePackagePath` nor `vendor` is supplied.
	//
	// `publishMove` accepts either a literal path or an `Effect<string>`
	// that resolves it at acquire time. The vendor option threads through
	// the latter: yield the vendor tag inside the path effect and read
	// `(yield* vendor).deepbook` as the Move package path. The resolved
	// path participates in publishMove's `(sourceHash, chainId)` cache
	// key the same way a literal path would.
	const publishPath: string | Effect.Effect<string, never, any> | undefined =
		options.movePackagePath !== undefined
			? options.movePackagePath
			: options.vendor !== undefined
				? Effect.gen(function* () {
						const vendor = yield* options.vendor!;
						return vendor.deepbook;
					})
				: undefined;

	const publish =
		publishPath !== undefined
			? (publishMove({
					name: `${name}.publish` as const,
					path: publishPath,
					signer: options.signer,
					capture: (changes): DeepbookCapture => {
						const registryId = pickCreatedByType(changes, {
							suffix: DEEPBOOK_REGISTRY_TYPE_SUFFIX,
						});
						const adminCapId = pickCreatedByType(changes, {
							suffix: DEEPBOOK_ADMIN_CAP_TYPE_SUFFIX,
						});
						// DEEP `TreasuryCap` is `0x2::coin::TreasuryCap<{pkg}::deep::DEEP>`.
						// We can't spell the full type here — the inner packageId is
						// exactly what we're capturing — so match by the two stable
						// substrings around the unknown middle. The TreasuryCap pattern
						// is distinctive enough that this match doesn't collide with
						// `CoinMetadata<...::deep::DEEP>` (which DOES end with
						// `::deep::DEEP>` but starts with `0x2::coin::CoinMetadata<`).
						const deepTreasuryId = changes.find(
							(c): c is Extract<SuiObjectChange, { type: 'created' }> =>
								c.type === 'created' &&
								'objectType' in c &&
								typeof c.objectType === 'string' &&
								moveTypeStartsWith(c.objectType, '0x2::coin::TreasuryCap<') &&
								c.objectType.endsWith('::deep::DEEP>'),
						)?.objectId;
						return { registryId, adminCapId, deepTreasuryId };
					},
				}) as LayeredTag<any, Package<DeepbookCapture>, any, any>)
			: undefined;

	// Fold the optional `dependsOn` array into the upstream record under
	// generated aliases. The substrate auto-flattens `upstream` into
	// `__upstreamKeys`, so a single typed record IS the dep graph (per
	// the redesign's §3.1 "the dep declaration IS the dep graph"). Pool-
	// spec coin tags get a stable `pool<i>_base`/`pool<i>_quote` slot for
	// the same reason: every yield the body performs is in the record.
	const dependsOnRecord: Record<string, LayeredTag<any, any, any, any>> = {};
	(options.dependsOn ?? []).forEach((dep, i) => {
		dependsOnRecord[`dep_${i}`] = dep;
	});
	const coinTagRecord: Record<string, LayeredTag<any, any, any, any>> = {};
	specs.forEach((s, i) => {
		if (typeof s.base !== 'string') {
			coinTagRecord[`pool${i}_base`] = s.base as AnyCoinTag;
		}
		if (typeof s.quote !== 'string') {
			coinTagRecord[`pool${i}_quote`] = s.quote as AnyCoinTag;
		}
	});

	// Composite primitive — onChainArtifact wires inputs/verify/produce/
	// register through the substrate. Layer.build dedupes the acquire
	// (single publish + create-pools regardless of how many interface
	// tags downstream `yield*` it). The lean `CachedDeepbookPools`
	// payload is what hits StateStore; the rich `DeepbookLocalDeployShape`
	// is materialised in `register` and is what downstream consumers
	// see when they `yield* composite`.
	const composite = onChainArtifact({
		name,
		kind: 'action' as const,
		plugin: 'deepbook',
		displayTitle: `publish.${name}`,
		// The body iterates `options.dependsOn`, yields SuiTag, the
		// signer Account ref, and the inner publishMove tag. The upstream
		// record holds every yieldable; the substrate auto-flattens it
		// into __upstreamKeys so the topo scheduler places this composite
		// strictly after its providers. (`SuiTag` is implicit — the
		// substrate yields it itself for `chainId` resolution.)
		//
		// Each pool's `base`/`quote` may be a `LayeredTag` (e.g.
		// `Coin.fromPackage(usdc, 'MOCK_USDC')`) that the produce body
		// yields via `resolveCoinRef`. Lift those tags into upstreams via
		// `coinTagRecord` so the topo scheduler orders them strictly
		// before this primitive.
		//
		// When `opts.vendor` is set, the inner publishMove's `path:`
		// Effect yields the vendor tag — lift it so the topo scheduler
		// orders the vendor build before the publish runs.
		upstream: {
			signer: options.signer,
			publish,
			...(options.vendor !== undefined ? { vendor: options.vendor } : {}),
			...dependsOnRecord,
			...coinTagRecord,
		},

		namespace: DEEPBOOK_POOLS_NAMESPACE,
		label: `deepbookLocalDeploy(${name})`,

		display: (s: CachedDeepbookPools) => {
			const poolCount = s.pools.length;
			return {
				title: `publish.${name}`,
				primary: s.packageId,
				...(poolCount > 0 ? { extras: [`${poolCount} pool${poolCount === 1 ? '' : 's'}`] } : {}),
			};
		},

		// Canonical hashable inputs. `packageId` is the resolved
		// publishMove output, `signer` is the resolved Account address,
		// `poolsHash` folds the requested pool specs (sorted, bigints →
		// decimal strings) so reconfiguring the pool set misses. A
		// `publish === undefined` config (no `movePackagePath` AND no
		// `vendor`) surfaces here as a clean DeepbookError — the factory
		// body itself must construct successfully (per the existing
		// "delegated to runtime" test contract) but the build fails at
		// acquire time.
		inputs: ({ publish: pkg, signer }) =>
			Effect.gen(function* () {
				if (pkg === undefined) {
					return yield* Effect.fail(
						new DeepbookError({
							phase: 'publish',
							message:
								`deepbookLocalDeploy(${name}): either \`movePackagePath\` or \`vendor\` ` +
								`is required to publish the deepbook-v3 Move package. ` +
								'Vendor the source (e.g. via `gitFetch` or `vendorDeepbook(...)`) ' +
								'and pass the directory path.',
						}),
					);
				}
				const resolvedSpecs = yield* Effect.forEach(specs, (spec) =>
					Effect.gen(function* () {
						const base = yield* resolveCoinRef(spec.base);
						const quote = yield* resolveCoinRef(spec.quote);
						return {
							name: spec.name,
							base,
							quote,
							tickSize: spec.tickSize,
							lotSize: spec.lotSize,
							minSize: spec.minSize,
							whitelisted: spec.whitelisted ?? true,
							stable: spec.stable ?? false,
						};
					}),
				);
				const poolsHash = hashPoolSpecs(resolvedSpecs);
				return {
					packageId: pkg.packageId,
					signer: signer.address,
					poolsHash,
				};
			}),

		// §4.2 verify probe: every cached pool object id must still
		// resolve on chain AND its `type` must match
		// `<packageId>::pool::Pool<base, quote>`. `ChainProbe.objectsMatchTypes`
		// does the schema-validated read; transient RPC failures surface
		// as `false` (and the cache invalidates). Per RS2 we probe STABLE
		// identifiers — the pool ids came straight from the produce body's
		// objectChanges.
		//
		// Pre-substrate the verify probe read `.objectType` off the SDK
		// response root, which is `undefined` at runtime against the real
		// SDK — making every cache check fall through to "objects missing"
		// and re-firing the create-pools tx on resume (whose `register_pool`
		// then aborts because (base,quote) is still registered on chain).
		// ChainProbe's Schema-validated `objectsMatchTypes` makes that
		// bug class structurally impossible (B1).
		verify: ({ cached, chain }) =>
			chain
				.objectsMatchTypes(
					cached.pools.map((p) => ({
						objectId: p.poolId,
						expectedType: `${cached.packageId}::pool::Pool<${p.base}, ${p.quote}>`,
					})),
					moveTypeEquals,
				)
				.pipe(Effect.map((ok) => (ok ? cached : undefined))),

		// Fresh-create body — runs on cache miss / verify-fail. Resolves
		// the publish package (guaranteed non-undefined: `inputs` already
		// failed for the no-publish case before the cache look-up), then
		// runs the batched `init_balance_manager_map` + N
		// `create_pool_admin` transaction.
		produce: ({ publish: pkg, signer }) =>
			Effect.gen(function* () {
				if (pkg === undefined) {
					// Unreachable in practice — `inputs` fails first. Kept
					// for type narrowing.
					return yield* Effect.fail(
						new DeepbookError({
							phase: 'publish',
							message: `deepbookLocalDeploy(${name}): publish is required`,
						}),
					);
				}
				const packageId = pkg.packageId;
				const registryId = pkg.captured?.registryId;
				const adminCapId = pkg.captured?.adminCapId;
				if (registryId === undefined || adminCapId === undefined) {
					return yield* Effect.fail(
						new DeepbookError({
							phase: 'publish',
							message:
								`deepbookLocalDeploy(${name}): publish did not surface registryId/adminCapId — ` +
								'expected the deepbook-v3 source at `movePackagePath` to create them in init',
						}),
					);
				}

				// Re-resolve coin tags inside the produce body too. We
				// already did this once in `inputs` to derive `poolsHash`,
				// but the closure form `Effect.forEach` is cheap and keeps
				// the substrate's "inputs/produce don't share state"
				// invariant honest.
				const resolvedSpecs = yield* Effect.forEach(specs, (spec) =>
					Effect.gen(function* () {
						const base = yield* resolveCoinRef(spec.base);
						const quote = yield* resolveCoinRef(spec.quote);
						return { spec, base, quote };
					}),
				);

				const poolsArr: Array<CachedDeepbookPool> = [];

				// One batched tx — `init_balance_manager_map` + N
				// `create_pool_admin` calls. Skipped entirely when no
				// pools were requested.
				if (resolvedSpecs.length > 0) {
					const t = new Transaction();
					t.setGasBudget(500_000_000n);

					t.moveCall({
						target: `${packageId}::registry::init_balance_manager_map`,
						arguments: [t.object(registryId), t.object(adminCapId)],
					});

					for (const { spec, base, quote } of resolvedSpecs) {
						t.moveCall({
							target: `${packageId}::pool::create_pool_admin`,
							typeArguments: [base, quote],
							arguments: [
								t.object(registryId),
								t.pure.u64(spec.tickSize),
								t.pure.u64(spec.lotSize),
								t.pure.u64(spec.minSize),
								t.pure.bool(spec.whitelisted ?? true),
								t.pure.bool(spec.stable ?? false),
								t.object(adminCapId),
							],
						});
					}

					const result = yield* signer.signAndExecute(t).pipe(
						Effect.mapError(
							(cause) =>
								new DeepbookError({
									phase: 'create-pools',
									message: `deepbookLocalDeploy(${name}): create-pools tx failed: ${cause.message}`,
									cause,
								}),
						),
					);

					// Exact-string match against the expected `Pool<base, quote>`
					// objectType keeps multi-pool tx output deterministic.
					for (const { spec, base, quote } of resolvedSpecs) {
						const expected = `${packageId}::pool::Pool<${base}, ${quote}>`;
						const poolId = pickCreatedByType(result.objectChanges, { suffix: expected });
						if (poolId === undefined) {
							return yield* Effect.fail(
								new DeepbookError({
									phase: 'create-pools',
									message:
										`deepbookLocalDeploy(${name}): pool '${spec.name}' missing from objectChanges ` +
										`(expected type ${expected})`,
								}),
							);
						}
						poolsArr.push({
							name: spec.name,
							poolId,
							base,
							quote,
							tickSize: spec.tickSize,
							lotSize: spec.lotSize,
							minSize: spec.minSize,
						});
					}
				}

				const fresh: CachedDeepbookPools = {
					packageId,
					registryId,
					adminCapId,
					deepTreasuryId: pkg.captured?.deepTreasuryId,
					pools: poolsArr,
				};
				return fresh;
			}),

		// `register` runs on EVERY cycle (hit AND miss) AFTER the value
		// resolves but BEFORE downstream consumers see it. Two roles:
		//
		//   1. Re-attach the rich `DeepbookLocalDeployShape` fields
		//      (`pools` record, `poolIds` Map, `findPool` closure,
		//      `packageIds` view). The cached payload is plain data so it
		//      JSON-roundtrips cleanly; the consumer-facing shape carries
		//      closures + Maps. We mutate in place because the substrate
		//      returns `value` after `register` runs (per `onChainArtifact`'s
		//      contract), so this is the single point where the cache-hit
		//      and cache-miss paths converge on the same observable shape
		//      — matches `publishMove`'s host-local-field-mutation pattern.
		//   2. Re-publish to PackageRegistry + DeepbookStateRegistry so
		//      resume + cold start are observably identical from the
		//      consumer side (registries live in-memory per supervisor
		//      cycle).
		register: ({ value, deps: { publish: pkg } }) =>
			Effect.gen(function* () {
				// Snapshot the cached array shape BEFORE the rich-field
				// mutation below — `rich.pools = poolsRecord` overwrites
				// `value.pools` and the deepbook-state-registry payload
				// downstream needs the array form.
				const cachedPoolsArray = value.pools;
				const poolsRecord = buildPoolsRecord(cachedPoolsArray);
				const poolIds = buildPoolIds(cachedPoolsArray);
				const findPool = makeFindPool(name, poolsRecord);
				const packageIds = buildPackageIds({
					packageId: value.packageId,
					registryId: value.registryId,
					deepTreasuryId: value.deepTreasuryId,
				});

				// Mutate the rich shape onto the resolved value. The
				// `DeepbookLocalDeployShape` type is what consumers
				// expect from `yield* composite`; we attach all of its
				// derived fields here so hit + miss paths converge.
				const rich = value as unknown as {
					pools: Record<string, DeepbookPool>;
					poolIds: ReadonlyMap<string, string>;
					findPool: DeepbookCore['findPool'];
					packageIds: DeepbookCore['packageIds'];
					registryId: string;
					adminCapId: string;
				};
				rich.pools = poolsRecord;
				rich.poolIds = poolIds;
				rich.findPool = findPool;
				rich.packageIds = packageIds;

				// Re-register the composite package under `name` (the
				// deepbook service name) so codegen emitters can look it
				// up at `data.packages[name]`. The publishMove sub-tag
				// already registers under `${name}.publish` with the FULL
				// captured shape (registryId + adminCapId + deepTreasuryId);
				// we forward ALL three here so emitters that ask
				// `data.packages.deepbook` (vs `data.packages.deepbook.publish`)
				// see the same shape. Forgetting to pass `deepTreasuryId`
				// here was the cause of `DeepbookConfigEmitter: skipping
				// emit — ... packages.deepbook.captured.deepTreasuryId is
				// missing` — emit-time it was missing so the file never
				// landed and `src/lib/deployment.ts` died on
				// `import { deepbookConfig } from '../generated/deepbook-config.js'`.
				yield* publishPackage({
					name,
					packageId: value.packageId,
					upgradeCapId: pkg?.upgradeCapId,
					captured: {
						registryId: value.registryId,
						adminCapId: value.adminCapId,
						...(value.deepTreasuryId !== undefined
							? { deepTreasuryId: value.deepTreasuryId }
							: {}),
					},
				});

				yield* publishDeepbookState({
					name,
					packageId: value.packageId,
					registryId: value.registryId,
					pools: Object.fromEntries(
						cachedPoolsArray.map((p) => [
							p.name,
							{ poolId: p.poolId, baseType: p.base, quoteType: p.quote },
						]),
					),
				});
			}),
	});

	// The three interface layers all depend on the composite tag. Each
	// derives its slice of the rich shape and binds it to the canonical
	// Context key. Stacking the local-deploy member satisfies every
	// downstream consumer of `DeepbookCoreTag` / `DeepbookAdminTag` /
	// `DeepbookMarketMaker` from a single config entry.
	//
	// The composite resolves to the lean `CachedDeepbookPools` payload
	// with the rich `DeepbookLocalDeployShape` fields mutated on via
	// `register`. The interface layers cast to the rich type — see the
	// comment above `register`'s field mutation block.
	type CompositeResolved = CachedDeepbookPools & DeepbookLocalDeployShape;

	const coreLayer = provide(
		DeepbookCoreTag,
		Effect.gen(function* () {
			const db = (yield* composite) as unknown as CompositeResolved;
			return {
				packageId: db.packageId,
				registryId: db.registryId,
				packageIds: db.packageIds,
				poolIds: db.poolIds,
				findPool: db.findPool,
			} satisfies DeepbookCore;
		}),
	).__layer;

	const adminLayer = provide(
		DeepbookAdminTag,
		Effect.gen(function* () {
			yield* composite;
			return {} as const;
		}),
	).__layer;

	const marketMakerLayer = provide(
		DeepbookMarketMakerTag,
		Effect.gen(function* () {
			const db = (yield* composite) as unknown as CompositeResolved;
			const signer = yield* options.signer;

			// Lazy BalanceManager: minted on first `tickPool` call so
			// stacks that never consume the market-maker interface don't
			// pay for an empty BalanceManager tx at startup. Mutable
			// closure state — Layer.build resolves the layer once per
			// scope, so concurrent first-call races aren't a concern.
			let balanceManagerId: string | undefined;

			const ensureBalanceManager = Effect.gen(function* () {
				if (balanceManagerId !== undefined) return balanceManagerId;
				const t = new Transaction();
				t.setGasBudget(500_000_000n);
				const bm = t.moveCall({
					target: `${db.packageId}::balance_manager::new`,
					arguments: [],
				});
				t.transferObjects([bm], signer.address);
				const result = yield* signer.signAndExecute(t).pipe(
					Effect.mapError(
						(cause) =>
							new DeepbookError({
								phase: 'market-maker-tick',
								message: `deepbookLocalDeploy(${name}): BalanceManager mint failed: ${cause.message}`,
								cause,
							}),
					),
				);
				const bmType = `${db.packageId}::balance_manager::BalanceManager`;
				const createdId = pickCreatedByType(result.objectChanges, { suffix: bmType });
				if (createdId === undefined) {
					return yield* Effect.fail(
						new DeepbookError({
							phase: 'market-maker-tick',
							message:
								`deepbookLocalDeploy(${name}): BalanceManager id missing from ` +
								`objectChanges after mint`,
						}),
					);
				}
				balanceManagerId = createdId;
				return balanceManagerId;
			});

			const tickPool = (
				poolName: string,
				params: { readonly baseQty: bigint; readonly quotePrice: bigint },
			): Effect.Effect<void, DeepbookError> =>
				Effect.gen(function* () {
					const pool = (db.pools as Record<string, DeepbookPool | undefined>)[poolName];
					if (pool === undefined) {
						return yield* Effect.fail(
							new DeepbookError({
								phase: 'market-maker-tick',
								message: `deepbookLocalDeploy(${name}): pool '${poolName}' not declared`,
							}),
						);
					}
					const bmId = yield* ensureBalanceManager;
					const t = new Transaction();
					t.setGasBudget(500_000_000n);
					const bm = t.object(bmId);
					const proof = t.moveCall({
						target: `${db.packageId}::balance_manager::generate_proof_as_owner`,
						arguments: [bm],
					});
					const expireMs = BigInt(Date.now() + 24 * 60 * 60 * 1000);
					t.moveCall({
						target: `${db.packageId}::pool::place_limit_order`,
						typeArguments: [pool.base, pool.quote],
						arguments: [
							t.object(pool.poolId),
							bm,
							proof,
							t.pure.u64(BigInt(Math.floor(Date.now() / 1000))),
							t.pure.u8(ORDER_TYPE_POST_ONLY),
							t.pure.u8(SELF_MATCHING_ALLOWED),
							t.pure.u64(params.quotePrice),
							t.pure.u64(params.baseQty),
							t.pure.bool(true),
							t.pure.bool(false),
							t.pure.u64(expireMs),
							t.object(SUI_CLOCK_OBJECT_ID),
						],
					});
					yield* signer.signAndExecute(t).pipe(
						Effect.mapError(
							(cause) =>
								new DeepbookError({
									phase: 'market-maker-tick',
									message: `deepbookLocalDeploy(${name}): tickPool tx failed: ${cause.message}`,
									cause,
								}),
						),
					);
				});

			// Mint up-front so consumers can read `balanceManagerId`
			// synchronously from the shape. Yes this costs a tx even when
			// the interface isn't consumed — but local-deploy is already
			// publishing a Move package + creating pools, so the marginal
			// cost is small relative to startup.
			const bmId = yield* ensureBalanceManager;
			return {
				balanceManagerId: bmId,
				tickPool,
			};
		}),
	).__layer;

	// `SuiTag` is yielded inside `register` (transitively, via the substrate)
	// + `marketMakerLayer` (via `signer.signAndExecute`). The composite's
	// __layers already includes everything onChainArtifact stitched in
	// (the publish sibling's layers via `extraLayers`, plus the
	// composite's own Layer.effect). Stack the interface layers on top.
	const __layers: ReadonlyArray<Layer.Layer<any, any, any>> = [
		...composite.__layers,
		coreLayer,
		adminLayer,
		marketMakerLayer,
	];

	// Hybrid return — usable as a StackMember inside `defineDevstack`
	// AND yieldable as the composite tag for `yield* db` consumers
	// that read the rich `.pools` record. The composite's resolved value
	// has the rich `DeepbookLocalDeployShape` fields mutated on via
	// `register`; the cast bridges the substrate's `CachedDeepbookPools`
	// generic param to the user-visible shape.
	return Object.assign(
		composite as unknown as LayeredTag<
			Name,
			DeepbookLocalDeployShape<PoolsRecord<TPools>>,
			never,
			any
		>,
		{ __layers },
	);
};
