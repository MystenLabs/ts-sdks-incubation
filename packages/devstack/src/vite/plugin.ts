// Vite-side plugins for @mysten-incubation/devstack. Apps consume these via the
// `@mysten-incubation/devstack/vite` subpath in their `vite.config.ts`. Kept fully
// self-contained (no transitive devstack imports beyond type-only references)
// so vite's config loader doesn't need `.js` → `.ts` fallback for cross-file
// references — same reason the vitest entry is structured the way it is.
//
// Stacks: by default both plugins read from the active stack —
// `<viteRoot>/.devstack/stacks/<active>/manifest.json` and `.../.keys/`. The
// active stack is whatever `<viteRoot>/.devstack/active` says, falling back
// to `'main'`. Apps that need to pin a stack pass `manifestPath`/`keysDir`
// explicitly. The dev-server config watches `.devstack/active` so flipping
// the pointer (via `devstack stack use`) reloads the virtual modules.

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import type { Plugin } from 'vite';

import type { Manifest } from '../runtime/manifest-types.js';

const DEFAULT_STACK = 'main';

function readActiveStackFromRoot(viteRoot: string): string {
	const path = join(viteRoot, '.devstack', 'active');
	if (!existsSync(path)) return DEFAULT_STACK;
	const raw = readFileSync(path, 'utf8').trim();
	return raw.length > 0 ? raw : DEFAULT_STACK;
}

function envStackOverride(): string | undefined {
	const v = process.env.DEVSTACK_STACK;
	return v !== undefined && v.length > 0 ? v : undefined;
}

const VIRTUAL_ID = 'virtual:devstack-manifest';
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

const EMPTY_MANIFEST: Manifest = {
	app: '',
	network: 'localnet',
	emittedAt: '',
	registry: { tokens: [], packages: [], accounts: [], services: [] },
};

export interface DevstackManifestPluginOptions {
	/**
	 * Path to the JSON manifest written by the devstack runtime. Relative
	 * paths resolve against the Vite project root. When unset (the default),
	 * the plugin tracks the active stack via `<root>/.devstack/active` and
	 * loads `<root>/.devstack/stacks/<active>/manifest.json`.
	 */
	manifestPath?: string;
}

/**
 * Synthesizes `import { manifest } from 'virtual:devstack-manifest'` from the
 * devstack-emitted manifest of the active stack. Falls back to a typed empty
 * manifest before first bring-up so apps still boot and typecheck.
 *
 * Switching stacks via `devstack stack use` flips the `.devstack/active` pointer;
 * the dev server's watcher picks that up and reloads this virtual module.
 */
export function devstackManifestPlugin(opts: DevstackManifestPluginOptions = {}): Plugin {
	const overridePath = opts.manifestPath;
	let resolvedRoot = '';
	let activePath = '';

	const currentManifestPath = (): string => {
		if (overridePath !== undefined) {
			return isAbsolute(overridePath) ? overridePath : resolve(resolvedRoot, overridePath);
		}
		const stack = envStackOverride() ?? readActiveStackFromRoot(resolvedRoot);
		return resolve(resolvedRoot, '.devstack', 'stacks', stack, 'manifest.json');
	};

	return {
		name: '@mysten-incubation/devstack:dev-manifest',
		configResolved(config) {
			resolvedRoot = config.root;
			activePath = join(resolvedRoot, '.devstack', 'active');
		},
		resolveId(id) {
			if (id === VIRTUAL_ID) return RESOLVED_ID;
			return null;
		},
		load(id) {
			if (id !== RESOLVED_ID) return null;
			const data = readManifest(currentManifestPath());
			return `export const manifest = ${JSON.stringify(data)};`;
		},
		configureServer(server) {
			server.watcher.add(currentManifestPath());
			server.watcher.add(activePath);
			const reload = (changed: string) => {
				if (changed !== currentManifestPath() && changed !== activePath) return;
				// Re-prime the watcher on stack-switch (active changed → the new
				// stack's manifest path is what we want to react to next).
				server.watcher.add(currentManifestPath());
				const mod = server.moduleGraph.getModuleById(RESOLVED_ID);
				if (mod) server.reloadModule(mod);
			};
			server.watcher.on('add', reload);
			server.watcher.on('change', reload);
			server.watcher.on('unlink', reload);
		},
	};
}

function readManifest(path: string): Manifest {
	if (!existsSync(path)) return EMPTY_MANIFEST;
	try {
		return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
	} catch {
		return EMPTY_MANIFEST;
	}
}

export interface DevstackVitePluginsOptions {
	/** Override the manifest path passed to `devstackManifestPlugin`. */
	manifestPath?: string;
}

/**
 * Composes the devstack-side Vite plugins. Apps call this once in
 * `vite.config.ts`:
 *
 *   import { devstackVitePlugins } from '@mysten-incubation/devstack/vite';
 *   export default defineConfig({
 *     plugins: [react(), tailwindcss(), ...devstackVitePlugins()],
 *   });
 */
export function devstackVitePlugins(opts: DevstackVitePluginsOptions = {}): Plugin[] {
	return [devstackManifestPlugin({ manifestPath: opts.manifestPath })];
}
