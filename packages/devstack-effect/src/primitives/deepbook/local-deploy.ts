// `deepbookLocalDeploy(opts)` — publish the deepbook-v3 Move package +
// create the requested whitelisted pools. Provides all three interface
// tags (`DeepbookCore`, `DeepbookAdmin`, `DeepbookMarketMaker`) because
// the local deploy owns the admin cap and can mint a BalanceManager.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Effect, Layer } from 'effect';
import { Transaction } from '@mysten/sui/transactions';
import { makeTag, provideTag, type PluginTag } from '../../tag.js';
import { Sui } from '../sui.js';
import { publishMove, pickCreatedByTypeSuffix } from '../publish-move.js';
import { PackageRegistry } from '../../internal/registries.js';
import { stringifyCause } from '../../internal/stringify-cause.js';
import { DeepbookError } from '../errors.js';
import {
	DeepbookAdmin,
	DeepbookCore,
	DeepbookMarketMaker as DeepbookMarketMakerTag,
	type DeepbookCoreShape,
} from '../../interfaces/deepbook.js';
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
