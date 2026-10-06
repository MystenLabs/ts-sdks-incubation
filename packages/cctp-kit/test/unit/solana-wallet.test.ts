// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
	ComputeBudgetProgram,
	Connection,
	Keypair,
	SendTransactionError,
	Transaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { describe, expect, it, vi } from 'vitest';
import { SOLANA_MAINNET } from '../../src/chains/solana.js';
import { buildSolanaBurnTransaction } from '../../src/engine/solana.js';
import { signAndSendSolanaTransaction } from '../../src/wallets/solana.js';

const wallet = Keypair.generate();

async function burn() {
	vi.spyOn(Connection.prototype, 'getLatestBlockhash').mockResolvedValue({
		blockhash: Keypair.generate().publicKey.toBase58(),
		lastValidBlockHeight: 1,
	});
	return buildSolanaBurnTransaction(SOLANA_MAINNET, {
		owner: wallet.publicKey,
		amount: 1_000_000n,
		destinationDomain: 8,
		mintRecipient: new Uint8Array(32).fill(7),
		maxFee: 0n,
		minFinalityThreshold: 2000,
	});
}

/**
 * A wallet that adds a priority fee before it signs and returns the changed transaction, which
 * is what a wallet did to this kit's transactions on mainnet.
 */
async function signLikeAWallet(transaction: Transaction): Promise<Transaction> {
	const rewritten = new Transaction();
	rewritten.feePayer = transaction.feePayer;
	rewritten.recentBlockhash = transaction.recentBlockhash;
	rewritten.add(
		ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
		ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
		...transaction.instructions,
	);
	rewritten.partialSign(wallet);
	// Over the wire and back, as a wallet returns it.
	return Transaction.from(rewritten.serialize({ requireAllSignatures: false }));
}

