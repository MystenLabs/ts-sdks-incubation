// Closed-projection-field parity test.
//
// Why: the substrate documents two closed field sets — `SubscribableState`
// (asserted by `__ProjectionFieldsClosed`) and `Row` (asserted by
// `__RowFieldsClosed`). Both also appear in
// `ARCHITECTURE.md#Closed projection field list` as the human-readable
// contract. Drift between code and doc is silent (the TS guards don't
// touch the markdown), so this test parses both sources and asserts
// the field sets match exactly.
//
// Source of truth: `src/substrate/projection.ts`'s `_ProjectionKeysClosed`
// and `_RowKeysClosed` type-alias unions.
// Doc surface: `ARCHITECTURE.md` lists them as brace-enclosed
// comma-separated identifiers (see the "## Closed projection field
// list" section). The parser is defensive — it tolerates whitespace,
// newlines, and a trailing comma so reflowing the list in the doc
// doesn't trip the test.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const PROJECTION_SOURCE = fileURLToPath(
	new URL('../../src/substrate/projection.ts', import.meta.url),
);

const ARCHITECTURE_DOC = fileURLToPath(
	new URL('../../ARCHITECTURE.md', import.meta.url),
);

const parseTypeAliasUnion = (source: string, aliasName: string): Set<string> => {
	// Match `type _ProjectionKeysClosed =\n\t| 'identity'\n\t| 'cycle'\n\t...;`
	const aliasMatch = source.match(
		new RegExp(`type\\s+${aliasName}\\s*=\\s*([^;]+);`, 's'),
	);
	if (!aliasMatch) {
		throw new Error(
			`Could not find type alias \`${aliasName}\` in ${PROJECTION_SOURCE}. ` +
				`The closed-field source-of-truth has been renamed — update this test.`,
		);
	}
	const body = aliasMatch[1];
	if (body === undefined) {
		throw new Error(
			`Type alias \`${aliasName}\` matched but body was empty in ${PROJECTION_SOURCE}.`,
		);
	}
	const fields = body.match(/'([^']+)'/g);
	if (!fields || fields.length === 0) {
		throw new Error(
			`Found \`${aliasName}\` but extracted zero string-literal members from ${PROJECTION_SOURCE}.`,
		);
	}
	return new Set(fields.map((m) => m.slice(1, -1)));
};

