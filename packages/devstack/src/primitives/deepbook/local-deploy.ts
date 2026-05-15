// `deepbookLocalDeploy(opts)` — publish the deepbook-v3 Move package +
// create the requested whitelisted pools. Provides all three interface
// tags (`DeepbookCore`, `DeepbookAdmin`, `DeepbookMarketMaker`) because
// the local deploy owns the admin cap and can mint a BalanceManager.

/* eslint-disable @typescript-eslint/no-explicit-any */

import * as crypto from 'node:crypto';
import { Effect, Layer, Option } from 'effect';
import { Transaction } from '@mysten/sui/transactions';
import { makeTag, provideTag, type PluginTag } from '../../advanced/tag.js';
import { Sui } from '../sui.js';
import { publishMove, pickCreatedByTypeSuffix } from '../publish-move.js';
import { PackageRegistry } from '../../engine/registries.js';
import { StateStore } from '../../engine/state-store.js';
import { stringifyCause } from '../../engine/stringify-cause.js';
import { DeepbookError } from '../errors.js';
import {
	DeepbookAdmin,
	DeepbookCore,
	DeepbookMarketMakerTag,
	type DeepbookCoreShape,
} from '../../services/deepbook.js';
import type { Account, SuiObjectChange } from '../shared.js';
import {
	DEEPBOOK_ADMIN_CAP_TYPE_SUFFIX,
	DEEPBOOK_REGISTRY_TYPE_SUFFIX,
	ORDER_TYPE_POST_ONLY,
	SELF_MATCHING_ALLOWED,
	SUI_CLOCK_OBJECT_ID,
	makeFindPool,
	resolveCoinRef,
	type DeepbookPool,
	type DeepbookPoolSpec,
} from './internal.js';

// StateStore key prefix for the cached create-pools output. Versioned
// so a future schema bump invalidates stale caches automatically. The
// full key folds in `Sui.chainId` (regenesis ⇒ different chainId ⇒
// miss), the deepbook `packageId` (republish ⇒ different packageId
// ⇒ miss), and a hash of the requested pool specs (reconfigure ⇒
// miss). Without this cache, `pool::create_pool_admin` aborts in
// `registry::register_pool` (function 13) on every resume because
// (base, quote) was already registered by the previous boot —
// chain state survives `pnpm dev` restarts but the primitive
// didn't know it.
const STATE_KEY_POOLS_PREFIX = 'deepbook/pools/v1';

// Subset of `DeepbookPool` we persist into `StateStore`. Echoes the
// runtime pool record verbatim — the captured `poolId` is the load-
// bearing piece (it's what `register_pool` would re-mint), the
// `tick/lot/min` fields go in because consumers (`market-maker`,
// `findPool`'s table) read them off the cached pool record on resume.
// `bigint` round-trips through `state-store` via the BigInt-tagging
// JSON reviver/replacer.
interface CachedDeepbookPool {
	readonly name: string;
	readonly poolId: string;
	readonly base: string;
	readonly quote: string;
	readonly tickSize: bigint;
	readonly lotSize: bigint;
	readonly minSize: bigint;
}

interface CachedDeepbookPools {
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
	readonly signer: PluginTag<any, Account, any, any>;
	/** Filesystem path to a vendored deepbook-v3 Move package. The
	 *  `@mysten/deepbook-v3` npm package does not currently ship compiled
	 *  bytecode + dependency manifest in a form we can submit directly via
	 *  `Transaction.publish`, so callers vendor the source themselves
	 *  (typically via a monorepo-level `gitFetch` step or a checked-in
	 *  submodule). */
	readonly movePackagePath?: string;
	readonly pools?: TPools;
	readonly dependsOn?: ReadonlyArray<PluginTag<any, any, any, any>>;
}

// Local-deploy carries the rich per-pool record (tick/lot/min) so the
// composite tag can satisfy `yield* db` for legacy consumers projecting
// pools into manifest extras. The interface `DeepbookCore` itself only
// surfaces poolIds + findPool.
export interface DeepbookLocalDeployShape<
	TPools extends Record<string, DeepbookPool> = Record<string, DeepbookPool>,
> extends DeepbookCoreShape {
	readonly adminCapId: string;
	readonly pools: TPools;
}

type PoolsRecord<T extends ReadonlyArray<DeepbookPoolSpec>> = {
	readonly [K in T[number]['name']]: DeepbookPool;
};

