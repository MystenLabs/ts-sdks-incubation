// Token-studio app — single managed coin with TreasuryCap-gated minting.
// Alice doubles as publisher (holds the TreasuryCap so the UI's
// "TreasuryCap holder" badge resolves); see `tokenStudioPlugin.ts`.

import {
	codegen,
	defineDevstackConfig,
	frontend,
	sui,
	walletServer,
} from '@mysten-incubation/devstack';
import { tokenStudioPlugin } from './tokenStudioPlugin.ts';

export default defineDevstackConfig({
	app: 'token-studio',
	accounts: {
		alice: {},
		bob: {},
		carol: {},
	},
	plugins: [
		sui({
			version: 'devnet-v1.71.0',
			// Keep port assignments off 9000/9123 so arena, token-studio, and
			// wallet can coexist (each app's sui plugin default is 9000 — first
			// to bind wins).
			rpcPort: 9059,
			faucetPort: 9984,
		}),
		tokenStudioPlugin(),
		codegen(),
		walletServer({ port: 9422 }),
		frontend({ port: 5173 }),
	],
});
