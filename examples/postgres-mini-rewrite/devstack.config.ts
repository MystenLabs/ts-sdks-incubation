// postgres-mini — node-only smoke test for the postgres plugin.
//
// Two logical databases on a single postgres container. The plugin
// emits a `Codegenable` decl materializing `src/generated/
// postgres-connection.ts` with one URL per database.

import { defineDevstack, sui, account, postgres } from '@mysten-incubation/devstack-rewrite';

const alice = account('alice');
const bob = account('bob');

const pg = postgres({ databases: ['app', 'devstack'] });

export default defineDevstack(sui(), alice, bob, pg, {
	stackName: 'postgres-mini-rewrite',
});
