// Sui faucet client. Posts a fixed-amount funding request to a localnet /
// devnet faucet HTTP endpoint and returns once the faucet accepts it.
//
// We intentionally don't parse the response body. The faucet returns task
// metadata that callers in this repo don't use, and the on-chain effect is
// observed via balance polling rather than the HTTP response anyway.
//
// The faucet HTTP server typically comes up a beat AFTER the JSON-RPC
// server inside the sui-localnet container — the first POST that follows
// the RPC ready-probe can land before the faucet has bound its socket,
// and a 503/500/ECONNREFUSED leaks all the way back to `accounts` and
// fails the whole layer build. Internal retry with bounded exponential
// backoff keeps that race from being a user-visible flake.

import { Effect, Ref, Schedule, Schema } from 'effect';

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

export class FaucetError extends Schema.TaggedErrorClass<FaucetError>()('FaucetError', {
	url: Schema.String,
	address: Schema.String,
	message: Schema.String,
	// HTTP analog of the docker/sui stderr/stdout/exitCode shape. `stderr`
	// carries the response body (or surrounding error text), `exitCode`
	// the HTTP status code. `stdout` isn't generally useful for HTTP but
	// kept here so pretty-error.ts can render the same uniform block for
	// every subprocess/HTTP-wrapping tagged error.
	stderr: Schema.optional(Schema.String),
	stdout: Schema.optional(Schema.String),
	exitCode: Schema.optional(Schema.Number),
	cause: Schema.optional(Schema.Defect),
}) {}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

// Bounded exponential backoff with jitter. Default schedule (15
// attempts × 500ms initial × 1.5 growth + jitter) is paired with the
// 90s wall-clock budget at the call site — long enough to absorb a
// cold sui-localnet boot where the faucet binary needs ~30-60s after
// its HTTP socket opens before it can actually submit transactions
// (during that window it returns 503 / Internal). Callers can
// override all three via `requestFunds`'s
// `maxAttempts` / `initialDelayMs` / `timeoutMs` opts.
//
// C14: pre-fix this was 40 attempts with no jitter. Each retry burned
// ~5s through the per-fetch timeout, so a fully unhealthy faucet
// dragged out the cold path well past its 90s budget AND every
// account's retry schedule landed on the same wall-clock tick,
// thundering-herd hammering the faucet. Jitter spreads those, and
// the lower attempt count fail-fasts the broken-faucet case while
// the budget still covers the legitimate cold-start path.
const DEFAULT_MAX_ATTEMPTS = 15;
const DEFAULT_INITIAL_DELAY_MS = 500;
const DEFAULT_TIMEOUT_MS = 90_000;
const BACKOFF_FACTOR = 1.5;

const makeFaucetRetrySchedule = (initialDelayMs: number, maxAttempts: number) =>
	Schedule.exponential(`${initialDelayMs} millis`, BACKOFF_FACTOR).pipe(
		// `Schedule.jittered` multiplies each delay by a random factor
		// in [0.8, 1.2) (Effect v4 default) so concurrent account
		// retries don't synchronize on the wall clock.
		Schedule.jittered,
		Schedule.both(Schedule.recurs(maxAttempts)),
	);

// Single-shot faucet POST + body parse. Exported so unit tests can
// pin the body-level Failure detection without paying the retry /
// 90s-timeout cost of the full `requestFunds` wrapper. Production
// callers always go through `requestFunds`, which adds the retry
// schedule and a wall-clock budget on top.
// Per-POST hard deadline. The sui-faucet binary internally retries the
// underlying SUI transfer tx twice with ~30s timeouts, so a request
// against a cold chain (no recent checkpoints) blocks for ~60s before
// returning 500. That single slow response burns through most of our
// 90s budget in one shot. By aborting at 5s we let the outer retry
// loop hammer the faucet quickly — when the chain catches up, the
// next attempt lands in <1s and we're done. Successful warm-faucet
// calls return in well under 1s, so 5s is a safe upper bound.
const FAUCET_FETCH_TIMEOUT_MS = 5_000;

