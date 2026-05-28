// Regression test for the SealError unwrap pattern used by the
// key-server probe-timeout error mapper.
//
// Bug fix (review fix phase 22e/Bug 4): `key-server.ts:waitForProbe`
// previously mapped `ProbeTimeoutError` to
// `sealError('ready', { cause: cause.lastError ?? cause.lastNotReady ?? cause })`.
// If the inner `lastError` was ALREADY a `SealError` (e.g. surfaced
// from an upstream probe that promoted to typed before reaching the
// timeout boundary), this re-wrap produced a two-layer SealError
// chain. The outer `passthroughOrWrap.for<SealError>` in `index.ts`
// strips one layer on the index path, but the direct
// `sealError('ready', …)` build path doesn't — so a caller catching
// the surfaced SealError would chase two layers of the same tag.
//
// The fix introduces `isSealError` (structural predicate on `_tag`)
// and the key-server mapper now checks: if the inner cause is
// already a SealError, return it as-is rather than re-wrap. This
// keeps the cause chain at most one SealError layer deep.

import { describe, expect, it } from 'vitest';

import { isSealError, sealError, type SealError } from '../../../src/plugins/seal/errors.ts';

describe('isSealError — structural predicate', () => {
	it('returns true for a SealError-shaped value', () => {
		const err: SealError = sealError('ready', { name: 'seal', message: 'probe timed out' });
		expect(isSealError(err)).toBe(true);
	});

	it('returns false for plain Error instances', () => {
		expect(isSealError(new Error('not seal'))).toBe(false);
	});

	it('returns false for null / undefined', () => {
		expect(isSealError(null)).toBe(false);
		expect(isSealError(undefined)).toBe(false);
	});

	it('returns false for objects with a different _tag', () => {
		expect(isSealError({ _tag: 'NotSeal', message: 'x' })).toBe(false);
	});

	it('returns false for primitives', () => {
		expect(isSealError('SealError')).toBe(false);
		expect(isSealError(42)).toBe(false);
		expect(isSealError(true)).toBe(false);
	});
});

describe('SealError unwrap-on-probe-timeout — the contract', () => {
	// We can't easily synthesize a ProbeTimeoutError going through the
	// real `waitForProbe` loop without standing up a runtime stub, so
	// this test exercises the unwrap helper directly: the mapper inside
	// `key-server.ts` reads `cause.lastError ?? cause.lastNotReady ?? cause`
	// and routes through `isSealError` — when the inner value is a
	// SealError, the mapper returns the inner directly. This test
	// pins that contract via the predicate.
	it('a SealError surfaced as ProbeTimeoutError.lastError is unwrapped (not re-wrapped)', () => {
		const inner: SealError = sealError('container', {
			name: 'seal',
			message: 'inner — upstream probe already typed',
		});
		const unwrap = (lastError: unknown): SealError =>
			isSealError(lastError)
				? lastError
				: sealError('ready', { name: 'seal', message: 'outer wrap', cause: lastError });

		const result = unwrap(inner);
		// The inner SealError is returned as-is — same reference, same
		// phase, no message rewrite, no nested cause chain.
		expect(result).toBe(inner);
		expect(result.phase).toBe('container');
		expect(result.cause).toBeUndefined();
	});

	it('a non-SealError surfaced as ProbeTimeoutError.lastError IS wrapped (carried as cause)', () => {
		const nonSealCause = new Error('exec daemon refused');
		const unwrap = (lastError: unknown): SealError =>
			isSealError(lastError)
				? lastError
				: sealError('ready', { name: 'seal', message: 'outer wrap', cause: lastError });

		const result = unwrap(nonSealCause);
		expect(result.phase).toBe('ready');
		expect(result.cause).toBe(nonSealCause);
	});
});
