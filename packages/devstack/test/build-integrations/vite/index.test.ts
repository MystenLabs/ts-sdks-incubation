// `devstackVitePlugin` — `@generated` / `@devstack-dev` alias tests.
//
// `@generated` STATICALLY resolves to the committed `<root>/src/generated`
// tree (the single source of bindings, written by `devstack codegen`;
// ids resolve at runtime via `__DEVSTACK_IDS__`). Resolution order
// (src/build-integrations/vite/index.ts):
//   1. `options.generatedDir` — explicit escape hatch, resolved against
//      the Vite root.
//   2. `<root>/src/generated` — always.
//
// The `@devstack-dev` extras alias STILL resolves dynamically off the
// manifest's `codegen.extrasDir` (dev-only secret artifacts), so those
// tests plant a manifest. The plugin reads `process.env` directly, so we
// snapshot/restore it around every test. To make manifest discovery
// deterministic (no cwd walk-up), we set `DEVSTACK_STATE_DIR` to the
// ABSOLUTE temp root: `discoverManifestPath` degenerates an absolute
// stateDir to a single existence check at
// `<stateDir>/stacks/<stack>/manifest.json`.
//
// Signature notes matched from the impl:
//   - `devstackVitePlugin(options?)` returns `{ name, config }`.
//   - `config` is a PLAIN SYNC FUNCTION (not a `{ handler }` object):
//     `config(userConfig) => ({ resolve: { alias: { [prefix]: dir } } })`.
//   - The hook reads `userConfig.root` (defaults to `process.cwd()`),
//     used for relative-`options.generatedDir` resolution and the fallback.

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

/** Plant a stack manifest carrying the optional `codegen.extrasDir` (the
 *  `@devstack-dev` overlay source) at the supervisor-written path under an
 *  absolute state root. Bindings are not recorded in the manifest. */
const writeStackManifest = (
	stateRoot: string,
	stack: string,
	extrasDir?: string,
	idsFile?: string,
): string => {
	const dir = join(stateRoot, 'stacks', stack);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, 'manifest.json');
	writeFileSync(
		path,
		JSON.stringify({
			identity: { app: 'demo', stack, network: 'localnet' },
			manifestVersion: 1,
			services: {},
			endpoints: {},
			extras: {},
			codegen: {
				...(extrasDir !== undefined ? { extrasDir } : {}),
				...(idsFile !== undefined ? { idsFile } : {}),
			},
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

	it('@generated statically resolves to <root>/src/generated', () =>
		withTempRootSync('devstack-vite', (tmp) => {
			// A manifest is present; `@generated` is always the committed
			// `src/generated` tree regardless of what the manifest records.
			writeStackManifest(tmp, 'e2e');
			process.env.DEVSTACK_STATE_DIR = tmp;
			process.env.DEVSTACK_STACK = 'e2e';

			const plugin = devstackVitePlugin();
			const patch = plugin.config({ root: tmp });
			expect(patch.resolve.alias[DEFAULT_GENERATED_ALIAS]).toBe(resolve(tmp, 'src/generated'));
		}));

	it('options.generatedDir escape hatch wins (absolute passthrough)', () =>
		withTempRootSync('devstack-vite', (tmp) => {
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
			const plugin = devstackVitePlugin({ alias: '@gen' });
			const patch = plugin.config({ root: tmp });
			expect(patch.resolve.alias['@gen']).toBe(resolve(tmp, 'src/generated'));
			// And the default prefix is NOT also present.
			expect(patch.resolve.alias[DEFAULT_GENERATED_ALIAS]).toBeUndefined();
		}));

	it('manifest hit → also aliases @devstack-dev at codegen.extrasDir', () =>
		withTempRootSync('devstack-vite', (tmp) => {
			const extrasDir = join(tmp, '.devstack', 'stacks', 'e2e', 'generated-extras');
			writeStackManifest(tmp, 'e2e', extrasDir);
			process.env.DEVSTACK_STATE_DIR = tmp;
			process.env.DEVSTACK_STACK = 'e2e';

			const plugin = devstackVitePlugin();
			const patch = plugin.config({ root: tmp });
			expect(patch.resolve.alias[DEFAULT_DEV_EXTRAS_ALIAS]).toBe(extrasDir);
		}));

	it('manifest hit without extrasDir → @devstack-dev cold-start fallback under .devstack/stacks/<stack>', () =>
		withTempRootSync('devstack-vite', (tmp) => {
			// Manifest with codegen present but no extrasDir.
			writeStackManifest(tmp, 'e2e');
			process.env.DEVSTACK_STATE_DIR = tmp;
			process.env.DEVSTACK_STACK = 'e2e';

			const plugin = devstackVitePlugin();
			const patch = plugin.config({ root: tmp });
			expect(patch.resolve.alias[DEFAULT_DEV_EXTRAS_ALIAS]).toBe(
				resolve(tmp, '.devstack', 'stacks', 'e2e', 'generated-extras'),
			);
		}));

	it('options.extrasDir escape hatch wins for @devstack-dev', () =>
		withTempRootSync('devstack-vite', (tmp) => {
			const explicit = join(tmp, 'hand', 'picked', 'extras');
			const plugin = devstackVitePlugin({ extrasDir: explicit });
			const patch = plugin.config({ root: tmp });
			expect(patch.resolve.alias[DEFAULT_DEV_EXTRAS_ALIAS]).toBe(explicit);
		}));

	// --- command-defaulting: only an EXPLICIT `serve` takes the live-id path.
	// A programmatic `vite.build()` that omits the env arg must NOT bake live
	// local-stack ids into the bundle (build-safe default).
	it('explicit { command: "serve" } injects the live local-stack ids', () =>
		withTempRootSync('devstack-vite', (tmp) => {
			const idsFile = join(tmp, '.devstack', 'stacks', 'e2e', 'devstack-ids.json');
			mkdirSync(join(tmp, '.devstack', 'stacks', 'e2e'), { recursive: true });
			writeFileSync(
				idsFile,
				JSON.stringify({ network: 'localnet', networks: { localnet: { rpc: 'http://x' } } }),
			);
			writeStackManifest(tmp, 'e2e', undefined, idsFile);
			process.env.DEVSTACK_STATE_DIR = tmp;
			process.env.DEVSTACK_STACK = 'e2e';

			const plugin = devstackVitePlugin();
			const patch = plugin.config({ root: tmp }, { command: 'serve' });
			expect(patch.define.__DEVSTACK_IDS__).toContain('localnet');
		}));

	it('unknown command (no env arg) is build-safe: does NOT inject the live ids', () =>
		withTempRootSync('devstack-vite', (tmp) => {
			const idsFile = join(tmp, '.devstack', 'stacks', 'e2e', 'devstack-ids.json');
			mkdirSync(join(tmp, '.devstack', 'stacks', 'e2e'), { recursive: true });
			writeFileSync(
				idsFile,
				JSON.stringify({ network: 'localnet', networks: { localnet: { rpc: 'http://x' } } }),
			);
			writeStackManifest(tmp, 'e2e', undefined, idsFile);
			process.env.DEVSTACK_STATE_DIR = tmp;
			process.env.DEVSTACK_STACK = 'e2e';

			const plugin = devstackVitePlugin();
			// No configEnv + no config.command → unknown → defaults to `build`,
			// so no live local-stack ids are read (define resolves to `null`).
			const patch = plugin.config({ root: tmp });
			expect(patch.define.__DEVSTACK_IDS__).toBe('null');
		}));
});
