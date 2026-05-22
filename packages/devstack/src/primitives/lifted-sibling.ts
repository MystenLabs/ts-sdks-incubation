// Lifted-sibling substrate primitive.
//
// Architecture § CompositePrimitive lifted-sibling key conventions.
// This file owns the substrate-side dedup protocol (first-wins on
// identical keys; refuse on conflict). Type-level dedup for
// literal-hash siblings lives in `substrate/lifted-sibling.ts`; the
// runtime-computed regime is handled here.

import type { Effect, Scope } from 'effect';

import type { LiftedSiblingKey } from '../substrate/lifted-sibling.ts';
import type { AnyPlugin } from '../substrate/plugin.ts';

/** Outcome of registering a sibling under a key. */
export type LiftedSiblingRegistration =
	| { readonly result: 'registered'; readonly member: AnyPlugin }
	| { readonly result: 'deduped'; readonly existing: AnyPlugin }
	| { readonly result: 'conflict'; readonly conflict: LiftedSiblingConflict };

/** Runtime conflict — same `(plugin, kind, scope)` with different
 *  inputHash. Surfaces with a structured error listing both inputs. */
export interface LiftedSiblingConflict {
	readonly _tag: 'LiftedSiblingConflict';
	readonly groupKey: string;
	readonly existingHash: string;
	readonly attemptedHash: string;
}

/** The substrate-facing lifted-sibling registry. Architecture
 *  promises: topo-scheduler places lifted siblings at level 0;
 *  composites wait on them via upstream-keys. */
export interface LiftedSiblingRegistry {
	readonly register: (
		key: LiftedSiblingKey,
		factory: AnyPlugin,
	) => Effect.Effect<LiftedSiblingRegistration, never, Scope.Scope>;
	readonly list: () => Effect.Effect<ReadonlyArray<LiftedSiblingKey>>;
}
