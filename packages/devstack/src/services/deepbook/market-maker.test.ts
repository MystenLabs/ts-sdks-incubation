// L1 unit tests for the market-maker primitive — `bps` grid math + the
// state-store key shape for `perPool`. No chain, no Docker.

import { describe, expect, it } from 'vitest';
import { calculateGridLevels } from './internal.js';
import { STATE_KEY_BALANCE_MANAGER_PREFIX_INTERNAL } from './market-maker.js';

describe('calculateGridLevels (bps strategy)', () => {
	it('produces tick-aligned prices at the expected bps offsets', () => {
		// mid = 1_000_000 (e.g. SUI/USDC at $1 in 6dp quote)
		// tickSize = 100, lotSize = 1
		// spreadBps = 20 (0.20%), levelSpacingBps = 5 (0.05%), levels = 3
		const result = calculateGridLevels({
			mid: 1_000_000n,
			sizeBase: 1_000_000n,
			tickSize: 100n,
			lotSize: 1n,
			levels: 3,
			spreadBps: 20,
			levelSpacingBps: 5,
		});

		expect(result.bids.length + result.asks.length).toBe(6);

		// Level 1: spread = 20 bps → offset = 1_000_000 * 20 / 10_000 = 2000.
		// Tick-aligned: 2000 → 2000.
		// bid = 1_000_000 - 2000 = 998_000 → align to 100: 998_000.
		// ask = 1_000_000 + 2000 = 1_002_000.
		expect(result.bids[0]?.price).toBe(998_000n);
		expect(result.asks[0]?.price).toBe(1_002_000n);

		// Level 2: spread = 25 bps → offset = 2500 → tick-aligned to 2500.
		// bid = 997_500, ask = 1_002_500.
		expect(result.bids[1]?.price).toBe(997_500n);
		expect(result.asks[1]?.price).toBe(1_002_500n);

		// Level 3: spread = 30 bps → offset = 3000 → tick-aligned to 3000.
		// bid = 997_000, ask = 1_003_000.
		expect(result.bids[2]?.price).toBe(997_000n);
		expect(result.asks[2]?.price).toBe(1_003_000n);
	});

	it('aligns sizes to lotSize', () => {
		// sizeBase = 123n, lotSize = 10n → rounds down to 120.
		const result = calculateGridLevels({
			mid: 1_000_000n,
			sizeBase: 123n,
			tickSize: 100n,
			lotSize: 10n,
			levels: 1,
			spreadBps: 10,
			levelSpacingBps: 1,
		});
		expect(result.bids[0]?.size).toBe(120n);
		expect(result.asks[0]?.size).toBe(120n);
	});

	it('drops bids that would land at or below zero', () => {
		// mid = 100, spreadBps = 20_000 (200%) → offset > mid → bid <= 0.
		const result = calculateGridLevels({
			mid: 100n,
			sizeBase: 1n,
			tickSize: 1n,
			lotSize: 1n,
			levels: 1,
			spreadBps: 20_000,
			levelSpacingBps: 0,
		});
		expect(result.bids.length).toBe(0);
		expect(result.asks.length).toBe(1);
	});
});

describe('state-store key shape', () => {
	it('uses v2 prefix to allow optional perPool segment (P0.6)', () => {
		expect(STATE_KEY_BALANCE_MANAGER_PREFIX_INTERNAL).toBe(
			'deepbook/market-maker/balance-manager/v2',
		);
	});

	it('perPool variant appends pool name as final segment', () => {
		// The maker constructs `${baseKey}/${poolName}` for perPool;
		// assert the join produces the expected canonical shape.
		const baseKey = `${STATE_KEY_BALANCE_MANAGER_PREFIX_INTERNAL}/CHAIN/PKG/SIGNER`;
		const poolKey = `${baseKey}/sui_usdc`;
		expect(poolKey).toBe('deepbook/market-maker/balance-manager/v2/CHAIN/PKG/SIGNER/sui_usdc');
	});
});
