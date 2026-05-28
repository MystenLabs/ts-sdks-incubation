// STYLE_GUIDE Cookbook coverage parity test.
//
// Why: the Cookbook (§21) in `STYLE_GUIDE.md` is the canonical list of
// reusable plugin/substrate patterns. New foundational primitives —
// `definePlugin` skeletons, capability-sink registration — must be
// documented as Cookbook entries so plugin authors discover them
// alongside the existing ones (`as const`, `stageAndSwap`, etc.). This
// test pins that §21.7 and §21.8 stay in the file. If the doc loses
// them (rebase rot, manual edit), the test fails citing the path so
// the drift is caught at PR review time rather than in lived docs.
//
// Heading style: existing Cookbook entries use `### 21.N Title`. We
// accept the optional `§` prefix used in cross-references and any
// title text — the assertion is on the `21.N` numbering convention,
// not the exact title string.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const STYLE_GUIDE_PATH = fileURLToPath(
	new URL('../../STYLE_GUIDE.md', import.meta.url),
);

const cookbookEntryRegex = (n: number): RegExp =>
	// Matches lines like:
	//   ### 21.7 ...
	//   ### §21.7 ...
	//   ### 21.7. ...
	// Title text is unconstrained — we only pin the numbering.
	new RegExp(`^###\\s+§?21\\.${n}\\b.+$`, 'm');

describe('STYLE_GUIDE Cookbook coverage', () => {
	const text = readFileSync(STYLE_GUIDE_PATH, 'utf8');

	it('contains a §21.7 entry (minimal `definePlugin` skeleton)', () => {
		const match = text.match(cookbookEntryRegex(7));
		expect(
			match,
			`STYLE_GUIDE.md (${STYLE_GUIDE_PATH}) is missing a "### 21.7 …" Cookbook entry. ` +
				`Phase 22c/C1 was supposed to add the "minimal definePlugin skeleton" entry here.`,
		).not.toBeNull();
	});

	it('contains a §21.8 entry (capabilitySink registration)', () => {
		const match = text.match(cookbookEntryRegex(8));
		expect(
			match,
			`STYLE_GUIDE.md (${STYLE_GUIDE_PATH}) is missing a "### 21.8 …" Cookbook entry. ` +
				`Phase 22c/C1 was supposed to add the "capabilitySink registration" entry here.`,
		).not.toBeNull();
	});

	it('keeps §21.1-§21.6 anchors stable (regression guard)', () => {
		// The pre-existing entries are well-known. If any go missing the
		// Cookbook has been re-ordered and downstream cross-references
		// (e.g. ARCHITECTURE -> STYLE_GUIDE §21.x links) will rot.
		for (const n of [1, 2, 3, 4, 5, 6]) {
			const match = text.match(cookbookEntryRegex(n));
			expect(
				match,
				`STYLE_GUIDE.md (${STYLE_GUIDE_PATH}) lost its "### 21.${n} …" Cookbook entry.`,
			).not.toBeNull();
		}
	});
});
