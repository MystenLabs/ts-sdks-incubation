// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Connection, Signer, Transaction as SolanaTransaction } from '@solana/web3.js';
import type { WalletClient } from 'viem';
import type { EvmChainDefinition } from '../chains/types.js';

export interface WalletAccount {
	address: string;
}

/**
 * The widget's contract with an EVM wallet layer. The built-in implementation is backed by
 * Reown AppKit; hosts that already run wagmi can inject their own via
 * `createEvmWalletFromWagmiConfig`.
 */
export interface EvmWalletAdapter {
	readonly ecosystem: 'evm';
	getAccount(): WalletAccount | null;
	subscribe(listener: (account: WalletAccount | null) => void): () => void;
	/** Open the wallet picker (or whatever the host uses to connect). */
	connect(): Promise<void>;
	disconnect(): Promise<void>;
	/**
	 * A viem wallet client bound to `chain`. Implementations must switch (and if needed add)
	 * the chain in the user's wallet before resolving.
	 */
	getWalletClient(chain: EvmChainDefinition): Promise<WalletClient>;
}

export interface SolanaWalletAdapter {
	readonly ecosystem: 'solana';
	getAccount(): WalletAccount | null;
	subscribe(listener: (account: WalletAccount | null) => void): () => void;
	connect(): Promise<void>;
	disconnect(): Promise<void>;
	/**
	 * Sign with the wallet and send. `signers` are keypairs the wallet does not control that the
	 * transaction also needs. They have to sign after the wallet, which may change the
	 * transaction before it signs: `signAndSendSolanaTransaction` does this for any provider.
	 */
	signAndSendTransaction(
		transaction: SolanaTransaction,
		connection: Connection,
		signers?: Signer[],
	): Promise<string>;
}

export interface WalletAdapters {
	evm: EvmWalletAdapter;
	solana: SolanaWalletAdapter;
}

export type WalletAdapterFor<E extends 'evm' | 'solana'> = WalletAdapters[E];
