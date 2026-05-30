// Per-stack codegen output-location resolver — unit tests.
//
// `resolveCodegenOutput` is the single decision point that maps
// (appRoot, effective stack, home stack) → the absolute dir codegen
// owns for THIS stack (recorded later in `manifest.codegen.generatedDir`
// and read back by the Vite `@generated` alias plugin). Pure: no
// `process.env`, no I/O — so these are plain assertions over its return
// shape, no temp dir / env harness needed.
//
// Rules under test (see src/orchestrators/codegen/output-location.ts):
//   1. Explicit `outputDir` honored verbatim (relative → resolved
//      against appRoot; absolute → passthrough). Explicit `stackSubdir`
//      rides along.
//   2. Home stack (effectiveStack === homeStack, OR homeStack
//      undefined) → `<appRoot>/src/generated`, stackSubdir null.
//   3. Non-home stack → `<appRoot>/.devstack/stacks/<stack>/generated`,
//      stackSubdir null.

import { resolve } from 'node:path';

import { describe, expect, it } from '@effect/vitest';

import { resolveCodegenOutput } from '../../../src/orchestrators/codegen/output-location.ts';

const APP_ROOT = '/Users/me/app';

describe('resolveCodegenOutput', () => {
	it('home stack (effectiveStack === homeStack) → <appRoot>/src/generated, stackSubdir null', () => {
		const out = resolveCodegenOutput({
			appRoot: APP_ROOT,
			effectiveStack: 'main',
			homeStack: 'main',
		});
		expect(out.outputDir).toBe(resolve(APP_ROOT, 'src/generated'));
		expect(out.stackSubdir).toBeNull();
	});

	it('homeStack undefined is treated as home → <appRoot>/src/generated, stackSubdir null', () => {
		// No declared `stackName` means there is no config value for the
		// effective stack to diverge from, so the run is home by
		// definition — even though `effectiveStack` is a non-`main` name.
		const out = resolveCodegenOutput({
			appRoot: APP_ROOT,
			effectiveStack: 'whatever',
			homeStack: undefined,
		});
		expect(out.outputDir).toBe(resolve(APP_ROOT, 'src/generated'));
		expect(out.stackSubdir).toBeNull();
	});

	it('non-home stack → <appRoot>/.devstack/stacks/<stack>/generated, stackSubdir null', () => {
		const out = resolveCodegenOutput({
			appRoot: APP_ROOT,
			effectiveStack: 'e2e',
			homeStack: 'main',
		});
		expect(out.outputDir).toBe(resolve(APP_ROOT, '.devstack', 'stacks', 'e2e', 'generated'));
		expect(out.stackSubdir).toBeNull();
	});

	it('explicit relative outputDir is resolved against appRoot', () => {
		const out = resolveCodegenOutput({
			appRoot: APP_ROOT,
			effectiveStack: 'e2e',
			homeStack: 'main',
			explicitOutputDir: 'custom/gen',
		});
		// Explicit override wins over the non-home rule entirely.
		expect(out.outputDir).toBe(resolve(APP_ROOT, 'custom/gen'));
	});

	it('explicit absolute outputDir is passed through verbatim', () => {
		const out = resolveCodegenOutput({
			appRoot: APP_ROOT,
			effectiveStack: 'main',
			homeStack: 'main',
			explicitOutputDir: '/abs/pinned/generated',
		});
		expect(out.outputDir).toBe('/abs/pinned/generated');
	});

	it('explicit stackSubdir is honored (rides the explicit-outputDir branch)', () => {
		const out = resolveCodegenOutput({
			appRoot: APP_ROOT,
			effectiveStack: 'demo',
			homeStack: 'main',
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
			homeStack: 'main',
			explicitOutputDir: '/abs/pinned/generated',
			explicitStackSubdir: null,
		});
		expect(out.stackSubdir).toBeNull();
	});

	it('default (home + non-home) rules never populate stackSubdir', () => {
		// Belt-and-braces: only the explicit-outputDir branch threads a
		// subdir; the `.devstack/stacks/<stack>` path already isolates per
		// stack, so the non-home rule leaves stackSubdir null even when an
		// explicit stackSubdir is supplied WITHOUT an explicit outputDir.
		const out = resolveCodegenOutput({
			appRoot: APP_ROOT,
			effectiveStack: 'e2e',
			homeStack: 'main',
			explicitStackSubdir: 'ignored-without-outputDir',
		});
		expect(out.outputDir).toBe(resolve(APP_ROOT, '.devstack', 'stacks', 'e2e', 'generated'));
		expect(out.stackSubdir).toBeNull();
	});
});
