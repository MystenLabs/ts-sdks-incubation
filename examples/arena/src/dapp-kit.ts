import { createWalletApp } from '@mysten-incubation/devstack/react';
import { manifest } from './generated/manifest.js';

export const { dAppKit } = createWalletApp({ manifest });

declare module '@mysten/dapp-kit-react' {
	interface Register {
		dAppKit: typeof dAppKit;
	}
}
