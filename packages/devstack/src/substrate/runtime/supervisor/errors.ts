// Supervisor-owned typed errors.
//
// Split out of the monolith. These shapes are part of the public
// supervisor surface (re-exported from `./index.ts`).

import { Cause, Data } from 'effect';

import type { DepGraphError } from '../lifecycle/index.ts';
import type {
	PluginAcquireFailed,
	RestartTargetMissing,
	UnknownDependency,
} from '../lifecycle/index.ts';

export class SupervisorBootError extends Data.TaggedError('SupervisorBootError')<{
	readonly cause: DepGraphError;
}> {}

export class SupervisorPostAcquireFailed extends Data.TaggedError('SupervisorPostAcquireFailed')<{
	readonly cause: Cause.Cause<unknown>;
}> {}

/**
 * A live `snapshot.restore` did not leave the stack in a good state.
 * Raised by the command-loop so the submitted-command completion fails
 * (and the dashboard mutation reports `{ ok: false, detail }`) instead
 * of resolving success off a half-applied tree. Carries the failing
 * cause — either the injected restore handler's failure (`reason:
 * 'handler'`, drain skipped) or a post-restore re-acquire that left
 * rows `failed` (`reason: 'reacquire'`).
 */
export class SupervisorRestoreFailed extends Data.TaggedError('SupervisorRestoreFailed')<{
	readonly reason: 'handler' | 'reacquire';
	readonly cause: Cause.Cause<unknown>;
}> {}

export type SupervisorError =
	| SupervisorBootError
	| SupervisorPostAcquireFailed
	| SupervisorRestoreFailed
	| PluginAcquireFailed
	| RestartTargetMissing
	| UnknownDependency;
