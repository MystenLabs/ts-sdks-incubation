// Shutdown branches.
//
// Two paths handled here:
//
//   - `shutdown.requested` / `stack.stop` — graceful drain. Teardown +
//     the deferred resolution live in one `Effect.uninterruptible`
//     block (Bug #13 fix, regression test in
//     `test/substrate/runtime/supervisor-hard-shutdown.test.ts`).
//
//   - `shutdown.hardKillRequested` — escalated shutdown. The graceful
//     teardown is owned by the supervisor's scope-close finalizer
//     (which is already uninterruptible); this branch atomically
//     signals `shutdownComplete` + emits the fatal log so a third SIGINT
//     can't slip an Effect-level interrupt between the two writes.
//     `process.exit` from `signals.ts` IS still a hard kill — that
//     escape hatch is intentional double-Ctrl-C semantics.

import { Deferred, Effect, Ref } from 'effect';

import type { EngineCommand } from '../../events.ts';
import {
	planFullDrain,
} from '../lifecycle/index.ts';
import {
	requestBackgroundSnapshotInterrupt,
	requestBackgroundStackRestartInterrupt,
} from './background-tasks.ts';
import type { SupervisorState } from './state.ts';
import { publish, setCyclePhase } from './wiring.ts';
import { teardownKeys } from './teardown.ts';

export const handleShutdownRequested = (
	deps: SupervisorState,
): Effect.Effect<void, never, never> =>
	Effect.gen(function* () {
		const { graph, registry, ref, shutdownLatch, logger } = deps;
		yield* requestBackgroundSnapshotInterrupt(deps);
		yield* setCyclePhase(ref, 'shutting-down');
		yield* Ref.set(shutdownLatch, true);
		yield* logger.log('supervisor', null, {
			level: 'info',
			message: 'shutdown requested',
		});
		yield* requestBackgroundStackRestartInterrupt(deps);
		yield* setCyclePhase(ref, 'shutting-down');
		const plan = planFullDrain(graph);
		// Uninterruptible covers the Effect-level interrupt a second
		// SIGINT would inject between teardownKeys and the
		// shutdownComplete signal — scope close racing the in-loop
		// teardown leaks Docker containers. The deferred resolution
		// lives in the same block so callers blocked on
		// `awaitShutdown` only release AFTER teardown has run.
		// The signal handler's `process.exit` (signals.ts:75-102) is
		// still a hard kill — that's intentional; double-Ctrl-C is
		// the operator asking for abort.
		yield* Effect.uninterruptible(
			Effect.gen(function* () {
				yield* teardownKeys(graph, registry, plan.teardownOrder);
				yield* Effect.yieldNow;
				yield* Deferred.succeed(deps.shutdownComplete, void 0).pipe(Effect.ignore);
			}),
		);
	});

export const handleHardKillRequested = (
	deps: SupervisorState,
	cmd: Extract<EngineCommand, { readonly tag: 'shutdown.hardKillRequested' }>,
): Effect.Effect<void, never, never> =>
	Effect.gen(function* () {
		const { ref, hub, shutdownLatch, logger } = deps;
		yield* requestBackgroundSnapshotInterrupt(deps);
		yield* publish(ref, hub, {
			tag: 'shutdown.escalated',
			signal: cmd.signal,
			exitCode: cmd.exitCode,
			at: cmd.at,
		});
		yield* setCyclePhase(ref, 'shutting-down');
		yield* Ref.set(shutdownLatch, true);
		yield* requestBackgroundStackRestartInterrupt(deps);
		yield* setCyclePhase(ref, 'shutting-down');
		// Hard-kill path: graceful teardown is owned by the
		// scope-close finalizer (start-supervisor.ts addFinalizer) which
		// already runs uninterruptibly. We only need to atomically signal
		// `shutdownComplete` + emit the fatal log so a third SIGINT
		// can't slip an Effect-level interrupt between the two.
		// `process.exit` from signals.ts:75-102 IS still the hard
		// kill — that escape hatch is intentional.
		yield* Effect.uninterruptible(
			Effect.gen(function* () {
				yield* Deferred.succeed(deps.shutdownComplete, void 0).pipe(Effect.ignore);
				yield* logger.log('supervisor', null, {
					level: 'fatal',
					message: `shutdown escalated by ${cmd.signal}`,
					fields: { signal: cmd.signal, exitCode: cmd.exitCode },
				});
			}),
		);
	});
