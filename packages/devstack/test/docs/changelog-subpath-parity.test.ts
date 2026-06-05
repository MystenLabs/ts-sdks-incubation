// CHANGELOG subpath-claim parity test.
//
// Why: the pre-22c CHANGELOG claimed `/contracts` and `/substrate`
// subpath exports that don't exist in `package.json:exports` — the
// substrate is reachable from the root barrel only. The Phase 22c/C1
// edit drops those claims. This test prevents the drift from coming
// back by parsing every backtick-quoted `/<segment>` slash-prefix
// token in CHANGELOG.md and asserting it resolves to a real exports
// key.
//
// The set of "interesting" subpaths is whatever the package.json
// exports object actually exposes — we don't hard-code it. Tokens that
// look like subpath imports but aren't a real export key (e.g.
// `/contracts`) fail the test with a path-citing message.
//
// Heuristics:
//   - Only tokens enclosed in backticks count (the CHANGELOG uses
//     prose like "fixes" with bare slashes; we don't want false hits).
//   - We only consider tokens that start with `/` and contain only
//     `[A-Za-z0-9/_-]` — markdown URLs (which start with `(http`) and
//     posix paths are excluded.
//   - The CHANGELOG sometimes wraps multiple tokens in one backtick
//     run (e.g. `/contracts`, `/substrate`); the matcher walks each
//     backtick segment and extracts every `/segment` token inside.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const CHANGELOG_PATH = fileURLToPath(new URL('../../CHANGELOG.md', import.meta.url));
const PACKAGE_JSON_PATH = fileURLToPath(new URL('../../package.json', import.meta.url));

interface PackageJson {
	readonly exports: Record<string, unknown>;
}

const loadExportKeys = (): Set<string> => {
	const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8')) as PackageJson;
	return new Set(Object.keys(pkg.exports));
};

const extractSubpathClaims = (changelogText: string): Set<string> => {
	const claims = new Set<string>();
	// Walk every backtick-enclosed run.
	const backtickRuns = changelogText.matchAll(/`([^`\n]+)`/g);
	for (const run of backtickRuns) {
		const segment = run[1];
		if (segment === undefined) continue;
		// Inside a backtick run, pull every `/identifier` token.
		// Excludes anything with `.`, `:`, `?`, `=`, `(`, etc. — those
		// are URLs / module-resolution prose, not subpath claims.
		const tokens = segment.matchAll(/(?<![A-Za-z0-9._/-])(\/[A-Za-z][A-Za-z0-9/_-]*)/g);
		for (const t of tokens) {
			if (t[1] !== undefined) claims.add(t[1]);
		}
	}
	return claims;
};

describe('CHANGELOG subpath-claim parity (CHANGELOG.md <-> package.json#exports)', () => {
	const changelogText = readFileSync(CHANGELOG_PATH, 'utf8');
	const exportKeys = loadExportKeys();
	const exportSubpaths = new Set(
		[...exportKeys].filter((k) => k.startsWith('./')).map((k) => k.slice(1)),
	);
	// Subpath claims the CHANGELOG might legitimately mention without
	// declaring them as public exports. Keep this list TIGHT — anything
	// here is an exception we explicitly accept.
	const ALLOWLIST = new Set<string>([
		// HTTP route paths the CHANGELOG cites in prose (NOT package subpath
		// imports the user can `import` from):
		'/health', // Seal key-server health-probe route the dashboard hits
		'/execute', // removed dev-wallet HTTP endpoint (DEVSTACK_WALLET_HTTP_PATH.EXECUTE)
	]);

	it('every `/segment` backtick-claim in CHANGELOG.md resolves to a real package.json export', () => {
		const claims = extractSubpathClaims(changelogText);
		const unresolved: string[] = [];
		for (const claim of claims) {
			if (exportSubpaths.has(claim)) continue;
			if (ALLOWLIST.has(claim)) continue;
			unresolved.push(claim);
		}
		unresolved.sort();
		expect(
			unresolved,
			`CHANGELOG.md (${CHANGELOG_PATH}) names subpath(s) that don't exist as ` +
				`keys in package.json#exports (${PACKAGE_JSON_PATH}). ` +
				`Either add the export to package.json or drop the claim from the CHANGELOG. ` +
				`Real exports: ${[...exportSubpaths].sort().join(', ')}.`,
		).toEqual([]);
	});

	it('CHANGELOG mentions every real public subpath export at least once', () => {
		// Soft direction-check: a freshly-added export should be
		// documented in the CHANGELOG. If this trips on a non-user-facing
		// L5 path, add it to the allowlist below — but the default is
		// "if it's in `exports`, it's user-visible enough to mention".
		const claims = extractSubpathClaims(changelogText);
		const undocumented: string[] = [];
		const MENTION_ALLOWLIST = new Set<string>([
			// Sub-entry points that ship alongside their parent and don't
			// need their own CHANGELOG entry:
			'/vitest/setup',
			'/playwright/global-setup',
		]);
		for (const sub of exportSubpaths) {
			if (claims.has(sub)) continue;
			if (MENTION_ALLOWLIST.has(sub)) continue;
			undocumented.push(sub);
		}
		undocumented.sort();
		expect(
			undocumented,
			`Subpath(s) exported from package.json (${PACKAGE_JSON_PATH}) but not mentioned ` +
				`in CHANGELOG.md (${CHANGELOG_PATH}). New public subpaths should appear ` +
				`in the changelog so consumers discover them.`,
		).toEqual([]);
	});
});
