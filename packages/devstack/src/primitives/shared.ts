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
	readonly scheme: 'ED25519' | 'Secp256k1' | 'Secp256r1';
	signAndExecute(
		transaction: Transaction,
		options?: SignAndExecuteOptions,
	): Effect.Effect<TxResult, SignAndExecuteError>;
	signTransaction(
		transactionBytes: Uint8Array,
	): Effect.Effect<{ signature: string; bytes: string }, SignAndExecuteError>;
	signPersonalMessage(
		messageBytes: Uint8Array,
	): Effect.Effect<{ signature: string; bytes: string }, SignAndExecuteError>;
}
