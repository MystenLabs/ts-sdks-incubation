// User-owned dapp-kit wiring. Spreads the generated devstack config
// (RPC URL + MVR overrides + burner-wallet adapter) into
// `createDAppKit`. On a fork-mode stack the generated config has
// `runtime: 'forked'` so the UI can branch on fork-only affordances
// (impersonation status, manual advance-clock) — see Phase 5 §8.

import { createDAppKit } from '@mysten/dapp-kit-react';
import { devstackDappKitConfig } from './generated/dapp-kit-config.js';

export const dAppKit = createDAppKit({
	...devstackDappKitConfig,
});

// Expose the kit on globalThis so the playwright `connectAs` helper
// can drive account switching from `page.evaluate(...)`. Strip this
// behind an env guard in a production build.
(globalThis as { __devstackDAppKit__?: typeof dAppKit }).__devstackDAppKit__ = dAppKit;

declare module '@mysten/dapp-kit-react' {
	interface Register {
		dAppKit: typeof dAppKit;
	}
}
