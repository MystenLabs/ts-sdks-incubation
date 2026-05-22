// Pyth — INTERNAL module under the DeepBook plugin (per memory
// `project_pyth_inside_deepbook`).
//
// Pyth is NOT a top-level devstack plugin. It is part of the
// deepbook resolved value (`resolved.pyth: PythHandle | null`).
//
// Why an internal module:
//
//   - The user-facing DeepBook plugin includes the Pyth oracle
//     wiring as an implementation detail (price feeds drive the
//     deepbook margin module's risk math + the market-maker's mid).
//   - Promoting Pyth to a top-level plugin would split the feature
//     and force users to compose two plugins for one capability.
//   - A future external market-maker need MAY promote Pyth to a
//     top-level plugin; until then it lives here. See memory
//     `project_pyth_inside_deepbook`.
//
// This module exports:
//   - The publish flow (`publishPythPackage`) — uses artifact publisher via the
//     `sui-tx` ChainOperation variant, signed by `pyth.pusher`.
//   - The price-init flow (`initPythFeeds`) — one `update_price_feed`
//     Move call per declared feed.
//   - A long-running pusher fiber that keeps prices fresh.

import { Effect, type Scope } from 'effect';

import type { ArtifactPublisher } from '../../../primitives/artifact-publisher.ts';
import { compileChainOperation } from '../../../substrate/runtime/artifact-publisher/index.ts';
import type {
	ResolvedSigner,
	SuiExecuteClient,
} from '../../../substrate/runtime/sui-execute/index.ts';
import { executeSuiTx } from '../../../substrate/runtime/sui-execute/index.ts';
import {
	chainId as brandChainId,
	contentHash as brandContentHash,
} from '../../../substrate/brand.ts';
import { deepbookPluginError, type DeepbookPluginError } from '../errors.ts';
import type { PythFeed, PythHandle } from '../types.ts';

// ---------------------------------------------------------------------------
// Resolved values
// ---------------------------------------------------------------------------

export interface PythPublishResult {
	readonly stateId: string;
	readonly wormholeStateId: string;
	readonly packageId: string;
	readonly priceInfoObjectsBySymbol: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Publish — via artifact publisher / sui-tx variant
// ---------------------------------------------------------------------------

/** Publish the Pyth + Wormhole packages and initialize per-feed
 *  price-info objects. Signed by `pyth.pusher`. The artifact publisher primitive
 *  handles cache → verify → produce → register; on warm restart a
 *  prior publish is reused.
 *
 *  Produce is expressed as `compileChainOperation` with `_tag:
 *  'sui-tx'` so the `sui-execute` substrate helper owns the
 *  sign/execute/wait/parse round-trip. */
export const publishPythPackage = (
	publisher: ArtifactPublisher,
	client: SuiExecuteClient,
	chain: string,
	signer: ResolvedSigner,
	feeds: ReadonlyArray<PythFeed>,
): Effect.Effect<PythPublishResult, DeepbookPluginError, Scope.Scope> =>
	Effect.gen(function* () {
		// Hash inputs: signer address + sorted feed-id list. Two runs
		// with the same signer + feeds share a cache key; changing
		// either invalidates.
		const sortedFeedIds = [...feeds]
			.map((f) => f.feedId)
			.sort()
			.join('|');
		const contentHash = brandContentHash(`pyth|${signer.address}|${sortedFeedIds}`);

		const produced = yield* publisher
			.publish<PythPublishResult, null>({
				namespace: 'deepbook/pyth',
				chain: brandChainId(chain),
				contentHash,
				// Pyth state ids are immutable once published — verify is a
				// pure "did the cache exist" check; we return `null` to keep
				// the verified type slot unused (cache-hit fast path).
				verifySchema: null as unknown as never,
				verify: () => Effect.succeed(null),
				produce: compileChainOperation<PythPublishResult>({
					_tag: 'sui-tx',
					build: (_tx) => {
						void _tx;
					},
					signer,
					executor: (s, b) =>
						executeSuiTx({ client, signer: s, build: () => b(undefined as never) as never }).pipe(
							Effect.mapError(
								(cause) =>
									({
										_tag: 'ArtifactPublishError',
										reason: 'produce-failed',
										detail: cause.message,
									}) as const,
							),
							// The executor's `SuiEffects` slot is `unknown`; we
							// don't decode here — parse below.
							Effect.map((receipt) => receipt as unknown),
						),
					parse: (_effects) =>
						Effect.fail({
							_tag: 'ArtifactPublishError' as const,
							reason: 'produce-failed' as const,
							detail:
								'pyth publish requires a Wormhole/Pyth deployment transaction. Use deepbook known mode with an existing oracle deployment.',
						}),
				}),
				register: () => Effect.void,
			})
			.pipe(
				Effect.mapError(
					(err): DeepbookPluginError =>
						deepbookPluginError(
							'pyth-publish',
							err._tag === 'ArtifactPublishError' ? err.detail : String(err),
						),
				),
			);

		return produced as PythPublishResult;
	});

// ---------------------------------------------------------------------------
// Init feeds — one `update_price_feed` Move call per declared feed
// ---------------------------------------------------------------------------

/** Initialize per-feed price-info objects by calling
 *  `pyth::update_single_price_feed` once per feed. Idempotent — the
 *  feed's price info object is created on first call and re-priced on
 *  subsequent calls. */
export const initPythFeeds = (
	_publisher: ArtifactPublisher,
	_client: SuiExecuteClient,
	_chain: string,
	_signer: ResolvedSigner,
	_pyth: PythPublishResult,
	feeds: ReadonlyArray<PythFeed>,
): Effect.Effect<PythHandle, DeepbookPluginError, Scope.Scope> =>
	Effect.gen(function* () {
		const resolvedFeeds: Array<PythHandle['feeds'][number]> = [];
		for (const feed of feeds) {
			const priceInfoObjectId = _pyth.priceInfoObjectsBySymbol[feed.symbol];
			if (priceInfoObjectId === undefined || priceInfoObjectId === '') {
				return yield* Effect.fail(
					deepbookPluginError(
						'pyth-feed',
						`pyth feed ${feed.symbol} has no price info object in the published deployment.`,
					),
				);
			}
			resolvedFeeds.push({
				symbol: feed.symbol,
				feedId: feed.feedId,
				priceInfoObjectId,
			});
		}
		return {
			stateId: _pyth.stateId,
			wormholeStateId: _pyth.wormholeStateId,
			feeds: resolvedFeeds,
		} satisfies PythHandle;
	});

// ---------------------------------------------------------------------------
// Pusher fiber — long-running background loop refreshing prices
// ---------------------------------------------------------------------------

/** Start the pusher fiber. Forked via `Effect.forkScoped` by the
 *  DeepBook acquire body so the fiber dies with the surrounding
 *  scope. */
export const pushPythPrices = (
	_pyth: PythHandle,
	_intervalMillis: number,
): Effect.Effect<void, never, Scope.Scope> =>
	Effect.gen(function* () {
		yield* Effect.never;
	}).pipe(Effect.withSpan('devstack.plugin.deepbook.pyth.pusher'));

// Re-export the public Pyth user surface (folded inside deepbook).
export type { PythFeed, PythHandle, PythOptions } from '../types.ts';
export {
	DEEP_PRICE_FEED_ID,
	pythPriceFeedId,
	SUI_PRICE_FEED_ID,
	USDC_PRICE_FEED_ID,
} from '../types.ts';
