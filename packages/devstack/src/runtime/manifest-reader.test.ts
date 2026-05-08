// Manifest-reader tests. The hydrate path is the one place a renamed
// `app:` could silently load another app's persisted state into a
// fresh registry — so the validator earns a unit test even though
// hydrateRegistry is otherwise mostly delegation to the Registry.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RegistryImpl } from '../registry/index.js';
import { ManifestAppMismatchError, hydrateRegistry } from './manifest-reader.js';
import type { Manifest } from './manifest-types.js';
import { manifestPath } from './manifest-writer.js';

let tmpDirs: string[] = [];

const newTmpDir = (): string => {
	const dir = mkdtempSync(join(tmpdir(), 'devstack-manifest-reader-'));
	tmpDirs.push(dir);
	return dir;
};

const writeManifestAt = (path: string, app: string): Manifest => {
	mkdirSync(dirname(path), { recursive: true });
	const manifest: Manifest = {
		app,
		network: 'localnet',
		emittedAt: new Date(0).toISOString(),
		registry: {
			packages: [
				{
					name: 'pkg.alpha',
					packageId: '0xabc',
					captured: {},
					network: 'localnet',
				},
			],
			accounts: [],
			services: [],
		},
	};
	writeFileSync(path, JSON.stringify(manifest), 'utf8');
	return manifest;
};

beforeEach(() => {
	tmpDirs = [];
});

afterEach(() => {
	for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

describe('hydrateRegistry — manifest.app validation', () => {
	it('hydrates when manifest.app matches the supplied appName', () => {
		const appDir = newTmpDir();
		const path = manifestPath({ appDir, stack: 'main', network: 'localnet' });
		writeManifestAt(path, 'my-app');
		const registry = new RegistryImpl();
		const hydrated = hydrateRegistry({
			appName: 'my-app',
			appDir,
			stack: 'main',
			network: 'localnet',
			registry,
		});
		expect(hydrated).toBe(true);
		expect(registry.packages.list().map((p) => p.name)).toEqual(['pkg.alpha']);
	});

	it('returns false when no manifest exists (cold start)', () => {
		const appDir = newTmpDir();
		const registry = new RegistryImpl();
		const hydrated = hydrateRegistry({
			appName: 'my-app',
			appDir,
			stack: 'main',
			network: 'localnet',
			registry,
		});
		expect(hydrated).toBe(false);
	});

	it('throws ManifestAppMismatchError when manifest.app differs from appName', () => {
		const appDir = newTmpDir();
		const path = manifestPath({ appDir, stack: 'main', network: 'localnet' });
		writeManifestAt(path, 'old-app');
		const registry = new RegistryImpl();
		expect(() =>
			hydrateRegistry({
				appName: 'new-app',
				appDir,
				stack: 'main',
				network: 'localnet',
				registry,
			}),
		).toThrowError(ManifestAppMismatchError);
	});

	it('mismatch error carries the manifest path, old app, and new app', () => {
		const appDir = newTmpDir();
		const path = manifestPath({ appDir, stack: 'main', network: 'localnet' });
		writeManifestAt(path, 'old-app');
		const registry = new RegistryImpl();
		try {
			hydrateRegistry({
				appName: 'new-app',
				appDir,
				stack: 'main',
				network: 'localnet',
				registry,
			});
			expect.fail('expected hydrateRegistry to throw');
		} catch (err) {
			expect(err).toBeInstanceOf(ManifestAppMismatchError);
			const e = err as ManifestAppMismatchError;
			expect(e.manifestApp).toBe('old-app');
			expect(e.currentApp).toBe('new-app');
			expect(e.manifestPath).toBe(path);
			// Message names the path, both app names, and the remediation.
			expect(e.message).toContain(path);
			expect(e.message).toContain("'old-app'");
			expect(e.message).toContain("'new-app'");
			expect(e.message).toContain('devstack wipe --yes');
		}
	});

	it('does not mutate the registry when the validator throws', () => {
		const appDir = newTmpDir();
		const path = manifestPath({ appDir, stack: 'main', network: 'localnet' });
		writeManifestAt(path, 'old-app');
		const registry = new RegistryImpl();
		registry.packages.register({
			name: 'pre-existing',
			packageId: '0x000',
			captured: {},
			network: 'localnet',
		});
		expect(() =>
			hydrateRegistry({
				appName: 'new-app',
				appDir,
				stack: 'main',
				network: 'localnet',
				registry,
			}),
		).toThrow();
		// The manifest's `pkg.alpha` must NOT have been registered alongside
		// the pre-existing entry — the throw happens before the bulk-load
		// loop runs.
		expect(registry.packages.list().map((p) => p.name)).toEqual(['pre-existing']);
	});
});
