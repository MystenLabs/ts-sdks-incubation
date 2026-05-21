// Deepbook plugin — CompositePrimitive capability decl.
//
// Architecture §8 (CompositePrimitive): deepbook presents as ONE
// supervisor row while internally composing the Pyth state +
// deepbook package publish + per-pool creation + optional margin
// package + optional indexer container + optional server container
// + optional market-maker fiber.
//
// The composite key folds the deepbook instance name so multi-
// instance deepbook in the same stack mints distinct rows. The
// substrate's lifecycle scheduler walks the lifted siblings + the
// inner-participants (currently empty — phase-narration is driven
// by the acquire body via spans; future expansion can lift the
// inner one-shots into typed participants).

import type { CompositePrimitiveDecl } from '../../contracts/composite-primitive.ts';
import { pluginKey, type PluginKey } from '../../substrate/brand.ts';
import type { LiftedSiblingKey } from '../../substrate/lifted-sibling.ts';
import type { AnyMember } from '../../substrate/plugin.ts';

/** Per-deepbook-instance plugin key. */
export const deepbookPluginKey = (name: string): PluginKey => pluginKey(`deepbook:${name}`);

/** Build the CompositePrimitive decl. */
export const makeDeepbookComposite = (inputs: {
	readonly name: string;
	readonly liftedSiblings: ReadonlyArray<LiftedSiblingKey>;
	readonly innerParticipants: ReadonlyArray<AnyMember>;
}): CompositePrimitiveDecl => ({
	kind: 'composite-primitive',
	compositeKey: deepbookPluginKey(inputs.name),
	liftedSiblings: inputs.liftedSiblings,
	innerParticipants: inputs.innerParticipants,
});
