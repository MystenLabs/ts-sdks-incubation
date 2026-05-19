// `pythLocalDeploy(opts)` — publish a vendored Pyth Move package +
// create one `PriceInfoObject` per requested feed. Migrated to the
// canonical `onChainArtifact` substrate per `notes/integration-contract-
// redesign.md`: cache key resolves to
// `pyth/package/<chainId>/<contentHash(packageId, feedsHash)>`, the verify
// probe goes through the typed `ChainProbe` accessor (Schema-validated
// SDK response shape), and `register` runs on every cycle so PackageRegistry
// + PythStateRegistry stay populated on resume.

/* eslint-disable @typescript-eslint/no-explicit-any */

import * as crypto from 'node:crypto';
import { Effect } from 'effect';
import { Transaction } from '@mysten/sui/transactions';
import { provide, type LayeredTag } from '../../advanced/tag.js';
import { publishMove, type Package } from '../package/internal.js';
import { onChainArtifact } from '../../engine/on-chain-artifact.js';
import { moveTypeEquals, pickCreatedByType } from '../../engine/sui-helpers.js';
import { publishPackage, publishPythState, type PythStateRecord } from '../../engine/registries.js';
import { PythError } from '../../engine/errors.js';
import { PythTag, type PythPriceInfo, type Pyth } from './tag.js';
import type { Account } from '../../engine/shared.js';
import {
	PRICE_INFO_OBJECT_TYPE_SUFFIX,
	addPriceInfo,
	type PythPriceFeedId,
	type PythPriceInfoSpec,
} from './shared.js';

// State-store key prefix for pyth-package. Canonical builder is
// `StateStoreKeys.pythPackage({chainId, packageId, feedsHash})`. The
// prefix is re-exported below as `STATE_KEY_PYTH_PREFIX_INTERNAL` for the
// pyth tests that lock the on-disk shape. With `onChainArtifact` the
// actual cache key is `pyth/package/<chainId>/<contentHash(inputs)>` —
// the namespace stays `'pyth/package'` (bare, no version segment) per
// the §8.5 cache-shape rules in the redesign doc.
const STATE_KEY_PYTH_PREFIX = 'pyth/package';

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

interface CachedPythPriceInfo {
	readonly feedId: PythPriceFeedId;
	readonly priceInfoObjectId: string;
	readonly label: string;
}

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

