// Scoped seq-tagged registry primitive — public barrel.
//
// `makeScopedMultimap<K, V>()` — the raw seq-tagged multimap (the
// StrategyRegistry folds its own winner over the
// `MultimapEntry{value,seq}` snapshot this exposes).
//
// See `service.ts` for the rationale (sibling-scope-safe seq-tagged store,
// drop-by-seq finalizers).

export { makeScopedMultimap, type MultimapEntry } from './service.ts';
