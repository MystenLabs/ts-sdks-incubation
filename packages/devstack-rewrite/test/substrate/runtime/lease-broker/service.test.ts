// LeaseBrokerService — substrate-level lease primitive.
//
// Architecture invariants under test:
//   1. Lease is scope-bound — closing the surrounding scope releases
//      the lease; a fresh `acquire` on the same key after scope-close
//      succeeds.
//   2. `acquire` serialises concurrent claimants by FIFO — the second
//      claim blocks until the first scope closes.
//   3. `tryAcquire` is non-blocking — returns `null` when held by
//      anyone (same or different owner) and a `Lease` when free.
//   4. The broker is name-blind — same `LeaseKey` value coordinates
//      across callers; different `LeaseKey` values do NOT.
//   5. `holders()` reflects current ownership for diagnostics.

import { Deferred, Effect, Fiber } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import {
	LeaseBrokerService,
	layerLeaseBroker,
	leaseKey,
} from '../../../../src/substrate/runtime/lease-broker/index.ts';

const k = (s: string) => leaseKey(s);

describe('LeaseBrokerService', () => {
	it.effect('acquire grants the lease when the key is free', () =>
		Effect.gen(function* () {
			const broker = yield* LeaseBrokerService;
			yield* Effect.scoped(
				Effect.gen(function* () {
					const lease = yield* broker.acquire(k('alpha'), 'owner-1');
					expect(lease.key).toBe(k('alpha'));
					expect(lease.owner).toBe('owner-1');
					const snapshot = yield* broker.holders();
					expect(snapshot.get(k('alpha'))).toBe('owner-1');
				}),
			);
		}).pipe(Effect.provide(layerLeaseBroker)),
	);

	it.effect('scope close releases the lease (re-acquire after scope succeeds)', () =>
		Effect.gen(function* () {
			const broker = yield* LeaseBrokerService;
			yield* Effect.scoped(
				Effect.gen(function* () {
					yield* broker.acquire(k('beta'), 'owner-1');
				}),
			);
			// After the first scope closes, the entry must be gone — neither
			// the holders snapshot nor a fresh `acquire` sees stale state.
			const afterClose = yield* broker.holders();
			expect(afterClose.has(k('beta'))).toBe(false);
			yield* Effect.scoped(
				Effect.gen(function* () {
					const lease = yield* broker.acquire(k('beta'), 'owner-2');
					expect(lease.owner).toBe('owner-2');
				}),
			);
		}).pipe(Effect.provide(layerLeaseBroker)),
	);

	it.effect('tryAcquire returns null when held, Lease when free', () =>
		Effect.gen(function* () {
			const broker = yield* LeaseBrokerService;
			yield* Effect.scoped(
				Effect.gen(function* () {
					const first = yield* broker.tryAcquire(k('gamma'), 'owner-1');
					expect(first).not.toBeNull();
					expect(first?.owner).toBe('owner-1');
					// Held by owner-1 → contended claim refused.
					const contended = yield* broker.tryAcquire(k('gamma'), 'owner-2');
					expect(contended).toBeNull();
				}),
			);
			// After scope close, tryAcquire succeeds again.
			yield* Effect.scoped(
				Effect.gen(function* () {
					const lease = yield* broker.tryAcquire(k('gamma'), 'owner-3');
					expect(lease).not.toBeNull();
					expect(lease?.owner).toBe('owner-3');
				}),
			);
		}).pipe(Effect.provide(layerLeaseBroker)),
	);

	it.effect('tryAcquire does NOT block when contended', () =>
		Effect.gen(function* () {
			const broker = yield* LeaseBrokerService;
			yield* Effect.scoped(
				Effect.gen(function* () {
					yield* broker.acquire(k('delta'), 'holder');
					// Contended tryAcquire from another fiber must return
					// null IMMEDIATELY — never block on the held lease.
					const fiber = yield* Effect.forkChild(broker.tryAcquire(k('delta'), 'probe'));
					const result = yield* Fiber.join(fiber);
					expect(result).toBeNull();
				}),
			);
		}).pipe(Effect.provide(layerLeaseBroker)),
	);

	it.effect('acquire blocks while held; unblocks on prior scope close', () =>
		Effect.gen(function* () {
			const broker = yield* LeaseBrokerService;
			const firstScopeReady = yield* Deferred.make<void>();
			const releaseFirst = yield* Deferred.make<void>();
			const secondAcquired = yield* Deferred.make<void>();

			const firstHolder = yield* Effect.forkChild(
				Effect.scoped(
					Effect.gen(function* () {
						yield* broker.acquire(k('eps'), 'first');
						yield* Deferred.succeed(firstScopeReady, undefined);
						yield* Deferred.await(releaseFirst);
					}),
				),
			);

			yield* Deferred.await(firstScopeReady);
			// First holder is in. Verify the second `acquire` is queued —
			// not failed, not immediate.
			const snapshotWhileHeld = yield* broker.holders();
			expect(snapshotWhileHeld.get(k('eps'))).toBe('first');

			const secondHolder = yield* Effect.forkChild(
				Effect.scoped(
					Effect.gen(function* () {
						const lease = yield* broker.acquire(k('eps'), 'second');
						yield* Deferred.succeed(secondAcquired, undefined);
						expect(lease.owner).toBe('second');
					}),
				),
			);

			// The second fiber is parked on the per-key signal Deferred.
			// Release the first holder → promotion happens in the
			// finalizer → the second fiber acquires.
			yield* Deferred.succeed(releaseFirst, undefined);
			yield* Fiber.join(firstHolder);
			yield* Deferred.await(secondAcquired);
			yield* Fiber.join(secondHolder);

			// Both released — key is gone from holders.
			const afterBoth = yield* broker.holders();
			expect(afterBoth.has(k('eps'))).toBe(false);
		}).pipe(Effect.provide(layerLeaseBroker)),
	);

	it.effect('distinct keys do not coordinate', () =>
		Effect.gen(function* () {
			const broker = yield* LeaseBrokerService;
			yield* Effect.scoped(
				Effect.gen(function* () {
					const a = yield* broker.acquire(k('one'), 'owner-a');
					// Different key → tryAcquire succeeds immediately.
					const b = yield* broker.tryAcquire(k('two'), 'owner-b');
					expect(a.key).toBe(k('one'));
					expect(b).not.toBeNull();
					expect(b?.key).toBe(k('two'));
					const snap = yield* broker.holders();
					expect(snap.get(k('one'))).toBe('owner-a');
					expect(snap.get(k('two'))).toBe('owner-b');
				}),
			);
		}).pipe(Effect.provide(layerLeaseBroker)),
	);

	it.effect('FIFO order: two queued waiters acquire in the order they enqueued', () =>
		Effect.gen(function* () {
			const broker = yield* LeaseBrokerService;
			const holderReady = yield* Deferred.make<void>();
			const releaseHolder = yield* Deferred.make<void>();
			const completionOrder: string[] = [];

			const holder = yield* Effect.forkChild(
				Effect.scoped(
					Effect.gen(function* () {
						yield* broker.acquire(k('queue'), 'h');
						yield* Deferred.succeed(holderReady, undefined);
						yield* Deferred.await(releaseHolder);
					}),
				),
			);
			yield* Deferred.await(holderReady);

			// Enqueue two waiters in deterministic order.
			const firstWaiterEnqueued = yield* Deferred.make<void>();
			const secondWaiterEnqueued = yield* Deferred.make<void>();

			const firstWaiter = yield* Effect.forkChild(
				Effect.scoped(
					Effect.gen(function* () {
						yield* Deferred.succeed(firstWaiterEnqueued, undefined);
						yield* broker.acquire(k('queue'), 'w1');
						completionOrder.push('w1');
					}),
				),
			);
			yield* Deferred.await(firstWaiterEnqueued);
			// Tiny yield to let the first waiter's Ref.modify land before
			// the second one enqueues — without a TestClock, this is the
			// most direct way to pin enqueue order.
			yield* Effect.yieldNow;
			yield* Effect.yieldNow;

			const secondWaiter = yield* Effect.forkChild(
				Effect.scoped(
					Effect.gen(function* () {
						yield* Deferred.succeed(secondWaiterEnqueued, undefined);
						yield* broker.acquire(k('queue'), 'w2');
						completionOrder.push('w2');
					}),
				),
			);
			yield* Deferred.await(secondWaiterEnqueued);
			yield* Effect.yieldNow;
			yield* Effect.yieldNow;

			yield* Deferred.succeed(releaseHolder, undefined);
			yield* Fiber.join(holder);
			yield* Fiber.join(firstWaiter);
			yield* Fiber.join(secondWaiter);

			expect(completionOrder).toEqual(['w1', 'w2']);
		}).pipe(Effect.provide(layerLeaseBroker)),
	);

	it.effect('holders snapshot returns an empty map on a fresh broker', () =>
		Effect.gen(function* () {
			const broker = yield* LeaseBrokerService;
			const snap = yield* broker.holders();
			expect(snap.size).toBe(0);
		}).pipe(Effect.provide(layerLeaseBroker)),
	);

	it.effect('interrupting a queued waiter dequeues without affecting the holder', () =>
		Effect.gen(function* () {
			const broker = yield* LeaseBrokerService;
			const holderReady = yield* Deferred.make<void>();
			const releaseHolder = yield* Deferred.make<void>();
			const waiterEnqueued = yield* Deferred.make<void>();

			const holder = yield* Effect.forkChild(
				Effect.scoped(
					Effect.gen(function* () {
						yield* broker.acquire(k('cancel'), 'holder');
						yield* Deferred.succeed(holderReady, undefined);
						yield* Deferred.await(releaseHolder);
					}),
				),
			);
			yield* Deferred.await(holderReady);

			const waiter = yield* Effect.forkChild(
				Effect.scoped(
					Effect.gen(function* () {
						yield* Deferred.succeed(waiterEnqueued, undefined);
						yield* broker.acquire(k('cancel'), 'doomed-waiter');
					}),
				),
			);
			yield* Deferred.await(waiterEnqueued);
			yield* Effect.yieldNow;
			yield* Effect.yieldNow;

			// Interrupt the parked waiter. The holder is unaffected; the
			// waiter cleans itself out of the queue (cleanupCancelledWait).
			yield* Fiber.interrupt(waiter);

			const heldAfterInterrupt = yield* broker.holders();
			expect(heldAfterInterrupt.get(k('cancel'))).toBe('holder');

			// Release the holder — there are no live waiters left, so the
			// key fully releases.
			yield* Deferred.succeed(releaseHolder, undefined);
			yield* Fiber.join(holder);

			const fullyReleased = yield* broker.holders();
			expect(fullyReleased.has(k('cancel'))).toBe(false);
		}).pipe(Effect.provide(layerLeaseBroker)),
	);
});
