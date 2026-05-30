// Pin the README's CLI verb list to the actual command-tree registry.
//
// The README enumerates verbs as a single line of backtick-quoted
// fragments under "Package Surface". Nothing else ties that prose to
// the `VERBS` constant in `surfaces/cli/command-tree.ts`, so renaming
// or adding a verb has historically drifted the docs silently. This
// test extracts the verb list from each source and asserts set equality
// (with an explicit allow-list for hidden/internal verbs).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { VERBS } from '../../src/surfaces/cli/command-tree.ts';

// Verbs that exist in the registry but are intentionally undocumented
// in the README's verb sentence (none today — kept for forward-compat).
const README_OMITTED_VERBS: ReadonlyArray<string> = [];

// Verbs documented in the README that are not full registered verbs
// (none today — kept symmetric to README_OMITTED_VERBS).
const REGISTRY_OMITTED_VERBS: ReadonlyArray<string> = [];

// Extract every backtick-quoted fragment on the README line that starts
// the CLI verb sentence. The sentence is identified by its leading
// "CLI:" marker; the fragments include things like `devstack up`,
// `apply`, `schema --json`. We normalize each fragment to a bare verb
// (strip a leading `devstack ` and any trailing flag/argument).
const extractReadmeVerbs = (readme: string): ReadonlyArray<string> => {
	// The verb sentence may wrap across lines after a CommonMark soft
	// break — match the whole `- CLI: …` bullet up to the next blank
	// line or next bullet, then code-span over that block.
	const bulletMatch = readme.match(/^- CLI:[^\n]*(?:\n {2}[^\n]*)*/m);
	if (bulletMatch === null) {
		throw new Error(
			'verb-list-parity: could not locate the "- CLI:" bullet in README.md — ' +
				'has the Package Surface section been restructured?',
		);
	}
	const bullet = bulletMatch[0];
	const fragments = [...bullet.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);
	const verbs: Array<string> = [];
	for (const raw of fragments) {
		// Strip an optional leading `devstack ` and take the first token
		// — drops trailing flags like `--json`.
		const stripped = raw.replace(/^devstack\s+/, '').trim();
		const head = stripped.split(/\s+/)[0];
		if (head === undefined || head.length === 0) continue;
		// Skip flag-shaped tokens. The README also documents `--json` as
		// a global flag in the same bullet; it's a flag, not a verb.
		if (head.startsWith('-')) continue;
		verbs.push(head);
	}
	return verbs;
};

describe('README CLI verb list parity', () => {
	const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
	const readmeVerbs = extractReadmeVerbs(readme);
	const readmeSet = new Set(readmeVerbs);
	const registrySet = new Set(VERBS);

	it('extracts a non-empty verb list from the README', () => {
		// Sanity check — if this regex breaks, every other assertion
		// silently passes against an empty set.
		expect(readmeVerbs.length).toBeGreaterThan(0);
	});

	it('every README verb is registered in command-tree.ts', () => {
		const missing = [...readmeSet].filter(
			(verb) =>
				!registrySet.has(verb as (typeof VERBS)[number]) &&
				!REGISTRY_OMITTED_VERBS.includes(verb),
		);
		expect(missing, `README verbs not in VERBS registry: ${missing.join(', ')}`).toEqual([]);
	});

	it('every registered verb is documented in the README', () => {
		const undocumented = VERBS.filter(
			(verb) => !readmeSet.has(verb) && !README_OMITTED_VERBS.includes(verb),
		);
		expect(
			undocumented,
			`registered verbs missing from README: ${undocumented.join(', ')}`,
		).toEqual([]);
	});
});
