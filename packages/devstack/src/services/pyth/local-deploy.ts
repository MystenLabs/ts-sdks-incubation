// `pythLocalDeploy(opts)` — publish a vendored Pyth Move package +
// create one `PriceInfoObject` per requested feed. State-store cache at
// `pyth/package/<chainId>/<pythPackageId>/<feedsHash>` short-circuits
// the create-feeds tx on resume; cache hits verify each PriceInfoObject's
// objectType matches `<pythPackageId>::price_info::PriceInfoObject`
// before trusting.

/* eslint-disable @typescript-eslint/no-explicit-any */

import * as crypto from 'node:crypto';
import { Effect, Option } from 'effect';
import { Transaction } from '@mysten/sui/transactions';
import { tag, provide, type LayeredTag } from '../../advanced/tag.js';
import { SuiTag } from '../sui.js';
import { publishMove } from '../package/internal.js';
import { moveTypeEquals, pickCreatedByType } from '../../engine/sui-helpers.js';
import { publishPackage, publishPythState, type PythStateRecord } from '../../engine/registries.js';
import { StateStore } from '../../engine/state-store.js';
import { StateStoreKeys } from '../../engine/state-store-keys.js';
import { stringifyCause } from '../../engine/stringify-cause.js';
import { PythError } from '../../engine/errors.js';
import { PythTag, type PythPriceInfo, type Pyth } from './tag.js';
import type { Account } from '../../engine/shared.js';
import {
	PRICE_INFO_OBJECT_TYPE_SUFFIX,
	addPriceInfo,
	type PythPriceFeedId,
	type PythPriceInfoSpec,
} from './shared.js';

// State-store key prefix for pyth-package moved to
// `engine/state-store-keys.ts`. Canonical builder:
// `StateStoreKeys.pythPackage({chainId, packageId, feedsHash})`. The
// prefix is also re-exported below as `STATE_KEY_PYTH_PREFIX_INTERNAL`
// for the pyth tests that lock the on-disk shape.
const STATE_KEY_PYTH_PREFIX = 'pyth/package';

interface CachedPythPriceInfo {
	readonly feedId: PythPriceFeedId;
	readonly priceInfoObjectId: string;
	readonly label: string;
}
interface CachedPyth {
	readonly packageId: string;
	readonly pythStateId: string | undefined;
	readonly wormholeStateId: string | undefined;
	readonly priceInfos: ReadonlyArray<CachedPythPriceInfo>;
}

const PYTH_STATE_TYPE_SUFFIX = '::state::State';
const WORMHOLE_STATE_TYPE_SUFFIX = '::wormhole_state::WormholeState';

// Stable hash over the requested feed specs so a different set of
// requested feeds invalidates the cache.
const hashFeedSpecs = (specs: ReadonlyArray<PythLocalDeployFeedSpec>): string => {
	const canonical = specs
		.slice()
		.sort((a, b) => (a.label < b.label ? -1 : 1))
		.map((s) => ({
			label: s.label,
			feedId: s.feedId,
			price: s.initial.priceMagnitude.toString(),
			expo: s.initial.expoMagnitude.toString(),
			publishTime: s.initial.publishTime.toString(),
		}));
	return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);
};

export interface PythLocalDeployFeedSpec {
	/** Friendly label like `'SUI'`, `'DEEP'`. Used as a registry key
	 *  + as the cached `priceInfos[].label`. */
	readonly label: string;
	readonly feedId: PythPriceFeedId;
	readonly initial: PythPriceInfoSpec;
}

export interface PythLocalDeployOptions<Name extends string> {
	readonly name?: Name;
	readonly signer: LayeredTag<any, Account, any, any>;
	/** Filesystem path to a vendored Pyth Move package. */
	readonly movePackagePath?: string;
	/** Alternative: pull from a `vendorDeepbook(...)` Ref. Reads
	 *  `(yield* vendor).pyth` instead. Mutually exclusive with
	 *  `movePackagePath`. */
	readonly vendor?: LayeredTag<any, { readonly pyth: string }, any, any>;
	/** Feed specs to bootstrap with `create_price_feeds`. */
	readonly feeds: ReadonlyArray<PythLocalDeployFeedSpec>;
	readonly dependsOn?: ReadonlyArray<LayeredTag<any, any, any, any>>;
}

const CLOCK_OBJECT_ID = '0x6';

