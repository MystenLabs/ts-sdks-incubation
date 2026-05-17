// Token-studio app — single managed coin with TreasuryCap-gated minting.
// Alice doubles as publisher (holds the TreasuryCap so the UI's
// "TreasuryCap holder" badge resolves).

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Account, Codegen, Dev, devstack, Package, Wallet } from '@mysten-incubation/devstack';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANAGED_COIN_DIR = resolve(HERE, 'move/managed_coin');

const alice = Account('alice');
const bob = Account('bob');
const carol = Account('carol');

// `capture:` keyed form maps result-key → type-substring. Each entry
// picks the first created object whose type contains the substring and
// surfaces it on the resolved Package as `pkg.captured.<key>`. The
// token-studio frontend reads these ids to mint / burn / freeze the
// managed coin — without capturing them at publish time, every UI
// action would have to walk the publisher's owned objects.
const managedCoin = Package('managed_coin', MANAGED_COIN_DIR, {
	signer: alice,
	capture: {
		treasuryCapId: '::coin::TreasuryCap<',
		metadataId: '::coin::CoinMetadata<',
		upgradeCapId: '0x2::package::UpgradeCap',
	},
	coins: [{ name: 'managed_coin', module: 'managed_coin', type: 'MANAGED_COIN', decimals: 6 }],
});

const wallet = Wallet({
	accounts: [alice, bob, carol],
	allowedOrigins: ['http://dev.token-studio.localhost:5175', 'http://localhost:5173'],
});

const codegen = Codegen({ packages: [managedCoin] });

const dev = Dev({
	command: 'pnpm',
	args: ['exec', 'vite', '--host', '0.0.0.0', '--strictPort', '--port', '{port}'],
	port: 5173,
	needs: [managedCoin, wallet, codegen],
});

export default devstack(alice, bob, carol, managedCoin, wallet, codegen, dev);
