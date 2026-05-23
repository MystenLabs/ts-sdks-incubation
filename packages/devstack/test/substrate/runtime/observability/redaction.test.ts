import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';

import {
	Redactor,
	layerRedactor,
	redactText,
	redactValue,
} from '../../../../src/substrate/runtime/observability/redaction.ts';

describe('redaction helpers', () => {
	it('redacts literal and regex rules in plain text', () => {
		const redacted = redactText('password=abc token=123', [
			{ kind: 'literal', value: 'abc' },
			{ kind: 'pattern', pattern: /(token=)[0-9]+/g, replacement: '$1<hidden>' },
		]);

		expect(redacted).toBe('password=<redacted> token=<hidden>');
	});

	it('redacts nested structured values without mutating the source', () => {
		const source = {
			url: 'http://wallet.local/#token=abcdef',
			nested: ['abcdef', { ok: true }],
		};

		const redacted = redactValue(source, [{ kind: 'literal', value: 'abcdef' }]);

		expect(redacted).toEqual({
			url: 'http://wallet.local/#token=<redacted>',
			nested: ['<redacted>', { ok: true }],
		});
		expect(source.nested[0]).toBe('abcdef');
	});

	it.effect('registers rules in the Redactor service', () =>
		Effect.gen(function* () {
			const redactor = yield* Redactor;
			yield* redactor.register({ kind: 'literal', value: 'secret' });
			const out = yield* redactor.redact('value=secret');
			expect(out).toBe('value=<redacted>');
		}).pipe(Effect.provide(layerRedactor)),
	);
});
