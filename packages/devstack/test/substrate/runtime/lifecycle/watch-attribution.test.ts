// Watch attribution — glob matcher + root derivation.
//
// Pins the bug the L0 watcher exposed: the declared watch paths are
// globs (`<src>/**/*.move`), so attributing a fired file path needs
// glob-aware matching, not a literal prefix test.

import { describe, expect, it } from 'vitest';

import { pluginKey } from '../../../../src/substrate/brand.ts';
import {
	attribute,
	deriveWatchRoots,
	globMatch,
	type WatchEntry,
} from '../../../../src/substrate/runtime/lifecycle/watch-attribution.ts';

const SRC = '/abs/move/counter';

describe('globMatch', () => {
	it('matches `**/*.ext` against a nested file', () => {
		expect(globMatch(`${SRC}/**/*.move`, `${SRC}/sources/counter.move`)).toBe(true);
	});

	it('matches `**/*.ext` against a file directly under the root', () => {
		expect(globMatch(`${SRC}/**/*.move`, `${SRC}/counter.move`)).toBe(true);
	});

	it('does not let `*` cross a path segment', () => {
		expect(globMatch(`${SRC}/*.move`, `${SRC}/sources/counter.move`)).toBe(false);
	});

	it('rejects a non-matching extension', () => {
		expect(globMatch(`${SRC}/**/*.move`, `${SRC}/sources/counter.txt`)).toBe(false);
	});

	it('matches an exact (glob-free) path literally and escapes the dot', () => {
		expect(globMatch(`${SRC}/Move.toml`, `${SRC}/Move.toml`)).toBe(true);
		// the `.` must be literal, not a regex wildcard
		expect(globMatch(`${SRC}/Move.toml`, `${SRC}/MoveXtoml`)).toBe(false);
	});

	it('matches a glob a naive literal-prefix test would miss', () => {
		// The matcher must see globs: a `<root>/**/*.move` pattern matches a
		// nested file even though the literal prefix before the first glob
		// (`<root>/`) is only a directory prefix, not the file itself.
		const pattern = `${SRC}/**/*.move`;
		const path = `${SRC}/sources/counter.move`;
		expect(path.startsWith(pattern.replace(/\*.*$/, ''))).toBe(true); // prefix alone is ambiguous
		expect(globMatch(pattern, path)).toBe(true);
	});

	it('matches a Windows `\\`-separated path against a `/`-separated glob', () => {
		// `join(root, filename)` yields `\`-separated paths on Windows; both
		// sides are normalized to POSIX before matching.
		expect(globMatch(`${SRC}/**/*.move`, `${SRC}\\sources\\counter.move`)).toBe(true);
	});
});

describe('deriveWatchRoots', () => {
	const entry = (paths: ReadonlyArray<string>): WatchEntry => ({
		pluginKey: pluginKey('package:counter'),
		paths,
		cascade: true,
	});

	it('collapses a package plugin’s globs to one source root', () => {
		const roots = deriveWatchRoots([
			entry([`${SRC}/**/*.move`, `${SRC}/Move.toml`, `${SRC}/Move.lock`]),
		]);
		expect(roots).toEqual([SRC]);
	});

	it('dedupes roots shared across patterns and entries', () => {
		const roots = deriveWatchRoots([
			entry([`${SRC}/**/*.move`]),
			{ pluginKey: pluginKey('package:other'), paths: ['/abs/other/**/*.move'], cascade: true },
		]);
		expect(new Set(roots)).toEqual(new Set([SRC, '/abs/other']));
	});

	it('ignores entries with no paths', () => {
		expect(deriveWatchRoots([entry([])])).toEqual([]);
	});

	it('collapses separator-free patterns to the cwd, never a bare filename', () => {
		// A bare basename, a leading glob (empty literal prefix), and a
		// same-segment glob all lack a directory separator. fs.watch needs a
		// directory, so each must resolve to `.` rather than `Move.toml` / `` /
		// `src` — globMatch still filters the events these roots surface.
		expect(deriveWatchRoots([entry(['Move.toml'])])).toEqual(['.']);
		expect(deriveWatchRoots([entry(['*.move'])])).toEqual(['.']);
		expect(deriveWatchRoots([entry(['src*'])])).toEqual(['.']);
	});
});

describe('attribute (glob-aware)', () => {
	const index: ReadonlyArray<WatchEntry> = [
		{ pluginKey: pluginKey('package:counter'), paths: [`${SRC}/**/*.move`], cascade: true },
		{ pluginKey: pluginKey('package:other'), paths: ['/abs/other/**/*.move'], cascade: true },
	];

	it('attributes a fired path to the owning plugin via globMatch', () => {
		const matched = attribute(index, `${SRC}/sources/counter.move`, globMatch);
		expect([...matched]).toEqual([pluginKey('package:counter')]);
	});

	it('attributes nothing for an unrelated path', () => {
		expect(attribute(index, '/abs/elsewhere/foo.move', globMatch).size).toBe(0);
	});
});
