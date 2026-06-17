import { describe, expect, it } from 'vitest';

import { formatStudio, parseStudioAmount, shortAddress } from './amount.ts';

// STUDIO has 6 decimals, so 1 STUDIO == 1_000_000 raw units.
const ONE = 1_000_000n;

describe('parseStudioAmount', () => {
	it('parses whole numbers into raw units', () => {
		expect(parseStudioAmount('1')).toBe(ONE);
		expect(parseStudioAmount('17')).toBe(17n * ONE);
		expect(parseStudioAmount('0')).toBe(0n);
	});

	it('parses fractional amounts with full 6-decimal precision', () => {
		expect(parseStudioAmount('1.5')).toBe(1_500_000n);
		expect(parseStudioAmount('0.000001')).toBe(1n);
		expect(parseStudioAmount('0.123456')).toBe(123_456n);
	});

	it('trims surrounding whitespace and treats empty input as zero', () => {
		expect(parseStudioAmount('  2.25  ')).toBe(2_250_000n);
		expect(parseStudioAmount('')).toBe(0n);
		expect(parseStudioAmount('   ')).toBe(0n);
	});

	it('round-trips with formatStudio', () => {
		const raw = parseStudioAmount('3.14');
		// formatStudio defaults to 2 fraction digits.
		expect(formatStudio(raw)).toBe('3.14');
		expect(formatStudio(parseStudioAmount('100'))).toBe('100.00');
	});

	it('throws on negative, non-numeric, or over-precise input', () => {
		expect(() => parseStudioAmount('-1')).toThrow();
		expect(() => parseStudioAmount('abc')).toThrow();
		expect(() => parseStudioAmount('1.2.3')).toThrow();
		// More than 6 decimal places is rejected.
		expect(() => parseStudioAmount('1.1234567')).toThrow();
		expect(() => parseStudioAmount('1e3')).toThrow();
		// A leading-dot fraction with no whole part is rejected (regex needs \d+).
		expect(() => parseStudioAmount('.5')).toThrow();
	});
});

describe('formatStudio', () => {
	it('formats whole and fractional raw amounts (default 2 digits)', () => {
		expect(formatStudio(0n)).toBe('0.00');
		expect(formatStudio(ONE)).toBe('1.00');
		expect(formatStudio(1_500_000n)).toBe('1.50');
	});

	it('truncates (does not round) to the requested fraction digits', () => {
		// 1.239999 raw -> truncated to 2 digits -> "1.23", not "1.24".
		expect(formatStudio(1_239_999n)).toBe('1.23');
	});

	it('honors a custom fractionDigits argument', () => {
		expect(formatStudio(1_234_560n, 6)).toBe('1.234560');
		expect(formatStudio(1_234_560n, 0)).toBe('1.');
	});

	it('accepts string and number inputs', () => {
		expect(formatStudio('1000000')).toBe('1.00');
		expect(formatStudio(1_000_000)).toBe('1.00');
	});
});

describe('shortAddress', () => {
	it('truncates a long address with an ellipsis', () => {
		const addr = '0x' + 'a'.repeat(64);
		const result = shortAddress(addr);
		expect(result).toBe(`0x${'a'.repeat(6)}…${'a'.repeat(4)}`);
	});

	it('returns short addresses unchanged', () => {
		expect(shortAddress('0x1234')).toBe('0x1234');
	});

	it('respects custom head and tail lengths', () => {
		const addr = '0x' + 'b'.repeat(40);
		expect(shortAddress(addr, 4, 2)).toBe(`0x${'b'.repeat(4)}…${'b'.repeat(2)}`);
	});
});
