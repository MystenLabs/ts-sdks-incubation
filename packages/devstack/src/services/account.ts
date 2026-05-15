// Account(name, opts?) — single-named account factory. Replaces the
// `accounts({alice: {...}, bob: {...}})` shape with one factory call
// per named account, returning a typed Ref usable directly as a signer
// in `Package` / `Action` / `Wallet`.
//
// Phase 2 delegates to `accounts({[name]: opts})` and picks the single
// resulting tag back out; the underlying behavior (faucet funding,
// disk-keystore persistence, keystore/env/inline sources) is unchanged.

import { Effect, Schema } from 'effect';
import type { Transaction } from '@mysten/sui/transactions';
import type { SuiTransactionBlockResponse } from '@mysten/sui/jsonRpc';
import { accounts, type AccountSpec } from '../primitives/accounts.js';
import { AccountError } from '../primitives/errors.js';
import type { PluginTag } from '../advanced/tag.js';
import { withSection } from './ref.js';

// -----------------------------------------------------------------------------
// Contract
// -----------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------
// Factory
// -----------------------------------------------------------------------------

/** Factory for a single named account. The returned Ref is both an
 *  Effect Layer (composed into the merged stack by `devstack(...)`) and
 *  an Effect tag (`yield* alice` returns the resolved `Account`).
 *
 *  Default source: `'ephemeral-funded'` — generate a fresh keypair,
 *  persist it under `.devstack/stacks/<stack>/.keys/<name>.key`, and
 *  request faucet funding. Pass `{ from: 'env', key: '...' }` or
 *  `{ from: 'keystore', alias: '...' }` for non-localnet stacks. */
export const Account = <const N extends string>(name: N, opts?: AccountSpec) => {
	const handle = accounts({ [name]: opts ?? {} } as Record<N, AccountSpec>);
	const tag = handle[name];
	return withSection(tag, 'account');
};
