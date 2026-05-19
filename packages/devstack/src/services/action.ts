// Action(name, opts) — post-publish setup tx. The build callback
// receives a raw `Transaction` builder; its return Effect's `E` channel
// widens to whatever the yielded LayeredTags propagate (e.g. `PublishError`
// from a `Package` ref), and the supervisor catches errors at the
// engine level so users don't have to `catchTag` inside every action.

import { Effect, Option } from 'effect';
import { Transaction } from '@mysten/sui/transactions';
import { tag, setPhase, type LayeredTag } from '../advanced/tag.js';
import { PublishError } from '../engine/errors.js';
import { StateStore } from '../engine/state-store.js';
import { StateStoreKeys } from '../engine/state-store-keys.js';
import { SuiTag, type Sui } from './sui.js';
import type { Account, SuiObjectChange, TxResult } from '../engine/shared.js';

// Probe the first created object id from a cached TxResult. Returns
// `'valid'` when the object resolves on-chain, a short tag string
// otherwise (`'no-objects'` if the result captured zero creations —
// nothing to probe, treat as valid; `'object-missing'` if the
// lookup 404s; `'probe-error'` for any other failure, which we
// conservatively treat as valid so a transient RPC blip doesn't
// invalidate cache and force unnecessary re-fires).
const probeCachedTx = (
	sui: Sui,
	cached: TxResult,
): Effect.Effect<'valid' | 'no-objects' | 'object-missing' | 'probe-error'> =>
	Effect.gen(function* () {
		const created = cached.objectChanges.find(
			(c): c is Extract<SuiObjectChange, { type: 'created' }> => c.type === 'created',
		);
		if (created === undefined) return 'no-objects';
		const result = yield* Effect.tryPromise({
			try: () => sui.client.core.getObject({ objectId: created.objectId }),
			catch: (cause) => cause,
		}).pipe(
			Effect.map(() => 'valid' as const),
			Effect.catch((cause) => {
				const code = (cause as { code?: string }).code;
				const message = (cause as { message?: string }).message ?? '';
				if (code === 'OBJECT_NOT_FOUND' || /not\s*found|does\s*not\s*exist/i.test(message)) {
					return Effect.succeed('object-missing' as const);
				}
				return Effect.succeed('probe-error' as const);
			}),
		);
		return result;
	});

export interface ActionOptions<Name extends string, R, E = unknown> {
	/** Account that signs the action. */
	readonly signer: LayeredTag<any, Account, any, any>;
	/** Refs this action depends on. Yielded for ordering before `build`
	 *  runs. Typically a list of `Package` refs whose ids the action
	 *  references in `moveCall` targets. */
	readonly needs?: ReadonlyArray<LayeredTag<any, any, any, any>>;
	/** Optional gas budget for the transaction. */
	readonly gasBudget?: bigint;
	/** Build the transaction. Receives a fresh `Transaction` builder. The
	 *  return Effect's `E` channel widens to whatever the yielded LayeredTags
	 *  propagate; the supervisor catches errors at the engine level. */
	readonly build: (transaction: Transaction) => Effect.Effect<void, E, R>;
	/** Optional cache key. Two accepted forms:
	 *    - `Effect<string>` — full programmatic control.
	 *    - `string` — literal key; folded with chain id + signer address. */
	readonly cacheKey?: Effect.Effect<string, unknown, unknown> | string;
	/** Reserved for the typed `_name` parameter; defaults to the action's
	 *  `name`. */
	readonly _name?: Name;
}

/** Action factory. Returns a LayeredTag that runs the supplied transaction once
 *  per chain (when `cacheKey` is set) or every cycle (when omitted).
 *
 *  Cache key folds in `sui.chainId` + `signer.address`, so a regenesis of
 *  the underlying chain naturally misses the cache (the cached
 *  objectChanges reference object ids that no longer exist). When set,
 *  the on-chain side effects of this action are assumed to persist
 *  across cycle teardown — Phase 2 of the snapshot redesign puts chain
 *  state in the writable layer (preserved by `docker stop`, captured by
 *  `docker commit`), so cached results stay valid across `r` / Ctrl-C
 *  but NOT across `devstack stack down --force` or `wipe` (which discard
 *  the layer). A stale cached result against a freshly-genesised chain
 *  references objects that no longer exist; the chainId fold prevents
 *  reuse. */
