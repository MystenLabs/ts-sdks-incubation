import { Effect, Exit, Fiber, Option } from 'effect';
import * as TestClock from 'effect/testing/TestClock';
import { describe, expect, it } from '@effect/vitest';

import { defineFaucetStrategy } from '../../../src/plugins/faucet/index.ts';
import { faucetExhausted } from '../../../src/plugins/faucet/errors.ts';
import { requestFundsWithRetry } from '../../../src/plugins/faucet/http.ts';

describe('faucet strategy helper', () => {
	it('converts caller-supplied strategies into strategy contributions', () => {
		const strategy = {
			request: () => Effect.void,
		};
		const contribution = defineFaucetStrategy({
			chainId: 'sui:custom',
			strategy,
			priority: 10,
		});

		expect(contribution).toEqual({
			kind: 'strategy-contributor',
			capabilityKey: 'faucet:request:sui:custom',
			strategy,
			autoMounted: false,
			priority: 10,
		});
	});
});

describe('FaucetExhausted shape', () => {
	// Pinning the shape post-bug-4 fix: `kind: 'wall-clock' | 'attempts'`
	// was dropped. Wall-clock budget exhaustion is the only surface that
	// wraps the underlying cause as `FaucetExhausted` — attempt-cap
	// exhaustion lets `FaucetUnreachable | FaucetBodyError` propagate
	// verbatim (more informative than a wrapped budget message).
	it('does not carry a discriminating "kind" field anymore', () => {
		const exhausted = faucetExhausted({
			url: 'http://faucet:9123',
			address: '0xabc',
			amount: 1n,
			attempts: 3,
			message: 'budget exhausted after 3 attempts',
			lastCause: new Error('socket hang up'),
		});
		expect(exhausted._tag).toBe('FaucetExhausted');
		expect((exhausted as unknown as Record<string, unknown>).kind).toBeUndefined();
		expect(exhausted.attempts).toBe(3);
		expect(exhausted.message).toContain('budget exhausted');
	});
});

