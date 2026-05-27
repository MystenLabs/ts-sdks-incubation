// Cross-process advisory lock — typed service + two Layers.
//
// Architecture § "What's collapsed" — three different locks in the
// old codebase consolidate to ONE lock primitive. The on-disk
// implementation (`stack.lock` via O_EXCL + PID/start-time liveness)
// lives at `./cross-process/stack-lock.ts` as a free function; THIS
// module wraps it in a Layer satisfying the typed
// `CrossProcessLock` service so consumers (state-store, cache,
// etc.) yield ONE name and let wiring decide
// whether they get the OS-advisory implementation or the in-process
// semaphore.
//
// The state-store uses this for read-modify-write critical sections
// where two processes might race to mutate the JSON. The lock is
// SHORT-CRITICAL-SECTION: hold across read+modify+atomic-write,
// release immediately. Long lifetimes (whole-stack lifecycle) belong
// to a separate lease, not this lock.

import { Clock, Context, Duration, Effect, Layer, Semaphore } from 'effect';

import {
	acquireStackLock,
	type StackLockIoError,
	type StackLockTimeoutError,
} from './cross-process/stack-lock.ts';
import { StackPathsService } from './paths.ts';

/** Live system Clock instance. The lock layers provide this for the
 *  body Effect so the lock's wall-time invariants (timeouts, backoff,
 *  the SHORT-CRITICAL-SECTION discipline from the architecture) hold
 *  even when the surrounding fiber has a `TestClock` installed.
 *
 *  Cross-process safety is fundamentally a wall-time property — two
 *  OS processes can't share a virtual test clock, and the holder
 *  liveness probes that reclaim stale locks measure real PID
 *  start-time. Body code running under TestClock that suspends on
 *  `Effect.sleep` would hold the lock indefinitely from the system's
 *  point of view, starving cross-process waiters; pinning the body
 *  to the live clock keeps the lock's semantics coherent. */
const LIVE_CLOCK: Clock.Clock = {
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
 *  `TestClock` for the duration of the lock body. See LIVE_CLOCK. */
const underLiveClock = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
	Effect.provideService(effect, Clock.Clock, LIVE_CLOCK);

/**
 * Cross-process exclusive lock. `withLock(effect)` runs `effect`
 * with the lock held — semantically `Semaphore.withPermits(1)` plus
 * cross-process fanout via the OS.
 *
 * Acquisition is cancellable: an interrupt while waiting for the
 * lock unwinds without acquiring. Acquisition while another holder
 * dies (PID cleanup) is the lock primitive's job, not the
 * state-store's.
 *
 * Acquisition surfaces `StackLockTimeoutError` (peer contention
 * exceeded the acquire window) and `StackLockIoError` (disk failure
 * during acquire) in the `E` channel alongside the body's own errors.
 * Consumers MUST handle these typed failures — either degrade
 * gracefully via `Effect.catchTag` or widen their own `E` channel.
 * Surfacing them as defects (the prior `Effect.orDie` shape) was a
 * bug: a busy peer should not crash the supervisor's fiber. The
 * in-process Layer's typed `E` channel matches `never` for the
 * acquire surface so test wiring stays interchangeable with prod
 * (the union absorbs `never` cleanly).
 */
export interface CrossProcessLockShape {
	readonly withLock: <A, E, R>(
		effect: Effect.Effect<A, E, R>,
	) => Effect.Effect<A, E | StackLockTimeoutError | StackLockIoError, R>;
}

export class CrossProcessLock extends Context.Service<CrossProcessLock, CrossProcessLockShape>()(
	'@devstack/substrate/CrossProcessLock',
) {}

/**
 * Production Layer — backed by `stack.lock` (O_EXCL + PID/start-time
 * liveness) per architecture § Cross-process safety protocol. Yields
 * `StackPathsService` to know which on-disk lock file represents
 * this stack; every `withLock` runs the body inside an
 * `Effect.scoped` that acquires + releases the OS-advisory lock.
 *
 * An in-process `Semaphore` sits in front of the disk acquire so
 * SAME-process concurrent yielders of `CrossProcessLock` serialize
 * before competing for the disk artifact. Without this, two fibers
 * in the same process race each other to `O_EXCL`-write the same
 * path; one wins, the other times out unnecessarily after backoff.
 *
 * Acquisition surfaces `StackLockTimeoutError` / `StackLockIoError`
 * in the `E` channel per `CrossProcessLockShape`; consumers catch
 * via `Effect.catchTag` or widen their own surface. The earlier
 * `Effect.orDie` here converted legitimate peer-contention timeouts
 * into supervisor defects — that was wrong; busy peers must be
 * recoverable through the typed channel.
 */
export const layerCrossProcessLockFlock: Layer.Layer<CrossProcessLock, never, StackPathsService> =
	Layer.effect(
		CrossProcessLock,
		Effect.gen(function* () {
			const paths = yield* StackPathsService;
			const semaphore = yield* Semaphore.make(1);
			const lockPath = paths.stackLockFile;
			return CrossProcessLock.of({
				withLock: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
					underLiveClock(
						semaphore.withPermits(1)(
							Effect.scoped(
								Effect.gen(function* () {
									yield* acquireStackLock(lockPath);
									return yield* effect;
								}),
							),
						),
					),
			});
		}),
	);

/**
 * In-process-only fallback. Useful for tests and single-process dev
 * loops where no other OS process can interleave with this
 * supervisor. Production wiring uses `layerCrossProcessLockFlock`.
 *
 * Documented in the architecture as acceptable for "no cross-process
 * safety needed" use cases (one-shot CLI invocations, unit tests
 * with a tmpdir per-test, etc.). NOT safe under `pnpm dev` where
 * A dev server and devstack share a runtime root.
 */
export const layerCrossProcessLockInProcess: Layer.Layer<CrossProcessLock> = Layer.effect(
	CrossProcessLock,
	Effect.gen(function* () {
		const semaphore = yield* Semaphore.make(1);
		return CrossProcessLock.of({
			withLock: (effect) => underLiveClock(semaphore.withPermits(1)(effect)),
		});
	}),
);
