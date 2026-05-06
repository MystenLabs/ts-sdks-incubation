// Vite plugin for @mysten-incubation/devstack. Apps consume this via the
// `@mysten-incubation/devstack/vite` subpath in their `vite.config.ts`.
//
// Stacks: by default the plugin reads from the active stack —
// `<viteRoot>/.devstack/stacks/<active>/manifest.json`. The active stack
// resolves through `runtime/active-stack.ts`'s charset-validated
// `resolveStack`, which honors a `DEVSTACK_STACK` env override and the
// `<viteRoot>/.devstack/active` pointer file (default `'main'`). Apps that
// need to pin a stack pass `manifestPath` explicitly. The dev-server
// config watches `.devstack/active` so flipping the pointer (via
// `devstack stack use`) reloads the virtual module.

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import type { Plugin } from 'vite';

import { resolveStack, stackDir } from '../runtime/active-stack.js';
import type { Manifest } from '../runtime/manifest-types.js';

const VIRTUAL_ID = 'virtual:devstack-manifest';
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

const EMPTY_MANIFEST: Manifest = {
	app: '',
	network: 'localnet',
	emittedAt: '',
	registry: { packages: [], accounts: [], services: [] },
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
	let isBuild = false;
	let currentServer: import('vite').ViteDevServer | undefined;

	const currentManifestPath = (): string => {
		if (overridePath !== undefined) {
			return isAbsolute(overridePath) ? overridePath : resolve(resolvedRoot, overridePath);
		}
		const stack = resolveStack({ appDir: resolvedRoot });
		return join(stackDir(resolvedRoot, stack), 'manifest.json');
	};

	return {
		name: '@mysten-incubation/devstack:dev-manifest',
		configResolved(config) {
			resolvedRoot = config.root;
			activePath = join(resolvedRoot, '.devstack', 'active');
			isBuild = config.command === 'build';
		},
		resolveId(id) {
			if (id === VIRTUAL_ID) return RESOLVED_ID;
			return null;
		},
		load(id) {
			if (id !== RESOLVED_ID) return null;
			// Re-prime the watcher on every load so a fresh-clone first
			// cycle (manifest absent → present) picks up the new file.
			// chokidar's `add` for a non-existent path is benign; doing
			// it here ensures the path tracked at load time is always the
			// one whose subsequent appearance triggers a reload.
			currentServer?.watcher.add(currentManifestPath());
			const data = readManifest(currentManifestPath());
			// Build-mode guard: the wallet-server plugin writes the
			// listener's bearer token into manifest service endpointLabels
			// (the dev-wallet adapter parses it back out at pair time).
			// Devstack is dev-only — we don't bake credentials into a
			// production bundle. Surface the leak as a build error so
			// `vite build` fails loudly instead of producing a leaky
			// artifact. Long-term fix is per-session tokens written to
			// `<stackDir>` and read via a Vite virtual module at dev time;
			// until then, refuse the build.
			if (isBuild) assertNoSecretsForBuild(data);
			return `export const manifest = ${JSON.stringify(data)};`;
		},
		configureServer(server) {
			currentServer = server;
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

/** Refuse to bake a manifest into a production bundle when it carries
 * dev credentials. The wallet-server plugin's `endpointLabel` is the
 * known leak path today; check both that field and the `url` for any
 * `?token=` query. */
function assertNoSecretsForBuild(manifest: Manifest): void {
	const services = manifest.registry.services ?? [];
	for (const svc of services) {
		const fields: Array<string | undefined> = [svc.endpointLabel, svc.url];
		for (const value of fields) {
			if (typeof value === 'string' && value.includes('?token=')) {
				throw new Error(
					`@mysten-incubation/devstack/vite: refusing to bake a manifest carrying a `
						+ `bearer token into a production build (service '${svc.name}'). Devstack `
						+ `is dev-only; the bundle must not leave the laptop. If you are intentionally `
						+ `building a dev artifact, run \`devstack down\` first or point Vite at an `
						+ `empty manifest path.`,
				);
			}
		}
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
