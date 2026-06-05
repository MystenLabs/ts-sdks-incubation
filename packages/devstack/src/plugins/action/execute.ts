// Action plugin — `signAndExecute` helper.
//
// Delegates the full build → sign → execute → wait → project pipeline
// to the Account plugin's `withTransactionSigner` scope. The action
// body never sees the SDK envelope; instead it receives the Account's
// already-projected `TxResult`, which this module re-projects into the
// action's `ActionReceipt` shape (bucketed `created`/`mutated` instead
// of the account-flat `objectChanges`).
//
// Before the dedup, this module reimplemented the entire SDK roundtrip
// (`executeTransaction`, `$kind`/`FailedTransaction`/no-digest envelope
// projection, `waitForTransaction` finality wait). The same logic lived
// in `account/service.ts:666-704` and `package/publish-executor.ts`, with
// three near-identical SDK envelope projectors. Backlog item #29 lifts
// the action path; the remaining package projector is tracked there too.
//
// Boundary discipline: this module imports the Account plugin's
// `AccountValue` + `TxResult` (peer L4 contract) and a `SuiClient`
// shim (peer L4 contract). It does not import `@mysten/sui/client` or
// reach into the SDK envelope — those concerns live in
// `account/service.ts`'s `projectTxResult`.

import { Effect, type Scope } from 'effect';

import { Transaction } from '@mysten/sui/transactions';

import type { AccountSignError, AccountValue, TxResult } from '../account/index.ts';
import {
	buildForkImpersonationTransactionBytes,
	formatExecutedFailure,
	signAndDispatch,
	type SuiClient,
} from '../sui/index.ts';
import { formatUnknownError } from '../../substrate/runtime/format-unknown-error.ts';

import { actionError, type ActionError } from './errors.ts';
import type { ActionReceipt } from './service.ts';
import { ActionSpans } from './spans.ts';

// ---------------------------------------------------------------------------
// Receipt object-change projection
// ---------------------------------------------------------------------------

/** Flat object-change record surfaced on an `ActionReceipt`. Mirrors
 *  the package plugin's `PublishObjectChange` shape so consumers can
 *  reuse `findCreatedByType`-style helpers across the two surfaces.
 *
 *  - `kind`: 'created' when `idOperation === 'Created'`, else 'mutated'
 *    (we expose the same two buckets the package plugin uses; finer
 *    distinctions are recoverable from the raw `idOperation` /
 *    `outputState` fields preserved alongside).
 *  - `objectType`: optional fully-qualified type string
 *    (`<packageId>::<module>::<Name>`) — present when the SDK's
 *    `objectTypes` map carries the id. */
export interface ActionObjectChange {
	readonly kind: 'created' | 'mutated';
	readonly objectId: string;
	readonly objectType?: string;
	readonly outputState?: string;
	readonly idOperation?: string;
}

// ---------------------------------------------------------------------------
// Account TxResult → ActionReceipt projection
// ---------------------------------------------------------------------------

/**
 * Re-bucket the account's flat `objectChanges` into action-flavored
 * `created` / `mutated` rows. The account plugin's projection emits
 * `{type, objectId, objectType?, outputState?, idOperation?}`; we
 * carry through the optional fields and discriminate on `type` /
 * `kind` so a downstream `findCreatedByType` consumer keeps working.
 */
const projectAccountObjectChanges = (
	changes: ReadonlyArray<unknown>,
): ReadonlyArray<ActionObjectChange> =>
	changes
		.filter(
			(
				change,
			): change is {
				readonly type?: string;
				readonly kind?: string;
				readonly objectId: string;
				readonly objectType?: string;
				readonly outputState?: string;
				readonly idOperation?: string;
			} =>
				typeof change === 'object' &&
				change !== null &&
				typeof (change as { readonly objectId?: unknown }).objectId === 'string',
		)
		.map((change) => {
			const entry: {
				-readonly [K in keyof ActionObjectChange]: ActionObjectChange[K];
			} = {
				kind: change.type === 'created' || change.kind === 'created' ? 'created' : 'mutated',
				objectId: change.objectId,
			};
			if (typeof change.objectType === 'string') entry.objectType = change.objectType;
			if (typeof change.outputState === 'string') entry.outputState = change.outputState;
			if (typeof change.idOperation === 'string') entry.idOperation = change.idOperation;
			return entry;
		});

const receiptFromTxResult = (tx: TxResult): ActionReceipt => ({
	digest: tx.digest,
	objectChanges: projectAccountObjectChanges(tx.objectChanges),
	balanceChanges: tx.balanceChanges,
});

// ---------------------------------------------------------------------------
// AccountSignError → ActionError mapping
// ---------------------------------------------------------------------------

