import { describe, expect, it } from '@effect/vitest';

import {
	defineConfigError,
	expectNonEmptyArray,
	expectNonEmptyString,
	expectOneOf,
	expectPort,
} from '../../../src/substrate/runtime/config-validation.ts';

const testConfigError = defineConfigError('TestConfigError');

describe('config validation helpers', () => {
	it('throws plugin-tagged config issues for scalar validators', () => {
		expect(() =>
			expectNonEmptyString('', {
				field: 'name',
				mkError: testConfigError,
				hint: 'pass a service name',
			}),
		).toThrowError(
			expect.objectContaining({
				_tag: 'TestConfigError',
				field: 'name',
				message: 'must be a non-empty string',
				hint: 'pass a service name',
			}),
		);

		expect(() => expectPort(0, { field: 'port', mkError: testConfigError })).toThrowError(
			expect.objectContaining({
				_tag: 'TestConfigError',
				field: 'port',
				message: 'must be an integer between 1 and 65535',
			}),
		);
	});

	it('preserves literal unions and non-empty arrays', () => {
		const stream = expectOneOf('stderr', ['stdout', 'stderr', 'both'] as const, {
			field: 'stream',
			mkError: testConfigError,
		});
		const values = expectNonEmptyArray(['devstack'] as const, {
			field: 'databases',
			mkError: testConfigError,
		});

		expect(stream).toBe('stderr');
		expect(values).toEqual(['devstack']);
		expect(() =>
			expectOneOf('other', ['stdout', 'stderr', 'both'] as const, {
				field: 'stream',
				mkError: testConfigError,
			}),
		).toThrowError(
			expect.objectContaining({
				_tag: 'TestConfigError',
				field: 'stream',
				message: "must be one of 'stdout', 'stderr', 'both'",
			}),
		);
	});

});
