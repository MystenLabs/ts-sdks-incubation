// Default-provider registry. If the user passes refs that require sui
// (any Account/Package/Action) and no `Sui(...)` ref is in the merge,
// devstack synthesizes a localnet `Sui()` automatically. Today this is
// the only auto-fill; capability-keyed defaults (e.g.
// `capability:seal-key-server` → `Seal()`) would slot in here.

import { Sui as SuiFactory } from '../services/sui.js';
import type { StackMember } from '../engine/supervisor.js';

/** The canonical Context key for the Sui tag. Matches the key on
 *  `SuiTag` in `services/sui.ts` (`@devstack/SuiTag`). */
const SUI_TAG_KEY = '@devstack/SuiTag';

/** Auto-fill missing required providers. Today: Sui. Returns the
 *  refs the user passed plus any synthesized defaults. */
export const fillDefaults = (refs: ReadonlyArray<StackMember>): ReadonlyArray<StackMember> => {
	const hasSui = refs.some((r) => (r as { key?: string }).key === SUI_TAG_KEY);
	if (hasSui) return refs;
	return [SuiFactory(), ...refs];
};
