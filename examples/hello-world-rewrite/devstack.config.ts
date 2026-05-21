// hello-world — the smallest possible devstack example.
//
// Node-only. No frontend, no package, no wallet. Sui + two accounts —
// the baseline for verifying the engine boots end-to-end against a
// fresh runtime root.

import { defineDevstack, sui, account } from '@mysten-incubation/devstack-rewrite';

const alice = account('alice');
const bob = account('bob');

export default defineDevstack(sui(), alice, bob, { stackName: 'hello-world-rewrite' });
