// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { atom } from 'nanostores';
import { describe, expect, it, vi } from 'vitest';
import { createCctpKit } from '../../src/core/index.js';
import { runTransfer } from '../../src/core/transfer.js';
import type { AnyDAppKit, TransferRecord } from '../../src/core/types.js';
import { IrisClient } from '../../src/iris/client.js';
import { createInMemoryStorage } from '../../src/utils/storage.js';
import type { WalletAdapters } from '../../src/wallets/types.js';

const SUI_ADDRESS = '0x' + 'ab'.repeat(32);
const EVM_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const ATTESTED = {
	// 148-byte header + 228-byte burn body: the minimum a real v2 message carries.
	message: '0x' + 'aa'.repeat(376),
	attestation: '0x' + 'bb'.repeat(130),
	eventNonce: '0x' + '11'.repeat(32),
	cctpVersion: 2,
	status: 'complete',
	decodedMessage: {
		sourceDomain: '8',
		destinationDomain: '1',
		nonce: '0x' + '11'.repeat(32),
		sender: '0x' + '22'.repeat(32),
		recipient: '0x' + '33'.repeat(32),
		destinationCaller: '0x' + '00'.repeat(32),
		minFinalityThreshold: '2000',
		finalityThresholdExecuted: '2000',
		messageBody: '0x',
		decodedMessageBody: {
			burnToken: '0x' + '44'.repeat(32),
			mintRecipient: EVM_ADDRESS,
			amount: '1000000',
			messageSender: SUI_ADDRESS,
			maxFee: '0',
		},
	},
};

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

/** Iris stand-in: fee quotes refused (like Sui today), messages attested unless `pendingFirst`. */
function irisFetch(options: { pendingFirst?: number } = {}) {
	let pendingLeft = options.pendingFirst ?? 0;
	return vi.fn<typeof fetch>(async (input) => {
		const url = String(input);
		if (url.includes('/v2/burn/USDC/fees/')) {
			return json(400, { error: 'Invalid source/destination domain id' });
		}
		if (url.includes('/v2/messages/')) {
			if (pendingLeft > 0) {
				pendingLeft--;
				return json(200, {
					messages: [
						{ ...ATTESTED, status: 'pending_confirmations', attestation: 'PENDING', message: '0x' },
					],
				});
			}
			return json(200, { messages: [ATTESTED] });
		}
		return json(404, { error: 'unexpected' });
	});
}

function mockDAppKit(network: 'mainnet' | 'testnet' = 'mainnet', balance = '5000000000') {
	const $connection = atom<{ account: { address: string } | null }>({
		account: { address: SUI_ADDRESS },
	});
	const $currentNetwork = atom<string>(network);
	const client = {
		core: {
			getBalance: vi.fn(async () => ({ balance: { balance } })),
			waitForTransaction: vi.fn(async () => ({})),
		},
	};
	const signAndExecuteTransaction = vi.fn(async () => ({
		$kind: 'Transaction',
		Transaction: { digest: 'C1v6NwPuxdXmaag9Wjcnq4TX65fh5QQj5nDVaSGeM39M' },
	}));
	const getClient = vi.fn(() => client);
	return {
		dAppKit: {
			stores: { $connection, $currentNetwork },
			getClient,
			signAndExecuteTransaction,
		} as unknown as AnyDAppKit,
		$connection,
		$currentNetwork,
		client,
		signAndExecuteTransaction,
		getClient,
	};
}

