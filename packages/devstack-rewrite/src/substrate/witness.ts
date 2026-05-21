// Phantom cross-plugin witnesses.
//
// Architecture Tension 11: a composite's resolved value can claim
// "this composition requires X" via a phantom witness. The
// stack-level type check computes `Exclude<Required, Provided>` and
// rejects mismatched stacks at compile time.
//
// Witness symbols are minted via a substrate helper, NOT inline by each
// plugin. The helper is in `api/witness.ts`; this file declares the
// phantom shape.
//
// Phantom variance rule: return-position. See `tag.ts` header.

declare const _witness: unique symbol;

/** A witness phantom keyed by literal name. Two witnesses with
 *  different names are structurally distinct. */
export interface Witness<Name extends string> {
	readonly [_witness]: Name;
}

/** Marker phantom a plugin's resolved-value type may carry to claim
 *  it REQUIRES a witness. */
export interface RequiresWitness<Name extends string> {
	readonly _requires?: () => Witness<Name>;
}

/** Marker phantom a plugin's resolved-value type may carry to claim
 *  it PROVIDES a witness. */
export interface ProvidesWitness<Name extends string> {
	readonly _provides?: () => Witness<Name>;
}

/** Type-level extraction of a witness name from a resolved value. */
export type WitnessRequiredBy<V> = V extends {
	readonly _requires?: () => Witness<infer N>;
}
	? N
	: never;

export type WitnessProvidedBy<V> = V extends {
	readonly _provides?: () => Witness<infer N>;
}
	? N
	: never;