export const pythLocalDeploy = <const Name extends string = 'pyth'>(
	opts: PythLocalDeployOptions<Name>,
) => {
	const name = (opts.name ?? 'pyth') as Name;

	if (opts.movePackagePath !== undefined && opts.vendor !== undefined) {
		throw new TypeError(
			`pythLocalDeploy: \`movePackagePath\` and \`vendor\` are mutually exclusive`,
		);
	}
	if (opts.feeds.length === 0) {
		throw new TypeError(`pythLocalDeploy: \`feeds\` must be non-empty`);
	}

	// publishMove accepts either a literal path or an `Effect<string>`
	// that resolves it at acquire time. The vendor path threads through
	// the latter — yield the vendor tag inside the path effect, read the
	// resolved `.pyth` subpath. Folds into the publishMove cache key the
	// same way a literal path would (the resolved path participates in
	// `sourceHash` / `chainId`).
	const publishPath: string | Effect.Effect<string, never, any> | undefined =
		opts.movePackagePath !== undefined
			? opts.movePackagePath
			: opts.vendor !== undefined
				? Effect.gen(function* () {
						const vendor = yield* opts.vendor!;
						return vendor.pyth;
					})
				: undefined;

	const publish =
		publishPath !== undefined
			? publishMove({
					name: `${name}.publish` as const,
					path: publishPath,
					signer: opts.signer,
					capture: (changes) => {
						const pythStateId = pickCreatedByType(changes, { suffix: PYTH_STATE_TYPE_SUFFIX });
						const wormholeStateId = pickCreatedByType(changes, {
							suffix: WORMHOLE_STATE_TYPE_SUFFIX,
						});
						return { pythStateId, wormholeStateId };
					},
				})
			: undefined;

	const composite = tag(
		name,
		Effect.gen(function* () {
			for (const dep of opts.dependsOn ?? []) {
				yield* dep;
			}
			const sui = yield* SuiTag;
			const signer = yield* opts.signer;
			const state = yield* StateStore;

			if (publish === undefined) {
				return yield* Effect.fail(
					new PythError({
						phase: 'publish',
						message:
							`pythLocalDeploy(${name}): either \`movePackagePath\` or \`vendor\` ` +
							`is required to publish the Pyth Move package.`,
					}),
				);
			}

			const pkg = yield* Effect.gen(function* () {
				return yield* publish;
			}).pipe(Effect.withSpan('PythPublish'));

			const packageId = pkg.packageId;
			const pythStateId = pkg.captured?.pythStateId as string | undefined;
			const wormholeStateId = pkg.captured?.wormholeStateId as string | undefined;

			const feedsHash = hashFeedSpecs(opts.feeds);
			const cacheKey = StateStoreKeys.pythPackage({
				chainId: sui.chainId,
				packageId,
				feedsHash,
			});
			const cached = yield* state.get<CachedPyth>(cacheKey);

			const verifyOnChain = (
				candidate: string,
				expectedType: string,
			): Effect.Effect<boolean, never> =>
				Effect.tryPromise({
					try: () => sui.client.core.getObject({ objectId: candidate }),
					catch: (cause) => cause,
				}).pipe(
					Effect.map((res) => {
						const t = (res as unknown as { objectType?: unknown }).objectType;
						return typeof t === 'string' && t === expectedType;
					}),
					Effect.orElseSucceed(() => false),
				);

			let priceInfos: Array<PythPriceInfo> = [];
			let resumed = false;
			if (Option.isSome(cached)) {
				const expectedType = `${packageId}${PRICE_INFO_OBJECT_TYPE_SUFFIX}`;
				let allValid = true;
				for (const p of cached.value.priceInfos) {
					const ok = yield* verifyOnChain(p.priceInfoObjectId, expectedType);
					if (!ok) {
						allValid = false;
						break;
					}
				}
				if (allValid) {
					yield* Effect.logInfo(
						`pythLocalDeploy(${name}): cache hit — chainId=${sui.chainId} packageId=${packageId} (${cached.value.priceInfos.length} feeds)`,
					);
					yield* Effect.annotateCurrentSpan({
						'pyth.cache': 'hit',
						'pyth.feedCount': cached.value.priceInfos.length,
					});
					priceInfos = cached.value.priceInfos.map((p) => ({
						label: p.label,
						feedId: p.feedId,
						priceInfoObjectId: p.priceInfoObjectId,
					}));
					resumed = true;
				} else {
					yield* Effect.logInfo(
						`pythLocalDeploy(${name}): cache hit but PriceInfoObjects missing/wrong-type on chain — invalidating`,
					);
					yield* Effect.annotateCurrentSpan({ 'pyth.cache': 'stale' });
					yield* state.remove(cacheKey).pipe(Effect.ignore);
				}
			}

			if (!resumed) {
				if (pythStateId === undefined) {
					return yield* Effect.fail(
						new PythError({
							phase: 'publish',
							message:
								`pythLocalDeploy(${name}): publish did not capture a Pyth State id ` +
								`(no object of type ${packageId}${PYTH_STATE_TYPE_SUFFIX}). The vendored ` +
								`Pyth Move package may not initialize the state object on publish.`,
						}),
					);
				}
				yield* Effect.annotateCurrentSpan({ 'pyth.cache': 'miss' });
				const t = new Transaction();
				t.setGasBudget(500_000_000n);
				for (const feed of opts.feeds) {
					addPriceInfo(t, packageId, pythStateId, CLOCK_OBJECT_ID, feed.initial);
				}
				const result = yield* signer.signAndExecute(t).pipe(
					Effect.mapError(
						(cause) =>
							new PythError({
								phase: 'create-feeds',
								message: `pythLocalDeploy(${name}): create-feeds tx failed: ${cause.message}`,
								cause,
							}),
					),
				);

				// One PriceInfoObject per feed. We can't distinguish them by
				// type alone — they all share `<pythPackageId>::price_info::PriceInfoObject`
				// — so match by the order of creation in the tx (deterministic
				// per-feed sequence).
				const expectedType = `${packageId}${PRICE_INFO_OBJECT_TYPE_SUFFIX}`;
				const createdIds = result.objectChanges
					.filter(
						(c): c is Extract<typeof c, { type: 'created' }> =>
							c.type === 'created' &&
							'objectType' in c &&
							typeof c.objectType === 'string' &&
							moveTypeEquals(c.objectType, expectedType),
					)
					.map((c) => c.objectId);
				if (createdIds.length < opts.feeds.length) {
					return yield* Effect.fail(
						new PythError({
							phase: 'create-feeds',
							message:
								`pythLocalDeploy(${name}): expected ${opts.feeds.length} PriceInfoObjects ` +
								`from objectChanges, got ${createdIds.length}`,
						}),
					);
				}
				priceInfos = opts.feeds.map((feed, i) => ({
					label: feed.label,
					feedId: feed.feedId,
					priceInfoObjectId: createdIds[i]!,
				}));

				const toCache: CachedPyth = {
					packageId,
					pythStateId,
					wormholeStateId,
					priceInfos: priceInfos.map((p) => ({
						label: p.label,
						feedId: p.feedId,
						priceInfoObjectId: p.priceInfoObjectId,
					})),
				};
				yield* state.put(cacheKey, toCache);
			}

			yield* publishPackage({
				name,
				packageId,
				upgradeCapId: pkg.upgradeCapId,
				captured: { pythStateId, wormholeStateId },
			});

			const priceInfoObjectIds: Record<string, string> = {};
			const feedsByLabel: Record<string, PythPriceFeedId> = {};
			for (const p of priceInfos) {
				priceInfoObjectIds[p.feedId] = p.priceInfoObjectId;
				feedsByLabel[p.label] = p.feedId;
			}
			yield* publishPythState({
				name,
				packageId,
				...(pythStateId !== undefined ? { pythStateId } : {}),
				...(wormholeStateId !== undefined ? { wormholeStateId } : {}),
				priceInfoObjectIds,
				feeds: feedsByLabel,
			} satisfies PythStateRecord);

			const findPriceInfo = (feed: PythPriceFeedId): PythPriceInfo | undefined => {
				return priceInfos.find((p) => p.feedId === feed);
			};

			const findPriceInfoByLabel = (label: string): PythPriceInfo | undefined => {
				return priceInfos.find((p) => p.label === label);
			};

			return {
				packageId,
				pythStateId,
				wormholeStateId,
				priceInfos,
				findPriceInfo,
				findPriceInfoByLabel,
			} satisfies Pyth;
		}).pipe(
			Effect.withSpan(`PythLocalDeploy(${name})`),
			Effect.catchTag('PythError', Effect.fail),
			Effect.catch((cause: unknown) =>
				Effect.fail(
					new PythError({
						phase: 'pyth',
						message: `pythLocalDeploy(${name}): ${stringifyCause(cause)}`,
						cause,
					}),
				),
			),
		),
		{
			...(publish !== undefined ? { extraLayers: [publish.__layer] } : {}),
			kind: 'service' as const,
			plugin: 'pyth',
			displayTitle: `pyth.${name}`,
			display: (s: Pyth) => ({
				title: `pyth.${name}`,
				primary: s.packageId,
				extras: [`${s.priceInfos.length} feed${s.priceInfos.length === 1 ? '' : 's'}`],
			}),
			// Yields SuiTag, the signer Account ref, the publishMove tag,
			// and iterates `dependsOn`. Lift them all into upstreams.
			// When
			// `opts.vendor` is set, the publishMove `path:` Effect yields
			// the vendor tag too — lift it so the topo scheduler orders
			// the vendor build before the publish runs.
			upstreamKeys: [
				SuiTag.key,
				opts.signer,
				...(publish !== undefined ? [publish] : []),
				...(opts.vendor !== undefined ? [opts.vendor] : []),
				...(opts.dependsOn ?? []),
			],
		},
	);

	const tagLayer = provide(
		PythTag,
		Effect.gen(function* () {
			return yield* composite;
		}),
	).__layer;

	const __layers: ReadonlyArray<any> = [...composite.__layers, tagLayer];
	return Object.assign(composite, { __layers });
};

export const STATE_KEY_PYTH_PREFIX_INTERNAL = STATE_KEY_PYTH_PREFIX;
