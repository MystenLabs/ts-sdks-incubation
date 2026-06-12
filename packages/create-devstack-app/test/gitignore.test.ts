// Guards against scaffolds carrying generated/runtime state, at two layers:
//   1. the copy skip-set never copies devstack runtime dirs / codegen output /
//      build artifacts out of a dev checkout of the authored `templates/`, and
//   2. each template's `_gitignore` (restored to `.gitignore` at scaffold)
//      ignores the same state, so a run before the initial commit stays clean.

import { readFileSync } from 'node:fs';
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

	it('skips codegen output (src/generated) but not lookalike paths', () => {
		expect(shouldSkipTemplatePath('src/generated')).toBe(true);
		expect(shouldSkipTemplatePath('src/generated/counter.ts')).toBe(true);
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
		it(`templates/${template}/_gitignore ignores devstack runtime + codegen output`, () => {
			const text = readFileSync(join(TEMPLATES, template, '_gitignore'), 'utf8');
			expect(text).toMatch(/^node_modules\/?$/m);
			expect(text).toMatch(/^\.devstack\/?$/m);
			expect(text).toMatch(/src\/generated/);
		});
	}
});
