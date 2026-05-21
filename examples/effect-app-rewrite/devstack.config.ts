import { defineDevstack, account } from '@mysten-incubation/devstack-rewrite';

const isProduction = process.env.NODE_ENV === 'production';

export const alice = isProduction
	? account('alice', { kind: 'env', name: 'alice', var: 'ALICE_PRIVATE_KEY' })
	: account('alice');

export default defineDevstack(alice);
