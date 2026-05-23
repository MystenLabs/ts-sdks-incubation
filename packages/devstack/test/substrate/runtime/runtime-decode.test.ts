import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit, Option, Schema } from 'effect';

import {
	decodeJsonArrayElementSync,
	decodeJsonLines,
	decodeJsonText,
	type RuntimeDecodeIssue,
} from '../../../src/substrate/runtime/runtime-decode.ts';

const Doc = Schema.Struct({
	version: Schema.Literal(1),
	name: Schema.String,
});

const mkError = (issue: RuntimeDecodeIssue): RuntimeDecodeIssue => issue;

describe('runtime decode helpers', () => {
	it('parses and decodes JSON text with one boundary error shape', async () => {
		const decoded = await Effect.runPromise(
			decodeJsonText(Doc, '{"version":1,"name":"dev"}', {
				source: 'doc.json',
				mkError,
			}),
		);

		expect(decoded).toEqual({ version: 1, name: 'dev' });
	});

	it('decodes one element from JSON array outputs', () => {
		const decoded = decodeJsonArrayElementSync(Doc, '[{"version":1,"name":"first"}]', {
			source: 'docker inspect',
			mkError,
		});

		expect(decoded).toEqual({ version: 1, name: 'first' });
	});

	it('annotates JSON-line sources with line numbers', async () => {
		const exit = await Effect.runPromiseExit(
			decodeJsonLines(Doc, '{"version":1,"name":"ok"}\n{"version":2,"name":"bad"}', {
				source: 'lines',
				mkError,
			}),
		);

		expect(Exit.isFailure(exit)).toBe(true);
		const error = Exit.findErrorOption(exit);
		expect(Option.isSome(error)).toBe(true);
		if (Option.isSome(error)) {
			expect(error.value.source).toBe('lines:2');
		}
	});
});