describe('signing a Solana transaction that needs a second signer', () => {
	it('lets the wallet sign first, so what the wallet adds does not break the second signature', async () => {
		const built = await burn();
		const signTransaction = vi.fn(signLikeAWallet);
		const sendRawTransaction = vi.fn(async (_raw: Buffer | Uint8Array | number[]) => 'signature');
		const result = await signAndSendSolanaTransaction(
			{ signTransaction, signAndSendTransaction: vi.fn() },
			built.transaction,
			{ sendRawTransaction } as unknown as Connection,
			built.signers,
		);
		expect(result).toBe('signature');
		// The wallet was handed a transaction nobody had signed.
		expect(signTransaction.mock.calls[0]![0].signatures.every((s) => !s.signature)).toBe(true);
		// What was sent carries the wallet's additions and two signatures that both verify.
		const sent = Transaction.from(sendRawTransaction.mock.calls[0]![0] as Buffer);
		expect(sent.instructions).toHaveLength(3);
		expect(sent.signatures.map((s) => s.publicKey.toBase58())).toEqual([
			wallet.publicKey.toBase58(),
			built.signers[0]!.publicKey.toBase58(),
		]);
		expect(sent.verifySignatures()).toBe(true);
	});

	it('sends the same signed transaction again when a send ends without an answer', async () => {
		// The connection dropped: the node may or may not have taken it. The same bytes cannot
		// burn twice, and the wallet is not asked again.
		vi.useFakeTimers();
		try {
			const built = await burn();
			const signTransaction = vi.fn(signLikeAWallet);
			const sendRawTransaction = vi
				.fn<(raw: Buffer | Uint8Array | number[]) => Promise<string>>()
				.mockRejectedValueOnce(new TypeError('Failed to fetch'))
				.mockResolvedValueOnce('signature');
			const outcome = signAndSendSolanaTransaction(
				{ signTransaction, signAndSendTransaction: vi.fn() },
				built.transaction,
				{ sendRawTransaction } as unknown as Connection,
				built.signers,
			);
			await vi.runAllTimersAsync();
			expect(await outcome).toBe('signature');
			expect(signTransaction).toHaveBeenCalledTimes(1);
			expect(sendRawTransaction).toHaveBeenCalledTimes(2);
			expect(sendRawTransaction.mock.calls[1]![0]).toEqual(sendRawTransaction.mock.calls[0]![0]);
		} finally {
			vi.useRealTimers();
		}
	});

	it('knows the first send got through when the node says it has seen the transaction', async () => {
		vi.useFakeTimers();
		try {
			const built = await burn();
			const sendRawTransaction = vi
				.fn<(raw: Buffer | Uint8Array | number[]) => Promise<string>>()
				.mockRejectedValueOnce(new TypeError('Failed to fetch'))
				.mockRejectedValueOnce(
					new SendTransactionError({
						action: 'simulate',
						signature: '',
						transactionMessage:
							'Transaction simulation failed: This transaction has already been processed',
					}),
				);
			const outcome = signAndSendSolanaTransaction(
				{ signTransaction: vi.fn(signLikeAWallet), signAndSendTransaction: vi.fn() },
				built.transaction,
				{ sendRawTransaction } as unknown as Connection,
				built.signers,
			);
			await vi.runAllTimersAsync();
			const sent = Transaction.from(sendRawTransaction.mock.calls[0]![0] as Buffer);
			expect(await outcome).toBe(bs58.encode(sent.signature!));
		} finally {
			vi.useRealTimers();
		}
	});

	it('hands back the signature when no send gets an answer', async () => {
		// The node may have passed the transaction on before the connection dropped. Reporting a
		// failure would invite a second burn beside one that may still land; with the signature
		// the caller watches the chain until it shows what became of the first.
		vi.useFakeTimers();
		try {
			const built = await burn();
			const sendRawTransaction = vi
				.fn<(raw: Buffer | Uint8Array | number[]) => Promise<string>>()
				.mockRejectedValue(new TypeError('Failed to fetch'));
			const outcome = signAndSendSolanaTransaction(
				{ signTransaction: vi.fn(signLikeAWallet), signAndSendTransaction: vi.fn() },
				built.transaction,
				{ sendRawTransaction } as unknown as Connection,
				built.signers,
			);
			await vi.runAllTimersAsync();
			const sent = Transaction.from(sendRawTransaction.mock.calls[0]![0] as Buffer);
			expect(await outcome).toBe(bs58.encode(sent.signature!));
			expect(sendRawTransaction).toHaveBeenCalledTimes(3);
		} finally {
			vi.useRealTimers();
		}
	});

	it('reports a send that the node refused, without sending again', async () => {
		const refusals = [
			new SendTransactionError({
				action: 'simulate',
				signature: '',
				transactionMessage: 'Blockhash not found',
			}),
			new Error('429 Too Many Requests: slow down'),
		];
		for (const refusal of refusals) {
			const built = await burn();
			const sendRawTransaction = vi.fn().mockRejectedValue(refusal);
			await expect(
				signAndSendSolanaTransaction(
					{ signTransaction: vi.fn(signLikeAWallet), signAndSendTransaction: vi.fn() },
					built.transaction,
					{ sendRawTransaction } as unknown as Connection,
					built.signers,
				),
			).rejects.toBe(refusal);
			expect(sendRawTransaction).toHaveBeenCalledTimes(1);
		}
	});

	it('signs first itself for a wallet that can only sign and send in one step', async () => {
		const built = await burn();
		const signAndSendTransaction = vi.fn(async (_transaction: Transaction) => 'signature');
		await signAndSendSolanaTransaction(
			{ signAndSendTransaction },
			built.transaction,
			{} as Connection,
			built.signers,
		);
		const given = signAndSendTransaction.mock.calls[0]![0];
		const event = given.signatures.find((s) => s.publicKey.equals(built.signers[0]!.publicKey));
		expect(event?.signature).toBeTruthy();
	});

	it('sends a transaction only the wallet signs through the kit connection', async () => {
		const sendTransaction = vi.fn(async () => 'signature');
		const connection = {} as Connection;
		const transaction = new Transaction();
		await signAndSendSolanaTransaction(
			{ sendTransaction, signAndSendTransaction: vi.fn() },
			transaction,
			connection,
		);
		expect(sendTransaction).toHaveBeenCalledWith(transaction, connection);
	});
});
