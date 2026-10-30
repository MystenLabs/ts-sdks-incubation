// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { atom } from 'nanostores';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCctpKit } from '../../src/core/index.js';
import { runTransfer } from '../../src/core/transfer.js';
import type { AnyDAppKit, TransferRecord } from '../../src/core/types.js';
import * as evm from '../../src/engine/evm.js';
import { IrisClient } from '../../src/iris/client.js';
import { createInMemoryStorage } from '../../src/utils/storage.js';
import type { WalletAdapters } from '../../src/wallets/types.js';

// These tests reach no chain: not to ask when a burn happened, whether a claim was made on an
// EVM chain, or what a typed Solana address is.
vi.mock('../../src/engine/evm.js', async (original) => ({
	...(await original<typeof import('../../src/engine/evm.js')>()),
	getEvmTransactionTime: vi.fn(async () => 1),
	evmIsNonceUsed: vi.fn(async () => false),
}));
vi.mock('../../src/engine/solana.js', async (original) => ({
	...(await original<typeof import('../../src/engine/solana.js')>()),
	describeSolanaAccount: vi.fn(async () => ({ kind: 'wallet' })),
}));

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

describe("claim: 'manual'", () => {
	it('stops at Claim after the burn, and on resume', async () => {
		const kit = createCctpKit({
			dAppKit: mockDAppKit().dAppKit,
			network: 'mainnet',
			claim: 'manual',
			defaults: { from: 'sui', to: 'avalanche', amount: '1' },
			storage: createInMemoryStorage(),
			iris: { fetch: irisFetch() },
			wallets: { evm: fakeEvmAdapter(EVM_ADDRESS), solana: fakeSolanaAdapter() },
		});
		await kit.wallets();
		await Promise.all([kit.refreshBalance(), kit.refreshQuote()]);
		// The fake EVM wallet cannot claim, so an attempt would reject.
		const stopped = await kit.transfer();
		expect(stopped.status).toBe('readyToMint');
		expect((await kit.resume(stopped.id)).status).toBe('readyToMint');
		kit.destroy();
	});

	it('claim() rejects a transfer Circle has not attested, without burning', async () => {
		const mock = mockDAppKit();
		const unburned: TransferRecord = {
			id: 'never-burned',
			network: 'mainnet',
			from: 'sui',
			to: 'avalanche',
			amount: '1000000',
			maxFee: '0',
			speed: 'standard',
			sender: SUI_ADDRESS,
			recipient: EVM_ADDRESS,
			status: 'failed',
			createdAt: 1,
			updatedAt: 1,
		};
		const storage = createInMemoryStorage();
		storage.setItem('mysten-cctp-kit:transfers:mainnet', JSON.stringify([unburned]));
		const kit = createCctpKit({
			dAppKit: mock.dAppKit,
			network: 'mainnet',
			storage,
			iris: { fetch: irisFetch() },
			wallets: { evm: fakeEvmAdapter(), solana: fakeSolanaAdapter() },
		});
		await expect(kit.claim(unburned.id)).rejects.toThrow('nothing to claim');
		expect(mock.signAndExecuteTransaction).not.toHaveBeenCalled();
		kit.destroy();
	});
});

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

