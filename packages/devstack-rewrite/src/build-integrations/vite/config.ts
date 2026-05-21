// `defineDevstackViteConfig` — single-call config preset.
//
// Apps collapse their `vite.config.ts` to one call:
//
//   import { defineDevstackViteConfig } from '@mysten-incubation/devstack/vite';
//   export default defineDevstackViteConfig({ port: 5174 });
//
// What's baked in:
//   - The devstack vite plugin (manifest discovery, HMR pin,
//     allowedHosts, proxy + define from endpoints, watch ignore for
//     the runtime root, SIGTERM graceful shutdown).
//   - `$PORT` from the supervisor's allocator wins over the
//     fallback (architecture § invariants, "$PORT must win over the
//     Vite preset's port option").
//   - ES2022 build + esbuild targets (architecture § invariants,
//     "Vite + esbuild targets must be ES2022").
//
// What's NOT baked in (intentionally, redesign decision per
// distilled-doc §"Should the Vite preset support non-React
// frameworks"): framework plugins (react, vue, svelte, etc.). The
// preset is framework-agnostic; apps pass framework plugins via
// `plugins`.

import { defineConfig, type Plugin, type PluginOption, type UserConfig } from 'vite';

import { ViteConfigOptionsError } from './errors.ts';
import { devstackVitePlugin, type DevstackVitePluginOptions } from './plugin.ts';

// -----------------------------------------------------------------------------
// Public options
// -----------------------------------------------------------------------------

export interface DefineDevstackViteConfigOptions {
	/** Fallback dev-server port when the supervisor has not set
	 *  `$PORT`. Each example app picks a distinct fallback so
	 *  concurrent `vite` runs outside the supervisor don't collide. */
	readonly port: number;
	/** Optional `base` override. Defaults to Vite's default (`'/'`). */
	readonly base?: string;
	/** Server-level extras. Merged shallowly into the preset's
	 *  `server` block; user values win for overlapping fields except
	 *  `proxy`, where user entries are SPREAD AFTER the manifest-
	 *  derived ones so user-defined proxies override the
	 *  endpoint-named ones. */
	readonly server?: UserConfig['server'];
	/** Additional plugins appended after the devstack plugin. Apps
	 *  pass `react()`, `tailwindcss()`, etc. here. */
	readonly plugins?: ReadonlyArray<PluginOption>;
	/** Devstack plugin tuning. Tests pin all fields; apps usually
	 *  pass nothing. */
	readonly devstackPlugin?: DevstackVitePluginOptions;
	/** Extra fields merged shallowly onto the resulting config. User
	 *  values win for top-level keys not handled above. */
	readonly extend?: UserConfig;
}

// -----------------------------------------------------------------------------
// API
// -----------------------------------------------------------------------------

/**
 * Build the canonical devstack Vite config. Returns a complete
 * `UserConfig` with the devstack plugin pre-installed.
 *
 * Sensible defaults:
 *   - `build.target` + `optimizeDeps.esbuildOptions.target` = `es2022`.
 *   - `server.port` = `$PORT` if set, else `options.port`.
 *   - `server.strictPort` = `false` (the supervisor's allocator
 *     is authoritative; concurrent host vite runs fall back).
 *   - Devstack plugin pre-installed at the front of `plugins`.
 */
export const defineDevstackViteConfig = (options: DefineDevstackViteConfigOptions): UserConfig => {
	if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65_535) {
		throw new ViteConfigOptionsError({
			message: `\`port\` must be a positive integer in 1..65535, got ${String(options.port)}`,
			field: 'port',
		});
	}

	const envPort = readEnvPort();
	const port = envPort ?? options.port;

	const devstackPlugin: Plugin = devstackVitePlugin(options.devstackPlugin);

	const userPlugins = options.plugins ?? [];
	const extendPlugins = options.extend?.plugins ?? [];

	const userServer = options.server ?? {};
	const extendServer = options.extend?.server ?? {};

	// User-supplied proxy entries override the manifest-derived ones
	// of the same key (which the devstack plugin emits via `config()`).
	// Vite merges plugin-returned `server.proxy` with the user one by
	// shallow spread, so this top-level `proxy` field is the explicit
	// merge point.
	const proxy = {
		...(userServer.proxy ?? {}),
		...(extendServer.proxy ?? {}),
	};

	return defineConfig({
		plugins: [devstackPlugin, ...userPlugins, ...extendPlugins],
		base: options.base,
		build: {
			target: 'es2022',
			...options.extend?.build,
		},
		optimizeDeps: {
			esbuildOptions: {
				target: 'es2022',
				...options.extend?.optimizeDeps?.esbuildOptions,
			},
			...options.extend?.optimizeDeps,
		},
		server: {
			port,
			strictPort: false,
			...userServer,
			...extendServer,
			proxy: Object.keys(proxy).length > 0 ? proxy : undefined,
		},
		...stripHandledKeys(options.extend ?? {}),
	});
};

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

const readEnvPort = (): number | undefined => {
	const raw = process.env.PORT;
	if (!raw) return undefined;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65_535) return undefined;
	return Math.trunc(parsed);
};

type HandledKey = 'plugins' | 'build' | 'optimizeDeps' | 'server' | 'base';

const stripHandledKeys = (extend: UserConfig): Omit<UserConfig, HandledKey> => {
	const { plugins: _p, build: _b, optimizeDeps: _o, server: _s, base: _ba, ...rest } = extend;
	return rest;
};
