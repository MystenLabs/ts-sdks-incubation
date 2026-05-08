import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { findManifestForCwd } from './manifest-discovery.js';
import type { Manifest } from './manifest-types.js';

let tmpDirs: string[] = [];

const newTmpDir = (): string => {
	const dir = mkdtempSync(join(tmpdir(), 'devstack-manifest-discovery-'));
	tmpDirs.push(dir);
	return dir;
};

const writeManifest = (path: string, label: string): Manifest => {
	mkdirSync(join(path, '..'), { recursive: true });
	const manifest: Manifest = {
		app: label,
		network: 'localnet',
		emittedAt: new Date(0).toISOString(),
		registry: {
			packages: [],
			accounts: [],
			services: [],
		},
	};
	writeFileSync(path, JSON.stringify(manifest), 'utf8');
	return manifest;
};

const seedAppDir = (stack = 'main'): { appDir: string; manifestPath: string } => {
	const appDir = newTmpDir();
	writeFileSync(join(appDir, 'devstack.config.ts'), '// stub\n', 'utf8');
	const manifestPath = join(appDir, '.devstack', 'stacks', stack, 'manifest.json');
	writeManifest(manifestPath, `app-${stack}`);
	return { appDir, manifestPath };
};

beforeEach(() => {
	tmpDirs = [];
});

afterEach(() => {
	for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

describe('findManifestForCwd — precedence', () => {
	it('explicit path takes precedence over env var and cwd-walk', () => {
		// Set up an env-var manifest and a cwd-walk manifest, both readable.
		// Then point explicitPath at a third manifest and check it wins.
		const envDir = newTmpDir();
		const envManifestPath = join(envDir, 'env-manifest.json');
		writeManifest(envManifestPath, 'env');
		vi.stubEnv('DEVSTACK_MANIFEST_PATH', envManifestPath);

		const { appDir } = seedAppDir();

		const explicitDir = newTmpDir();
		const explicitPath = join(explicitDir, 'explicit-manifest.json');
		writeManifest(explicitPath, 'explicit');

		const result = findManifestForCwd({
			explicitPath,
			cwd: appDir,
		});
		expect(result.path).toBe(explicitPath);
		expect(result.manifest.app).toBe('explicit');
	});

	it('env var takes precedence over cwd-walk', () => {
		const { appDir } = seedAppDir();

		const envDir = newTmpDir();
		const envManifestPath = join(envDir, 'env-manifest.json');
		writeManifest(envManifestPath, 'env');
		vi.stubEnv('DEVSTACK_MANIFEST_PATH', envManifestPath);

		const result = findManifestForCwd({ cwd: appDir });
		expect(result.path).toBe(envManifestPath);
		expect(result.manifest.app).toBe('env');
	});

	it('cwd-walk finds manifest when no env / explicit override is set', () => {
		const { appDir, manifestPath } = seedAppDir();
		vi.stubEnv('DEVSTACK_MANIFEST_PATH', '');

		const result = findManifestForCwd({ cwd: appDir });
		expect(result.path).toBe(manifestPath);
		expect(result.manifest.app).toBe('app-main');
	});
});

describe('findManifestForCwd — cwd walk', () => {
	it('finds manifest in a parent dir of cwd', () => {
		const { appDir, manifestPath } = seedAppDir();
		const nested = join(appDir, 'src', 'deeply', 'nested');
		mkdirSync(nested, { recursive: true });
		vi.stubEnv('DEVSTACK_MANIFEST_PATH', '');

		const result = findManifestForCwd({ cwd: nested });
		expect(result.path).toBe(manifestPath);
	});

	it('respects opts.stack when picking the manifest under .devstack/stacks/', () => {
		const { appDir, manifestPath } = seedAppDir('feature-x');
		vi.stubEnv('DEVSTACK_MANIFEST_PATH', '');
		vi.stubEnv('DEVSTACK_STACK', '');

		const result = findManifestForCwd({ cwd: appDir, stack: 'feature-x' });
		expect(result.path).toBe(manifestPath);
		expect(result.manifest.app).toBe('app-feature-x');
	});

	it('respects DEVSTACK_STACK env when no opts.stack is set', () => {
		const { appDir, manifestPath } = seedAppDir('feature-y');
		vi.stubEnv('DEVSTACK_MANIFEST_PATH', '');
		vi.stubEnv('DEVSTACK_STACK', 'feature-y');

		const result = findManifestForCwd({ cwd: appDir });
		expect(result.path).toBe(manifestPath);
	});

	it('defaults to "main" stack when neither opts.stack nor env is set', () => {
		const { appDir, manifestPath } = seedAppDir('main');
		vi.stubEnv('DEVSTACK_MANIFEST_PATH', '');
		vi.stubEnv('DEVSTACK_STACK', '');

		const result = findManifestForCwd({ cwd: appDir });
		expect(result.path).toBe(manifestPath);
	});
});

describe('findManifestForCwd — failure modes', () => {
	it('throws with hint when no manifest is found anywhere', () => {
		// cwd outside any devstack tree, no env override.
		const isolated = newTmpDir();
		vi.stubEnv('DEVSTACK_MANIFEST_PATH', '');

		expect(() => findManifestForCwd({ cwd: isolated })).toThrow(
			/no devstack manifest found/,
		);
		expect(() => findManifestForCwd({ cwd: isolated })).toThrow(
			/devstack apply/,
		);
	});

	it('lists all paths attempted in the error message', () => {
		const isolated = newTmpDir();
		const phantomEnvPath = join(newTmpDir(), 'no-such-manifest.json');
		vi.stubEnv('DEVSTACK_MANIFEST_PATH', phantomEnvPath);

		try {
			findManifestForCwd({ cwd: isolated });
			throw new Error('expected throw');
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).toContain(phantomEnvPath);
			expect(msg).toContain('Looked at');
		}
	});

	it('explicitPath that does not exist falls through to env / cwd-walk', () => {
		// Spec wording: "explicitPath takes precedence" — but if the path
		// doesn't resolve, the helper should still try the next layer rather
		// than blindly throwing on a non-existent override. Verify this so
		// CI tooling that conditionally sets explicitPath isn't punished.
		const { appDir, manifestPath } = seedAppDir();
		vi.stubEnv('DEVSTACK_MANIFEST_PATH', '');
		const phantom = join(newTmpDir(), 'phantom.json');

		const result = findManifestForCwd({
			explicitPath: phantom,
			cwd: appDir,
		});
		expect(result.path).toBe(manifestPath);
	});
});
