// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
	ComputeBudgetInstruction,
	ComputeBudgetProgram,
	Connection,
	Keypair,
	PublicKey,
	Transaction,
	TransactionMessage,
	VersionedTransaction,
} from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { SOLANA_MAINNET } from '../../src/chains/solana.js';
import {
	buildSolanaBurnTransaction,
	buildSolanaReceiveTransaction,
	buildSolanaTokenAccountTransaction,
	getAssociatedTokenAddress,
	getSolanaClaimedMessage,
	getSolanaUsdcBalance,
} from '../../src/engine/solana.js';
import { MESSAGE_V2 } from '../../src/utils/bytes.js';
import { CctpKitError } from '../../src/utils/errors.js';
import { MAINNET_CCTP_LOOKUP_TABLE, solanaHasCctpLookupTable } from './solana-lookup-table.js';

const owner = Keypair.generate().publicKey;

/** The programs a versioned transaction calls, in order. Program ids are never in a lookup table. */
function programsOf(transaction: VersionedTransaction): string[] {
	const { compiledInstructions, staticAccountKeys } = transaction.message;
	return compiledInstructions.map((i) => staticAccountKeys[i.programIdIndex]!.toBase58());
}

/** The instructions of a claim, with the accounts it loads from Circle's table put back. */
function instructionsOf(transaction: VersionedTransaction) {
	return TransactionMessage.decompile(transaction.message, {
		addressLookupTableAccounts: [MAINNET_CCTP_LOOKUP_TABLE],
	}).instructions;
}

/**
 * A v2 message from Sui to Solana as Circle attests it: 376 bytes, which is the whole message
 * when there is no hook data.
 */
function suiMessage(recipientTokenAccount: PublicKey): Uint8Array {
	const message = new Uint8Array(MESSAGE_V2.body + MESSAGE_V2.bodyFields.hookData).fill(0x5a);
	const view = new DataView(message.buffer);
	view.setUint32(MESSAGE_V2.version, 1);
	view.setUint32(MESSAGE_V2.sourceDomain, 8);
	view.setUint32(MESSAGE_V2.destinationDomain, SOLANA_MAINNET.domain);
	message.set(
		recipientTokenAccount.toBytes(),
		MESSAGE_V2.body + MESSAGE_V2.bodyFields.mintRecipient,
	);
	return message;
}

/** The chain a claim is built against: a token messenger to read the fee recipient from. */
function solanaServesClaims(feeRecipient = Keypair.generate().publicKey) {
	const tokenMessengerData = Buffer.alloc(8 + 32 + 32 + 32 + 4 + 1 + 32 + 32 + 4);
	feeRecipient.toBuffer().copy(tokenMessengerData, 109);
	vi.spyOn(Connection.prototype, 'getLatestBlockhash').mockResolvedValue({
		blockhash: '11111111111111111111111111111111',
		lastValidBlockHeight: 1,
	});
	vi.spyOn(Connection.prototype, 'getAccountInfo').mockResolvedValue({
		data: tokenMessengerData,
		executable: false,
		lamports: 1,
		owner,
	});
}

