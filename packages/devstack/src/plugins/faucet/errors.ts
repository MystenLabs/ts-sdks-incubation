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
//   - A wall-clock budget exhaustion is distinct from a retry-count
//     exhaustion; both surface through the same `FaucetExhausted`
//     class but carry the discriminating field.
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
 * Retry-budget exhaustion. The wall-clock budget elapsed before any
 * attempt succeeded, OR the attempt count cap was hit first. Both
 * paths land here; `kind` discriminates so renderers can distinguish
 * "we ran out of time" from "we ran out of attempts".
 *
 * Carries the last underlying cause so pretty-error rendering can
 * show what was actually failing instead of just the budget message.
 */
export interface FaucetExhausted {
	readonly _tag: 'FaucetExhausted';
	readonly kind: 'wall-clock' | 'attempts';
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

/**
 * Unknown coin / chain id at dispatch. The strategy registry held
 * no contributor matching `capabilityKey`. The error names the
 * registered set so users can see "I asked for X, only Y is wired".
 *
 * Distinct from substrate-level `StrategyNotFoundError` — this one
 * is faucet-flavored (carries amount + address) and lives at the
 * plugin's public boundary.
 */
export interface FaucetStrategyMissing {
	readonly _tag: 'FaucetStrategyMissing';
	readonly capabilityKey: string;
	readonly address: string;
	readonly amount: bigint;
	readonly registeredKeys: ReadonlyArray<string>;
	readonly hint: string;
}

export const faucetStrategyMissing = (
	parts: Omit<FaucetStrategyMissing, '_tag'>,
): FaucetStrategyMissing => ({
	_tag: 'FaucetStrategyMissing',
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
	| FaucetStrategyMissing
	| FaucetConfigError;
