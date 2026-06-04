// Scoped seq-tagged registry primitive — public barrel.
//
// ONE storage + finalizer + snapshot core, TWO primitives over it:
//
//   - `makeScopedMultimap<K, V>()` — the raw seq-tagged multimap
//     (the StrategyRegistry folds its own winner over the
//     `MultimapEntry{value,seq}` snapshot this exposes).
//
//   - `defineScopedRefMap<K, V>(name)` — a typed `Context.Service`
//     factory over the SAME core, a last-write-wins `K -> V`
//     `ScopedRefMap`. Used by coin/package.
//
// See `service.ts` for the rationale (sibling-scope-safe seq-tagged store,
// drop-by-seq finalizers, LWW projection reproducing the prior order).

export {
	makeScopedMultimap,
	defineScopedRefMap,
	setSingleEntry,
	ScopedRefMapKeyMissingError,
	type MultimapEntry,
	type ScopedRefMap,
} from './service.ts';