describe('a sponsor', () => {
	const BASE_URL = 'https://claimer.example';
	const SERVICE_DIGEST = '5sNhJ1QkBXPyZ7pWqtTbvNfmT2pQk4cZkVjRwGnYdE9x';
	const KEY = 'mysten-cctp-kit:transfers:mainnet';
	const HEALTHY = { ok: true, dryRun: false };
	const DENYLIST = { sourceDomains: [{ domain: 10, name: 'Unichain' }] };
	const refused = () => json(422, { status: 'ineligible', reason: 'below_minimum' });
	const waiting = (over: Partial<TransferRecord> = {}): TransferRecord => ({
		id: 'waiting',
		network: 'mainnet',
		from: 'ethereum',
		to: 'sui',
		amount: '1000000',
		maxFee: '0',
		speed: 'standard',
		sender: EVM_ADDRESS,
		recipient: SUI_ADDRESS,
		status: 'readyToMint',
		sourceTxHash: '0x' + 'ab'.repeat(32),
		sourceConfirmed: true,
		burnedAt: 1,
		message: ATTESTED.message,
		attestation: ATTESTED.attestation,
		createdAt: 1,
		updatedAt: 1,
		...over,
	});
	const nonceIs = (used: boolean) => async () => ({
		commandResults: [{ returnValues: [{ bcs: new Uint8Array([used ? 1 : 0]) }] }],
	});

	type Answer = () => Response | Promise<Response>;

	/** The service, answering `/api/claim` with `claim`. */
	function service(claim: Answer = refused, over: { health?: Answer; denylist?: Answer } = {}) {
		const sponsorFetch = vi.fn<typeof fetch>(async (input) => {
			const url = String(input);
			if (url.endsWith('/api/health')) return over.health?.() ?? json(200, HEALTHY);
			if (url.endsWith('/api/denylist')) return over.denylist?.() ?? json(200, DENYLIST);
			return claim();
		});
		const calls = (path: string) =>
			sponsorFetch.mock.calls.filter(([url]) => String(url).endsWith(path));
		return { sponsorFetch, calls, posts: () => calls('/api/claim') };
	}

	/** A kit created over stored records, with a chain that says the nonce is `used`. */
	function load(
		records: TransferRecord[],
		options: {
			sponsorFetch?: typeof fetch;
			baseUrl?: string;
			used?: () => Promise<unknown>;
			storage?: ReturnType<typeof createInMemoryStorage>;
			onEvent?: (event: { type: string }) => void;
			iris?: typeof fetch;
		} = {},
	) {
		const storage = options.storage ?? createInMemoryStorage();
		storage.setItem(KEY, JSON.stringify(records));
		const mock = mockDAppKit();
		const simulateTransaction = vi.fn(options.used ?? nonceIs(false));
		Object.assign(mock.client.core, { simulateTransaction });
		const kit = createCctpKit({
			dAppKit: mock.dAppKit,
			network: 'mainnet',
			storage,
			iris: { fetch: options.iris ?? irisFetch() },
			wallets: { evm: fakeEvmAdapter(), solana: fakeSolanaAdapter() },
			sponsor: options.sponsorFetch
				? { baseUrl: options.baseUrl ?? BASE_URL, fetch: options.sponsorFetch }
				: undefined,
			onEvent: options.onEvent,
		});
		return { kit, mock, storage, simulateTransaction };
	}
	const stored = (kit: ReturnType<typeof createCctpKit>, id = 'waiting') =>
		kit.stores.$transfers.get().find((t) => t.id === id)!;

	describe('when the page loads', () => {
		it('is sent a stored transfer that waits at Claim, and finishes it', async () => {
			const { sponsorFetch, posts } = service(() =>
				json(200, { status: 'claimed', digest: SERVICE_DIGEST }),
			);
			let reads = 0;
			const events: string[] = [];
			const { kit, mock } = load([waiting()], {
				sponsorFetch,
				used: () => nonceIs(++reads > 1)(),
				onEvent: (event) => events.push(event.type),
			});
			await vi.waitFor(() => expect(stored(kit).status).toBe('complete'));
			expect(posts()).toHaveLength(1);
			const [url, init] = posts()[0]!;
			expect(url).toBe(`${BASE_URL}/api/claim`);
			expect(JSON.parse(init!.body as string)).toEqual({
				message: ATTESTED.message,
				attestation: ATTESTED.attestation,
			});
			expect(stored(kit).destinationTxHash).toBe(SERVICE_DIGEST);
			expect(mock.signAndExecuteTransaction).not.toHaveBeenCalled();
			await flush();
			// `settleClaimed` kept off it: one completion, and nothing written after it.
			expect(events.filter((type) => type === 'transfer:complete')).toHaveLength(1);
			kit.destroy();
		});

		it('leaves the transfer at Claim when it gives up, with no wallet', async () => {
			const { sponsorFetch, posts } = service();
			const { kit, mock } = load([waiting()], { sponsorFetch });
			await vi.waitFor(() => expect(kit.isRunning('waiting')).toBe(false));
			expect(posts()).toHaveLength(1);
			expect(stored(kit)).toMatchObject({ status: 'readyToMint', sponsorClaim: 'unavailable' });
			expect(mock.signAndExecuteTransaction).not.toHaveBeenCalled();
			kit.destroy();
		});

		it('is not asked for anything with no sponsor, or an empty baseUrl', async () => {
			const globalFetch = vi.spyOn(globalThis, 'fetch');
			const empty = vi.fn<typeof fetch>();
			for (const options of [{}, { sponsorFetch: empty, baseUrl: '' }]) {
				const { kit, mock } = load([waiting()], options);
				await flush();
				await flush();
				expect(stored(kit).status).toBe('readyToMint');
				expect(kit.isRunning('waiting')).toBe(false);
				expect(mock.signAndExecuteTransaction).not.toHaveBeenCalled();
				expect(kit.stores.$sponsor.get()).toBeNull();
				kit.destroy();
			}
			expect(empty).not.toHaveBeenCalled();
			// Not "no fetch at all": earlier tests can still be retrying their RPC reads through it.
			expect(globalFetch.mock.calls.filter(([url]) => /\/api\//.test(String(url)))).toEqual([]);
		});

		it('tries once more for a transfer left at minting or failed, or marked unavailable', async () => {
			const { sponsorFetch, posts } = service();
			const { kit } = load(
				[
					waiting({ id: 'interrupted', status: 'minting', sponsorClaim: 'pending' }),
					waiting({ id: 'rejected', status: 'failed', error: 'The request was rejected' }),
					waiting({ id: 'gave-up', sponsorClaim: 'unavailable' }),
				],
				{ sponsorFetch },
			);
			await vi.waitFor(() => expect(posts()).toHaveLength(3));
			await vi.waitFor(() => expect(stored(kit, 'rejected').status).toBe('readyToMint'));
			await vi.waitFor(() => expect(kit.isRunning('rejected')).toBe(false));
			expect(stored(kit, 'interrupted').status).toBe('readyToMint');
			expect(stored(kit, 'rejected').error).toBeUndefined();
			kit.destroy();
		});

		it('is not sent what has nothing to claim, goes elsewhere, or was dismissed', async () => {
			const { sponsorFetch, posts } = service();
			const { kit } = load(
				[
					waiting({ id: 'done', status: 'complete' }),
					waiting({ id: 'claimed', destinationTxHash: SERVICE_DIGEST }),
					waiting({ id: 'dismissed', hidden: true }),
					waiting({
						id: 'to-evm',
						from: 'sui',
						to: 'avalanche',
						sender: SUI_ADDRESS,
						recipient: EVM_ADDRESS,
						sourceTxHash: 'C1v6NwPuxdXmaag9Wjcnq4TX65fh5QQj5nDVaSGeM39M',
					}),
				],
				{ sponsorFetch },
			);
			await flush();
			await flush();
			expect(posts()).toHaveLength(0);
			kit.destroy();
		});

		it('does not stop the kit from loading over a message it cannot read', async () => {
			const { sponsorFetch, posts } = service();
			const { kit } = load([waiting({ message: '0x1234' })], { sponsorFetch });
			await vi.waitFor(() => expect(kit.isRunning('waiting')).toBe(false));
			expect(posts()).toHaveLength(0);
			expect(stored(kit).status).toBe('readyToMint');
			kit.destroy();
		});

		it('leaves alone a transfer another tab is driving', async () => {
			const { sponsorFetch, posts } = service();
			const storage = createInMemoryStorage();
			storage.setItem(
				`${KEY}:running:waiting`,
				JSON.stringify({ owner: 'another-tab', until: Date.now() + 60_000 }),
			);
			const { kit } = load([waiting()], { sponsorFetch, storage });
			await flush();
			await flush();
			expect(posts()).toHaveLength(0);
			kit.destroy();
		});

		it('does not run a transfer another kit on the page is driving', async () => {
			const { sponsorFetch, posts } = service(() => new Promise(() => undefined));
			const storage = createInMemoryStorage();
			const first = load([waiting()], { sponsorFetch, storage });
			await vi.waitFor(() => expect(posts()).toHaveLength(1));
			const second = load([waiting()], { sponsorFetch, storage });
			await flush();
			expect(posts()).toHaveLength(1);
			first.kit.destroy();
			second.kit.destroy();
		});

		it('does not fall through to the wallet when the kit is torn down', async () => {
			const { sponsorFetch, posts } = service(() => new Promise(() => undefined));
			const { kit, mock } = load([waiting()], { sponsorFetch });
			await vi.waitFor(() => expect(posts()).toHaveLength(1));
			kit.destroy();
			await flush();
			expect(mock.signAndExecuteTransaction).not.toHaveBeenCalled();
			expect(stored(kit)).toMatchObject({ status: 'minting', sponsorClaim: 'pending' });
		});

		it('picks them up on pageshow too, but leaves a route it knows is denied alone', async () => {
			const window = new EventTarget();
			vi.stubGlobal('window', window);
			try {
				const { sponsorFetch, posts } = service();
				const { kit, storage } = load([], { sponsorFetch });
				await vi.waitFor(() => expect(kit.stores.$sponsor.get()).not.toBeNull());
				const denied = waiting({
					id: 'denied',
					from: 'unichain',
					status: 'failed',
					error: 'The request was rejected in the wallet.',
				});
				storage.setItem(KEY, JSON.stringify([waiting(), denied]));
				window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
				await vi.waitFor(() => expect(posts()).toHaveLength(1));
				await vi.waitFor(() => expect(kit.isRunning('waiting')).toBe(false));
				expect(kit.isRunning('denied')).toBe(false);
				expect(stored(kit, 'denied')).toMatchObject({
					status: 'failed',
					error: 'The request was rejected in the wallet.',
				});
				expect(stored(kit, 'denied').sponsorClaim).toBeUndefined();
				kit.destroy();
			} finally {
				vi.unstubAllGlobals();
			}
		});

		it('is sent a transfer into Sui that is tracked by hash, already attested', async () => {
			const { sponsorFetch, posts } = service();
			const toSui = {
				...ATTESTED,
				decodedMessage: {
					...ATTESTED.decodedMessage,
					sourceDomain: '0',
					destinationDomain: '8',
					decodedMessageBody: {
						...ATTESTED.decodedMessage.decodedMessageBody,
						mintRecipient: SUI_ADDRESS,
						messageSender: `0x${'0'.repeat(24)}${EVM_ADDRESS.slice(2)}`,
					},
				},
			};
			const { kit, mock } = load([], {
				sponsorFetch,
				iris: vi.fn<typeof fetch>(async (input) =>
					String(input).includes('/fees/')
						? json(400, { error: 'no' })
						: json(200, { messages: [toSui] }),
				),
			});
			await kit.importTransfer({ txHash: `0x${'cd'.repeat(32)}`, sourceChain: 'ethereum' });
			await vi.waitFor(() => expect(posts()).toHaveLength(1));
			await vi.waitFor(() =>
				expect(kit.stores.$transfers.get()[0]).toMatchObject({
					to: 'sui',
					status: 'readyToMint',
					sponsorClaim: 'unavailable',
				}),
			);
			expect(mock.signAndExecuteTransaction).not.toHaveBeenCalled();
			kit.destroy();
		});
	});

	describe('warnings', () => {
		const NO_GAS = 'Your Sui wallet holds no SUI. You will need some to claim the USDC on Sui.';
		const TYPED =
			'USDC does not arrive on Sui by itself. After the burn, it has to be claimed on Sui from a wallet that holds SUI.';
		const inflow = (
			options: {
				sponsorFetch?: typeof fetch;
				from?: 'ethereum' | 'unichain';
				typed?: boolean;
			} = {},
		) => {
			const mock = mockDAppKit('mainnet', '0');
			if (options.typed) mock.$connection.set({ account: null });
			const kit = createCctpKit({
				dAppKit: mock.dAppKit,
				network: 'mainnet',
				direction: 'inflow',
				defaults: { from: options.from ?? 'ethereum' },
				storage: null,
				iris: { fetch: irisFetch() },
				wallets: { evm: fakeEvmAdapter(), solana: fakeSolanaAdapter() },
				sponsor: options.sponsorFetch
					? { baseUrl: BASE_URL, fetch: options.sponsorFetch }
					: undefined,
			});
			if (options.typed) kit.setRecipient(SUI_ADDRESS);
			return kit;
		};
		const answered = (kit: ReturnType<typeof createCctpKit>) =>
			vi.waitFor(() => expect(kit.stores.$sponsor.get()).not.toBeNull());
		const gasRead = (kit: ReturnType<typeof createCctpKit>) =>
			vi.waitFor(() => expect(kit.stores.$destination.get().gas).toBe(0n));

		it('are hidden only when the sponsor serves the route', async () => {
			const kit = inflow({ sponsorFetch: service().sponsorFetch });
			await answered(kit);
			await gasRead(kit);
			expect(kit.warnings()).toEqual([]);
			kit.destroy();
		});

		it('are hidden for a typed recipient too', async () => {
			const kit = inflow({ sponsorFetch: service().sponsorFetch, typed: true });
			await answered(kit);
			expect(kit.warnings()).toEqual([]);
			kit.destroy();
		});

		it('show with no sponsor', async () => {
			const kit = inflow();
			await gasRead(kit);
			expect(kit.warnings()).toEqual([NO_GAS]);
			kit.destroy();
			const typed = inflow({ typed: true });
			expect(typed.warnings()).toEqual([TYPED]);
			typed.destroy();
		});

		it('show for a denied source', async () => {
			const kit = inflow({ sponsorFetch: service().sponsorFetch, from: 'unichain' });
			await answered(kit);
			await gasRead(kit);
			expect(kit.warnings()).toEqual([NO_GAS]);
			kit.destroy();
		});

		it.each<[string, Answer]>([
			['answers 503', () => json(503, { ok: false, error: 'gas' })],
			['is unreachable', () => Promise.reject(new TypeError('Failed to fetch'))],
			['is in dry-run mode', () => json(200, { ok: true, dryRun: true })],
		])('show when health %s', async (_name, health) => {
			const kit = inflow({ sponsorFetch: service(refused, { health }).sponsorFetch });
			await answered(kit);
			await gasRead(kit);
			expect(kit.warnings()).toEqual([NO_GAS]);
			kit.destroy();
		});

		it('show when the denylist cannot be read', async () => {
			const kit = inflow({
				sponsorFetch: service(refused, {
					denylist: () => Promise.reject(new TypeError('Failed to fetch')),
				}).sponsorFetch,
			});
			await answered(kit);
			await gasRead(kit);
			expect(kit.warnings()).toEqual([NO_GAS]);
			kit.destroy();
		});

		it('show while the status is not known yet, and go when it arrives', async () => {
			let answer: (response: Response) => void = () => undefined;
			const { sponsorFetch } = service(refused, {
				health: () => new Promise((resolve) => (answer = resolve)),
			});
			const kit = inflow({ sponsorFetch });
			await gasRead(kit);
			expect(kit.stores.$sponsor.get()).toBeNull();
			expect(kit.warnings()).toEqual([NO_GAS]);
			const render = vi.fn();
			const stop = kit.stores.$sponsor.listen(render);
			answer(json(200, HEALTHY));
			await answered(kit);
			// The store is what makes the form draw again, as `$destination` does for the gas.
			expect(render).toHaveBeenCalledTimes(1);
			expect(kit.warnings()).toEqual([]);
			stop();
			kit.destroy();
		});

		it('follows the source as the form changes', async () => {
			const kit = inflow({ sponsorFetch: service().sponsorFetch });
			await answered(kit);
			await gasRead(kit);
			kit.setFromChain('unichain');
			expect(kit.warnings()).toEqual([NO_GAS]);
			kit.setFromChain('ethereum');
			expect(kit.warnings()).toEqual([]);
			kit.destroy();
		});

		it('leave EVM and Solana destinations as they are', () => {
			const outflow = (to: 'avalanche' | 'solana') => {
				const kit = createCctpKit({
					dAppKit: mockDAppKit().dAppKit,
					network: 'mainnet',
					direction: 'outflow',
					defaults: { to },
					storage: null,
					iris: { fetch: irisFetch() },
					wallets: { evm: fakeEvmAdapter(), solana: fakeSolanaAdapter() },
					sponsor: { baseUrl: BASE_URL, fetch: service().sponsorFetch },
				});
				kit.setRecipient(to === 'solana' ? '11111111111111111111111111111111' : EVM_ADDRESS);
				return kit;
			};
			const evm = outflow('avalanche');
			const solana = outflow('solana');
			expect(evm.warnings()).toEqual([
				'USDC does not arrive on Avalanche by itself. After the burn, it has to be claimed on Avalanche from a wallet that holds AVAX.',
			]);
			expect(solana.warnings()).toEqual([
				'USDC does not arrive on Solana by itself. After the burn, it has to be claimed on Solana from a wallet that holds SOL.',
			]);
			evm.destroy();
			solana.destroy();
		});
	});

	describe('status', () => {
		afterEach(() => vi.useRealTimers());

		it('is read once when the kit is created', async () => {
			const { sponsorFetch, calls } = service();
			const { kit } = load([waiting()], { sponsorFetch });
			await vi.waitFor(() => expect(kit.isRunning('waiting')).toBe(false));
			// The form and the run that started with the kit asked at the same moment.
			expect(calls('/api/health')).toHaveLength(1);
			expect(calls('/api/denylist')).toHaveLength(1);
			kit.destroy();
		});

		it('is read again when the form changes and what is held has gone stale', async () => {
			vi.useFakeTimers();
			const { sponsorFetch, calls } = service();
			const { kit } = load([], { sponsorFetch });
			await vi.advanceTimersByTimeAsync(59_000);
			kit.setAmount('1');
			await vi.advanceTimersByTimeAsync(0);
			expect(calls('/api/health')).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(2_000);
			kit.setAmount('2');
			await vi.advanceTimersByTimeAsync(0);
			expect(calls('/api/health')).toHaveLength(2);
			kit.destroy();
		});
	});
});

describe('transfers into Sui finished somewhere else', () => {
	const KEY = 'mysten-cctp-kit:transfers:mainnet';
	const waiting = (over: Partial<TransferRecord> = {}): TransferRecord => ({
		id: 'waiting',
		network: 'mainnet',
		from: 'ethereum',
		to: 'sui',
		amount: '1000000',
		maxFee: '0',
		speed: 'standard',
		sender: EVM_ADDRESS,
		recipient: SUI_ADDRESS,
		status: 'readyToMint',
		sourceTxHash: '0x' + 'ab'.repeat(32),
		sourceConfirmed: true,
		burnedAt: 1,
		message: ATTESTED.message,
		attestation: ATTESTED.attestation,
		createdAt: 1,
		updatedAt: 1,
		...over,
	});

	/** A page that can be shown, hidden and focused. */
	function page(visibilityState: 'visible' | 'hidden' = 'visible') {
		const document = Object.assign(new EventTarget(), { visibilityState });
		const window = new EventTarget();
		vi.stubGlobal('document', document);
		vi.stubGlobal('window', window);
		return {
			document,
			window,
			show(state: 'visible' | 'hidden') {
				document.visibilityState = state;
				document.dispatchEvent(new Event('visibilitychange'));
			},
			focus: () => window.dispatchEvent(new Event('focus')),
		};
	}

	/** A kit over stored records, on a chain whose answer the test can change. */
	function load(records: TransferRecord[], storage = createInMemoryStorage()) {
		storage.setItem(KEY, JSON.stringify(records));
		const chain = { used: false };
		const mock = mockDAppKit();
		const simulateTransaction = vi.fn(async () => ({
			commandResults: [{ returnValues: [{ bcs: new Uint8Array([chain.used ? 1 : 0]) }] }],
		}));
		Object.assign(mock.client.core, { simulateTransaction });
		const events: { type: string; transfer?: TransferRecord }[] = [];
		const kit = createCctpKit({
			dAppKit: mock.dAppKit,
			network: 'mainnet',
			storage,
			iris: { fetch: irisFetch() },
			wallets: { evm: fakeEvmAdapter(), solana: fakeSolanaAdapter() },
			onEvent: (event) => events.push(event),
		});
		const completions = () => events.filter((event) => event.type === 'transfer:complete');
		return { kit, mock, chain, simulateTransaction, completions };
	}
	const status = (kit: ReturnType<typeof createCctpKit>, id = 'waiting') =>
		kit.stores.$transfers.get().find((t) => t.id === id)?.status;

	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('are noticed within one interval while the page is visible', async () => {
		page();
		const { kit, chain, completions } = load([waiting()]);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(status(kit)).toBe('readyToMint');

		chain.used = true;
		await vi.advanceTimersByTimeAsync(15_000);
		expect(status(kit)).toBe('complete');
		expect(kit.stores.$transfers.get()[0]!.completedAt).toBeTypeOf('number');
		expect(completions()).toHaveLength(1);
		expect(completions()[0]!.transfer).toMatchObject({ id: 'waiting', status: 'complete' });
		kit.destroy();
	});

	it('clears an error, and a "pending" left behind, when one is noticed', async () => {
		const view = page();
		const { kit, chain } = load([
			waiting({ status: 'failed', error: 'Rejected.', sponsorClaim: 'pending' }),
		]);
		await vi.advanceTimersByTimeAsync(1_000);
		chain.used = true;
		view.focus();
		await vi.advanceTimersByTimeAsync(0);
		expect(kit.stores.$transfers.get()[0]).toMatchObject({ status: 'complete' });
		expect(kit.stores.$transfers.get()[0]!.error).toBeUndefined();
		expect(kit.stores.$transfers.get()[0]!.sponsorClaim).toBeUndefined();
		kit.destroy();
	});

	it('are not looked for while the page is hidden', async () => {
		page('hidden');
		const { kit, chain, simulateTransaction } = load([waiting()]);
		await vi.advanceTimersByTimeAsync(1_000);
		const atLoad = simulateTransaction.mock.calls.length;
		chain.used = true;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(simulateTransaction).toHaveBeenCalledTimes(atLoad);
		expect(status(kit)).toBe('readyToMint');
		kit.destroy();
	});

	it('are looked for at once when the page becomes visible', async () => {
		const view = page('hidden');
		const { kit, chain } = load([waiting()]);
		await vi.advanceTimersByTimeAsync(1_000);
		chain.used = true;
		view.show('visible');
		await vi.advanceTimersByTimeAsync(0);
		expect(status(kit)).toBe('complete');
		kit.destroy();
	});

	it('are looked for at once when the window gains focus', async () => {
		const view = page();
		const { kit, chain } = load([waiting()]);
		await vi.advanceTimersByTimeAsync(1_000);
		chain.used = true;
		view.focus();
		await vi.advanceTimersByTimeAsync(0);
		expect(status(kit)).toBe('complete');
		kit.destroy();
	});

	it('are not looked for when the page is hidden again', async () => {
		const view = page();
		const { kit, simulateTransaction } = load([waiting()]);
		await vi.advanceTimersByTimeAsync(1_000);
		const atLoad = simulateTransaction.mock.calls.length;
		view.show('hidden');
		await vi.advanceTimersByTimeAsync(0);
		expect(simulateTransaction).toHaveBeenCalledTimes(atLoad);
		kit.destroy();
	});

	it('skips a transfer this page is driving', async () => {
		page();
		const { kit, mock, chain, simulateTransaction } = load([waiting()]);
		await vi.advanceTimersByTimeAsync(1_000);
		// The wallet's prompt is open and unanswered.
		let answer: (value: never) => void = () => undefined;
		mock.signAndExecuteTransaction.mockImplementationOnce(
			() => new Promise((resolve) => (answer = resolve)),
		);
		const run = kit.resume('waiting').catch(() => undefined);
		await vi.advanceTimersByTimeAsync(0);
		expect(kit.isRunning('waiting')).toBe(true);
		chain.used = true;
		const before = simulateTransaction.mock.calls.length;
		await vi.advanceTimersByTimeAsync(45_000);
		expect(simulateTransaction).toHaveBeenCalledTimes(before);
		expect(status(kit)).toBe('minting');
		answer({ $kind: 'Transaction', Transaction: { digest: 'digest' } } as never);
		await run;
		kit.destroy();
	});

	it('skips a transfer another tab is driving, until its claim lapses', async () => {
		page();
		const storage = createInMemoryStorage();
		storage.setItem(
			`${KEY}:running:waiting`,
			JSON.stringify({ owner: 'another-tab', until: Date.now() + 40_000 }),
		);
		const { kit, chain, simulateTransaction } = load([waiting({ status: 'minting' })], storage);
		chain.used = true;
		await vi.advanceTimersByTimeAsync(31_000);
		expect(simulateTransaction).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(status(kit)).toBe('complete');
		kit.destroy();
	});

	it('picks up a transfer left at minting by a page that is gone', async () => {
		// With a run in place to move it to Claim, the record has to be written after the load.
		page();
		const storage = createInMemoryStorage();
		const { kit, chain } = load([], storage);
		await vi.advanceTimersByTimeAsync(1_000);
		storage.setItem(KEY, JSON.stringify([waiting({ status: 'minting' })]));
		chain.used = true;
		await vi.advanceTimersByTimeAsync(15_000);
		expect(status(kit)).toBe('complete');
		kit.destroy();
	});

	it('leaves alone what has no claim to look for, and what does not go to Sui', async () => {
		page();
		const { kit, chain, simulateTransaction } = load([
			waiting({ id: 'dismissed', hidden: true }),
			waiting({ id: 'not-attested', status: 'pending', attestation: undefined }),
			waiting({ id: 'with-digest', destinationTxHash: 'digest' }),
			waiting({ id: 'done', status: 'complete' }),
			waiting({
				id: 'to-evm',
				from: 'sui',
				to: 'avalanche',
				sender: SUI_ADDRESS,
				recipient: EVM_ADDRESS,
				sourceTxHash: 'C1v6NwPuxdXmaag9Wjcnq4TX65fh5QQj5nDVaSGeM39M',
			}),
		]);
		await vi.advanceTimersByTimeAsync(1_000);
		simulateTransaction.mockClear();
		chain.used = true;
		await vi.advanceTimersByTimeAsync(30_000);
		expect(simulateTransaction).not.toHaveBeenCalled();
		expect(status(kit, 'dismissed')).toBe('readyToMint');
		kit.destroy();
	});

	it('runs one pass at a time', async () => {
		const view = page();
		const { kit, simulateTransaction } = load([waiting()]);
		await vi.advanceTimersByTimeAsync(1_000);
		simulateTransaction.mockClear();
		simulateTransaction.mockImplementation(() => new Promise(() => undefined));
		view.focus();
		await vi.advanceTimersByTimeAsync(0);
		view.focus();
		view.show('visible');
		await vi.advanceTimersByTimeAsync(0);
		expect(simulateTransaction).toHaveBeenCalledTimes(1);
		kit.destroy();
	});

	it('is not stopped for good by a read that never answers', async () => {
		const view = page();
		const { kit, chain, simulateTransaction } = load([waiting()]);
		await vi.advanceTimersByTimeAsync(1_000);
		simulateTransaction.mockImplementationOnce(() => new Promise(() => undefined));
		view.focus();
		await vi.advanceTimersByTimeAsync(8_000);
		chain.used = true;
		await vi.advanceTimersByTimeAsync(15_000);
		expect(status(kit)).toBe('complete');
		kit.destroy();
	});

	it('stops with the kit: no timer, no listeners', async () => {
		const view = page();
		const interval = vi.spyOn(globalThis, 'setInterval');
		const cleared = vi.spyOn(globalThis, 'clearInterval');
		const visibility = vi.spyOn(view.document, 'removeEventListener');
		const focus = vi.spyOn(view.window, 'removeEventListener');
		const { kit, chain, simulateTransaction } = load([waiting()]);
		await vi.advanceTimersByTimeAsync(1_000);
		const at = interval.mock.calls.findIndex(([, ms]) => ms === 15_000);
		kit.destroy();
		expect(cleared).toHaveBeenCalledWith(interval.mock.results[at]!.value);
		expect(visibility).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
		expect(focus).toHaveBeenCalledWith('focus', expect.any(Function));
		simulateTransaction.mockClear();
		chain.used = true;
		view.focus();
		view.show('visible');
		await vi.advanceTimersByTimeAsync(30_000);
		expect(simulateTransaction).not.toHaveBeenCalled();
	});

	it('does not start in a place with no page to look at', async () => {
		const { kit, simulateTransaction } = load([waiting()]);
		await vi.advanceTimersByTimeAsync(1_000);
		simulateTransaction.mockClear();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(simulateTransaction).not.toHaveBeenCalled();
		kit.destroy();
	});

	it('still looks at every destination once when the page loads', async () => {
		vi.mocked(evm.evmIsNonceUsed).mockClear();
		page();
		const { kit, simulateTransaction } = load([
			waiting(),
			waiting({
				id: 'to-evm',
				from: 'sui',
				to: 'avalanche',
				sender: SUI_ADDRESS,
				recipient: EVM_ADDRESS,
				sourceTxHash: 'C1v6NwPuxdXmaag9Wjcnq4TX65fh5QQj5nDVaSGeM39M',
			}),
		]);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(simulateTransaction).toHaveBeenCalledTimes(1);
		expect(evm.evmIsNonceUsed).toHaveBeenCalledTimes(1);
		// After that only Sui is looked at.
		await vi.advanceTimersByTimeAsync(15_000);
		expect(simulateTransaction).toHaveBeenCalledTimes(2);
		expect(evm.evmIsNonceUsed).toHaveBeenCalledTimes(1);
		kit.destroy();
	});

	it('tells the host about one found when the page loads, as it does for any other', async () => {
		page();
		const storage = createInMemoryStorage();
		storage.setItem(KEY, JSON.stringify([waiting()]));
		const onEvent = vi.fn();
		const mock = mockDAppKit();
		Object.assign(mock.client.core, {
			simulateTransaction: async () => ({
				commandResults: [{ returnValues: [{ bcs: new Uint8Array([1]) }] }],
			}),
		});
		const kit = createCctpKit({
			dAppKit: mock.dAppKit,
			network: 'mainnet',
			storage,
			iris: { fetch: irisFetch() },
			wallets: { evm: fakeEvmAdapter(), solana: fakeSolanaAdapter() },
			onEvent,
		});
		await vi.advanceTimersByTimeAsync(1_000);
		expect(status(kit)).toBe('complete');
		expect(onEvent).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'transfer:complete', transfer: expect.anything() }),
		);
		kit.destroy();
	});

	it('copes with a page object that has no events', async () => {
		vi.stubGlobal('document', { visibilityState: 'visible' });
		const { kit, chain } = load([waiting()]);
		await vi.advanceTimersByTimeAsync(1_000);
		chain.used = true;
		await vi.advanceTimersByTimeAsync(15_000);
		expect(status(kit)).toBe('complete');
		kit.destroy();
	});
});
