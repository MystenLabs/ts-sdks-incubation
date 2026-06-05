// Structural pins for the `CodegenableDecl` capability contract.
//
// The codegen contract uses an opaque `CodegenEmitContext` (no raw record
// return) so the orchestrator owns the collected/grouped output. This file
// pins:
//   1. discriminated `kind: 'codegenable'`,
//   2. required `emitterName` + `outputPath` + `emit`,
//   3. the `AggregateContribution.project` shape.

import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';

import type {
	AggregateContribution,
	CodegenableDecl,
} from '../../src/contracts/codegenable.ts';

describe('contracts/codegenable — structural pins', () => {
	it('discriminated-union `kind` is the literal `"codegenable"`', () => {
		const decl: CodegenableDecl = {
			kind: 'codegenable',
			emitterName: 'demo',
			outputPath: 'demo.ts',
			emit: (ctx) => Effect.sync(() => ctx.done()),
		};
		const tagged: 'codegenable' = decl.kind;
		expect(tagged).toBe('codegenable');
	});

	it('rejects a literal missing `emitterName` (required)', () => {
		// @ts-expect-error -- `emitterName` is required.
		const _bad: CodegenableDecl = {
			kind: 'codegenable',
			outputPath: 'demo.ts',
			emit: (ctx) => Effect.sync(() => ctx.done()),
		};
		void _bad;
	});

	it('rejects a literal missing `outputPath` (required)', () => {
		// @ts-expect-error -- `outputPath` is required.
		const _bad: CodegenableDecl = {
			kind: 'codegenable',
			emitterName: 'demo',
			emit: (ctx) => Effect.sync(() => ctx.done()),
		};
		void _bad;
	});

	it('rejects a literal missing `emit` (required)', () => {
		// @ts-expect-error -- `emit` is required.
		const _bad: CodegenableDecl = {
			kind: 'codegenable',
			emitterName: 'demo',
			outputPath: 'demo.ts',
		};
		void _bad;
	});

	it('`AggregateContribution.project` returns a shallow-mergeable record or null', () => {
		const agg: AggregateContribution = {
			bucket: 'services.ts',
			project: (exported) =>
				exported['rpc'] === undefined ? null : { rpc: exported['rpc'] },
			kind: 'sui-network',
		};
		expect(agg.bucket).toBe('services.ts');
		expect(agg.project({ rpc: 'http://x' })).toEqual({ rpc: 'http://x' });
		expect(agg.project({})).toBeNull();
	});
});
