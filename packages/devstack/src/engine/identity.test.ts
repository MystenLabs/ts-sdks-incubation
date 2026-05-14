import { describe, expect, it } from 'vitest';

import { canonicalize, computeInputHash, hash } from './identity.js';

describe('canonicalize', () => {
	it('sorts object keys for stable output', () => {
		expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
	});

	it('omits undefined values', () => {
		expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
	});

	it('preserves array order', () => {
		expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
	});

	it('handles nested objects', () => {
		expect(canonicalize({ a: { x: 1, y: 2 } })).toBe(canonicalize({ a: { y: 2, x: 1 } }));
	});

	it('treats null and undefined identically at top level', () => {
		expect(canonicalize(null)).toBe('null');
		expect(canonicalize(undefined)).toBe('null');
	});

	it('serializes bigint as decimal string', () => {
		expect(canonicalize(42n)).toBe('"42"');
	});
});

describe('hash', () => {
	it('is deterministic', () => {
		expect(hash({ a: 1 })).toBe(hash({ a: 1 }));
	});

	it('differs across content', () => {
		expect(hash({ a: 1 })).not.toBe(hash({ a: 2 }));
	});

	it('is invariant to key order', () => {
		expect(hash({ a: 1, b: 2 })).toBe(hash({ b: 2, a: 1 }));
	});

	it('returns hex sha-256 (64 chars)', () => {
		expect(hash('x')).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe('computeInputHash', () => {
	it('changes when an upstream identity changes', () => {
		const a = computeInputHash({ upstreamIdentities: ['id-1'], ownInputs: undefined });
		const b = computeInputHash({ upstreamIdentities: ['id-2'], ownInputs: undefined });
		expect(a).not.toBe(b);
	});

	it('changes when own inputs change', () => {
		const a = computeInputHash({ upstreamIdentities: ['id-1'], ownInputs: { v: 1 } });
		const b = computeInputHash({ upstreamIdentities: ['id-1'], ownInputs: { v: 2 } });
		expect(a).not.toBe(b);
	});

	it('is order-sensitive on upstream identities (positional)', () => {
		const a = computeInputHash({ upstreamIdentities: ['x', 'y'], ownInputs: undefined });
		const b = computeInputHash({ upstreamIdentities: ['y', 'x'], ownInputs: undefined });
		expect(a).not.toBe(b);
	});
});
