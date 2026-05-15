// Action(name, opts) — post-publish setup tx. The build callback
// receives a raw `Transaction` builder; its return Effect's `E` channel
// widens to whatever the yielded Refs propagate (e.g. `PublishError`
// from a `Package` ref), and the supervisor catches errors at the
// engine level so users don't have to `catchTag` inside every action.

import { Effect, Option } from 'effect';
import { Transaction } from '@mysten/sui/transactions';
import { tag, setPhase, type Ref } from '../advanced/tag.js';
import { PublishError } from '../primitives/errors.js';
import { StateStore } from '../engine/state-store.js';
import { SuiTag } from './sui.js';
import type { Account, TxResult } from '../primitives/shared.js';

export interface ActionOptions<Name extends string, R, E = unknown> {
	/** Account that signs the action. */
	readonly signer: Ref<any, Account, any, any>;
	/** Refs this action depends on. Yielded for ordering before `build`
	 *  runs. Typically a list of `Package` refs whose ids the action
	 *  references in `moveCall` targets. */
	readonly needs?: ReadonlyArray<Ref<any, any, any, any>>;
	/** Optional gas budget for the transaction. */
	readonly gasBudget?: bigint;
	/** Build the transaction. Receives a fresh `Transaction` builder. The
	 *  return Effect's `E` channel widens to whatever the yielded Refs
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

/** Action factory. Returns a Ref that runs the supplied transaction once
 *  per chain (when `cacheKey` is set) or every cycle (when omitted).
 *
 *  Cache key folds in `sui.chainId` + `signer.address`, so a regenesis of
 *  the underlying chain naturally misses the cache (the cached
 *  objectChanges reference object ids that no longer exist). When set,
 *  the on-chain side effects of this action are assumed to persist
 *  across `docker rm` (the localnet image should be on a named volume)
 *  — otherwise a stale cached result will reference objects the freshly-
 *  genesised chain no longer has. */
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
				const userKey = yield* (cacheKeyEff as Effect.Effect<string, unknown, never>);
				const fullKey = `tx/${name}/${sui.chainId}/${signer.address}/${userKey}`;
				const cached = yield* state.get<TxResult>(fullKey);
				if (Option.isSome(cached)) {
					yield* Effect.logInfo(
						`Action(${name}): cache hit — key=${userKey} digest=${cached.value.digest}`,
					);
					return cached.value;
				}
				yield* Effect.logInfo(
					`Action(${name}): cache miss — key=${userKey} (will sign+execute)`,
				);
				yield* setPhase('building');
				const t = new Transaction();
				if (opts.gasBudget !== undefined) {
					t.setGasBudget(opts.gasBudget);
				}
				yield* (opts.build(t) as Effect.Effect<void, unknown, never>);
				yield* setPhase('executing');
				const result = yield* signer.signAndExecute(t).pipe(
					Effect.mapError(
						(cause) =>
							new PublishError({
								stage: 'publish-tx',
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
			yield* (opts.build(t) as Effect.Effect<void, unknown, never>);
			yield* setPhase('executing');
			const result = yield* signer.signAndExecute(t).pipe(
				Effect.mapError(
					(cause) =>
						new PublishError({
							stage: 'publish-tx',
							message: `Action(${name}): sign+execute failed`,
							cause,
						}),
				),
			);
			return result satisfies TxResult;
		}).pipe(Effect.withSpan(`Action(${name})`)),
		{
			kind: 'action',
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
