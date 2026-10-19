// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
	ComputeBudgetProgram,
	Connection,
	Keypair,
	PublicKey,
	SendTransactionError,
	SystemProgram,
	Transaction,
	TransactionMessage,
	VersionedTransaction,
} from '@solana/web3.js';
import type { TransactionInstruction } from '@solana/web3.js';
import { Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519';
import { toBase58 } from '@mysten/sui/utils';
import { describe, expect, it, vi } from 'vitest';
import { SOLANA_MAINNET } from '../../src/chains/solana.js';
import {
	buildSolanaBurnTransaction,
	buildSolanaReceiveTransaction,
	getAssociatedTokenAddress,
} from '../../src/engine/solana.js';
import { MESSAGE_V2 } from '../../src/utils/bytes.js';
import { signAndSendSolanaTransaction } from '../../src/wallets/solana.js';
import type { SolanaProviderLike } from '../../src/wallets/solana.js';
import { MAINNET_CCTP_LOOKUP_TABLE, solanaHasCctpLookupTable } from './solana-lookup-table.js';

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

/** A claim of a transfer from Sui that `wallet` pays for, with two attesters' signatures. */
async function claim() {
	const recipient = getAssociatedTokenAddress(
		new PublicKey(SOLANA_MAINNET.usdcMint),
		wallet.publicKey,
	);
	const message = new Uint8Array(MESSAGE_V2.body + MESSAGE_V2.bodyFields.hookData);
	new DataView(message.buffer).setUint32(MESSAGE_V2.sourceDomain, 8);
	message.set(recipient.toBytes(), MESSAGE_V2.body + MESSAGE_V2.bodyFields.mintRecipient);
	vi.spyOn(Connection.prototype, 'getLatestBlockhash').mockResolvedValue({
		blockhash: Keypair.generate().publicKey.toBase58(),
		lastValidBlockHeight: 1,
	});
	vi.spyOn(Connection.prototype, 'getAccountInfo').mockResolvedValue({
		data: Buffer.alloc(8 + 32 + 32 + 32 + 4 + 1 + 32 + 32 + 4),
		executable: false,
		lamports: 1,
		owner: wallet.publicKey,
	});
	solanaHasCctpLookupTable();
	return buildSolanaReceiveTransaction(
		SOLANA_MAINNET,
		wallet.publicKey,
		message,
		new Uint8Array(130),
	);
}

/** A versioned transaction `wallet` pays for that `other` has to sign as well. */
function versionedNeeding(other: Keypair): VersionedTransaction {
	return new VersionedTransaction(
		new TransactionMessage({
			payerKey: wallet.publicKey,
			recentBlockhash: Keypair.generate().publicKey.toBase58(),
			instructions: [
				SystemProgram.transfer({
					fromPubkey: other.publicKey,
					toPubkey: wallet.publicKey,
					lamports: 1,
				}),
			],
		}).compileToV0Message(),
	);
}

/**
 * A wallet that sets its own compute budget before it signs and returns the changed
 * transaction, which is what wallets did to this kit's transactions on mainnet. Like AppKit's
 * providers it takes either kind of transaction, and gives back the kind it was given.
 */
async function signLikeAWallet<T extends Transaction | VersionedTransaction>(
	transaction: T,
): Promise<T> {
	const budget = [
		ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
		ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
	];
	const notBudget = (i: TransactionInstruction) =>
		!i.programId.equals(ComputeBudgetProgram.programId);
	if (transaction instanceof VersionedTransaction) {
		// The tables the transaction names, which the wallet fetches to read it and compiles it
		// against again.
		const tables = [MAINNET_CCTP_LOOKUP_TABLE].filter((table) =>
			transaction.message.addressTableLookups.some((l) => l.accountKey.equals(table.key)),
		);
		const { payerKey, recentBlockhash, instructions } = TransactionMessage.decompile(
			transaction.message,
			{ addressLookupTableAccounts: tables },
		);
		const rewritten = new VersionedTransaction(
			new TransactionMessage({
				payerKey,
				recentBlockhash,
				instructions: [...budget, ...instructions.filter(notBudget)],
			}).compileToV0Message(tables),
		);
		rewritten.sign([wallet]);
		return VersionedTransaction.deserialize(rewritten.serialize()) as T;
	}
	const legacy = transaction as Transaction;
	const rewritten = new Transaction();
	rewritten.feePayer = legacy.feePayer;
	rewritten.recentBlockhash = legacy.recentBlockhash;
	rewritten.add(...budget, ...legacy.instructions.filter(notBudget));
	rewritten.partialSign(wallet);
	// Over the wire and back, as a wallet returns it.
	return Transaction.from(rewritten.serialize({ requireAllSignatures: false })) as T;
}

/** Whether every signature a versioned transaction needs is there and verifies. */
async function signedByAll(transaction: VersionedTransaction): Promise<boolean> {
	const message = transaction.message.serialize();
	const signers = transaction.message.staticAccountKeys.slice(
		0,
		transaction.message.header.numRequiredSignatures,
	);
	const checks = await Promise.all(
		signers.map((key, i) =>
			new Ed25519PublicKey(key.toBytes()).verify(message, transaction.signatures[i]!),
		),
	);
	return checks.every(Boolean);
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
		const given = signTransaction.mock.calls[0]![0] as Transaction;
		expect(given.signatures.every((s) => !s.signature)).toBe(true);
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
			expect(await outcome).toBe(toBase58(sent.signature!));
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
			expect(await outcome).toBe(toBase58(sent.signature!));
			expect(sendRawTransaction).toHaveBeenCalledTimes(3);
		} finally {
			vi.useRealTimers();
		}
	});

	it('keeps the signature when a send is refused after one that got no answer', async () => {
		// The first send may have reached the node before the connection dropped. Being turned
		// away afterwards says nothing about it, so the burn is still tracked, not reported as
		// failed with a Retry beside it.
		const refusals = [
			new Error('429 Too Many Requests: slow down'),
			new SendTransactionError({
				action: 'simulate',
				signature: '',
				transactionMessage: 'Blockhash not found',
			}),
		];
		for (const refusal of refusals) {
			vi.useFakeTimers();
			try {
				const built = await burn();
				const sendRawTransaction = vi
					.fn<(raw: Buffer | Uint8Array | number[]) => Promise<string>>()
					.mockRejectedValueOnce(new TypeError('Failed to fetch'))
					.mockRejectedValue(refusal);
				const outcome = signAndSendSolanaTransaction(
					{ signTransaction: vi.fn(signLikeAWallet), signAndSendTransaction: vi.fn() },
					built.transaction,
					{ sendRawTransaction } as unknown as Connection,
					built.signers,
				);
				await vi.runAllTimersAsync();
				const sent = Transaction.from(sendRawTransaction.mock.calls[0]![0] as Buffer);
				expect(await outcome).toBe(toBase58(sent.signature!));
			} finally {
				vi.useRealTimers();
			}
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
		const signAndSendTransaction = vi.fn(async (_transaction: unknown) => 'signature');
		await signAndSendSolanaTransaction(
			{ signAndSendTransaction },
			built.transaction,
			{} as Connection,
			built.signers,
		);
		const given = signAndSendTransaction.mock.calls[0]![0] as Transaction;
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

describe('signing a versioned Solana transaction that needs a second signer', () => {
	it('lets the wallet sign first, then adds the second signature to what the wallet returned', async () => {
		const other = Keypair.generate();
		const signTransaction = vi.fn(signLikeAWallet);
		const sendRawTransaction = vi.fn(async (_raw: Buffer | Uint8Array | number[]) => 'signature');
		const result = await signAndSendSolanaTransaction(
			{ signTransaction, signAndSendTransaction: vi.fn() },
			versionedNeeding(other),
			{ sendRawTransaction } as unknown as Connection,
			[other],
		);
		expect(result).toBe('signature');
		const given = signTransaction.mock.calls[0]![0] as VersionedTransaction;
		expect(given.signatures.every((s) => s.every((byte) => byte === 0))).toBe(true);
		const sent = VersionedTransaction.deserialize(
			sendRawTransaction.mock.calls[0]![0] as Uint8Array,
		);
		expect(sent.message.compiledInstructions).toHaveLength(3);
		expect(sent.message.staticAccountKeys.slice(0, 2).map((key) => key.toBase58())).toEqual([
			wallet.publicKey.toBase58(),
			other.publicKey.toBase58(),
		]);
		expect(await signedByAll(sent)).toBe(true);
	});

	it("hands back the fee payer's signature when no send gets an answer", async () => {
		vi.useFakeTimers();
		try {
			const other = Keypair.generate();
			const sendRawTransaction = vi
				.fn<(raw: Buffer | Uint8Array | number[]) => Promise<string>>()
				.mockRejectedValue(new TypeError('Failed to fetch'));
			const outcome = signAndSendSolanaTransaction(
				{ signTransaction: vi.fn(signLikeAWallet), signAndSendTransaction: vi.fn() },
				versionedNeeding(other),
				{ sendRawTransaction } as unknown as Connection,
				[other],
			);
			await vi.runAllTimersAsync();
			const sent = VersionedTransaction.deserialize(
				sendRawTransaction.mock.calls[0]![0] as Uint8Array,
			);
			expect(await outcome).toBe(toBase58(sent.signatures[0]!));
			expect(sendRawTransaction).toHaveBeenCalledTimes(3);
		} finally {
			vi.useRealTimers();
		}
	});

	it('signs first itself for a wallet that can only sign and send in one step', async () => {
		const other = Keypair.generate();
		const signAndSendTransaction = vi.fn(async (_transaction: unknown) => 'signature');
		await signAndSendSolanaTransaction(
			{ signAndSendTransaction },
			versionedNeeding(other),
			{} as Connection,
			[other],
		);
		const given = signAndSendTransaction.mock.calls[0]![0] as VersionedTransaction;
		expect(given.signatures[1]!.some((byte) => byte !== 0)).toBe(true);
	});
});

describe('sending a Solana claim', () => {
	it('gives the wallet the v0 claim, and what the wallet signed still fits in 1232 bytes', async () => {
		const { transaction } = await claim();
		const sendRawTransaction = vi.fn(async (_raw: Buffer | Uint8Array | number[]) => 'signature');
		// How AppKit's providers send: the wallet signs, and the bytes go out through the kit's
		// connection.
		const sendTransaction = vi.fn<NonNullable<SolanaProviderLike['sendTransaction']>>(
			async (given, connection) =>
				connection.sendRawTransaction((await signLikeAWallet(given)).serialize()),
		);
		const result = await signAndSendSolanaTransaction(
			{ sendTransaction, signAndSendTransaction: vi.fn() },
			transaction,
			{ sendRawTransaction } as unknown as Connection,
		);
		expect(result).toBe('signature');
		expect(sendTransaction.mock.calls[0]![0]).toBe(transaction);
		const raw = sendRawTransaction.mock.calls[0]![0] as Uint8Array;
		expect(raw.length).toBeLessThan(1232);
		const sent = VersionedTransaction.deserialize(raw);
		expect(sent.version).toBe(0);
		expect(sent.message.addressTableLookups.map((l) => l.accountKey.toBase58())).toEqual([
			SOLANA_MAINNET.cctpLookupTable,
		]);
		expect(await signedByAll(sent)).toBe(true);
	});
});
