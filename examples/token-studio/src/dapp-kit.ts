import { createDevstackDappKit } from '@mysten-incubation/devstack/react';
import { manifest } from './generated/manifest.js';

// `mountUI: false` skips the dynamic panels import — production bundles
// for token-studio drop the ~30KB devstack panels code. Exercises the
// tree-shake path so the claim stays verified across releases.
export const { dAppKit } = await createDevstackDappKit({ manifest, mountUI: false });

declare module '@mysten/dapp-kit-react' {
	interface Register {
		dAppKit: typeof dAppKit;
	}
}
