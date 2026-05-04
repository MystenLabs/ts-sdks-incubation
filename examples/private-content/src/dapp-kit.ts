import { createWalletApp } from '@mysten-incubation/devstack/app-setup';
import { manifest } from 'virtual:devstack-manifest';

export const { dAppKit } = createWalletApp({ manifest });

declare module '@mysten/dapp-kit-react' {
	interface Register {
		dAppKit: typeof dAppKit;
	}
}
