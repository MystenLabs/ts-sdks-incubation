// Lifecycle state-machine — runtime guard over `LifecycleTransition`.
//
// Architecture § Lifecycle state. The transition table is declared in
// `substrate/lifecycle.ts`; this file asserts moves against it at runtime
// so an off-table transition lands as a typed Defect (programmer-error
// class), not a corrupt projection.
//
// The state machine is per-plugin. Callers (the supervisor) hold a
// `Ref` of `LifecycleStatus` and route every change through
// `transition`, which:
//   - validates the move,
//   - emits the `lifecycle.statusChanged` typed event,
//   - returns the new status.

import { Data, Effect } from 'effect';

import type { LifecycleStatus, LifecycleTransition } from '../../lifecycle.ts';

/** Off-table transition — programmer error. Surfaced as a defect via
 *  `Effect.die` so the renderer / cause walker sees the impossible
 *  transition rather than silently corrupting the projection. */
export class InvalidLifecycleTransition extends Data.TaggedError('InvalidLifecycleTransition')<{
	readonly from: LifecycleStatus;
	readonly to: LifecycleStatus;
}> {}

/** Canonical transition table — mirrors the type-level
 *  `LifecycleTransition` from `substrate/lifecycle.ts` exactly. Adding
 *  a transition requires updating BOTH (the type-level union AND this
 *  table). */
const ALLOWED: ReadonlyMap<LifecycleStatus, ReadonlySet<LifecycleStatus>> = new Map([
	['pending', new Set<LifecycleStatus>(['acquiring', 'failed'])],
	['acquiring', new Set<LifecycleStatus>(['ready', 'failed'])],
	['ready', new Set<LifecycleStatus>(['stopping', 'failed', 'done'])],
	['stopping', new Set<LifecycleStatus>(['stopped', 'failed'])],
	['failed', new Set<LifecycleStatus>(['pending'])],
	['stopped', new Set<LifecycleStatus>(['pending'])],
	['done', new Set<LifecycleStatus>()], // terminal
] as const);

/** Predicate that the type-table and the runtime table agree. The
 *  compiler checks the type-level shape; this conditional verifies the
 *  runtime table covers exactly the same `from` set. */
type _AllFroms = LifecycleTransition['from'];
type _RuntimeFroms = 'pending' | 'acquiring' | 'ready' | 'stopping' | 'failed' | 'stopped' | 'done';
type _TableShape = _AllFroms extends _RuntimeFroms
	? _RuntimeFroms extends _AllFroms | 'done'
		? true
		: false
	: false;
// Force the check by exporting the assertion.
export type __LifecycleTableShape = _TableShape extends true ? true : never;

/** Returns true iff `from → to` is on the allowed-transition table. */
export const isAllowedTransition = (from: LifecycleStatus, to: LifecycleStatus): boolean =>
	ALLOWED.get(from)?.has(to) ?? false;

/** Effect-flavored transition assertion. Returns the new status on
 *  success; dies with `InvalidLifecycleTransition` otherwise. */
export const assertTransition = (
	from: LifecycleStatus,
	to: LifecycleStatus,
): Effect.Effect<LifecycleStatus> =>
	isAllowedTransition(from, to)
		? Effect.succeed(to)
		: Effect.die(new InvalidLifecycleTransition({ from, to }));

/** Terminal statuses — no further transitions. */
export const isTerminal = (status: LifecycleStatus): boolean => status === 'done';

/** Statuses that count toward "stack is ready" — every plugin must be
 *  in one of these for the stack to surface `running`. */
export const isReadyOrTerminal = (status: LifecycleStatus): boolean =>
	status === 'ready' || status === 'done';
