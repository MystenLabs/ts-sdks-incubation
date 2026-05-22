import { describe, expect, it } from 'vitest';

import { takeBoolFlag, takePositional, takeValueFlag } from '../../../src/surfaces/cli/flags.ts';
import { CliUsageError } from '../../../src/surfaces/cli/errors.ts';

describe('subcommand-flag helpers', () => {
	it('takePositional pops first non-flag', () => {
		const r = takePositional(['--foo', 'bar', '--baz']);
		expect(r.head).toBe('bar');
		expect(r.tail).toEqual(['--foo', '--baz']);
	});

	it('takeBoolFlag matches long form', () => {
		const r = takeBoolFlag(['a', '--include-images', 'b'], 'include-images');
		expect(r.present).toBe(true);
		expect(r.tail).toEqual(['a', 'b']);
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
