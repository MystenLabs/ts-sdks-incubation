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

// Coin auto-discovery surfaces the `STUDIO` coin under
// `pkg.coins.STUDIO` (the symbol declared in the Move source's
// `coin::create_currency` call). The TreasuryCap and CoinMetadata
// object ids land on `pkg.coins.STUDIO.{treasuryCapId, metadataId}`;
// the codegen-emitted `generated/coins.ts` (P5) projects the same
// fields into a typed app-level record the frontend reads.
const managedCoin = Package('managed_coin', MANAGED_COIN_DIR, { signer: alice });

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
