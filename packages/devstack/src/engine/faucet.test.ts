// The faucet client has three failure shapes it has to detect:
//
//   1. fetch rejected (ECONNREFUSED / DNS / TLS) → SuiHttpFaucetError
//   2. HTTP non-2xx                              → SuiHttpFaucetError
//   3. HTTP 200 with body `status: { Failure }`  → SuiHttpFaucetError
//
// The body-Failure case is the load-bearing one — during sui-localnet
// warm-up the faucet HTTP socket binds before the underlying tx
// pipeline is ready, and a naive `response.ok ? success : retry`
// would mark funding as complete when no coins were actually
// transferred. These tests pin all three at the level of the
// single-shot helper (`requestFundsOnce`) so the retry/timeout
// wrapper around it doesn't muddy the assertion. The composite
// `requestFunds` is covered by the integration tests that boot a
// real localnet.

import { Cause, Effect, Exit, Option } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';
import { SuiHttpFaucetError, requestFunds, requestFundsOnce } from './faucet.js';

// Track the original fetch so each test can restore it cleanly even
// when an assertion throws partway through.
let originalFetch: typeof globalThis.fetch;

const installFetch = (impl: typeof globalThis.fetch): void => {
	globalThis.fetch = impl;
};

beforeEach(() => {
	originalFetch = globalThis.fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

// Pull a SuiHttpFaucetError out of an Exit.Failure regardless of where it
// lands in the Cause tree (same shape `accounts.test.ts` uses).
const extractSuiHttpFaucetError = (
	exit: Exit.Exit<unknown, unknown>,
): SuiHttpFaucetError | undefined => {
	if (!Exit.isFailure(exit)) return undefined;
	const cause = (exit as unknown as { cause: Cause.Cause<unknown> }).cause;
	const opt = Cause.findErrorOption(cause);
	if (Option.isNone(opt)) return undefined;
	return opt.value instanceof SuiHttpFaucetError ? opt.value : undefined;
};

const OPTS = { faucetUrl: 'http://localhost:9123', address: '0xabc' };

describe('requestFundsOnce', () => {
	it.effect('treats a 200 body-level `status: { Failure }` as a SuiHttpFaucetError', () =>
		Effect.gen(function* () {
			installFetch(
				(async () =>
					new Response(
						JSON.stringify({
							status: { Failure: { Internal: 'gas object stale' } },
						}),
						{
							status: 200,
							headers: { 'content-type': 'application/json' },
						},
					)) as typeof fetch,
			);
			const exit = yield* requestFundsOnce(OPTS).pipe(Effect.exit);
			expect(Exit.isFailure(exit)).toBe(true);
			const err = extractSuiHttpFaucetError(exit);
			expect(err).toBeInstanceOf(SuiHttpFaucetError);
			expect(err?.message).toMatch(/Failure/);
			// The inner Internal payload should make it through for
			// debuggability.
			expect(err?.message).toContain('gas object stale');
		}),
	);

	it.effect('resolves cleanly on a `status: "Success"` body', () =>
		Effect.gen(function* () {
			installFetch(
				(async () =>
					new Response(
						JSON.stringify({
							status: 'Success',
							coins_sent: [{ id: '0xdeadbeef', amount: 1_000_000_000 }],
						}),
						{
							status: 200,
							headers: { 'content-type': 'application/json' },
						},
					)) as typeof fetch,
			);
			yield* requestFundsOnce(OPTS);
		}),
	);

	it.effect('surfaces fetch rejection (network error) as a SuiHttpFaucetError', () =>
		Effect.gen(function* () {
			installFetch((async () => {
				throw new Error('ECONNREFUSED 127.0.0.1:9123');
			}) as typeof fetch);
			const exit = yield* requestFundsOnce(OPTS).pipe(Effect.exit);
			expect(Exit.isFailure(exit)).toBe(true);
			const err = extractSuiHttpFaucetError(exit);
			expect(err).toBeInstanceOf(SuiHttpFaucetError);
			// Stable user-facing prefix from `Effect.tryPromise`'s catch.
			expect(err?.message).toBe('faucet request failed');
			expect(err?.url).toBe(OPTS.faucetUrl);
			expect(err?.address).toBe(OPTS.address);
		}),
	);

	it.effect('non-OK HTTP status maps to SuiHttpFaucetError carrying status text', () =>
		// Documents the third failure branch — the 503 / 500 path that
		// fires while the upstream sui-faucet binary is still binding
		// its socket. Also serves as a regression guard against anyone
		// "simplifying" the !response.ok check away.
		Effect.gen(function* () {
			installFetch(
				(async () =>
					new Response('upstream unavailable', {
						status: 503,
						statusText: 'Service Unavailable',
					})) as typeof fetch,
			);
			const exit = yield* requestFundsOnce(OPTS).pipe(Effect.exit);
			expect(Exit.isFailure(exit)).toBe(true);
			const err = extractSuiHttpFaucetError(exit);
			expect(err).toBeInstanceOf(SuiHttpFaucetError);
			expect(err?.message).toContain('503');
		}),
	);
});

// `requestFunds` adds retry + wall-clock budget around `requestFundsOnce`.
// Today's defaults (90s, 40 attempts) are reproduced exactly when the new
// `timeoutMs` / `maxAttempts` / `initialDelayMs` opts are unset — these
// tests cover the override path so a CI config aimed at a broken faucet
// can fail in seconds instead of the 90s × N-accounts wall-clock.
//
// These tests use `it.live` (real clock) rather than `it.effect` because
// the retry schedule sleeps between attempts; `it.effect`'s TestClock
// would freeze on the first `Schedule.exponential` delay. The custom
// `initialDelayMs`/`timeoutMs` keep the wall-clock cost <1s.
describe('requestFunds — configurable retry budget', () => {
	it.live(
		'maxAttempts override bounds the retry schedule (fail-fast against a broken faucet)',
		() =>
			// With a tiny `maxAttempts` and `initialDelayMs`, a perpetually
			// failing fetch should surface a SuiHttpFaucetError quickly rather than
			// hammering the default 40-attempt schedule. The wall-clock
			// timeout is held well above the schedule's max delay so the
			// failure path under test is "schedule exhausted", not "wall
			// clock fired".
			Effect.gen(function* () {
				let calls = 0;
				installFetch((async () => {
					calls += 1;
					throw new Error('ECONNREFUSED 127.0.0.1:9123');
				}) as typeof fetch);
				const started = Date.now();
				const exit = yield* requestFunds({
					...OPTS,
					maxAttempts: 2,
					initialDelayMs: 1,
					timeoutMs: 4_000,
				}).pipe(Effect.exit);
				const elapsed = Date.now() - started;
				expect(Exit.isFailure(exit)).toBe(true);
				// Hard upper bound — with maxAttempts=2 and initialDelay=1ms,
				// the schedule completes near-instantly. If a future refactor
				// silently ignored `maxAttempts`, the default 40-attempt
				// schedule would push elapsed well past this bound.
				expect(elapsed).toBeLessThan(2_000);
				// Schedule.recurs(N) = initial attempt + N retries.
				expect(calls).toBeGreaterThanOrEqual(2);
				expect(calls).toBeLessThanOrEqual(3);
			}),
	);

	it.live('timeoutMs override surfaces in the wall-clock failure message', () =>
		// Force the wall-clock branch by spacing retries far enough apart
		// that the custom `timeoutMs` fires before the schedule exhausts.
		// The error message should reflect the override value, not the
		// 90s default — that's the user-visible signal that the knob is
		// wired through.
		Effect.gen(function* () {
			installFetch((async () => {
				throw new Error('ECONNREFUSED 127.0.0.1:9123');
			}) as typeof fetch);
			const exit = yield* requestFunds({
				...OPTS,
				timeoutMs: 100,
				// Large attempt budget + large initial delay so the
				// schedule can't exhaust before the wall-clock fires.
				maxAttempts: 1000,
				initialDelayMs: 200,
			}).pipe(Effect.exit);
			expect(Exit.isFailure(exit)).toBe(true);
			const err = extractSuiHttpFaucetError(exit);
			expect(err).toBeInstanceOf(SuiHttpFaucetError);
			expect(err?.message).toContain('100ms');
		}),
	);
});
