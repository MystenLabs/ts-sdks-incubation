import { describe, expect, it, vi } from 'vitest';

const ensureUpstreamSourceImageMock = vi.hoisted(() => vi.fn());
const extractUpstreamSourceMock = vi.hoisted(() => vi.fn());
const existsSyncMock = vi.hoisted(() => vi.fn());
const readFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock('../../helpers/upstream-source.js', async () => {
	const actual = await vi.importActual<typeof import('../../helpers/upstream-source.js')>(
		'../../helpers/upstream-source.js',
	);
	return {
		...actual,
		ensureUpstreamSourceImage: ensureUpstreamSourceImageMock,
		extractUpstreamSource: extractUpstreamSourceMock,
	};
});

vi.mock('node:fs', async () => {
	const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
	return {
		...actual,
		existsSync: existsSyncMock,
		readFileSync: readFileSyncMock,
	};
});

import { resolveImports } from './resolve.js';

describe('resolveImports', () => {
	beforeEach();

	it('resolves a single seed with no transitive deps', async () => {
		mockMoveTomlFor({
			'a/b@v1:.': `
[package]
name = "leaf"
[dependencies]
Sui = { git = "https://github.com/MystenLabs/sui.git", subdir = "crates/sui-framework", rev = "framework/devnet" }
			`,
		});
		const { resolved } = await resolveImports([
			{ name: 'leaf', repo: 'a/b', rev: 'v1', subdir: '.' },
		]);
		expect(resolved).toHaveLength(1);
		expect(resolved[0]).toMatchObject({ name: 'leaf', repo: 'a/b', depKeys: [] });
	});

	it('walks one level of transitive git deps and topo-sorts deps before dependents', async () => {
		mockMoveTomlFor({
			'a/parent@v1:pkg': `
[dependencies]
Child = { git = "https://github.com/x/child.git", rev = "v2", subdir = "." }
			`,
			'x/child@v2:.': `
[dependencies]
Sui = { git = "https://github.com/MystenLabs/sui.git", subdir = "crates", rev = "framework/devnet" }
			`,
		});
		const { resolved } = await resolveImports([
			{ name: 'parent', repo: 'a/parent', rev: 'v1', subdir: 'pkg' },
		]);
		expect(resolved.map((r) => r.name)).toEqual(['parent-child', 'parent']);
		const parent = resolved.find((r) => r.name === 'parent');
		expect(parent?.depKeys).toEqual(['x/child@v2:.']);
	});

	it('dedupes by (repo, rev, subdir)', async () => {
		mockMoveTomlFor({
			'a/p@v1:pkg-a': `
[dependencies]
Shared = { git = "https://github.com/x/shared.git", rev = "v1", subdir = "." }
			`,
			'a/p@v1:pkg-b': `
[dependencies]
Shared = { git = "https://github.com/x/shared.git", rev = "v1", subdir = "." }
			`,
			'x/shared@v1:.': `[dependencies]`,
		});
		const { resolved } = await resolveImports([
			{ name: 'pkg-a', repo: 'a/p', rev: 'v1', subdir: 'pkg-a' },
			{ name: 'pkg-b', repo: 'a/p', rev: 'v1', subdir: 'pkg-b' },
		]);
		// Three entries: shared (deduped) + pkg-a + pkg-b.
		expect(resolved).toHaveLength(3);
		const names = resolved.map((r) => r.name).sort();
		expect(names).toEqual(['pkg-a', 'pkg-a-shared', 'pkg-b'].sort());
	});

	it('skips MystenLabs/sui framework deps (do not enqueue separately)', async () => {
		mockMoveTomlFor({
			'a/b@v1:.': `
[dependencies]
Sui = { git = "https://github.com/MystenLabs/sui.git", subdir = "crates/sui-framework", rev = "framework/devnet" }
			`,
		});
		const { resolved } = await resolveImports([{ name: 'b', repo: 'a/b', rev: 'v1', subdir: '.' }]);
		expect(resolved).toHaveLength(1);
		expect(resolved[0]?.depKeys).toEqual([]);
	});

	it('does not enqueue local deps as separate entries', async () => {
		mockMoveTomlFor({
			'a/b@v1:.': `
[dependencies]
inner = { local = "../inner" }
			`,
		});
		const { resolved } = await resolveImports([{ name: 'b', repo: 'a/b', rev: 'v1', subdir: '.' }]);
		expect(resolved).toHaveLength(1);
		expect(resolved[0]?.depKeys).toEqual([]);
	});

	it('rejects subdir traversal (".." segments)', async () => {
		await expect(
			resolveImports([{ name: 'b', repo: 'a/b', rev: 'v1', subdir: '../../etc' }]),
		).rejects.toThrow(/refusing to walk subdir.*\.\./);
	});

	it('rejects absolute subdirs', async () => {
		await expect(
			resolveImports([{ name: 'b', repo: 'a/b', rev: 'v1', subdir: '/etc/passwd' }]),
		).rejects.toThrow(/absolute path/);
	});
});

function beforeEach(): void {
	import('vitest').then(({ beforeEach: vbe }) => {
		vbe(() => {
			ensureUpstreamSourceImageMock.mockReset();
			extractUpstreamSourceMock.mockReset();
			existsSyncMock.mockReset();
			readFileSyncMock.mockReset();
		});
	});
}

function mockMoveTomlFor(table: Record<string, string>): void {
	ensureUpstreamSourceImageMock.mockImplementation(
		async ({ repo, rev }: { repo: string; rev: string }) => ({
			imageTag: `image:${repo}:${rev}`,
		}),
	);
	extractUpstreamSourceMock.mockResolvedValue(undefined);
	existsSyncMock.mockReturnValue(true);
	// readFileSync gets called with `<tmp>/<subdir>/Move.toml`. We key on
	// the imageTag-derived (repo,rev) plus the subdir, decoded from the
	// path that resolve.ts constructs.
	readFileSyncMock.mockImplementation((path: string) => {
		// resolveImports calls extractUpstreamSource passing destDir=<tmp>;
		// then readFileSync(join(tmp, subdir, 'Move.toml')). We can't see
		// `tmp` directly here. Instead, key on the most recent
		// ensureUpstreamSourceImage call to recover (repo, rev), then
		// read the path's tail to recover subdir.
		const lastCall = ensureUpstreamSourceImageMock.mock.calls.at(-1);
		if (lastCall === undefined) throw new Error('mockMoveTomlFor: no upstream image call yet');
		const { repo, rev } = lastCall[0] as { repo: string; rev: string };
		// Decode subdir from path: it's the portion between <tmp> and `/Move.toml`.
		const m = String(path).match(/devstack-resolve-[^/]+\/(.+)\/Move\.toml$/);
		const subdir = m?.[1] ?? '.';
		const key = `${repo}@${rev}:${subdir}`;
		const toml = table[key];
		if (toml === undefined) {
			throw new Error(
				`mockMoveTomlFor: no fixture for key '${key}' (have: ${Object.keys(table).join(', ')})`,
			);
		}
		return toml;
	});
}
