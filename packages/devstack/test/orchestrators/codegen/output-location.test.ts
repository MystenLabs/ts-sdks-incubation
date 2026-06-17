// Per-stack codegen output-location resolver — unit tests.
//
// `resolveCodegenOutput` is the single decision point that maps
// (appRoot, effective stack) → the absolute dir the LIVE (`'ran'`)
// codegen owns for THIS stack (recorded later in
// `manifest.codegen.generatedDir` and read back by the Vite `@generated`
// alias plugin). Pure: no `process.env`, no I/O — so these are plain
// assertions over its return shape, no temp dir / env harness needed.
//
// Rules under test (see src/orchestrators/codegen/output-location.ts):
//   1. Explicit `outputDir` honored verbatim (relative → resolved
//      against appRoot; absolute → passthrough). Explicit `stackSubdir`
//      rides along.
//   2. Default → `<appRoot>/.devstack/stacks/<stack>/generated`,
//      stackSubdir null — for EVERY live stack. The committed
//      `src/generated` tree is owned by the stack-free `codegen` verb,
//      never by this resolver.

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

	it('explicit relative outputDir is resolved against appRoot', () => {
		const out = resolveCodegenOutput({
			appRoot: APP_ROOT,
			effectiveStack: 'e2e',
			explicitOutputDir: 'custom/gen',
		});
		// Explicit override wins over the default rule entirely.
		expect(out.outputDir).toBe(resolve(APP_ROOT, 'custom/gen'));
	});

	it('explicit absolute outputDir is passed through verbatim', () => {
		const out = resolveCodegenOutput({
			appRoot: APP_ROOT,
			effectiveStack: 'main',
			explicitOutputDir: '/abs/pinned/generated',
		});
		expect(out.outputDir).toBe('/abs/pinned/generated');
	});

	it('explicit stackSubdir is honored (rides the explicit-outputDir branch)', () => {
		const out = resolveCodegenOutput({
			appRoot: APP_ROOT,
			effectiveStack: 'demo',
			explicitOutputDir: '/abs/pinned/generated',
			explicitStackSubdir: 'demo',
		});
		expect(out.outputDir).toBe('/abs/pinned/generated');
		expect(out.stackSubdir).toBe('demo');
	});

	it('explicit stackSubdir null/undefined collapses to null', () => {
		const out = resolveCodegenOutput({
			appRoot: APP_ROOT,
			effectiveStack: 'demo',
			explicitOutputDir: '/abs/pinned/generated',
			explicitStackSubdir: null,
		});
		expect(out.stackSubdir).toBeNull();
	});

	it('default rule never populates stackSubdir even when one is supplied without outputDir', () => {
		// Belt-and-braces: only the explicit-outputDir branch threads a
		// subdir; the `.devstack/stacks/<stack>` path already isolates per
		// stack, so the default rule leaves stackSubdir null even when an
		// explicit stackSubdir is supplied WITHOUT an explicit outputDir.
		const out = resolveCodegenOutput({
			appRoot: APP_ROOT,
			effectiveStack: 'e2e',
			explicitStackSubdir: 'ignored-without-outputDir',
		});
		expect(out.outputDir).toBe(resolve(APP_ROOT, '.devstack', 'stacks', 'e2e', 'generated'));
		expect(out.stackSubdir).toBeNull();
	});
});