type CapturedPyth = {
	readonly pythStateId: string | undefined;
	readonly wormholeStateId: string | undefined;
};

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

	const publish: LayeredTag<any, Package<CapturedPyth>, any, any> | undefined =
		publishPath !== undefined
			? (publishMove({
					name: `${name}.publish` as const,
					path: publishPath,
					signer: opts.signer,
					capture: (changes): CapturedPyth => {
						const pythStateId = pickCreatedByType(changes, { suffix: PYTH_STATE_TYPE_SUFFIX });
						const wormholeStateId = pickCreatedByType(changes, {
							suffix: WORMHOLE_STATE_TYPE_SUFFIX,
						});
						return { pythStateId, wormholeStateId };
					},
				}) as LayeredTag<any, Package<CapturedPyth>, any, any>)
			: undefined;

	// dependsOn is folded into the upstream record under stable aliases.
	// The substrate auto-flattens `upstream` into the resulting tag's
	// `__upstreamKeys` so the topo scheduler orders dependencies before
	// this primitive — declaring them all up here in one record is the
	// single source of truth (per the redesign's §3.1 "the dep
	// declaration IS the dep graph").
	const dependsOnRecord: Record<string, LayeredTag<any, any, any, any>> = {};
	(opts.dependsOn ?? []).forEach((dep, i) => {
		dependsOnRecord[`dependsOn_${i}`] = dep;
	});

	const composite = onChainArtifact({
		name,
		kind: 'service' as const,
		plugin: 'pyth',
		displayTitle: `pyth.${name}`,
		display: (s: Pyth) => ({
			title: `pyth.${name}`,
			primary: s.packageId,
			extras: [`${s.priceInfos.length} feed${s.priceInfos.length === 1 ? '' : 's'}`],
		}),

		// `signer` + the publishMove sibling are real upstreams. `vendor`
		// is included whenever set so the topo scheduler orders the vendor
		// gitFetch before publishMove's `path:` Effect resolves it.
		// `dependsOn` entries flatten in under generated aliases.
		upstream: {
			signer: opts.signer,
			publish,
			...(opts.vendor !== undefined ? { vendor: opts.vendor } : {}),
			...dependsOnRecord,
		},

		namespace: STATE_KEY_PYTH_PREFIX,
		label: `pythLocalDeploy(${name})`,

		// Canonical hashable inputs. Folds packageId (from the resolved
		// publish) + the feedSpecs hash, so a re-publish or a different
		// requested feed set invalidates the cache.
		//
		// `publish === undefined` (no `movePackagePath` AND no `vendor`)
		// surfaces here as a clean PythError — the factory body itself
		// must construct successfully (per the existing
		// "delegated to runtime" test contract) but the build fails at
		// acquire time.
		inputs: ({ publish: pkg }) =>
			Effect.gen(function* () {
				if (pkg === undefined) {
					return yield* Effect.fail(
						new PythError({
							phase: 'publish',
							message:
								`pythLocalDeploy(${name}): either \`movePackagePath\` or \`vendor\` ` +
								`is required to publish the Pyth Move package.`,
						}),
					);
				}
				return {
					packageId: pkg.packageId,
					feedsHash: hashFeedSpecs(opts.feeds),
				};
			}),

		// §4.2 verify probe: every cached PriceInfoObject id must still
		// resolve on chain AND its `type` must match
		// `<packageId>::price_info::PriceInfoObject`. `ChainProbe` does the
		// schema-validated read; a transient RPC failure surfaces as
		// `undefined` for that object (and the cache invalidates). Per
		// RS2 we probe STABLE identifiers — the priceInfoObjectIds came
		// straight from the produce body's objectChanges.
		verify: ({ cached, chain }) =>
			Effect.gen(function* () {
				const expectedType = `${cached.packageId}${PRICE_INFO_OBJECT_TYPE_SUFFIX}`;
				const ok = yield* chain.objectsMatchTypes(
					cached.priceInfos.map((p) => ({
						objectId: p.priceInfoObjectId,
						expectedType,
					})),
					moveTypeEquals,
				);
				return ok ? cached : undefined;
			}),

		// Fresh-create body — runs only on cache miss / verify-fail.
		// Resolves the publish package (guaranteed non-undefined here:
		// `inputs` already failed for the no-publish case before the cache
		// look-up), then builds one batched `create_price_feeds` tx.
		produce: ({ publish: pkg, signer }) =>
			Effect.gen(function* () {
				if (pkg === undefined) {
					// Unreachable in practice — `inputs` fails first. Kept
					// for type narrowing.
					return yield* Effect.fail(
						new PythError({
							phase: 'publish',
							message: `pythLocalDeploy(${name}): publish is required`,
						}),
					);
				}
				const packageId = pkg.packageId;
				const pythStateId = pkg.captured?.pythStateId;
				const wormholeStateId = pkg.captured?.wormholeStateId;

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
				const priceInfos: ReadonlyArray<CachedPythPriceInfo> = opts.feeds.map((feed, i) => ({
					label: feed.label,
					feedId: feed.feedId,
					priceInfoObjectId: createdIds[i]!,
				}));

				// Returned shape is `Pyth`-typed so the resulting LayeredTag's
				// resolved value satisfies the `Pyth` interface (PythPusher /
				// pythMid consumers `yield* opts.pyth` and read
				// `findPriceInfo`). The lookup methods are reattached in
				// `register` — on a cache miss they ride along here too, on
				// a cache hit they're attached after `state.get` rehydrates
				// the JSON-serializable subset.
				const fresh: Pyth = {
					packageId,
					pythStateId,
					wormholeStateId,
					priceInfos: priceInfos.map((p) => ({
						label: p.label,
						feedId: p.feedId,
						priceInfoObjectId: p.priceInfoObjectId,
					})),
					findPriceInfo: (feed) => priceInfos.find((p) => p.feedId === feed),
					findPriceInfoByLabel: (label) => priceInfos.find((p) => p.label === label),
				};
				return fresh;
			}),

		// `register` runs on EVERY cycle (hit AND miss) AFTER the value
		// resolves but BEFORE downstream consumers see it. Two roles:
		//
		//   1. Re-attach `findPriceInfo` / `findPriceInfoByLabel` methods
		//      onto `value`. The cached payload (`CachedPyth`) is plain
		//      data so it can JSON-roundtrip cleanly; the consumer-facing
		//      `Pyth` shape carries lookup methods. We mutate in place
		//      because the substrate returns `value` after `register`
		//      runs (per `onChainArtifact`'s contract), so this is the
		//      single point where the cache-hit and cache-miss paths
		//      converge on the same observable shape — matches
		//      `publishMove`'s host-local-field-mutation pattern.
		//   2. Re-publish the package to PackageRegistry + per-feed
		//      PriceInfoObjects to PythStateRegistry, so resume + cold
		//      start are observably identical from the consumer side
		//      (registries live in-memory per supervisor cycle).
		register: ({ value }) =>
			Effect.gen(function* () {
				const findPriceInfo = (feed: PythPriceFeedId): PythPriceInfo | undefined =>
					value.priceInfos.find((p) => p.feedId === feed);
				const findPriceInfoByLabel = (label: string): PythPriceInfo | undefined =>
					value.priceInfos.find((p) => p.label === label);
				(value as unknown as { findPriceInfo: typeof findPriceInfo }).findPriceInfo =
					findPriceInfo;
				(
					value as unknown as { findPriceInfoByLabel: typeof findPriceInfoByLabel }
				).findPriceInfoByLabel = findPriceInfoByLabel;

				const priceInfoObjectIds: Record<string, string> = {};
				const feedsByLabel: Record<string, PythPriceFeedId> = {};
				for (const p of value.priceInfos) {
					priceInfoObjectIds[p.feedId] = p.priceInfoObjectId;
					feedsByLabel[p.label] = p.feedId;
				}
				// The publishMove sibling already published itself to the
				// PackageRegistry during its own `register` step — we
				// re-publish here under the pyth name so a status query
				// targeting `name` (the friendly name in the user's stack
				// file) resolves to the same packageId. We don't carry
				// `upgradeCapId` in our cache payload — the publishMove
				// sibling's own publishPackage already carries it under
				// `${name}.publish` for that exact use case.
				yield* publishPackage({
					name,
					packageId: value.packageId,
					upgradeCapId: undefined,
					captured: {
						pythStateId: value.pythStateId,
						wormholeStateId: value.wormholeStateId,
					},
				});
				yield* publishPythState({
					name,
					packageId: value.packageId,
					...(value.pythStateId !== undefined ? { pythStateId: value.pythStateId } : {}),
					...(value.wormholeStateId !== undefined
						? { wormholeStateId: value.wormholeStateId }
						: {}),
					priceInfoObjectIds,
					feeds: feedsByLabel,
				} satisfies PythStateRecord);
			}),
	});

	// Surface a `PythTag` projection over the per-name composite so
	// downstream services (PythPusher, deepbookMargin) can `yield* PythTag`
	// instead of having to know the per-name tag identity.
	const tagLayer = provide(
		PythTag,
		Effect.gen(function* () {
			const out = yield* composite;
			const findPriceInfo = (feed: PythPriceFeedId): PythPriceInfo | undefined =>
				out.priceInfos.find((p) => p.feedId === feed);
			const findPriceInfoByLabel = (label: string): PythPriceInfo | undefined =>
				out.priceInfos.find((p) => p.label === label);
			return {
				packageId: out.packageId,
				pythStateId: out.pythStateId,
				wormholeStateId: out.wormholeStateId,
				priceInfos: out.priceInfos.map((p) => ({
					label: p.label,
					feedId: p.feedId,
					priceInfoObjectId: p.priceInfoObjectId,
				})),
				findPriceInfo,
				findPriceInfoByLabel,
			} satisfies Pyth;
		}),
	).__layer;

	const __layers: ReadonlyArray<any> = [...composite.__layers, tagLayer];
	return Object.assign(composite, { __layers });
};

export const STATE_KEY_PYTH_PREFIX_INTERNAL = STATE_KEY_PYTH_PREFIX;
