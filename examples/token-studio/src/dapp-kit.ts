// User-owned dapp-kit wiring. Spreads the generated devstack config
// (RPC URL + MVR overrides) into `createDAppKit` and overrides the
// burner-wallet initializer to drop the panel UI — token-studio's
// production bundle skips the ~30KB devstack panels. Exercises the
// tree-shake path so the claim stays verified across releases.

import { createDAppKit } from '@mysten/dapp-kit-react';
import { devstackDappKitConfig, devstackWalletInitializer } from './generated/dapp-kit-config.js';

const headlessInit = devstackWalletInitializer({ mountUI: false });

export const dAppKit = createDAppKit({
	...devstackDappKitConfig,
	walletInitializers: headlessInit ? [headlessInit] : [],
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
