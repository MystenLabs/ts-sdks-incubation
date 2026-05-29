import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	account,
	defineDevstack,
	localPackage,
	sui,
	type Stack,
	wallet,
} from '@mysten-incubation/devstack';

const HERE = dirname(fileURLToPath(import.meta.url));

// Fork testnet. The fork faucet impersonates a default large-reserve
// "whale" address (override via `faucet: { whale: '0x…' }`) and transfers
// SUI from it, so ephemeral accounts auto-fund with NO pre-funded
// addresses and NO environment variables. `pnpm dev` just works.
const forkedNetwork = sui({
	mode: 'fork',
	upstream: 'testnet',
});

// Ephemeral accounts get a real local keypair and are auto-funded from the
// fork faucet. (To instead drive a specific on-chain address, use
// `account('name', { kind: 'impersonate', address: '0x…' })` — fork mode
// submits empty-signature transactions on its behalf.)
const publisher = account('publisher', { kind: 'ephemeral' });
const alice = account('alice', { kind: 'ephemeral' });
const bob = account('bob', { kind: 'ephemeral' });

const greeting = localPackage('greeting', {
	sourcePath: resolve(HERE, 'move', 'greeting'),
	publisher,
	capture: { boardId: '::board::Board' },
});
const devWallet = wallet({
	accounts: [publisher, alice, bob],
});
const stack: Stack = defineDevstack({
	members: [forkedNetwork, greeting, devWallet],
	stackName: 'fork-greeting',
});

export default stack;
