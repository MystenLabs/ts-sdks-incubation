import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import type {
	ChainProbe,
	ChainProbeError,
	ChainProbeMode,
	ChainProbeSchema,
} from '../../../src/contracts/chain-probe.ts';
import {
	buildWalSeedRequests,
	buildWalSwapTransaction,
	resolveWalExchange,
	type WalSwapSigner,
	type WalExchangeProbeKey,
} from '../../../src/plugins/walrus/seed-wal.ts';

const makeSigner = (name: string, address: string): WalSwapSigner => ({
	name,
	address,
	signTransaction: () => Effect.succeed({ bytes: 'bytes', signature: 'signature' }),
	withTransactionSigner: (body) =>
		body({
			signTransaction: () => Effect.succeed({ bytes: 'bytes', signature: 'signature' }),
		}),
});

describe('walrus seed WAL swap', () => {
	it('resolves the exchange package id from the on-chain object type', async () => {
		const probe: ChainProbe<WalExchangeProbeKey> = {
			get: <Shape>(
				_key: WalExchangeProbeKey,
				schema: ChainProbeSchema<Shape>,
				_mode: ChainProbeMode,
			) =>
				Schema.decodeUnknownEffect(schema)({
					objectId: '0xabc',
					type: '0xfeed::wal_exchange::Exchange',
				}).pipe(
					Effect.mapError(
						(cause): ChainProbeError => ({
							_tag: 'ChainProbeError',
							reason: 'decode-failed',
							chain: 'sui:localnet',
							detail: String(cause),
						}),
					),
				),
		};

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

	it('builds one self-funded WAL seed request per seed account in order', () => {
		const sdk = { client: {} };
		const exchange = {
			objectId: '0xdef',
			packageId: '0xabc',
		};
		const signers = [makeSigner('alice', '0xa'), makeSigner('bob', '0xb')];

		const requests = buildWalSeedRequests({
			signers,
			sdk,
			exchange,
			paymentMist: 123n,
		});

		expect(requests).toHaveLength(2);
		expect(requests[0]?.signer).toBe(signers[0]);
		expect(requests[0]).toMatchObject({
			sdk,
			exchange,
			recipientAddress: '0xa',
			paymentMist: 123n,
		});
		expect(requests[1]?.signer).toBe(signers[1]);
		expect(requests[1]).toMatchObject({
			sdk,
			exchange,
			recipientAddress: '0xb',
			paymentMist: 123n,
		});
	});
});
