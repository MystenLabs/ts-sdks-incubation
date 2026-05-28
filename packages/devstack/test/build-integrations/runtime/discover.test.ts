// `discoverManifestPath` — sync walk-up resolver tests.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';

import {
	discoverManifestPath,
	discoverSingleStackManifestPath,
	ManifestDiscoveryError,
} from '../../../src/build-integrations/runtime/index.ts';

const ENV_KEYS = ['DEVSTACK_MANIFEST_PATH', 'DEVSTACK_STACK', 'DEVSTACK_STATE_DIR'] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
	for (const k of ENV_KEYS) saved[k] = process.env[k];
	for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
	for (const k of ENV_KEYS) {
		const v = saved[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

const makeStackManifest = (root: string, stack = 'main'): string => {
	const dir = join(root, '.devstack', 'stacks', stack);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, 'manifest.json');
	writeFileSync(path, '{}');
	return path;
};

describe('discoverManifestPath', () => {
	it('returns the path from DEVSTACK_MANIFEST_PATH when set and file exists', () => {
		const tmp = mkdtempSync(join(tmpdir(), 'devstack-discover-'));
		const path = makeStackManifest(tmp);
		process.env.DEVSTACK_MANIFEST_PATH = path;
		expect(discoverManifestPath()).toBe(path);
	});

	it('throws ManifestDiscoveryError(phase=env-missing) when DEVSTACK_MANIFEST_PATH points at a missing file', () => {
		// `required: false` does NOT suppress env-miss: the user
		// explicitly pointed at a path, so a typo must surface rather
		// than silently fall back to walk-up.
		process.env.DEVSTACK_MANIFEST_PATH = '/nonexistent/manifest.json';
		try {
			discoverManifestPath();
			expect.fail('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(ManifestDiscoveryError);
			expect((err as ManifestDiscoveryError).phase).toBe('env-missing');
		}
	});

	it('throws ManifestDiscoveryError(phase=env-missing) for missing env path when required', () => {
		process.env.DEVSTACK_MANIFEST_PATH = '/nonexistent/manifest.json';
		try {
			discoverManifestPath({ required: true });
			expect.fail('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(ManifestDiscoveryError);
			expect((err as ManifestDiscoveryError).phase).toBe('env-missing');
		}
	});

	it('honors override when set and existing, ignoring walk-up', () => {
		const tmp = mkdtempSync(join(tmpdir(), 'devstack-discover-'));
		const path = makeStackManifest(tmp);
		expect(discoverManifestPath({ override: path })).toBe(path);
	});

	it('throws ManifestDiscoveryError(phase=override-missing) when override does not exist and required', () => {
		try {
			discoverManifestPath({ override: '/nope.json', required: true });
			expect.fail('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(ManifestDiscoveryError);
			expect((err as ManifestDiscoveryError).phase).toBe('override-missing');
		}
	});

	it('walks up from a nested cwd to find the stack-scoped manifest', () => {
		const tmp = mkdtempSync(join(tmpdir(), 'devstack-discover-'));
		const path = makeStackManifest(tmp);
		const nested = join(tmp, 'a', 'b', 'c');
		mkdirSync(nested, { recursive: true });
		expect(discoverManifestPath({ cwd: nested })).toBe(path);
	});

	it('ignores a stale flat manifest (must use stack-scoped path only)', () => {
		const tmp = mkdtempSync(join(tmpdir(), 'devstack-discover-'));
		// Stale flat: NOT in `.devstack/stacks/main/manifest.json`.
		const flatDir = join(tmp, '.devstack');
		mkdirSync(flatDir, { recursive: true });
		writeFileSync(join(flatDir, 'manifest.json'), '{}');
		expect(discoverManifestPath({ cwd: tmp })).toBeUndefined();
	});

	it('honors DEVSTACK_STACK for stack selection', () => {
		const tmp = mkdtempSync(join(tmpdir(), 'devstack-discover-'));
		const path = makeStackManifest(tmp, 'feature-x');
		process.env.DEVSTACK_STACK = 'feature-x';
		expect(discoverManifestPath({ cwd: tmp })).toBe(path);
	});

	it('does not infer stack selection from package metadata when DEVSTACK_STACK is unset', () => {
		const tmp = mkdtempSync(join(tmpdir(), 'devstack-discover-'));
		writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: '@scope/wallet-demo' }));
		const path = makeStackManifest(tmp, 'main');
		expect(discoverManifestPath({ cwd: tmp })).toBe(path);
	});

	it('honors DEVSTACK_STATE_DIR for the state-dir override', () => {
		const tmp = mkdtempSync(join(tmpdir(), 'devstack-discover-'));
		const dir = join(tmp, '.devstack-alt', 'stacks', 'main');
		mkdirSync(dir, { recursive: true });
		const path = join(dir, 'manifest.json');
		writeFileSync(path, '{}');
		process.env.DEVSTACK_STATE_DIR = '.devstack-alt';
		expect(discoverManifestPath({ cwd: tmp })).toBe(path);
	});

	it('throws ManifestDiscoveryError(phase=walk-up) on miss when required', () => {
		const tmp = mkdtempSync(join(tmpdir(), 'devstack-discover-'));
		try {
			discoverManifestPath({ cwd: tmp, required: true });
			expect.fail('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(ManifestDiscoveryError);
			expect((err as ManifestDiscoveryError).phase).toBe('walk-up');
		}
	});

	it('returns undefined on miss when not required', () => {
		const tmp = mkdtempSync(join(tmpdir(), 'devstack-discover-'));
		expect(discoverManifestPath({ cwd: tmp })).toBeUndefined();
	});

	it('prefers the closest stack-scoped manifest in a nested-projects tree', () => {
		const outer = mkdtempSync(join(tmpdir(), 'devstack-discover-'));
		const outerPath = makeStackManifest(outer);
		const inner = join(outer, 'subapp');
		const innerPath = makeStackManifest(inner);
		// Sanity: outerPath != innerPath
		expect(outerPath).not.toBe(innerPath);
		expect(discoverManifestPath({ cwd: inner })).toBe(innerPath);
	});

	it('DEVSTACK_MANIFEST_PATH wins over a passed override', () => {
		const tmp = mkdtempSync(join(tmpdir(), 'devstack-discover-'));
		const envPath = makeStackManifest(tmp);
		const otherTmp = mkdtempSync(join(tmpdir(), 'devstack-discover-other-'));
		const overridePath = makeStackManifest(otherTmp);
		process.env.DEVSTACK_MANIFEST_PATH = envPath;
		expect(discoverManifestPath({ override: overridePath })).toBe(envPath);
	});
});

describe('discoverSingleStackManifestPath', () => {
	it('returns the manifest when exactly one stack exists at cwds stateDir', () => {
		const tmp = mkdtempSync(join(tmpdir(), 'devstack-single-'));
		const path = makeStackManifest(tmp, 'only-one');
		expect(discoverSingleStackManifestPath({ cwd: tmp })).toBe(path);
	});

	it('returns null when no stacks exist anywhere on the walk-up', () => {
		const tmp = mkdtempSync(join(tmpdir(), 'devstack-single-'));
		expect(discoverSingleStackManifestPath({ cwd: tmp })).toBeNull();
	});

	it('returns null (ambiguous) when multiple stacks exist at the same level', () => {
		const tmp = mkdtempSync(join(tmpdir(), 'devstack-single-'));
		makeStackManifest(tmp, 'stack-a');
		makeStackManifest(tmp, 'stack-b');
		expect(discoverSingleStackManifestPath({ cwd: tmp })).toBeNull();
	});

	it('walks up to an ancestor stateDir when cwds has none', () => {
		const outer = mkdtempSync(join(tmpdir(), 'devstack-single-'));
		const path = makeStackManifest(outer, 'lone');
		const nested = join(outer, 'a', 'b', 'c');
		mkdirSync(nested, { recursive: true });
		expect(discoverSingleStackManifestPath({ cwd: nested })).toBe(path);
	});

	it('honors a custom stateDir name', () => {
		const tmp = mkdtempSync(join(tmpdir(), 'devstack-single-'));
		const dir = join(tmp, '.devstack-alt', 'stacks', 'solo');
		mkdirSync(dir, { recursive: true });
		const path = join(dir, 'manifest.json');
		writeFileSync(path, '{}');
		expect(discoverSingleStackManifestPath({ cwd: tmp, stateDir: '.devstack-alt' })).toBe(path);
	});

	it('skips a stacks dir that holds only directories without manifests', () => {
		const tmp = mkdtempSync(join(tmpdir(), 'devstack-single-'));
		// Create stacks/half-baked/ with NO manifest.json — should be
		// treated as zero, not one.
		mkdirSync(join(tmp, '.devstack', 'stacks', 'half-baked'), { recursive: true });
		expect(discoverSingleStackManifestPath({ cwd: tmp })).toBeNull();
	});

	it('does not walk past an ambiguous level to find a higher single-stack', () => {
		// Outer has one stack; inner has two — caller cwd at inner should
		// see ambiguous and stop (returning null), NOT walk up to outer.
		const outer = mkdtempSync(join(tmpdir(), 'devstack-single-'));
		makeStackManifest(outer, 'outer-only');
		const inner = join(outer, 'sub');
		mkdirSync(inner, { recursive: true });
		makeStackManifest(inner, 'inner-a');
		makeStackManifest(inner, 'inner-b');
		expect(discoverSingleStackManifestPath({ cwd: inner })).toBeNull();
	});
});
