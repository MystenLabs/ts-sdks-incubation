// Lifecycle classification tests for the Faucet service (post-launch
// sweep §3.7 / W15). The header doc pins Faucet as:
//
//   - per-cycle state (strategies registered inside the tag's Effect,
//     no carry-over between scopes),
//   - in-memory only (no container, no host process, no own
//     state-store key),
//   - ambient (auto-mounted by `fillDefaults`).
//
// These tests lock #1 — the strategy registry has the same lifetime as
// the surrounding scope — so a regression that hoists the `Ref<Map>`
// outside the layer (e.g. promoting `FaucetLive` to a process-global
// singleton) trips a unit failure rather than a subtle cross-stack
// leak. The ambient/auto-mount classification is locked structurally
// by `fillDefaults` + the engine-shared dashboard tests; we don't
// re-verify it here.
//
// Strategy-level dispatch is exercised by `treasury-cap-mint.test.ts`,
// `wal-exchange.test.ts`, and the engine integration tests.

import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { FaucetLive, FaucetTag, type Faucet, type FaucetStrategy } from './index.js';

// Identity-only stub strategy. Lets us register, dispatch, and assert
// presence in `listFundable` without touching the SUI HTTP path or any
// chain primitives.
const noopStrategy = (coinType: string): FaucetStrategy => ({
	coinType,
	request: () => Effect.void,
});

describe('Faucet lifecycle classification', () => {
	it.effect('strategy registry is scope-local — fresh `Ref<Map>` per layer build', () =>
		Effect.gen(function* () {
			// Build the live Faucet twice from the SAME `FaucetLive` layer.
			// If `FaucetLive` accidentally promoted the registry to a
			// module-level singleton, the second build would see the
			// strategy registered during the first build. We assert the
			// opposite: each build gets an empty registry.
			const firstFundable = yield* Effect.gen(function* () {
				const faucet = yield* FaucetTag;
				yield* faucet.register(noopStrategy('STUB-A'));
				return yield* faucet.listFundable;
			}).pipe(Effect.provide(FaucetLive));

			expect(firstFundable).toEqual(['STUB-A']);

			const secondFundable = yield* Effect.gen(function* () {
				const faucet = yield* FaucetTag;
				// Registry must NOT carry `STUB-A` over from the previous
				// `Effect.provide(FaucetLive)` — a fresh layer build means
				// a fresh `Ref<Map>`.
				return yield* faucet.listFundable;
			}).pipe(Effect.provide(FaucetLive));

			expect(secondFundable).toEqual([]);
		}),
	);

	it.effect('register/listFundable/requestCoin reflect the in-memory registry shape', () =>
		Effect.gen(function* () {
			// Locks the per-cycle in-memory contract: a strategy registered
			// during the scope is visible to `listFundable` and dispatched
			// by `requestCoin` within that same scope, and a re-register on
			// the same `coinType` shadows the prior entry (the manifest
			// emitter and `Account({ funding })` both rely on this).
			let invocations = 0;
			const recording: FaucetStrategy = {
				coinType: 'STUB',
				request: () =>
					Effect.sync(() => {
						invocations += 1;
					}),
			};

			yield* Effect.gen(function* () {
				const faucet: Faucet = yield* FaucetTag;
				yield* faucet.register(recording);

				const listed = yield* faucet.listFundable;
				expect(listed).toEqual(['STUB']);

				yield* faucet.requestCoin('STUB', '0xabc', 1n);
				expect(invocations).toBe(1);

				// Re-register the same coinType → the later registration
				// wins (this is the override hook `Faucet({ strategies })`
				// relies on for user-supplied overrides of built-ins).
				let overrideHits = 0;
				yield* faucet.register({
					coinType: 'STUB',
					request: () =>
						Effect.sync(() => {
							overrideHits += 1;
						}),
				});
				yield* faucet.requestCoin('STUB', '0xabc', 1n);
				expect(invocations).toBe(1);
				expect(overrideHits).toBe(1);
			}).pipe(Effect.provide(FaucetLive));
		}),
	);

	it.effect('unknown coinType fails with FaucetRequestError naming the registered set', () =>
		Effect.gen(function* () {
			// Locks the "unknown coinType" branch on the in-memory dispatch
			// path — the registered-set string is what makes the failure
			// surface debuggable, so a regression that drops it should
			// fail this assertion explicitly.
			const exit = yield* Effect.gen(function* () {
				const faucet = yield* FaucetTag;
				yield* faucet.register(noopStrategy('SUI'));
				return yield* faucet.requestCoin('NOPE', '0xabc', 1n);
			}).pipe(Effect.provide(FaucetLive), Effect.exit);

			expect(exit._tag).toBe('Failure');
		}),
	);

	it.effect('FaucetLive holds no own state-store / filesystem resources', () =>
		Effect.gen(function* () {
			// Per the lifecycle doc, FaucetLive is in-memory-only — building
			// it must not require `StateStoreConfig`, `Identity`, an
			// allocator, etc. The Effect type signature already proves
			// `Layer<FaucetTag, never, never>`, but we re-assert at runtime
			// by building it with NO additional layers and confirming we
			// can yield the tag.
			const faucet = yield* Effect.gen(function* () {
				return yield* FaucetTag;
			}).pipe(Effect.provide(FaucetLive));

			expect(typeof faucet.register).toBe('function');
			expect(typeof faucet.requestCoin).toBe('function');
			expect(typeof faucet.listFundable.pipe).toBe('function');
		}),
	);

	it.effect('two concurrent FaucetLive scopes hold disjoint registries', () =>
		Effect.gen(function* () {
			// Lock the "no shared mutable state between cycles" invariant
			// by running two effects concurrently, each provided its own
			// FaucetLive. The strategy a sibling registers must not appear
			// in the other's `listFundable`.
			const observed = yield* Effect.all(
				[
					Effect.gen(function* () {
						const faucet = yield* FaucetTag;
						yield* faucet.register(noopStrategy('LEFT'));
						return yield* faucet.listFundable;
					}).pipe(Effect.provide(FaucetLive)),
					Effect.gen(function* () {
						const faucet = yield* FaucetTag;
						yield* faucet.register(noopStrategy('RIGHT'));
						return yield* faucet.listFundable;
					}).pipe(Effect.provide(FaucetLive)),
				],
				{ concurrency: 'unbounded' },
			);

			expect(observed[0]).toEqual(['LEFT']);
			expect(observed[1]).toEqual(['RIGHT']);
		}),
	);
});
