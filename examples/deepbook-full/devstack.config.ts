import {
	defineDevstack,
	account,
	wallet,
	deepbook,
	type AnyMember,
	type Stack,
} from '@mysten-incubation/devstack';

const alice = account('alice');
const bob = account('bob');

const dex = deepbook({
	mode: 'known',
	network: 'testnet',
});

const stack: Stack<ReadonlyArray<AnyMember>> = defineDevstack(
	alice,
	bob,
	dex,
	wallet({ accounts: 'all' }),
);

export default stack;