describe('Solana CCTP v2 instruction builders', () => {
	it('creates the recipient token account in its own transaction, for a known owner', async () => {
		const recipientOwner = Keypair.generate().publicKey;
		const mint = new PublicKey(SOLANA_MAINNET.usdcMint);
		const ata = getAssociatedTokenAddress(mint, recipientOwner);
		const message = new Uint8Array(MESSAGE_V2.body + MESSAGE_V2.bodyFields.hookData);
		new DataView(message.buffer).setUint32(MESSAGE_V2.sourceDomain, 8);
		message.set(ata.toBytes(), MESSAGE_V2.body + MESSAGE_V2.bodyFields.mintRecipient);
		const tokenMessengerData = Buffer.alloc(8 + 32 + 32 + 32 + 4 + 1 + 32 + 32 + 4);
		vi.spyOn(Connection.prototype, 'getLatestBlockhash').mockResolvedValue({
			blockhash: '11111111111111111111111111111111',
			lastValidBlockHeight: 1,
		});
		vi.spyOn(Connection.prototype, 'getAccountInfo').mockImplementation(async (key) => {
			if ((key as PublicKey).equals(ata)) return null;
			return { data: tokenMessengerData, executable: false, lamports: 1, owner };
		});
		const built = await buildSolanaTokenAccountTransaction(
			SOLANA_MAINNET,
			owner,
			message,
			recipientOwner,
		);
		expect(built!.transaction.instructions).toHaveLength(1);
		const create = built!.transaction.instructions[0]!;
		expect(create.keys[0]!.pubkey.equals(owner)).toBe(true); // payer funds rent
		expect(create.keys[1]!.pubkey.equals(ata)).toBe(true);
		expect(create.keys[2]!.pubkey.equals(recipientOwner)).toBe(true);
		await expect(
			buildSolanaTokenAccountTransaction(SOLANA_MAINNET, owner, message),
		).rejects.toThrow(/owner is unknown/);

		// The claim itself never carries the create instruction, which keeps room in it for what
		// wallets add.
		solanaHasCctpLookupTable();
		const claim = await buildSolanaReceiveTransaction(
			SOLANA_MAINNET,
			owner,
			message,
			new Uint8Array(65),
		);
		expect(programsOf(claim.transaction)).toEqual([
			ComputeBudgetProgram.programId.toBase58(),
			SOLANA_MAINNET.messageTransmitterV2,
		]);
	});

	it('needs no extra transaction when the token account exists', async () => {
		const mint = new PublicKey(SOLANA_MAINNET.usdcMint);
		const ata = getAssociatedTokenAddress(mint, owner);
		const message = new Uint8Array(MESSAGE_V2.body + MESSAGE_V2.bodyFields.hookData);
		message.set(ata.toBytes(), MESSAGE_V2.body + MESSAGE_V2.bodyFields.mintRecipient);
		vi.spyOn(Connection.prototype, 'getAccountInfo').mockResolvedValue({
			data: Buffer.alloc(165),
			executable: false,
			lamports: 1,
			owner,
		});
		expect(await buildSolanaTokenAccountTransaction(SOLANA_MAINNET, owner, message)).toBeNull();
	});

	it('reads the USDC balance from the token account data', async () => {
		// mint (32) + owner (32) + amount (u64 LE) + the rest of a 165-byte token account.
		const data = Buffer.alloc(165);
		data.writeBigUInt64LE(334_600_933n, 64);
		vi.spyOn(Connection.prototype, 'getAccountInfo').mockResolvedValue({
			data,
			executable: false,
			lamports: 1,
			owner,
		});
		const balanceCall = vi.spyOn(Connection.prototype, 'getTokenAccountBalance');
		expect(await getSolanaUsdcBalance(SOLANA_MAINNET, owner)).toBe(334_600_933n);
		// Public endpoints refuse this call from browsers, so it must not be needed.
		expect(balanceCall).not.toHaveBeenCalled();
		vi.spyOn(Connection.prototype, 'getAccountInfo').mockResolvedValue(null);
		expect(await getSolanaUsdcBalance(SOLANA_MAINNET, owner)).toBe(0n);
	});

	it('encodes deposit_for_burn with the Anchor discriminator and Borsh params', async () => {
		vi.spyOn(Connection.prototype, 'getLatestBlockhash').mockResolvedValue({
			blockhash: '11111111111111111111111111111111',
			lastValidBlockHeight: 1,
		});

		const mintRecipient = new Uint8Array(32).fill(9);
		const { transaction, signers } = await buildSolanaBurnTransaction(SOLANA_MAINNET, {
			owner,
			amount: 1_500_000n,
			destinationDomain: 8,
			mintRecipient,
			maxFee: 0n,
			minFinalityThreshold: 1000,
		});

		expect(signers).toHaveLength(1);
		const ix = transaction.instructions[0]!;
		expect(ix.programId.toBase58()).toBe(SOLANA_MAINNET.tokenMessengerMinterV2);
		expect(ix.keys).toHaveLength(18);
		expect(
			ix.keys[3]!.pubkey.equals(
				getAssociatedTokenAddress(new PublicKey(SOLANA_MAINNET.usdcMint), owner),
			),
		).toBe(true);
		expect(ix.keys[11]!.pubkey.equals(signers[0]!.publicKey)).toBe(true);

		const data = ix.data;
		expect(data.length).toBe(8 + 8 + 4 + 32 + 32 + 8 + 4);
		expect(Array.from(data.subarray(0, 8))).toEqual([215, 60, 61, 46, 114, 55, 128, 176]);
		expect(data.readBigUInt64LE(8)).toBe(1_500_000n);
		expect(data.readUInt32LE(16)).toBe(8);
		expect(Array.from(data.subarray(20, 52))).toEqual(Array.from(mintRecipient));
		expect(data.readUInt32LE(92)).toBe(1000);
		// Nothing has signed yet: the wallet signs first, the event account keypair after it.
		expect(transaction.signatures.every((s) => !s.signature)).toBe(true);
	});

	it('encodes receive_message with length-prefixed bytes and the TMM remaining accounts', async () => {
		const payer = owner;
		const ata = getAssociatedTokenAddress(new PublicKey(SOLANA_MAINNET.usdcMint), payer);
		const message = new Uint8Array(MESSAGE_V2.body + MESSAGE_V2.bodyFields.hookData);
		new DataView(message.buffer).setUint32(MESSAGE_V2.sourceDomain, 8);
		message.set(ata.toBytes(), MESSAGE_V2.body + MESSAGE_V2.bodyFields.mintRecipient);
		const attestation = new Uint8Array(65).fill(1);

		const tokenMessengerData = Buffer.alloc(8 + 32 + 32 + 32 + 4 + 1 + 32 + 32 + 4);
		const feeRecipient = Keypair.generate().publicKey;
		feeRecipient.toBuffer().copy(tokenMessengerData, 109);

		vi.spyOn(Connection.prototype, 'getLatestBlockhash').mockResolvedValue({
			blockhash: '11111111111111111111111111111111',
			lastValidBlockHeight: 1,
		});
		vi.spyOn(Connection.prototype, 'getAccountInfo').mockImplementation(async (key) => {
			if ((key as PublicKey).equals(ata)) return null;
			return { data: tokenMessengerData, executable: false, lamports: 1, owner: payer };
		});
		solanaHasCctpLookupTable();

		const { transaction, signers, lastValidBlockHeight } = await buildSolanaReceiveTransaction(
			SOLANA_MAINNET,
			payer,
			message,
			attestation,
		);
		expect(transaction.version).toBe(0);
		expect(signers).toEqual([]);
		expect(lastValidBlockHeight).toBe(1);
		expect(transaction.message.addressTableLookups.map((l) => l.accountKey.toBase58())).toEqual([
			SOLANA_MAINNET.cctpLookupTable,
		]);
		// Its own compute unit limit, then only the claim: a missing token account is created by
		// its own transaction first.
		const instructions = instructionsOf(transaction);
		expect(instructions).toHaveLength(2);
		expect(ComputeBudgetInstruction.decodeSetComputeUnitLimit(instructions[0]!).units).toBe(
			350_000,
		);
		const ix = instructions[1]!;
		expect(ix.programId.toBase58()).toBe(SOLANA_MAINNET.messageTransmitterV2);
		expect(ix.keys).toHaveLength(20);
		// Accounts loaded from the table keep what they may do. The payer is also the caller, and
		// an account is writable everywhere in a transaction if it is anywhere.
		expect(ix.keys.flatMap((k, i) => (k.isSigner ? [i] : []))).toEqual([0, 1]);
		expect(ix.keys.flatMap((k, i) => (k.isWritable ? [i] : []))).toEqual([
			0, 1, 4, 11, 12, 14, 15, 16,
		]);
		expect(ix.keys[15]!.pubkey.equals(ata)).toBe(true);
		expect(
			ix.keys[14]!.pubkey.equals(
				getAssociatedTokenAddress(new PublicKey(SOLANA_MAINNET.usdcMint), feeRecipient),
			),
		).toBe(true);

		const data = ix.data;
		expect(Array.from(data.subarray(0, 8))).toEqual([38, 144, 127, 225, 31, 225, 238, 25]);
		expect(data.readUInt32LE(8)).toBe(message.length);
		expect(data.readUInt32LE(12 + message.length)).toBe(attestation.length);
		expect(data.length).toBe(8 + 4 + message.length + 4 + attestation.length);
	});
});

