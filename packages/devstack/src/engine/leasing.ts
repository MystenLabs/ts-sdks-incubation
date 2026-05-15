// Signer leasing / pool coordination. When multiple actions all use the
// same on-chain address to sign transactions, they fight over the gas
// coin (each tx mutates the active gas-coin object's version; concurrent
// txs from one address fail with `BalanceInsufficient` or
// `LockedSharedObject` errors). v3's `leasing/signer-pool.ts` serialized
// signer use per-address; this is the Effect-v4 equivalent.
//
// Concurrency is intentionally split from the signer interface — the
// signer service stays pure ("here is how you sign"), and primitives
// that know they need serialization request a lease around their
// signing call. `withExclusive` wraps a work effect so the permit is
// released on completion / interrupt / failure without the caller
// needing to manage a Scope.

import { Context, Effect, Layer, Ref, Semaphore } from 'effect';

export interface LeasingShape {
	/**
	 * Run `work` while holding an exclusive lease on `address`. The permit
	 * is released on completion, failure, or interrupt — `withPermits` is
	 * interrupt-safe by construction so callers don't need to manage a Scope.
	 */
	readonly withExclusive: <A, E, R>(
		address: string,
		work: Effect.Effect<A, E, R>,
	) => Effect.Effect<A, E, R>;
}

export class Leasing extends Context.Service<Leasing, LeasingShape>()('@devstack/Leasing') {}

export const LeasingLive: Layer.Layer<Leasing> = Layer.effect(
	Leasing,
	Effect.gen(function* () {
		// Per-address semaphore. Created lazily on first lease — addresses
		// we never sign with shouldn't allocate state.
		const ref = yield* Ref.make<Map<string, Semaphore.Semaphore>>(new Map());

		const getOrCreate = (address: string): Effect.Effect<Semaphore.Semaphore> =>
			Effect.gen(function* () {
				const existing = (yield* Ref.get(ref)).get(address);
				if (existing !== undefined) return existing;
				// Race-safe insert via Ref.modify: if a concurrent fiber
				// inserted between our read and write, use theirs.
				const fresh = yield* Semaphore.make(1);
				return yield* Ref.modify(ref, (m) => {
					const found = m.get(address);
					if (found !== undefined) return [found, m] as const;
					const next = new Map(m);
					next.set(address, fresh);
					return [fresh, next] as const;
				});
			});

		const withExclusive = <A, E, R>(
			address: string,
			work: Effect.Effect<A, E, R>,
		): Effect.Effect<A, E, R> =>
			Effect.gen(function* () {
				const sem = yield* getOrCreate(address);
				return yield* sem.withPermits(1)(work);
			}).pipe(Effect.withSpan('Leasing.withExclusive', { attributes: { address } }));

		return { withExclusive };
	}),
);
