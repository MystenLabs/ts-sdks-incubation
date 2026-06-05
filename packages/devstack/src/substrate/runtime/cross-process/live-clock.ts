// Live wall-clock instance — shared between the cross-process lock and
// the on-disk `stack.lock` acquire loop.
//
// Cross-process safety is fundamentally a wall-time property: two OS
// processes can't share a virtual test clock, and the holder-liveness
// PID/start-time probes that reclaim stale locks measure real time. The
// `underLiveClock` wrapper pins acquire/release infrastructure (lock
// retry backoff, holder-liveness probes) to this clock so the lock
// primitive's semantics hold even when callers install a `TestClock`.
//
// SCOPE: applied ONLY to acquire/release infrastructure. The user body
// inherits the caller's clock so TestClock-driven tests can virtualize
// `Effect.sleep` inside lock-protected sections without being forced to
// wall time. The lock primitives themselves still get the live clock
// for their wall-time invariants. The SHORT-CRITICAL-SECTION discipline
// from the architecture is enforced by code review rather than by
// forcing wall time on every body.

import { Clock, Duration, Effect } from 'effect';

/** Live system Clock instance. Used by the cross-process lock and the
 *  on-disk `stack.lock` acquire loop so the lock's wall-time invariants
 *  (acquire-timeout, exponential backoff, holder-liveness probes) hold
 *  even when the surrounding fiber has a `TestClock` installed. */
export const LIVE_CLOCK: Clock.Clock = {
	currentTimeMillis: Effect.sync(() => Date.now()),
	currentTimeMillisUnsafe: () => Date.now(),
	currentTimeNanos: Effect.sync(() => BigInt(Date.now()) * 1_000_000n),
	currentTimeNanosUnsafe: () => BigInt(Date.now()) * 1_000_000n,
	sleep: (duration: Duration.Duration) =>
		Effect.callback<void>((resume) => {
			const ms = Duration.toMillis(duration);
			if (ms <= 0) {
				resume(Effect.void);
				return;
			}
			const handle = setTimeout(() => resume(Effect.void), ms);
			return Effect.sync(() => clearTimeout(handle));
		}),
};

/** Provide the live Clock for `effect`, overriding any inherited
 *  `TestClock` for the duration of the wrapped effect.
 *
 *  SCOPE: applied ONLY to the acquire/release infrastructure (OS-advisory
 *  lock retry backoff, holder-liveness PID probes). Callers MUST NOT
 *  wrap user-supplied body effects — those should inherit the caller's
 *  clock so TestClock-driven tests can adjust virtual time inside
 *  critical sections. See `cross-process/stack-lock.ts` for the discipline. */
export const underLiveClock = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => Effect.provideService(effect, Clock.Clock, LIVE_CLOCK);
