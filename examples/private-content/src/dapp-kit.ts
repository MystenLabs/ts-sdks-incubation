// User-owned dapp-kit wiring. Spreads the generated devstack config
// (RPC URL + MVR overrides + burner-wallet adapter) into
// `createDAppKit`. Add app-specific overrides on top of the spread.

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
