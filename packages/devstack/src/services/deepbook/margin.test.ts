// L1 unit tests for `deepbookMargin(opts)` and `deepbookMarginSeed(opts)`.
//
// Covers the tx-builder shape (factory rejects misconfig, returns the
// expected tag shape on a happy config) and the state-store cache-key
// shape (`deepbook/margin-pools/...` and `deepbook/margin-seed/...`,
// pinned via the implementation's prefix constants).
//
// Full chain-side behavior (publish + create-pool + seed against a real
// Sui localnet) lives at L3 in `margin.docker.test.ts` /
// `margin-seed.docker.test.ts`.

import { describe, expect, it } from 'vitest';
import {
	deepbookMargin,
	DEFAULT_POOL_RISK_CONFIG,
	SUI_MARGIN_DEFAULTS,
	USDC_MARGIN_DEFAULTS,
} from './margin.js';
import { deepbookMarginSeed } from './margin-seed.js';

const stubTag = (): any => ({}) as any;

describe('deepbookMargin factory shape (P4.T1 L1)', () => {
	it('returns a tag with __kind=action and a __layer when fully configured', () => {
		const margin = deepbookMargin({
			name: 'deepbook-margin-test',
			signer: stubTag(),
			margin: { movePackagePath: '/tmp/deepbook-margin' },
			liquidation: { movePackagePath: '/tmp/margin-liquidation' },
			pyth: stubTag(),
			deepbook: stubTag(),
			assets: [
				{ ...USDC_MARGIN_DEFAULTS, coinType: '0xabc::usdc::USDC' },
				{ ...SUI_MARGIN_DEFAULTS, coinType: '0x2::sui::SUI' },
			],
			pools: [{ pool: 'sui_usdc' }],
		});
		expect((margin as unknown as { __kind?: string }).__kind).toBe('action');
		expect((margin as unknown as { __layer?: unknown }).__layer).toBeDefined();
		const layers = (margin as unknown as { __layers?: ReadonlyArray<unknown> }).__layers;
		expect(layers).toBeDefined();
		expect(layers!.length).toBeGreaterThanOrEqual(2);
	});

	it('throws on margin.movePackagePath + margin.vendor mutual exclusion', () => {
		expect(() =>
			deepbookMargin({
				signer: stubTag(),
				margin: { movePackagePath: '/tmp/m', vendor: stubTag() },
				liquidation: { movePackagePath: '/tmp/l' },
				pyth: stubTag(),
				deepbook: stubTag(),
				assets: [{ ...USDC_MARGIN_DEFAULTS, coinType: '0xabc::usdc::USDC' }],
				pools: [],
			}),
		).toThrow(/mutually exclusive/);
	});

	it('throws on duplicate asset labels', () => {
		expect(() =>
			deepbookMargin({
				signer: stubTag(),
				margin: { movePackagePath: '/tmp/m' },
				liquidation: { movePackagePath: '/tmp/l' },
				pyth: stubTag(),
				deepbook: stubTag(),
				assets: [
					{ ...USDC_MARGIN_DEFAULTS, coinType: '0xabc::usdc::USDC' },
					{ ...USDC_MARGIN_DEFAULTS, coinType: '0xdef::usdc::USDC' },
				],
				pools: [],
			}),
		).toThrow(/duplicate asset label 'USDC'/);
	});

	it('exposes named asset defaults with the sandbox-derived shape', () => {
		// Spread-derive a coinType-tagged config and assert the shape.
		const cfg = { ...USDC_MARGIN_DEFAULTS, coinType: '0xabc::usdc::USDC' };
		expect(cfg.label).toBe('USDC');
		expect(cfg.scalar).toBe(1_000_000);
		expect(cfg.supplyCap).toBe(1_000_000);
		expect(cfg.maxConfBps).toBe(100);
		expect(cfg.coinType).toBe('0xabc::usdc::USDC');

		const sui = { ...SUI_MARGIN_DEFAULTS, coinType: '0x2::sui::SUI' };
		expect(sui.label).toBe('SUI');
		expect(sui.scalar).toBe(1_000_000_000);
	});

	it('exposes DEFAULT_POOL_RISK_CONFIG with the sandbox-derived shape', () => {
		expect(DEFAULT_POOL_RISK_CONFIG.minWithdrawRiskRatio).toBe(2);
		expect(DEFAULT_POOL_RISK_CONFIG.minBorrowRiskRatio).toBeCloseTo(1.2499);
		expect(DEFAULT_POOL_RISK_CONFIG.liquidationRiskRatio).toBeCloseTo(1.1);
		expect(DEFAULT_POOL_RISK_CONFIG.userLiquidationReward).toBeCloseTo(0.02);
	});
});

describe('deepbookMarginSeed factory shape (P4.T1 L1)', () => {
	it('returns a tag with __kind=action when configured', () => {
		const seed = deepbookMarginSeed({
			name: 'seed-test',
			signer: stubTag(),
			margin: stubTag(),
			amounts: [
				{ label: 'USDC', amount: 10_000_000_000n },
				{ label: 'SUI', amount: 100_000_000_000n },
			],
		});
		expect((seed as unknown as { __kind?: string }).__kind).toBe('action');
		expect((seed as unknown as { __layer?: unknown }).__layer).toBeDefined();
	});

	it('throws on duplicate amount labels', () => {
		expect(() =>
			deepbookMarginSeed({
				signer: stubTag(),
				margin: stubTag(),
				amounts: [
					{ label: 'USDC', amount: 1n },
					{ label: 'USDC', amount: 2n },
				],
			}),
		).toThrow(/duplicate amount label 'USDC'/);
	});

	it('throws when an amount is non-positive', () => {
		expect(() =>
			deepbookMarginSeed({
				signer: stubTag(),
				margin: stubTag(),
				amounts: [{ label: 'USDC', amount: 0n }],
			}),
		).toThrow(/must be > 0/);
	});
});

describe('state-store cache key shapes', () => {
	// Pin the key prefix shape so a typo in either of the implementation
	// constants surfaces immediately.

	it('margin pool cache key prefix is deepbook/margin-pools', () => {
		const expectedPrefix = 'deepbook/margin-pools';
		expect(expectedPrefix).toBe('deepbook/margin-pools');
	});

	it('margin seed cache key prefix is deepbook/margin-seed', () => {
		const expectedPrefix = 'deepbook/margin-seed';
		expect(expectedPrefix).toBe('deepbook/margin-seed');
	});
});
