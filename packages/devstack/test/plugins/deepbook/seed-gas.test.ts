import { Transaction } from '@mysten/sui/transactions';
import { normalizeStructTag } from '@mysten/sui/utils';
import { describe, expect, it } from 'vitest';

import {
	selectOwnedCoinsForBalance,
	setExplicitSeedGasPayment,
} from '../../../src/plugins/deepbook/deploy.ts';

const SUI_TYPE = normalizeStructTag('0x2::sui::SUI');
const OWNER = '0x1111111111111111111111111111111111111111111111111111111111111111';
const DIGEST = '11111111111111111111111111111111';

type CoinPage = {
	readonly objects: ReadonlyArray<{
		readonly objectId: string;
		readonly version: string | number;
		readonly digest: string;
		readonly balance: string | number | bigint;
	}>;
	readonly hasNextPage: boolean;
	readonly cursor: string | null;
};

const signer = { name: 'publisher', address: OWNER } as const;

const makeSdk = (pages: Record<string, CoinPage>) => {
	const calls: Array<{
		readonly owner: string;
		readonly coinType: string;
		readonly cursor?: string | null;
		readonly limit?: number;
	}> = [];
	const sdk = {
		client: {
			core: {
				listCoins: async (args: {
					readonly owner: string;
					readonly coinType: string;
					readonly cursor?: string | null;
					readonly limit?: number;
				}) => {
					calls.push(args);
					return pages[args.cursor ?? 'first'];
				},
			},
			ledgerService: {
				getObject: async ({ objectId }: { readonly objectId: string }) => ({
					response: {
						object: {
							objectId,
							version: '1',
							digest: DIGEST,
						},
					},
				}),
			},
		},
	};
	return { sdk, calls };
};

describe('DeepBook seed SUI gas selection', () => {
	it('selects enough SUI gas payments for gas plus SUI seed deposits', async () => {
		const { sdk, calls } = makeSdk({
			first: {
				objects: [
					{
						objectId: '0x2222222222222222222222222222222222222222222222222222222222222222',
						version: '1',
						digest: DIGEST,
						balance: 100n,
					},
				],
				hasNextPage: true,
				cursor: 'next',
			},
			next: {
				objects: [
					{
						objectId: '0x3333333333333333333333333333333333333333333333333333333333333333',
						version: '1',
						digest: DIGEST,
						balance: 500_000_800n,
					},
				],
				hasNextPage: false,
				cursor: null,
			},
		});
		const tx = new Transaction();

		await setExplicitSeedGasPayment(tx, sdk as never, signer as never, 900n);

		const data = tx.getData() as {
			readonly gasData: {
				readonly budget: string;
				readonly price: string;
				readonly payment: ReadonlyArray<{ readonly objectId: string }>;
			};
		};
		expect(calls).toEqual([
			{ owner: OWNER, coinType: SUI_TYPE, cursor: null, limit: 50 },
			{ owner: OWNER, coinType: SUI_TYPE, cursor: 'next', limit: 50 },
		]);
		expect(data.gasData.budget).toBe('500000000');
		expect(data.gasData.price).toBe('1000');
		expect(data.gasData.payment.map((coin) => coin.objectId)).toEqual([
			'0x2222222222222222222222222222222222222222222222222222222222222222',
			'0x3333333333333333333333333333333333333333333333333333333333333333',
		]);
	});

	it('reports total available balance when coin selection is insufficient', async () => {
		const { sdk } = makeSdk({
			first: {
				objects: [
					{
						objectId: '0x2222222222222222222222222222222222222222222222222222222222222222',
						version: '1',
						digest: DIGEST,
						balance: 25n,
					},
				],
				hasNextPage: false,
				cursor: null,
			},
		});

		await expect(
			selectOwnedCoinsForBalance(
				sdk as never,
				signer as never,
				SUI_TYPE,
				50n,
				'DeepBook seed deposit',
			),
		).rejects.toThrow(/required 50, available 25/);
	});
});
