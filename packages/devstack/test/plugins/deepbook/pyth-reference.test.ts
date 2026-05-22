import { describe, expect, it } from 'vitest';
import { fromHex, toBase64 } from '@mysten/sui/utils';

import {
	DEEP_PRICE_FEED_ID,
	feedIdFromJson,
	SUI_PRICE_FEED_ID,
	USDC_PRICE_FEED_ID,
} from '../../../src/plugins/deepbook/pyth/index.ts';

const pythJson = (bytes: unknown) => ({
	price_info: {
		price_feed: {
			price_identifier: { bytes },
		},
	},
});

describe('deepbook local Pyth reference ids', () => {
	it('matches the DeepBook sandbox oracle feed ids without the 0x prefix', () => {
		expect(SUI_PRICE_FEED_ID).toBe(
			'23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744',
		);
		expect(DEEP_PRICE_FEED_ID).toBe(
			'29bdd5248234e33bd93d3b81100b5fa32eaa5997843847e2c2cb16d7c6d9f7ff',
		);
		expect(USDC_PRICE_FEED_ID).toBe(
			'eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',
		);
	});

	it('decodes sandbox feed ids from base64 JSON bytes', () => {
		expect(feedIdFromJson(pythJson(toBase64(fromHex(SUI_PRICE_FEED_ID))))).toBe(SUI_PRICE_FEED_ID);
	});

	it('decodes gRPC feed ids from numeric JSON byte arrays', () => {
		expect(feedIdFromJson(pythJson(Array.from(fromHex(DEEP_PRICE_FEED_ID))))).toBe(
			DEEP_PRICE_FEED_ID,
		);
	});

	it('ignores malformed feed id bytes', () => {
		expect(feedIdFromJson(pythJson('not-base64'))).toBeNull();
		expect(feedIdFromJson(pythJson([0, 256]))).toBeNull();
		expect(feedIdFromJson(pythJson([]))).toBeNull();
		expect(feedIdFromJson({})).toBeNull();
	});
});