const noWallets = (): Promise<WalletAdapters> =>
	Promise.reject(new Error('no non-Sui wallets in tests'));

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('createCctpKit', () => {
	it('blocks the form until the quote matches the typed amount (stale quotes never burn)', async () => {
		const { dAppKit } = mockDAppKit();
		const kit = createCctpKit({
			dAppKit,
			network: 'mainnet',
			direction: 'outflow',
			defaults: { to: 'avalanche' },
			storage: null,
			iris: { fetch: irisFetch() },
			wallets: { evm: fakeEvmAdapter(), solana: fakeSolanaAdapter() },
		});
		await flush();
		kit.setRecipient(EVM_ADDRESS);
		kit.setAmount('1000');
		expect(kit.validate()).toBe('Fetching quote…');
		await kit.refreshQuote();
		await flush();
		// Typed amount now 10, but the only quote is for 1000: the form must not be submittable.
		kit.setAmount('10');
		expect(kit.stores.$quote.get()).toBeNull();
		expect(kit.validate()).toBe('Fetching quote…');
		await expect(kit.transfer()).rejects.toThrow('Fetching quote…');
		await kit.refreshQuote();
		expect(kit.stores.$quote.get()?.amount).toBe(10_000_000n);
		expect(kit.validate()).toBeNull();
		kit.destroy();
	});

	it('refuses to work when dapp-kit is on another Sui network', async () => {
		const { dAppKit } = mockDAppKit('testnet');
		const kit = createCctpKit({
			dAppKit,
			network: 'mainnet',
			direction: 'outflow',
			storage: null,
			iris: { fetch: irisFetch() },
			wallets: { evm: fakeEvmAdapter(), solana: fakeSolanaAdapter() },
		});
		kit.setRecipient(EVM_ADDRESS);
		kit.setAmount('1');
		await kit.refreshQuote();
		expect(kit.validate()).toBe('Switch your Sui wallet to mainnet');
		kit.destroy();
	});

	it('reads the Sui balance on the kit network, not the current dapp-kit network', async () => {
		const mock = mockDAppKit('mainnet');
		const kit = createCctpKit({
			dAppKit: mock.dAppKit,
			network: 'mainnet',
			direction: 'outflow',
			storage: null,
			iris: { fetch: irisFetch() },
			wallets: { evm: fakeEvmAdapter(), solana: fakeSolanaAdapter() },
		});
		await flush();
		expect(mock.getClient).toHaveBeenCalledWith('mainnet');
		expect(kit.stores.$balance.get().source).toBe(5_000_000_000n);
		kit.destroy();
	});

	it('rejects truncated Sui recipients and only allows fast when the host permits standard fallback', async () => {
		const { dAppKit } = mockDAppKit();
		const kit = createCctpKit({
			dAppKit,
			network: 'mainnet',
			direction: 'inflow',
			defaults: { from: 'ethereum' },
			storage: null,
			iris: { fetch: irisFetch() },
			transferSpeed: { allow: ['fast'] },
			wallets: { evm: fakeEvmAdapter(EVM_ADDRESS), solana: fakeSolanaAdapter() },
		});
		await flush();
		kit.setRecipient('0xdeadbeef');
		kit.setAmount('1');
		await kit.refreshQuote();
		// Fast-only host on a route Circle will not quote: surfaced as the blocking reason.
		expect(kit.stores.$quoteError.get()).toMatch(/Fast Transfer/);
		expect(kit.validate()).toMatch(/Invalid Sui address|Fast Transfer/);
		kit.setRecipient(SUI_ADDRESS);
		expect(kit.validate()).toMatch(/Fast Transfer/);
		kit.destroy();
	});

	it('shares storage between kits without clobbering and never double-runs a transfer', async () => {
		const storage = createInMemoryStorage();
		const a = createCctpKit({
			dAppKit: mockDAppKit().dAppKit,
			network: 'mainnet',
			storage,
			iris: { fetch: irisFetch() },
			wallets: { evm: fakeEvmAdapter(), solana: fakeSolanaAdapter() },
		});
		const imported = await a.importTransfer({
			txHash: 'C1v6NwPuxdXmaag9Wjcnq4TX65fh5QQj5nDVaSGeM39M',
		});
		expect(imported.status).toBe('readyToMint');
		expect(imported.to).toBe('avalanche');

		const b = createCctpKit({
			dAppKit: mockDAppKit().dAppKit,
			network: 'mainnet',
			storage,
			iris: { fetch: irisFetch() },
			wallets: { evm: fakeEvmAdapter(), solana: fakeSolanaAdapter() },
		});
		expect(b.stores.$transfers.get().map((t) => t.id)).toEqual([imported.id]);
		expect(b.isRunning(imported.id)).toBe(false);

		b.dismiss(imported.id);
		expect(
			(JSON.parse(storage.getItem('mysten-cctp-kit:transfers:mainnet')!) as TransferRecord[])[0]!
				.hidden,
		).toBe(true);
		b.remove(imported.id);
		expect(JSON.parse(storage.getItem('mysten-cctp-kit:transfers:mainnet')!)).toEqual([]);
		// A later write from kit A must not resurrect what B dismissed.
		const second = await a.importTransfer({
			txHash: 'DN2qGSAZRRrfaeqD7KJgYVUEuqWYd9yCfQuDaiWiBQqV',
		});
		const stored = JSON.parse(
			storage.getItem('mysten-cctp-kit:transfers:mainnet')!,
		) as TransferRecord[];
		expect(stored.map((t) => t.id)).toEqual([second.id]);
		a.destroy();
		b.destroy();
	});
});

