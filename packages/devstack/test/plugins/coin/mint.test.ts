import { describe, expect, it } from '@effect/vitest';

import { buildMintContentHash, pickCreatedCoin } from '../../../src/plugins/coin/mint.ts';

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

	describe('buildMintContentHash', () => {
		const baseParts = {
			treasuryCapId: '0xcap',
			recipient: '0xalice',
			amount: 100n,
		};

		it('folds signerAddress into the cache key (backlog #6)', () => {
			// Regression: the original key omitted the signer, so re-running
			// `(treasuryCap, recipient, amount)` under a NEW signer would
			// hit the prior cache entry and short-circuit the mint with a
			// stale digest. The signer is part of the cache identity —
			// distinct signers MUST produce distinct content hashes.
			const a = buildMintContentHash({ ...baseParts, signerAddress: '0xsignerA' });
			const b = buildMintContentHash({ ...baseParts, signerAddress: '0xsignerB' });

			expect(a).not.toBe(b);
		});

		it('is stable for identical inputs (idempotent)', () => {
			const a = buildMintContentHash({ ...baseParts, signerAddress: '0xsigner' });
			const b = buildMintContentHash({ ...baseParts, signerAddress: '0xsigner' });

			expect(a).toBe(b);
		});

		it('still distinguishes treasuryCapId / recipient / amount columns', () => {
			const baseline = buildMintContentHash({ ...baseParts, signerAddress: '0xsigner' });

			expect(
				buildMintContentHash({ ...baseParts, treasuryCapId: '0xother', signerAddress: '0xsigner' }),
			).not.toBe(baseline);
			expect(
				buildMintContentHash({ ...baseParts, recipient: '0xbob', signerAddress: '0xsigner' }),
			).not.toBe(baseline);
			expect(
				buildMintContentHash({ ...baseParts, amount: 101n, signerAddress: '0xsigner' }),
			).not.toBe(baseline);
		});
	});
});
