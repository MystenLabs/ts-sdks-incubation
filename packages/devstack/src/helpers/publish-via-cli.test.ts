import { describe, expect, it } from 'vitest';
import { extractTrailingJson, stripEnvSections } from './publish-via-cli.js';

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

describe('stripEnvSections', () => {
	it('removes [env] and [env.<name>] sections, keeps the rest', () => {
		const src = `[move]
version = 3

[[move.package]]
id = "Sui"
source = { git = "x" }

[env]

[env.testnet]
chain-id = "4c78adac"
original-published-id = "0x36dbef"

[env.mainnet]
chain-id = "35834a8a"
original-published-id = "0xdeeb7a"
`;
		const out = stripEnvSections(src);
		expect(out).not.toMatch(/\[env/);
		expect(out).toContain('[move]');
		expect(out).toContain('[[move.package]]');
	});

	it('is idempotent on input without env sections', () => {
		const src = `[move]
version = 4

[pinned.testnet.token]
source = { git = "x" }
`;
		expect(stripEnvSections(src)).toBe(src);
	});

	it('does not strip sections that merely contain `env` in their name', () => {
		const src = `[envelope]
foo = "bar"

[move.environments]
x = "y"
`;
		expect(stripEnvSections(src)).toBe(src);
	});
});
