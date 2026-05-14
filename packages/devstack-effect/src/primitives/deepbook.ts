// DeepBook v3 primitives — interface-driven multi-impl.
//
//   - `deepbookLocalDeploy(opts)`     → publish the deepbook-v3 Move
//     package + create the requested whitelisted pools. Provides all
//     three interface tags (`DeepbookCore`, `DeepbookAdmin`,
//     `DeepbookMarketMaker`) because the local deploy owns the admin
//     cap and can mint a BalanceManager.
//   - `deepbookKnownPackage(opts)`    → wrap an already-deployed
//     deepbook-v3 instance (e.g. canonical testnet/mainnet). Provides
//     only `DeepbookCore` — no admin cap, no balance manager.
//   - `deepbookMarketMaker(opts)`     → long-running grid maker. A
//     CONSUMER that yields `DeepbookCore` from Context, so it composes
//     against either local-deploy or known-package.
//
// Mechanical heir of `deepbook(opts)` + `deepbookMarketMaker(opts)`.
// Same Move calls, same fee math, same cadence — only the surrounding
// plumbing is split across multiple interface layers.

import { Effect, Layer, Schedule } from 'effect';
import { Transaction, type TransactionObjectArgument } from '@mysten/sui/transactions';
import { makeTag, provideTag, type PluginTag } from '../tag.js';
import { Sui } from './sui.js';
import { publishMove, pickCreatedByTypeSuffix } from './publish-move.js';
import { PackageRegistry } from '../internal/registries.js';
import { stringifyCause } from '../internal/stringify-cause.js';
import { DeepbookError } from './errors.js';
import {
	DeepbookAdmin,
	DeepbookCore,
	DeepbookMarketMaker as DeepbookMarketMakerTag,
	type DeepbookCoreShape,
	type DeepbookPoolRef,
} from '../interfaces/deepbook.js';
import { knownDeployments, type KnownNetwork } from '../internal/known-deployments.js';
import type { StackMember } from '../define-devstack.js';
import type { Account, SuiObjectChange } from './shared.js';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const SUI_CLOCK_OBJECT_ID = '0x6';

const DEEPBOOK_REGISTRY_TYPE_SUFFIX = '::registry::Registry';
const DEEPBOOK_ADMIN_CAP_TYPE_SUFFIX = '::registry::DeepbookAdminCap';

// `pool::place_limit_order` order types. POST_ONLY rejects any order that
// would cross the book — required for makers; without it a maker would
// self-take its own bids when posting an ask inside the spread on a thin
// book.
const ORDER_TYPE_POST_ONLY = 3;
const SELF_MATCHING_ALLOWED = 0;

// Per-pool default predeposit multiplier — covers ~16 refresh ticks of
// the full grid before any fills would draw the maker down. Mirrors v3.
const DEFAULT_PREDEPOSIT_MULTIPLIER = 100n;

// -----------------------------------------------------------------------------
// Shared types
// -----------------------------------------------------------------------------

// `base` / `quote` accept either a literal Move type string
// (`0x2::sui::SUI`) or a tag whose yielded value carries
// `fullCoinType` — the shape `registerCoin` produces. The tag form
// lets pools reference coins published earlier in the same devstack,
// where the on-chain id (and therefore the full Move type) isn't
// known until the publish step resolves at runtime.
//
// `Context.Service` is invariant in its value parameter, so a coin
// tag with a richer shape (extra `name` / `packageId` fields from
// `registerCoin`) isn't assignable to `PluginTag<any, { fullCoinType:
// string }, any, any>`. The pool spec's coin slots accept any tag
// (`AnyCoinTag`); the `fullCoinType` field is read structurally
// inside the body.
export type DeepbookCoinRef = string | PluginTag<any, { readonly fullCoinType: string }, any, any>;

type AnyCoinTag = PluginTag<any, any, any, any>;

export interface DeepbookPoolSpec<
	Base extends string | AnyCoinTag = string | AnyCoinTag,
	Quote extends string | AnyCoinTag = string | AnyCoinTag,
> {
	readonly name: string;
	readonly base: Base;
	readonly quote: Quote;
	readonly tickSize: bigint;
	readonly lotSize: bigint;
	readonly minSize: bigint;
	/** Whitelisted pool — disables DEEP fees. Default true (test-friendly). */
	readonly whitelisted?: boolean;
	/** Stable pool — different fee math. Default false. */
	readonly stable?: boolean;
}

