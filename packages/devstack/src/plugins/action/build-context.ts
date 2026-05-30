// Action plugin — typed context exposed to the user's body and
// discriminator callbacks.
//
// The context is intentionally helper-only. Upstream plugin values are
// passed as the callback's second argument, shaped by `dependsOn`.

import type { Effect, Scope } from 'effect';

import type { Transaction } from '@mysten/sui/transactions';

import type { AccountValue } from '../account/index.ts';
import type { SuiClient } from '../sui/index.ts';

import type { ActionError } from './errors.ts';
import type { ActionReceipt } from './service.ts';

/** Build-time context handed to the user's `body` callback (and the
 *  optional `discriminator` callback).
 *
 *  Carries:
 *
 *   - `sui` — the resolved `SuiClient` (sdk shim + chain id + opaque
 *     `client` for `Transaction.build({client})`). Threaded eagerly
 *     because suiResource is always part of the action's hard upstream.
 *   - `signAndExecute(account, build)` — high-level helper. Drives
 *     the full build → sign → execute → wait → project pipeline
 *     against the supplied account, returning a parsed
 *     `ActionReceipt`. Folds the SDK boundary cast +
 *     `include: {effects, objectTypes}` execute + finality wait +
 *     envelope projection into a single call. Errors surface as
 *     `ActionError` (phase `sign` for build / sign / submit transport
 *     failures; `execute-failed` for an on-chain `FailedTransaction`
 *     outcome). */
export interface ActionBuildContext {
	/** Resolved SuiClient. suiResource is part of action's hard upstream so
	 *  this is always populated. */
	readonly sui: SuiClient;
	/** High-level: build + sign + execute + wait + project the
	 *  transaction in one call. The `account` is the signer, usually
	 *  from the resolved dependency values passed to the action body.
	 *  The `build` callback populates the fresh `Transaction`; the
	 *  sender is set automatically to `account.address`. Returns a
	 *  parsed `ActionReceipt` whose `objectChanges` array is non-empty
	 *  when the transaction created or mutated on-chain objects (the
	 *  SDK is invoked with `include: { effects, objectTypes }`). */
	readonly signAndExecute: (
		account: AccountValue,
		build: (tx: Transaction) => void,
	) => Effect.Effect<ActionReceipt, ActionError, Scope.Scope>;
}
