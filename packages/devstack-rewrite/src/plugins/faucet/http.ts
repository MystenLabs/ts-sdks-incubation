// Faucet HTTP wrapper.
//
// One module per the distilled-doc "collapse engine/service split"
// guidance — the HTTP helper is the only wire-level path for any
// HTTP-based faucet strategy, and it lives WITH the plugin instead
// of in a sibling engine module.
//
// Wire-level invariants (distilled doc §Invariants):
//
//   1. A non-2xx HTTP status MUST raise (NOT be treated as success).
//      The Sui faucet binds its TCP socket before its validator can
//      transfer coins — the warm-up window returns 5xx and must be
//      retried, not silently absorbed.
//
//   2. A 200 OK body with `{ status: { Failure: ... } }` MUST raise.
//      The single most load-bearing invariant in this module: during
//      warm-up the faucet ACCEPTS requests it cannot execute (gas
//      object stale, consensus hiccup, mid-genesis). Treating those
//      bodies as success marks accounts funded when no coins moved.
//
//   3. Per-fetch deadline is short relative to wall-clock budget
//      (5s vs 90s). The faucet's internal retries can block one POST
//      for ~60s; capping each POST lets the outer retry loop hammer
//      quickly and land on the first attempt after the chain catches
//      up.
//
//   4. Retry MUST jitter. Pre-jitter, parallel-account retries
//      synchronized on the wall-clock tick and thundering-herded the
//      faucet.
//
// The shared funds-transferable barrier (invariant #5 in the doc)
// is owned by Sui and surfaced via the `gate:funds-ready` strategy
// in `contracts/network-resolver.ts`; consumers call it before the
// FIRST POST. This module is barrier-agnostic: it assumes callers
// gate themselves.
//
// HTTP transport: `globalThis.fetch` + `AbortSignal.timeout`. Kept
// direct rather than going through `@effect/platform-node`'s
// `HttpClient`: this body owns the wire-level contract (status,
// body-Failure detection, per-fetch deadline) and adding the Effect
// HttpClient layer here would not change behaviour at any of the
// invariants above.

import { Effect, Ref, Schedule } from 'effect';

import {
	faucetBodyError,
	faucetExhausted,
	faucetUnreachable,
	type FaucetBodyError,
	type FaucetExhausted,
	type FaucetUnreachable,
} from './errors.ts';

// ---------------------------------------------------------------------------
// Default retry profile
// ---------------------------------------------------------------------------

/** Retry attempts cap. Paired with the wall-clock budget below: at
 *  500ms initial × 1.5 backoff × jitter, 15 attempts saturates well
 *  before 90s, so the wall-clock check is the dominant exit. */
export const DEFAULT_MAX_ATTEMPTS = 15;

/** Initial delay between retries (ms). Subsequent delays grow by
 *  the `BACKOFF_FACTOR`. */
export const DEFAULT_INITIAL_DELAY_MS = 500;

/** Wall-clock budget for the WHOLE request including all retries.
 *  Sized for a cold sui-localnet boot — the validator binary needs
 *  ~30–60s after its HTTP socket opens before it can submit txs. */
export const DEFAULT_TIMEOUT_MS = 90_000;

/** Exponential growth factor between retries. */
export const BACKOFF_FACTOR = 1.5;

/** Per-POST hard deadline. The sui-faucet binary internally retries
 *  the underlying SUI transfer tx twice with ~30s timeouts; a single
 *  cold-chain request blocks ~60s before returning 500. Capping each
 *  POST at 5s lets the outer retry loop hammer quickly — when the
 *  chain catches up the next attempt lands in <1s. Successful
 *  warm-faucet calls return well under 1s, so 5s is a safe ceiling. */
export const DEFAULT_FETCH_DEADLINE_MS = 5_000;

/** Build the retry schedule. Jitter spreads parallel account retries
 *  across the wall-clock so they don't thundering-herd the faucet
 *  on the same tick. Effect's `Schedule.jittered` multiplies each
 *  delay by a random factor in `[0.8, 1.2)` by default. */
