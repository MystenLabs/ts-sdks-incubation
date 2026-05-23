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

const requireForkAddress = (key: string): string => {
	const value = process.env[key]?.trim();
	if (value === undefined || value.length === 0) {
		throw new Error(`${key} must be set to a funded testnet address before running fork-greeting.`);
	}
	return value;
};

const publisherAddress = requireForkAddress('FORK_GREETING_PUBLISHER_ADDRESS');
const aliceAddress = requireForkAddress('FORK_GREETING_ALICE_ADDRESS');
const bobAddress = requireForkAddress('FORK_GREETING_BOB_ADDRESS');

const forkedNetwork = sui({
	mode: 'fork',
	upstream: 'testnet',
	seed: { addresses: [publisherAddress, aliceAddress, bobAddress] },
});
const publisher = account('publisher', {
	kind: 'impersonate',
	address: publisherAddress,
});
const alice = account('alice', {
	kind: 'impersonate',
	address: aliceAddress,
});
const bob = account('bob', {
	kind: 'impersonate',
	address: bobAddress,
});

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
