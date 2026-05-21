// postgres-mini — node-only smoke test for the postgres plugin.
//
// Two logical databases on a single postgres container. The plugin
// emits a `Codegenable` decl materializing `src/generated/
// postgres-connection.ts` with one URL per database.

import {
	defineDevstack,
	sui,
	account,
	postgres,
	type AnyMember,
	type Stack,
} from '@mysten-incubation/devstack';

const alice = account('alice');
const bob = account('bob');

const pg = postgres({ databases: ['app', 'devstack'] });

const stack: Stack<ReadonlyArray<AnyMember>> = defineDevstack(sui(), alice, bob, pg, {
	stackName: 'postgres-mini',
});

export default stack;
