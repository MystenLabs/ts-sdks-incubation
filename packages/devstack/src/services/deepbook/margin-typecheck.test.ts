// P4.T5 — typecheck-required `pyth: Ref<Pyth>` enforcement.
//
// The plan demands a test that runs `pnpm tsc --noEmit` against a
// deliberately-broken config that OMITS the `pyth` option and asserts
// non-zero exit. The fixture lives at
// `test-setup/fixtures/margin/no-pyth.fixture.ts`; this test spawns a
// dedicated `tsc --noEmit` against a generated tsconfig that points at
// the fixture only — so the broken config doesn't poison the normal
// package-wide typecheck.
//
// The generated tsconfig is written INSIDE the package root (and
// deleted in `finally`) so the `@types/node` resolution rooted at the
// package's `node_modules` works during the dedicated typecheck pass.
// `tsconfig.json` already excludes `test-setup/**` from `include`, so
// the fixture file doesn't participate in the package's main
// `pnpm tsc --noEmit` invocation — only this dedicated test sees it.
//
// Skip semantics: the test invokes `tsc` via the workspace's
// `node_modules/.bin/tsc` binary; if that's not yet hoisted (CI cold
// install hasn't run yet), the test silently skips. Pre-condition for
// the skip is checked at test-discovery time so the skip is visible.

import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';

const PKG_ROOT = path.resolve(__dirname, '../../../');
const FIXTURE = path.join(PKG_ROOT, 'test-setup/fixtures/margin/no-pyth.fixture.ts');

const tscBin = path.join(PKG_ROOT, 'node_modules/.bin/tsc');

describe('deepbookMargin typecheck enforcement (P4.T5 L1)', () => {
	it.skipIf(!existsSync(tscBin))(
		'rejects a config that omits `pyth` (D5 — typecheck-enforced Pyth+Margin coupling)',
		() => {
			expect(existsSync(FIXTURE), `fixture missing: ${FIXTURE}`).toBe(true);

			// Generated tsconfig sits at the package root so `@types/node`
			// resolution finds the package's own `node_modules`. Random
			// suffix prevents concurrent vitest workers from stepping on
			// each other; deleted in `finally`.
			const tsconfigPath = path.join(
				PKG_ROOT,
				`.margin-typecheck-${randomBytes(4).toString('hex')}.tsconfig.json`,
			);
			writeFileSync(
				tsconfigPath,
				JSON.stringify(
					{
						extends: './tsconfig.json',
						compilerOptions: { noEmit: true, declaration: false },
						include: [path.relative(PKG_ROOT, FIXTURE)],
					},
					null,
					2,
				),
			);
			try {
				const result = spawnSync(tscBin, ['--noEmit', '-p', tsconfigPath], {
					cwd: PKG_ROOT,
					stdio: ['ignore', 'pipe', 'pipe'],
					encoding: 'utf8',
					timeout: 60_000,
				});
				if (result.error) {
					throw new Error(`tsc failed to spawn: ${result.error.message}`);
				}
				// Non-zero exit = the typecheck rejected the broken config = test passes.
				expect(
					result.status,
					`tsc unexpectedly exited 0 (the missing-pyth typecheck enforcement may have regressed).\n` +
						`stdout=${result.stdout}\nstderr=${result.stderr}`,
				).not.toBe(0);
				// The diagnostic should mention the missing `pyth` property OR
				// the more generic "Property 'pyth' is missing" / "argument
				// is not assignable" forms tsc emits depending on the
				// closeness of the call site to the function signature.
				// Loose match — multiple equivalent diagnostic shapes
				// satisfy the same intent.
				const combined = `${result.stdout}\n${result.stderr}`;
				expect(combined).toMatch(/pyth|missing.*propert|not assignable|argument/i);
			} finally {
				rmSync(tsconfigPath, { force: true });
			}
		},
		90_000,
	);
});
