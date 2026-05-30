// Internal plugin helpers — funding-failure error envelope.
//
// `fundingFailureError` collapses the two near-identical
// `accountAcquireError` builds in `plugins/account/funding.ts` that wrap
// a strategy `request(...)` failure during funding:
//
//   - `fund-default`         — the ephemeral-account SUI faucet path
//                              (the `wrapFaucetFailure` site).
//   - `fund-cross-cutting`   — the per-coin cross-cutting path
//                              (the `wrapCrossCuttingFailure` site).
//
// Both sites produced an `AccountAcquireError` with the same shape
// (`phase`, `accountName`, `variant`, `cause`, `message`, `hint`), the
// same `(tag=...)` suffix extracted from the cause, and a phase-specific
// hint. This helper centralizes the tag extraction and the phase →
// (message-template, hint) mapping so the call sites collapse to a
// single line each.
//
// Internal to this package — not re-exported from the root barrel.

import {
	accountAcquireError,
	type AccountAcquireError,
	type AccountVariantKind,
} from '../account/errors.ts';

/** Discriminated spec for `fundingFailureError`. Each phase carries
 *  the identifying fields it needs to preserve byte-identical message
 *  output with the original inline builders in `funding.ts`. */
export type FundingFailureErrorSpec =
	| {
			readonly phase: 'fund-default';
			readonly accountName: string;
			readonly variant: AccountVariantKind;
			/** Chain id the faucet strategy was keyed on. */
			readonly chainId: string;
			readonly cause: { readonly _tag: string };
	  }
	| {
			readonly phase: 'fund-cross-cutting';
			readonly accountName: string;
			readonly variant: AccountVariantKind;
			/** Strategy-registry key the request was routed through —
			 *  `faucet:request:<chainId>` for SUI entries or
			 *  `coinType:<fullCoinType>` for other entries. */
			readonly key: string;
			readonly amount: bigint;
			readonly cause: unknown;
	  };

const extractTag = (cause: unknown): string =>
	typeof cause === 'object' && cause !== null && '_tag' in cause
		? String((cause as { readonly _tag?: unknown })._tag)
		: 'unknown';

const FUND_DEFAULT_HINT =
	'See the cause chain — typical roots are the faucet container ' +
	'not yet ready (FaucetUnreachable), the wall-clock budget elapsed ' +
	'(FaucetExhausted), or the body returned Failure (FaucetBodyError).';

const FUND_CROSS_CUTTING_HINT =
	'Cross-cutting funding requires the matching strategy ' +
	'to be registered at the time of acquire — check the ' +
	'plugin that contributes this coin and any `via` dependency.';

/** Build the `AccountAcquireError` for a funding strategy request that
 *  failed. The message and hint are templated from `phase`; the tag is
 *  extracted from the cause's `_tag` field (falling back to
 *  `'unknown'`). */
export const fundingFailureError = (spec: FundingFailureErrorSpec): AccountAcquireError => {
	if (spec.phase === 'fund-default') {
		return accountAcquireError({
			phase: 'fund-default',
			accountName: spec.accountName,
			variant: spec.variant,
			message:
				`Account '${spec.accountName}': faucet strategy request failed ` +
				`for chain '${spec.chainId}' (tag=${spec.cause._tag}).`,
			cause: spec.cause,
			hint: FUND_DEFAULT_HINT,
		});
	}
	const tag = extractTag(spec.cause);
	return accountAcquireError({
		phase: 'fund-cross-cutting',
		accountName: spec.accountName,
		variant: spec.variant,
		message:
			`Account '${spec.accountName}': cross-cutting funding ` +
			`failed for coin (key='${spec.key}') amount=${spec.amount} ` +
			`(tag=${tag}).`,
		cause: spec.cause,
		hint: FUND_CROSS_CUTTING_HINT,
	});
};
