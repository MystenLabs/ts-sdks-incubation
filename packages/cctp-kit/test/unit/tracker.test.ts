// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

// "Track a transfer": whatever transaction someone has of a transfer, pasted in a browser that
// has never seen it. Someone in production had only the claim transaction, on a chain the form
// was not set to, and was told the transaction could not be found.

import { atom } from 'nanostores';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCctpKit } from '../../src/core/index.js';
import type { AnyDAppKit } from '../../src/core/types.js';
import * as evm from '../../src/engine/evm.js';
import * as solana from '../../src/engine/solana.js';
import * as sui from '../../src/engine/sui.js';
import { MESSAGE_V2 } from '../../src/utils/bytes.js';
import { createInMemoryStorage } from '../../src/utils/storage.js';

vi.mock('../../src/engine/evm.js', async (original) => ({
	...(await original<typeof evm>()),
	getEvmCctpActivity: vi.fn(async () => null),
	evmIsNonceUsed: vi.fn(async () => false),
	getEvmTransactionTime: vi.fn(async () => null),
	getEvmNativeBalance: vi.fn(async () => 10n ** 18n),
	getEvmUsdcBalance: vi.fn(async () => 0n),
}));
vi.mock('../../src/engine/sui.js', async (original) => ({
	...(await original<typeof sui>()),
	getSuiClaimedMessage: vi.fn(async () => null),
	getSuiTransactionTime: vi.fn(async () => null),
}));
vi.mock('../../src/engine/solana.js', async (original) => ({
	...(await original<typeof solana>()),
	getSolanaClaimedMessage: vi.fn(async () => null),
	getSolanaTransactionTime: vi.fn(async () => null),
}));

const SUI_ADDRESS = `0x${'ab'.repeat(32)}`;
const EVM_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const SUI_DIGEST = 'B3oEZxT9EMVCNdL3KRx6TP6hDUq4LTcXCuEuE1yzb4EN';
const BASE_CLAIM = `0x${'09'.repeat(32)}`;
const BASE_BURN = `0x${'b5'.repeat(32)}`;
const NONCE = `0x${'78'.repeat(32)}`;
const DOMAIN = { sui: 8, base: 6 };

