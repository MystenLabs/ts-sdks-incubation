// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Connection } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { SOLANA_MAINNET } from '../../src/chains/solana.js';
import {
	hasSolanaTransactionSucceeded,
	waitForSolanaConfirmation,
} from '../../src/engine/solana.js';
import { TransactionRevertedError } from '../../src/utils/errors.js';

const SIGNATURE = '5'.repeat(88);
const quickly = { pollIntervalMs: 1, timeoutMs: 150 };
/** With the chain at block 1000 when the wait starts, 1000 + 150 + 150 is the last block that could carry it. */
const SENT_AT = 1_000;
const LAST_POSSIBLE = 1_300;

type Level = 'processed' | 'confirmed' | 'finalized';
const seen = (confirmationStatus: Level, err: unknown = null) => ({
	slot: 1,
	confirmations: null,
	err: err as never,
	confirmationStatus,
});
type Answer = { value: ReturnType<typeof seen> | null; nodeSlot?: number } | Error;

/** The chain when the wait starts, and how far the finalized chain has got since. */
function chainIs(chain: { sentAt: number | Error; finalized: number; finalizedSlot?: number }) {
	vi.spyOn(Connection.prototype, 'getEpochInfo').mockImplementation(async (commitment) => {
		const finalized = commitment === 'finalized';
		if (!finalized && chain.sentAt instanceof Error) throw chain.sentAt;
		return {
			absoluteSlot: finalized ? (chain.finalizedSlot ?? 9_000) : 9_500,
			blockHeight: finalized ? chain.finalized : (chain.sentAt as number),
			epoch: 1,
			slotIndex: 1,
			slotsInEpoch: 432_000,
		};
	});
}

/** One answer per lookup; the last one repeats. */
function lookupsAnswer(...answers: Answer[]) {
	let call = 0;
	return vi.spyOn(Connection.prototype, 'getSignatureStatuses').mockImplementation(async () => {
		const answer = answers[Math.min(call++, answers.length - 1)]!;
		if (answer instanceof Error) throw answer;
		return { context: { slot: answer.nodeSlot ?? 10_000 }, value: [answer.value] };
	});
}

const wait = () => waitForSolanaConfirmation(SOLANA_MAINNET, SIGNATURE, quickly);

