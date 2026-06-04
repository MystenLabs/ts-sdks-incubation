// Stack supervisor — public surface.
//
// Architecture § Engine / supervisor split:
//   "Stack supervisor (L0): the outer driver — boot identity, consult
//   network resolver, run scheduler, fire shutdown finalizers, emit
//   lifecycle events."
//
// The supervisor is split into per-concern modules (backlog #38):
//   - `wiring.ts`             — substrate-wiring helpers (publish,
//                               setCyclePhase, projectionLevel,
//                               withEventPublishingLogger,
//                               buildTransitionEmitter, OptionalService).
//   - `errors.ts`             — typed error surface.
//   - `types.ts`              — `SupervisedStack` runtime-boundary shape.
//   - `state.ts`              — shared-state record threaded through the
//                               per-concern modules.
//   - `contribution-dispatcher.ts` — the closed, typed post-start
//                               contribution seam (five methods, one per
//                               built-in decl kind) the supervisor
//                               replays each plugin's ctx buffer through.
//   - `acquire-node.ts`       — per-plugin acquire pipeline +
//                               buildRegistry + acquireFullGraph + the
//                               static dispatch (dual-catch).
//   - `teardown.ts`           — slice teardown + selective restart.
//   - `background-tasks.ts`   — injected command handler, snapshot
//                               capture, stack restart, post-acquire
//                               hook.
//   - `shutdown.ts`           — shutdown.requested / stack.stop and
//                               shutdown.hardKillRequested branches
//                               (Bug #13 uninterruptible guard).
//   - `command-loop.ts`       — single-consumer command-channel
//                               dispatcher.
//   - `start-supervisor.ts`   — startSupervisor + supervise +
//                               runToShutdown.

export {
	SupervisorBootError,
	SupervisorPostAcquireFailed,
	SupervisorRestoreFailed,
} from './errors.ts';
export type { SupervisorError } from './errors.ts';
export type { SupervisedStack } from './types.ts';
export type {
	SupervisorCommandHandler,
	SupervisorCommandHandlerContext,
	SupervisorPostAcquireContext,
	SupervisorPostAcquireHook,
} from './state.ts';
export { runToShutdown, startSupervisor, supervise } from './start-supervisor.ts';
export type {
	SupervisorHandle,
	SupervisorStartup,
	SupervisorStartupOptions,
} from './start-supervisor.ts';

// The closed contribution-dispatch seam: production callers build it via
// `buildProductionContributionDispatcher` (L3) and pass it into
// `startSupervisor`; bare smoke tests use the no-op default.
export {
	noopContributionDispatcher,
	type ContributionDispatcher,
	type ContributionDispatchContext,
} from './contribution-dispatcher.ts';
