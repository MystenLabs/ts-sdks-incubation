// Default-provider registry. Two implicit refs land on every
// `devstack(...)` call when missing:
//
// - `Sui()` — the localnet provider every per-account / per-package /
//   per-action ref transitively depends on. Auto-fills when the user
//   doesn't supply their own `Sui(...)`.
// - `Faucet()` — the dispatch service `Account({ funding })` and the
//   dev-wallet UI's "Get <symbol>" panel both consume. Auto-fills when
//   the user doesn't supply their own `Faucet(...)` (rare; plugin
//   authors registering custom strategies via `Faucet({ strategies })`
//   on `/advanced`). The auto-included Faucet best-effort registers
//   the built-in SUI HTTP strategy when `SuiTag.faucet` is available;
//   per-coin TreasuryCap mint strategies auto-register from
//   `Package(...)` publish via the coin-discovery pass.

import { Faucet as FaucetFactory } from '../services/faucet/index.js';
import { Sui as SuiFactory } from '../services/sui.js';
import type { StackMember } from '../engine/supervisor.js';

/** The canonical Context key for the Sui tag. Matches the key on
 *  `SuiTag` in `services/sui.ts` (`@devstack/SuiTag`). */
const SUI_TAG_KEY = '@devstack/SuiTag';

/** Auto-fill missing required providers. Today: Sui + Faucet. Returns the
 *  refs the user passed plus any synthesized defaults. */
export const fillDefaults = (refs: ReadonlyArray<StackMember>): ReadonlyArray<StackMember> => {
	const hasSui = refs.some((r) => (r as { key?: string }).key === SUI_TAG_KEY);
	const hasFaucet = refs.some((r) => ((r as { key?: string }).key ?? '').startsWith('faucet/'));
	const out: Array<StackMember> = [...refs];
	if (!hasSui) out.unshift(SuiFactory());
	if (!hasFaucet) {
		// `hidden: true` because this Faucet is auto-included by devstack
		// itself (the user didn't type it), so surfacing it as a TUI row
		// is confusing — the user sees `[sui] faucet pending` and
		// wonders what it is and why it's separate from the sui localnet
		// row that already shows the faucet URL. Users who explicitly
		// add `Faucet({...})` to their stack still get a visible row.
		out.push(FaucetFactory({ hidden: true }) as unknown as StackMember);
	}
	return out;
};
