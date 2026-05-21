// Substrate-minted witness symbols.
//
// Architecture open question #12: phase-3 ships a `defineWitness`
// constructor so the witness symbol is centralized and two
// out-of-tree plugins cannot collide on the same tag.
//
// The witness phantom uses return-position (covariant) variance —
// see `substrate/witness.ts`.

import type { Witness, ProvidesWitness, RequiresWitness } from '../substrate/witness.ts';

/** Witness-namespace registry — phantom-typed key. The substrate
 *  treats names as opaque; this typed wrapper prevents two plugins
 *  from registering the same name via collision. */
export interface WitnessDeclaration<Name extends string> {
	readonly name: Name;
	/** Phantom — same return-position variance rule as the rest of
	 *  the substrate. */
	readonly _phantom?: () => Witness<Name>;
}

/** Mint a witness declaration. The literal `name` is preserved so
 *  the requires/provides shapes the plugin attaches to its resolved
 *  value carry the same literal. */
export function defineWitness<Name extends string>(name: Name): WitnessDeclaration<Name> {
	return { name };
}

/** Helper for plugins that REQUIRE a witness — returns the phantom
 *  shape to spread into the resolved value's type. The runtime
 *  value is `{}`; the type-level marker drives stack-level
 *  satisfaction checking. */
export function requiresWitness<Name extends string>(
	_witness: WitnessDeclaration<Name>,
): RequiresWitness<Name> {
	return {} as RequiresWitness<Name>;
}

/** Helper for plugins that PROVIDE a witness. */
export function providesWitness<Name extends string>(
	_witness: WitnessDeclaration<Name>,
): ProvidesWitness<Name> {
	return {} as ProvidesWitness<Name>;
}

export type { Witness, RequiresWitness, ProvidesWitness } from '../substrate/witness.ts';
