// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { FINALITY_BY_CHAIN } from './finality.js';
import type { SuiChainDefinition } from './types.js';

/**
 * Circle CCTP v2 on Sui (domain 8).
 *
 * Package and state object ids are the ones Circle documents at
 * https://developers.circle.com/cctp/references/sui-packages (checked 2026-10-05, the day
 * Circle opened the Sui routes). The source is https://github.com/circlefin/sui-cctp.
 *
 * Call a package by the id listed here. If Circle upgrades a package, the state object's
 * `compatible_versions` decides which package ids still work; an outdated id aborts with
 * EIncompatibleVersion.
 */
export const SUI_MAINNET: SuiChainDefinition = {
	ecosystem: 'sui',
	key: 'sui',
	name: 'Sui',
	domain: 8,
	isTestnet: false,
	suiNetwork: 'mainnet',
	// Circle marks Fast Transfer as not applicable when Sui is the source: a standard
	// attestation already lands in seconds. Fast into Sui depends on the source chain.
	fastTransferAsSource: false,
	explorerUrl: 'https://suiscan.xyz/mainnet',
	rpcUrls: ['https://fullnode.mainnet.sui.io:443'],
	finality: FINALITY_BY_CHAIN.sui,
	usdcCoinType: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
	packages: {
		messageTransmitterV2: '0x16bcfcfc465f96281663a344641c017de84529370e11aa3879d0dce43ad6db87',
		tokenMessengerMinterV2: '0xeb14978abfe93a37c5d5bf86a0623b923553a5f0e794daac7724f1e2fdbfb830',
		stablecoinHandler: '0x185ed207c4d64fc594882ab927f9f3c6ff957aad03df8a731ba64378faeeb2bf',
	},
	objects: {
		messageTransmitterState: '0x0c067f7d325e5b60e3179712e7783534ba1556cbb3d359d8161497e37689230c',
		tokenMessengerMinterState: '0x06fb166941cd7bc095edc019d054a753ec3f1e4c25f28f2ecc4a6cfa0a9b1167',
		stablecoinHandlerState: '0xa32de8a6dd0178fb05f662929d55cddb69a25c26bde4b83f89e36d17ead94c41',
		treasury: '0x57d6725e7a8b49a7b2a612f6bd66ab5f39fc95332ca48be421c3229d514a6de7',
		denyList: '0x403',
		clock: '0x6',
	},
};

export const SUI_TESTNET: SuiChainDefinition = {
	ecosystem: 'sui',
	key: 'sui',
	name: 'Sui Testnet',
	domain: 8,
	isTestnet: true,
	suiNetwork: 'testnet',
	fastTransferAsSource: false,
	explorerUrl: 'https://suiscan.xyz/testnet',
	rpcUrls: ['https://fullnode.testnet.sui.io:443'],
	finality: FINALITY_BY_CHAIN.sui,
	usdcCoinType: '0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC',
	packages: {
		messageTransmitterV2: '0xe9678cd42a81886e18e21361088071f275105636a4d3751e1d7f255211f73bbe',
		tokenMessengerMinterV2: '0x267d3c0cb776eace2840f27e4d33da9c6d952f9749403f1fe6579f4962ed3c64',
		stablecoinHandler: '0xbe8479044396a45e07de2c7f14789c35b8338406eebc53b2527da56839a91561',
	},
	objects: {
		messageTransmitterState: '0xfee3a2b47f9ef2de2405fc63d79194307945f8ea768815cfc46083bc20fbe6ed',
		tokenMessengerMinterState: '0x72cb55cd14d01e6361386d6ea93eecda9fa1efc3c202b8dd69c1e4683e4c0ca0',
		stablecoinHandlerState: '0xfbd9c0517c4f0e1817445ee2be598806e3c392a465d7e3d773d1055f3f0eed32',
		treasury: '0x7170137d4a6431bf83351ac025baf462909bffe2877d87716374fb42b9629ebe',
		denyList: '0x403',
		clock: '0x6',
	},
};