export interface DeepbookPool {
	readonly name: string;
	readonly poolId: string;
	readonly base: string;
	readonly quote: string;
	/** Echoed back so consumers (market makers) can compute level offsets
	 *  without re-reading the spec. */
	readonly tickSize: bigint;
	readonly lotSize: bigint;
	readonly minSize: bigint;
}

// -----------------------------------------------------------------------------
// deepbookLocalDeploy(opts)
// -----------------------------------------------------------------------------

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
						return { registryId, adminCapId };
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

			// Surface the chain identifier as a span attribute. A regenesis
			// of the underlying chain flips `sui.chainId`; downstream cache
			// keys (if/when added) fold it in so they naturally miss.
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
				}).pipe(Effect.withSpan('deepbook.create-pools'));
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

			// SDK-aligned view. `DEEP_TREASURY_ID` would be the locally-minted
			// DEEP token's `TreasuryCap`; the local deepbook source we vendor
			// doesn't expose a hook to capture it yet, so it's left undefined
			// here. Consumers that need on-chain DEEP fees should run against
			// `deepbookKnownPackage({network})` instead, where the canonical
			// testnet/mainnet treasury id is registered.
			// TODO(deep-treasury): plumb the locally-deployed DEEP
			// TreasuryCap object id through `publishMove({capture})` and
			// surface it here once the vendored Move source includes it.
			const packageIds = {
				DEEPBOOK_PACKAGE_ID: packageId,
				REGISTRY_ID: registryId,
				DEEP_TREASURY_ID: '',
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

// -----------------------------------------------------------------------------
// deepbookKnownPackage(opts)
// -----------------------------------------------------------------------------

export interface DeepbookKnownPackageOptions {
	readonly network?: KnownNetwork;
	readonly packageId?: string;
	readonly registryId?: string;
	readonly pools?: ReadonlyArray<{
		readonly name: string;
		readonly poolId: string;
		readonly baseType: string;
		readonly quoteType: string;
	}>;
}

/**
 * Point `DeepbookCore` at an already-deployed deepbook-v3 instance
 * (canonical testnet/mainnet, or any caller-supplied id pair). Does NOT
 * provide `DeepbookAdmin` (we don't own the cap) or `DeepbookMarketMaker`
 * (no balance manager to set up here). Stack `deepbookMarketMaker(...)`
 * separately for makers running against a known package.
 */
export const deepbookKnownPackage = (opts: DeepbookKnownPackageOptions): StackMember => {
	const deployment = opts.network !== undefined ? knownDeployments.deepbook[opts.network] : undefined;
	const packageId = opts.packageId ?? deployment?.packageId;
	const registryId = opts.registryId ?? deployment?.registryId;

	if (packageId === undefined || registryId === undefined) {
		throw new Error(
			'deepbookKnownPackage: no packageId/registryId could be resolved. Pass ' +
				'`network` (e.g. `"testnet"`) for a canonical deployment, or supply ' +
				'`packageId` + `registryId` explicitly.',
		);
	}

	// SDK-aligned `packageIds` view. Sourced from the registry's
	// camelCase entry when the caller passed `network`; falls back to
	// explicit ids (with empty strings + undefineds for the optional
	// fields) when only `packageId`/`registryId` were supplied.
	const packageIds: DeepbookCoreShape['packageIds'] = {
		DEEPBOOK_PACKAGE_ID: packageId,
		REGISTRY_ID: registryId,
		DEEP_TREASURY_ID: deployment?.deepTreasuryId ?? '',
		MARGIN_PACKAGE_ID: deployment?.marginPackageId,
		MARGIN_REGISTRY_ID: deployment?.marginRegistryId,
		LIQUIDATION_PACKAGE_ID: deployment?.liquidationPackageId,
	};

	const staticPools = opts.pools ?? [];
	const fakeDeepbookPools: Record<string, DeepbookPool> = {};
	for (const p of staticPools) {
		fakeDeepbookPools[p.name] = {
			name: p.name,
			poolId: p.poolId,
			base: p.baseType,
			quote: p.quoteType,
			// Tick/lot/min not known from the registry — known-package
			// consumers carry these themselves (e.g. inside
			// `deepbookMarketMaker.pools[]`).
			tickSize: 0n,
			lotSize: 0n,
			minSize: 0n,
		};
	}
	const poolIds = new Map<string, string>(staticPools.map((p) => [p.name, p.poolId]));
	const findPool = makeFindPool('deepbookKnownPackage', fakeDeepbookPools);

	const { __layer, key, __kind, __displayTitle } = provideTag(
		DeepbookCore,
		Effect.gen(function* () {
			yield* Effect.annotateCurrentSpan({
				'deepbook.packageId': packageId,
				'deepbook.registryId': registryId,
				'deepbook.poolCount': staticPools.length,
			});
			return {
				packageId,
				registryId,
				packageIds,
				poolIds,
				findPool,
			} satisfies DeepbookCoreShape;
		}).pipe(Effect.withSpan('deepbookKnownPackage')),
		{
			kind: 'service',
			displayTitle: 'deepbook.known',
			display: (s) => ({ title: 'deepbook.known', primary: s.packageId }),
		},
	);
	return { __layer, key, __kind, __displayTitle };
};

// -----------------------------------------------------------------------------
// deepbookMarketMaker(opts) — consumer
// -----------------------------------------------------------------------------

export interface DeepbookMarketMakerPoolSpec<
	Base extends string | AnyCoinTag = string | AnyCoinTag,
	Quote extends string | AnyCoinTag = string | AnyCoinTag,
> {
	readonly name: string;
	/** Move type or coin tag for the base asset. Tag form resolved before
	 *  the first tick — yielding the tag here also pins it as a dependency
	 *  edge in the layer graph. */
	readonly base: Base;
	readonly quote: Quote;
	readonly tickSize: bigint;
	/** Mid price in the pool's quote units (same scale as `tickSize`).
	 *  Each tick reposts a POST_ONLY grid centred here. */
	readonly midPrice: bigint;
	/** Order size per level in BASE units. */
	readonly sizePerLevel: bigint;
	/** Optional per-pool predeposit override. Without an override the maker
	 *  deposits `100 * sizePerLevel` base + the quote-equivalent at
	 *  `midPrice`. */
	readonly preDeposit?: { readonly base: bigint; readonly quote: bigint };
}

export interface DeepbookMarketMakerHandle {
	/** Always 0 — the maker runs as an in-process Effect fiber rather
	 *  than an OS subprocess, so there's no real pid. Kept for shape
	 *  parity with the v3 plugin / future hostProcess variant. */
	readonly pid: number;
}

export interface DeepbookMarketMakerOptions<Name extends string> {
	readonly name: Name;
	readonly signer: PluginTag<any, Account, any, any>;
	readonly pools: ReadonlyArray<DeepbookMarketMakerPoolSpec>;
	/** Levels per side. Default 3 (so 6 orders per pool per tick). */
	readonly levels?: number;
	/** Distance between adjacent levels in `tickSize` units. Default 1. */
	readonly tickSpacing?: number;
	/** Refresh cadence in ms. Default 10_000 (10 s). */
	readonly refreshMs?: number;
	readonly dependsOn?: ReadonlyArray<PluginTag<any, any, any, any>>;
}

/**
 * Long-running grid market-maker. Composes against `DeepbookCore`
 * regardless of which factory provided it (local-deploy or
 * known-package), then forks a refresh loop into the surrounding scope.
 */
export const deepbookMarketMaker = <const Name extends string>(
	options: DeepbookMarketMakerOptions<Name>,
) =>
	makeTag(
		options.name,
		Effect.gen(function* () {
			for (const tag of options.dependsOn ?? []) {
				yield* tag;
			}
			yield* Sui;
			const signer = yield* options.signer;
			const core = yield* DeepbookCore;

			const levels = options.levels ?? 3;
			const tickSpacing = options.tickSpacing ?? 1;
			const refreshMs = options.refreshMs ?? 10_000;

			if (options.pools.length === 0) {
				return yield* Effect.fail(
					new DeepbookError({
						phase: 'market-maker-tick',
						message: `deepbookMarketMaker(${options.name}): \`pools\` cannot be empty`,
					}),
				);
			}

			// Resolve coin-tag refs up-front so the inner tick loop runs
			// against plain Move-type strings. Yielding the tags here also
			// pins them as dependency edges in the layer graph.
			const quotedPools = yield* Effect.gen(function* () {
				const out: Array<{
					readonly spec: DeepbookMarketMakerPoolSpec;
					readonly pool: DeepbookPoolRef;
				}> = [];
				for (const spec of options.pools) {
					const base = yield* resolveCoinRef(spec.base);
					const quote = yield* resolveCoinRef(spec.quote);
					const pool = yield* core.findPool({ base, quote });
					out.push({ spec, pool });
				}
				return out;
			});

			// BalanceManager id is minted on the first tick (matches v3's
			// behavior); subsequent ticks reuse it. Mutable closure state
			// rather than a Ref since the fiber is single-threaded and we
			// don't read it from outside the loop.
			let balanceManagerId: string | undefined;

			const tickOnce = Effect.gen(function* () {
				const creating = balanceManagerId === undefined;
				const t = new Transaction();
				t.setGasBudget(2_000_000_000n);

				let bm: TransactionObjectArgument;
				if (creating) {
					bm = t.moveCall({
						target: `${core.packageId}::balance_manager::new`,
						arguments: [],
					});
					depositPreDeposits({
						t,
						bm,
						packageId: core.packageId,
						quotedPools,
					});
				} else {
					bm = t.object(balanceManagerId!);
				}

				const proof = t.moveCall({
					target: `${core.packageId}::balance_manager::generate_proof_as_owner`,
					arguments: [bm],
				});

				const expireMs = BigInt(Date.now() + 24 * 60 * 60 * 1000);
				let clientOrderId = Math.floor(Date.now() / 1000);

				for (const { spec, pool } of quotedPools) {
					if (!creating) {
						t.moveCall({
							target: `${core.packageId}::pool::cancel_all_orders`,
							typeArguments: [pool.baseType, pool.quoteType],
							arguments: [t.object(pool.poolId), bm, proof, t.object(SUI_CLOCK_OBJECT_ID)],
						});
					}

					const mid = spec.midPrice;
					const sizeBase = spec.sizePerLevel;
					const tickSize = spec.tickSize;

					for (let i = 1; i <= levels; i++) {
						for (const isBid of [true, false] as const) {
							const offset = tickSize * BigInt(i * tickSpacing);
							const price = isBid ? mid - offset : mid + offset;
							if (price <= 0n) continue;
							t.moveCall({
								target: `${core.packageId}::pool::place_limit_order`,
								typeArguments: [pool.baseType, pool.quoteType],
								arguments: [
									t.object(pool.poolId),
									bm,
									proof,
									t.pure.u64(BigInt(clientOrderId++)),
									t.pure.u8(ORDER_TYPE_POST_ONLY),
									t.pure.u8(SELF_MATCHING_ALLOWED),
									t.pure.u64(price),
									t.pure.u64(sizeBase),
									t.pure.bool(isBid),
									// pay_with_deep — whitelisted pool waives DEEP fees.
									t.pure.bool(false),
									t.pure.u64(expireMs),
									t.object(SUI_CLOCK_OBJECT_ID),
								],
							});
						}
					}
				}

				if (creating) {
					t.transferObjects([bm], signer.address);
				}

				const result = yield* signer.signAndExecute(t).pipe(
					Effect.mapError(
						(cause) =>
							new DeepbookError({
								phase: 'market-maker-tick',
								message: `deepbookMarketMaker(${options.name}): tick tx failed: ${cause.message}`,
								cause,
							}),
					),
				);

				if (creating) {
					const bmType = `${core.packageId}::balance_manager::BalanceManager`;
					const bmObj = result.objectChanges.find(
						(c): c is Extract<SuiObjectChange, { type: 'created' }> =>
							c.type === 'created' && 'objectType' in c && c.objectType === bmType,
					);
					if (bmObj === undefined) {
						return yield* Effect.fail(
							new DeepbookError({
								phase: 'market-maker-tick',
								message:
									`deepbookMarketMaker(${options.name}): BalanceManager id missing ` +
									`from objectChanges after creation tick`,
							}),
						);
					}
					balanceManagerId = bmObj.objectId;
				}
			}).pipe(Effect.withSpan('deepbookMarketMaker.tick'));

			// Transient failures (a single bad tx, a temporarily-unreachable
			// RPC) shouldn't kill the maker — log + continue on the next
			// schedule tick. The fiber only exits when the surrounding scope
			// closes.
			const loopOnce = tickOnce.pipe(
				Effect.catch((cause: unknown) =>
					Effect.logWarning(
						`deepbookMarketMaker(${options.name}): tick failed: ${stringifyCause(cause)}`,
					),
				),
			);

			// First tick runs synchronously inside the producer so a
			// configuration error (bad pool ref) surfaces as a startup failure
			// rather than a silent skipped loop. Matches v3's `await fire()`
			// before kicking off setInterval.
			yield* tickOnce.pipe(
				Effect.mapError(
					(cause) =>
						new DeepbookError({
							phase: 'market-maker-tick',
							message: `deepbookMarketMaker(${options.name}): initial tick failed: ${cause.message}`,
							cause,
						}),
				),
			);

			yield* Effect.forkScoped(loopOnce.pipe(Effect.repeat(Schedule.spaced(refreshMs))));

			return { pid: 0 } satisfies DeepbookMarketMakerHandle;
		}).pipe(
			Effect.withSpan(`deepbookMarketMaker(${options.name})`),
			Effect.catchTag('DeepbookError', Effect.fail),
			Effect.catch((cause: unknown) =>
				Effect.fail(
					new DeepbookError({
						phase: 'deepbookMarketMaker',
						message: `deepbookMarketMaker(${options.name}): ${stringifyCause(cause)}`,
						cause,
					}),
				),
			),
		),
		{
			kind: 'service',
			displayTitle: `deepbook.${options.name}`,
			display: () => ({
				title: `deepbook.${options.name}`,
				primary: `${options.pools.length} pool${options.pools.length === 1 ? '' : 's'}`,
			}),
		},
	);

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

interface DepositArgs {
	readonly t: Transaction;
	readonly bm: TransactionObjectArgument;
	readonly packageId: string;
	readonly quotedPools: ReadonlyArray<{
		readonly spec: DeepbookMarketMakerPoolSpec;
		readonly pool: DeepbookPoolRef;
	}>;
}

// Sum required base/quote deposits across pools, then issue one
// `balance_manager::deposit<T>` per coin type. v3's `useGasCoin: true`
// trick on SUI deposits is preserved — without it the SDK's coin
// resolver consumes every owned SUI coin as a deposit source and the
// gas-coin selector fails with "No valid gas coins found".
function depositPreDeposits(args: DepositArgs): void {
	const { t, bm, packageId, quotedPools } = args;

	const totalsByCoinType = new Map<string, bigint>();
	for (const { spec, pool } of quotedPools) {
		const sizeBase = spec.sizePerLevel;
		const mid = spec.midPrice;
		const explicit = spec.preDeposit;
		const baseAmount = explicit?.base ?? DEFAULT_PREDEPOSIT_MULTIPLIER * sizeBase;
		const quoteAmount =
			explicit?.quote ?? (DEFAULT_PREDEPOSIT_MULTIPLIER * sizeBase * mid) / 1_000_000_000n + 1n;
		totalsByCoinType.set(
			pool.baseType,
			(totalsByCoinType.get(pool.baseType) ?? 0n) + baseAmount,
		);
		totalsByCoinType.set(
			pool.quoteType,
			(totalsByCoinType.get(pool.quoteType) ?? 0n) + quoteAmount,
		);
	}

	for (const [coinType, amount] of totalsByCoinType) {
		const coin = t.coin({ balance: amount, type: coinType, useGasCoin: true });
		t.moveCall({
			target: `${packageId}::balance_manager::deposit`,
			typeArguments: [coinType],
			arguments: [bm, coin],
		});
	}
}

// Tag refs are duck-typed: a tag is yieldable inside `Effect.gen`, a
// literal Move-type string isn't. The structural `fullCoinType: string`
// constraint is enforced at the call-site type — once we're inside the
// body the value is opaque, so we trust the constraint and read the
// field directly.
const resolveCoinRef = (ref: string | AnyCoinTag) =>
	Effect.gen(function* () {
		if (typeof ref === 'string') return ref;
		const coin = (yield* ref) as { readonly fullCoinType: string };
		return coin.fullCoinType;
	});

// Build a `findPool` closure against a known pool table. Used by both
// local-deploy (table populated post-publish) and known-package (table
// populated from the caller's static config).
const makeFindPool = (
	factoryName: string,
	pools: Record<string, DeepbookPool>,
): DeepbookCoreShape['findPool'] => {
	const byBaseQuote = new Map<string, DeepbookPoolRef>();
	for (const p of Object.values(pools)) {
		byBaseQuote.set(`${p.base}|${p.quote}`, {
			poolId: p.poolId,
			baseType: p.base,
			quoteType: p.quote,
		});
	}
	return (opts) =>
		Effect.gen(function* () {
			const hit = byBaseQuote.get(`${opts.base}|${opts.quote}`);
			if (hit !== undefined) return hit;
			return yield* Effect.fail(
				new DeepbookError({
					phase: 'market-maker-tick',
					message:
						`${factoryName}: pool not declared for base=${opts.base} ` +
						`quote=${opts.quote}. Add it to the factory's \`pools\` option.`,
				}),
			);
		});
};

