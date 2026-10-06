// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { atom } from 'nanostores';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCctpKit } from '../../src/core/index.js';
import type { AnyDAppKit, TransferRecord } from '../../src/core/types.js';
import { createInMemoryStorage } from '../../src/utils/storage.js';
import { CctpBridge } from '../../src/web/cctp-bridge.js';

vi.mock('@webcomponents/scoped-custom-element-registry', () => ({}));

const SUI_ADDRESS = `0x${'ab'.repeat(32)}`;
const EVM_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const DIGEST = 'C1v6NwPuxdXmaag9Wjcnq4TX65fh5QQj5nDVaSGeM39M';
const KEY = 'mysten-cctp-kit:transfers:mainnet';

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

const unusedWallet = (ecosystem: 'evm' | 'solana') => ({
	ecosystem,
	getAccount: () => null,
	subscribe: () => () => undefined,
	connect: async () => undefined,
	disconnect: async () => undefined,
	getWalletClient: async () => {
		throw new Error('not in tests');
	},
	signAndSendTransaction: async () => {
		throw new Error('not in tests');
	},
});

/** A kit sending from Sui to Avalanche, with a Sui wallet that holds 5 USDC. */
function suiKit(storage = createInMemoryStorage(), circle?: typeof fetch) {
	const signAndExecuteTransaction = vi.fn(async () => ({
		$kind: 'Transaction',
		Transaction: { digest: DIGEST },
	}));
	const dAppKit = {
		stores: {
			$connection: atom({ account: { address: SUI_ADDRESS } }),
			$currentNetwork: atom('mainnet'),
		},
		getClient: () => ({
			core: {
				// A real read is network I/O: it settles in a later task, never in the click's own.
				getBalance: async () => {
					await settle(1);
					return { balance: { balance: '5000000' } };
				},
				waitForTransaction: async () => ({}),
			},
		}),
		signAndExecuteTransaction,
	} as unknown as AnyDAppKit;
	const kit = createCctpKit({
		dAppKit,
		network: 'mainnet',
		direction: 'outflow',
		defaults: { to: 'avalanche' },
		storage,
		iris: {
			fetch: vi.fn<typeof fetch>(async (input, init) =>
				String(input).includes('/fees/')
					? json(400, { error: 'Invalid source/destination domain id' })
					: circle
						? circle(input, init)
						: json(404, { error: 'not found' }),
			),
		},
		wallets: {
			evm: unusedWallet('evm') as never,
			solana: unusedWallet('solana') as never,
		},
	});
	return { kit, signAndExecuteTransaction, storage };
}

const failedBeforeBurning: TransferRecord = {
	id: 'transfer-1',
	network: 'mainnet',
	from: 'sui',
	to: 'avalanche',
	amount: '1000000',
	maxFee: '0',
	speed: 'standard',
	sender: SUI_ADDRESS,
	recipient: EVM_ADDRESS,
	status: 'failed',
	error: 'User rejected the request',
	createdAt: 1,
	updatedAt: 1,
};

/** Burned and seen on Sui, waiting for Circle: what a page finds and picks up when it loads. */
const waitingForCircle: TransferRecord = {
	...failedBeforeBurning,
	status: 'attesting',
	sourceTxHash: DIGEST,
	sourceConfirmed: true,
	burnedAt: 1,
	error: undefined,
};

describe('a burn from Sui', () => {
	// A Sui wallet that signs in a window it opens itself can only open it while the click is
	// still being handled. Anything awaited first, and the browser blocks the window.
	it('asks the wallet inside the click on Bridge', async () => {
		const { kit, signAndExecuteTransaction } = suiKit();
		const element = new CctpBridge() as unknown as { instance: unknown; submit(): Promise<void> };
		element.instance = kit;
		await settle();
		kit.setRecipient(EVM_ADDRESS);
		kit.setAmount('1');
		await kit.refreshQuote();
		await settle();
		expect(kit.validate()).toBeNull();

		void element.submit();
		expect(signAndExecuteTransaction).toHaveBeenCalledTimes(1);
		await settle();
		kit.destroy();
	});

	it('asks the wallet inside the click on Retry', async () => {
		const storage = createInMemoryStorage();
		storage.setItem(KEY, JSON.stringify([failedBeforeBurning]));
		const { kit, signAndExecuteTransaction } = suiKit(storage);
		const element = new CctpBridge() as unknown as {
			instance: unknown;
			resume(kit: unknown, id: string): Promise<void>;
		};
		element.instance = kit;
		await settle();

		void element.resume(kit, failedBeforeBurning.id);
		expect(signAndExecuteTransaction).toHaveBeenCalledTimes(1);
		await settle();
		kit.destroy();
	});
});

