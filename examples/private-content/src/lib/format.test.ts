import { describe, expect, it } from 'vitest';
import {
	arraysEqual,
	bytesToHex,
	bytesToString,
	hexToBytes,
	shortAddress,
	stringToBytes,
} from './format.ts';

describe('stringToBytes / bytesToString', () => {
	it('round-trips ASCII', () => {
		const s = 'hello world';
		expect(bytesToString(stringToBytes(s))).toBe(s);
	});

	it('round-trips unicode (multi-byte) content', () => {
		const s = 'secret · ☃ · 日本語';
		const bytes = stringToBytes(s);
		// `·` and these glyphs are multi-byte, so the encoded length exceeds
		// the JS string length.
		expect(bytes.length).toBeGreaterThan(s.length);
		expect(bytesToString(bytes)).toBe(s);
	});

	it('round-trips the empty string', () => {
		expect(bytesToString(stringToBytes(''))).toBe('');
		expect(stringToBytes('').length).toBe(0);
	});
});

describe('bytesToHex / hexToBytes', () => {
	it('encodes bytes to zero-padded lowercase hex', () => {
		expect(bytesToHex(new Uint8Array([0, 1, 15, 16, 255]))).toBe('00010f10ff');
	});

	it('returns empty string for empty input', () => {
		expect(bytesToHex(new Uint8Array([]))).toBe('');
	});

	it('round-trips bytes → hex → bytes', () => {
		const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x7f]);
		expect(arraysEqual(hexToBytes(bytesToHex(bytes)), bytes)).toBe(true);
	});

	it('parses hex with a 0x prefix', () => {
		expect(arraysEqual(hexToBytes('0xdeadbeef'), new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toBe(
			true,
		);
	});

	it('parses hex without a prefix', () => {
		expect(arraysEqual(hexToBytes('deadbeef'), new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toBe(
			true,
		);
	});

	it('throws on odd-length hex', () => {
		expect(() => hexToBytes('abc')).toThrow(/odd length/);
		expect(() => hexToBytes('0xabc')).toThrow(/odd length/);
	});
});

describe('arraysEqual', () => {
	it('is true for identical contents', () => {
		expect(arraysEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
	});

	it('is true for two empty arrays', () => {
		expect(arraysEqual(new Uint8Array([]), new Uint8Array([]))).toBe(true);
	});

	it('is false when contents differ at the same length', () => {
		expect(arraysEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
	});

	it('is false when lengths mismatch', () => {
		expect(arraysEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
	});
});

describe('shortAddress', () => {
	it('truncates a long address with head + tail and an ellipsis', () => {
		const addr = `0x${'a'.repeat(60)}1234`;
		// default head=6, tail=4 → "0x" + first 6 + "…" + last 4
		expect(shortAddress(addr)).toBe('0xaaaaaa…1234');
	});

	it('honors custom head/tail lengths', () => {
		const addr = `0x${'b'.repeat(60)}cdef`;
		expect(shortAddress(addr, 4, 2)).toBe('0xbbbb…ef');
	});

	it('returns short addresses unchanged', () => {
		expect(shortAddress('0x1234')).toBe('0x1234');
		// At the head + tail + 2 boundary (length 12) it is returned as-is.
		expect(shortAddress('0x1234567890')).toBe('0x1234567890');
	});
});
