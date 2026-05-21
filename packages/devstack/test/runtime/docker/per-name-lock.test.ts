// Per-name in-process lock — the inspect→action window's invariant.
//
// Architecture rule (runtime-docker review issue #2): two concurrent
// `ensureContainer` calls for the same name must not interleave docker
// inspect/create/start. The cross-process side is the docker daemon's
// `--name` atomicity; the in-process side is the lock primitive
// exercised here.
//
// We test the primitive directly so the invariant holds independent
// of the surrounding `ensureContainer` scaffolding (which spawns
// docker and is unavailable in CI).

import { describe, expect, it } from '@effect/vitest';
import { Effect, Fiber, Ref } from 'effect';

import {
	acquirePerNameLock,
	type PerNameLockState,
	releasePerNameLock,
} from '../../../src/runtime/docker/container.ts';

/** Cooperatively park until `predicate` returns true. Used to wait for
 *  a forked fiber to reach a known checkpoint (e.g. parked on the
 *  lock's Deferred.await) before driving the next step. `Effect.yieldNow`
 *  hands control to other ready fibers; under `it.effect`'s TestClock
 *  there is no wall-clock dependency. */
const waitFor = (predicate: Effect.Effect<boolean>): Effect.Effect<void> =>
	Effect.gen(function* () {
		while (!(yield* predicate)) {
			yield* Effect.yieldNow;
		}
	});

const queueLength = (lock: Ref.Ref<PerNameLockState>, name: string): Effect.Effect<number> =>
	Effect.gen(function* () {
		const state = yield* Ref.get(lock);
		const q = state.get(name);
		return q === undefined ? -1 : q.length;
	});