const makeRetrySchedule = (initialDelayMs: number, maxAttempts: number) =>
	Schedule.exponential(`${initialDelayMs} millis`, BACKOFF_FACTOR).pipe(
		Schedule.jittered,
		Schedule.both(Schedule.recurs(maxAttempts)),
	);

// ---------------------------------------------------------------------------
// Single-shot POST + body parser
// ---------------------------------------------------------------------------

/** Configuration for a single faucet POST. */
export interface FaucetPostOptions {
	/** Base URL — e.g. `http://localhost:9123` or
	 *  `https://faucet.testnet.sui.io`. Path is appended internally. */
	readonly faucetUrl: string;
	/** Recipient address. */
	readonly address: string;
	/** Amount in the strategy-native unit (carried through to error
	 *  payloads). The Sui HTTP faucet itself ignores `amount` and
	 *  funds a fixed grant per request; the field is here so
	 *  exhaustion errors carry the unit-correct value. */
	readonly amount: bigint;
	/** Endpoint path (default `/v2/gas`). Live faucets sometimes
	 *  diverge — `/gas` on older endpoints. */
	readonly path?: string;
	/** Per-fetch deadline in ms (default `DEFAULT_FETCH_DEADLINE_MS`). */
	readonly fetchDeadlineMs?: number;
}

/**
 * One-shot POST: send + check status + parse body + check body
 * status. Exported so tests can pin the body-Failure detection
 * without paying the retry / wall-clock cost of the wrapper. Production
 * callers go through `requestFundsWithRetry`.
 *
 * Failure modes raised:
 *   - `FaucetUnreachable` on transport failure (fetch reject, abort
 *      timeout, network error).
 *   - `FaucetBodyError` on non-2xx, body Failure status, or
 *     unparseable JSON. The doc-load-bearing distinction.
 */
export const requestFundsOnce = (
	opts: FaucetPostOptions,
): Effect.Effect<void, FaucetUnreachable | FaucetBodyError> =>
	Effect.gen(function* () {
		const path = opts.path ?? '/v2/gas';
		const endpoint = `${opts.faucetUrl}${path}`;
		const deadlineMs = opts.fetchDeadlineMs ?? DEFAULT_FETCH_DEADLINE_MS;

		const response = yield* Effect.tryPromise({
			try: () =>
				fetch(endpoint, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						FixedAmountRequest: { recipient: opts.address },
					}),
					signal: AbortSignal.timeout(deadlineMs),
				}),
			catch: (cause) =>
				faucetUnreachable({
					url: opts.faucetUrl,
					address: opts.address,
					amount: opts.amount,
					message: `faucet POST to ${endpoint} failed (transport)`,
					cause,
				}),
		});

		// Invariant #1: non-2xx MUST raise. We read the body
		// best-effort so the diagnostic carries the upstream reason
		// instead of just a numeric status.
		if (!response.ok) {
			const body = yield* Effect.tryPromise({
				try: () => response.text(),
				catch: () => undefined,
			}).pipe(Effect.orElseSucceed(() => undefined as string | undefined));
			return yield* Effect.fail(
				faucetBodyError({
					url: opts.faucetUrl,
					address: opts.address,
					amount: opts.amount,
					status: response.status,
					reason: 'failure-status',
					message: `faucet returned ${response.status} ${response.statusText}`,
					...(body !== undefined && body.length > 0 ? { bodySnippet: body } : {}),
				}),
			);
		}

		// Invariant #2: 200 OK with body-level Failure MUST raise.
		// We treat JSON-parse failure as a `malformed-body` raise too —
		// during cold boot the faucet very occasionally writes an empty
		// or truncated body before it's ready, and silently accepting
		// that mirrors the bug we're explicitly guarding against.
		const body = (yield* Effect.tryPromise({
			try: () => response.json() as Promise<unknown>,
			catch: (cause) =>
				faucetBodyError({
					url: opts.faucetUrl,
					address: opts.address,
					amount: opts.amount,
					status: response.status,
					reason: 'invalid-json',
					message: 'faucet response was not valid JSON',
					...(cause !== undefined ? { bodySnippet: String(cause) } : {}),
				}),
		})) as { status?: unknown };

		const status = body.status;
		if (typeof status === 'object' && status !== null && 'Failure' in status) {
			const payload = JSON.stringify((status as { Failure: unknown }).Failure);
			return yield* Effect.fail(
				faucetBodyError({
					url: opts.faucetUrl,
					address: opts.address,
					amount: opts.amount,
					status: response.status,
					reason: 'failure-status',
					message: `faucet body reported Failure: ${payload}`,
					bodySnippet: payload,
				}),
			);
		}
	}).pipe(Effect.withSpan('faucet.requestFundsOnce'));