/** A v2 message between two domains, as bytes and as Circle returns it once attested. */
function transfer(route: { from: number; to: number; sender: string; recipient: string }) {
	const bytes = new Uint8Array(376);
	const view = new DataView(bytes.buffer);
	view.setUint32(MESSAGE_V2.version, 1);
	view.setUint32(MESSAGE_V2.sourceDomain, route.from);
	view.setUint32(MESSAGE_V2.destinationDomain, route.to);
	bytes.fill(0x78, MESSAGE_V2.nonce, MESSAGE_V2.nonce + 32);
	const hex = `0x${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
	return {
		bytes,
		circle: {
			message: hex,
			attestation: `0x${'bb'.repeat(65)}`,
			eventNonce: NONCE,
			cctpVersion: 2,
			status: 'complete',
			decodedMessage: {
				sourceDomain: String(route.from),
				destinationDomain: String(route.to),
				nonce: NONCE,
				destinationCaller: `0x${'00'.repeat(32)}`,
				minFinalityThreshold: '2000',
				decodedMessageBody: {
					mintRecipient: route.recipient,
					amount: '99634037',
					messageSender: route.sender,
					maxFee: '0',
				},
			},
		},
	};
}
const suiToBase = transfer({
	from: DOMAIN.sui,
	to: DOMAIN.base,
	sender: SUI_ADDRESS,
	recipient: EVM_ADDRESS,
});
const baseToSui = transfer({
	from: DOMAIN.base,
	to: DOMAIN.sui,
	sender: EVM_ADDRESS,
	recipient: SUI_ADDRESS,
});

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Circle, knowing the given burns by transaction and by nonce. */
function circleKnows(burns: { domain: number; txHash: string; message: unknown }[]) {
	return vi.fn<typeof fetch>(async (input) => {
		const url = new URL(String(input));
		const asked = /\/v2\/messages\/(\d+)$/.exec(url.pathname);
		if (!asked) return json(400, { error: 'no quote in this test' });
		const domain = Number(asked[1]);
		const burn = burns.find(
			(b) =>
				b.domain === domain &&
				(url.searchParams.get('transactionHash') === b.txHash || url.searchParams.has('nonce')),
		);
		return burn
			? json(200, { messages: [burn.message], sourceTxHash: burn.txHash })
			: json(404, { error: 'not found' });
	});
}
const messageRequests = (circle: ReturnType<typeof circleKnows>) =>
	circle.mock.calls.map(([url]) => String(url)).filter((url) => url.includes('/v2/messages/'));

function kitWith(circle: typeof fetch, storage = createInMemoryStorage()) {
	return createCctpKit({
		dAppKit: {
			stores: {
				$connection: atom({ account: { address: SUI_ADDRESS } }),
				$currentNetwork: atom('mainnet'),
			},
			getClient: () => ({ core: { getBalance: async () => ({ balance: { balance: '1' } }) } }),
		} as unknown as AnyDAppKit,
		network: 'mainnet',
		storage,
		iris: { fetch: circle },
		wallets: {
			evm: { ecosystem: 'evm', getAccount: () => null, subscribe: () => () => undefined } as never,
			solana: {
				ecosystem: 'solana',
				getAccount: () => null,
				subscribe: () => () => undefined,
			} as never,
		},
	});
}

beforeEach(() => {
	vi.mocked(evm.getEvmCctpActivity).mockReset().mockResolvedValue(null);
	vi.mocked(evm.evmIsNonceUsed).mockReset().mockResolvedValue(false);
	vi.mocked(sui.getSuiClaimedMessage).mockReset().mockResolvedValue(null);
});

describe('tracking a transfer by a transaction of it', () => {
	it('finds it from the claim, on a chain nobody named', async () => {
		// The case from production: the only transaction at hand was the one that minted on Base.
		vi.mocked(evm.getEvmCctpActivity).mockImplementation(async (chain) =>
			chain.key === 'base'
				? { burn: null, claim: { sourceDomain: DOMAIN.sui, nonce: NONCE as never } }
				: null,
		);
		const circle = circleKnows([
			{ domain: DOMAIN.sui, txHash: SUI_DIGEST, message: suiToBase.circle },
		]);
		const kit = kitWith(circle);
		const found = await kit.importTransfer({ txHash: BASE_CLAIM });
		expect(found).toMatchObject({
			from: 'sui',
			to: 'base',
			amount: '99634037',
			status: 'complete',
			sourceTxHash: SUI_DIGEST,
			destinationTxHash: BASE_CLAIM,
		});
		// Every EVM chain was asked for the transaction; Circle was asked once, by nonce.
		expect(vi.mocked(evm.getEvmCctpActivity).mock.calls.length).toBeGreaterThan(20);
		expect(messageRequests(circle)).toHaveLength(1);
		kit.destroy();
	});

	it('finds a burn on an EVM chain without being told which', async () => {
		vi.mocked(evm.getEvmCctpActivity).mockImplementation(async (chain) =>
			chain.key === 'base'
				? {
						burn: {
							amount: 99634037n,
							destinationDomain: DOMAIN.sui,
							mintRecipient: SUI_ADDRESS as never,
							depositor: EVM_ADDRESS,
							maxFee: 0n,
							minFinalityThreshold: 2000,
						},
						claim: null,
					}
				: null,
		);
		const circle = circleKnows([
			{ domain: DOMAIN.base, txHash: BASE_BURN, message: baseToSui.circle },
		]);
		const kit = kitWith(circle);
		const found = await kit.importTransfer({ txHash: BASE_BURN });
		expect(found).toMatchObject({
			from: 'base',
			to: 'sui',
			status: 'readyToMint',
			sourceTxHash: BASE_BURN,
		});
		// Circle is not asked once per chain: its limit is per visitor.
		expect(messageRequests(circle)).toHaveLength(1);
		kit.destroy();
	});

	it('shows a burn that was claimed already as done, not as waiting for a claim', async () => {
		vi.mocked(evm.evmIsNonceUsed).mockResolvedValue(true);
		const kit = kitWith(
			circleKnows([{ domain: DOMAIN.sui, txHash: SUI_DIGEST, message: suiToBase.circle }]),
		);
		const found = await kit.importTransfer({
			txHash: `https://suiscan.xyz/mainnet/tx/${SUI_DIGEST}`,
		});
		expect(found).toMatchObject({ from: 'sui', to: 'base', status: 'complete' });
		kit.destroy();
	});

	it('finds it from a claim on Sui', async () => {
		const claimDigest = 'C1v6NwPuxdXmaag9Wjcnq4TX65fh5QQj5nDVaSGeM39M';
		vi.mocked(sui.getSuiClaimedMessage).mockResolvedValue(baseToSui.bytes);
		const kit = kitWith(
			circleKnows([{ domain: DOMAIN.base, txHash: BASE_BURN, message: baseToSui.circle }]),
		);
		const found = await kit.importTransfer({ txHash: claimDigest });
		expect(found).toMatchObject({
			from: 'base',
			to: 'sui',
			status: 'complete',
			sourceTxHash: BASE_BURN,
			destinationTxHash: claimDigest,
		});
		kit.destroy();
	});

	it('finishes the transfer it already has when given its claim, and adds no second one', async () => {
		vi.mocked(evm.getEvmCctpActivity).mockImplementation(async (chain) =>
			chain.key === 'base'
				? { burn: null, claim: { sourceDomain: DOMAIN.sui, nonce: NONCE as never } }
				: null,
		);
		const kit = kitWith(
			circleKnows([{ domain: DOMAIN.sui, txHash: SUI_DIGEST, message: suiToBase.circle }]),
		);
		const byBurn = await kit.importTransfer({ txHash: SUI_DIGEST });
		expect(byBurn.status).toBe('readyToMint');
		const byClaim = await kit.importTransfer({ txHash: BASE_CLAIM });
		expect(byClaim).toMatchObject({
			id: byBurn.id,
			status: 'complete',
			destinationTxHash: BASE_CLAIM,
		});
		// And the claim's hash finds it from now on.
		expect((await kit.importTransfer({ txHash: BASE_CLAIM })).id).toBe(byBurn.id);
		expect(kit.stores.$transfers.get()).toHaveLength(1);
		kit.destroy();
	});

	it('says so when no chain knows the transaction as a transfer', async () => {
		const kit = kitWith(circleKnows([]));
		const message =
			'No USDC transfer was found for that transaction. Paste the transaction that sent the USDC, or the one that claimed it.';
		await expect(kit.importTransfer({ txHash: BASE_CLAIM })).rejects.toThrow(message);
		await expect(kit.importTransfer({ txHash: SUI_DIGEST })).rejects.toThrow(message);
		await expect(kit.importTransfer({ txHash: 'not a transaction' })).rejects.toThrow(
			'That does not look like a transaction hash, or a link to one',
		);
		expect(kit.stores.$transfers.get()).toEqual([]);
		kit.destroy();
	});
});
