// Lifted-sibling key shape + dedup contract.
//
// Architecture § CompositePrimitive "Lifted-sibling key conventions".
// Two regimes:
//
//   - Literal `inputHash`  → compile-time dedup conflict via
//                            union-to-intersection collapse.
//   - Runtime `inputHash`  → compose-time runtime refusal (substrate
//                            primitive in `primitives/lifted-sibling.ts`).
//
// Same `(plugin, kind, scope)` with same `inputHash` is first-wins
// dedup; different `inputHash` is refused. Different `plugin`
// namespaces never dedup, regardless of `kind`.

import type { Brand, ContentHash } from './brand.ts';

/** Closed scope vocabulary — keep it small and well-defined. */
export type SiblingScope = 'per-app' | 'per-stack' | 'per-process';

/** A lifted-sibling key. The four fields together uniquely identify
 *  one sibling artifact across multiple composites of the same
 *  plugin family. */
export interface LiftedSiblingKey<
	Plugin extends string = string,
	Kind extends string = string,
	Scope extends SiblingScope = SiblingScope,
> {
	readonly plugin: Plugin;
	readonly kind: Kind;
	readonly scope: Scope;
	readonly inputHash: ContentHash;
}

/** Literal-typed sibling-key brand. Preserves the input hash as a
 *  string literal type so the compiler can dedup across composites
 *  at type level. */
declare const _litHash: unique symbol;
/** A literal-typed content hash. Carries BOTH the `ContentHash` brand
 *  AND a literal-string phantom so the compiler can read the hash at
 *  the type level for compile-time dedup. */
export type LitHash<S extends string> = Brand<string, 'ContentHash'> & {
	readonly [_litHash]: S;
};

/** Construct a literal-typed hash (substrate boundary). The cast is
 *  the standard branded-primitive constructor pattern. */
export function litHash<S extends string>(s: S): LitHash<S> {
	return s as unknown as LitHash<S>;
}

/** Literal-typed sibling key — preserves the hash at the type level
 *  for compile-time dedup. */
export interface LitSiblingKey<
	Plugin extends string,
	Kind extends string,
	Scope extends SiblingScope,
	Hash extends string,
> {
	readonly plugin: Plugin;
	readonly kind: Kind;
	readonly scope: Scope;
	readonly inputHash: LitHash<Hash>;
}

/** Construct a literal-typed sibling key — the recommended shape
 *  for siblings whose inputs are knowable at authoring time
 *  (pinned git refs, image tags). */
export function litSiblingKey<
	P extends string,
	K extends string,
	S extends SiblingScope,
	H extends string,
>(plugin: P, kind: K, scope: S, hash: H): LitSiblingKey<P, K, S, H> {
	return { plugin, kind, scope, inputHash: litHash(hash) };
}

// --- Type-level dedup contract (literal-hash regime) -------------------

/** Group-key digest used by the compile-time conflict check. */
export type GroupKey<K> =
	K extends LitSiblingKey<infer P, infer Kind, infer S, string> ? `${P}|${Kind}|${S}` : never;

/** Extract the literal hash from a sibling key. */
export type HashOf<K> = K extends LitSiblingKey<string, string, SiblingScope, infer H> ? H : never;

export type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (
	k: infer I,
) => void
	? I
	: never;

/** True iff every sibling in the group has the same hash (singleton
 *  union); false (the conflict marker) otherwise. */
export type IsUniformHash<G extends string, AllSiblings> = [
	UnionToIntersection<HashesForGroup<G, AllSiblings>>,
] extends [never]
	? false
	: true;

export type HashesForGroup<G extends string, AllSiblings> = AllSiblings extends infer S
	? S extends LitSiblingKey<string, string, SiblingScope, string>
		? GroupKey<S> extends G
			? HashOf<S>
			: never
		: never
	: never;

/** Branded structured error (open question #11) — surfaces the
 *  conflicting `plugin|kind|scope` group key in the IDE. */
export interface __SiblingHashConflictError<G extends string> {
	readonly __sibling_hash_conflict: G;
}