// ---------------------------------------------------------------------------
// Retry wrapper
// ---------------------------------------------------------------------------

/** Configuration for a retry-wrapped faucet POST. */
export interface RetryOptions extends FaucetPostOptions {
	/** Wall-clock budget for the WHOLE request including retries.
	 *  Default `DEFAULT_TIMEOUT_MS`. CI configs pointing at a clearly
	 *  broken faucet can lower this to fail-fast. */
	readonly timeoutMs?: number;
	/** Max attempts cap. Default `DEFAULT_MAX_ATTEMPTS`. */
	readonly maxAttempts?: number;
	/** Initial inter-attempt delay (ms). Default
	 *  `DEFAULT_INITIAL_DELAY_MS`. */
	readonly initialDelayMs?: number;
	/** Optional per-attempt callback. Lets callers surface "waiting
	 *  on faucet (attempt N)" in a TUI row so cold-start doesn't look
	 *  like a hang. */
	readonly onAttempt?: (
		attempt: number,
		error: FaucetUnreachable | FaucetBodyError,
	) => Effect.Effect<void>;
}

/**
 * Retry-wrapped POST. Combines `requestFundsOnce` with a jittered
 * exponential schedule and a wall-clock budget; on exhaustion raises
 * `FaucetExhausted` carrying the last underlying cause.
 *
 * Invariant #4 (jitter): handled by the schedule above. Invariant #3
 * (per-fetch deadline): handled by `requestFundsOnce`'s
 * `AbortSignal.timeout`.
 */
export const requestFundsWithRetry = (
	opts: RetryOptions,
): Effect.Effect<void, FaucetExhausted | FaucetUnreachable | FaucetBodyError> =>
	Effect.gen(function* () {
		const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
		const initialDelayMs = opts.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;

		yield* Effect.annotateCurrentSpan({
			'faucet.url': opts.faucetUrl,
			'faucet.address': opts.address,
			'faucet.amount': opts.amount.toString(),
			'faucet.budget_ms': timeoutMs,
			'faucet.max_attempts': maxAttempts,
		});

		const attempts = yield* Ref.make(0);
		const lastError = yield* Ref.make<FaucetUnreachable | FaucetBodyError | undefined>(undefined);

		const wrapped = requestFundsOnce(opts).pipe(
			Effect.tapError((err) =>
				Effect.gen(function* () {
					const n = yield* Ref.updateAndGet(attempts, (x) => x + 1);
					yield* Ref.set(lastError, err);
					if (opts.onAttempt !== undefined) {
						yield* opts.onAttempt(n, err);
					}
				}),
			),
		);

		yield* wrapped.pipe(
			Effect.retry(makeRetrySchedule(initialDelayMs, maxAttempts)),
			Effect.timeoutOrElse({
				duration: `${timeoutMs} millis`,
				orElse: () =>
					Effect.gen(function* () {
						const n = yield* Ref.get(attempts);
						const last = yield* Ref.get(lastError);
						return yield* Effect.fail(
							faucetExhausted({
								kind: 'wall-clock',
								url: opts.faucetUrl,
								address: opts.address,
								amount: opts.amount,
								attempts: n,
								message:
									`faucet did not accept request within ${timeoutMs}ms ` +
									`(${n} attempts; last: ${last?.message ?? 'unknown'})`,
								lastCause: last,
							}),
						);
					}),
			}),
		);
	}).pipe(Effect.withSpan('faucet.requestFundsWithRetry'));