describe('waiting for a Solana transaction', () => {
	it('returns once the transaction is confirmed', async () => {
		chainIs({ sentAt: SENT_AT, finalized: SENT_AT });
		const lookups = lookupsAnswer(
			{ value: null },
			{ value: seen('processed') },
			{ value: seen('confirmed') },
		);
		await expect(wait()).resolves.toBeUndefined();
		expect(lookups).toHaveBeenCalledTimes(3);
	});

	it('reports a transaction that is on chain with an error', async () => {
		chainIs({ sentAt: SENT_AT, finalized: SENT_AT });
		lookupsAnswer({ value: seen('confirmed', { InstructionError: [0, { Custom: 1 }] }) });
		await expect(wait()).rejects.toBeInstanceOf(TransactionRevertedError);
	});

	it('does not write off a transaction that is not visible yet', async () => {
		// Just after it is sent no node knows it. That is not proof of anything, however late
		// the blockhash this kit asked for may be: the wallet may have used another.
		chainIs({ sentAt: SENT_AT, finalized: LAST_POSSIBLE });
		lookupsAnswer({ value: null }, { value: null }, { value: null }, { value: seen('confirmed') });
		await expect(wait()).resolves.toBeUndefined();
	});

	it('writes it off once the finalized chain is past the last block that could carry it', async () => {
		chainIs({ sentAt: SENT_AT, finalized: LAST_POSSIBLE + 1, finalizedSlot: 9_000 });
		lookupsAnswer({ value: null, nodeSlot: 9_000 });
		const outcome = wait();
		await expect(outcome).rejects.toBeInstanceOf(TransactionRevertedError);
		await expect(outcome).rejects.toThrow(/expired before it was included/);
	});

	it('finds a transaction that landed just before the chain passed that block', async () => {
		chainIs({ sentAt: SENT_AT, finalized: LAST_POSSIBLE + 1 });
		// Unknown on the first lookup, there on the one made to confirm the write-off.
		lookupsAnswer({ value: null }, { value: seen('finalized') });
		await expect(wait()).resolves.toBeUndefined();
	});

	it('does not believe "unknown" from a node that is behind the finalized chain', async () => {
		chainIs({ sentAt: SENT_AT, finalized: LAST_POSSIBLE + 1, finalizedSlot: 9_000 });
		lookupsAnswer({ value: null, nodeSlot: 8_999 });
		const outcome = wait();
		await expect(outcome).rejects.toThrow(/not confirmed in time/);
		await expect(outcome).rejects.not.toBeInstanceOf(TransactionRevertedError);
	});

	it('does not write it off when the lookups fail', async () => {
		chainIs({ sentAt: SENT_AT, finalized: LAST_POSSIBLE + 10_000 });
		lookupsAnswer(new Error('node says no'));
		const outcome = wait();
		await expect(outcome).rejects.toThrow(/not confirmed in time/);
		await expect(outcome).rejects.not.toBeInstanceOf(TransactionRevertedError);
	});

	it('says nothing about expiry while the block height cannot be read', async () => {
		chainIs({ sentAt: new Error('node says no'), finalized: LAST_POSSIBLE + 10_000 });
		lookupsAnswer({ value: null });
		const outcome = wait();
		await expect(outcome).rejects.toThrow(/not confirmed in time/);
		await expect(outcome).rejects.not.toBeInstanceOf(TransactionRevertedError);
	});

	it('stops when it is aborted', async () => {
		chainIs({ sentAt: SENT_AT, finalized: SENT_AT });
		lookupsAnswer({ value: null });
		const controller = new AbortController();
		const outcome = waitForSolanaConfirmation(SOLANA_MAINNET, SIGNATURE, {
			pollIntervalMs: 20,
			signal: controller.signal,
		});
		controller.abort(new Error('stopped'));
		await expect(outcome).rejects.toThrow('stopped');
	});
});

describe('looking up an earlier Solana transaction', () => {
	it('tells success from failure from not knowing', async () => {
		lookupsAnswer({ value: seen('finalized') });
		expect(await hasSolanaTransactionSucceeded(SOLANA_MAINNET, SIGNATURE)).toBe(true);
		lookupsAnswer({ value: seen('finalized', { InstructionError: [0, { Custom: 1 }] }) });
		expect(await hasSolanaTransactionSucceeded(SOLANA_MAINNET, SIGNATURE)).toBe(false);
		lookupsAnswer({ value: null });
		expect(await hasSolanaTransactionSucceeded(SOLANA_MAINNET, SIGNATURE)).toBe(false);
		lookupsAnswer(new Error('node says no'));
		expect(await hasSolanaTransactionSucceeded(SOLANA_MAINNET, SIGNATURE)).toBeNull();
	});
});

describe('the block height reading the expiry test rests on', () => {
	it('is taken on a later pass when the first attempt fails', async () => {
		// The bound from a later reading is later, never earlier, so it is still safe.
		let reads = 0;
		vi.spyOn(Connection.prototype, 'getEpochInfo').mockImplementation(async (commitment) => {
			if (commitment !== 'finalized' && ++reads === 1) throw new Error('node says no');
			return {
				absoluteSlot: 9_000,
				blockHeight: commitment === 'finalized' ? LAST_POSSIBLE + 1 : SENT_AT,
				epoch: 1,
				slotIndex: 1,
				slotsInEpoch: 432_000,
			};
		});
		lookupsAnswer({ value: null, nodeSlot: 9_000 });
		await expect(wait()).rejects.toThrow(/expired before it was included/);
		expect(reads).toBe(2);
	});
});
