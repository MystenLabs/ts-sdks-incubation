import { Effect, Exit, Schema } from 'effect';
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
	swapAccountSuiForWal,
	type WalExchangeProbeKey,
	type WalSwapSdk,
} from '../../../src/plugins/walrus/wal-swap.ts';
import {
	parseWalCoinTypeFromTreasuryType,
	resolveWalCoinType,
} from '../../../src/plugins/walrus/faucet-strategy.ts';
import type { AccountValue } from '../../../src/plugins/account/index.ts';

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

	it('refuses with a typed error when paymentMist exceeds the account SUI balance', async () => {
		// Regression: without the pre-flight check the failure surfaces
		// as an opaque `Transaction.build` / chain-side `InsufficientGas`
		// after the wire call has already started. The typed refusal
		// names the balance + required numbers so the caller can act.
		const sdk: WalSwapSdk = {
			client: {} as never,
			core: {
				getBalance: async () => ({ balance: { balance: '1000' } }),
			},
		};
		const account = {
			name: 'alice',
			address: '0xalice',
		} as unknown as AccountValue;

		const exit = await Effect.runPromiseExit(
			swapAccountSuiForWal({
				account,
				sdk,
				exchange: { objectId: '0xex', packageId: '0xpkg' },
				recipientAddress: '0xalice',
				paymentMist: 500_000_000n,
			}),
		);

		expect(Exit.isFailure(exit)).toBe(true);
		const err = Exit.findErrorOption(exit);
		expect(err._tag).toBe('Some');
		if (err._tag === 'Some') {
			expect(err.value._tag).toBe('WalrusPluginError');
			expect(err.value.phase).toBe('fund-wal');
			expect(err.value.message).toContain('insufficient SUI');
			expect(err.value.message).toContain('balance=1000');
			expect(err.value.message).toContain('500000000');
		}
	});

	it('falls through to the wire path when the balance read returns null (best-effort hint)', async () => {
		// If the SDK throws or returns an unparseable shape the pre-flight
		// must NOT swallow the call — control reaches `withTransactionSigner`
		// (the wire path) instead of being short-circuited as
		// "insufficient SUI".
		const sdk: WalSwapSdk = {
			client: {} as never,
			core: {
				getBalance: async () => {
					throw new Error('rpc unreachable');
				},
			},
		};
		let wireWasReached = false;
		const account = {
			name: 'alice',
			address: '0xalice',
			source: 'real',
			withTransactionSigner: () => {
				wireWasReached = true;
				return Effect.fail(new Error('wire-path sentinel'));
			},
		} as unknown as AccountValue;

		const exit = await Effect.runPromiseExit(
			swapAccountSuiForWal({
				account,
				sdk,
				exchange: { objectId: '0xex', packageId: '0xpkg' },
				recipientAddress: '0xalice',
				paymentMist: 500_000_000n,
			}),
		);

		// The pre-flight passed through (balance=null) — `withTransactionSigner`
		// was reached, proving the pre-flight did NOT short-circuit on a
		// best-effort read failure.
		expect(wireWasReached).toBe(true);
		expect(Exit.isFailure(exit)).toBe(true);
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
