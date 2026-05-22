import { describe, expect, it } from '@effect/vitest';

import { pickCreatedCoin } from '../../../src/plugins/coin/mint.ts';

const SUI_FRAMEWORK_PADDED = '0x0000000000000000000000000000000000000000000000000000000000000002';

describe('plugins/coin/mint', () => {
	it('finds minted coins when objectTypes use the padded Sui framework address', () => {
		const minted = pickCreatedCoin(
			[
				{
					type: 'created',
					objectId: '0xcoin',
					objectType: `${SUI_FRAMEWORK_PADDED}::coin::Coin<0xabc::deep::DEEP>`,
				},
			],
			'0xabc::deep::DEEP',
		);

		expect(minted).toBe('0xcoin');
	});

	it('normalizes the package address when matching the inner coin type', () => {
		const minted = pickCreatedCoin(
			[
				{
					type: 'created',
					objectId: '0xcoin',
					objectType: `${SUI_FRAMEWORK_PADDED}::coin::Coin<0x0000000000000000000000000000000000000000000000000000000000000abc::deep::DEEP>`,
				},
			],
			'0xabc::deep::DEEP',
		);

		expect(minted).toBe('0xcoin');
	});
});
