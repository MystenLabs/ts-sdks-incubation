// Minimal Effect program for effect-app-rewrite.
//
// The body that yields the resolved `SuiClient` + `AccountValue` and
// runs the program against a real (dev) or remote-RPC (prod) stack
// is BLOCKED on the `Stack` runnable handle (api.run-stack /
// `runStack(stack)`). Once that primitive lands, this file becomes:
//
//     import { runStack } from '@mysten-incubation/devstack/runtime';
//     runMain(program.pipe(Effect.provide(runStack(stack).layer)));
//
// Today's stub-path proves the config typechecks + composes.

import { Effect } from 'effect';
import { runMain } from '@effect/platform-node/NodeRuntime';

import stack from '../devstack.config.ts';

if (import.meta.url === `file://${process.argv[1]}`) {
	runMain(
		Effect.log(`effect-app-rewrite composed (stack: ${stack.options.stackName ?? '<inferred>'})`),
	);
}
