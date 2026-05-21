import {
	defineDevstack,
	account,
	type AnyMember,
	type Stack,
} from '@mysten-incubation/devstack-rewrite';

const isProduction = process.env.NODE_ENV === 'production';

const alice = isProduction
	? account('alice', { kind: 'env', name: 'alice', key: 'ALICE_PRIVATE_KEY' })
	: account('alice');

const stack: Stack<ReadonlyArray<AnyMember>> = defineDevstack(alice);

export default stack;
