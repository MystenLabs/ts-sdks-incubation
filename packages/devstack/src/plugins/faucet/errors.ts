// Faucet plugin — typed errors.
//
// Architecture (distilled doc §Invariants / §Edge cases):
//   - A non-2xx HTTP status MUST raise (NOT be silently treated as
//     success). The Sui faucet binary binds its socket before its
//     validator can transfer coins → the warm-up window returns 5xx.
//   - A 200 OK body carrying `{ status: { Failure: ... } }` MUST
//     raise. The most load-bearing wire-level invariant: during
//     warm-up the faucet accepts requests it cannot execute, and
//     treating those bodies as success marks accounts funded when
//     no coins moved.
//   - Wall-clock budget exhaustion surfaces as `FaucetExhausted`. The
//     attempt-cap (`maxRetries` on the underlying retry schedule)
//     re-raises the LAST `FaucetUnreachable | FaucetBodyError` directly
//     — wrapping it in `FaucetExhausted` would just hide the wire-level
//     error the cap was triggered by. The wall-clock budget is the
//     dominant exit; the attempt cap exists as a safety net.
//
// Effect v4: tagged errors are plain interfaces; `Effect.catchTag` /
// `catchTags` match on the `_tag` literal.

import { defineConfigError, type ConfigIssue } from '../../substrate/runtime/config-validation.ts';

/**
 * Transport-level reachability failure. Raised when `fetch` itself
 * rejects (ECONNREFUSED, DNS failure, TLS failure, AbortSignal
 * timeout). Typical during cold boot before the faucet HTTP server
 * binds.
 *
 * The retry loop catches this; it surfaces to the caller only after
 * the wall-clock budget elapses.
 */
export interface FaucetUnreachable {
	readonly _tag: 'FaucetUnreachable';
	readonly url: string;
	readonly address: string;
	readonly amount: bigint;
	readonly message: string;
	readonly cause?: unknown;
}

export const faucetUnreachable = (parts: Omit<FaucetUnreachable, '_tag'>): FaucetUnreachable => ({
	_tag: 'FaucetUnreachable',
	...parts,
});

/**
 * Wall-clock budget exhaustion. The retry loop did not land a
 * successful attempt within the configured `timeoutMs`.
 *
 * The attempt-count cap (`maxRetries` on the schedule) does NOT
 * surface as `FaucetExhausted` — when the retry schedule exhausts,
 * Effect re-raises the LAST `FaucetUnreachable | FaucetBodyError`
 * verbatim, which is more informative than a wrapped budget message.
 * Callers handling `FaucetUnreachable | FaucetBodyError` already see
 * the right wire-level cause.
 *
 * Carries the last underlying cause so pretty-error rendering can
 * show what was actually failing instead of just the budget message.
 */
export interface FaucetExhausted {
	readonly _tag: 'FaucetExhausted';
	readonly url: string;
	readonly address: string;
	readonly amount: bigint;
	readonly attempts: number;
	readonly message: string;
	readonly lastCause?: unknown;
}

export const faucetExhausted = (parts: Omit<FaucetExhausted, '_tag'>): FaucetExhausted => ({
	_tag: 'FaucetExhausted',
	...parts,
});

/**
 * Body-level Failure on a 200 OK. The load-bearing invariant: the
 * Sui faucet returns `{ status: { Failure: ... } }` when it accepted
 * the request but couldn't execute the underlying tx (gas object
 * stale, mid-genesis, consensus hiccup).
 *
 * Also covers JSON-parse failures on a 200 body and other malformed-
 * response cases — anything that means "the HTTP layer says OK but
 * the body does not confirm a successful transfer". Caller code MUST
 * treat this as a failed funding, not a silent success.
 */
export interface FaucetBodyError {
	readonly _tag: 'FaucetBodyError';
	readonly url: string;
	readonly address: string;
	readonly amount: bigint;
	readonly status: number;
	readonly reason: 'failure-status' | 'malformed-body' | 'invalid-json';
	readonly message: string;
	/** The raw body payload (truncated where necessary) for diagnostics. */
	readonly bodySnippet?: string;
}

export const faucetBodyError = (parts: Omit<FaucetBodyError, '_tag'>): FaucetBodyError => ({
	_tag: 'FaucetBodyError',
	...parts,
});

export interface FaucetConfigError extends ConfigIssue {
	readonly _tag: 'FaucetConfigError';
}

export const faucetConfigError = defineConfigError('FaucetConfigError');

/** Union of every error a faucet caller may encounter. */
export type FaucetError =
	| FaucetUnreachable
	| FaucetExhausted
	| FaucetBodyError
	| FaucetConfigError;