/**
 * Map an `AccountSignError` onto the action's `'sign'` phase. The
 * account's `signAndExecute` returns a discriminated `SignAndExecuteResult`
 * for the on-chain outcome (success vs FailedTransaction); only
 * transport / lifecycle failures surface here.
 */
const accountSignErrorToActionError =
	(actionName: string) =>
	(cause: AccountSignError): ActionError =>
		actionError('sign', {
			actionName,
			message:
				`Action '${actionName}': account sign/execute failed for ` +
				`'${cause.accountName}' (address=${cause.address}): ${cause.message}`,
			cause,
		});

// ---------------------------------------------------------------------------
// `signAndExecute` helper
// ---------------------------------------------------------------------------

/** Drive the full build → sign → execute → wait → project pipeline by
 *  delegating to the account's `withTransactionSigner` /
 *  `signAndExecute` surface, then re-projecting the returned
 *  `TxResult` into the action's `ActionReceipt` shape.
 *
 *  Allocates a fresh `Transaction`, sets the sender to the account's
 *  address, lets the caller populate it via the `build` callback,
 *  serialises via `Transaction.build({ client })` (or the fork-mode
 *  builder for impersonation accounts), then hands the bytes to the
 *  account's locked-signer scope. The account plugin owns sign,
 *  execute, finality wait, and envelope projection.
 *
 *  All failures surface as `ActionError`:
 *   - `build` callback throws  → `phase: 'sign'`.
 *   - `Transaction.build` rejects → `phase: 'sign'`.
 *   - `account.signAndExecute` rejects with `AccountSignError` → mapped
 *     to `phase: 'sign'`. The Account plugin's `'no-digest'` phase
 *     (SDK envelope protocol violation) flows through here as well —
 *     the originating `AccountSignError` is preserved via `cause` so
 *     the cause walker renders the underlying `phase: 'no-digest'`.
 *
 *  The `actionName` parameter threads into every error's `actionName`
 *  field so cause-walker output stays attributable.
 */
export const signAndExecute = (params: {
	readonly actionName: string;
	readonly sui: SuiClient;
	readonly account: AccountValue;
	readonly build: (tx: Transaction) => void;
}): Effect.Effect<ActionReceipt, ActionError, Scope.Scope> => {
	const { actionName, sui, account, build } = params;
	const mapAccountErr = accountSignErrorToActionError(actionName);
	// Delegate the build → sign → execute → dispatch pipeline to the
	// shared `signAndDispatch` helper. The build closure handles both
	// the user callback (`build(tx)`) and mode-appropriate serialization
	// (fork impersonation vs SDK-resolver). On-chain failures surface
	// as `phase: 'execute-failed'` so cause-walker renders them distinctly
	// from transport-level signing failures (`phase: 'sign'`).
	return signAndDispatch({
		signerSource: account,
		buildTxBytes: () =>
			Effect.gen(function* () {
				// --- 1. Allocate + populate the Transaction ------------------
				const tx = new Transaction();
				tx.setSender(account.address);
				yield* Effect.try({
					try: () => build(tx),
					catch: (cause): ActionError =>
						actionError('sign', {
							actionName,
							message: `Action '${actionName}': build callback threw before serialisation.`,
							cause,
						}),
				});

				// --- 2. Serialise via the mode-appropriate path --------------
				// Fork mode (impersonate OR real signer) must build offline with
				// explicit gas: the sui-fork binary has no simulate_transaction,
				// so the SDK's gas-estimating `tx.build({ client })` fails. The
				// real-vs-empty-signature split happens later in signAndExecute.
				return account.source === 'impersonate' || sui.fork !== null
					? yield* buildForkImpersonationTransactionBytes(tx, account.address, sui.sdk.core).pipe(
							Effect.mapError(
								(cause): ActionError =>
									actionError('sign', {
										actionName,
										message: `Action '${actionName}': fork Transaction.build failed — ${cause.message}.`,
										cause,
									}),
							),
						)
					: yield* Effect.tryPromise({
							try: () => tx.build({ client: sui.sdk.client }),
							catch: (cause): ActionError =>
								actionError('sign', {
									actionName,
									message: `Action '${actionName}': Transaction.build failed — ${formatUnknownError(
										cause,
									)}.`,
									cause,
								}),
						});
			}),
		mapSignError: mapAccountErr,
		onFailed: (failure) =>
			Effect.fail(
				actionError('execute-failed', {
					actionName,
					message:
						`Action '${actionName}': transaction execution failed on-chain ` +
						`for account '${account.name}' (address=${account.address}) ` +
						formatExecutedFailure(failure),
				}),
			),
		onSuccess: (txResult) => Effect.succeed(receiptFromTxResult(txResult)),
	}).pipe(
		Effect.withSpan('devstack.plugin.action.signAndExecute', {
			attributes: { [ActionSpans.name]: actionName },
		}),
	);
};
