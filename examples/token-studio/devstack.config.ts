// Token-studio app — single managed coin with TreasuryCap-gated minting.
// Alice doubles as publisher (holds the TreasuryCap so the UI's
// "TreasuryCap holder" badge resolves).

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	codegen,
	defineDevstackConfig,
	frontend,
	publishMove,
	sui,
	walletServer,
} from '@mysten-incubation/devstack';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANAGED_COIN_DIR = resolve(HERE, 'move/managed_coin');

export default defineDevstackConfig({
	app: 'token-studio',
	accounts: {
		alice: {},
		bob: {},
		carol: {},
	},
	plugins: [
		// Plugin port options are hints to the per-stack port allocator;
		// the allocator picks any free port if a sibling stack has the
		// preferred port claimed.
		sui({ version: 'devnet-v1.71.0', rpcPort: 9059, faucetPort: 9984 }),
		codegen(),
		walletServer({ port: 9422 }),
		frontend({ port: 5173 }),
	],
	// App-level setup: publish the managed_coin Move package as alice
	// (publisher = TreasuryCap holder; the UI gates the mint card on
	// `address === accounts.alice`). Captures TreasuryCap +
	// CoinMetadata + UpgradeCap so the UI can mint via the cap and
	// link the metadata badge.
	setup: [
		publishMove({
			name: 'managedCoin',
			needs: ['sui.accounts'],
			registryAs: 'managed_coin',
			path: MANAGED_COIN_DIR,
			publisher: 'alice',
			capture: {
				treasuryCapId: '::coin::TreasuryCap<',
				metadataId: '::coin::CoinMetadata<',
				upgradeCapId: '0x2::package::UpgradeCap',
			},
			onPublished: (ctx, result) => {
				ctx.registry.tokens.register({
					name: 'managed_coin',
					type: `${result.packageId}::managed_coin::MANAGED_COIN`,
					decimals: 6,
				});
			},
		}),
	],
});
