// Default-provider registry. Phase 2 implements the auto-Sui fill: if
// the user passes refs that require sui (any Account/Package/Action)
// and no `Sui(...)` ref is in the merge, devstack synthesizes a
// localnet `Sui()` automatically.
//
// Phase 6 will extend this with capability-keyed defaults
// (`capability:seal-key-server` → `Seal()`, etc.) and apply-time
// invariant validation (ephemeral-funded + testnet).

import { Sui as SuiFactory } from '../services/sui.js';
import type { StackMember } from '../engine/supervisor.js';

/** The canonical Context key for the Sui tag. Matches the key on
 *  `SuiTag` in `services/sui.ts` (`@devstack/Sui`). */
const SUI_TAG_KEY = '@devstack/Sui';

/** Auto-fill missing required providers. Today: Sui. Returns the
 *  refs the user passed plus any synthesized defaults. */
export const fillDefaults = (refs: ReadonlyArray<StackMember>): ReadonlyArray<StackMember> => {
	const hasSui = refs.some((r) => (r as { key?: string }).key === SUI_TAG_KEY);
	if (hasSui) return refs;
	return [SuiFactory(), ...refs];
};
