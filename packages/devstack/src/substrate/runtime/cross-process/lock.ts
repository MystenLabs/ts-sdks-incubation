// Cross-process advisory lock — typed service + two Layers.
//
// Architecture § "What's collapsed" — three different locks in the
// old codebase consolidate to ONE lock primitive. The on-disk
// implementation (`stack.lock` via O_EXCL + PID/start-time liveness)
// lives at `./stack-lock.ts` as a free function; THIS module wraps
// it in a Layer satisfying the typed `CrossProcessLock` service so
// consumers (state-store, cache, etc.) yield ONE name and let
// wiring decide whether they get the OS-advisory implementation or
// the in-process semaphore.
//
// The state-store uses this for read-modify-write critical sections
// where two processes might race to mutate the JSON. The lock is
// SHORT-CRITICAL-SECTION: hold across read+modify+atomic-write,
// release immediately. Long lifetimes (whole-stack lifecycle) belong
// to a separate lease, not this lock.

import { Context, Effect, Layer, Semaphore } from 'effect';

import { StackPathsService } from '../paths.ts';
import { underLiveClock } from './live-clock.ts';
import {
	acquireStackLock,
	type StackLockIoError,
	type StackLockTimeoutError,
} from './stack-lock.ts';

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
					// Acquire/release infrastructure runs under live clock
					// (OS-advisory lock retry backoff needs wall time — see
					// LIVE_CLOCK). The user body inherits the caller's
					// clock so TestClock-driven tests can virtualize
					// `Effect.sleep` inside the critical section.
					//
					// `semaphore.withPermits(1)` keeps SAME-process fibers
					// serialized before they race for the on-disk artifact;
					// permit release fires on body completion, failure, AND
					// interrupt via the semaphore's own finalizer.
					// `Effect.scoped` owns the on-disk acquire so its
					// finalizer (registered by `acquireStackLock`) unlinks
					// `stack.lock` on the same lifecycle.
					semaphore.withPermits(1)(
						Effect.scoped(
							Effect.gen(function* () {
								yield* underLiveClock(acquireStackLock(lockPath));
								return yield* effect;
							}),
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
			// No on-disk acquire here, so there's no wall-time backoff to
			// pin — `semaphore.withPermits(1)` parks on a queue without
			// `Effect.sleep`, so it tolerates TestClock natively. The
			// body inherits the caller's clock by construction; no
			// `underLiveClock` wrap.
			withLock: (effect) => semaphore.withPermits(1)(effect),
		});
	}),
);
