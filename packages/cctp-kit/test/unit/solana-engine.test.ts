// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { SOLANA_MAINNET } from '../../src/chains/solana.js';
import {
	buildSolanaBurnTransaction,
	buildSolanaReceiveTransaction,
	buildSolanaTokenAccountTransaction,
	getAssociatedTokenAddress,
	getSolanaUsdcBalance,
} from '../../src/engine/solana.js';
import { MESSAGE_V2 } from '../../src/utils/bytes.js';

const owner = Keypair.generate().publicKey;

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

		// The claim itself never carries the create instruction: with it the transaction would
		// be larger than Solana accepts.
		const claim = await buildSolanaReceiveTransaction(
			SOLANA_MAINNET,
			owner,
			message,
			new Uint8Array(65),
		);
		expect(claim.transaction.instructions).toHaveLength(1);
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

		const { transaction } = await buildSolanaReceiveTransaction(
			SOLANA_MAINNET,
			payer,
			message,
			attestation,
		);
		// Only the claim: a missing token account is created by its own transaction first.
		expect(transaction.instructions).toHaveLength(1);
		const ix = transaction.instructions[0]!;
		expect(ix.programId.toBase58()).toBe(SOLANA_MAINNET.messageTransmitterV2);
		expect(ix.keys).toHaveLength(20);
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