describe('runTransfer (Sui source)', () => {
	it('burns on the kit network, persists the digest immediately, polls Iris and stops at readyToMint', async () => {
		const mock = mockDAppKit();
		const fetchMock = irisFetch({ pendingFirst: 1 });
		const iris = new IrisClient('mainnet', { fetch: fetchMock });
		const chains = createCctpKit({
			dAppKit: mock.dAppKit,
			network: 'mainnet',
			storage: null,
			iris: { fetch: fetchMock },
			wallets: { evm: fakeEvmAdapter(), solana: fakeSolanaAdapter() },
		}).chains;
		const updates: TransferRecord[] = [];
		const record: TransferRecord = {
			id: 't1',
			network: 'mainnet',
			from: 'sui',
			to: 'avalanche',
			amount: '1000000',
			maxFee: '0',
			speed: 'standard',
			sender: SUI_ADDRESS,
			recipient: EVM_ADDRESS,
			status: 'pending',
			createdAt: 1,
			updatedAt: 1,
		};
		const result = await runTransfer(record, {
			dAppKit: mock.dAppKit,
			wallets: noWallets,
			iris,
			chains,
			stopAfterAttestation: true,
			checkNonce: false,
			pollIntervalMs: 1,
			onUpdate: (t) => updates.push(t),
		});
		expect(result.status).toBe('readyToMint');
		expect(result.sourceTxHash).toBe('C1v6NwPuxdXmaag9Wjcnq4TX65fh5QQj5nDVaSGeM39M');
		expect(result.message).toBe(ATTESTED.message);
		expect(result.attestation).toBe(ATTESTED.attestation);
		expect(result.attestingSince).toBeTypeOf('number');
		// Signed on the record's network and waited on that network's client.
		expect(mock.signAndExecuteTransaction).toHaveBeenCalledTimes(1);
		expect(mock.signAndExecuteTransaction).toHaveBeenCalledWith(
			expect.objectContaining({ network: 'mainnet' }),
		);
		expect(mock.getClient).toHaveBeenCalledWith('mainnet');
		// The digest was persisted before the confirmation wait finished.
		const digestIndex = updates.findIndex((u) => u.sourceTxHash);
		expect(updates[digestIndex]!.status).toBe('burning');
		expect(updates.map((u) => u.status)).toEqual([
			'burning',
			'burning',
			'attesting',
			'readyToMint',
		]);
		// Iris was polled while pending, then returned the attestation.
		expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('/v2/messages/')).length).toBe(
			2,
		);
	});
});

function fakeEvmAdapter(address?: string) {
	return {
		ecosystem: 'evm' as const,
		getAccount: () => (address ? { address } : null),
		subscribe: () => () => undefined,
		connect: async () => undefined,
		disconnect: async () => undefined,
		getWalletClient: async () => {
			throw new Error('not in tests');
		},
	};
}

function fakeSolanaAdapter() {
	return {
		ecosystem: 'solana' as const,
		getAccount: () => null,
		subscribe: () => () => undefined,
		connect: async () => undefined,
		disconnect: async () => undefined,
		signAndSendTransaction: async () => {
			throw new Error('not in tests');
		},
	};
}

