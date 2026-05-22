// Action plugin — `signAndExecute` helper.
//
// This module encapsulates the "build → sign → execute → wait → project"
// roundtrip that every action body needs to perform a Move call against
// the booted Sui chain. Without it, every action body re-implements the
// SDK boundary cast on `sdk.client.executeTransaction` + the SDK envelope
// projection + the post-submit `waitForTransaction` gate.
//
// The same wiring lives in `plugins/package/publish-executor.ts` — both
// sites cast the opaque `sdk.client` to call `executeTransaction({
// include: { effects: true, objectTypes: true }})` so they recover
// `changedObjects` + their fully-qualified types. Both run through the
// Account plugin's transaction-signer scope so `Transaction.build`,
// signing, execute, and finality wait serialize per address.
//
// What this helper extracts: the SDK-envelope projection + the
// finality-wait. Per call sites:
//
//   - The user supplies a `build(tx)` callback that populates the
//     `Transaction` synchronously (moveCalls, transferObjects, etc.).
//   - The user supplies the signing `account` (an `AccountValue` from
//     the action's resolved dependency values); we sign with the
//     locked transaction signer and drive the SDK's
//     `executeTransaction` directly.
//   - The helper returns an `ActionReceipt` projection: `{ digest,
//     objectChanges }`. The `objectChanges` array is shaped uniformly so
//     downstream consumers can pick by `objectType` substring.
//
// All failures route through `ActionError` (phase: `sign` for transport
// / RPC failures; `parse` for "no digest" / "wrong envelope shape"
// situations). The action plugin's outer wrap collapses these into the
// substrate's OCA `produce-failed` channel.

import { Effect, type Scope } from 'effect';

import { Transaction } from '@mysten/sui/transactions';

import type { AccountValue } from '../account/service.ts';
import type { SuiClient } from '../sui/index.ts';

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
// SDK shape — kept narrow, mirrors the cast in publish-executor.ts
// ---------------------------------------------------------------------------

interface SdkExecuteClient {
	readonly executeTransaction: (args: {
		readonly transaction: Uint8Array;
		readonly signatures: ReadonlyArray<string>;
		readonly include?: {
			readonly effects?: boolean;
			readonly objectTypes?: boolean;
		};
	}) => Promise<unknown>;
	readonly waitForTransaction: (args: {
		readonly digest: string;
		readonly include?: { readonly effects?: boolean };
		readonly timeout?: number;
	}) => Promise<unknown>;
}

interface RawExecuteEnvelope {
	readonly $kind?: 'Transaction' | 'FailedTransaction';
	readonly Transaction?: {
		readonly digest?: string;
		readonly effects?: {
			readonly changedObjects?: ReadonlyArray<{
				readonly objectId?: string;
				readonly outputState?: string;
				readonly idOperation?: string;
			}>;
		};
		readonly objectTypes?: Readonly<Record<string, string>>;
	};
	readonly FailedTransaction?: {
		readonly digest?: string;
		readonly status?: { readonly error?: string };
	};
}

// ---------------------------------------------------------------------------
// `signAndExecute` helper
// ---------------------------------------------------------------------------

