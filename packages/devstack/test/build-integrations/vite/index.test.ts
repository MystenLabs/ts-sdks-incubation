// `devstackVitePlugin` — `@generated` alias resolution tests.
//
// The plugin points an import alias (default `@generated`) at the
// ACTIVE stack's codegen output dir so two stacks of the same app
// resolve `@generated/*` to different directories. Resolution order
// (src/build-integrations/vite/index.ts):
//   1. `options.generatedDir` — explicit escape hatch, resolved against
//      the Vite root.
//   2. manifest-recorded `codegen.generatedDir` for the active stack
//      (discovered via `resolveDiscoveryEnv(process.env)` +
//      `discoverManifestPath(...)`).
//   3. cold-start fallback → `<root>/src/generated`.
//
// The plugin reads `process.env` directly, so we snapshot/restore it
// around every test. To make manifest discovery deterministic (no cwd
// walk-up), we set `DEVSTACK_STATE_DIR` to the ABSOLUTE temp root:
// `discoverManifestPath` degenerates an absolute stateDir to a single
// existence check at `<stateDir>/stacks/<stack>/manifest.json`.
//
// Signature notes matched from the impl:
//   - `devstackVitePlugin(options?)` returns `{ name, config }`.
//   - `config` is a PLAIN SYNC FUNCTION (not a `{ handler }` object):
//     `config(userConfig) => ({ resolve: { alias: { [prefix]: dir } } })`.
//   - The hook reads `userConfig.root` (defaults to `process.cwd()`),
//     used for relative-`generatedDir` resolution and the fallback.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';

import {
	DEFAULT_DEV_EXTRAS_ALIAS,
	DEFAULT_GENERATED_ALIAS,
	devstackVitePlugin,
} from '../../../src/build-integrations/vite/index.ts';
import { withTempRootSync } from '../../helpers/with-temp-root.ts';

const ENV_KEYS = [
	'DEVSTACK_STACK',
	'DEVSTACK_STATE_DIR',
	'DEVSTACK_RUNTIME_ROOT',
	'DEVSTACK_MANIFEST_PATH',
] as const;
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

/** Plant a stack manifest containing `codegen.generatedDir` at the
 *  supervisor-written path under an absolute state root. */
const writeStackManifest = (
	stateRoot: string,
	stack: string,
	generatedDir: string,
	extrasDir?: string,
): string => {
	const dir = join(stateRoot, 'stacks', stack);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, 'manifest.json');
	writeFileSync(
		path,
		JSON.stringify({
			identity: { app: 'demo', stack, chain: 'sui:local' },
			manifestVersion: 1,
			services: {},
			endpoints: {},
			extras: {},
			codegen: { generatedDir, ...(extrasDir !== undefined ? { extrasDir } : {}) },
		}),
	);
	return path;
};

