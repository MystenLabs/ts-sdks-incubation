// Tests for `discoverManifestPath()` — env-var override, stack-scoped
// path, and walk-up behavior. Each test sets up a tmp tree, runs the
// helper with explicit `cwd` / `stack` / `stateDir` arguments so the
// test isn't sensitive to ambient `DEVSTACK_*` env vars, and asserts
// the resolved path. The env-var test sets `DEVSTACK_MANIFEST_PATH`
// directly and restores it on teardown.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverManifestPath } from './discover-manifest.js';

describe('discoverManifestPath', () => {
	let tmp: string;
	const savedEnv = {
		DEVSTACK_MANIFEST_PATH: undefined as string | undefined,
		DEVSTACK_STACK: undefined as string | undefined,
		DEVSTACK_STATE_DIR: undefined as string | undefined,
	};

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), 'discover-manifest-'));
		savedEnv.DEVSTACK_MANIFEST_PATH = process.env.DEVSTACK_MANIFEST_PATH;
		savedEnv.DEVSTACK_STACK = process.env.DEVSTACK_STACK;
		savedEnv.DEVSTACK_STATE_DIR = process.env.DEVSTACK_STATE_DIR;
		delete process.env.DEVSTACK_MANIFEST_PATH;
		delete process.env.DEVSTACK_STACK;
		delete process.env.DEVSTACK_STATE_DIR;
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
		// Restore env vars verbatim — including the `undefined` case
		// (clear them) so a test that sets an env doesn't leak into the
		// next file.
		for (const key of ['DEVSTACK_MANIFEST_PATH', 'DEVSTACK_STACK', 'DEVSTACK_STATE_DIR'] as const) {
			const prev = savedEnv[key];
			if (prev === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = prev;
			}
		}
	});

	it('returns the path from DEVSTACK_MANIFEST_PATH when set and the file exists', () => {
		const manifest = join(tmp, 'custom-manifest.json');
		writeFileSync(manifest, '{}');
		process.env.DEVSTACK_MANIFEST_PATH = manifest;
		expect(discoverManifestPath({ cwd: tmp })).toBe(resolve(manifest));
	});

	it('returns undefined when DEVSTACK_MANIFEST_PATH points at a missing file', () => {
		process.env.DEVSTACK_MANIFEST_PATH = join(tmp, 'does-not-exist.json');
		expect(discoverManifestPath({ cwd: tmp })).toBeUndefined();
	});

	it('throws on a missing DEVSTACK_MANIFEST_PATH when required: true', () => {
		process.env.DEVSTACK_MANIFEST_PATH = join(tmp, 'does-not-exist.json');
		expect(() => discoverManifestPath({ cwd: tmp, required: true })).toThrowError(
			/DEVSTACK_MANIFEST_PATH/,
		);
	});

	it('returns the override path when it exists, ignoring walk-up', () => {
		const manifest = join(tmp, 'somewhere', 'else.json');
		mkdirSync(join(tmp, 'somewhere'), { recursive: true });
		writeFileSync(manifest, '{}');
		// Also write a walk-up candidate to prove override wins.
		mkdirSync(join(tmp, '.devstack'), { recursive: true });
		writeFileSync(join(tmp, '.devstack', 'manifest.json'), '{}');
		expect(discoverManifestPath({ cwd: tmp, override: manifest })).toBe(resolve(manifest));
	});

	it('finds the stack-scoped manifest at the cwd level', () => {
		const stackPath = join(tmp, '.devstack', 'stacks', 'main', 'manifest.json');
		mkdirSync(join(tmp, '.devstack', 'stacks', 'main'), { recursive: true });
		writeFileSync(stackPath, '{}');
		expect(discoverManifestPath({ cwd: tmp })).toBe(stackPath);
	});

	it('ignores a stale flat manifest — only stack-scoped paths count', () => {
		// The supervisor never writes to `.devstack/manifest.json` since
		// the codegen redesign — any hit there is leftover from older
		// runs (or a removed snapshot stack) and would steer callers at
		// the wrong URLs / package ids.
		const flatPath = join(tmp, '.devstack', 'manifest.json');
		mkdirSync(join(tmp, '.devstack'), { recursive: true });
		writeFileSync(flatPath, '{}');
		expect(discoverManifestPath({ cwd: tmp })).toBeUndefined();
	});

	it('honors the DEVSTACK_STACK env var when picking the stack-scoped path', () => {
		const stackPath = join(tmp, '.devstack', 'stacks', 'test', 'manifest.json');
		mkdirSync(join(tmp, '.devstack', 'stacks', 'test'), { recursive: true });
		writeFileSync(stackPath, '{}');
		// Stale flat manifest also present — must NOT be returned.
		writeFileSync(join(tmp, '.devstack', 'manifest.json'), '{}');
		process.env.DEVSTACK_STACK = 'test';
		expect(discoverManifestPath({ cwd: tmp })).toBe(stackPath);
	});

	it('walks up from a nested cwd to find the stack-scoped manifest at a parent dir', () => {
		const stackPath = join(tmp, '.devstack', 'stacks', 'main', 'manifest.json');
		mkdirSync(join(tmp, '.devstack', 'stacks', 'main'), { recursive: true });
		writeFileSync(stackPath, '{}');
		const nested = join(tmp, 'apps', 'web', 'src');
		mkdirSync(nested, { recursive: true });
		expect(discoverManifestPath({ cwd: nested })).toBe(stackPath);
	});

	it('returns undefined when no candidate exists anywhere up the tree', () => {
		// Use a sentinel stateDir name that won't collide with any
		// `.devstack/manifest.json` left over higher up the filesystem
		// from prior real-stack runs (macOS tmp roots commonly carry
		// stale developer state in `/var/folders/.../`).
		expect(discoverManifestPath({ cwd: tmp, stateDir: '.devstack-test-sentinel' })).toBeUndefined();
	});

	it('throws a guiding error on miss when required: true', () => {
		expect(() =>
			discoverManifestPath({
				cwd: tmp,
				stateDir: '.devstack-test-sentinel',
				required: true,
			}),
		).toThrowError(/no manifest\.json found/);
	});

	it('honors an explicit stateDir option that overrides .devstack', () => {
		const stateDir = '.custom-state';
		const stackPath = join(tmp, stateDir, 'stacks', 'main', 'manifest.json');
		mkdirSync(join(tmp, stateDir, 'stacks', 'main'), { recursive: true });
		writeFileSync(stackPath, '{}');
		expect(discoverManifestPath({ cwd: tmp, stateDir })).toBe(stackPath);
	});

	// Nested-project layout — two `.devstack/stacks/main/manifest.json`
	// files exist, one in an outer project and one in a nested inner
	// project. The walk-up algorithm climbs parent-by-parent from `cwd`
	// and returns the FIRST hit, which means "closest wins": a `cwd`
	// inside the inner project resolves to the inner manifest, while a
	// `cwd` that's inside the outer project but outside the inner one
	// resolves to the outer manifest. Documented as a known limitation
	// in `round1/13-runtime-manifest.md § 4.10`; users that need to
	// reach across nesting can use `DEVSTACK_MANIFEST_PATH` or
	// `override:`.
	describe('nested-project walk-up', () => {
		const setupNestedLayout = () => {
			const outerManifest = join(tmp, '.devstack', 'stacks', 'main', 'manifest.json');
			mkdirSync(join(tmp, '.devstack', 'stacks', 'main'), { recursive: true });
			writeFileSync(outerManifest, '{"outer": true}');
			const innerRoot = join(tmp, 'apps', 'nested');
			const innerManifest = join(innerRoot, '.devstack', 'stacks', 'main', 'manifest.json');
			mkdirSync(join(innerRoot, '.devstack', 'stacks', 'main'), { recursive: true });
			writeFileSync(innerManifest, '{"inner": true}');
			return { outerManifest, innerRoot, innerManifest };
		};

		it('returns the inner manifest when cwd is inside the inner project (closest wins)', () => {
			const { innerRoot, innerManifest } = setupNestedLayout();
			const nestedCwd = join(innerRoot, 'src', 'feature');
			mkdirSync(nestedCwd, { recursive: true });
			expect(discoverManifestPath({ cwd: nestedCwd })).toBe(innerManifest);
		});

		it('returns the outer manifest when cwd is inside the outer project but outside the inner one', () => {
			const { outerManifest } = setupNestedLayout();
			// cwd is a sibling of the inner project — still under the
			// outer root, but the walk-up never traverses into the inner
			// `apps/nested/` subtree.
			const siblingCwd = join(tmp, 'apps', 'other');
			mkdirSync(siblingCwd, { recursive: true });
			expect(discoverManifestPath({ cwd: siblingCwd })).toBe(outerManifest);
		});
	});
});
