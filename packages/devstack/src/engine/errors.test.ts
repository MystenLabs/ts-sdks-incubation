// Conformance tests for the tagged-error catalog. The errors AGENTS.md
// rule: a `phase` field, when present, MUST be a closed
// `Schema.Literals(...)` union (optionally wrapped in `Schema.optional`).
// Open `Schema.String` shapes are grandfathered ONLY for the two
// existing subprocess-wrapping errors that wrap arbitrary CLI / host
// process names; new errors don't get the same latitude.
//
// This test reads the schema's AST for each error and walks the
// `phase` field, asserting either:
//   - missing (`SeedManifestMismatchError` etc. — no lifecycle context)
//   - a Union of `Literal` nodes (with optional outer `Undefined`
//     union member from `Schema.optional`)
//   - or one of the two grandfathered open-string exceptions.
//
// A new error class with an open-string phase fails this test, which
// is exactly the regression we want — the AGENTS.md rule turns into a
// runtime guard.

import { describe, expect, it } from 'vitest';
import {
	AccountError,
	DeepbookError,
	DeepbookIndexerError,
	DeepbookServerError,
	DockerError,
	ForkIncompatibleError,
	ForkUnsupportedError,
	HostProcessError,
	ManifestError,
	PostgresError,
	PublishError,
	PythError,
	SealError,
	SeedManifestMismatchError,
	SuiError,
	WalletAppError,
	WalrusError,
} from './errors.js';

/** Errors that take an open-string phase. Grandfathered — these
 *  subprocess wrappers carry argv-derived phase strings that can't be
 *  enumerated up-front (any docker subcommand, any host-script
 *  invocation). New errors should NOT be added here; the AGENTS.md
 *  rule forbids open phases on lifecycle errors. */
const OPEN_STRING_PHASE_GRANDFATHERED = new Set(['DockerError', 'HostProcessError']);

/** Errors that don't carry a phase at all (context errors, no
 *  lifecycle step). These pass the rule by absence. */
const NO_PHASE_FIELD = new Set([
	'ForkUnsupportedError',
	'SeedManifestMismatchError',
	'ForkIncompatibleError',
]);

// Effect v4 schema AST shapes (observed via `JSON.stringify`):
//   - `Schema.String`              → `{_tag: 'String'}`
//   - `Schema.Literal('a')`        → `{_tag: 'Literal', literal: 'a'}`
//   - `Schema.Literals('a','b')`   → `{_tag: 'Union', types: [Literal, Literal]}`
//   - `Schema.optional(X)`         → `{_tag: 'Union', types: [X, {_tag:'Undefined'}], context: {isOptional: true}}`
// Walk the union to find the non-Undefined members and classify them.

interface ASTNode {
	readonly _tag: string;
	readonly types?: ReadonlyArray<ASTNode>;
}

interface ErrorClass {
	readonly fields: Record<string, { readonly ast: ASTNode }>;
}

const allErrors: ReadonlyArray<{ name: string; cls: unknown }> = [
	{ name: 'ForkUnsupportedError', cls: ForkUnsupportedError },
	{ name: 'SeedManifestMismatchError', cls: SeedManifestMismatchError },
	{ name: 'ForkIncompatibleError', cls: ForkIncompatibleError },
	{ name: 'SuiError', cls: SuiError },
	{ name: 'AccountError', cls: AccountError },
	{ name: 'PublishError', cls: PublishError },
	{ name: 'HostProcessError', cls: HostProcessError },
	{ name: 'DockerError', cls: DockerError },
	{ name: 'WalletAppError', cls: WalletAppError },
	{ name: 'ManifestError', cls: ManifestError },
	{ name: 'WalrusError', cls: WalrusError },
	{ name: 'SealError', cls: SealError },
	{ name: 'DeepbookError', cls: DeepbookError },
	{ name: 'PythError', cls: PythError },
	{ name: 'PostgresError', cls: PostgresError },
	{ name: 'DeepbookIndexerError', cls: DeepbookIndexerError },
	{ name: 'DeepbookServerError', cls: DeepbookServerError },
];

const phaseAst = (cls: unknown): ASTNode | undefined => {
	const fields = (cls as ErrorClass).fields;
	return fields?.phase?.ast;
};

const nonUndefinedMembers = (ast: ASTNode): ReadonlyArray<ASTNode> => {
	if (ast._tag === 'Union' && ast.types !== undefined) {
		return ast.types.filter((t) => t._tag !== 'Undefined');
	}
	return [ast];
};

const classifyPhase = (ast: ASTNode): 'literals' | 'string' | 'other' => {
	const candidates = nonUndefinedMembers(ast);
	// Closed `Schema.Literals('a','b','c')` becomes a Union of Literal
	// nodes. That Union may sit nested inside `Schema.optional`'s outer
	// Union (after removing the `Undefined` member, we're left with one
	// inner Union of Literals).
	if (candidates.length === 1) {
		const c = candidates[0];
		if (c === undefined) return 'other';
		if (c._tag === 'Literal') return 'literals';
		if (c._tag === 'Union' && c.types !== undefined && c.types.every((t) => t._tag === 'Literal')) {
			return 'literals';
		}
		if (c._tag === 'String') return 'string';
	}
	// Top-level union of Literals (non-optional `Schema.Literals`).
	if (candidates.length > 1 && candidates.every((c) => c._tag === 'Literal')) {
		return 'literals';
	}
	return 'other';
};

describe('errors — phase-field conformance', () => {
	for (const { name, cls } of allErrors) {
		it(`${name} conforms to the phase-field rule`, () => {
			const ast = phaseAst(cls);
			if (ast === undefined) {
				// Context error — no phase field. Allowed only for the
				// grandfathered set.
				expect(NO_PHASE_FIELD).toContain(name);
				return;
			}
			const kind = classifyPhase(ast);
			if (OPEN_STRING_PHASE_GRANDFATHERED.has(name)) {
				// Open-string is allowed only for the two grandfathered subprocess wrappers.
				expect(['literals', 'string']).toContain(kind);
				return;
			}
			// Everyone else: phase MUST be a `Schema.Literals(...)` union.
			expect(kind).toBe('literals');
		});
	}
});
