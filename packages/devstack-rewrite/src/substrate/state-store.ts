// Per-stack persistent state store.
//
// Architecture § State store: BRANDed typed keys; cross-process safe
// via the unified lock; durable until stack wipe. Distinct from
// cache (content-addressed, dropable) and from snapshot (frozen
// replica).
//
// L0 owns the file format and the lock; the substrate exposes a
// typed-key constructor pattern so each plugin namespaces its keys
// under its plugin-key prefix.

import type { Effect } from 'effect';

import type { Brand, PluginKey } from './brand.ts';
import type { StateStoreError } from './runtime/errors.ts';

/** A typed state-store key. The brand carries the value shape as a
 *  phantom so reads/writes are type-safe. */
declare const _stateKey: unique symbol;
export type StateKey<V> = Brand<string, 'StateKey'> & {
	readonly [_stateKey]?: () => V;
};

/** Construct a state-store key with a typed value shape. The owning
 *  plugin's key prefix is required at the call site — keys are
 *  structurally namespaced under that prefix. */
export function defineStateKey<V>(pluginKey: PluginKey, suffix: string): StateKey<V> {
	return `${pluginKey}/${suffix}` as StateKey<V>;
}

/**
 * The state-store service interface.
 *
 * Every method may surface a `StateStoreError` (I/O, corruption,
 * lock-contention). The error class lives at `runtime/errors.ts`;
 * this contract imports it type-only so the contract layer stays
 * free of runtime-side cycles.
 *
 * Tombstone semantics: `get` on a deleted (tombstoned) key returns
 * `null`, indistinguishable from a never-written key. The
 * tombstone-vs-missing distinction is preserved on disk for
 * snapshot fidelity but is invisible to the typed contract.
 */
export interface StateStore {
	/** Read a typed value. Returns `null` if absent or tombstoned. */
	get<V>(key: StateKey<V>): Effect.Effect<V | null, StateStoreError>;
	/** Write a typed value (atomic, cross-process safe). */
	set<V>(key: StateKey<V>, value: V): Effect.Effect<void, StateStoreError>;
	/** Tombstone-delete a key. */
	delete<V>(key: StateKey<V>): Effect.Effect<void, StateStoreError>;
	/** List all keys present under a plugin's namespace. Tombstones
	 *  are excluded from the result. */
	listUnder(prefix: PluginKey): Effect.Effect<ReadonlyArray<string>, StateStoreError>;
}
