// Structural pins for the `CodegenableDecl` capability contract.
//
// The codegen contract uses an opaque `CodegenEmitContext` (no raw record
// return) so the orchestrator owns the collected/grouped output. This file
// pins:
//   1. discriminated `kind: 'codegenable'`,
//   2. required `emitterName` + `outputPath` + `emit`,
//   3. the `AggregateContribution.project` shape,
//   4. the `define-capabilities.ts` helper round-trip preserving the
//      narrow `Emitter` literal in the return type.

import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';

import { codegenable } from '../../src/api/define-capabilities.ts';
import type {
	AggregateContribution,
	CodegenEmitContext,
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

	it('`define-capabilities.ts` helper round-trips and preserves the narrow `Emitter` literal', () => {
		const decl = codegenable({
			emitterName: 'sui-services' as const,
			outputPath: 'sui-services.ts',
			sensitive: false,
			emit: (ctx: CodegenEmitContext) =>
				Effect.sync(() => {
					ctx.exportConst('rpcUrl', 'http://127.0.0.1:9000');
					return ctx.done();
				}),
		});
		expect(decl.kind).toBe('codegenable');
		expect(decl.emitterName).toBe('sui-services');
		expect(decl.outputPath).toBe('sui-services.ts');
		// Compile-time: `decl.emitterName` is the narrowed `'sui-services'`
		// literal, not the wider `string` (the helper preserves it through
		// the `Emitter extends string` generic).
		const narrowed: 'sui-services' = decl.emitterName;
		expect(narrowed).toBe('sui-services');
	});
});
