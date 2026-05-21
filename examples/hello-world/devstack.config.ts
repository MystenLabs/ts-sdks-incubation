// hello-world — the smallest possible devstack example.
//
// Node-only. No frontend, no package, no wallet. Sui + two accounts —
// the baseline for verifying the engine boots end-to-end against a
// fresh runtime root.

import {
	defineDevstack,
	sui,
	account,
	type AnyMember,
	type Stack,
} from '@mysten-incubation/devstack';

const alice = account('alice');
const bob = account('bob');

const stack: Stack<ReadonlyArray<AnyMember>> = defineDevstack(sui(), alice, bob, {
	stackName: 'hello-world',
});

export default stack;