describe('per-name lock', () => {
	it.effect('serializes concurrent acquires on the same name', () =>
		Effect.gen(function* () {
			const lock = yield* Ref.make<PerNameLockState>(new Map());
			const events = yield* Ref.make<ReadonlyArray<string>>([]);
			const log = (m: string) => Ref.update(events, (a) => [...a, m]);

			// Fiber a takes the lock first, then yields to let b enqueue
			// before logging `done` + releasing. Fiber b parks on the
			// lock's Deferred until a's release transfers ownership.
			const work = (id: string, waitForQueue: number) =>
				Effect.gen(function* () {
					yield* acquirePerNameLock(lock, 'shared');
					yield* log(`${id}:acquired`);
					// Give the next fiber a chance to enqueue before we
					// release; under it.effect this is a fiber yield,
					// not a wall-clock wait.
					yield* waitFor(Effect.map(queueLength(lock, 'shared'), (n) => n >= waitForQueue));
					yield* log(`${id}:done`);
					yield* releasePerNameLock(lock, 'shared');
				});

			const f1 = yield* Effect.forkChild(work('a', 1));
			// Yield until a has claimed the slot, so b's acquire sees
			// the held entry and enqueues.
			yield* waitFor(Effect.map(queueLength(lock, 'shared'), (n) => n >= 0));
			const f2 = yield* Effect.forkChild(work('b', 0));
			yield* Fiber.join(f1);
			yield* Fiber.join(f2);

			const seen = yield* Ref.get(events);
			// Strict FIFO: a took the lock first, so a's acquired/done
			// pair must precede b's.
			expect(seen).toEqual(['a:acquired', 'a:done', 'b:acquired', 'b:done']);
		}),
	);

	it.effect('contended acquires release in FIFO order', () =>
		Effect.gen(function* () {
			const lock = yield* Ref.make<PerNameLockState>(new Map());
			const events = yield* Ref.make<ReadonlyArray<string>>([]);
			const log = (m: string) => Ref.update(events, (a) => [...a, m]);

			const acquireAndLog = (id: string) =>
				Effect.gen(function* () {
					yield* acquirePerNameLock(lock, 'shared');
					yield* log(id);
					yield* releasePerNameLock(lock, 'shared');
				});

			// Fiber a acquires first (forks before b/c, and the first
			// acquire on a free slot returns immediately without ever
			// awaiting a Deferred). We hold a via an external gate so
			// b and c have time to enqueue in order.
			const gate = yield* Ref.make<boolean>(false);
			const fa = yield* Effect.forkChild(
				Effect.gen(function* () {
					yield* acquirePerNameLock(lock, 'shared');
					yield* log('a');
					yield* waitFor(Ref.get(gate));
					yield* releasePerNameLock(lock, 'shared');
				}),
			);
			// Wait for a to claim, so b/c see the held entry.
			yield* waitFor(Effect.map(queueLength(lock, 'shared'), (n) => n === 0));
			const fb = yield* Effect.forkChild(acquireAndLog('b'));
			// Wait for b to enqueue.
			yield* waitFor(Effect.map(queueLength(lock, 'shared'), (n) => n === 1));
			const fc = yield* Effect.forkChild(acquireAndLog('c'));
			// Wait for c to enqueue.
			yield* waitFor(Effect.map(queueLength(lock, 'shared'), (n) => n === 2));
			// Open the gate — a releases, ownership transfers to b,
			// then b finishes and ownership transfers to c.
			yield* Ref.set(gate, true);
			yield* Fiber.join(fa);
			yield* Fiber.join(fb);
			yield* Fiber.join(fc);

			const seen = yield* Ref.get(events);
			expect(seen).toEqual(['a', 'b', 'c']);
			// Lock must be empty after all releases.
			const finalState = yield* Ref.get(lock);
			expect(finalState.size).toBe(0);
		}),
	);

	it.effect('different names do not block each other', () =>
		Effect.gen(function* () {
			const lock = yield* Ref.make<PerNameLockState>(new Map());
			yield* acquirePerNameLock(lock, 'foo');
			// Acquire on a different name proceeds without waiting on the
			// 'foo' slot. If the implementation accidentally used a global
			// lock, this would hang past the test timeout.
			yield* acquirePerNameLock(lock, 'bar');
			yield* releasePerNameLock(lock, 'foo');
			yield* releasePerNameLock(lock, 'bar');
			const finalState = yield* Ref.get(lock);
			expect(finalState.size).toBe(0);
		}),
	);

	it.effect('release after acquire allows a second acquire', () =>
		Effect.gen(function* () {
			const lock = yield* Ref.make<PerNameLockState>(new Map());
			yield* acquirePerNameLock(lock, 'x');
			yield* releasePerNameLock(lock, 'x');
			// Re-acquire on the same name post-release must succeed.
			yield* acquirePerNameLock(lock, 'x');
			yield* releasePerNameLock(lock, 'x');
			expect((yield* Ref.get(lock)).size).toBe(0);
		}),
	);

	it.effect('release of unheld slot is a no-op', () =>
		Effect.gen(function* () {
			const lock = yield* Ref.make<PerNameLockState>(new Map());
			// Releasing a slot that was never acquired must not throw.
			yield* releasePerNameLock(lock, 'never-acquired');
			expect((yield* Ref.get(lock)).size).toBe(0);
		}),
	);

	it.effect('interrupted waiter is removed from the queue', () =>
		Effect.gen(function* () {
			const lock = yield* Ref.make<PerNameLockState>(new Map());
			// Holder takes the slot.
			yield* acquirePerNameLock(lock, 'shared');
			// Waiter enqueues then is interrupted before the holder releases.
			const waiter = yield* Effect.forkChild(acquirePerNameLock(lock, 'shared'));
			yield* waitFor(Effect.map(queueLength(lock, 'shared'), (n) => n === 1));
			yield* Fiber.interrupt(waiter);
			// onInterrupt should have dropped the deferred from the queue.
			yield* waitFor(Effect.map(queueLength(lock, 'shared'), (n) => n === 0));
			// Holder releases — no orphan completion left behind.
			yield* releasePerNameLock(lock, 'shared');
			const finalState = yield* Ref.get(lock);
			expect(finalState.size).toBe(0);
		}),
	);
});
