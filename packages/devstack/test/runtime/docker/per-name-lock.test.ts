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

	// Narrower "promoted-but-interrupted" race — deterministically
	// reproduced. `releasePerNameLock` transfers ownership in TWO steps
	// with a yield between: (1) a `Ref.modify` pops the head waiter
	// (ownership transferred), then (2) `Deferred.succeed` signals it.
	// If an interrupt fires in the window AFTER (1) but BEFORE (2), the
	// interrupted waiter finds itself already absent from the queue while
	// its deferred is still pending.
	//
	// We hit that window deterministically by performing release's POP
	// STEP by hand (mirroring `releasePerNameLock`'s `Ref.modify`) WITHOUT
	// the subsequent signal, then interrupting B. This drives the REAL
	// `acquirePerNameLock` onInterrupt branch — the load-bearing code
	// under test — against the exact mid-transfer state, with no reliance
	// on Effect-scheduler timing.
	//
	// Falsifiability: the previous `Deferred.isDoneUnsafe(waiter)`
	// discriminator returns false here (the deferred was popped but never
	// signaled), so the buggy branch would NOT re-release — leaving
	// `{ 'shared': [] }` with no holder. C's acquire would then enqueue
	// behind a slot no code path ever pops and HANG past the test timeout.
	// The fix discriminates on queue membership (not queued ⇒ promoted),
	// so it re-releases, drains the slot, and C acquires cleanly.
	it.effect(
		'promoted-but-interrupted: release re-runs on dead waiter so next acquire proceeds',
		() =>
			Effect.gen(function* () {
				const lock = yield* Ref.make<PerNameLockState>(new Map());

				// A holds 'shared' (entry present, empty queue).
				yield* acquirePerNameLock(lock, 'shared');

				// B enqueues; wait until B is parked on its Deferred.
				const fiberB = yield* Effect.forkChild(acquirePerNameLock(lock, 'shared'));
				yield* waitFor(Effect.map(queueLength(lock, 'shared'), (n) => n === 1));

				// Perform ONLY release's pop step: remove B's deferred from
				// the head of the queue (transferring ownership to B) but do
				// NOT signal it. State is now `{ 'shared': [] }`, B still
				// parked on a pending Deferred, B absent from the queue —
				// exactly the pop/signal window of `releasePerNameLock`.
				yield* Ref.modify(lock, (m) => {
					const queue = m.get('shared') ?? [];
					const [, ...rest] = queue;
					const next = new Map(m);
					next.set('shared', rest);
					return [undefined, next as PerNameLockState] as const;
				});

				// Interrupt B. Its onInterrupt sees: queue present, B not in
				// it ⇒ promoted ⇒ re-release on B's behalf.
				yield* Fiber.interrupt(fiberB);

				// With the fix the slot is fully drained, so C acquires
				// cleanly. With the buggy isDoneUnsafe discriminator the
				// empty-queue entry would persist with no holder and this
				// acquire would park forever (test timeout = failure).
				yield* acquirePerNameLock(lock, 'shared');
				yield* releasePerNameLock(lock, 'shared');
				const finalState = yield* Ref.get(lock);
				expect(finalState.size).toBe(0);
			}),
	);

	it.effect('cancelled waiter drops out of the queue without stranding the slot', () =>
		// Regression for the cancelled-waiter cleanup that mirrors the
		// lease-broker pattern (`substrate/runtime/lease-broker/
		// service.ts:cleanupCancelledWait`):
		//   1. Fiber A holds the slot.
		//   2. Fiber B is queued waiting on its Deferred.
		//   3. B is interrupted while parked.
		//   4. B's `onInterrupt` filters its deferred out of the queue
		//      so a later `releasePerNameLock` finds an empty queue and
		//      fully releases the slot rather than promoting a dead
		//      fiber.
		//   5. C acquires cleanly.
		//
		// The narrower "promoted-but-interrupted" race (release pops B's
		// deferred AND B is interrupted between the pop and B's await
		// resuming) is covered by the second branch of `onInterrupt` —
		// it uses `Deferred.isDoneUnsafe(waiter)` to detect promotion
		// and re-releases on the dead waiter's behalf. That branch is
		// defensive against an Effect-scheduler-internal timing window
		// that's hard to deterministically reproduce in a single-
		// process test; the source code is in place at
		// `runtime/docker/container.ts:acquirePerNameLock`.
		Effect.gen(function* () {
			const lock = yield* Ref.make<PerNameLockState>(new Map());

			// A holds 'shared'.
			yield* acquirePerNameLock(lock, 'shared');

			// B enqueues; wait until B is actually parked on its Deferred.
			const fiberB = yield* Effect.forkChild(acquirePerNameLock(lock, 'shared'));
			yield* waitFor(Effect.map(queueLength(lock, 'shared'), (n) => n === 1));

			// Interrupt B while it's parked. B's onInterrupt should
			// filter its deferred out of the queue.
			yield* Fiber.interrupt(fiberB);

			// Queue should now be empty (A still holds).
			yield* waitFor(Effect.map(queueLength(lock, 'shared'), (n) => n === 0));

			// Release A. With no live waiters, the slot fully releases
			// (map entry deleted).
			yield* releasePerNameLock(lock, 'shared');
			const afterRelease = yield* Ref.get(lock);
			expect(afterRelease.has('shared')).toBe(false);

			// C acquires the now-free slot cleanly.
			yield* acquirePerNameLock(lock, 'shared');
			yield* releasePerNameLock(lock, 'shared');
			const finalState = yield* Ref.get(lock);
			expect(finalState.size).toBe(0);
		}),
	);
});
