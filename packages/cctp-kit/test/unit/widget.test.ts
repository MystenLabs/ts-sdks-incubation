// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { atom } from 'nanostores';
import { describe, expect, it, vi } from 'vitest';
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
function suiKit(storage = createInMemoryStorage()) {
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
			fetch: vi.fn<typeof fetch>(async (input) =>
				String(input).includes('/fees/')
					? json(400, { error: 'Invalid source/destination domain id' })
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
});
