// Guards against scaffolds carrying runtime/build state, at two layers:
//   1. the copy skip-set never copies devstack runtime dirs / build artifacts
//      out of a dev checkout of the authored `templates/`, and
//   2. each template's `_gitignore` (restored to `.gitignore` at scaffold)
//      ignores the same state, so a run before the initial commit stays clean.
//
// `src/generated` is NOT in either layer: the templates ship the committed
// codegen projection tree (id-free bindings + sentinel-id config + the emitted
// `src/generated/.gitignore` that governs it), exactly like the examples, so a
// freshly-scaffolded app builds on a clean checkout with no stack running.
// `devstack up`/`apply` no longer write `src/generated` (output moved to the
// gitignored `.devstack/`), so the bindings must travel with the template.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { shouldSkipTemplatePath } from '../src/scaffold.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATES = resolve(HERE, '..', 'templates');

describe('template copy skip-set', () => {
	it('skips build/runtime artifacts at any depth', () => {
		expect(shouldSkipTemplatePath('node_modules/react/index.js')).toBe(true);
		expect(shouldSkipTemplatePath('dist/index.mjs')).toBe(true);
		expect(shouldSkipTemplatePath('.devstack/stacks/main/state.json')).toBe(true);
		expect(shouldSkipTemplatePath('.turbo/turbo-build.log')).toBe(true);
		expect(shouldSkipTemplatePath('tsconfig.tsbuildinfo')).toBe(true);
		expect(shouldSkipTemplatePath('nested/tsconfig.app.tsbuildinfo')).toBe(true);
	});

	it('copies the committed codegen projection tree (src/generated)', () => {
		expect(shouldSkipTemplatePath('src/generated')).toBe(false);
		expect(shouldSkipTemplatePath('src/generated/config.ts')).toBe(false);
		expect(shouldSkipTemplatePath('src/generated/bindings/counter/counter.ts')).toBe(false);
		expect(shouldSkipTemplatePath('src/generated-helpers.ts')).toBe(false);
	});

	it('copies authored template files', () => {
		expect(shouldSkipTemplatePath('package.json')).toBe(false);
		expect(shouldSkipTemplatePath('_gitignore')).toBe(false);
		expect(shouldSkipTemplatePath('src/counter.ts')).toBe(false);
		expect(shouldSkipTemplatePath('move/counter/Move.toml')).toBe(false);
	});
});

describe('template _gitignore contract', () => {
	for (const template of ['app', 'ts'] as const) {
		it(`templates/${template}/_gitignore ignores devstack runtime but tracks src/generated`, () => {
			const text = readFileSync(join(TEMPLATES, template, '_gitignore'), 'utf8');
			expect(text).toMatch(/^node_modules\/?$/m);
			expect(text).toMatch(/^\.devstack\/?$/m);
			// The committed projection tree is tracked — NOT ignored at the app root.
			expect(text).not.toMatch(/^src\/generated\/?$/m);
		});

		it(`templates/${template} ships the committed codegen projection tree`, () => {
			const generated = join(TEMPLATES, template, 'src', 'generated');
			expect(existsSync(join(generated, 'config.ts'))).toBe(true);
			expect(existsSync(join(generated, 'bindings', 'counter', 'counter.ts'))).toBe(true);
			// The emitted in-tree `.gitignore` governs what stays tracked.
			expect(existsSync(join(generated, '.gitignore'))).toBe(true);
		});
	}
});
