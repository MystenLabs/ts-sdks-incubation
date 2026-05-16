// Shared types used by every primitive.

import type { SuiObjectChange, SuiTransactionBlockResponse } from '@mysten/sui/jsonRpc';
import type { Transaction } from '@mysten/sui/transactions';
import type { Effect } from 'effect';

export type { SuiObjectChange, SuiTransactionBlockResponse, Transaction };

export interface TxResult {
	readonly digest: string;
	readonly effects: SuiTransactionBlockResponse['effects'];
	readonly objectChanges: ReadonlyArray<SuiObjectChange>;
	readonly balanceChanges: SuiTransactionBlockResponse['balanceChanges'];
}

export interface SignAndExecuteOptions {
	readonly gasBudget?: bigint;
	readonly waitForLocalExecution?: boolean;
}

// An Account's signAndExecute returns an Effect — the client is closed
// over at construction time, so R = never. The user yields it inside
// their Effect.gen body.
export interface SignAndExecuteError {
	readonly _tag: 'SignAndExecuteError';
	readonly message: string;
	readonly cause?: unknown;
}

export interface Account {
	readonly name: string;
	readonly address: string;
	readonly publicKey: Uint8Array;
	// Lowercased to match @mysten/sui's `decodeSuiPrivateKey(…).schema.toLowerCase()`
	// and the on-chain Move type conventions. The runtime impl calls
	// `signer.getKeyScheme().toLowerCase()` in services/account.ts.
	readonly scheme: 'ed25519' | 'secp256k1' | 'secp256r1';
	signAndExecute(
		transaction: Transaction,
		options?: SignAndExecuteOptions,
	): Effect.Effect<TxResult, SignAndExecuteError>;
	// Takes pre-built tx bytes (the dapp-kit wallet adapter ships them
	// to the wallet server as base64; the server decodes once and hands
	// the Uint8Array to this method). Returns the @mysten/sui Signer's
	// native `{ bytes, signature }` shape so callers can forward to
	// `executeTransactionBlock` without re-serialization.
	signTransaction(
		transactionBytes: Uint8Array,
	): Effect.Effect<{ signature: string; bytes: string }, SignAndExecuteError>;
	signPersonalMessage(
		messageBytes: Uint8Array,
	): Effect.Effect<{ signature: string; bytes: string }, SignAndExecuteError>;
}
