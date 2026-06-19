// `devstackVitePlugin` — `@generated` / `@devstack-dev` alias + deployment
// merge tests.
//
// `@generated` STATICALLY resolves to the committed `<root>/src/generated`
// tree (the single source of bindings, written by `devstack codegen`;
// deployment resolves at runtime via `__DEVSTACK_DEPLOYMENT__`). Resolution
// order (src/build-integrations/vite/index.ts):
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
//   - `devstackVitePlugin(options?)` returns `{ name, config, ... }`.
//   - `config` is an ASYNC FUNCTION (it awaits the committed `deployments`
//     thunks): `await config(userConfig) => ({ resolve: { alias }, define })`.
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
import { withTempRootAsync } from '../../helpers/with-temp-root.ts';

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

/** Write a live deployment ENVELOPE file `{ defaultNetwork, networks }` for
 *  the given single network at `<tmp>/.devstack/stacks/<stack>/deployment.json`
 *  and return its path. */
const writeLiveEnvelope = (tmp: string, stack: string, network: string, rpc: string): string => {
	const file = join(tmp, '.devstack', 'stacks', stack, 'deployment.json');
	mkdirSync(join(tmp, '.devstack', 'stacks', stack), { recursive: true });
	writeFileSync(
		file,
		JSON.stringify({
			defaultNetwork: network,
			networks: {
				[network]: { network, rpc, packages: {}, mvrOverrides: {} },
			},
		}),
	);
	return file;
};

/** A committed per-network `deployments` thunk resolving to
 *  `{ deployment: NetworkDeployment }` (sans `network`/`local`, which the
 *  merge stamps from the key). */
const committedThunk = (rpc: string) => () =>
	Promise.resolve({
		deployment: { rpc, packages: {}, mvrOverrides: {} },
	});

interface ParsedEnvelope {
	defaultNetwork: string;
	networks: Record<string, { rpc?: string; local?: boolean }>;
}

/** Parse the (non-null) `__DEVSTACK_DEPLOYMENT__` define literal. */
const parseDefine = (define: Record<string, string>): ParsedEnvelope =>
	JSON.parse(define.__DEVSTACK_DEPLOYMENT__ as string) as ParsedEnvelope;

