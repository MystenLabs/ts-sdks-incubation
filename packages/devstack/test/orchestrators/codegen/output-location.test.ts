// Per-stack codegen output-location resolver — unit tests.
//
// `resolveCodegenOutput` is the single decision point that maps
// (appRoot, effective stack) → the absolute dir the LIVE (`'ran'`)
// codegen owns for THIS stack. The dev-extras sibling is recorded in
// `manifest.codegen.extrasDir`; the bindings tree is the committed
// `src/generated`, resolved directly by the Vite `@generated` alias.
// Pure: no `process.env`, no I/O — so these are plain
// assertions over its return shape, no temp dir / env harness needed.
//
// Rule under test (see src/orchestrators/codegen/output-location.ts):
//   A single fixed per-stack rule, no override → every live stack maps to
//   `<appRoot>/.devstack/stacks/<stack>/generated`, stackSubdir null. The
//   committed `src/generated` tree is owned by the stack-free `codegen`
//   verb, never by this resolver.

import { resolve } from 'node:path';

import { describe, expect, it } from '@effect/vitest';

import { resolveCodegenOutput } from '../../../src/orchestrators/codegen/output-location.ts';

const APP_ROOT = '/Users/me/app';

describe('resolveCodegenOutput', () => {
	it('any live stack → <appRoot>/.devstack/stacks/<stack>/generated, stackSubdir null', () => {
		const out = resolveCodegenOutput({
			appRoot: APP_ROOT,
			effectiveStack: 'main',
		});
		expect(out.outputDir).toBe(resolve(APP_ROOT, '.devstack', 'stacks', 'main', 'generated'));
		expect(out.stackSubdir).toBeNull();
	});

	it('a differently-named live stack also lands under .devstack (no primary special-case)', () => {
		const out = resolveCodegenOutput({
			appRoot: APP_ROOT,
			effectiveStack: 'e2e',
		});
		expect(out.outputDir).toBe(resolve(APP_ROOT, '.devstack', 'stacks', 'e2e', 'generated'));
		expect(out.stackSubdir).toBeNull();
	});

	it('records the per-stack generated-extras sibling as extrasDir', () => {
		const out = resolveCodegenOutput({
			appRoot: APP_ROOT,
			effectiveStack: 'main',
		});
		expect(out.extrasDir).toBe(
			resolve(APP_ROOT, '.devstack', 'stacks', 'main', 'generated-extras'),
		);
	});
});
