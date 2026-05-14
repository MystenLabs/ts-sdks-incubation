// The faucet client has three failure shapes it has to detect:
//
//   1. fetch rejected (ECONNREFUSED / DNS / TLS) → FaucetError
//   2. HTTP non-2xx                              → FaucetError
//   3. HTTP 200 with body `status: { Failure }`  → FaucetError
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
import { FaucetError, requestFundsOnce } from './faucet.js';

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

// Pull a FaucetError out of an Exit.Failure regardless of where it
// lands in the Cause tree (same shape `accounts.test.ts` uses).
const extractFaucetError = (
	exit: Exit.Exit<unknown, unknown>,
): FaucetError | undefined => {
	if (!Exit.isFailure(exit)) return undefined;
	const cause = (exit as unknown as { cause: Cause.Cause<unknown> }).cause;
	const opt = Cause.findErrorOption(cause);
	if (Option.isNone(opt)) return undefined;
	return opt.value instanceof FaucetError ? opt.value : undefined;
};

const OPTS = { faucetUrl: 'http://localhost:9123', address: '0xabc' };

describe('requestFundsOnce', () => {
	it.effect('treats a 200 body-level `status: { Failure }` as a FaucetError', () =>
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
			const err = extractFaucetError(exit);
			expect(err).toBeInstanceOf(FaucetError);
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

	it.effect('surfaces fetch rejection (network error) as a FaucetError', () =>
		Effect.gen(function* () {
			installFetch(
				(async () => {
					throw new Error('ECONNREFUSED 127.0.0.1:9123');
				}) as typeof fetch,
			);
			const exit = yield* requestFundsOnce(OPTS).pipe(Effect.exit);
			expect(Exit.isFailure(exit)).toBe(true);
			const err = extractFaucetError(exit);
			expect(err).toBeInstanceOf(FaucetError);
			// Stable user-facing prefix from `Effect.tryPromise`'s catch.
			expect(err?.message).toBe('faucet request failed');
			expect(err?.url).toBe(OPTS.faucetUrl);
			expect(err?.address).toBe(OPTS.address);
		}),
	);

	it.effect('non-OK HTTP status maps to FaucetError carrying status text', () =>
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
			const err = extractFaucetError(exit);
			expect(err).toBeInstanceOf(FaucetError);
			expect(err?.message).toContain('503');
		}),
	);
});
