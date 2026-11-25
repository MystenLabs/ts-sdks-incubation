// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';
import { getChainRegistry } from '../../src/chains/index.js';
import type { ChainDefinition } from '../../src/chains/types.js';
import { deriveDepositAddress } from '../../src/deposit/address.js';
import { DEPOSIT_CONTRACTS, minimumDeposit } from '../../src/deposit/contracts.js';
import { requestDepositProcess, watchDepositAddress } from '../../src/deposit/watcher.js';
import type {
	DepositProcessAnswer,
	DepositState,
	DepositWatcherDeps,
} from '../../src/deposit/watcher.js';

const testnet = getChainRegistry('testnet');
const chain = (key: string) => testnet.find((c) => c.key === key) as ChainDefinition;
const base = { chain: chain('base'), contract: DEPOSIT_CONTRACTS.testnet.base! };
const solana = { chain: chain('solana'), contract: DEPOSIT_CONTRACTS.testnet.solana! };

// The same vectors the claimer's src/deposit/deposit.test.ts pins, generated from the contracts'
// own TypeScript (cctpv2-claimer deposit-addresses/src) on 2026-11-25.
const SUI = `0x${'ab'.repeat(32)}`;

describe('deposit addresses', () => {
	it('match the contracts on EVM, with and without a recovery address', () => {
		expect(
			deriveDepositAddress({
				...base,
				recipient: SUI,
				owner: '0x1111111111111111111111111111111111111111',
			}).address,
		).toBe('0x5022fddafed03fCBC80636Ea9fc26a1b1Fc0cF21');
		expect(deriveDepositAddress({ ...base, recipient: SUI }).address).toBe(
			'0x47482f8c8C5ea531a3E8FDFb19202CE847c9180f',
		);
	});

	it('match the program on Solana, with and without a recovery address', () => {
		expect(
			deriveDepositAddress({
				...solana,
				recipient: SUI,
				owner: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
			}),
		).toEqual({
			address: '7zqKSmxjC1K1nP1tVScWKiGYjj8QHFgUkcBmqB81BisX',
			tokenAccount: '2kRbMerxwQeqMMBX31su9kBwbeHF97wVFUcak84NFsRu',
			owner: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
		});
		expect(deriveDepositAddress({ ...solana, recipient: SUI })).toEqual({
			address: '9u93HhCNFmB2Asi5LfkZvHQEz6oCYr4C4KmaXkeTiav6',
			tokenAccount: '2HnXic72c9U5abWUuz4xveAog2GXpjLxNc38D7HjE5p9',
			owner: null,
		});
	});

	it('treat the Sui address case-insensitively', () => {
		expect(
			deriveDepositAddress({ ...base, recipient: SUI.toUpperCase().replace('0X', '0x') }).address,
		).toBe('0x47482f8c8C5ea531a3E8FDFb19202CE847c9180f');
	});

	it('refuse what is not an address', () => {
		expect(() => deriveDepositAddress({ ...base, recipient: '0x12' })).toThrow(/full Sui address/);
		expect(() => deriveDepositAddress({ ...base, recipient: SUI, owner: 'nope' })).toThrow(
			/recovery address/,
		);
		expect(() => deriveDepositAddress({ ...solana, recipient: SUI, owner: '0x11' })).toThrow(
			/recovery address/,
		);
	});

	it('need the keeper fee plus enough to land 0.1 USDC under the fee cap', () => {
		expect(minimumDeposit(base.contract)).toBe(200_051n);
	});
});

const DEPOSIT = '0x47482f8c8C5ea531a3E8FDFb19202CE847c9180f';
const EMPTY: DepositProcessAnswer = { status: 'empty', depositAddress: DEPOSIT };

function harness(
	balances: bigint[],
	answers: DepositProcessAnswer[],
	options: { trackFailures?: number } = {},
) {
	const controller = new AbortController();
	const states: DepositState[] = [];
	const tracked: string[] = [];
	let trackFailures = options.trackFailures ?? 0;
	const processed = vi.fn(async (_incoming: unknown) => answers.shift() ?? EMPTY);
	const deps: DepositWatcherDeps = {
		readBalance: async () => {
			const next = balances.shift();
			if (next === undefined) {
				controller.abort();
				throw new Error('done');
			}
			return next;
		},
		findIncoming: async () => ({ txHash: '0xfund' }),
		process: processed,
		track: async (burn) => {
			if (trackFailures-- > 0) throw new Error('Circle has not decoded this transfer yet');
			tracked.push(burn);
		},
		update: (state) => states.push(state),
		sleep: async (_ms, signal) => {
			if (signal.aborted) throw new Error('aborted');
		},
	};
	const initial: DepositState = {
		address: DEPOSIT,
		owner: null,
		from: 'base',
		recipient: SUI,
		phase: 'waiting',
		balance: null,
		minimum: 200_051n,
		keeperFee: 100_000n,
		incoming: null,
		burns: [],
	};
	return {
		run: () => watchDepositAddress(initial, deps, controller.signal),
		states,
		tracked,
		processed,
		last: () => states.at(-1)!,
	};
}