describe('archive, restore, remove', () => {
	it('tracks a transfer from a block explorer link, and keeps the bare hash', async () => {
		const storage = createInMemoryStorage();
		const kit = createCctpKit({
			dAppKit: mockDAppKit().dAppKit,
			network: 'mainnet',
			storage,
			iris: { fetch: irisFetch() },
			wallets: { evm: fakeEvmAdapter(), solana: fakeSolanaAdapter() },
		});
		const digest = 'C1v6NwPuxdXmaag9Wjcnq4TX65fh5QQj5nDVaSGeM39M';
		const t = await kit.importTransfer({ txHash: `https://suiscan.xyz/mainnet/tx/${digest}` });
		expect(t).toMatchObject({ from: 'sui', sourceTxHash: digest });
		// Pasting the hash itself afterwards finds the same transfer, not a second one.
		expect((await kit.importTransfer({ txHash: digest })).id).toBe(t.id);
		expect(kit.stores.$transfers.get()).toHaveLength(1);
		kit.destroy();
	});

	it('dismiss hides but keeps the record; restore and remove behave as named', async () => {
		const storage = createInMemoryStorage();
		const kit = createCctpKit({
			dAppKit: mockDAppKit().dAppKit,
			network: 'mainnet',
			storage,
			iris: { fetch: irisFetch() },
			wallets: { evm: fakeEvmAdapter(), solana: fakeSolanaAdapter() },
		});
		const t = await kit.importTransfer({ txHash: 'C1v6NwPuxdXmaag9Wjcnq4TX65fh5QQj5nDVaSGeM39M' });
		const stored = () =>
			JSON.parse(storage.getItem('mysten-cctp-kit:transfers:mainnet')!) as TransferRecord[];

		kit.dismiss(t.id);
		expect(stored()).toHaveLength(1);
		expect(stored()[0]!.hidden).toBe(true);
		expect(kit.stores.$transfers.get()[0]!.hidden).toBe(true);

		kit.restore(t.id);
		expect(stored()[0]!.hidden).toBe(false);

		kit.remove(t.id);
		expect(stored()).toEqual([]);
		kit.destroy();
	});
});

