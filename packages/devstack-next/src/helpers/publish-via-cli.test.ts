import { describe, expect, it } from 'vitest';
import { extractTrailingJson } from './publish-via-cli.js';

describe('extractTrailingJson', () => {
	it('returns the input verbatim when it begins with `{`', () => {
		const json = '{"modules":["a","b"],"dependencies":["0x1"]}';
		expect(extractTrailingJson(json)).toBe(json);
	});

	it('strips leading warnings + non-JSON noise to reach the trailing object', () => {
		const noisy = `Updating Cargo lock...
Note: skipping fee analysis (sui_only mode)
{"modules":["m"],"dependencies":[]}
`;
		const out = JSON.parse(extractTrailingJson(noisy)) as {
			modules: string[];
			dependencies: string[];
		};
		expect(out.modules).toEqual(['m']);
		expect(out.dependencies).toEqual([]);
	});

	it('returns trimmed input when no JSON object is present', () => {
		expect(extractTrailingJson('  no braces here  \n')).toBe('no braces here');
	});
});
