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

import type { AccountSignError } from '../account/errors.ts';
import type { AccountValue, TxResult } from '../account/service.ts';
import type { SuiClient } from '../sui/index.ts';
import { buildForkImpersonationTransactionBytes } from '../sui/fork-transaction.ts';

import { actionError, type ActionError } from './errors.ts';
import type { ActionReceipt } from './service.ts';

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
 * Collapse an `AccountSignError` onto the action's `'sign' | 'parse'`
 * taxonomy. The account's `submit` phase carries both transport
 * failures AND envelope-shape failures (FailedTransaction, no-digest).
 * Action callers historically distinguished "no digest returned" as
 * `parse`; we preserve that distinction by inspecting the account's
 * message text. The account-plugin team would ideally surface this
 * as a `no-digest` phase distinct from `submit` (backlog'd alongside
 * #29's projector lift).
 */
const accountSignErrorToActionError = (actionName: string) =>
	(cause: AccountSignError): ActionError => {
		if (cause.phase === 'submit' && cause.message.includes('returned no digest')) {
			return actionError('parse', {
				actionName,
				message:
					`Action '${actionName}': executeTransaction returned no digest. ` +
					`(account='${cause.accountName}', address=${cause.address})`,
				cause,
			});
		}
		return actionError('sign', {
			actionName,
			message:
				`Action '${actionName}': account sign/execute failed for ` +
				`'${cause.accountName}' (address=${cause.address}): ${cause.message}`,
			cause,
		});
	};

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
 *     to `phase: 'sign'` (or `phase: 'parse'` for the no-digest case).
 *
 *  The `actionName` parameter threads into every error's `actionName`
 *  field so cause-walker output stays attributable.
 */
export const signAndExecute = (params: {
	readonly actionName: string;
	readonly sui: SuiClient;
	readonly account: AccountValue;
	readonly build: (tx: Transaction) => void;
}): Effect.Effect<ActionReceipt, ActionError, Scope.Scope> =>
	Effect.gen(function* () {
		const { actionName, sui, account, build } = params;
		const mapAccountErr = accountSignErrorToActionError(actionName);
		return yield* account.withTransactionSigner((lockedSigner) =>
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
				const txBytes =
					account.source === 'impersonate'
						? yield* buildForkImpersonationTransactionBytes(tx, account.address, sui.sdk.core).pipe(
								Effect.mapError(
									(cause): ActionError =>
										actionError('sign', {
											actionName,
											message: `Action '${actionName}': fork impersonation Transaction.build failed — ${cause.message}.`,
											cause,
										}),
								),
							)
						: yield* Effect.tryPromise({
								try: () =>
									tx.build({
										client: sui.sdk.client as Parameters<typeof tx.build>[0] extends
											| { client?: infer C }
											| undefined
											? C
											: never,
									}),
								catch: (cause): ActionError =>
									actionError('sign', {
										actionName,
										message: `Action '${actionName}': Transaction.build failed — ${
											cause instanceof Error ? cause.message : String(cause)
										}.`,
										cause,
									}),
							});

				// --- 3. Delegate sign + execute + wait to the account -------
				//
				// `lockedSigner.signAndExecute` runs INSIDE the per-address
				// transaction-signer lease scope the outer
				// `withTransactionSigner` opened, so we keep sequencing for
				// gas/object-version resolution across the whole roundtrip.
				const txResult: TxResult = yield* lockedSigner.signAndExecute(txBytes).pipe(
					Effect.mapError(mapAccountErr),
				);

				// --- 4. Re-project TxResult → ActionReceipt -----------------
				return receiptFromTxResult(txResult);
			}),
		);
	}).pipe(
		Effect.withSpan('devstack.plugin.action.signAndExecute', {
			attributes: { 'action.name': params.actionName },
		}),
	);
