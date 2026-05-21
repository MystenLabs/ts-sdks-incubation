// Plugin authoring helper.
//
// Brands a member with `MEMBER_BRAND` (the runtime discriminator for
// the variadic `defineDevstack` form) and preserves the narrow
// generic parameters end-to-end.
//
// The `capabilities` field accepts either:
//   (a) a static `Caps` tuple (factory-time), or
//   (b) a `CapabilitiesFactory<Caps, Resolved>` invoked POST-acquire
//       with the resolved plugin value + acquire context.
// `defineNodePlugin` is shape-agnostic — the supervisor's harvest loop
// dispatches each contribution through the `CapabilitySinksService`
// kind→sink registry at runtime.

import type { CapabilityDecl } from '../contracts/capability-decl.ts';
import type { LiftedSiblingKey } from '../substrate/lifted-sibling.ts';
import type { AnyTag } from '../substrate/tag.ts';
import { MEMBER_BRAND, type StackMember } from '../substrate/plugin.ts';

/**
 * Authoring helper. Accepts the plugin's tag, consumed tags,
 * acquire procedure, and capability tuple, and returns a branded
 * `StackMember` with all four generics narrowed (provides, consumes,
 * caps, lifted siblings).
 */
export function defineNodePlugin<
	Provides extends AnyTag,
	Consumes extends ReadonlyArray<AnyTag>,
	Caps extends ReadonlyArray<CapabilityDecl> = readonly [],
	Siblings extends ReadonlyArray<LiftedSiblingKey> = readonly [],
>(
	spec: Omit<StackMember<Provides, Consumes, Caps, Siblings>, typeof MEMBER_BRAND>,
): StackMember<Provides, Consumes, Caps, Siblings> {
	return {
		...spec,
		[MEMBER_BRAND]: true,
	} as StackMember<Provides, Consumes, Caps, Siblings>;
}
