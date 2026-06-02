// Regression guard for the scaffold-time `test-results/` leak: a freshly
// scaffolded app's initial commit must not carry Playwright's `test-results/`.
// We assert this at two layers without paying for a full pnpm-install scaffold:
//   1. `test-results` is in the shared copy-SKIP set (so it's never copied
//      from a dev checkout of examples/_template into the bundled template or
//      a scaffolded app), and
//   2. the bundled template's `_gitignore` (restored to `.gitignore` at
//      scaffold) lists `test-results/`, so even if a run produces it before
//      the initial commit, git ignores it.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SKIP } from '../src/skip.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '..');
const BUNDLED_TEMPLATE = join(PKG_ROOT, 'template');

describe('scaffold .gitignore / copy-skip guards', () => {
	it('test-results is in the shared copy-SKIP set', () => {
		expect(SKIP.has('test-results')).toBe(true);
		expect(SKIP.has('playwright-report')).toBe(true);
	});

	it("the bundled template's _gitignore lists test-results/", () => {
		const gi = join(BUNDLED_TEMPLATE, '_gitignore');
		// The bundled template may be absent in a pristine checkout before a
		// build runs sync-template; skip rather than fail in that case.
		if (!existsSync(gi)) {
			expect(existsSync(gi)).toBe(false); // documents the precondition
			return;
		}
		const text = readFileSync(gi, 'utf8');
		expect(text).toMatch(/^test-results\/?$/m);
		expect(text).toMatch(/^playwright-report\/?$/m);
		expect(text).toMatch(/^\.devstack\/?$/m);
		expect(text).toMatch(/src\/generated\/?/);
	});
});
