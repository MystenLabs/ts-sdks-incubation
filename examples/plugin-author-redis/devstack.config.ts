// Demo devstack config consuming the local `./redis-plugin.ts`.
//
// Plugin-author-symmetry reference: the user-surface (this file) is
// identical to how a built-in plugin would be consumed — single root
// barrel import, lowercase factory, member-by-value composition.

import { defineDevstack, type AnyMember, type Stack } from '@mysten-incubation/devstack';
import { redis } from './redis-plugin.ts';

const stack: Stack<ReadonlyArray<AnyMember>> = defineDevstack(redis({ route: true }), {
	stackName: 'plugin-author-redis',
});

export default stack;