describe('removing a transfer that never burned', () => {
	const stored = (storage: ReturnType<typeof createInMemoryStorage>) =>
		JSON.parse(storage.getItem(KEY) ?? '[]') as TransferRecord[];

	it('deletes it', () => {
		const storage = createInMemoryStorage();
		storage.setItem(KEY, JSON.stringify([failedBeforeBurning]));
		const { kit } = suiKit(storage);
		expect(kit.removeUnburned(failedBeforeBurning.id)).toBe(true);
		expect(stored(storage)).toEqual([]);
		expect(kit.stores.$transfers.get()).toEqual([]);
		kit.destroy();
	});

	it('refuses when another tab has burned it since this page last looked', () => {
		const storage = createInMemoryStorage();
		storage.setItem(KEY, JSON.stringify([failedBeforeBurning]));
		const { kit } = suiKit(storage);
		// The other tab: Retry, and the burn went through. This page still shows the failed card.
		const burned = {
			...failedBeforeBurning,
			status: 'attesting',
			sourceTxHash: DIGEST,
			error: undefined,
		};
		storage.setItem(KEY, JSON.stringify([burned]));
		expect(kit.stores.$transfers.get()[0]!.sourceTxHash).toBeUndefined();

		expect(kit.removeUnburned(failedBeforeBurning.id)).toBe(false);
		// The only record of the burn is still there, and the page now shows it as it is.
		expect(stored(storage)[0]!.sourceTxHash).toBe(DIGEST);
		expect(kit.stores.$transfers.get()[0]).toMatchObject({
			status: 'attesting',
			sourceTxHash: DIGEST,
		});
		kit.destroy();
	});

	it('refuses for a transfer whose burn was written off, or that has an attestation', () => {
		for (const patch of [{ droppedSourceTxHash: 'signature' }, { attestation: '0xbb' }]) {
			const storage = createInMemoryStorage();
			storage.setItem(KEY, JSON.stringify([{ ...failedBeforeBurning, ...patch }]));
			const { kit } = suiKit(storage);
			expect(kit.removeUnburned(failedBeforeBurning.id)).toBe(false);
			expect(stored(storage)).toHaveLength(1);
			kit.destroy();
		}
	});
});

describe('a typed recipient', () => {
	it('stays on screen when a wallet is connected afterwards', async () => {
		// Typing an address and then connecting a wallet used to hide the field while the
		// transfer still went to the typed address: the screen showed the wallet, not the truth.
		let announce: (account: { address: string } | null) => void = () => undefined;
		const evmWallet = {
			...unusedWallet('evm'),
			subscribe: (listener: typeof announce) => {
				announce = listener;
				return () => undefined;
			},
		};
		const dAppKit = {
			stores: {
				$connection: atom({ account: { address: SUI_ADDRESS } }),
				$currentNetwork: atom('mainnet'),
			},
			getClient: () => ({ core: {} }),
		} as unknown as AnyDAppKit;
		const kit = createCctpKit({
			dAppKit,
			network: 'mainnet',
			direction: 'outflow',
			defaults: { to: 'avalanche' },
			storage: createInMemoryStorage(),
			iris: { fetch: vi.fn<typeof fetch>(async () => json(404, { error: 'not found' })) },
			wallets: { evm: evmWallet as never, solana: unusedWallet('solana') as never },
		});
		const element = new CctpBridge() as unknown as {
			instance: unknown;
			showRecipientField(kit: unknown, chain: unknown, account: unknown): boolean;
		};
		element.instance = kit;
		await settle();
		const destination = kit.stores.$destinationChain.get();

		const typed = '0x2222222222222222222222222222222222222222';
		kit.setRecipient(typed);
		announce({ address: EVM_ADDRESS });
		await settle();

		const connected = kit.stores.$destinationAccount.get();
		expect(connected?.address).toBe(EVM_ADDRESS);
		expect(kit.stores.$recipient.get()).toBe(typed);
		expect(element.showRecipientField(kit, destination, connected)).toBe(true);
		// With nothing typed, a connected wallet needs no field.
		kit.setRecipient('');
		expect(element.showRecipientField(kit, destination, connected)).toBe(false);
		kit.destroy();
	});
});