describe('history follows the connected wallets', () => {
	const OTHER_SUI = '0x' + 'cd'.repeat(32);
	const OTHER_EVM = '0x1111111111111111111111111111111111111111';
	const record = (over: Partial<TransferRecord>): TransferRecord => ({
		id: 'x',
		network: 'mainnet',
		from: 'ethereum',
		to: 'sui',
		amount: '1000000',
		maxFee: '0',
		speed: 'standard',
		sender: OTHER_EVM,
		recipient: OTHER_SUI,
		status: 'complete',
		createdAt: 1,
		updatedAt: 1,
		...over,
	});
	const seeded = () => {
		const storage = createInMemoryStorage();
		storage.setItem(
			'mysten-cctp-kit:transfers:mainnet',
			JSON.stringify([
				record({ id: 'mine-received', recipient: SUI_ADDRESS }),
				// Same Sui address in another casing: hex addresses compare case-insensitively.
				record({
					id: 'mine-sent',
					from: 'sui',
					to: 'ethereum',
					sender: '0x' + 'AB'.repeat(32),
					recipient: OTHER_EVM,
				}),
				record({ id: 'theirs-done' }),
				record({
					id: 'strangers',
					sender: '0x2222222222222222222222222222222222222222',
					recipient: '0x' + 'ef'.repeat(32),
				}),
				record({
					id: 'theirs-waiting',
					status: 'readyToMint',
					sourceTxHash: '0x' + 'ab'.repeat(32),
					message: ATTESTED.message,
					attestation: ATTESTED.attestation,
				}),
			]),
		);
		return storage;
	};
	const ids = (kit: ReturnType<typeof createCctpKit>) =>
		kit.stores.$history
			.get()
			.map((t) => t.id)
			.sort();

	it('lists a finished transfer only for a wallet that sent or received it, and keeps unfinished ones', async () => {
		const mock = mockDAppKit();
		const kit = createCctpKit({
			dAppKit: mock.dAppKit,
			network: 'mainnet',
			storage: seeded(),
			iris: { fetch: irisFetch() },
			wallets: { evm: fakeEvmAdapter(), solana: fakeSolanaAdapter() },
		});
		await flush();
		expect(ids(kit)).toEqual(['mine-received', 'mine-sent', 'theirs-waiting']);
		// Nothing is deleted: the other wallets' finished transfers are still in storage.
		expect(kit.stores.$transfers.get()).toHaveLength(5);

		// With no wallet connected only the transfer that still needs a claim is listed.
		mock.$connection.set({ account: null });
		await flush();
		expect(ids(kit)).toEqual(['theirs-waiting']);

		// Reconnecting brings the wallet's own history back.
		mock.$connection.set({ account: { address: SUI_ADDRESS } });
		await flush();
		expect(ids(kit)).toEqual(['mine-received', 'mine-sent', 'theirs-waiting']);
		kit.destroy();
	});

	it('counts the connected EVM wallet too, whatever the address casing', async () => {
		const mock = mockDAppKit();
		mock.$connection.set({ account: null });
		const kit = createCctpKit({
			dAppKit: mock.dAppKit,
			network: 'mainnet',
			storage: seeded(),
			iris: { fetch: irisFetch() },
			// The records store this address in lower case; the wallet reports it checksummed-ish.
			wallets: {
				evm: fakeEvmAdapter(OTHER_EVM.toUpperCase().replace('0X', '0x')),
				solana: fakeSolanaAdapter(),
			},
		});
		await flush();
		// OTHER_EVM sent 'mine-received' and 'theirs-done' and received 'mine-sent'; it has no
		// part in 'strangers'.
		expect(ids(kit)).toEqual(['mine-received', 'mine-sent', 'theirs-done', 'theirs-waiting']);
		kit.destroy();
	});

	it('keeps a transfer that was looked up by hash listed for the session', async () => {
		const mock = mockDAppKit();
		const kit = createCctpKit({
			dAppKit: mock.dAppKit,
			network: 'mainnet',
			storage: seeded(),
			iris: { fetch: irisFetch() },
			wallets: { evm: fakeEvmAdapter(), solana: fakeSolanaAdapter() },
		});
		await flush();
		expect(ids(kit)).not.toContain('theirs-done');
		kit.stores.$trackedTransferIds.set(new Set(['theirs-done']));
		expect(ids(kit)).toContain('theirs-done');

		const imported = await kit.importTransfer({
			txHash: 'C1v6NwPuxdXmaag9Wjcnq4TX65fh5QQj5nDVaSGeM39M',
		});
		expect(kit.stores.$trackedTransferIds.get().has(imported.id)).toBe(true);
		kit.destroy();
	});
});

describe('auto-resume after a failed wait', () => {
	it('picks a failed-while-attesting record back up on load', async () => {
		const storage = createInMemoryStorage();
		const record: TransferRecord = {
			id: 'old-timeout',
			network: 'mainnet',
			from: 'sui',
			to: 'avalanche',
			amount: '1',
			maxFee: '0',
			speed: 'standard',
			sender: SUI_ADDRESS,
			recipient: EVM_ADDRESS,
			status: 'failed',
			error: 'Timed out waiting for attestation of C1v6…',
			sourceTxHash: 'C1v6NwPuxdXmaag9Wjcnq4TX65fh5QQj5nDVaSGeM39M',
			createdAt: 1,
			updatedAt: 2,
		};
		storage.setItem('mysten-cctp-kit:transfers:mainnet', JSON.stringify([record]));
		const kit = createCctpKit({
			dAppKit: mockDAppKit().dAppKit,
			network: 'mainnet',
			storage,
			iris: { fetch: irisFetch() },
			wallets: { evm: fakeEvmAdapter(), solana: fakeSolanaAdapter() },
		});
		await new Promise((r) => setTimeout(r, 50));
		const updated = kit.stores.$transfers.get()[0]!;
		expect(updated.status).toBe('readyToMint');
		expect(updated.error).toBeUndefined();
		kit.destroy();
	});
});
