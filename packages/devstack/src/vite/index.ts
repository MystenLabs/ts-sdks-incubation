// Vite config preset for devstack-based example apps. Encodes the
// canonical wiring every example app needs:
//
//   - React + Tailwind plugins
//   - `es2022` build/optimize target — example apps and the codegen
//     emitters (`DappKitConfigEmitter`) freely use ES2022 features
//     (class fields, top-level await in transitive deps)
//   - Per-stack manifest aliasing so concurrent stacks (e.g. `pnpm dev`
//     vs `DEVSTACK_STACK=test playwright test`) each resolve their own
//     `.devstack/stacks/<stack>/manifest.json` file
//   - Dev server pinned to the port the supervisor's allocator hands
//     in via `$PORT` (with a per-app fallback for `vite` runs outside
//     the supervisor)
//   - `.devstack/` watcher exclusion + Traefik-compatible HMR clientPort
//     + `.localhost` allowedHosts
//
// Apps that need additional plugins or overrides extend via the
// `extraPlugins` and `extend` options:
//
//   import { defineDevstackViteConfig } from '@mysten-incubation/devstack/vite';
//
//   export default defineDevstackViteConfig({
//     port: 5174,
//     extraPlugins: [svgr()],
//     extend: { build: { sourcemap: true } },
//   });

import { resolve as pathResolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type PluginOption, type UserConfig } from 'vite';

export interface DevstackViteConfigOptions {
	/** Fallback port when the supervisor's allocator hasn't set `$PORT`
	 *  (i.e. `vite` invoked outside `pnpm dev`). The supervisor always
	 *  wins when set. Pick a value unique to this app — each example
	 *  app uses a distinct fallback so concurrent vite runs don't
	 *  collide. Default `5179`. */
	readonly port?: number;
	/** App root used to resolve the per-stack manifest path and `@`
	 *  alias. Defaults to `process.cwd()`, which is the directory vite
	 *  was invoked from (and therefore where `vite.config.ts` lives).
	 *  Override only when running vite from a non-project-root cwd. */
	readonly appDir?: string;
	/** Plugins appended after React + Tailwind. */
	readonly extraPlugins?: ReadonlyArray<PluginOption>;
	/** Extra fields merged shallowly into the resulting config. User
	 *  values win for top-level keys; for `server`, `resolve`, `build`,
	 *  `optimizeDeps` the merge is one level deep so the preset's
	 *  defaults survive partial overrides. */
	readonly extend?: UserConfig;
}

/**
 * Build the canonical devstack Vite config. Apps reduce their
 * `vite.config.ts` to a single call:
 *
 *   export default defineDevstackViteConfig({ port: 5174 });
 *
 * See the module header for what's baked in and how to extend.
 */
export function defineDevstackViteConfig(options: DevstackViteConfigOptions = {}): UserConfig {
	// Per-stack manifest resolution. The generated `src/generated/manifest.ts`
	// hard-codes `../../.devstack/manifest.json` (the `main` stack location);
	// alias that path to the active stack's file so a `DEVSTACK_STACK=test`
	// playwright run reads its own manifest and a concurrent `pnpm dev` (on
	// the `main` stack) reads its own.
	const stack = process.env.DEVSTACK_STACK ?? 'main';
	const appDir = options.appDir ?? process.cwd();
	// Trailing slash so `new URL('./.devstack/...', appUrl)` resolves
	// inside `appDir` rather than alongside it.
	const appUrl = pathToFileURL(pathResolve(appDir) + '/');
	const manifestUrl =
		stack === 'main'
			? new URL('./.devstack/manifest.json', appUrl)
			: new URL(`./.devstack/stacks/${stack}/manifest.json`, appUrl);

	const port = options.port ?? 5179;
	const extraPlugins = options.extraPlugins ?? [];
	const extend = options.extend ?? {};

	return defineConfig({
		plugins: [react(), tailwindcss(), ...extraPlugins, ...(extend.plugins ?? [])],
		// Pin a modern ES target. Devstack's example apps and the codegen
		// emitters (notably `DappKitConfigEmitter` for `src/dapp-kit.ts`)
		// freely use ES2022 features (class fields, top-level await in
		// transitive deps); the upstream `@mysten/dapp-kit-*` peers also
		// ship with ES2022 builds. `optimizeDeps` mirrors the build target
		// so Vite's dev-mode pre-bundle (esbuild, defaults to `es2020`)
		// stays consistent with the production build.
		build: { target: 'es2022', ...extend.build },
		optimizeDeps: {
			esbuildOptions: { target: 'es2022', ...extend.optimizeDeps?.esbuildOptions },
			...extend.optimizeDeps,
		},
		resolve: {
			alias: {
				'@': fileURLToPath(new URL('./src', appUrl)),
				'../../.devstack/manifest.json': fileURLToPath(manifestUrl),
				...(extend.resolve?.alias as Record<string, string> | undefined),
			},
			...extend.resolve,
		},
		server: {
			// Skip `.devstack/` so vite doesn't loop full-reload on the
			// per-stack manifest the supervisor writes there.
			watch: { ignored: ['**/.devstack/**'], ...extend.server?.watch },
			// Per-stack port comes in via `$PORT` from the devstack
			// supervisor's allocator. Fallback is for `vite` invoked
			// outside the supervisor.
			port: Number(process.env.PORT) || port,
			strictPort: false,
			// Allow the Traefik router to proxy this dev-server in via
			// the stack-scoped hostname (`dev.<app>.localhost`). Without
			// this, Vite's `Host:` header allowlist rejects requests
			// routed through traefik.
			allowedHosts: ['.localhost'],
			// HMR over the router. Client (browser) talks WS to the
			// public router port (5175); pin `clientPort` so the HMR
			// client doesn't dial the upstream local port from the
			// public host.
			hmr:
				typeof extend.server?.hmr === 'object'
					? { clientPort: 5175, ...extend.server.hmr }
					: (extend.server?.hmr ?? { clientPort: 5175 }),
			...extend.server,
		},
		...stripHandledKeys(extend),
	});
}

// Drop the keys we've already merged so a top-level spread doesn't
// clobber them.
function stripHandledKeys(extend: UserConfig): Omit<UserConfig, HandledKey> {
	const { plugins: _p, build: _b, optimizeDeps: _o, resolve: _r, server: _s, ...rest } = extend;
	return rest;
}

type HandledKey = 'plugins' | 'build' | 'optimizeDeps' | 'resolve' | 'server';
