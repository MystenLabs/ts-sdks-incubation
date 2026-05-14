import { createDevstackDappKit } from '@mysten-incubation/devstack-effect/dapp-kit';
import { manifest } from './generated/manifest.js';

export const { dAppKit } = await createDevstackDappKit({ manifest });

declare module '@mysten/dapp-kit-react' {
	interface Register {
		dAppKit: typeof dAppKit;
	}
}