/** Drive the full build → sign → execute → wait → project pipeline.
 *
 *  Allocates a fresh `Transaction`, sets the sender to the account's
 *  address, lets the caller populate it via the `build` callback,
 *  serialises via `Transaction.build({ client })`, signs via the
 *  account's transaction-signer scope, executes via the SDK's
 *  `executeTransaction` (with `include: { effects: true, objectTypes:
 *  true }` so the SDK surfaces `changedObjects` + types), waits for
 *  finality, and projects the envelope into an `ActionReceipt`.
 *
 *  All failures surface as `ActionError`:
 *   - `build` callback throws  → `phase: 'sign'` (matches the existing
 *      catch-all phase for body-side failures).
 *   - `Transaction.build` rejects → `phase: 'sign'`.
 *   - `signTransaction` rejects → `phase: 'sign'`.
 *   - `executeTransaction` rejects → `phase: 'sign'`.
 *   - SDK returns `FailedTransaction` → `phase: 'sign'`.
 *   - SDK returns no digest → `phase: 'parse'`.
 *   - `waitForTransaction` rejects → `phase: 'sign'`.
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

				// --- 2. Serialise via the SDK client -------------------------
				const txBytes = yield* Effect.tryPromise({
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

				// --- 3. Sign with the account -------------------------------
				const signed = yield* lockedSigner.signTransaction(txBytes).pipe(
					Effect.mapError(
						(cause): ActionError =>
							actionError('sign', {
								actionName,
								message:
									`Action '${actionName}': account.signTransaction failed for ` +
									`'${account.name}' (address=${account.address}): ${
										cause instanceof Error ? cause.message : String(cause)
									}`,
								cause,
							}),
					),
				);

				// --- 4. Execute via the SDK (with effects+objectTypes) ------
				const sdkClient = sui.sdk.client as SdkExecuteClient;
				const raw = yield* Effect.tryPromise({
					try: () =>
						sdkClient.executeTransaction({
							transaction: txBytes,
							signatures: [signed.signature],
							include: { effects: true, objectTypes: true },
						}),
					catch: (cause): ActionError =>
						actionError('sign', {
							actionName,
							message:
								`Action '${actionName}': executeTransaction failed — ` +
								(cause instanceof Error ? cause.message : String(cause)),
							cause,
						}),
				});

				// --- 5. Project the envelope --------------------------------
				const env = raw as RawExecuteEnvelope;
				if (env.$kind === 'FailedTransaction') {
					const failedDigest = env.FailedTransaction?.digest;
					if (failedDigest !== undefined) {
						yield* Effect.tryPromise({
							try: () => sdkClient.waitForTransaction({ digest: failedDigest }),
							catch: (cause): ActionError =>
								actionError('sign', {
									actionName,
									message: `Action '${actionName}': waitForTransaction(${failedDigest}) failed.`,
									cause,
								}),
						});
					}
					return yield* Effect.fail(
						actionError('sign', {
							actionName,
							message:
								`Action '${actionName}': FailedTransaction ` +
								`(digest=${env.FailedTransaction?.digest ?? '<unknown>'}): ` +
								`${env.FailedTransaction?.status?.error ?? '<no error>'}`,
						}),
					);
				}
				const txOk = env.Transaction;
				if (txOk?.digest === undefined) {
					return yield* Effect.fail(
						actionError('parse', {
							actionName,
							message: `Action '${actionName}': executeTransaction returned no digest.`,
						}),
					);
				}

				// --- 6. Wait for finality -----------------------------------
				yield* Effect.tryPromise({
					try: () => sdkClient.waitForTransaction({ digest: txOk.digest! }),
					catch: (cause): ActionError =>
						actionError('sign', {
							actionName,
							message: `Action '${actionName}': waitForTransaction(${txOk.digest}) failed.`,
							cause,
						}),
				});

				// --- 7. Project changedObjects into the receipt's objectChanges
				const objectTypes = txOk.objectTypes ?? {};
				const objectChanges: ReadonlyArray<ActionObjectChange> = (
					txOk.effects?.changedObjects ?? []
				)
					.filter(
						(c): c is { objectId: string; outputState?: string; idOperation?: string } =>
							typeof c.objectId === 'string',
					)
					.map((c) => {
						const objectType = objectTypes[c.objectId];
						const entry: {
							-readonly [K in keyof ActionObjectChange]: ActionObjectChange[K];
						} = {
							kind: c.idOperation === 'Created' ? 'created' : 'mutated',
							objectId: c.objectId,
						};
						if (objectType !== undefined) entry.objectType = objectType;
						if (c.outputState !== undefined) entry.outputState = c.outputState;
						if (c.idOperation !== undefined) entry.idOperation = c.idOperation;
						return entry;
					});

				const receipt: ActionReceipt = {
					digest: txOk.digest,
					objectChanges,
					balanceChanges: [],
				};
				return receipt;
			}),
		);
	}).pipe(
		Effect.withSpan('devstack.plugin.action.signAndExecute', {
			attributes: { 'action.name': params.actionName },
		}),
	);
