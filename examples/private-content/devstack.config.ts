// Private-content app — Seal-encrypted file vault on top of sui-localnet,
// walrus, and a single Open-mode seal key server. The vault Move package
// is owned by privateContentPlugin().
//
// First `pnpm --filter private-content localnet:up` builds two heavy local
// arm64 images: walrus-service (~10 min) and seal (~5–8 min). Subsequent
// ups hit Docker layer cache and complete in seconds.

import {
	codegen,
	defineDevstackConfig,
	seal,
	sui,
	vite,
	walrus,
} from '@mysten-incubation/devstack';
import { privateContentPlugin } from './privateContentPlugin.js';

export default defineDevstackConfig({
	app: 'private-content',
	accounts: {
		publisher: {},
		alice: {},
		bob: {},
	},
	plugins: [
		sui({
			version: 'devnet-v1.71.0',
			// Keep port assignments off 9000/9123 so arena, token-studio, wallet,
			// and private-content can coexist (each app's sui plugin default is
			// 9000 — first to bind wins).
			rpcPort: 9482,
			faucetPort: 9871,
		}),
		walrus(),
		seal(),
		privateContentPlugin(),
		codegen(),
		vite({ port: 5175 }),
	],
});