describe('dismissing a transfer', () => {
	it('takes its card out of the pending list and keeps the record', () => {
		const storage = createInMemoryStorage();
		storage.setItem(KEY, JSON.stringify([failedBeforeBurning]));
		const { kit } = suiKit(storage);
		const element = new CctpBridge() as unknown as {
			instance: unknown;
			pendingTransfers(kit: unknown): TransferRecord[];
		};
		element.instance = kit;
		expect(element.pendingTransfers(kit).map((t) => t.id)).toEqual([failedBeforeBurning.id]);
		kit.dismiss(failedBeforeBurning.id);
		expect(element.pendingTransfers(kit)).toEqual([]);
		expect(kit.stores.$transfers.get()[0]).toMatchObject({
			id: failedBeforeBurning.id,
			hidden: true,
		});
		kit.restore(failedBeforeBurning.id);
		expect(element.pendingTransfers(kit)).toHaveLength(1);
		kit.destroy();
	});

	it('stays dismissed when the transfer moves on afterwards', async () => {
		// The run that is waiting for Circle holds the record as it was before the dismissal.
		// Writing that copy back with its next step brought the card back.
		vi.useFakeTimers();
		try {
			const storage = createInMemoryStorage();
			storage.setItem(KEY, JSON.stringify([waitingForCircle]));
			let attested = false;
			const { kit } = suiKit(storage, async () =>
				attested
					? json(200, {
							messages: [
								{
									status: 'complete',
									message: `0x${'aa'.repeat(376)}`,
									attestation: `0x${'bb'.repeat(65)}`,
								},
							],
						})
					: json(404, { error: 'not found' }),
			);
			const element = new CctpBridge() as unknown as {
				instance: unknown;
				pendingTransfers(kit: unknown): TransferRecord[];
			};
			element.instance = kit;
			await vi.advanceTimersByTimeAsync(1_000);
			expect(kit.isRunning(waitingForCircle.id)).toBe(true);
			kit.dismiss(waitingForCircle.id);
			expect(element.pendingTransfers(kit)).toEqual([]);

			attested = true;
			await vi.advanceTimersByTimeAsync(10_000);
			expect(kit.stores.$transfers.get()[0]).toMatchObject({
				status: 'readyToMint',
				hidden: true,
			});
			expect(element.pendingTransfers(kit)).toEqual([]);
			kit.destroy();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('a transfer that another tab is driving', () => {
	afterEach(() => vi.useRealTimers());

	/** A second tab: its own copy of the kit module, the same storage. */
	async function otherTab(storage: ReturnType<typeof createInMemoryStorage>) {
		vi.resetModules();
		const fresh = await import('../../src/core/index.js');
		const signAndExecuteTransaction = vi.fn(async () => ({
			$kind: 'Transaction',
			Transaction: { digest: DIGEST },
		}));
		const circle = vi.fn<typeof fetch>(async () => json(404, { error: 'not found' }));
		const kit = fresh.createCctpKit({
			dAppKit: {
				stores: {
					$connection: atom({ account: { address: SUI_ADDRESS } }),
					$currentNetwork: atom('mainnet'),
				},
				getClient: () => ({ core: { waitForTransaction: async () => ({}) } }),
				signAndExecuteTransaction,
			} as unknown as AnyDAppKit,
			network: 'mainnet',
			direction: 'outflow',
			defaults: { to: 'avalanche' },
			storage,
			iris: { fetch: circle },
			wallets: { evm: unusedWallet('evm') as never, solana: unusedWallet('solana') as never },
		});
		return { kit, signAndExecuteTransaction, circle };
	}

	it('cannot be retried or removed from a second tab while the first is at the wallet', async () => {
		const storage = createInMemoryStorage();
		storage.setItem(KEY, JSON.stringify([failedBeforeBurning]));
		const first = suiKit(storage);
		// The first tab's wallet prompt is open and unanswered.
		let answer: (value: unknown) => void = () => undefined;
		first.signAndExecuteTransaction.mockImplementationOnce(
			() => new Promise((resolve) => (answer = resolve)) as never,
		);
		const running = first.kit.resume(failedBeforeBurning.id).catch(() => undefined);

		const second = await otherTab(storage);
		expect(second.kit.isRunning(failedBeforeBurning.id)).toBe(true);
		await expect(second.kit.resume(failedBeforeBurning.id)).rejects.toThrow(
			'This transfer is being handled in another tab.',
		);
		expect(second.signAndExecuteTransaction).not.toHaveBeenCalled();
		expect(second.kit.removeUnburned(failedBeforeBurning.id)).toBe(false);

		// The first tab's wallet answers and its run moves on: the second tab is free again.
		answer({
			$kind: 'FailedTransaction',
			FailedTransaction: { status: { error: { message: 'rejected' } } },
		});
		await running;
		expect(second.kit.isRunning(failedBeforeBurning.id)).toBe(false);
		first.kit.destroy();
		second.kit.destroy();
	});

	it('is given up by a page that is put away for the back button, and picked up when it returns', async () => {
		// Such a page is frozen with its runs still pending. If it only gave up its claims, it
		// would carry on with those runs when it came back, beside the tab that took them over.
		vi.useFakeTimers();
		vi.stubGlobal('window', new EventTarget());
		const pageEvent = (type: string, persisted: boolean) =>
			window.dispatchEvent(Object.assign(new Event(type), { persisted }));
		try {
			const storage = createInMemoryStorage();
			storage.setItem(KEY, JSON.stringify([waitingForCircle]));
			const claim = () => storage.getItem(`${KEY}:running:${waitingForCircle.id}`);
			const { kit, circle } = await otherTab(storage);
			const polls = () =>
				circle.mock.calls.filter(([url]) => String(url).includes('/v2/messages/')).length;
			await vi.advanceTimersByTimeAsync(6_000);
			expect(polls()).toBeGreaterThan(0);
			expect(claim()).not.toBeNull();

			pageEvent('pagehide', true);
			await vi.advanceTimersByTimeAsync(0);
			expect(claim()).toBeNull();
			expect(kit.isRunning(waitingForCircle.id)).toBe(false);
			// Its run has ended: it asks Circle nothing more while it is away.
			const before = polls();
			await vi.advanceTimersByTimeAsync(30_000);
			expect(polls()).toBe(before);
			// Stopping is not failing: the record is as the run left it.
			expect(kit.stores.$transfers.get()[0]).toMatchObject({ status: 'attesting' });
			expect(kit.stores.$transfers.get()[0]!.error).toBeUndefined();

			pageEvent('pageshow', true);
			await vi.advanceTimersByTimeAsync(6_000);
			expect(claim()).not.toBeNull();
			expect(polls()).toBeGreaterThan(before);
			kit.destroy();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('is left running by a page that is simply shown again', async () => {
		vi.useFakeTimers();
		vi.stubGlobal('window', new EventTarget());
		try {
			const storage = createInMemoryStorage();
			storage.setItem(KEY, JSON.stringify([waitingForCircle]));
			const { kit, circle } = await otherTab(storage);
			await vi.advanceTimersByTimeAsync(6_000);
			// The first load of a page also fires `pageshow`, with nothing to bring back.
			window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }));
			const before = circle.mock.calls.length;
			await vi.advanceTimersByTimeAsync(6_000);
			expect(kit.isRunning(waitingForCircle.id)).toBe(true);
			expect(circle.mock.calls.length).toBeGreaterThan(before);
			kit.destroy();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("is picked up once a dead tab's claim has lapsed", async () => {
		vi.useFakeTimers();
		const storage = createInMemoryStorage();
		const waiting = waitingForCircle;
		storage.setItem(KEY, JSON.stringify([waiting]));
		// A tab that crashed left its claim behind; it has 30 seconds to run.
		storage.setItem(
			`${KEY}:running:${waiting.id}`,
			JSON.stringify({ owner: 'a-dead-tab', until: Date.now() + 30_000 }),
		);
		const { kit, circle } = await otherTab(storage);
		// Polls for this transfer's attestation, not the fee quote the form asks for at start.
		const polls = () =>
			circle.mock.calls.filter(([url]) => String(url).includes('/v2/messages/')).length;
		await vi.advanceTimersByTimeAsync(5_000);
		expect(polls()).toBe(0);
		expect(kit.isRunning(waiting.id)).toBe(true);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(polls()).toBeGreaterThan(0);
		kit.destroy();
	});
});