// ---------------------------------------------------------------------------
// bug-4 exit-selection behaviour (the load-bearing half the shape test omits)
// ---------------------------------------------------------------------------
//
// `requestFundsWithRetry` composes `Effect.retry(schedule)` INSIDE
// `Effect.timeoutOrElse`. The two exits MUST diverge:
//
//   - attempt-cap exhausts FIRST (small maxAttempts, generous wall-clock):
//     `Effect.retry` re-raises the LAST `FaucetUnreachable | FaucetBodyError`
//     verbatim. It must NOT be wrapped as `FaucetExhausted`.
//   - wall-clock budget elapses FIRST (large maxAttempts, tiny timeout):
//     `timeoutOrElse.orElse` fires and yields `FaucetExhausted`.
//
// The pre-existing shape test only constructs a `FaucetExhausted` value, so a
// refactor that reordered the pipe (e.g. timeout inside retry, or
// `Schedule.either`) such that attempt-cap exhaustion got wrapped as
// `FaucetExhausted` would leave it green. These drive the real production
// path through both exits to pin the selection.
describe('requestFundsWithRetry exit-selection (bug-4)', () => {
	const ADDRESS = `0x${'a'.repeat(64)}`;
	const FAUCET_URL = 'http://127.0.0.1:9123';

	// Always-failing transport stub. Rejects synchronously so the rejection
	// is a microtask (resolves before any timer) and never arms a real
	// AbortSignal timer — keeping the whole run on the TestClock.
	const stubAlwaysRejectingFetch = (calls: { count: number }) => {
		const original = globalThis.fetch;
		globalThis.fetch = ((_input, _init) => {
			calls.count += 1;
			return Promise.reject(new Error('ECONNREFUSED (stubbed transport failure)'));
		}) as typeof fetch;
		return original;
	};

	it.effect(
		'attempt-cap exhaustion re-raises FaucetUnreachable verbatim (NOT FaucetExhausted)',
		() =>
			Effect.gen(function* () {
				const calls = { count: 0 };
				const originalFetch = stubAlwaysRejectingFetch(calls);

				const exit = yield* Effect.exit(
					requestFundsWithRetry({
						faucetUrl: FAUCET_URL,
						address: ADDRESS,
						amount: 1n,
						// Tiny attempt cap, generous wall-clock budget: the
						// `recurs(maxAttempts)` arm exhausts long before the 90s
						// timeout. `initialDelayMs: 0` makes every inter-attempt
						// sleep zero-duration — on the TestClock a zero sleep
						// completes immediately (no `adjust` needed), so the whole
						// retry chain runs at virtual time 0 and the wall-clock
						// timeout never fires.
						maxAttempts: 2,
						initialDelayMs: 0,
						timeoutMs: 90_000,
					}),
				).pipe(
					Effect.ensuring(
						Effect.sync(() => {
							globalThis.fetch = originalFetch;
						}),
					),
				);

				expect(Exit.isFailure(exit)).toBe(true);
				const err = Exit.findErrorOption(exit);
				expect(Option.isSome(err)).toBe(true);
				if (Option.isSome(err)) {
					// The whole point of bug-4: the wire-level cause surfaces
					// verbatim. Wrapping it as `FaucetExhausted` here is the
					// regression this test guards.
					expect(err.value._tag).toBe('FaucetUnreachable');
				}
				// Drove the real `requestFundsOnce` path: 1 initial + maxAttempts
				// retries === 3 transport calls.
				expect(calls.count).toBe(3);
			}),
	);

	it.effect('wall-clock exhaustion surfaces FaucetExhausted carrying the attempt count', () =>
		Effect.gen(function* () {
			const calls = { count: 0 };
			const originalFetch = stubAlwaysRejectingFetch(calls);

			// Generous attempt cap, tiny wall-clock budget, and an
			// inter-attempt delay LONGER than the budget: the first attempt
			// fails instantly, the schedule parks in a 1000ms sleep, and the
			// 500ms wall-clock timeout fires first — selecting the
			// `timeoutOrElse.orElse` branch that mints `FaucetExhausted`.
			const fiber = yield* Effect.forkChild(
				Effect.exit(
					requestFundsWithRetry({
						faucetUrl: FAUCET_URL,
						address: ADDRESS,
						amount: 1n,
						maxAttempts: 1_000,
						initialDelayMs: 1_000,
						timeoutMs: 500,
					}),
				).pipe(
					Effect.ensuring(
						Effect.sync(() => {
							globalThis.fetch = originalFetch;
						}),
					),
				),
			);

			// Let the forked fiber run its first (instantly-rejecting) attempt
			// and park on both the 1000ms retry sleep and the 500ms timeout
			// sleep before we advance virtual time.
			yield* Effect.yieldNow;
			// Advance past the wall-clock budget but NOT past the retry delay:
			// the 500ms timeout resolves, the 1000ms retry sleep stays pending.
			yield* TestClock.adjust('500 millis');

			const exit = yield* Fiber.join(fiber);
			expect(Exit.isFailure(exit)).toBe(true);
			const err = Exit.findErrorOption(exit);
			expect(Option.isSome(err)).toBe(true);
			if (Option.isSome(err)) {
				expect(err.value._tag).toBe('FaucetExhausted');
				expect(err.value.message).toContain('500ms');
				// Narrow on the tag so the FaucetExhausted-only `attempts`
				// field is type-safe: the orElse branch records attempts seen.
				if (err.value._tag === 'FaucetExhausted') {
					expect(err.value.attempts).toBeGreaterThanOrEqual(1);
				}
			}
			// At least the first transport call happened (the retry sleep never
			// elapsed, so exactly one in this deterministic schedule).
			expect(calls.count).toBeGreaterThanOrEqual(1);
		}),
	);
});
