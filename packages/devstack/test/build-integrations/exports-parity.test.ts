// Pin the README's "Build integrations" subpath list to `package.json`'s
// `exports` field — the analogue of `cli/verb-list-parity.test.ts` for
// the public subpath surface.
//
// The README enumerates the surface-level subpaths as backtick-quoted
// fragments under "Package Surface" (e.g. `@mysten-incubation/devstack/
// vitest`). Nothing else ties that prose to `pkg.exports`, so adding a
// new public subpath or renaming one has historically drifted the docs
// silently. This test extracts both sides and asserts set equality
// (with an explicit allowlist for internal hookpoint subpaths like
// `./vitest/setup` and `./playwright/global-setup` that ship in
// `pkg.exports` for framework wiring but aren't user-facing surfaces).
//
// Regex-vs-constant: we lean on a regex here, mirroring
// `verb-list-parity.test.ts`. The "- Build integrations:" bullet is a
// stable, single-line, backtick-fragment list — extracting the prefixed
// subpaths from `pkg.exports` straight from `package.json`. Falling back
// to a SCHEMA constant would re-create the drift risk the test is meant
// to prevent.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Subpaths that exist in `pkg.exports` but are intentionally undocumented
// in the README's user-facing "Build integrations" sentence. These are
// internal hookpoints referenced by the parent surface (e.g. consumers
// import `./vitest`, which internally references `./vitest/setup` via
// the framework preset).
const README_OMITTED_SUBPATHS: ReadonlyArray<string> = [
	'./vitest/setup',
	'./vitest/global-setup',
	'./playwright/global-setup',
];

// Subpaths documented in the README's "Build integrations" sentence
// that are not full `pkg.exports` entries (none today — kept symmetric
// to README_OMITTED_SUBPATHS).
const PACKAGE_OMITTED_SUBPATHS: ReadonlyArray<string> = [];

type PackageJson = {
	readonly exports?: Readonly<Record<string, unknown>>;
};

// Extract every backtick-quoted fragment on the README line that starts
// the "Build integrations:" sentence. Each fragment looks like
// `@mysten-incubation/devstack/vitest` or `/playwright`; we normalize
// each one to a leading-slash `./subpath` matching `pkg.exports` keys.
const extractReadmeSubpaths = (readme: string): ReadonlyArray<string> => {
	// The sentence may wrap across lines after a CommonMark soft break —
	// match the whole `- Build integrations:` bullet up to the next blank
	// line or next bullet, then code-span over that block.
	const bulletMatch = readme.match(/^- Build integrations:[^\n]*(?:\n {2}[^\n]*)*/m);
	if (bulletMatch === null) {
		throw new Error(
			'exports-parity: could not locate the "- Build integrations:" bullet in README.md — ' +
				'has the Package Surface section been restructured?',
		);
	}
	const bullet = bulletMatch[0];
	const fragments = [...bullet.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);
	const subpaths: Array<string> = [];
	for (const raw of fragments) {
		// Two fragment shapes appear in the README:
		//   `@mysten-incubation/devstack/vitest` → full specifier
		//   `/playwright`                        → bare suffix following an "and"
		// Normalize both to the `pkg.exports` key form `./vitest`.
		const trimmed = raw.trim();
		const tail = trimmed.replace(/^@mysten-incubation\/devstack/, '');
		if (tail.length === 0 || !tail.startsWith('/')) continue;
		subpaths.push(`.${tail}`);
	}
	return subpaths;
};

// Extract `pkg.exports` subpath keys, excluding the root barrel `'.'`.
const extractPackageSubpaths = (pkg: PackageJson): ReadonlyArray<string> => {
	const keys = Object.keys(pkg.exports ?? {});
	return keys.filter((key) => key !== '.');
};

describe('README build-integrations subpath parity', () => {
	const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
	const pkg = JSON.parse(
		readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
	) as PackageJson;

	const readmeSubpaths = extractReadmeSubpaths(readme);
	const packageSubpaths = extractPackageSubpaths(pkg);
	const readmeSet = new Set(readmeSubpaths);
	const packageSet = new Set(packageSubpaths);

	it('extracts a non-empty subpath list from the README', () => {
		// Sanity check — if this regex breaks, every other assertion
		// silently passes against an empty set.
		expect(readmeSubpaths.length).toBeGreaterThan(0);
	});

	it('every README subpath appears in package.json exports', () => {
		const missing = [...readmeSet].filter(
			(subpath) => !packageSet.has(subpath) && !PACKAGE_OMITTED_SUBPATHS.includes(subpath),
		);
		expect(missing, `README subpaths not in package.json exports: ${missing.join(', ')}`).toEqual(
			[],
		);
	});

	it('every package.json export subpath is documented in the README', () => {
		const undocumented = packageSubpaths.filter(
			(subpath) => !readmeSet.has(subpath) && !README_OMITTED_SUBPATHS.includes(subpath),
		);
		expect(
			undocumented,
			`package.json export subpaths missing from README: ${undocumented.join(', ')}`,
		).toEqual([]);
	});
});
