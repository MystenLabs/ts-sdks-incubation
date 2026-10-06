// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from 'buffer';
import {
	Connection,
	Keypair,
	PublicKey,
	SystemProgram,
	Transaction,
	TransactionInstruction,
} from '@solana/web3.js';
import type { SolanaChainDefinition } from '../chains/types.js';
import { parseMessageV2 } from '../utils/bytes.js';
import { TransactionRevertedError } from '../utils/errors.js';
import { sleep } from '../utils/sleep.js';

export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
	'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
);

/** Anchor instruction discriminators from the v2 IDLs (sha256("global:<name>")[0..8]). */
const DISCRIMINATOR = {
	depositForBurn: Uint8Array.from([215, 60, 61, 46, 114, 55, 128, 176]),
	receiveMessage: Uint8Array.from([38, 144, 127, 225, 31, 225, 238, 25]),
};

const connections = new Map<string, Connection>();
const preferredRpc = new Map<string, number>();

function connectionFor(url: string): Connection {
	let connection = connections.get(url);
	if (!connection) {
		connection = new Connection(url, 'confirmed');
		connections.set(url, connection);
	}
	return connection;
}

/** The chain's primary connection (used for wallet submission). */
export function getSolanaConnection(chain: SolanaChainDefinition): Connection {
	const index = preferredRpc.get(chain.key) ?? 0;
	return connectionFor(chain.rpcUrls[index] ?? chain.rpcUrls[0]!);
}

/**
 * Run a read against the chain's RPC list, falling over to the next endpoint on transport
 * failure and remembering the one that worked. Application errors (e.g. "account not found")
 * are not retried.
 */
export async function withSolanaConnection<T>(
	chain: SolanaChainDefinition,
	fn: (connection: Connection) => Promise<T>,
): Promise<T> {
	const start = preferredRpc.get(chain.key) ?? 0;
	let lastError: unknown;
	for (let i = 0; i < chain.rpcUrls.length; i++) {
		const index = (start + i) % chain.rpcUrls.length;
		try {
			const result = await fn(connectionFor(chain.rpcUrls[index]!));
			preferredRpc.set(chain.key, index);
			return result;
		} catch (error) {
			lastError = error;
			if (!isTransportError(error)) throw error;
		}
	}
	throw lastError instanceof Error ? lastError : new Error('All Solana RPC endpoints failed');
}

function isTransportError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /fetch failed|failed to fetch|network|timeout|timed out|429|50\d|ECONN|socket|rate limit/i.test(
		message,
	);
}

function pda(programId: PublicKey, seeds: (string | Uint8Array | PublicKey)[]): PublicKey {
	const encoded = seeds.map((seed) => {
		if (typeof seed === 'string') return Buffer.from(seed, 'utf8');
		if (seed instanceof PublicKey) return seed.toBuffer();
		return Buffer.from(seed);
	});
	return PublicKey.findProgramAddressSync(encoded, programId)[0];
}

export function getAssociatedTokenAddress(mint: PublicKey, owner: PublicKey): PublicKey {
	return pda(ASSOCIATED_TOKEN_PROGRAM_ID, [owner, TOKEN_PROGRAM_ID, mint]);
}

