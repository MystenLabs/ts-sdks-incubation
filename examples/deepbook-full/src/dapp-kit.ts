// User-owned dapp-kit wiring. Spreads the generated devstack config
// (RPC URL + MVR overrides + burner-wallet adapter) into
// `createDAppKit`. Add app-specific overrides on top of the spread.

import { createDAppKit } from '@mysten/dapp-kit-react';
import { devstackDappKitConfig } from './generated/dapp-kit-config.js';

export const dAppKit = createDAppKit({
	...devstackDappKitConfig,
});

(globalThis as { __devstackDAppKit__?: typeof dAppKit }).__devstackDAppKit__ = dAppKit;

declare module '@mysten/dapp-kit-react' {
	interface Register {
		dAppKit: typeof dAppKit;
	}
}
