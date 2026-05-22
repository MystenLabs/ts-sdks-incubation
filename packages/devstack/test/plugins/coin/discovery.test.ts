// Coin plugin — package-publish-output discovery tests.
//
// Covers the pure output walker that turns package publish object
// changes into CoinRegistry-ready discovered coin records.

import { describe, expect, it } from '@effect/vitest';

import {
	discoverCoinsFromPublish,
	type CoinDiscoveryPublishOutput,
} from '../../../src/plugins/coin/discovery.ts';

const SUI_FRAMEWORK_PADDED = '0x0000000000000000000000000000000000000000000000000000000000000002';

const baseOutput = (
	objectChanges: CoinDiscoveryPublishOutput['objectChanges'],
): CoinDiscoveryPublishOutput => ({
	publisher: '0xpublisher',
	objectChanges,
});

describe('plugins/coin/discovery', () => {
	it('discovers TreasuryCap and CoinMetadata when the SDK emits a padded Sui framework address', () => {
		const discovered = discoverCoinsFromPublish(
			baseOutput([
				{
					type: 'created',
					objectId: '0xmeta',
					objectType: `${SUI_FRAMEWORK_PADDED}::coin::CoinMetadata<0xpkg::mock_usdc::MOCK_USDC>`,
				},
				{
					type: 'created',
					objectId: '0xcap',
					objectType: `${SUI_FRAMEWORK_PADDED}::coin::TreasuryCap<0xpkg::mock_usdc::MOCK_USDC>`,
					owner: { AddressOwner: '0xpublisher' },
				},
			]),
		);

		expect(discovered).toEqual([
			{
				fullCoinType: '0xpkg::mock_usdc::MOCK_USDC',
				witness: 'mock_usdc',
				moduleName: 'mock_usdc',
				treasuryCapId: '0xcap',
				treasuryCapOwner: '0xpublisher',
				metadataId: '0xmeta',
				publisherOwnsCap: true,
			},
		]);
	});

	it('continues to accept the compact 0x2 framework address', () => {
		const discovered = discoverCoinsFromPublish(
			baseOutput([
				{
					type: 'created',
					objectId: '0xcap',
					objectType: '0x2::coin::TreasuryCap<0xpkg::mock_weth::MOCK_WETH>',
				},
			]),
		);

		expect(discovered.map((coin) => coin.fullCoinType)).toEqual(['0xpkg::mock_weth::MOCK_WETH']);
	});

	it('uses hydrated coin registry Currency metadata and hydrated TreasuryCap owner', () => {
		const discovered = discoverCoinsFromPublish(
			baseOutput([
				{
					type: 'created',
					objectId: '0xcap',
					objectType: `${SUI_FRAMEWORK_PADDED}::coin::TreasuryCap<0xpkg::dusdc::DUSDC>`,
					owner: { $kind: 'AddressOwner', AddressOwner: '0xpublisher' },
				},
				{
					type: 'created',
					objectId: '0xcurrency',
					objectType: `${SUI_FRAMEWORK_PADDED}::coin_registry::Currency<0xpkg::dusdc::DUSDC>`,
					json: {
						decimals: 6,
						symbol: 'DUSDC',
						name: 'DeepBook USDC',
						icon_url: 'https://cryptologos.cc/logos/usd-coin-usdc-logo.svg',
					},
				},
			]),
		);

		expect(discovered).toEqual([
			{
				fullCoinType: '0xpkg::dusdc::DUSDC',
				witness: 'dusdc',
				moduleName: 'dusdc',
				treasuryCapId: '0xcap',
				treasuryCapOwner: '0xpublisher',
				metadataId: '0xcurrency',
				decimals: 6,
				symbol: 'DUSDC',
				displayName: 'DeepBook USDC',
				iconUrl: 'https://cryptologos.cc/logos/usd-coin-usdc-logo.svg',
				publisherOwnsCap: true,
			},
		]);
	});
});