describe('devstackVitePlugin', () => {
	it('exposes the expected structural plugin shape', () => {
		const plugin = devstackVitePlugin();
		expect(plugin.name).toBe('devstack:generated-alias');
		expect(typeof plugin.config).toBe('function');
	});

	it('@generated statically resolves to <root>/src/generated', () =>
		withTempRootAsync('devstack-vite', async (tmp) => {
			// A manifest is present; `@generated` is always the committed
			// `src/generated` tree regardless of what the manifest records.
			writeStackManifest(tmp, 'e2e');
			process.env.DEVSTACK_STATE_DIR = tmp;
			process.env.DEVSTACK_STACK = 'e2e';

			const plugin = devstackVitePlugin();
			const patch = await plugin.config({ root: tmp });
			expect(patch.resolve.alias[DEFAULT_GENERATED_ALIAS]).toBe(resolve(tmp, 'src/generated'));
		}));

	it('resolve.dedupe is filtered to the Lit packages actually installed at the root', () =>
		withTempRootAsync('devstack-vite', async (tmp) => {
			// Only `lit` is hoisted at the root (the `app` template declares it);
			// `lit-html` / `lit-element` / `@lit/reactive-element` are phantom
			// (transitive-only under dapp-kit-core). `dedupe` forces resolution
			// from the root, so listing a phantom package fails the production
			// build with `Rollup failed to resolve import "lit-html"`. The plugin
			// must dedupe ONLY what is genuinely present at the root.
			mkdirSync(join(tmp, 'node_modules', 'lit'), { recursive: true });
			const patch = await devstackVitePlugin().config({ root: tmp });
			expect(patch.resolve.dedupe).toEqual(['lit']);
		}));

	it('resolve.dedupe is empty when no Lit package is hoisted at the root', () =>
		withTempRootAsync('devstack-vite', async (tmp) => {
			const patch = await devstackVitePlugin().config({ root: tmp });
			expect(patch.resolve.dedupe).toEqual([]);
		}));

	it('options.generatedDir escape hatch wins (absolute passthrough)', () =>
		withTempRootAsync('devstack-vite', async (tmp) => {
			const explicit = join(tmp, 'hand', 'picked', 'generated');
			const plugin = devstackVitePlugin({ generatedDir: explicit });
			const patch = await plugin.config({ root: tmp });
			expect(patch.resolve.alias[DEFAULT_GENERATED_ALIAS]).toBe(explicit);
		}));

	it('options.generatedDir relative path is resolved against the Vite root', () =>
		withTempRootAsync('devstack-vite', async (tmp) => {
			const plugin = devstackVitePlugin({ generatedDir: 'custom/gen' });
			const patch = await plugin.config({ root: tmp });
			expect(patch.resolve.alias[DEFAULT_GENERATED_ALIAS]).toBe(resolve(tmp, 'custom/gen'));
		}));

	it('custom options.alias prefix is used as the alias key', () =>
		withTempRootAsync('devstack-vite', async (tmp) => {
			const plugin = devstackVitePlugin({ alias: '@gen' });
			const patch = await plugin.config({ root: tmp });
			expect(patch.resolve.alias['@gen']).toBe(resolve(tmp, 'src/generated'));
			// And the default prefix is NOT also present.
			expect(patch.resolve.alias[DEFAULT_GENERATED_ALIAS]).toBeUndefined();
		}));

	it('manifest hit → also aliases @devstack-dev at codegen.extrasDir', () =>
		withTempRootAsync('devstack-vite', async (tmp) => {
			const extrasDir = join(tmp, '.devstack', 'stacks', 'e2e', 'generated-extras');
			writeStackManifest(tmp, 'e2e', extrasDir);
			process.env.DEVSTACK_STATE_DIR = tmp;
			process.env.DEVSTACK_STACK = 'e2e';

			const plugin = devstackVitePlugin();
			const patch = await plugin.config({ root: tmp });
			expect(patch.resolve.alias[DEFAULT_DEV_EXTRAS_ALIAS]).toBe(extrasDir);
		}));

	it('manifest hit without extrasDir → @devstack-dev cold-start fallback under .devstack/stacks/<stack>', () =>
		withTempRootAsync('devstack-vite', async (tmp) => {
			// Manifest with codegen present but no extrasDir.
			writeStackManifest(tmp, 'e2e');
			process.env.DEVSTACK_STATE_DIR = tmp;
			process.env.DEVSTACK_STACK = 'e2e';

			const plugin = devstackVitePlugin();
			const patch = await plugin.config({ root: tmp });
			expect(patch.resolve.alias[DEFAULT_DEV_EXTRAS_ALIAS]).toBe(
				resolve(tmp, '.devstack', 'stacks', 'e2e', 'generated-extras'),
			);
		}));

	it('options.extrasDir escape hatch wins for @devstack-dev', () =>
		withTempRootAsync('devstack-vite', async (tmp) => {
			const explicit = join(tmp, 'hand', 'picked', 'extras');
			const plugin = devstackVitePlugin({ extrasDir: explicit });
			const patch = await plugin.config({ root: tmp });
			expect(patch.resolve.alias[DEFAULT_DEV_EXTRAS_ALIAS]).toBe(explicit);
		}));

	// --- command-defaulting: only an EXPLICIT `serve` takes the live-id path.
	// A programmatic `vite.build()` that omits the env arg must NOT bake live
	// local-stack ids into the bundle (build-safe default).
	it('explicit { command: "serve" } injects the live local-stack deployment via the runtime global', () =>
		withTempRootAsync('devstack-vite', async (tmp) => {
			const deploymentFile = writeLiveEnvelope(tmp, 'e2e', 'localnet', 'http://x');
			writeStackManifest(tmp, 'e2e', undefined, deploymentFile);
			process.env.DEVSTACK_STATE_DIR = tmp;
			process.env.DEVSTACK_STACK = 'e2e';

			const plugin = devstackVitePlugin();
			const patch = await plugin.config({ root: tmp }, { command: 'serve' });
			// Dev serve does NOT bake the id into `define` (that would pin it
			// for the server's lifetime); it points the identifier at the
			// runtime global the HTML injection sets fresh per load.
			expect(patch.define.__DEVSTACK_DEPLOYMENT__).toContain('__DEVSTACK_DEPLOYMENT_LIVE__');
			expect(patch.define.__DEVSTACK_DEPLOYMENT__).not.toContain('localnet');

			// The live deployment flows through `transformIndexHtml` (re-read per
			// request → a reload picks up a republished id).
			plugin.configResolved({ command: 'serve' });
			const result = plugin.transformIndexHtml('<html></html>');
			const script = result?.tags.find((t) => t.children?.includes('__DEVSTACK_DEPLOYMENT_LIVE__'));
			expect(script?.injectTo).toBe('head-prepend');
			expect(script?.children).toContain('localnet');
		}));

	it('under vitest (command "serve" + VITEST set) bakes an esbuild-valid literal, not the runtime global', () =>
		withTempRootAsync('devstack-vite', async (tmp) => {
			// Vitest reports `command: 'serve'` too, but runs no `transformIndexHtml`,
			// so the `__DEVSTACK_DEPLOYMENT_LIVE__` global is never set — and esbuild
			// rejects the operator-expression `define`. The plugin must bake a literal
			// so the resolver falls back to `DEVSTACK_DEPLOYMENT_FILE` (set by the
			// vitest globalSetup).
			process.env.DEVSTACK_STATE_DIR = tmp;
			process.env.DEVSTACK_STACK = 'e2e';
			process.env.VITEST = 'true';

			const patch = await devstackVitePlugin().config({ root: tmp }, { command: 'serve' });
			// The Vite config loads before the test stack boots, so no live ids are
			// read → a plain `null` literal (esbuild-valid; triggers the env fallback).
			expect(patch.define.__DEVSTACK_DEPLOYMENT__).toBe('null');
			expect(patch.define.__DEVSTACK_DEPLOYMENT__).not.toContain('__DEVSTACK_DEPLOYMENT_LIVE__');
		}));

	it('unknown command (no env arg) is build-safe: does NOT inject the live ids', () =>
		withTempRootAsync('devstack-vite', async (tmp) => {
			const deploymentFile = writeLiveEnvelope(tmp, 'e2e', 'localnet', 'http://x');
			writeStackManifest(tmp, 'e2e', undefined, deploymentFile);
			process.env.DEVSTACK_STATE_DIR = tmp;
			process.env.DEVSTACK_STACK = 'e2e';

			const plugin = devstackVitePlugin();
			// No configEnv + no config.command → unknown → defaults to `build`,
			// so no live local-stack ids are read AND no committed thunks → null.
			const patch = await plugin.config({ root: tmp });
			expect(patch.define.__DEVSTACK_DEPLOYMENT__).toBe('null');
		}));

	it('injects the live deployment even when the dev wallet is off', () =>
		withTempRootAsync('devstack-vite', async (tmp) => {
			const deploymentFile = writeLiveEnvelope(tmp, 'e2e', 'localnet', 'http://x');
			writeStackManifest(tmp, 'e2e', undefined, deploymentFile);
			process.env.DEVSTACK_STATE_DIR = tmp;
			process.env.DEVSTACK_STACK = 'e2e';

			const plugin = devstackVitePlugin({ injectDevWallet: false });
			await plugin.config({ root: tmp }, { command: 'serve' });
			plugin.configResolved({ command: 'serve' });
			const result = plugin.transformIndexHtml('<html></html>');
			// deployment script present; dev-wallet module script absent.
			expect(result?.tags.some((t) => t.children?.includes('localnet'))).toBe(true);
			expect(result?.tags.some((t) => t.attrs?.src !== undefined)).toBe(false);
		}));

	it('configureServer full-reloads the page when the deployment file changes', () =>
		withTempRootAsync('devstack-vite', async (tmp) => {
			const deploymentFile = writeLiveEnvelope(tmp, 'e2e', 'localnet', 'http://x');
			writeStackManifest(tmp, 'e2e', undefined, deploymentFile);
			process.env.DEVSTACK_STATE_DIR = tmp;
			process.env.DEVSTACK_STACK = 'e2e';

			const plugin = devstackVitePlugin();
			await plugin.config({ root: tmp }, { command: 'serve' });
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

			// The deployment file is watched, on both 'change' and 'add' (the file
			// may be (re)created after the server starts).
			expect(watched).toContain(deploymentFile);
			expect(onChange).toHaveLength(1);
			expect(onAdd).toHaveLength(1);
			// A change to an UNRELATED file does not reload.
			for (const l of onChange) l(join(tmp, 'src', 'main.ts'));
			expect(sent).toHaveLength(0);
			// A change to the deployment file triggers a single full reload.
			for (const l of onChange) l(deploymentFile);
			expect(sent).toEqual([{ type: 'full-reload' }]);
			// An 'add' of the deployment file reloads too (file created post-boot).
			for (const l of onAdd) l(deploymentFile);
			expect(sent).toEqual([{ type: 'full-reload' }, { type: 'full-reload' }]);
		}));

	// --- multi-network MERGE layer ---------------------------------------

	it('dev serve overlays the live localnet on a committed testnet (both present, default=localnet, local flags)', () =>
		withTempRootAsync('devstack-vite', async (tmp) => {
			const deploymentFile = writeLiveEnvelope(tmp, 'e2e', 'localnet', 'http://live');
			writeStackManifest(tmp, 'e2e', undefined, deploymentFile);
			process.env.DEVSTACK_STATE_DIR = tmp;
			process.env.DEVSTACK_STACK = 'e2e';

			const plugin = devstackVitePlugin({
				deployments: { testnet: committedThunk('http://testnet') },
			});
			await plugin.config({ root: tmp }, { command: 'serve' });
			plugin.configResolved({ command: 'serve' });
			const result = plugin.transformIndexHtml('<html></html>');
			const script = result?.tags.find((t) => t.children?.includes('__DEVSTACK_DEPLOYMENT_LIVE__'));
			const json = script!
				.children!.replace(/^globalThis\.__DEVSTACK_DEPLOYMENT_LIVE__ = /, '')
				.replace(/;$/, '');
			const envelope = JSON.parse(json) as ParsedEnvelope;
			// Both networks present; live localnet is the default + local:true,
			// committed testnet is local:false.
			expect(Object.keys(envelope.networks).sort()).toEqual(['localnet', 'testnet']);
			expect(envelope.defaultNetwork).toBe('localnet');
			expect(envelope.networks['localnet']!.local).toBe(true);
			expect(envelope.networks['localnet']!.rpc).toBe('http://live');
			expect(envelope.networks['testnet']!.local).toBe(false);
			expect(envelope.networks['testnet']!.rpc).toBe('http://testnet');
		}));

	it('command "build" drops the live local-mode network, ships the committed one only', () =>
		withTempRootAsync('devstack-vite', async (tmp) => {
			// A live envelope exists on disk, but a `build` must NOT read it.
			const deploymentFile = writeLiveEnvelope(tmp, 'e2e', 'localnet', 'http://live');
			writeStackManifest(tmp, 'e2e', undefined, deploymentFile);
			process.env.DEVSTACK_STATE_DIR = tmp;
			process.env.DEVSTACK_STACK = 'e2e';

			const plugin = devstackVitePlugin({
				deployments: { testnet: committedThunk('http://testnet') },
			});
			const patch = await plugin.config({ root: tmp }, { command: 'build' });
			const envelope = parseDefine(patch.define);
			expect(Object.keys(envelope.networks)).toEqual(['testnet']);
			expect(envelope.defaultNetwork).toBe('testnet');
			expect(envelope.networks['testnet']!.local).toBe(false);
		}));

	it('command "build" with empty deployments injects a null define', () =>
		withTempRootAsync('devstack-vite', async (tmp) => {
			process.env.DEVSTACK_STATE_DIR = tmp;
			process.env.DEVSTACK_STACK = 'e2e';
			const plugin = devstackVitePlugin();
			const patch = await plugin.config({ root: tmp }, { command: 'build' });
			expect(patch.define.__DEVSTACK_DEPLOYMENT__).toBe('null');
		}));

	it('AUTO-DISCOVERS <root>/deployments/*.ts (D7 — "just drop a file")', () =>
		withTempRootAsync('devstack-vite', async (tmp) => {
			process.env.DEVSTACK_STATE_DIR = tmp;
			process.env.DEVSTACK_STACK = 'e2e';
			// Drop a committed `deployments/testnet.ts` — no `deployments` option.
			const depsDir = join(tmp, 'deployments');
			mkdirSync(depsDir, { recursive: true });
			writeFileSync(
				join(depsDir, 'testnet.ts'),
				`export const deployment = { rpc: 'http://auto-testnet', packages: {}, mvrOverrides: {} };\n`,
			);
			// No explicit `deployments` option → auto-discovery picks up the file.
			const plugin = devstackVitePlugin();
			const patch = await plugin.config({ root: tmp }, { command: 'build' });
			const envelope = parseDefine(patch.define);
			expect(Object.keys(envelope.networks)).toEqual(['testnet']);
			expect(envelope.networks['testnet']!.rpc).toBe('http://auto-testnet');
			expect(envelope.networks['testnet']!.local).toBe(false);
		}));

	it('explicit deployments option OVERRIDES auto-discovery', () =>
		withTempRootAsync('devstack-vite', async (tmp) => {
			process.env.DEVSTACK_STATE_DIR = tmp;
			process.env.DEVSTACK_STACK = 'e2e';
			// A `deployments/` dir exists, but the explicit option wins.
			const depsDir = join(tmp, 'deployments');
			mkdirSync(depsDir, { recursive: true });
			writeFileSync(
				join(depsDir, 'testnet.ts'),
				`export const deployment = { rpc: 'http://auto', packages: {}, mvrOverrides: {} };\n`,
			);
			const plugin = devstackVitePlugin({
				deployments: { mainnet: committedThunk('http://explicit-mainnet') },
			});
			const patch = await plugin.config({ root: tmp }, { command: 'build' });
			const envelope = parseDefine(patch.define);
			expect(Object.keys(envelope.networks)).toEqual(['mainnet']);
		}));

	it('a malformed committed thunk fails loud at config-load', () =>
		withTempRootAsync('devstack-vite', async (tmp) => {
			process.env.DEVSTACK_STATE_DIR = tmp;
			process.env.DEVSTACK_STACK = 'e2e';
			const plugin = devstackVitePlugin({
				// Missing the required `rpc` field.
				deployments: {
					testnet: () => Promise.resolve({ deployment: { packages: {} } as never }),
				},
			});
			await expect(plugin.config({ root: tmp }, { command: 'build' })).rejects.toThrow();
		}));

	it('respects options.defaultNetwork for a build with multiple committed networks', () =>
		withTempRootAsync('devstack-vite', async (tmp) => {
			process.env.DEVSTACK_STATE_DIR = tmp;
			process.env.DEVSTACK_STACK = 'e2e';
			const plugin = devstackVitePlugin({
				deployments: {
					testnet: committedThunk('http://testnet'),
					mainnet: committedThunk('http://mainnet'),
				},
				defaultNetwork: 'mainnet',
			});
			const patch = await plugin.config({ root: tmp }, { command: 'build' });
			expect(parseDefine(patch.define).defaultNetwork).toBe('mainnet');
		}));
});