export const Action = <const Name extends string, R = never, E = unknown>(
	name: Name,
	opts: ActionOptions<Name, R, E>,
) => {
	const cacheKeyEff =
		opts.cacheKey === undefined
			? undefined
			: typeof opts.cacheKey === 'string'
				? Effect.succeed(opts.cacheKey)
				: opts.cacheKey;

	return tag(
		name,
		Effect.gen(function* () {
			for (const dep of opts.needs ?? []) {
				yield* dep;
			}
			const signer = yield* opts.signer;

			// Cache-key path. Compute key first; on a hit, return the prior
			// TxResult and skip build + sign + execute entirely.
			if (cacheKeyEff !== undefined) {
				const sui = yield* SuiTag;
				const state = yield* StateStore;
				const userKey = yield* cacheKeyEff as Effect.Effect<string, unknown, never>;
				const fullKey = StateStoreKeys.actionTx({
					actionName: name,
					chainId: sui.chainId,
					signerAddress: signer.address,
					userKey,
				});
				const cached = yield* state.get<TxResult>(fullKey);
				if (Option.isSome(cached)) {
					// HIGH-C3: probe the cached result against the chain before
					// returning it. `cacheKey` folds in chainId so a regenesis
					// would miss the cache — but a `devstack wipe` that
					// preserves cached state (snapshot restore against a
					// freshly-genesised chain, or a corrupted state.json that
					// kept the entry but the chain volume is gone) would
					// otherwise return a TxResult whose object ids no longer
					// exist on chain. Probing one created object catches that
					// case loudly: re-fire the action instead of returning a
					// dangling reference.
					const probeProbe = yield* probeCachedTx(sui, cached.value);
					if (probeProbe === 'valid') {
						yield* Effect.logInfo(
							`Action(${name}): cache hit — key=${userKey} digest=${cached.value.digest}`,
						);
						return cached.value;
					}
					yield* Effect.logInfo(
						`Action(${name}): cache hit but probe found stale on-chain state ` +
							`(${probeProbe}); evicting and re-firing — key=${userKey}`,
					);
					yield* state.remove(fullKey).pipe(Effect.ignore);
				}
				yield* Effect.logInfo(`Action(${name}): cache miss — key=${userKey} (will sign+execute)`);
				yield* setPhase('building');
				const t = new Transaction();
				if (opts.gasBudget !== undefined) {
					t.setGasBudget(opts.gasBudget);
				}
				yield* opts.build(t) as Effect.Effect<void, unknown, never>;
				yield* setPhase('executing');
				const result = yield* signer.signAndExecute(t).pipe(
					Effect.mapError(
						(cause) =>
							new PublishError({
								phase: 'publish-tx',
								message: `Action(${name}): sign+execute failed`,
								cause,
							}),
					),
				);
				yield* state.put(fullKey, result);
				return result satisfies TxResult;
			}

			yield* setPhase('building');
			const t = new Transaction();
			if (opts.gasBudget !== undefined) {
				t.setGasBudget(opts.gasBudget);
			}
			yield* opts.build(t) as Effect.Effect<void, unknown, never>;
			yield* setPhase('executing');
			const result = yield* signer.signAndExecute(t).pipe(
				Effect.mapError(
					(cause) =>
						new PublishError({
							phase: 'publish-tx',
							message: `Action(${name}): sign+execute failed`,
							cause,
						}),
				),
			);
			return result satisfies TxResult;
		}).pipe(Effect.withSpan(`Action(${name})`)),
		{
			kind: 'action',
			plugin: 'action',
			displayTitle: `tx.${name}`,
			display: (s: TxResult) => ({
				title: `tx.${name}`,
				primary: `digest ${s.digest}`,
				...(s.objectChanges.length > 0
					? {
							extras: [
								`${s.objectChanges.length} object${s.objectChanges.length === 1 ? '' : 's'}`,
							],
						}
					: {}),
			}),
		},
	);
};
