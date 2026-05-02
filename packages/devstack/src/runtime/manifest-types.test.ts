// `manifest-types.ts` is a pure-type module (no runtime code), so this
// suite covers the migration-aware read path in `manifest-reader.ts`
// that consumes those types — the only place where the `version` field
// actually drives behavior.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Network } from '../core/types.js';
import { readManifestWithMigration } from './manifest-reader.js';
import { type Manifest, manifestPath, writeManifest } from './manifest-writer.js';
import { RegistryImpl } from '../registry/index.js';

let tmpDirs: string[] = [];

const newAppDir = (): string => {
	const dir = mkdtempSync(join(tmpdir(), 'devstack-manifest-types-'));
	tmpDirs.push(dir);
	return dir;
};

const writeRawManifest = (
	appDir: string,
	stack: string,
	network: Network,
	body: object,
): string => {
	const path = manifestPath({ appDir, stack, network });
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(body), 'utf8');
	return path;
};

beforeEach(() => {
	tmpDirs = [];
});

afterEach(() => {
	for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe('readManifestWithMigration — current version (v2)', () => {
	it('returns null when the manifest file does not exist', () => {
		const appDir = newAppDir();
		const result = readManifestWithMigration({
			appDir,
			stack: 'main',
			network: 'localnet',
		});
		expect(result).toBeNull();
	});

	it('round-trips a v2 manifest written by writeManifest unchanged', () => {
		const appDir = newAppDir();
		const reg = new RegistryImpl();
		reg.tokens.register({
			name: 'sui',
			type: '0x2::sui::SUI',
			decimals: 9,
		});
		writeManifest({
			appName: 'demo',
			appDir,
			stack: 'main',
			network: 'localnet',
			registry: reg,
		});
		const result = readManifestWithMigration({
			appDir,
			stack: 'main',
			network: 'localnet',
		});
		expect(result).not.toBeNull();
		expect(result?.version).toBe(2);
		expect(result?.app).toBe('demo');
		expect(result?.network).toBe('localnet');
		expect(result?.registry.tokens).toEqual([
			{ name: 'sui', type: '0x2::sui::SUI', decimals: 9 },
		]);
	});

	it('passes a hand-rolled v2 manifest through the migration loop unchanged', () => {
		const appDir = newAppDir();
		const v2: Manifest = {
			app: 'demo',
			network: 'localnet',
			version: 2,
			emittedAt: '2024-01-01T00:00:00.000Z',
			registry: {
				tokens: [],
				packages: [],
				accounts: [],
				services: [],
			},
		};
		writeRawManifest(appDir, 'main', 'localnet', v2);
		const result = readManifestWithMigration({
			appDir,
			stack: 'main',
			network: 'localnet',
		});
		expect(result).toEqual(v2);
	});
});

describe('readManifestWithMigration — out-of-band versions', () => {
	// Current behavior: the migration table (`MANIFEST_MIGRATIONS` in
	// manifest-reader.ts) is empty — every writer emits v2, so there's
	// no v1→v2 step yet. Anything that isn't already v2 falls into the
	// "unknown version" branch and throws with an actionable message.

	it('throws on a legacy manifest with no version field (current behavior — no default-to-1 fallback)', () => {
		const appDir = newAppDir();
		writeRawManifest(appDir, 'main', 'localnet', {
			app: 'demo',
			network: 'localnet',
			emittedAt: '2024-01-01T00:00:00.000Z',
			registry: { tokens: [], packages: [], accounts: [], services: [] },
		});
		expect(() =>
			readManifestWithMigration({
				appDir,
				stack: 'main',
				network: 'localnet',
			}),
		).toThrow(/unknown manifest version/);
	});

	it('throws on a future-version manifest with an actionable message', () => {
		const appDir = newAppDir();
		writeRawManifest(appDir, 'main', 'localnet', {
			app: 'demo',
			network: 'localnet',
			version: 99,
			emittedAt: '2024-01-01T00:00:00.000Z',
			registry: { tokens: [], packages: [], accounts: [], services: [] },
		});
		expect(() =>
			readManifestWithMigration({
				appDir,
				stack: 'main',
				network: 'localnet',
			}),
		).toThrow(/unknown manifest version 99/);
	});

	it('future-version error mentions the target version (2) and points to `devstack reset`', () => {
		const appDir = newAppDir();
		writeRawManifest(appDir, 'main', 'localnet', {
			app: 'demo',
			network: 'localnet',
			version: 99,
			emittedAt: '2024-01-01T00:00:00.000Z',
			registry: { tokens: [], packages: [], accounts: [], services: [] },
		});
		expect(() =>
			readManifestWithMigration({
				appDir,
				stack: 'main',
				network: 'localnet',
			}),
		).toThrow(/devstack reset/);
	});
});