/**
 * Publish a vendored deepbook-v3 package, create whitelisted pools, and
 * surface `DeepbookCore`, `DeepbookAdmin`, and `DeepbookMarketMaker`
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

	// The publish tag is a sibling primitive; we yield it inside our
	// scoped acquire to chain its package id + captured registry/admin-cap
	// ids forward into the create-pool transactions. Built lazily so the
	// producer fails at start (not at module-eval) when `movePackagePath`
	// is omitted.
	const publish =
		options.movePackagePath !== undefined
			? publishMove({
					name: `${name}.publish` as const,
					path: options.movePackagePath,
					signer: options.signer,
					capture: (changes) => {
						const registryId = pickCreatedByTypeSuffix(changes, DEEPBOOK_REGISTRY_TYPE_SUFFIX);
						const adminCapId = pickCreatedByTypeSuffix(changes, DEEPBOOK_ADMIN_CAP_TYPE_SUFFIX);
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
								c.objectType.startsWith('0x2::coin::TreasuryCap<') &&
								c.objectType.endsWith('::deep::DEEP>'),
						)?.objectId;
						return { registryId, adminCapId, deepTreasuryId };
					},
				})
			: undefined;

	// Composite acquire — does the publish + pool creation once, surfaces
	// the rich shape. The three interface layers below all depend on this
	// composite tag, so Layer.build dedupes the acquire (single publish
	// regardless of how many interface tags are yielded downstream).
	const composite = makeTag(
		name,
		Effect.gen(function* () {
			for (const tag of options.dependsOn ?? []) {
				yield* tag;
			}
			const sui = yield* Sui;
			const signer = yield* options.signer;
			const state = yield* StateStore;

			// Surface the chain identifier as a span attribute. A regenesis
			// of the underlying chain flips `sui.chainId`; downstream cache
			// keys fold it in so they naturally miss.
			yield* Effect.annotateCurrentSpan({ 'sui.chainId': sui.chainId });

			if (publish === undefined) {
				return yield* Effect.fail(
					new DeepbookError({
						phase: 'publish',
						message:
							`deepbookLocalDeploy(${name}): \`movePackagePath\` is required to publish ` +
							'the deepbook-v3 Move package. Vendor the source (e.g. via `gitFetch` ' +
							'or a checked-in submodule) and pass the directory path.',
					}),
				);
			}

			const pkg = yield* Effect.gen(function* () {
				return yield* publish;
			}).pipe(Effect.withSpan('deepbook.publish'));

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

			// One batched tx — `init_balance_manager_map` + N `create_pool_admin`
			// calls (matches v3). Skipped entirely when no pools were requested.
			//
			// Resume idempotency: `pool::create_pool_admin` calls
			// `registry::register_pool`, which aborts (function 13) on a
			// duplicate (base, quote) pair. The chain state, named volumes,
			// and packageId all survive `pnpm dev` restarts, but the
			// primitive didn't know — so a second boot died here. Cache the
			// captured pool object ids under (chainId, packageId,
			// poolsHash) and reuse them on resume.
			const pools = {} as Record<string, DeepbookPool>;
			if (specs.length > 0) {
				const resolvedSpecs: ReadonlyArray<{
					readonly spec: DeepbookPoolSpec;
					readonly base: string;
					readonly quote: string;
				}> = yield* Effect.gen(function* () {
					const out: Array<{
						readonly spec: DeepbookPoolSpec;
						readonly base: string;
						readonly quote: string;
					}> = [];
					for (const spec of specs) {
						const base = yield* resolveCoinRef(spec.base);
						const quote = yield* resolveCoinRef(spec.quote);
						out.push({ spec, base, quote });
					}
					return out;
				});

				const poolsHash = hashPoolSpecs(
					resolvedSpecs.map(({ spec, base, quote }) => ({
						name: spec.name,
						base,
						quote,
						tickSize: spec.tickSize,
						lotSize: spec.lotSize,
						minSize: spec.minSize,
						whitelisted: spec.whitelisted ?? true,
						stable: spec.stable ?? false,
					})),
				);
				const cacheKey = `${STATE_KEY_POOLS_PREFIX}/${sui.chainId}/${packageId}/${poolsHash}`;
				const cached = yield* state.get<CachedDeepbookPools>(cacheKey);

				// Best-effort verification — confirm each cached pool object
				// is still resolvable on chain before trusting the cache.
				// Covers the pathological case where the state-store file
				// survived but the chain got wiped externally (manual
				// `docker volume rm`, container snapshot mismatch, etc.).
				// Any verification failure falls through to a re-create.
				// Mirrors publishMove's "chainId fold is the primary
				// invalidator, secondary verify is defense-in-depth"
				// pattern, but here we actually probe — the cost of a
				// second create-pools-abort on resume is the entire
				// reason this cache exists.
				const verifyCached = (
					payload: CachedDeepbookPools,
				): Effect.Effect<boolean, never> =>
					Effect.gen(function* () {
						for (const p of payload.pools) {
							const ok = yield* Effect.tryPromise({
								try: () => sui.client.core.getObject({ objectId: p.poolId }),
								catch: (cause) => cause,
							}).pipe(
								Effect.as(true),
								Effect.catch(() => Effect.succeed(false)),
							);
							if (!ok) return false;
						}
						return true;
					});

				let resumed = false;
				if (Option.isSome(cached)) {
					const verified = yield* verifyCached(cached.value);
					if (verified) {
						yield* Effect.logInfo(
							`deepbookLocalDeploy(${name}): cache hit — chainId=${sui.chainId} ` +
								`packageId=${packageId} poolsHash=${poolsHash} ` +
								`(${cached.value.pools.length} pool${cached.value.pools.length === 1 ? '' : 's'}, verified)`,
						);
						yield* Effect.annotateCurrentSpan({
							'deepbook.pools.cache': 'hit',
							'deepbook.pools.count': cached.value.pools.length,
							'deepbook.pools.hash': poolsHash,
						});
						for (const p of cached.value.pools) {
							pools[p.name] = {
								name: p.name,
								poolId: p.poolId,
								base: p.base,
								quote: p.quote,
								tickSize: p.tickSize,
								lotSize: p.lotSize,
								minSize: p.minSize,
							};
						}
						resumed = true;
					} else {
						yield* Effect.logInfo(
							`deepbookLocalDeploy(${name}): cache hit but pool objects missing on chain — ` +
								`invalidating and re-creating (chainId=${sui.chainId} packageId=${packageId})`,
						);
						yield* Effect.annotateCurrentSpan({
							'deepbook.pools.cache': 'stale',
							'deepbook.pools.hash': poolsHash,
						});
						yield* state.remove(cacheKey);
					}
				}

				if (!resumed) {
					yield* Effect.annotateCurrentSpan({
						'deepbook.pools.cache': Option.isNone(cached) ? 'miss' : 'invalidated',
						'deepbook.pools.hash': poolsHash,
					});
					yield* Effect.gen(function* () {
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
							const found = result.objectChanges.find(
								(c): c is Extract<SuiObjectChange, { type: 'created' }> =>
									c.type === 'created' && 'objectType' in c && c.objectType === expected,
							);
							if (found === undefined) {
								return yield* Effect.fail(
									new DeepbookError({
										phase: 'create-pools',
										message:
											`deepbookLocalDeploy(${name}): pool '${spec.name}' missing from objectChanges ` +
											`(expected type ${expected})`,
									}),
								);
							}
							pools[spec.name] = {
								name: spec.name,
								poolId: found.objectId,
								base,
								quote,
								tickSize: spec.tickSize,
								lotSize: spec.lotSize,
								minSize: spec.minSize,
							};
						}

						// Persist the captured pool ids so the next supervisor
						// cycle short-circuits the create-pools tx. Write
						// happens AFTER capture so a mid-flight failure
						// doesn't poison the cache with half-created pools.
						const toCache: CachedDeepbookPools = {
							pools: Object.values(pools).map((p) => ({
								name: p.name,
								poolId: p.poolId,
								base: p.base,
								quote: p.quote,
								tickSize: p.tickSize,
								lotSize: p.lotSize,
								minSize: p.minSize,
							})),
						};
						yield* state.put(cacheKey, toCache);
					}).pipe(Effect.withSpan('deepbook.create-pools'));
				}
			}

			yield* PackageRegistry.publish({
				name,
				packageId,
				upgradeCapId: pkg.upgradeCapId,
				captured: { registryId, adminCapId },
			});

			const poolIds = new Map<string, string>(
				Object.values(pools).map((p) => [p.name, p.poolId]),
			);
			const findPool = makeFindPool(name, pools);

			// SDK-aligned view. `DEEP_TREASURY_ID` is the locally-minted DEEP
			// token's `TreasuryCap` — the vendored deepbook-v3 Move source
			// declares the `deep::DEEP` coin, so the publish tx creates a
			// `TreasuryCap<{pkg}::deep::DEEP>` that we capture via the
			// `publishMove({capture})` callback above. Falls back to `''` if
			// the vendored source ever drops the DEEP module (we don't fail
			// loudly because consumers that don't need DEEP fees on localnet
			// shouldn't be forced to vendor a specific Move version).
			const deepTreasuryId = (pkg.captured?.deepTreasuryId as string | undefined) ?? '';
			const packageIds = {
				DEEPBOOK_PACKAGE_ID: packageId,
				REGISTRY_ID: registryId,
				DEEP_TREASURY_ID: deepTreasuryId,
				MARGIN_PACKAGE_ID: undefined,
				MARGIN_REGISTRY_ID: undefined,
				LIQUIDATION_PACKAGE_ID: undefined,
			} satisfies DeepbookCoreShape['packageIds'];

			return {
				packageId,
				registryId,
				adminCapId,
				pools: pools as unknown as PoolsRecord<TPools>,
				poolIds,
				findPool,
				packageIds,
			} satisfies DeepbookLocalDeployShape<PoolsRecord<TPools>>;
		}).pipe(
			Effect.withSpan(`deepbookLocalDeploy(${name})`),
			Effect.catchTag('DeepbookError', Effect.fail),
			Effect.catch((cause: unknown) =>
				Effect.fail(
					new DeepbookError({
						phase: 'deepbook',
						message: `deepbookLocalDeploy(${name}): ${stringifyCause(cause)}`,
						cause,
					}),
				),
			),
		),
		// Publish tag's layer must flow into the parent's `__layers` so
		// defineDevstack picks it up alongside the composite + interface
		// layers below. The composite is the user-facing "deploy +
		// configure once" step, so we render it under Actions even though
		// it shares its life with the long-running stack.
		{
			...(publish !== undefined ? { extraLayers: [publish.__layer] } : {}),
			kind: 'action' as const,
			displayTitle: `publish.${name}`,
			display: (s: DeepbookLocalDeployShape) => {
				const poolCount = Object.keys(s.pools).length;
				return {
					title: `publish.${name}`,
					primary: s.packageId,
					...(poolCount > 0 ? { extras: [`${poolCount} pool${poolCount === 1 ? '' : 's'}`] } : {}),
				};
			},
		},
	);

	// The three interface layers all depend on the composite tag. Each
	// derives its slice of the rich shape and binds it to the canonical
	// Context key. Stacking the local-deploy member satisfies every
	// downstream consumer of `DeepbookCore` / `DeepbookAdmin` /
	// `DeepbookMarketMaker` from a single config entry.
	const coreLayer = provideTag(
		DeepbookCore,
		Effect.gen(function* () {
			const db = yield* composite;
			return {
				packageId: db.packageId,
				registryId: db.registryId,
				packageIds: db.packageIds,
				poolIds: db.poolIds,
				findPool: db.findPool,
			} satisfies DeepbookCoreShape;
		}),
	).__layer;

	const adminLayer = provideTag(
		DeepbookAdmin,
		Effect.gen(function* () {
			yield* composite;
			return {} as const;
		}),
	).__layer;

	const marketMakerLayer = provideTag(
		DeepbookMarketMakerTag,
		Effect.gen(function* () {
			const db = yield* composite;
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
				const created = result.objectChanges.find(
					(c): c is Extract<SuiObjectChange, { type: 'created' }> =>
						c.type === 'created' && 'objectType' in c && c.objectType === bmType,
				);
				if (created === undefined) {
					return yield* Effect.fail(
						new DeepbookError({
							phase: 'market-maker-tick',
							message:
								`deepbookLocalDeploy(${name}): BalanceManager id missing from ` +
								`objectChanges after mint`,
						}),
					);
				}
				balanceManagerId = created.objectId;
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

	const __layers: ReadonlyArray<Layer.Layer<any, any, any>> = [
		...composite.__layers,
		coreLayer,
		adminLayer,
		marketMakerLayer,
	];

	// Hybrid return — usable as a StackMember inside `defineDevstack`
	// AND yieldable as the composite tag for legacy `yield* db` consumers
	// that read the rich `.pools` record.
	return Object.assign(composite, { __layers });
};
