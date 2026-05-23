import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit, Schema } from 'effect';

import {
	decodeConfig,
	decodeConfigSync,
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

	it('wraps Effect Schema decode failures in the same config issue shape', () => {
		const DatabaseConfig = Schema.Struct({
			name: Schema.String,
			port: Schema.Number,
		});

		expect(
			decodeConfigSync(
				DatabaseConfig,
				{ name: 'postgres', port: 5432 },
				{
					field: 'postgres',
					mkError: testConfigError,
				},
			),
		).toEqual({ name: 'postgres', port: 5432 });

		expect(() =>
			decodeConfigSync(
				DatabaseConfig,
				{ name: 'postgres', port: '5432' },
				{
					field: 'postgres',
					mkError: testConfigError,
				},
			),
		).toThrowError(
			expect.objectContaining({
				_tag: 'TestConfigError',
				field: 'postgres',
				message: 'failed to decode config value',
			}),
		);
	});

	it.effect('decodes Effect Schema values through the typed error channel', () =>
		Effect.gen(function* () {
			const DatabaseConfig = Schema.Struct({
				name: Schema.String,
				port: Schema.Number,
			});

			const decoded = yield* decodeConfig(
				DatabaseConfig,
				{ name: 'postgres', port: 5432 },
				{
					field: 'postgres',
					mkError: testConfigError,
				},
			);
			expect(decoded).toEqual({ name: 'postgres', port: 5432 });

			const exit = yield* Effect.exit(
				decodeConfig(
					DatabaseConfig,
					{ name: 'postgres', port: '5432' },
					{
						field: 'postgres',
						mkError: testConfigError,
					},
				),
			);
			expect(Exit.isFailure(exit)).toBe(true);
		}),
	);
});
