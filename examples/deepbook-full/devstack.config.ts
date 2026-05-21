import {
	defineDevstack,
	account,
	wallet,
	deepbook,
	type AnyMember,
	type Stack,
} from '@mysten-incubation/devstack';

const publisher = account('publisher');
const alice = account('alice');
const bob = account('bob');

const dex = deepbook({
	mode: 'local',
	publisher,
});

const stack: Stack<ReadonlyArray<AnyMember>> = defineDevstack(
	publisher,
	alice,
	bob,
	dex,
	wallet({ accounts: 'all' }),
);

export default stack;