function createAtaIdempotentInstruction(
	payer: PublicKey,
	ata: PublicKey,
	owner: PublicKey,
	mint: PublicKey,
): TransactionInstruction {
	return new TransactionInstruction({
		programId: ASSOCIATED_TOKEN_PROGRAM_ID,
		keys: [
			{ pubkey: payer, isSigner: true, isWritable: true },
			{ pubkey: ata, isSigner: false, isWritable: true },
			{ pubkey: owner, isSigner: false, isWritable: false },
			{ pubkey: mint, isSigner: false, isWritable: false },
			{ pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
			{ pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
		],
		data: Buffer.from([1]),
	});
}

class BorshWriter {
	#chunks: Uint8Array[] = [];

	u32(value: number) {
		const buf = new Uint8Array(4);
		new DataView(buf.buffer).setUint32(0, value, true);
		this.#chunks.push(buf);
		return this;
	}

	u64(value: bigint) {
		const buf = new Uint8Array(8);
		new DataView(buf.buffer).setBigUint64(0, value, true);
		this.#chunks.push(buf);
		return this;
	}

	pubkey(key: PublicKey) {
		this.#chunks.push(key.toBytes());
		return this;
	}

	bytes(value: Uint8Array) {
		this.u32(value.length);
		this.#chunks.push(value);
		return this;
	}

	raw(value: Uint8Array) {
		this.#chunks.push(value);
		return this;
	}

	toBuffer(): Buffer {
		const total = this.#chunks.reduce((n, c) => n + c.length, 0);
		const out = new Uint8Array(total);
		let offset = 0;
		for (const chunk of this.#chunks) {
			out.set(chunk, offset);
			offset += chunk.length;
		}
		return Buffer.from(out);
	}
}

export interface SolanaDepositForBurnParams {
	owner: PublicKey;
	amount: bigint;
	destinationDomain: number;
	/** 32-byte recipient. */
	mintRecipient: Uint8Array;
	/** 32-byte destination caller; omit to allow anyone to mint. */
	destinationCaller?: Uint8Array;
	maxFee: bigint;
	minFinalityThreshold: number;
}

export interface SolanaBuiltTransaction {
	transaction: Transaction;
	/**
	 * Keypairs the wallet does not control that must also sign. They are not applied here: the
	 * wallet signs first (see `signAndSendSolanaTransaction`).
	 */
	signers: Keypair[];
}

/**
 * Build a CCTP v2 `deposit_for_burn` transaction. The `message_sent_event_data` account is
 * a fresh keypair that must co-sign. It is returned in `signers` and has not signed yet: the
 * wallet has to sign before it does.
 */
export async function buildSolanaBurnTransaction(
	chain: SolanaChainDefinition,
	params: SolanaDepositForBurnParams,
): Promise<SolanaBuiltTransaction> {
	const mt = new PublicKey(chain.messageTransmitterV2);
	const tmm = new PublicKey(chain.tokenMessengerMinterV2);
	const mint = new PublicKey(chain.usdcMint);
	const eventKeypair = Keypair.generate();

	const data = new BorshWriter()
		.raw(DISCRIMINATOR.depositForBurn)
		.u64(params.amount)
		.u32(params.destinationDomain)
		.raw(params.mintRecipient)
		.raw(params.destinationCaller ?? new Uint8Array(32))
		.u64(params.maxFee)
		.u32(params.minFinalityThreshold)
		.toBuffer();

	const instruction = new TransactionInstruction({
		programId: tmm,
		data,
		keys: [
			{ pubkey: params.owner, isSigner: true, isWritable: false },
			{ pubkey: params.owner, isSigner: true, isWritable: true }, // event_rent_payer
			{ pubkey: pda(tmm, ['sender_authority']), isSigner: false, isWritable: false },
			{ pubkey: getAssociatedTokenAddress(mint, params.owner), isSigner: false, isWritable: true },
			{ pubkey: pda(tmm, ['denylist_account', params.owner]), isSigner: false, isWritable: false },
			{ pubkey: pda(mt, ['message_transmitter']), isSigner: false, isWritable: true },
			{ pubkey: pda(tmm, ['token_messenger']), isSigner: false, isWritable: false },
			{
				pubkey: pda(tmm, ['remote_token_messenger', params.destinationDomain.toString()]),
				isSigner: false,
				isWritable: false,
			},
			{ pubkey: pda(tmm, ['token_minter']), isSigner: false, isWritable: false },
			{ pubkey: pda(tmm, ['local_token', mint]), isSigner: false, isWritable: true },
			{ pubkey: mint, isSigner: false, isWritable: true },
			{ pubkey: eventKeypair.publicKey, isSigner: true, isWritable: true },
			{ pubkey: mt, isSigner: false, isWritable: false },
			{ pubkey: tmm, isSigner: false, isWritable: false },
			{ pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
			{ pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
			{ pubkey: pda(tmm, ['__event_authority']), isSigner: false, isWritable: false },
			{ pubkey: tmm, isSigner: false, isWritable: false },
		],
	});

	const transaction = new Transaction().add(instruction);
	transaction.feePayer = params.owner;
	const { blockhash, lastValidBlockHeight } = await withSolanaConnection(chain, (c) =>
		c.getLatestBlockhash(),
	);
	transaction.recentBlockhash = blockhash;
	transaction.lastValidBlockHeight = lastValidBlockHeight;

	return { transaction, signers: [eventKeypair] };
}

/** Read `fee_recipient` from the TokenMessenger account (Anchor layout from the v2 IDL). */
async function getFeeRecipient(chain: SolanaChainDefinition, tmm: PublicKey): Promise<PublicKey> {
	const info = await withSolanaConnection(chain, (c) =>
		c.getAccountInfo(pda(tmm, ['token_messenger'])),
	);
	if (!info) throw new Error('TokenMessenger account not found');
	// 8 discriminator + denylister(32) + owner(32) + pending_owner(32) + message_body_version(4) + authority_bump(1)
	const offset = 8 + 32 + 32 + 32 + 4 + 1;
	return new PublicKey(info.data.subarray(offset, offset + 32));
}

/**
 * A transaction that creates the USDC token account a message mints to, or `null` when the
 * account already exists.
 *
 * It has to be its own transaction: `receive_message` alone is within a few bytes of Solana's
 * 1232-byte limit, so adding the create instruction to it makes a transaction no node accepts.
 * Anyone may create an associated token account for any owner (the payer funds the rent), but
 * the owner has to be known: the recipient wallet from the record, or the payer claiming for
 * themselves.
 */
export async function buildSolanaTokenAccountTransaction(
	chain: SolanaChainDefinition,
	payer: PublicKey,
	message: Uint8Array,
	recipientOwner?: PublicKey,
): Promise<SolanaBuiltTransaction | null> {
	const mint = new PublicKey(chain.usdcMint);
	const parsed = parseMessageV2(bytesToHexString(message));
	const recipientTokenAccount = new PublicKey(parsed.body.mintRecipient);
	const existing = await withSolanaConnection(chain, (c) =>
		c.getAccountInfo(recipientTokenAccount),
	);
	if (existing) return null;
	const owner = [recipientOwner, payer].find(
		(candidate) =>
			candidate && getAssociatedTokenAddress(mint, candidate).equals(recipientTokenAccount),
	);
	if (!owner) {
		throw new Error(
			'The recipient has no USDC token account on Solana and its owner is unknown; the recipient wallet must create one first',
		);
	}
	const transaction = new Transaction();
	transaction.add(createAtaIdempotentInstruction(payer, recipientTokenAccount, owner, mint));
	transaction.feePayer = payer;
	const { blockhash, lastValidBlockHeight } = await withSolanaConnection(chain, (c) =>
		c.getLatestBlockhash(),
	);
	transaction.recentBlockhash = blockhash;
	transaction.lastValidBlockHeight = lastValidBlockHeight;
	return { transaction, signers: [] };
}

/**
 * Build a CCTP v2 `receive_message` transaction. The mint recipient encoded in the message is
 * a USDC token account, which must exist: see `buildSolanaTokenAccountTransaction`.
 */
export async function buildSolanaReceiveTransaction(
	chain: SolanaChainDefinition,
	payer: PublicKey,
	message: Uint8Array,
	attestation: Uint8Array,
): Promise<SolanaBuiltTransaction> {
	const mt = new PublicKey(chain.messageTransmitterV2);
	const tmm = new PublicKey(chain.tokenMessengerMinterV2);
	const mint = new PublicKey(chain.usdcMint);
	const parsed = parseMessageV2(bytesToHexString(message));
	const remoteDomain = parsed.sourceDomain.toString();
	const recipientTokenAccount = new PublicKey(parsed.body.mintRecipient);
	const feeRecipient = await getFeeRecipient(chain, tmm);

	const data = new BorshWriter()
		.raw(DISCRIMINATOR.receiveMessage)
		.bytes(message)
		.bytes(attestation)
		.toBuffer();

	const instruction = new TransactionInstruction({
		programId: mt,
		data,
		keys: [
			{ pubkey: payer, isSigner: true, isWritable: true },
			{ pubkey: payer, isSigner: true, isWritable: false }, // caller
			{
				pubkey: pda(mt, ['message_transmitter_authority', tmm]),
				isSigner: false,
				isWritable: false,
			},
			{ pubkey: pda(mt, ['message_transmitter']), isSigner: false, isWritable: false },
			{ pubkey: pda(mt, ['used_nonce', parsed.nonce]), isSigner: false, isWritable: true },
			{ pubkey: tmm, isSigner: false, isWritable: false }, // receiver
			{ pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
			{ pubkey: pda(mt, ['__event_authority']), isSigner: false, isWritable: false },
			{ pubkey: mt, isSigner: false, isWritable: false },
			// Remaining accounts consumed by token_messenger_minter_v2::handle_receive_message.
			{ pubkey: pda(tmm, ['token_messenger']), isSigner: false, isWritable: false },
			{
				pubkey: pda(tmm, ['remote_token_messenger', remoteDomain]),
				isSigner: false,
				isWritable: false,
			},
			{ pubkey: pda(tmm, ['token_minter']), isSigner: false, isWritable: true },
			{ pubkey: pda(tmm, ['local_token', mint]), isSigner: false, isWritable: true },
			{
				pubkey: pda(tmm, ['token_pair', remoteDomain, parsed.body.burnToken]),
				isSigner: false,
				isWritable: false,
			},
			{ pubkey: getAssociatedTokenAddress(mint, feeRecipient), isSigner: false, isWritable: true },
			{ pubkey: recipientTokenAccount, isSigner: false, isWritable: true },
			{ pubkey: pda(tmm, ['custody', mint]), isSigner: false, isWritable: true },
			{ pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
			{ pubkey: pda(tmm, ['__event_authority']), isSigner: false, isWritable: false },
			{ pubkey: tmm, isSigner: false, isWritable: false },
		],
	});

	const transaction = new Transaction();
	transaction.add(instruction);
	transaction.feePayer = payer;
	const { blockhash, lastValidBlockHeight } = await withSolanaConnection(chain, (c) =>
		c.getLatestBlockhash(),
	);
	transaction.recentBlockhash = blockhash;
	transaction.lastValidBlockHeight = lastValidBlockHeight;

	return { transaction, signers: [] };
}

/** Bytes of the account a claim creates to record that its nonce was used. */
const USED_NONCE_ACCOUNT_SIZE = 9;
/** Bytes of an SPL token account. */
const TOKEN_ACCOUNT_SIZE = 165;
const LAMPORTS_PER_SIGNATURE = 5_000;

/**
 * What a wallet holds and the least it needs to claim, in lamports: rent for the accounts the
 * claim creates, the base fees, and the minimum Solana makes a wallet keep. Wallets add a
 * priority fee on top, so this is a lower bound: a wallet below it cannot claim.
 */
export async function getSolanaClaimFunds(
	chain: SolanaChainDefinition,
	payer: PublicKey,
	createsTokenAccount: boolean,
): Promise<{ balance: bigint; required: bigint }> {
	return withSolanaConnection(chain, async (connection) => {
		const [balance, nonceRent, tokenAccountRent, keep] = await Promise.all([
			connection.getBalance(payer),
			connection.getMinimumBalanceForRentExemption(USED_NONCE_ACCOUNT_SIZE),
			createsTokenAccount ? connection.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SIZE) : 0,
			connection.getMinimumBalanceForRentExemption(0),
		]);
		const fees = LAMPORTS_PER_SIGNATURE * (createsTokenAccount ? 2 : 1);
		return {
			balance: BigInt(balance),
			required: BigInt(nonceRent + tokenAccountRent + keep + fees),
		};
	});
}

export async function getSolanaUsdcBalance(
	chain: SolanaChainDefinition,
	owner: PublicKey,
): Promise<bigint> {
	const ata = getAssociatedTokenAddress(new PublicKey(chain.usdcMint), owner);
	return withSolanaConnection(chain, async (connection) => {
		const info = await connection.getAccountInfo(ata);
		if (!info) return 0n; // no token account yet: genuinely zero
		// SPL token account layout: mint (32 bytes), owner (32), amount (u64, little-endian).
		// Reading it from here avoids `getTokenAccountBalance`, which public endpoints refuse
		// to serve to browsers.
		return Buffer.from(info.data).readBigUInt64LE(64);
	});
}

export async function solanaIsNonceUsed(
	chain: SolanaChainDefinition,
	nonce: Uint8Array,
): Promise<boolean> {
	const mt = new PublicKey(chain.messageTransmitterV2);
	const info = await withSolanaConnection(chain, (c) =>
		c.getAccountInfo(pda(mt, ['used_nonce', nonce])),
	);
	return info !== null;
}

/** A blockhash can be used in the 150 blocks after the one it comes from. */
const BLOCKHASH_LIFETIME_BLOCKS = 150;
/**
 * Slack for not knowing which blockhash a transaction carries: a wallet may replace the one it
 * was given with one from a node that was ahead of the node this kit asks.
 */
const BLOCK_HEIGHT_SLACK = 150;
const CONFIRMATION_POLL_MS = 1_500;
/** Long enough for an unused blockhash to expire and for that to become final. */
const CONFIRMATION_TIMEOUT_MS = 240_000;

export interface SolanaConfirmationOptions {
	signal?: AbortSignal;
	pollIntervalMs?: number;
	timeoutMs?: number;
	/**
	 * The last block that could carry the transaction, from `getSolanaLastPossibleBlock` taken
	 * after it was signed. Read at the start of the wait when it is not given.
	 */
	lastPossibleBlock?: number;
}

/**
 * The last block a transaction signed before now could be included in, or null when the chain
 * could not be asked.
 *
 * Whichever blockhash the transaction carries, it existed before now. So it comes from a block
 * no higher than the current one, give or take the slack, and cannot be used more than 150
 * blocks after that. Take the reading after the wallet has signed: a wallet can replace the
 * blockhash while its prompt is open.
 */
export async function getSolanaLastPossibleBlock(
	chain: SolanaChainDefinition,
): Promise<number | null> {
	const now = await withSolanaConnection(chain, (c) => c.getEpochInfo('processed')).catch(
		() => null,
	);
	return now?.blockHeight ? now.blockHeight + BLOCKHASH_LIFETIME_BLOCKS + BLOCK_HEIGHT_SLACK : null;
}

/**
 * Wait for a transaction that has been sent to be confirmed.
 *
 * Throws `TransactionRevertedError` only on proof that it did not happen and never will: it is
 * on chain with an error, or the finalized chain has passed the last block that could have
 * carried it and it is not there. Any other rejection means the outcome is unknown and the
 * transaction may still land, so the caller must not send it again.
 *
 * It polls, so it needs no websocket.
 */
export async function waitForSolanaConfirmation(
	chain: SolanaChainDefinition,
	signature: string,
	options: SolanaConfirmationOptions = {},
): Promise<void> {
	const pollMs = options.pollIntervalMs ?? CONFIRMATION_POLL_MS;
	const deadline = Date.now() + (options.timeoutMs ?? CONFIRMATION_TIMEOUT_MS);
	let lastPossibleHeight: number | null = options.lastPossibleBlock ?? null;
	for (;;) {
		options.signal?.throwIfAborted();
		// A reading taken on a later pass is still an upper bound; without one nothing can be
		// said about expiry.
		lastPossibleHeight ??= await getSolanaLastPossibleBlock(chain);
		const status = await getSolanaSignatureStatus(chain, signature);
		if (status?.value) {
			if (status.value.err) {
				throw new TransactionRevertedError(
					`Solana transaction ${signature} failed: ${JSON.stringify(status.value.err)}`,
				);
			}
			const level = status.value.confirmationStatus;
			if (level === 'confirmed' || level === 'finalized') return;
		} else if (status && lastPossibleHeight !== null) {
			if (await hasSolanaTransactionExpired(chain, signature, lastPossibleHeight)) {
				throw new TransactionRevertedError(
					`Solana transaction ${signature} expired before it was included`,
				);
			}
		}
		if (Date.now() >= deadline) {
			throw new Error(
				`Solana transaction ${signature} was not confirmed in time; it may still go through`,
			);
		}
		await sleep(pollMs, options.signal);
	}
}

/** What a node says about a signature, or null when no node could be asked. */
async function getSolanaSignatureStatus(chain: SolanaChainDefinition, signature: string) {
	try {
		const response = await withSolanaConnection(chain, (c) =>
			c.getSignatureStatuses([signature], { searchTransactionHistory: true }),
		);
		return { slot: response.context.slot, value: response.value[0] ?? null };
	} catch {
		return null;
	}
}

/**
 * Whether a transaction no node has seen can be ruled out for good: the finalized chain is
 * past the last block that could carry it, and a node that has got at least that far still
 * does not know it.
 */
async function hasSolanaTransactionExpired(
	chain: SolanaChainDefinition,
	signature: string,
	lastPossibleHeight: number,
): Promise<boolean> {
	const finalized = await withSolanaConnection(chain, (c) => c.getEpochInfo('finalized')).catch(
		() => null,
	);
	if (!finalized?.blockHeight || finalized.blockHeight <= lastPossibleHeight) return false;
	const status = await getSolanaSignatureStatus(chain, signature);
	return status !== null && status.value === null && status.slot >= finalized.absoluteSlot;
}

/** Whether a transaction is on chain and succeeded, or null when that could not be read. */
export async function hasSolanaTransactionSucceeded(
	chain: SolanaChainDefinition,
	signature: string,
): Promise<boolean | null> {
	const status = await getSolanaSignatureStatus(chain, signature);
	if (!status) return null;
	const level = status.value?.confirmationStatus;
	return !!status.value && !status.value.err && (level === 'confirmed' || level === 'finalized');
}

function bytesToHexString(bytes: Uint8Array): string {
	let out = '0x';
	for (const b of bytes) out += b.toString(16).padStart(2, '0');
	return out;
}

/** Owner wallet of an SPL token account (bytes 32..64 of the account data), or null if it does not exist. */
export async function getSolanaTokenAccountOwner(
	chain: SolanaChainDefinition,
	tokenAccount: PublicKey,
): Promise<PublicKey | null> {
	const info = await withSolanaConnection(chain, (c) => c.getAccountInfo(tokenAccount));
	if (!info || info.data.length < 64) return null;
	return new PublicKey(info.data.subarray(32, 64));
}

/** Block time (ms) of a confirmed transaction, or null if unknown. */
export async function getSolanaTransactionTime(
	chain: SolanaChainDefinition,
	signature: string,
): Promise<number | null> {
	const tx = await withSolanaConnection(chain, (c) =>
		c.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }),
	);
	return tx?.blockTime ? tx.blockTime * 1000 : null;
}
