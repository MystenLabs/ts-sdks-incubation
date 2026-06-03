// Unified scoped seq-tagged registry primitive — public barrel.
//
// ONE storage + finalizer + snapshot core, TWO surfaces:
//
//   - `makeScopedMultimap<K, V>()` — the raw seq-tagged multimap
//     (StrategyRegistry / FormatterRegistry fold their own winner over
//     the `MultimapEntry{value,seq}` snapshot this exposes).
//
//   - `defineScopedRegistry<K, V>(name, { multi? })` — a typed
//     `Context.Service` factory over the SAME core. Default (single mode)
//     is a last-write-wins `K -> V` `ScopedRefMap`; `multi: true` exposes
//     the raw multimap ops. `defineScopedRefMap` is the single-mode alias.
//
// See `service.ts` for the rationale (sibling-scope-safe seq-tagged store,
// drop-by-seq finalizers, LWW projection reproducing the prior order).

export {
	makeScopedMultimap,
	defineScopedRegistry,
	defineScopedRefMap,
	ScopedRefMapKeyMissingError,
	type MultimapEntry,
	type MultimapItem,
	type ScopedMultimap,
	type ScopedRefMap,
} from './service.ts';
