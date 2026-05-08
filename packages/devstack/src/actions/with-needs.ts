// `WithNeeds<TNeeds, T>` — phantom-typed return shape used by every
// action factory whose `needs:` literal union should flow into
// `defineDevstackConfig`'s mapped-type validator.
//
// `__needs` carries the union forward at the type level only; it has
// no runtime presence. `defineDevstackConfig` reads it via
// `DottedNeedsIn<TUse>` to type-check that every dotted reference in
// `needs:` matches a `Plugin<TProvides>` provides string in the same
// `use:[]` array.
//
// Each factory (`publishMove`, `registerCoin`, `seed`, `runTransaction`)
// constructs its own `TNeeds` from its `opts.needs` literal tuple — the
// `<const TNeeds extends string>` generic + `readonly TNeeds[]` shape
// on the options is what tells TS to preserve string literals through
// inference instead of widening to `string`.

export type WithNeeds<TNeeds extends string, T> = T & { readonly __needs?: TNeeds };