export const requestFundsOnce = (opts: {
	faucetUrl: string;
	address: string;
}): Effect.Effect<void, FaucetError> =>
	Effect.gen(function* () {
		const endpoint = `${opts.faucetUrl}/v2/gas`;
		const response = yield* Effect.tryPromise({
			try: () =>
				fetch(endpoint, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						FixedAmountRequest: { recipient: opts.address },
					}),
					signal: AbortSignal.timeout(FAUCET_FETCH_TIMEOUT_MS),
				}),
			catch: (cause) =>
				new FaucetError({
					url: opts.faucetUrl,
					address: opts.address,
					message: 'faucet request failed',
					cause,
				}),
		});

		// A non-OK status is a "not yet ready" signal too — the v2
		// faucet returns 503 while the upstream sui-faucet binary
		// is still binding its socket, and the same retry shape
		// that catches `ECONNREFUSED` should catch those. 200
		// short-circuits.
		if (!response.ok) {
			// Best-effort body read so a meaningful error payload (the v2
			// faucet emits a plain-text reason on 503) surfaces in the
			// structured `stderr` field instead of being lost.
			const body = yield* Effect.tryPromise({
				try: () => response.text(),
				catch: () => undefined,
			}).pipe(Effect.catch(() => Effect.succeed<string | undefined>(undefined)));
			return yield* Effect.fail(
				new FaucetError({
					url: opts.faucetUrl,
					address: opts.address,
					message: `faucet returned ${response.status} ${response.statusText}`,
					stderr: body !== undefined && body.length > 0 ? body : undefined,
					exitCode: response.status,
				}),
			);
		}
		// 200 OK can still be a failure — the sui-faucet binary
		// returns `{"status": {"Failure": {"Internal": "..."}}}`
		// in the body when it accepted the request but couldn't
		// execute the underlying tx (gas object stale, consensus
		// hiccup). Treat that as retryable so a transient failure
		// during sui-localnet warm-up doesn't surface as "funded"
		// when no coins were actually transferred.
		const body = (yield* Effect.tryPromise({
			try: () => response.json() as Promise<unknown>,
			catch: (cause) =>
				new FaucetError({
					url: opts.faucetUrl,
					address: opts.address,
					message: 'faucet response was not valid JSON',
					cause,
				}),
		})) as { status?: unknown };
		const status = body.status;
		if (typeof status === 'object' && status !== null && 'Failure' in status) {
			const failurePayload = JSON.stringify((status as { Failure: unknown }).Failure);
			return yield* Effect.fail(
				new FaucetError({
					url: opts.faucetUrl,
					address: opts.address,
					message: `faucet response status: Failure (${failurePayload})`,
					stderr: failurePayload,
					exitCode: response.status,
				}),
			);
		}
	});

export const requestFunds = (opts: {
	faucetUrl: string;
	address: string;
	/**
	 * Called on each retryable failure with the attempt count (1-indexed)
	 * and the latest error. Lets callers surface "waiting on the faucet
	 * (attempt N)" in their TUI row so a slow cold-start doesn't look
	 * like a hang. Optional — callers that don't care can omit it.
	 */
	onAttempt?: (attempt: number, error: FaucetError) => Effect.Effect<void>;
	/**
	 * Wall-clock budget for the whole funding request, including all
	 * retries. Defaults to 90_000 (90s) — sized for a cold sui-localnet
	 * boot. CI configs that point at a clearly-broken faucet can lower
	 * this so failure surfaces in seconds instead of minutes-per-account.
	 */
	timeoutMs?: number;
	/**
	 * Maximum number of retry attempts before giving up (the initial
	 * attempt plus `maxAttempts` retries). Defaults to 40 — paired with
	 * the default 90s budget, the schedule saturates well before the
	 * wall-clock timeout fires. Lower to fail-fast against a broken
	 * faucet.
	 */
	maxAttempts?: number;
	/**
	 * Initial delay between retries, in milliseconds. Subsequent delays
	 * grow by a fixed 1.5x factor (exponential backoff). Defaults to
	 * 500ms.
	 */
	initialDelayMs?: number;
}): Effect.Effect<void, FaucetError> =>
	Effect.gen(function* () {
		const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
		const initialDelayMs = opts.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
		// `faucetUrl` is the BASE (e.g. `http://localhost:9123`). The v2
		// gas path is appended by `requestFundsOnce` — matches v3's
		// `accounts.ts:440` convention so callers (and any externally
		// supplied faucet URL) only deal in bases.
		yield* Effect.annotateCurrentSpan({
			'faucet.url': opts.faucetUrl,
			'faucet.address': opts.address,
		});

		const attempts = yield* Ref.make(0);
		const lastError = yield* Ref.make<FaucetError | undefined>(undefined);
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
			Effect.retry(makeFaucetRetrySchedule(initialDelayMs, maxAttempts)),
			Effect.timeoutOrElse({
				duration: `${timeoutMs} millis`,
				orElse: () =>
					Effect.gen(function* () {
						const n = yield* Ref.get(attempts);
						const last = yield* Ref.get(lastError);
						return yield* Effect.fail(
							new FaucetError({
								url: opts.faucetUrl,
								address: opts.address,
								message:
									`faucet did not accept request within ${timeoutMs}ms ` +
									`(${n} attempts; last error: ${last?.message ?? 'unknown'})`,
								...(last?.stderr ? { stderr: last.stderr } : {}),
								...(last?.exitCode !== undefined ? { exitCode: last.exitCode } : {}),
							}),
						);
					}),
			}),
		);
	}).pipe(Effect.withSpan('Faucet.requestFunds'));
