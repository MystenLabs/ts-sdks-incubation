// CrossProcessLock service + two Layers — tests.
//
// `layerCrossProcessLockInProcess` is the in-memory semaphore fallback;
// `layerCrossProcessLockFlock` is the O_EXCL/PID-liveness-backed
// production Layer that adapts `acquireStackLock`.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { Cause, Deferred, Effect, Exit, Fiber, Layer, Ref } from 'effect';
import * as TestClock from 'effect/testing/TestClock';
import { describe, expect, it } from '@effect/vitest';

import {
	CrossProcessLock,
	layerCrossProcessLockFlock,
	layerCrossProcessLockInProcess,
} from '../../../../src/substrate/runtime/cross-process/lock.ts';
import { ownHolder } from '../../../../src/substrate/runtime/cross-process/liveness.ts';
import { stackPathsLayer } from '../../../helpers/mock-stack-paths.ts';

const freshRoot = (): string => mkdtempSync(join(tmpdir(), 'cross-process-lock-test-'));

describe('layerCrossProcessLockInProcess', () => {
	it.effect('withLock serializes concurrent fibers (same process)', () =>
		// Serialization assertion is Deferred-gated (not sleep-gated) so the
		// test is deterministic and independent of clock semantics: the lock
		// body inherits the caller's clock per `cross-process/lock.ts`'s
		// `underLiveClock` narrowing, so any wall-time sleep inside the body
		// would park indefinitely under `it.effect`'s TestClock and miss the
		// serialization signal.
		Effect.gen(function* () {
			const lock = yield* CrossProcessLock;
			const log = yield* Ref.make<ReadonlyArray<string>>([]);
			const append = (s: string) => Ref.update(log, (prev) => [...prev, s]);
			const release = yield* Deferred.make<void>();

			const a = lock.withLock(
				Effect.gen(function* () {
					yield* append('a-in');
					// Block until the test fires `release`, holding the lock.
					yield* Deferred.await(release);
					yield* append('a-out');
				}),
			);
			const b = lock.withLock(
				Effect.gen(function* () {
					yield* append('b-in');
					yield* append('b-out');
				}),
			);

			const fiberA = yield* Effect.forkChild(a);
			const fiberB = yield* Effect.forkChild(b);
			// Yield so fiber A can acquire and reach the `Deferred.await`.
			yield* Effect.yieldNow;
			yield* Effect.yieldNow;
			yield* Deferred.succeed(release, undefined);
			yield* Fiber.join(fiberA);
			yield* Fiber.join(fiberB);
			const events = yield* Ref.get(log);
			const aStart = events.indexOf('a-in');
			const aEnd = events.indexOf('a-out');
			const bStart = events.indexOf('b-in');
			const bEnd = events.indexOf('b-out');
			expect(aStart).toBeGreaterThanOrEqual(0);
			expect(bStart).toBeGreaterThanOrEqual(0);
			const aRunFirst = aEnd < bStart;
			const bRunFirst = bEnd < aStart;
			expect(aRunFirst || bRunFirst).toBe(true);
		}).pipe(Effect.provide(layerCrossProcessLockInProcess)),
	);

	it.effect('withLock propagates the body Effect channel', () =>
		Effect.gen(function* () {
			const lock = yield* CrossProcessLock;
			const result = yield* lock.withLock(Effect.succeed(42));
			expect(result).toBe(42);
		}).pipe(Effect.provide(layerCrossProcessLockInProcess)),
	);

	it.effect('withLock propagates failures through the body channel', () =>
		Effect.gen(function* () {
			const lock = yield* CrossProcessLock;
			const exit = yield* lock.withLock(Effect.fail('boom' as const)).pipe(Effect.exit);
			expect(exit._tag).toBe('Failure');
		}).pipe(Effect.provide(layerCrossProcessLockInProcess)),
	);
});

