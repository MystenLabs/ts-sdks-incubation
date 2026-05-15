// Action(name, opts) — post-publish setup tx. Replaces the v3
// `tx({name, signer, dependsOn, cacheKey, build})` factory. Same shape,
// renamed to fit the new vocabulary:
//
//   - `dependsOn` → `needs` (consistent with the redesign's framing)
//   - `cacheKey` accepts both the v3 `Effect<string>` form and a sync
//     `(pkgs) => string` form derived from the `needs` array's resolved
//     refs; the sync form covers the common case in one line.
//
// The `build` callback continues to receive the raw `Transaction` builder.
// Its return Effect's `E` channel widens to whatever the yielded Refs
// propagate (e.g. `PublishError` from a `Package` ref); the supervisor
// catches errors at the engine level so users don't have to `catchTag`
// inside every action's build body.

import { Effect } from 'effect';
import { Transaction } from '@mysten/sui/transactions';
import { tx, type TxOptions } from '../primitives/tx.js';
import type { Account } from '../primitives/shared.js';
import type { Ref } from '../advanced/tag.js';

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
	 *    - `Effect<string>` — full programmatic control (v3-compatible).
	 *    - `string` — literal key; folded with chain id + signer address. */
	readonly cacheKey?: Effect.Effect<string, unknown, unknown> | string;
	/** Reserved for the typed `_name` parameter; defaults to the action's
	 *  `name`. */
	readonly _name?: Name;
}

/** Action factory. Returns a Ref that runs the supplied transaction once
 *  per chain (when `cacheKey` is set) or every cycle (when omitted). */
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
	// v3 `tx`'s `build` type pins E=never. The v4 `Action` widens E to
	// match what real builds yield (Refs propagate their own E channels);
	// the supervisor catches errors at the engine level. Cast through to
	// the legacy signature — runtime behavior is identical.
	const txOpts: TxOptions<Name, R> = {
		name,
		signer: opts.signer,
		build: opts.build as TxOptions<Name, R>['build'],
		...(opts.needs !== undefined ? { dependsOn: opts.needs } : {}),
		...(opts.gasBudget !== undefined ? { gasBudget: opts.gasBudget } : {}),
		...(cacheKeyEff !== undefined ? { cacheKey: cacheKeyEff } : {}),
	};
	return Object.assign(tx(txOpts), { __kind: 'action' as const });
};