describe('watchDepositAddress', () => {
	it('checks the service once at the start, then processes a deposit and tracks the burn', async () => {
		const h = harness(
			[0n, 0n, 1_000_000n],
			[EMPTY, { status: 'processed', depositAddress: DEPOSIT, burnTx: '0xburn' }],
		);
		await h.run();
		expect(h.processed.mock.calls).toEqual([[null], [{ txHash: '0xfund' }]]);
		expect(h.tracked).toEqual(['0xburn']);
		expect(h.last().burns).toEqual(['0xburn']);
		expect(h.last().phase).toBe('waiting');
	});

	it('stops before any funds arrive when the service derives another address', async () => {
		const h = harness(
			[0n, 0n],
			[{ status: 'empty', depositAddress: '0x0000000000000000000000000000000000000001' }],
		);
		await h.run();
		expect(h.last().phase).toBe('mismatch');
		expect(h.processed).toHaveBeenCalledTimes(1);
	});

	it('waits for more below the minimum', async () => {
		const h = harness(
			[150_000n, 150_000n],
			[{ status: 'ineligible', reason: 'below_minimum', depositAddress: DEPOSIT }],
		);
		await h.run();
		expect(h.processed).toHaveBeenCalledTimes(1);
		expect(h.last().phase).toBe('belowMinimum');
	});

	it('finds a burn whose answer was lost: blocked, then the deposit reads empty', async () => {
		const h = harness(
			[1_000_000n, 0n, 0n],
			[
				{ status: 'blocked', reason: 'timeout', depositAddress: DEPOSIT },
				{ status: 'empty', depositAddress: DEPOSIT, lastBurnTx: '0xburn' },
			],
		);
		await h.run();
		expect(h.states.some((s) => s.phase === 'unavailable')).toBe(true);
		expect(h.tracked).toEqual(['0xburn']);
		expect(h.processed).toHaveBeenCalledTimes(2);
	});

	it('tracks a burn the same once, however often the service names it', async () => {
		const h = harness(
			[1_000_000n, 1_000_000n],
			[
				{ status: 'empty', depositAddress: DEPOSIT, lastBurnTx: '0xburn' },
				{ status: 'empty', depositAddress: DEPOSIT, lastBurnTx: '0xburn' },
			],
		);
		await h.run();
		expect(h.tracked).toEqual(['0xburn']);
	});

	it('hands a burn to the kit again until it takes it', async () => {
		const h = harness(
			[1_000_000n, 0n, 0n, 0n],
			[{ status: 'processed', depositAddress: DEPOSIT, burnTx: '0xburn' }],
			{ trackFailures: 2 },
		);
		await h.run();
		expect(h.tracked).toEqual(['0xburn']);
		expect(h.last().burns).toEqual(['0xburn']);
	});

	it('says the service is unavailable, and asks again', async () => {
		const h = harness(
			[1_000_000n, 1_000_000n],
			[
				{ status: 'blocked', reason: 'low_gas', depositAddress: DEPOSIT },
				{ status: 'processed', depositAddress: DEPOSIT, burnTx: '0xburn' },
			],
		);
		await h.run();
		expect(h.states.some((s) => s.phase === 'unavailable' && s.error === 'low_gas')).toBe(true);
		expect(h.tracked).toEqual(['0xburn']);
	});
});

describe('requestDepositProcess', () => {
	it('posts a simple request and returns the answer', async () => {
		const fetch = vi.fn(async () =>
			Response.json({ status: 'processed', burnTx: '0xburn' }, { status: 200 }),
		);
		const answer = await requestDepositProcess({
			baseUrl: 'https://claimer.example',
			fetch: fetch as unknown as typeof globalThis.fetch,
			chain: 'base',
			recipient: SUI,
			owner: null,
			txHash: '0xfund',
		});
		expect(answer).toEqual({ status: 'processed', burnTx: '0xburn' });
		const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
		expect(String(url)).toBe('https://claimer.example/api/deposit/process');
		expect((init.headers as Record<string, string>)['content-type']).toMatch(/^text\/plain/);
		expect(JSON.parse(init.body as string)).toEqual({ chain: 'base', sui: SUI, txHash: '0xfund' });
	});

	it('turns a failed request into a blocked answer', async () => {
		const answer = await requestDepositProcess({
			baseUrl: 'https://claimer.example',
			fetch: (async () => {
				throw new TypeError('Failed to fetch');
			}) as unknown as typeof globalThis.fetch,
			chain: 'base',
			recipient: SUI,
			owner: null,
		});
		expect(answer.status).toBe('blocked');
	});
});