describe('layerCrossProcessLockFlock', () => {
	it.effect('withLock writes the stack.lock file and unlinks on release', () => {
		const root = freshRoot();
		const stackRoot = join(root, 'app', 'main');
		return Effect.gen(function* () {
			try {
				const lock = yield* CrossProcessLock;
				const lockPath = join(stackRoot, 'stack.lock');
				yield* lock.withLock(
					Effect.sync(() => {
						expect(existsSync(lockPath)).toBe(true);
					}),
				);
				expect(existsSync(lockPath)).toBe(false);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}).pipe(
			Effect.provide(layerCrossProcessLockFlock.pipe(Layer.provide(stackPathsLayer(stackRoot)))),
		);
	});

	it.effect('withLock serializes concurrent fibers via the on-disk lock', () => {
		// Deferred-gated rather than sleep-gated — see the in-process variant
		// above for the rationale (body inherits TestClock; wall-time sleeps
		// would park indefinitely).
		const root = freshRoot();
		const stackRoot = join(root, 'app', 'main');
		return Effect.gen(function* () {
			try {
				const lock = yield* CrossProcessLock;
				const log = yield* Ref.make<ReadonlyArray<string>>([]);
				const append = (s: string) => Ref.update(log, (prev) => [...prev, s]);
				const release = yield* Deferred.make<void>();

				const fiberA = yield* Effect.forkChild(
					lock.withLock(
						Effect.gen(function* () {
							yield* append('a-in');
							yield* Deferred.await(release);
							yield* append('a-out');
						}),
					),
				);
				const fiberB = yield* Effect.forkChild(
					lock.withLock(
						Effect.gen(function* () {
							yield* append('b-in');
							yield* append('b-out');
						}),
					),
				);

				yield* Effect.yieldNow;
				yield* Effect.yieldNow;
				yield* Deferred.succeed(release, undefined);
				yield* Fiber.join(fiberA);
				yield* Fiber.join(fiberB);

				const events = yield* Ref.get(log);
				const aEnd = events.indexOf('a-out');
				const bStart = events.indexOf('b-in');
				const bEnd = events.indexOf('b-out');
				const aStart = events.indexOf('a-in');
				const aRunFirst = aEnd < bStart;
				const bRunFirst = bEnd < aStart;
				expect(aRunFirst || bRunFirst).toBe(true);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}).pipe(
			Effect.provide(layerCrossProcessLockFlock.pipe(Layer.provide(stackPathsLayer(stackRoot)))),
		);
	});

	it.effect('re-acquire after release succeeds', () => {
		const root = freshRoot();
		const stackRoot = join(root, 'app', 'main');
		return Effect.gen(function* () {
			try {
				const lock = yield* CrossProcessLock;
				const seen = yield* Ref.make(0);
				yield* lock.withLock(Ref.update(seen, (n) => n + 1));
				yield* lock.withLock(Ref.update(seen, (n) => n + 1));
				expect(yield* Ref.get(seen)).toBe(2);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}).pipe(
			Effect.provide(layerCrossProcessLockFlock.pipe(Layer.provide(stackPathsLayer(stackRoot)))),
		);
	});

	it.effect('body errors release the lock so a subsequent acquire succeeds', () => {
		const root = freshRoot();
		const stackRoot = join(root, 'app', 'main');
		const lockPath = join(stackRoot, 'stack.lock');
		return Effect.gen(function* () {
			try {
				const lock = yield* CrossProcessLock;
				const first = yield* lock.withLock(Effect.fail('nope' as const)).pipe(Effect.exit);
				expect(first._tag).toBe('Failure');
				expect(existsSync(lockPath)).toBe(false);
				const second = yield* lock.withLock(Effect.succeed('ok'));
				expect(second).toBe('ok');
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}).pipe(
			Effect.provide(layerCrossProcessLockFlock.pipe(Layer.provide(stackPathsLayer(stackRoot)))),
		);
	});

	it.effect(
		'acquire timeout surfaces as typed StackLockTimeoutError, not a defect',
		() => {
			// Regression for Phase C1 — earlier `Effect.orDie` shape
			// converted a peer-contention timeout into a fiber defect that
			// could crash the surrounding scope. The typed shape must
			// surface `StackLockTimeoutError` in the `E` channel so
			// consumers (stack-lock / container ownership) can map it to
			// their own error.
			const root = freshRoot();
			const stackRoot = join(root, 'app', 'main');
			const lockPath = join(stackRoot, 'stack.lock');
			// Plant a stack.lock body that points at THIS process — the
			// liveness probe sees the holder as alive (same pid +
			// start-time), so the acquire loop never reclaims and times
			// out cleanly. Default acquire window is 5s (per stack-lock
			// module).
			mkdirSync(dirname(lockPath), { recursive: true });
			writeFileSync(lockPath, JSON.stringify(ownHolder()));
			return Effect.gen(function* () {
				try {
					const lock = yield* CrossProcessLock;
					const exit = yield* lock.withLock(Effect.succeed('unreachable')).pipe(Effect.exit);
					expect(Exit.isFailure(exit)).toBe(true);
					if (Exit.isFailure(exit)) {
						// MUST be a typed Fail, NOT a Die. The whole
						// point of this regression: peer contention
						// cannot be a defect.
						expect(Cause.hasDies(exit.cause)).toBe(false);
						const fail = exit.cause.reasons.find(Cause.isFailReason);
						expect(fail).toBeDefined();
						if (fail !== undefined) {
							expect((fail.error as { _tag: string })._tag).toBe('StackLockTimeoutError');
						}
					}
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			}).pipe(
				Effect.provide(layerCrossProcessLockFlock.pipe(Layer.provide(stackPathsLayer(stackRoot)))),
			);
		},
		{ timeout: 15_000 },
	);

	it.effect('withLock body inherits TestClock so wall-time sleeps are virtual', () => {
		// Phase 5 regression: `withLock` was previously wrapped end-to-end
		// in `underLiveClock`, which forced the user body to use the
		// real OS clock too. That made TestClock-driven tests park
		// indefinitely on any `Effect.sleep` inside the critical
		// section. Phase 5 narrowed `underLiveClock` to wrap ONLY the
		// acquire/release infrastructure — the body inherits the
		// caller's clock — so `TestClock.adjust` virtually advances
		// past sleeps inside the lock body.
		const root = freshRoot();
		const stackRoot = join(root, 'app', 'main');
		return Effect.gen(function* () {
			try {
				const lock = yield* CrossProcessLock;
				const done = yield* Deferred.make<void>();
				const fiber = yield* Effect.forkChild(
					lock.withLock(
						Effect.gen(function* () {
							// Five minutes of wall time — would block the test
							// runner past its default timeout without TestClock
							// virtualization of the body.
							yield* Effect.sleep('5 minutes');
							yield* Deferred.succeed(done, undefined);
						}),
					),
				);
				// Let the body fork reach `Effect.sleep` (it acquires the
				// lock first under live clock, then yields on sleep under
				// TestClock).
				yield* TestClock.adjust('100 millis');
				// Virtually advance past the 5-minute sleep.
				yield* TestClock.adjust('5 minutes');
				yield* Deferred.await(done);
				yield* Fiber.join(fiber);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}).pipe(
			Effect.provide(layerCrossProcessLockFlock.pipe(Layer.provide(stackPathsLayer(stackRoot)))),
		);
	});

	it.effect('parallel-stack instances do not share locks', () => {
		// Two distinct stack roots → two distinct on-disk lock files →
		// the layers materialize independent in-process semaphores too.
		// Acquiring both concurrently should NOT serialize them.
		const root = freshRoot();
		const stackA = join(root, 'app-a', 'main');
		const stackB = join(root, 'app-b', 'main');
		// `Layer.fresh` forces each fiber to materialize its own
		// CrossProcessLock service instance instead of sharing a memoized
		// one from the parent runtime — without this, both fibers see the
		// same lock and serialize despite having separate stack roots.
		const layerA = Layer.fresh(
			layerCrossProcessLockFlock.pipe(Layer.provide(stackPathsLayer(stackA))),
		);
		const layerB = Layer.fresh(
			layerCrossProcessLockFlock.pipe(Layer.provide(stackPathsLayer(stackB))),
		);

		const programA = (entered: Deferred.Deferred<void>, release: Deferred.Deferred<void>) =>
			Effect.gen(function* () {
				const lock = yield* CrossProcessLock;
				return yield* lock.withLock(
					Effect.gen(function* () {
						// Signal we're inside the lock so B can race.
						yield* Deferred.succeed(entered, undefined);
						// Hold the lock until the main fiber releases — proves
						// B isn't blocked by A's lock (different stack root →
						// different file → no contention).
						yield* Deferred.await(release);
						return 'a-done';
					}),
				);
			}).pipe(Effect.provide(layerA));

		const programB = (entered: Deferred.Deferred<void>) =>
			Effect.gen(function* () {
				// Wait until A is provably inside its lock.
				yield* Deferred.await(entered);
				const lock = yield* CrossProcessLock;
				return yield* lock.withLock(Effect.succeed('b-done'));
			}).pipe(Effect.provide(layerB));

		return Effect.gen(function* () {
			try {
				const entered = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				const fiberA = yield* Effect.forkChild(programA(entered, release));
				const fiberB = yield* Effect.forkChild(programB(entered));
				// B must complete WHILE A still holds its lock — this proves
				// the two stack roots have independent locks (if they shared
				// one, B would block until A releases).
				const b = yield* Fiber.join(fiberB);
				yield* Deferred.succeed(release, undefined);
				const a = yield* Fiber.join(fiberA);
				expect(a).toBe('a-done');
				expect(b).toBe('b-done');
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});
	});
});
