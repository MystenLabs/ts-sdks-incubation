import { describe, expect, it } from '@effect/vitest';

import { formatUnknownError } from '../../../src/substrate/runtime/format-unknown-error.ts';

describe('formatUnknownError', () => {
	it('returns a string as-is', () => {
		expect(formatUnknownError('boom')).toBe('boom');
	});

	it('uses an Error message', () => {
		expect(formatUnknownError(new Error('plain failure'))).toBe('plain failure');
	});

	// The headline fix: a thrown `new Error(msg, { cause })` must surface the
	// chained root, not just the wrapper. Before, Error short-circuited to
	// `.message` and dropped `.cause` entirely.
	it('walks Error.cause when the cause is another Error', () => {
		const err = new Error('build step failed', { cause: new Error('compiler not found') });
		expect(formatUnknownError(err)).toBe('build step failed [cause: compiler not found]');
	});

	it('walks Error.cause when the cause is a tagged object', () => {
		const err = new Error('publish failed', {
			cause: { _tag: 'SuiPluginError', message: 'fork binary panicked' },
		});
		expect(formatUnknownError(err)).toBe('publish failed [cause: fork binary panicked]');
	});

	// Tagged devstack errors (AccountSignError, SuiPluginError, …) are plain
	// objects, NOT Error instances — `String(obj)` yields `[object Object]`.
	// We must prefer their `.message`.
	it('prefers a tagged object .message over [object Object]', () => {
		expect(
			formatUnknownError({ _tag: 'AccountSignError', message: 'no SUI gas coins for 0xabc' }),
		).toBe('no SUI gas coins for 0xabc');
	});

	it('chains a tagged object .cause into the message', () => {
		const cause = {
			_tag: 'AccountSignError',
			message: 'submit failed',
			cause: { _tag: 'SuiPluginError', message: 'no SUI gas coins for 0xabc' },
		};
		expect(formatUnknownError(cause)).toBe('submit failed [cause: no SUI gas coins for 0xabc]');
	});

	it('does not append a cause already present in the message', () => {
		const cause = { message: 'failed: root detail', cause: 'root detail' };
		expect(formatUnknownError(cause)).toBe('failed: root detail');
	});

	// A raw detail bag (no human-readable `.message`) is not spliced into the
	// headline — it falls back to JSON so the structured formatter can still
	// render it without dumping `[object Object]`.
	it('JSON-stringifies an object with no message field', () => {
		expect(formatUnknownError({ sender: '0xabc', objectCount: 3 })).toBe(
			'{"sender":"0xabc","objectCount":3}',
		);
	});

	// A deep (or cyclic) chain must terminate: the walk is bounded so it can't
	// produce a runaway string or loop forever.
	it('bounds the cause walk depth', () => {
		let chain: Error = new Error('leaf');
		for (let i = 0; i < 8; i++) {
			chain = new Error(`wrap${i}`, { cause: chain });
		}
		const out = formatUnknownError(chain);
		expect(out.startsWith('wrap7')).toBe(true);
		// Reaches a few levels deep…
		expect(out).toContain('wrap2');
		// …but stops before exhausting the chain — proving the depth bound.
		expect(out).not.toContain('wrap1');
		expect(out).not.toContain('leaf');
	});

	it('survives a self-referential cause without looping', () => {
		const cyclic: { message: string; cause?: unknown } = { message: 'cyclic' };
		cyclic.cause = cyclic;
		const out = formatUnknownError(cyclic);
		expect(out.startsWith('cyclic')).toBe(true);
	});
});
