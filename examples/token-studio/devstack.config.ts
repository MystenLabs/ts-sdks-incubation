// Token-studio app — single managed coin with TreasuryCap-gated minting.
// Alice doubles as publisher (holds the TreasuryCap so the UI's
// "TreasuryCap holder" badge resolves).

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineDevstackConfig } from '@mysten-incubation/devstack-next';
import {
	publishMove,
	publishViaSuiCli,
	viteDevServer,
} from '@mysten-incubation/devstack-next/helpers';
import { pickCreatedByTypeSuffix } from '@mysten-incubation/devstack-next/helpers';
import {
	accounts,
	manifest,
	registerCoin,
	sui,
	walletApp,
} from '@mysten-incubation/devstack-next/plugins';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANAGED_COIN_DIR = resolve(HERE, 'move/managed_coin');

const a = accounts({ specs: { alice: {}, bob: {}, carol: {} } });

// Publish as alice — same account holds the TreasuryCap (UI gates
// minting on `address === accounts.alice`). Capture surfaces the
// TreasuryCap + CoinMetadata + UpgradeCap object ids alongside
// `packageId` on the manifest's `package.captured` map.
const managedCoinPublish = publishMove({
	name: 'managed_coin',
	path: MANAGED_COIN_DIR,
	signer: a.pool.get('signer', { name: 'alice' }),
	publish: (ctx) =>
		publishViaSuiCli(ctx, {
			capture: (changes) => {
				const out: Record<string, string> = {};
				const t = pickCreatedByTypeSuffix(changes, '::coin::TreasuryCap<');
				if (t !== undefined) out.treasuryCapId = t;
				const md = pickCreatedByTypeSuffix(changes, '::coin::CoinMetadata<');
				if (md !== undefined) out.metadataId = md;
				const up = pickCreatedByTypeSuffix(changes, '0x2::package::UpgradeCap');
				if (up !== undefined) out.upgradeCapId = up;
				return out;
			},
		}),
});

const managedCoinReg = registerCoin({
	name: 'managed_coin',
	package: managedCoinPublish.get('package'),
	module: 'managed_coin',
	type: 'MANAGED_COIN',
	decimals: 6,
});

const m = manifest({
	packages: [managedCoinPublish.get('package')],
	accounts: [
		a.pool.get('account', { name: 'alice' }),
		a.pool.get('account', { name: 'bob' }),
		a.pool.get('account', { name: 'carol' }),
	],
	coins: [managedCoinReg.get('coin')],
});

const wallet = walletApp.create({
	accounts: [
		{ name: 'alice', signer: a.pool.get('signer', { name: 'alice' }) },
		{ name: 'bob', signer: a.pool.get('signer', { name: 'bob' }) },
		{ name: 'carol', signer: a.pool.get('signer', { name: 'carol' }) },
	],
});

const dev = viteDevServer({
	gates: [managedCoinPublish.get('package'), wallet.get('full')],
});

export default defineDevstackConfig({
	stack: [
		sui.create({ network: 'localnet' }),
		a.pool,
		a.fund,
		managedCoinPublish,
		managedCoinReg,
		m,
		wallet,
		dev,
	],
});
