import { describe, expect, it } from 'vitest';
import {
	decimalsFromScalar,
	formatAge,
	formatCoinAmount,
	formatNumber,
	formatPercent,
	parseCoinAmount,
	shortId,
} from '../../src/lib/format.ts';

describe('decimalsFromScalar', () => {
	it('returns the base-10 exponent for valid power-of-10 scalars', () => {
		expect(decimalsFromScalar(1)).toBe(0);
		expect(decimalsFromScalar(10)).toBe(1);
		expect(decimalsFromScalar(1_000_000)).toBe(6);
		expect(decimalsFromScalar(1_000_000_000)).toBe(9);
	});

	it('throws on non-positive scalars', () => {
		expect(() => decimalsFromScalar(0)).toThrow(/Invalid coin scalar/);
		expect(() => decimalsFromScalar(-10)).toThrow(/Invalid coin scalar/);
	});

	it('throws on non-integer / unsafe scalars', () => {
		expect(() => decimalsFromScalar(1.5)).toThrow(/Invalid coin scalar/);
		expect(() => decimalsFromScalar(Number.MAX_SAFE_INTEGER + 2)).toThrow(/Invalid coin scalar/);
	});

	it('throws when the scalar is positive but not a power of 10', () => {
		expect(() => decimalsFromScalar(2)).toThrow(/not a power of 10/);
		expect(() => decimalsFromScalar(1500)).toThrow(/not a power of 10/);
	});
});

describe('formatCoinAmount', () => {
	const scalar = 1_000_000_000; // 9 decimals

	it('formats whole and fractional parts with default 4 fraction digits', () => {
		expect(formatCoinAmount(1_500_000_000n, scalar)).toBe('1.5000');
		expect(formatCoinAmount(1_000_000_000n, scalar)).toBe('1.0000');
		expect(formatCoinAmount(0n, scalar)).toBe('0.0000');
	});

	it('truncates the fraction to the requested fractionDigits', () => {
		// 1.123456789 -> only first 4 fractional digits kept
		expect(formatCoinAmount(1_123_456_789n, scalar)).toBe('1.1234');
	});

	it('accepts string and number raw inputs', () => {
		expect(formatCoinAmount('1500000000', scalar)).toBe('1.5000');
		expect(formatCoinAmount(1_500_000_000, scalar)).toBe('1.5000');
	});

	it('omits the decimal point when fractionDigits is 0', () => {
		expect(formatCoinAmount(1_500_000_000n, scalar, 0)).toBe('1');
	});

	it('propagates decimalsFromScalar validation errors', () => {
		expect(() => formatCoinAmount(1n, 0)).toThrow(/Invalid coin scalar/);
	});
});

describe('parseCoinAmount', () => {
	const scalar = 1_000_000_000; // 9 decimals

	it('parses whole and fractional input into base units', () => {
		expect(parseCoinAmount('1', scalar)).toBe(1_000_000_000n);
		expect(parseCoinAmount('1.5', scalar)).toBe(1_500_000_000n);
		expect(parseCoinAmount('0.000000001', scalar)).toBe(1n);
	});

	it('treats empty / whitespace input as zero', () => {
		expect(parseCoinAmount('', scalar)).toBe(0n);
		expect(parseCoinAmount('   ', scalar)).toBe(0n);
	});

	it('throws on negative, non-numeric, or over-precise input', () => {
		expect(() => parseCoinAmount('-1', scalar)).toThrow(/non-negative amount/);
		expect(() => parseCoinAmount('abc', scalar)).toThrow(/non-negative amount/);
		// 10 fractional digits > 9 allowed
		expect(() => parseCoinAmount('1.0000000001', scalar)).toThrow(/up to 9 decimal places/);
	});

	it('round-trips with formatCoinAmount', () => {
		const raw = parseCoinAmount('123.456', scalar);
		expect(formatCoinAmount(raw, scalar)).toBe('123.4560');
	});
});

describe('formatNumber', () => {
	it('returns n/a for non-finite values', () => {
		expect(formatNumber(NaN)).toBe('n/a');
		expect(formatNumber(Infinity)).toBe('n/a');
	});

	it('uses min 2 fraction digits for values >= 1', () => {
		expect(formatNumber(1)).toBe('1.00');
		expect(formatNumber(1234.5)).toBe('1,234.50');
	});

	it('drops trailing zeros for values below 1', () => {
		expect(formatNumber(0.5)).toBe('0.5');
		expect(formatNumber(0)).toBe('0');
	});
});

describe('formatPercent', () => {
	it('scales by 100 and appends a percent sign', () => {
		expect(formatPercent(0.5)).toBe('50.00%');
		expect(formatPercent(0.0125)).toBe('1.25%');
	});
});

describe('formatAge', () => {
	it('returns n/a for invalid durations', () => {
		expect(formatAge(NaN)).toBe('n/a');
		expect(formatAge(-1)).toBe('n/a');
	});

	it('formats seconds, minutes, and hours by magnitude', () => {
		expect(formatAge(30)).toBe('30s');
		expect(formatAge(120)).toBe('2m');
		expect(formatAge(7200)).toBe('2h');
	});
});

describe('shortId', () => {
	it('returns the id unchanged when short enough', () => {
		expect(shortId('0x1234')).toBe('0x1234');
	});

	it('truncates long ids with a middle ellipsis', () => {
		const id = '0x' + 'a'.repeat(60);
		const out = shortId(id);
		expect(out).toBe(`${id.slice(0, 10)}...${id.slice(-6)}`);
		expect(out).toContain('...');
	});
});
