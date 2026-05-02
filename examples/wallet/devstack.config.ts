// Wallet app — multi-coin wallet UI + DeepBook v3 swap. Coin publishes
// + pool/order seeds live in walletPlugin; deepbook is imported via the
// shared `imports` plugin.

import {
	codegen,
	defineDevstackConfig,
	frontend,
	imports,
	sui,
	walletServer,
} from '@mysten-incubation/devstack';
import { walletPlugin } from './walletPlugin.ts';

export default defineDevstackConfig({
	app: 'wallet',
	accounts: {
		publisher: {},
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
			rpcPort: 9376,
			faucetPort: 9765,
		}),
		imports({
			packages: [
				{
					name: 'deepbook',
					// Pinned to v7.0.0 (rev 190ab8fd, also tagged testnet-v19.0.0).
					repo: 'MystenLabs/deepbookv3',
					rev: 'v7.0.0',
					subdir: 'packages/deepbook',
					capture: {
						registryId: '::registry::Registry',
						adminCapId: '::registry::DeepbookAdminCap',
					},
				},
			],
		}),
		walletPlugin(),
		codegen(),
		walletServer({ port: 9420 }),
		frontend({ port: 5174 }),
	],
});
