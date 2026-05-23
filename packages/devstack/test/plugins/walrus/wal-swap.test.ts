import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import type {
	ChainProbe,
	ChainProbeError,
	ChainProbeMode,
	ChainProbeSchema,
} from '../../../src/contracts/chain-probe.ts';
import {
	buildWalSwapTransaction,
	resolveWalExchange,
	type WalExchangeProbeKey,
} from '../../../src/plugins/walrus/wal-swap.ts';
import {
	parseWalCoinTypeFromTreasuryType,
	resolveWalCoinType,
} from '../../../src/plugins/walrus/faucet-strategy.ts';

const objectProbe = (object: { readonly objectId: string; readonly type: string }) =>
	({
		get: <Shape>(
			_key: WalExchangeProbeKey,
			schema: ChainProbeSchema<Shape>,
			_mode: ChainProbeMode,
		) =>
			Schema.decodeUnknownEffect(schema)(object).pipe(
				Effect.mapError(
					(cause): ChainProbeError => ({
						_tag: 'ChainProbeError',
						reason: 'decode-failed',
						chain: 'sui:localnet',
						detail: String(cause),
					}),
				),
			),
	}) satisfies ChainProbe<WalExchangeProbeKey>;

describe('walrus WAL swap', () => {
	it('resolves the exchange package id from the on-chain object type', async () => {
		const probe = objectProbe({
			objectId: '0xabc',
			type: '0xfeed::wal_exchange::Exchange',
		});

		const exchange = await Effect.runPromise(resolveWalExchange(probe, '0xabc'));

		expect(exchange).toEqual({
			objectId: '0xabc',
			packageId: '0xfeed',
		});
	});

	it('builds the wal_exchange::exchange_all_for_wal transaction', () => {
		const tx = buildWalSwapTransaction({
			signerAddress: '0x1',
			recipientAddress: '0x2',
			exchange: {
				objectId: '0xdef',
				packageId: '0xabc',
			},
			paymentMist: 500_000_000n,
		});

		const data = tx.getData();
		expect(data.sender).toBe('0x0000000000000000000000000000000000000000000000000000000000000001');
		expect(data.commands).toHaveLength(3);
		expect(data.commands[0]?.$kind).toBe('$Intent');
		expect(data.commands[0]?.$Intent?.name).toBe('CoinWithBalance');
		expect(data.commands[0]?.$Intent?.data).toMatchObject({
			type: 'gas',
			balance: 500_000_000n,
			outputKind: 'coin',
		});
		expect(data.commands[1]).toMatchObject({
			$kind: 'MoveCall',
			MoveCall: {
				package: '0x0000000000000000000000000000000000000000000000000000000000000abc',
				module: 'wal_exchange',
				function: 'exchange_all_for_wal',
			},
		});
		expect(data.commands[2]?.$kind).toBe('TransferObjects');
	});

	it('derives the WAL coin type from the protected treasury original package', () => {
		expect(parseWalCoinTypeFromTreasuryType('0x123::wal::ProtectedTreasury')).toBe(
			'0x123::wal::WAL',
		);
		expect(parseWalCoinTypeFromTreasuryType('0x2::coin::TreasuryCap<0x456::wal::WAL>')).toBe(
			'0x456::wal::WAL',
		);
		expect(parseWalCoinTypeFromTreasuryType('0xabc::wal_exchange::Exchange')).toBeNull();
	});

	it('uses the treasury package id for WAL funding instead of the upgraded walrus package id', async () => {
		const probe = objectProbe({
			objectId: '0xtreasury',
			type: '0x111::wal::ProtectedTreasury',
		});

		const coinType = await Effect.runPromise(
			resolveWalCoinType({
				probe,
				treasuryObjectId: '0xtreasury',
				deployPackageId: '0x222',
				requireTreasuryObject: true,
			}),
		);

		expect(coinType).toBe('0x111::wal::WAL');
	});
});
