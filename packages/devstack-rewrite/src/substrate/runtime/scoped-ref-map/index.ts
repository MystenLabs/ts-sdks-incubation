// Generic scoped Ref-Map registry primitive — barrel.
//
// Substrate-level name-blind `K -> V` registry factory. L2 plugins
// (Sui-coin, Move-package, future chain plugins) instantiate this
// to author their own typed Context.Service rather than reaching
// for a single shared map.

export { defineScopedRefMap, ScopedRefMapKeyMissingError, type ScopedRefMap } from './service.ts';
