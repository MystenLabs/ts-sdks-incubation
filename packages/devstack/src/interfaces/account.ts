// Interface contract for an Account.
//
// Unlike the other interfaces in this directory, `Account` does NOT
// produce a singleton `Context.Service` tag — stacks have multiple
// accounts (alice, bob, …) and each gets its own per-name tag built
// by the `accounts({...})` factory. What the interface pins is the
// SHAPE every such per-name tag yields.
//
// `AccountError` is the unified error type the redesign uses for
// signer failures. The current `primitives/accounts.ts` produces
// `SignAndExecuteError` (a plain interface) for sign+execute paths
// and `AccountError` (a tagged class) for setup paths; Phase 8 will
// reconcile these. For now the contract pins the desired end state
// — `AccountError` everywhere — and the existing primitive remains
// the lone outlier.

import { Effect, Schema } from 'effect';
import type { Transaction } from '@mysten/sui/transactions';
import type { SuiTransactionBlockResponse } from '@mysten/sui/jsonRpc';
import type { PluginTag } from '../tag.js';
import { AccountError } from '../primitives/errors.js';

/** Per-account-instance shape. Every per-name tag produced by the
 *  `accounts({...})` factory yields a value satisfying this contract.
 *
 *  - `scheme` is lowercased here to match the on-chain Move type
 *    conventions and the lowercase form `@mysten/sui` exposes via
 *    `decodeSuiPrivateKey(...).schema.toLowerCase()`. Phase 8 will
 *    flip the existing primitive's capitalised variant to this form.
 *  - `signAndExecute` returns the raw `SuiTransactionBlockResponse`
 *    rather than the current `TxResult` wrapper; downstream code
 *    that needs `objectChanges` / `effects` can read them off the
 *    response directly, and consumers that want the wrapper can
 *    project it themselves.
 *  - `signTransaction` returns the base64-encoded signature string;
 *    downstream code that needs both `{ signature, bytes }` can
 *    serialize the transaction itself once.
 *  - `signPersonalMessage` retains the `{ signature, bytes }` shape
 *    because the dapp-kit personal-message flow needs both halves.
 */
export interface AccountShape {
	readonly name: string;
	readonly address: string;
	readonly scheme: 'ed25519' | 'secp256k1' | 'secp256r1';
	readonly publicKey: Uint8Array;
	readonly signAndExecute: (
		tx: Transaction,
	) => Effect.Effect<SuiTransactionBlockResponse, AccountError>;
	readonly signTransaction: (tx: Transaction) => Effect.Effect<string, AccountError>;
	readonly signPersonalMessage: (
		message: Uint8Array,
	) => Effect.Effect<{ readonly signature: string; readonly bytes: string }, AccountError>;
}

/** Reference type for downstream consumers that take an account tag as
 *  configuration. `accounts({alice: {...}})` produces a record of
 *  `AccountTag`s; consumers (`publishMove({signer})`,
 *  `seal({signer})`, …) accept any value matching this shape. */
/* eslint-disable @typescript-eslint/no-explicit-any */
export type AccountTag = PluginTag<any, AccountShape, any, AccountError>;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Runtime-validation mirror of `AccountShape`. Use
 *  `Schema.decode(AccountShapeSchema)` to validate a hand-rolled
 *  per-name account tag value, or in tests where you want to assert the
 *  shape on yield. Signing functions are closures (not Schema-validatable)
 *  so they're typed as `Unknown` here. */
export const AccountShapeSchema = Schema.Struct({
	name: Schema.String,
	address: Schema.String,
	scheme: Schema.Literals(['ed25519', 'secp256k1', 'secp256r1']),
	publicKey: Schema.Unknown,
	signAndExecute: Schema.Unknown,
	signTransaction: Schema.Unknown,
	signPersonalMessage: Schema.Unknown,
});
