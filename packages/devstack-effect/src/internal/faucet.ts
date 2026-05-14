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

import { Effect, Schedule, Schema } from 'effect';

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

export class FaucetError extends Schema.TaggedErrorClass<FaucetError>()('FaucetError', {
	url: Schema.String,
	address: Schema.String,
	message: Schema.String,
	cause: Schema.optional(Schema.Defect),
}) {}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

// Bounded exponential backoff capped at 40 attempts. Paired with a
// 90s wall-clock budget at the call site — long enough to absorb a
// cold sui-localnet boot where the faucet binary needs ~30-60s after
// its HTTP socket opens before it can actually submit transactions
// (during that window it returns 503 / Internal). 30s was too tight
// and produced flaky funding failures on the first run after a wipe.
const faucetRetrySchedule = Schedule.exponential('500 millis', 1.5).pipe(
	Schedule.both(Schedule.recurs(40)),
);

export const requestFunds = (opts: {
	faucetUrl: string;
	address: string;
}): Effect.Effect<void, FaucetError> =>
	Effect.gen(function* () {
		// `faucetUrl` is the BASE (e.g. `http://localhost:9123`). The v2
		// gas path is appended here — matches v3's `accounts.ts:440`
		// convention so callers (and any externally supplied faucet URL)
		// only deal in bases.
		const endpoint = `${opts.faucetUrl}/v2/gas`;
		yield* Effect.annotateCurrentSpan({
			'faucet.url': opts.faucetUrl,
			'faucet.address': opts.address,
		});

		const attempt = Effect.gen(function* () {
			const response = yield* Effect.tryPromise({
				try: () =>
					fetch(endpoint, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							FixedAmountRequest: { recipient: opts.address },
						}),
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
				return yield* Effect.fail(
					new FaucetError({
						url: opts.faucetUrl,
						address: opts.address,
						message: `faucet returned ${response.status} ${response.statusText}`,
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
				return yield* Effect.fail(
					new FaucetError({
						url: opts.faucetUrl,
						address: opts.address,
						message: `faucet response status: Failure (${JSON.stringify((status as { Failure: unknown }).Failure)})`,
					}),
				);
			}
		});

		yield* attempt.pipe(
			Effect.retry(faucetRetrySchedule),
			Effect.timeoutOrElse({
				duration: '90 seconds',
				orElse: () =>
					Effect.fail(
						new FaucetError({
							url: opts.faucetUrl,
							address: opts.address,
							message: 'faucet did not accept request within 90s',
						}),
					),
			}),
		);
	}).pipe(Effect.withSpan('Faucet.requestFunds'));
