// Regression guard for the scaffold-time `test-results/` leak: a freshly
// scaffolded app's initial commit must not carry Playwright's `test-results/`.
// We assert this at two layers without paying for a full pnpm-install scaffold:
//   1. `test-results` is in the copy-SKIP set (so it's never copied from a dev
//      checkout of the authored `template/` into a scaffolded app), and
//   2. the authored template's `_gitignore` (restored to `.gitignore` at
//      scaffold) lists `test-results/`, so even if a run produces it before
//      the initial commit, git ignores it.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SKIP } from '../src/skip.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '..');
const TEMPLATE = join(PKG_ROOT, 'template');

describe('scaffold .gitignore / copy-skip guards', () => {
	it('test-results is in the copy-SKIP set', () => {
		expect(SKIP.has('test-results')).toBe(true);
		expect(SKIP.has('playwright-report')).toBe(true);
	});

	it("the authored template's _gitignore lists test-results/", () => {
		const gi = join(TEMPLATE, '_gitignore');
		const text = readFileSync(gi, 'utf8');
		expect(text).toMatch(/^test-results\/?$/m);
		expect(text).toMatch(/^playwright-report\/?$/m);
		expect(text).toMatch(/^\.devstack\/?$/m);
		expect(text).toMatch(/src\/generated\/?/);
	});
});