const parseDocFieldList = (
	docText: string,
	heading: string,
): Set<string> => {
	// The architecture doc renders both closed lists as backtick-quoted
	// brace-enclosed comma-separated identifier lists, e.g.
	//   `{ identity, cycle, rows, ... }`
	// We locate the first such list AFTER the heading line.
	const headingIdx = docText.indexOf(heading);
	if (headingIdx === -1) {
		throw new Error(
			`Could not locate heading "${heading}" in ${ARCHITECTURE_DOC}.`,
		);
	}
	const after = docText.slice(headingIdx);
	// Match the first backtick-wrapped brace list.
	const braceMatch = after.match(/`\{\s*([^`}]+?)\s*\}`/);
	if (!braceMatch) {
		throw new Error(
			`Could not find a brace-enclosed field list after "${heading}" in ${ARCHITECTURE_DOC}.`,
		);
	}
	const body = braceMatch[1];
	if (body === undefined) {
		throw new Error(
			`Brace list matched but body was empty after "${heading}" in ${ARCHITECTURE_DOC}.`,
		);
	}
	const fields = body
		.split(',')
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	return new Set(fields);
};

describe('closed projection field parity (code <-> ARCHITECTURE.md)', () => {
	const sourceText = readFileSync(PROJECTION_SOURCE, 'utf8');
	const docText = readFileSync(ARCHITECTURE_DOC, 'utf8');

	it('SubscribableState fields in `_ProjectionKeysClosed` match the ARCHITECTURE.md list', () => {
		const codeFields = parseTypeAliasUnion(sourceText, '_ProjectionKeysClosed');
		// Anchor on the section heading; the first brace list in this
		// section enumerates `SubscribableState` fields.
		const docFields = parseDocFieldList(docText, '## Closed projection field list');

		const missingInDoc = [...codeFields].filter((f) => !docFields.has(f)).sort();
		const extraInDoc = [...docFields].filter((f) => !codeFields.has(f)).sort();

		expect(
			missingInDoc,
			`Fields present in \`_ProjectionKeysClosed\` (${PROJECTION_SOURCE}) ` +
				`but missing from ARCHITECTURE.md (${ARCHITECTURE_DOC}#Closed projection field list).`,
		).toEqual([]);
		expect(
			extraInDoc,
			`Fields listed in ARCHITECTURE.md (${ARCHITECTURE_DOC}#Closed projection field list) ` +
				`but absent from \`_ProjectionKeysClosed\` (${PROJECTION_SOURCE}).`,
		).toEqual([]);
	});

	it('Row fields in `_RowKeysClosed` match the ARCHITECTURE.md list', () => {
		const codeFields = parseTypeAliasUnion(sourceText, '_RowKeysClosed');
		// The Row brace list sits in the same section but is the SECOND
		// brace-enclosed list — anchor on the "`Row` is also closed"
		// sentence to pick it deterministically.
		const docFields = parseDocFieldList(docText, '`Row` is also closed');

		const missingInDoc = [...codeFields].filter((f) => !docFields.has(f)).sort();
		const extraInDoc = [...docFields].filter((f) => !codeFields.has(f)).sort();

		expect(
			missingInDoc,
			`Fields present in \`_RowKeysClosed\` (${PROJECTION_SOURCE}) ` +
				`but missing from ARCHITECTURE.md (${ARCHITECTURE_DOC}#Closed projection field list).`,
		).toEqual([]);
		expect(
			extraInDoc,
			`Fields listed in ARCHITECTURE.md (${ARCHITECTURE_DOC}#Closed projection field list) ` +
				`but absent from \`_RowKeysClosed\` (${PROJECTION_SOURCE}).`,
		).toEqual([]);
	});

	it('RowSection union members match the ARCHITECTURE.md enumeration', () => {
		// `RowSection = 'service' | 'package' | 'account' | 'action' | 'app' | 'other'`
		const aliasMatch = sourceText.match(
			/export\s+type\s+RowSection\s*=\s*([^;]+);/,
		);
		expect(
			aliasMatch,
			`Could not locate \`RowSection\` type alias in ${PROJECTION_SOURCE}.`,
		).not.toBeNull();
		const aliasBody = aliasMatch![1];
		if (aliasBody === undefined) {
			throw new Error(
				`\`RowSection\` type alias matched but body was empty in ${PROJECTION_SOURCE}.`,
			);
		}
		const codeMembers = new Set(
			[...aliasBody.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? ''),
		);

		// Doc enumerates `RowSection` inline:
		//   `'service' | 'package' | 'account' | 'action' | 'app' | 'other'`
		const docIdx = docText.indexOf('`RowSection` is');
		expect(
			docIdx,
			`Could not locate "\`RowSection\` is" sentence in ${ARCHITECTURE_DOC}.`,
		).not.toBe(-1);
		const docTail = docText.slice(docIdx, docIdx + 400);
		const docMembers = new Set(
			[...docTail.matchAll(/'([a-z]+)'/g)].map((m) => m[1] ?? ''),
		);

		const missingInDoc = [...codeMembers].filter((m) => !docMembers.has(m)).sort();
		const extraInDoc = [...docMembers].filter((m) => !codeMembers.has(m)).sort();

		expect(
			missingInDoc,
			`\`RowSection\` members in code (${PROJECTION_SOURCE}) missing from doc (${ARCHITECTURE_DOC}).`,
		).toEqual([]);
		expect(
			extraInDoc,
			`\`RowSection\` members in doc (${ARCHITECTURE_DOC}) absent from code (${PROJECTION_SOURCE}).`,
		).toEqual([]);
	});
});