describe('the size of a Solana claim', () => {
	it('leaves room under 1232 bytes for the compute budget a wallet adds', async () => {
		// A claim of a transfer from Sui as Circle attests it, with two attesters' signatures. On
		// mainnet with Circle's table it is 990 bytes, and 1002 once a wallet has set its limit and
		// its price; the legacy claim was 1224, and 1276 with the same additions.
		const payer = Keypair.generate().publicKey;
		const recipient = getAssociatedTokenAddress(new PublicKey(SOLANA_MAINNET.usdcMint), payer);
		const message = suiMessage(recipient);
		const attestation = new Uint8Array(130).fill(0x2c);
		solanaServesClaims();
		solanaHasCctpLookupTable();
		const { transaction } = await buildSolanaReceiveTransaction(
			SOLANA_MAINNET,
			payer,
			message,
			attestation,
		);
		expect(transaction.serialize().length).toBeLessThan(1232);

		// What a wallet does while it signs: put back the accounts from the table, set its own
		// limit and price, and compile it again against the same table.
		const [, claim] = instructionsOf(transaction);
		const walletAdds = [
			ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
			ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
		];
		const signed = new VersionedTransaction(
			new TransactionMessage({
				payerKey: payer,
				recentBlockhash: transaction.message.recentBlockhash,
				instructions: [...walletAdds, claim!],
			}).compileToV0Message([MAINNET_CCTP_LOOKUP_TABLE]),
		);
		expect(signed.serialize().length).toBeLessThan(1232);

		// The same claim with the same additions as a legacy transaction: what the wallet could
		// not send in production.
		const legacy = new Transaction({
			feePayer: payer,
			blockhash: transaction.message.recentBlockhash,
			lastValidBlockHeight: 1,
		}).add(...walletAdds, claim!);
		expect(() =>
			legacy.serialize({ requireAllSignatures: false, verifySignatures: false }),
		).toThrow('Transaction too large: 1276 > 1232');
	});

	it("is not built without Circle's lookup table", async () => {
		const payer = Keypair.generate().publicKey;
		const recipient = getAssociatedTokenAddress(new PublicKey(SOLANA_MAINNET.usdcMint), payer);
		const build = () =>
			buildSolanaReceiveTransaction(
				SOLANA_MAINNET,
				payer,
				suiMessage(recipient),
				new Uint8Array(130),
			);
		solanaServesClaims();
		const lookup = vi.spyOn(Connection.prototype, 'getAddressLookupTable');

		lookup.mockResolvedValue({ context: { slot: 1 }, value: null });
		const missing = await build().catch((error: unknown) => error);
		expect(missing).toBeInstanceOf(CctpKitError);
		expect((missing as Error).message).toBe(
			`Circle's address lookup table ${SOLANA_MAINNET.cctpLookupTable} is not available on Solana, so a claim cannot be built.`,
		);

		const refused = new Error('403 Forbidden');
		lookup.mockRejectedValue(refused);
		const unread = await build().catch((error: unknown) => error);
		expect(unread).toBeInstanceOf(CctpKitError);
		expect((unread as Error).message).toMatch(/^Could not read Circle's address lookup table/);
		expect((unread as Error).cause).toBe(refused);
	});
});

describe('reading back the message a Solana claim minted', () => {
	const payer = Keypair.generate().publicKey;
	const recipient = getAssociatedTokenAddress(new PublicKey(SOLANA_MAINNET.usdcMint), payer);
	const message = suiMessage(recipient);

	function onChain(transaction: { message: unknown }, err: unknown = null) {
		vi.spyOn(Connection.prototype, 'getTransaction').mockResolvedValue({
			slot: 1,
			blockTime: 1_700_000_000,
			transaction: { message: transaction.message, signatures: [] },
			meta: { err },
		} as never);
	}

	it('finds receive_message in a v0 claim, behind its compute budget instruction', async () => {
		solanaServesClaims();
		solanaHasCctpLookupTable();
		const { transaction } = await buildSolanaReceiveTransaction(
			SOLANA_MAINNET,
			payer,
			message,
			new Uint8Array(130).fill(0x2c),
		);
		// Through the wire and back, as a node returns it.
		onChain(VersionedTransaction.deserialize(transaction.serialize()));
		expect(await getSolanaClaimedMessage(SOLANA_MAINNET, 'claim')).toEqual(message);
		onChain(transaction, { InstructionError: [1, { Custom: 1 }] });
		expect(await getSolanaClaimedMessage(SOLANA_MAINNET, 'claim')).toBeNull();
	});

	it('still finds it in a legacy claim, as the kit sent them before', async () => {
		solanaServesClaims();
		solanaHasCctpLookupTable();
		const { transaction } = await buildSolanaReceiveTransaction(
			SOLANA_MAINNET,
			payer,
			message,
			new Uint8Array(130).fill(0x2c),
		);
		const legacy = new Transaction({
			feePayer: payer,
			blockhash: transaction.message.recentBlockhash,
			lastValidBlockHeight: 1,
		}).add(instructionsOf(transaction)[1]!);
		onChain({ message: legacy.compileMessage() });
		// A legacy message hands its instruction data back as a Buffer.
		const found = await getSolanaClaimedMessage(SOLANA_MAINNET, 'claim');
		expect(found && Uint8Array.from(found)).toEqual(message);
	});
});