describe('devstackVitePlugin', () => {
	it('exposes the expected structural plugin shape', () => {
		const plugin = devstackVitePlugin();
		expect(plugin.name).toBe('devstack:generated-alias');
		expect(typeof plugin.config).toBe('function');
	});

	it('manifest hit → aliases @generated at the manifest codegen.generatedDir', () =>
		withTempRootSync('devstack-vite', (tmp) => {
			const generatedDir = join(tmp, '.devstack', 'stacks', 'e2e', 'generated');
			writeStackManifest(tmp, 'e2e', generatedDir);
			// Absolute state root → single-existence-check discovery, no
			// cwd dependence. DEVSTACK_STACK selects the stack subdir.
			process.env.DEVSTACK_STATE_DIR = tmp;
			process.env.DEVSTACK_STACK = 'e2e';

			const plugin = devstackVitePlugin();
			const patch = plugin.config({ root: tmp });
			expect(patch.resolve.alias[DEFAULT_GENERATED_ALIAS]).toBe(generatedDir);
		}));

	it('options.generatedDir escape hatch wins over the manifest (absolute passthrough)', () =>
		withTempRootSync('devstack-vite', (tmp) => {
			// A manifest exists, but the explicit escape hatch must bypass
			// discovery entirely.
			writeStackManifest(tmp, 'e2e', join(tmp, 'manifest-dir'));
			process.env.DEVSTACK_STATE_DIR = tmp;
			process.env.DEVSTACK_STACK = 'e2e';

			const explicit = join(tmp, 'hand', 'picked', 'generated');
			const plugin = devstackVitePlugin({ generatedDir: explicit });
			const patch = plugin.config({ root: tmp });
			expect(patch.resolve.alias[DEFAULT_GENERATED_ALIAS]).toBe(explicit);
		}));

	it('options.generatedDir relative path is resolved against the Vite root', () =>
		withTempRootSync('devstack-vite', (tmp) => {
			const plugin = devstackVitePlugin({ generatedDir: 'custom/gen' });
			const patch = plugin.config({ root: tmp });
			expect(patch.resolve.alias[DEFAULT_GENERATED_ALIAS]).toBe(resolve(tmp, 'custom/gen'));
		}));

	it('custom options.alias prefix is used as the alias key', () =>
		withTempRootSync('devstack-vite', (tmp) => {
			const generatedDir = join(tmp, '.devstack', 'stacks', 'e2e', 'generated');
			writeStackManifest(tmp, 'e2e', generatedDir);
			process.env.DEVSTACK_STATE_DIR = tmp;
			process.env.DEVSTACK_STACK = 'e2e';

			const plugin = devstackVitePlugin({ alias: '@gen' });
			const patch = plugin.config({ root: tmp });
			expect(patch.resolve.alias['@gen']).toBe(generatedDir);
			// And the default prefix is NOT also present.
			expect(patch.resolve.alias[DEFAULT_GENERATED_ALIAS]).toBeUndefined();
		}));

	it('no manifest → cold-start fallback to <root>/src/generated', () =>
		withTempRootSync('devstack-vite', (tmp) => {
			// Point discovery at the temp root but write NO manifest, so the
			// single existence check misses and the plugin falls back.
			process.env.DEVSTACK_STATE_DIR = tmp;
			process.env.DEVSTACK_STACK = 'main';

			const plugin = devstackVitePlugin();
			const patch = plugin.config({ root: tmp });
			expect(patch.resolve.alias[DEFAULT_GENERATED_ALIAS]).toBe(resolve(tmp, 'src/generated'));
		}));

	it('manifest hit → also aliases @devstack-dev at codegen.extrasDir', () =>
		withTempRootSync('devstack-vite', (tmp) => {
			const generatedDir = join(tmp, '.devstack', 'stacks', 'e2e', 'generated');
			const extrasDir = join(tmp, '.devstack', 'stacks', 'e2e', 'generated-extras');
			writeStackManifest(tmp, 'e2e', generatedDir, extrasDir);
			process.env.DEVSTACK_STATE_DIR = tmp;
			process.env.DEVSTACK_STACK = 'e2e';

			const plugin = devstackVitePlugin();
			const patch = plugin.config({ root: tmp });
			expect(patch.resolve.alias[DEFAULT_GENERATED_ALIAS]).toBe(generatedDir);
			expect(patch.resolve.alias[DEFAULT_DEV_EXTRAS_ALIAS]).toBe(extrasDir);
		}));

	it('manifest hit without extrasDir → @devstack-dev cold-start fallback under .devstack/stacks/<stack>', () =>
		withTempRootSync('devstack-vite', (tmp) => {
			const generatedDir = join(tmp, '.devstack', 'stacks', 'e2e', 'generated');
			// Older manifest with generatedDir but no extrasDir.
			writeStackManifest(tmp, 'e2e', generatedDir);
			process.env.DEVSTACK_STATE_DIR = tmp;
			process.env.DEVSTACK_STACK = 'e2e';

			const plugin = devstackVitePlugin();
			const patch = plugin.config({ root: tmp });
			expect(patch.resolve.alias[DEFAULT_DEV_EXTRAS_ALIAS]).toBe(
				resolve(tmp, '.devstack', 'stacks', 'e2e', 'generated-extras'),
			);
		}));

	it('options.devExtrasDir escape hatch wins for @devstack-dev', () =>
		withTempRootSync('devstack-vite', (tmp) => {
			const explicit = join(tmp, 'hand', 'picked', 'extras');
			const plugin = devstackVitePlugin({ devExtrasDir: explicit });
			const patch = plugin.config({ root: tmp });
			expect(patch.resolve.alias[DEFAULT_DEV_EXTRAS_ALIAS]).toBe(explicit);
		}));

	it('manifest present but missing codegen field → cold-start fallback', () =>
		withTempRootSync('devstack-vite', (tmp) => {
			// A back-compat manifest with NO `codegen` key → readGeneratedDir
			// returns null → fallback to src/generated.
			const dir = join(tmp, 'stacks', 'main');
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, 'manifest.json'),
				JSON.stringify({
					identity: { app: 'demo', stack: 'main', chain: 'sui:local' },
					manifestVersion: 1,
					services: {},
					endpoints: {},
					extras: {},
				}),
			);
			process.env.DEVSTACK_STATE_DIR = tmp;
			process.env.DEVSTACK_STACK = 'main';

			const plugin = devstackVitePlugin();
			const patch = plugin.config({ root: tmp });
			expect(patch.resolve.alias[DEFAULT_GENERATED_ALIAS]).toBe(resolve(tmp, 'src/generated'));
		}));
});
