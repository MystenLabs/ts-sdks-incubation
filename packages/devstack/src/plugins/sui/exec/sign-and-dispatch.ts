// signAndDispatch — boilerplate compactor for the
// `withTransactionSigner → buildTxBytes → signAndExecute → $kind
// dispatch` pattern that recurs across every Sui-tx plugin
// (`package.publish`, `action.execute`, `coin.mint`, `walrus.fundWal`,
// `deepbook.fundDeep`, and any future user-authored signer plugin).
//
// Distinct from `executeSuiTx` (sibling in this directory):
//   - `executeSuiTx` drives `core.executeTransaction` directly via the
//     raw SDK client + an opaque resolved signer. It splits sign and
//     execute and projects the SDK envelope itself.
//   - `signAndDispatch` consumes the Account plugin's higher-level
//     `signAndExecute` surface (which fuses sign + execute + finality
//     wait + projection into one Effect) and just compacts the
//     surrounding boilerplate.
//
// Both helpers coexist: plugins that publish through the Account bus
// (the majority) use `signAndDispatch`; lower-level callers that drive
// the SDK client directly use `executeSuiTx`.
//
// Lives in `plugins/sui`. Consumes opaque shapes (an `AccountValue`-like
// contract surface and the `SignAndExecuteResult` union) without reaching
// into any particular publisher's full contract. The caller owns the
// transaction build, the error mapping, and the dispatch bodies.
//
// On-chain `FailedTransaction` is a RETURN-CHANNEL outcome (caller
// dispatches on `$kind` via the `onFailed` callback), NOT an error —
// matches STYLE_GUIDE §2 and the upstream `SignAndExecuteResult` shape.

import { Effect } from 'effect';

import type { ExecutedFailure, ExecutedReceipt } from './index.ts';

// ---------------------------------------------------------------------------
// Resolved-signer shape — narrow slice of `AccountValue`
// ---------------------------------------------------------------------------

/** The SDK-shaped result of `lockedSigner.signAndExecute`. Mirrors the
 *  Account plugin's `SignAndExecuteResult` union; redeclared here so
 *  this helper does not import from `plugins/account/*`. The Account
 *  plugin's projection uses the `ExecutedFailure` shape already (single
 *  source of truth in `./index.ts`). Generic over the success
 *  transaction shape because the Account plugin's `TxResult` widens
 *  `ExecutedReceipt` with `effects` / `balanceChanges` fields that not
 *  every caller needs to surface. */
export type SignAndDispatchResult<TxOk extends { readonly digest: string } = ExecutedReceipt> =
	| { readonly $kind: 'Transaction'; readonly Transaction: TxOk }
	| { readonly $kind: 'FailedTransaction'; readonly FailedTransaction: ExecutedFailure };

/** Locked-signer slice handed to the caller's tx-build closure. Narrow
 *  view of `AccountTransactionSigner` — this contract doesn't reach into
 *  the Account plugin's surface. Generic over the signer's sign-side
 *  error (typically `AccountSignError`) and the success transaction
 *  shape. */
export interface SignAndDispatchSigner<SignError, TxOk extends { readonly digest: string }> {
	readonly signAndExecute: (
		tx: Uint8Array,
	) => Effect.Effect<SignAndDispatchResult<TxOk>, SignError>;
}

/** Outer signer-source surface required by `signAndDispatch` — anything
 *  that exposes a `withTransactionSigner` scope. This helper only
 *  reaches `withTransactionSigner`, so plugins composing custom
 *  signing surfaces can satisfy the slice without dragging in any
 *  particular publisher's full contract. */
export interface TransactionSignerSource<SignError, TxOk extends { readonly digest: string }> {
	readonly withTransactionSigner: <A, E, R>(
		body: (signer: SignAndDispatchSigner<SignError, TxOk>) => Effect.Effect<A, E, R>,
	) => Effect.Effect<A, E, R>;
}

// ---------------------------------------------------------------------------
// The helper
// ---------------------------------------------------------------------------

/** Run `withTransactionSigner( buildTxBytes → signAndExecute → mapSignError →
 *  dispatch on $kind )`. The caller owns:
 *
 *   - `buildTxBytes`: an Effect returning the serialised `Uint8Array`,
 *     run INSIDE the signer scope. Failures inside this effect
 *     propagate verbatim — the caller maps `Transaction.build` /
 *     impersonation-build errors to its plugin domain there.
 *   - `mapSignError`: projects the signer's typed sign error
 *     (`AccountSignError` for the Account bus) into the caller's
 *     domain error before dispatch. Without this projection
 *     `mapSignError` and the dispatch callbacks would need to share
 *     the same error channel, which forces every caller into a tagged
 *     domain error anyway.
 *   - `onFailed`: dispatch for the `FailedTransaction` variant.
 *     Typically `Effect.fail(domainError(formatExecutedFailure(...)))`.
 *   - `onSuccess`: dispatch for the `Transaction` variant — projects
 *     the SDK-shaped tx result to the caller's receipt shape.
 *
 *  Returns the union of the dispatch callbacks' types so callers do
 *  not have to wrap the call in a redundant `Effect.gen`. */
export const signAndDispatch = <
	A,
	BuildError,
	BuildEnv,
	SignError,
	DomainError,
	OnFailedError,
	OnFailedEnv,
	OnSuccessError,
	OnSuccessEnv,
	TxOk extends { readonly digest: string } = ExecutedReceipt,
>(args: {
	readonly signerSource: TransactionSignerSource<SignError, TxOk>;
	readonly buildTxBytes: (
		signer: SignAndDispatchSigner<SignError, TxOk>,
	) => Effect.Effect<Uint8Array, BuildError, BuildEnv>;
	readonly mapSignError: (cause: SignError) => DomainError;
	readonly onFailed: (failure: ExecutedFailure) => Effect.Effect<A, OnFailedError, OnFailedEnv>;
	readonly onSuccess: (ok: TxOk) => Effect.Effect<A, OnSuccessError, OnSuccessEnv>;
}): Effect.Effect<
	A,
	BuildError | DomainError | OnFailedError | OnSuccessError,
	BuildEnv | OnFailedEnv | OnSuccessEnv
> =>
	args.signerSource.withTransactionSigner((lockedSigner) =>
		Effect.gen(function* () {
			const txBytes = yield* args.buildTxBytes(lockedSigner);
			const result = yield* lockedSigner
				.signAndExecute(txBytes)
				.pipe(Effect.mapError(args.mapSignError));
			if (result.$kind === 'FailedTransaction') {
				return yield* args.onFailed(result.FailedTransaction);
			}
			return yield* args.onSuccess(result.Transaction);
		}),
	);
