import { describe, expect, it } from 'vitest';
import { parseMoveToml } from './move-toml.js';

describe('parseMoveToml', () => {
	it('extracts the package name and dependency block', () => {
		const out = parseMoveToml(`
[package]
name = "deepbook"
version = "0.0.1"

[dependencies]
Sui = { git = "https://github.com/MystenLabs/sui.git", subdir = "crates/sui-framework/packages/sui-framework", rev = "framework/devnet" }
deep = { local = "../deep" }
		`);
		expect(out.packageName).toBe('deepbook');
		expect(out.deps).toHaveLength(2);
		expect(out.deps[0]).toEqual({
			kind: 'git',
			name: 'Sui',
			repo: 'MystenLabs/sui',
			rev: 'framework/devnet',
			subdir: 'crates/sui-framework/packages/sui-framework',
		});
		expect(out.deps[1]).toEqual({ kind: 'local', name: 'deep', path: '../deep' });
	});

	it('ignores other sections and tolerates comments + blank lines', () => {
		const out = parseMoveToml(`
# Pin upstream to v3.
[package]
name = "x"

[addresses]
foo = "0x0"

[dependencies]
# A comment between deps.
Foo = { git = "https://github.com/Owner/Repo.git", rev = "v1", subdir = "pkg" } # trailing
`);
		expect(out.deps).toEqual([
			{ kind: 'git', name: 'Foo', repo: 'Owner/Repo', rev: 'v1', subdir: 'pkg' },
		]);
	});

	it('treats subdir as empty when omitted', () => {
		const out = parseMoveToml(`
[dependencies]
Foo = { git = "https://github.com/Owner/Repo", rev = "main" }
`);
		expect(out.deps[0]).toMatchObject({ subdir: '' });
	});

	it('throws on git dep missing rev', () => {
		expect(() =>
			parseMoveToml(`[dependencies]\nFoo = { git = "https://github.com/Owner/Repo" }`),
		).toThrow(/no 'rev'/);
	});

	it('throws on dep with neither git nor local', () => {
		expect(() => parseMoveToml(`[dependencies]\nFoo = { something = "weird" }`)).toThrow(
			/neither 'git' nor 'local'/,
		);
	});

	it('parses ssh-form git URLs', () => {
		const out = parseMoveToml(`
[dependencies]
Foo = { git = "git@github.com:Owner/Repo.git", rev = "main" }
`);
		expect(out.deps[0]).toMatchObject({ repo: 'Owner/Repo' });
	});

	it('rejects host-impersonation URLs (regex anchored)', () => {
		// `github.com.evil.com/...` would have matched the unanchored regex
		// because it contains the substring `github.com/`. The ^ anchor
		// rules it out — surfaces as "cannot extract owner/repo".
		expect(() =>
			parseMoveToml(
				`[dependencies]\nFoo = { git = "https://github.com.evil.com/Owner/Repo", rev = "main" }`,
			),
		).toThrow(/cannot extract owner\/repo/);
		expect(() =>
			parseMoveToml(
				`[dependencies]\nFoo = { git = "https://evil.com/wrap/github.com/Owner/Repo", rev = "main" }`,
			),
		).toThrow(/cannot extract owner\/repo/);
	});

	it('ignores non-string field values', () => {
		const out = parseMoveToml(`
[dependencies]
Foo = { git = "https://github.com/Owner/Repo", rev = "main", override = true }
`);
		expect(out.deps[0]).toMatchObject({ kind: 'git', name: 'Foo' });
	});
});
