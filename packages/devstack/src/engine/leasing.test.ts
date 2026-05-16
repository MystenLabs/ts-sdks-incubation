// Leasing must keep concurrent signers from racing on the same on-chain
// address. The interesting failure mode is the permit leaking when a
// fiber is interrupted or fails — we test that explicitly.

import { Deferred, Effect, Exit, Fiber, Ref } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { Leasing, LeasingLive } from './leasing.js';

describe('Leasing.withExclusive', () => {
	it.effect('sequential calls on the same address compose without contention', () =>
		Effect.gen(function* () {
			const leasing = yield* Leasing;
			const log: string[] = [];
			yield* leasing.withExclusive(
				'0xA',
				Effect.sync(() => log.push('a1')),
			);
			yield* leasing.withExclusive(
				'0xA',
				Effect.sync(() => log.push('a2')),
			);
			expect(log).toEqual(['a1', 'a2']);
		}).pipe(Effect.provide(LeasingLive)),
	);

	it.effect('two fibers racing on the SAME address serialize', () =>
		Effect.gen(function* () {
			const leasing = yield* Leasing;
			const release = yield* Deferred.make<void>();
			const order: string[] = [];

			// First fiber acquires and parks until `release` fires.
			const f1 = yield* Effect.forkChild(
				leasing.withExclusive(
					'0xA',
					Effect.gen(function* () {
						order.push('f1-enter');
						yield* Deferred.await(release);
						order.push('f1-exit');
					}),
				),
			);

			// Second fiber must block on the same address. Give the runtime
			// a yield so f1 definitely entered withPermits before f2 forks.
			yield* Effect.yieldNow;
			const f2 = yield* Effect.forkChild(
				leasing.withExclusive(
					'0xA',
					Effect.sync(() => order.push('f2')),
				),
			);
			yield* Effect.yieldNow;
			// f2 should still be queued — f1 hasn't released.
			expect(order).toEqual(['f1-enter']);

			yield* Deferred.succeed(release, undefined);
			yield* Fiber.join(f1);
			yield* Fiber.join(f2);
			expect(order).toEqual(['f1-enter', 'f1-exit', 'f2']);
		}).pipe(Effect.provide(LeasingLive)),
	);

	it.effect('two fibers on DIFFERENT addresses run in parallel', () =>
		Effect.gen(function* () {
			const leasing = yield* Leasing;
			const gateA = yield* Deferred.make<void>();
			const gateB = yield* Deferred.make<void>();
			const ref = yield* Ref.make(0);

			// Each fiber waits on its own gate inside the critical section.
			// If addresses serialize against each other (a regression), the
			// second `Deferred.succeed` below would deadlock.
			const fA = yield* Effect.forkChild(
				leasing.withExclusive(
					'0xA',
					Effect.gen(function* () {
						yield* Ref.update(ref, (n) => n + 1);
						yield* Deferred.await(gateA);
					}),
				),
			);
			const fB = yield* Effect.forkChild(
				leasing.withExclusive(
					'0xB',
					Effect.gen(function* () {
						yield* Ref.update(ref, (n) => n + 1);
						yield* Deferred.await(gateB);
					}),
				),
			);
			yield* Effect.yieldNow;
			yield* Effect.yieldNow;
			// Both critical sections should be in flight concurrently.
			expect(yield* Ref.get(ref)).toBe(2);
			yield* Deferred.succeed(gateA, undefined);
			yield* Deferred.succeed(gateB, undefined);
			yield* Fiber.join(fA);
			yield* Fiber.join(fB);
		}).pipe(Effect.provide(LeasingLive)),
	);

	it.effect('interrupted fiber releases its permit so the next acquirer proceeds', () =>
		Effect.gen(function* () {
			const leasing = yield* Leasing;
			const acquired = yield* Deferred.make<void>();

			// Park inside the critical section until interrupted. The whole
			// point: after the interrupt, address '0xA' must be available.
			const blocker = yield* Effect.forkChild(
				leasing.withExclusive(
					'0xA',
					Effect.gen(function* () {
						yield* Deferred.succeed(acquired, undefined);
						yield* Effect.never;
					}),
				),
			);
			yield* Deferred.await(acquired);
			yield* Fiber.interrupt(blocker);

			// If the permit leaked, this would hang indefinitely.
			const ran = yield* Ref.make(false);
			yield* leasing.withExclusive('0xA', Ref.set(ran, true));
			expect(yield* Ref.get(ran)).toBe(true);
		}).pipe(Effect.provide(LeasingLive)),
	);

	it.effect('failed fiber releases its permit', () =>
		Effect.gen(function* () {
			const leasing = yield* Leasing;
			const exit = yield* leasing
				.withExclusive('0xA', Effect.fail('boom' as const))
				.pipe(Effect.exit);
			expect(Exit.isFailure(exit)).toBe(true);

			// Next acquire must succeed — same proof as the interrupt case.
			const ran = yield* Ref.make(false);
			yield* leasing.withExclusive('0xA', Ref.set(ran, true));
			expect(yield* Ref.get(ran)).toBe(true);
		}).pipe(Effect.provide(LeasingLive)),
	);
});
