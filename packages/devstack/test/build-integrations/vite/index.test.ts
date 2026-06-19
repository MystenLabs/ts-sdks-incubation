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
	// Cleared per-test so the plugin's vitest-vs-dev-server `define` branch is
	// deterministic (these tests run UNDER vitest, which sets `VITEST`).
	'VITEST',
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
	deploymentFile?: string,
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
				...(deploymentFile !== undefined ? { deploymentFile } : {}),
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

	it('resolve.dedupe is filtered to the Lit packages actually installed at the root', () =>
		withTempRootSync('devstack-vite', (tmp) => {
			// Only `lit` is hoisted at the root (the `app` template declares it);
			// `lit-html` / `lit-element` / `@lit/reactive-element` are phantom
			// (transitive-only under dapp-kit-core). `dedupe` forces resolution
			// from the root, so listing a phantom package fails the production
			// build with `Rollup failed to resolve import "lit-html"`. The plugin
			// must dedupe ONLY what is genuinely present at the root.
			mkdirSync(join(tmp, 'node_modules', 'lit'), { recursive: true });
			const patch = devstackVitePlugin().config({ root: tmp });
			expect(patch.resolve.dedupe).toEqual(['lit']);
		}));

	it('resolve.dedupe is empty when no Lit package is hoisted at the root', () =>
		withTempRootSync('devstack-vite', (tmp) => {
			const patch = devstackVitePlugin().config({ root: tmp });
			expect(patch.resolve.dedupe).toEqual([]);
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
	it('explicit { command: "serve" } injects the live local-stack ids via the runtime global', () =>
		withTempRootSync('devstack-vite', (tmp) => {
			const deploymentFile = join(tmp, '.devstack', 'stacks', 'e2e', 'deployment.json');
			mkdirSync(join(tmp, '.devstack', 'stacks', 'e2e'), { recursive: true });
			writeFileSync(
				deploymentFile,
				JSON.stringify({ network: 'localnet', networks: { localnet: { rpc: 'http://x' } } }),
			);
			writeStackManifest(tmp, 'e2e', undefined, deploymentFile);
			process.env.DEVSTACK_STATE_DIR = tmp;
			process.env.DEVSTACK_STACK = 'e2e';

			const plugin = devstackVitePlugin();
			const patch = plugin.config({ root: tmp }, { command: 'serve' });
			// Dev serve does NOT bake the id into `define` (that would pin it
			// for the server's lifetime); it points the identifier at the
			// runtime global the HTML injection sets fresh per load.
			expect(patch.define.__DEVSTACK_IDS__).toContain('__DEVSTACK_IDS_LIVE__');
			expect(patch.define.__DEVSTACK_IDS__).not.toContain('localnet');

			// The live ids flow through `transformIndexHtml` (re-read per
			// request → a reload picks up a republished id).
			plugin.configResolved({ command: 'serve' });
			const result = plugin.transformIndexHtml('<html></html>');
			const idsScript = result?.tags.find((t) => t.children?.includes('__DEVSTACK_IDS_LIVE__'));
			expect(idsScript?.injectTo).toBe('head-prepend');
			expect(idsScript?.children).toContain('localnet');
		}));

	it('under vitest (command "serve" + VITEST set) bakes an esbuild-valid literal, not the runtime global', () =>
		withTempRootSync('devstack-vite', (tmp) => {
			// Vitest reports `command: 'serve'` too, but runs no `transformIndexHtml`,
			// so the `__DEVSTACK_IDS_LIVE__` global is never set — and esbuild rejects
			// the operator-expression `define`. The plugin must bake a literal so the
			// resolver falls back to `DEVSTACK_DEPLOYMENT_FILE` (set by the vitest globalSetup).
			process.env.DEVSTACK_STATE_DIR = tmp;
			process.env.DEVSTACK_STACK = 'e2e';
			process.env.VITEST = 'true';

			const patch = devstackVitePlugin().config({ root: tmp }, { command: 'serve' });
			// The Vite config loads before the test stack boots, so no live ids are
			// read → a plain `null` literal (esbuild-valid; triggers the env fallback).
			expect(patch.define.__DEVSTACK_IDS__).toBe('null');
			expect(patch.define.__DEVSTACK_IDS__).not.toContain('__DEVSTACK_IDS_LIVE__');
		}));

	it('unknown command (no env arg) is build-safe: does NOT inject the live ids', () =>
		withTempRootSync('devstack-vite', (tmp) => {
			const deploymentFile = join(tmp, '.devstack', 'stacks', 'e2e', 'deployment.json');
			mkdirSync(join(tmp, '.devstack', 'stacks', 'e2e'), { recursive: true });
			writeFileSync(
				deploymentFile,
				JSON.stringify({ network: 'localnet', networks: { localnet: { rpc: 'http://x' } } }),
			);
			writeStackManifest(tmp, 'e2e', undefined, deploymentFile);
			process.env.DEVSTACK_STATE_DIR = tmp;
			process.env.DEVSTACK_STACK = 'e2e';

			const plugin = devstackVitePlugin();
			// No configEnv + no config.command → unknown → defaults to `build`,
			// so no live local-stack ids are read (define resolves to `null`).
			const patch = plugin.config({ root: tmp });
			expect(patch.define.__DEVSTACK_IDS__).toBe('null');
		}));

	it('injects the live ids even when the dev wallet is off', () =>
		withTempRootSync('devstack-vite', (tmp) => {
			const deploymentFile = join(tmp, '.devstack', 'stacks', 'e2e', 'deployment.json');
			mkdirSync(join(tmp, '.devstack', 'stacks', 'e2e'), { recursive: true });
			writeFileSync(
				deploymentFile,
				JSON.stringify({ network: 'localnet', networks: { localnet: { rpc: 'http://x' } } }),
			);
			writeStackManifest(tmp, 'e2e', undefined, deploymentFile);
			process.env.DEVSTACK_STATE_DIR = tmp;
			process.env.DEVSTACK_STACK = 'e2e';

			const plugin = devstackVitePlugin({ injectDevWallet: false });
			plugin.config({ root: tmp }, { command: 'serve' });
			plugin.configResolved({ command: 'serve' });
			const result = plugin.transformIndexHtml('<html></html>');
			// ids script present; dev-wallet module script absent.
			expect(result?.tags.some((t) => t.children?.includes('localnet'))).toBe(true);
			expect(result?.tags.some((t) => t.attrs?.src !== undefined)).toBe(false);
		}));

	it('configureServer full-reloads the page when the ids file changes', () =>
		withTempRootSync('devstack-vite', (tmp) => {
			const deploymentFile = join(tmp, '.devstack', 'stacks', 'e2e', 'deployment.json');
			mkdirSync(join(tmp, '.devstack', 'stacks', 'e2e'), { recursive: true });
			writeFileSync(deploymentFile, JSON.stringify({ network: 'localnet', networks: {} }));
			writeStackManifest(tmp, 'e2e', undefined, deploymentFile);
			process.env.DEVSTACK_STATE_DIR = tmp;
			process.env.DEVSTACK_STACK = 'e2e';

			const plugin = devstackVitePlugin();
			plugin.config({ root: tmp }, { command: 'serve' });
			plugin.configResolved({ command: 'serve' });

			const watched: string[] = [];
			const onChange: Array<(path: string) => void> = [];
			const onAdd: Array<(path: string) => void> = [];
			const sent: Array<{ type: string }> = [];
			plugin.configureServer({
				watcher: {
					add: (p) => watched.push(String(p)),
					on: (event, listener) => {
						if (event === 'change') onChange.push(listener);
						if (event === 'add') onAdd.push(listener);
					},
				},
				hot: { send: (payload) => sent.push(payload) },
			});

			// The ids file is watched, on both 'change' and 'add' (the file may
			// be (re)created after the server starts).
			expect(watched).toContain(deploymentFile);
			expect(onChange).toHaveLength(1);
			expect(onAdd).toHaveLength(1);
			// A change to an UNRELATED file does not reload.
			for (const l of onChange) l(join(tmp, 'src', 'main.ts'));
			expect(sent).toHaveLength(0);
			// A change to the ids file triggers a single full reload.
			for (const l of onChange) l(deploymentFile);
			expect(sent).toEqual([{ type: 'full-reload' }]);
			// An 'add' of the ids file reloads too (file created post-boot).
			for (const l of onAdd) l(deploymentFile);
			expect(sent).toEqual([{ type: 'full-reload' }, { type: 'full-reload' }]);
		}));
});
