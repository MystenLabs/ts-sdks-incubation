import { describe, expect, it } from 'vitest';

import { takePositional, takeValueFlag } from '../../../src/surfaces/cli/flags.ts';
import { CliUsageError } from '../../../src/surfaces/cli/errors.ts';

describe('subcommand-flag helpers', () => {
	it('takePositional pops first non-flag', () => {
		const r = takePositional(['--foo', 'bar', '--baz']);
		expect(r.head).toBe('bar');
		expect(r.tail).toEqual(['--foo', '--baz']);
	});

	it('takeValueFlag supports inline =', () => {
		const r = takeValueFlag(['--label=v1', 'rest'], 'label');
		expect(r.value).toBe('v1');
		expect(r.tail).toEqual(['rest']);
	});

	it('takeValueFlag supports space-separated', () => {
		const r = takeValueFlag(['--label', 'v1', 'rest'], 'label');
		expect(r.value).toBe('v1');
		expect(r.tail).toEqual(['rest']);
	});

	it('takeValueFlag rejects missing values', () => {
		expect(() => takeValueFlag(['--label'], 'label')).toThrow(CliUsageError);
	});
});
