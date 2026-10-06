// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

// An EVM burn the user speeds up or cancels in the wallet. The kit's real receipt wait and the
// installed viem run against a scripted JSON-RPC endpoint.

import { atom } from 'nanostores';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getChainRegistry } from '../../src/chains/index.js';
import { runTransfer } from '../../src/core/transfer.js';
import type { AnyDAppKit, TransferRecord } from '../../src/core/types.js';
import { IrisClient } from '../../src/iris/client.js';
import type { WalletAdapters } from '../../src/wallets/types.js';

const chains = getChainRegistry('mainnet');
const ethereum = chains.find((c) => c.key === 'ethereum')!;
const SUI_ADDRESS = `0x${'cd'.repeat(32)}`;
const OWNER = '0x1111111111111111111111111111111111111111';
const H1 = `0x${'a1'.repeat(32)}`; // the hash the wallet returned
const H2 = `0x${'b2'.repeat(32)}`; // what was mined in its place
const BLOCK_HASH = `0x${'cc'.repeat(32)}`;
const BURN_INPUT = '0x8e0250ee';

function pendingBurn() {
	return {
		hash: H1,
		nonce: '0x7',
		blockHash: null,
		blockNumber: null,
		transactionIndex: null,
		from: OWNER,
		to: ethereum.ecosystem === 'evm' ? ethereum.tokenMessengerV2 : '',
		value: '0x0',
		gas: '0x30d40',
		maxFeePerGas: '0x3b9aca00',
		maxPriorityFeePerGas: '0x1',
		input: BURN_INPUT,
		type: '0x2',
		chainId: '0x1',
		accessList: [],
		v: '0x0',
		r: '0x1',
		s: '0x1',
	};
}

/** A JSON-RPC endpoint where H1 stays pending and block 0x10 holds its replacement H2. */
function scriptedRpc(replacement: Record<string, unknown>) {
	const methods: string[] = [];
	const mined = {
		...pendingBurn(),
		...replacement,
		hash: H2,
		blockHash: BLOCK_HASH,
		blockNumber: '0x10',
		transactionIndex: '0x0',
	};
	const answer = (method: string, params: unknown[]): unknown => {
		switch (method) {
			case 'eth_chainId':
				return '0x1';
			case 'eth_call':
				return `0x${'0'.repeat(56)}ffffffff`; // balanceOf / allowance: plenty
			case 'eth_blockNumber':
				return '0x10';
			case 'eth_getTransactionByHash':
				return params[0] === H1 ? pendingBurn() : mined;
			case 'eth_getTransactionReceipt':
				if (params[0] === H1) return null;
				return {
					transactionHash: H2,
					transactionIndex: '0x0',
					blockHash: BLOCK_HASH,
					blockNumber: '0x10',
					from: OWNER,
					to: mined.to,
					cumulativeGasUsed: '0x5208',
					gasUsed: '0x5208',
					effectiveGasPrice: '0x1',
					contractAddress: null,
					logs: [],
					logsBloom: `0x${'0'.repeat(512)}`,
					status: '0x1',
					type: '0x2',
				};
			case 'eth_getBlockByNumber':
				return {
					number: '0x10',
					hash: BLOCK_HASH,
					parentHash: `0x${'dd'.repeat(32)}`,
					timestamp: '0x65000000',
					gasLimit: '0x1c9c380',
					gasUsed: '0x5208',
					baseFeePerGas: '0x1',
					transactions: [mined],
					uncles: [],
				};
			default:
				throw new Error(`unscripted method ${method}`);
		}
	};
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
			const body = JSON.parse(String(init?.body)) as {
				id: number;
				method: string;
				params: unknown[];
			};
			methods.push(
				`${body.method}${body.method.includes('Transaction') ? `(${String(body.params[0]).slice(0, 6)})` : ''}`,
			);
			return new Response(
				JSON.stringify({ jsonrpc: '2.0', id: body.id, result: answer(body.method, body.params) }),
				{
					status: 200,
					headers: { 'content-type': 'application/json' },
				},
			);
		}),
	);
	return methods;
}

const dAppKit = {
	stores: {
		$connection: atom({ account: { address: SUI_ADDRESS } }),
		$currentNetwork: atom('mainnet'),
	},
	getClient: () => ({ core: {} }),
} as unknown as AnyDAppKit;

function wallets(writeContract: () => Promise<string>): () => Promise<WalletAdapters> {
	return async () =>
		({
			evm: { getWalletClient: async () => ({ account: { address: OWNER }, writeContract }) },
			solana: {},
		}) as unknown as WalletAdapters;
}

const record = (): TransferRecord => ({
	id: 't',
	network: 'mainnet',
	from: 'ethereum',
	to: 'sui',
	amount: '1000000',
	maxFee: '200',
	speed: 'fast',
	sender: OWNER,
	recipient: SUI_ADDRESS,
	status: 'pending',
	createdAt: 1,
	updatedAt: 1,
});

async function drive(replacement: Record<string, unknown>) {
	scriptedRpc(replacement);
	const asked: string[] = [];
	const iris = new IrisClient('mainnet', {
		fetch: async (input) => {
			asked.push(new URL(String(input)).searchParams.get('transactionHash') ?? '');
			return new Response(
				JSON.stringify({
					messages: [
						{
							status: 'complete',
							message: `0x${'aa'.repeat(376)}`,
							attestation: `0x${'bb'.repeat(65)}`,
						},
					],
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			);
		},
	});
	const updates: TransferRecord[] = [];
	const writeContract = vi.fn(async () => H1);
	const outcome = await runTransfer(record(), {
		dAppKit,
		wallets: wallets(writeContract),
		iris,
		chains,
		stopAfterAttestation: true,
		pollIntervalMs: 1,
		onUpdate: (t) => updates.push(t),
	}).catch((error: Error) => error);
	return { outcome, asked, updates, writeContract };
}

afterEach(() => vi.unstubAllGlobals());

describe('an EVM burn that is replaced in the wallet', () => {
	it('sped up: follows the burn to the hash it was mined under', async () => {
		const { outcome, asked, updates, writeContract } = await drive({ maxFeePerGas: '0x77359400' });
		expect(outcome).not.toBeInstanceOf(Error);
		expect(writeContract).toHaveBeenCalledTimes(1);
		// Circle only knows the hash that was mined; the one the wallet first returned never was.
		expect(updates.at(-1)).toMatchObject({ status: 'readyToMint', sourceTxHash: H2 });
		expect(asked).toEqual([H2]);
	}, 30_000);

	it('cancelled: nothing was burned, so the transfer can be tried again', async () => {
		const { outcome, asked, updates } = await drive({ to: OWNER, input: '0x', value: '0x0' });
		expect(outcome).toBeInstanceOf(Error);
		expect((outcome as Error).message).toMatch(/was cancelled in the wallet/);
		expect(updates.at(-1)!.status).toBe('failed');
		expect(updates.at(-1)!.sourceTxHash).toBeUndefined();
		expect(asked).toEqual([]);
	}, 30_000);
});
