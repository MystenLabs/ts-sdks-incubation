// Plugin-author-facing cache wrapper around the internal `StateStore`.
//
// `StateStore` itself stays internal — plugin-author code shouldn't
// need to know about file paths, lock acquisition, schema versions, or
// the rest of `state-store.ts`'s machinery. `Cache` exposes the
// narrow get/put/remove surface most plugin authors actually want, in
// a stable namespace.

import { Effect, type Option } from 'effect';
import { StateStore } from './state-store.js';

// Get a cached value by key. Returns `None` on miss.
export const cacheGet = <T>(key: string): Effect.Effect<Option.Option<T>, never, StateStore> =>
	Effect.gen(function* () {
		const store = yield* StateStore;
		return yield* store.get<T>(key);
	});

// Store a value by key. Overwrites any prior entry.
export const cachePut = <T>(key: string, value: T): Effect.Effect<void, never, StateStore> =>
	Effect.gen(function* () {
		const store = yield* StateStore;
		yield* store.put<T>(key, value);
	});

// Remove a cached entry. No-op if the key isn't present.
export const cacheRemove = (key: string): Effect.Effect<void, never, StateStore> =>
	Effect.gen(function* () {
		const store = yield* StateStore;
		yield* store.remove(key);
	});
