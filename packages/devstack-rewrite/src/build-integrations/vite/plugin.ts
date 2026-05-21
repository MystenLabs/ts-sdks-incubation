// The devstack Vite plugin.
//
// Pure consumer of the L0 manifest envelope: discovers the manifest
// via `runtime/`'s sync resolver, projects an endpoint dispatch table
// into Vite's config, and exposes a small middleware endpoint set for
// browser-side stack introspection.
//
// Lifecycle inside Vite:
//   - `config()` — sync: discover identity + read manifest (if present),
//     project `define` + `proxy`, set the HMR client port, set the
//     watch ignore for the runtime root.
//   - `configResolved()` — capture the resolved config for the
//     middleware and for HMR custom events.
//   - `configureServer()` — wire `/__devstack/...` middleware
//     endpoints + the SIGTERM handler.
//   - `handleHotUpdate()` — short-circuit reloads when the only
//     changed file is the manifest (snapshot-survivable / no-restart
//     on harmless changes).

import { dirname, normalize } from 'node:path';

import type { HmrContext, Plugin, ResolvedConfig, ViteDevServer } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
	DAPP_KIT_SLOT_KEY,
	ManifestDiscoveryError,
	readStackContext,
	type StackContext,
} from '../runtime/index.ts';
import { coldStartHost, DEFAULT_ROUTER_PUBLIC_PORT } from './cold-start-url.ts';
import { buildDispatchTable, type DispatchTable } from './dispatch-table.ts';
import { discoverIdentity, type ResolvedIdentity } from './discover.ts';
import { wireGracefulShutdown } from './graceful-shutdown.ts';

export interface DevstackVitePluginOptions {
	/** Explicit app name. Overrides env + package.json walk-up. */
	readonly app?: string;
	/** Explicit stack name. Overrides `DEVSTACK_STACK`. */
	readonly stack?: string;
	/** Explicit state-dir override. Overrides `DEVSTACK_STATE_DIR`. */
	readonly stateDir?: string;
	/** Public router port for HMR client + allowedHosts. Defaults
	 *  to `DEFAULT_ROUTER_PUBLIC_PORT`. */
	readonly routerPort?: number;
	/** Disable the SIGTERM/SIGINT graceful-shutdown wiring. Default
	 *  `false`. Tests pass `true` so the test runner's own signal
	 *  handlers aren't shadowed. */
	readonly disableGracefulShutdown?: boolean;
	/** Override the cwd used for identity discovery. Defaults to
	 *  `process.cwd()`. */
	readonly cwd?: string;
}

/** Internal stash on the plugin instance — exposed for tests. */
export interface DevstackVitePluginInternals {
	readonly identity: ResolvedIdentity;
	readonly stackContext: StackContext | null;
	readonly dispatch: DispatchTable;
}

/** Read the stack context, swallowing the discovery error so cold-start
 *  (manifest not yet written) returns null. Shape errors propagate. */
const readStackContextOrNull = (manifestPath: string): StackContext | null => {
	try {
		return readStackContext({ manifestPath });
	} catch (err) {
		if (err instanceof ManifestDiscoveryError) return null;
		throw err;
	}
};

/**
 * The devstack Vite plugin. Apps usually consume it indirectly via
 * `defineDevstackViteConfig` (which pre-installs this plugin). The
 * standalone export is for apps that already have a complex
 * `vite.config.ts` and only want the devstack wiring grafted in.
 */
export const devstackVitePlugin = (options: DevstackVitePluginOptions = {}): Plugin => {
	let identity: ResolvedIdentity | null = null;
	let stackContext: StackContext | null = null;
	let dispatch: DispatchTable = { entries: [], proxy: {}, define: {} };
	let resolvedConfig: ResolvedConfig | null = null;

	return {
		name: 'devstack:vite',
		enforce: 'pre',

		config() {
			identity = discoverIdentity({
				cwd: options.cwd,
				app: options.app,
				stack: options.stack,
				stateDir: options.stateDir,
			});

			stackContext = readStackContextOrNull(identity.manifestPath);
			dispatch = buildDispatchTable(stackContext);

			const routerPort = options.routerPort ?? DEFAULT_ROUTER_PUBLIC_PORT;
			const host = coldStartHost({ app: identity.app, stack: identity.stack });

			// Surface the slot key as a `define` constant so the
			// codegen-emitted dapp-kit-config can write to a single
			// source of truth without hard-coding the literal.
			const define: Record<string, string> = {
				...dispatch.define,
				__DEVSTACK_DAPP_KIT_SLOT_KEY__: JSON.stringify(DAPP_KIT_SLOT_KEY),
				__DEVSTACK_APP__: JSON.stringify(identity.app),
				__DEVSTACK_STACK__: JSON.stringify(identity.stack),
			};

			return {
				define,
				server: {
					// Ignore the state dir so the manifest tick does not
					// trigger a full reload loop ("no-restart on harmless
					// changes" invariant).
					watch: {
						ignored: [`${identity.stateDir.replace(/\\/g, '/')}/**`, '**/.devstack/**'],
					},
					// Router-pinned HMR — the HMR client (browser) talks to
					// the router's PUBLIC port; the supervisor's allocator
					// hands the local dev-server port in via `$PORT`.
					hmr: { clientPort: routerPort },
					// `.localhost` wildcard for traefik routing; the
					// canonical cold-start host is included explicitly so
					// Vite's `Host:` allowlist accepts it.
					allowedHosts: ['.localhost', host],
					// Reverse-proxy mappings derived from the manifest
					// endpoints. User-supplied `server.proxy` (in
					// `defineDevstackViteConfig` `extend`) merges
					// downstream of these.
					proxy: dispatch.proxy,
				},
			};
		},

		configResolved(config: ResolvedConfig) {
			resolvedConfig = config;
		},

		configureServer(server: ViteDevServer) {
			if (!options.disableGracefulShutdown) {
				wireGracefulShutdown(server);
			}

			server.middlewares.use(
				'/__devstack/stack-context',
				(_req: IncomingMessage, res: ServerResponse) => {
					res.setHeader('content-type', 'application/json');
					res.end(JSON.stringify(stackContext ?? null));
				},
			);

			server.middlewares.use(
				'/__devstack/endpoints',
				(_req: IncomingMessage, res: ServerResponse) => {
					res.setHeader('content-type', 'application/json');
					res.end(JSON.stringify(dispatch.entries));
				},
			);

			server.middlewares.use(
				'/__devstack/identity',
				(_req: IncomingMessage, res: ServerResponse) => {
					res.setHeader('content-type', 'application/json');
					res.end(JSON.stringify(identity));
				},
			);
		},

		handleHotUpdate(ctx: HmrContext) {
			// Snapshot-survivable / no-restart on harmless changes. When
			// the changed file is the manifest itself, refresh the
			// in-memory projection and fire a custom HMR event the app can
			// subscribe to — but do NOT trigger a full reload.
			if (identity === null) return undefined;
			const normalizedManifest = normalize(identity.manifestPath);
			const changed = normalize(ctx.file);
			const isManifestChange =
				changed === normalizedManifest || dirname(changed) === dirname(normalizedManifest);

			if (!isManifestChange) return undefined;

			const refreshed = readStackContextOrNull(identity.manifestPath);
			if (refreshed !== null) {
				stackContext = refreshed;
				dispatch = buildDispatchTable(stackContext);
				ctx.server.ws.send({
					type: 'custom',
					event: 'devstack:manifest-updated',
					data: { manifestPath: stackContext.manifestPath },
				});
			}

			// Returning an empty array tells Vite "no modules to reload"
			// — the WS event above is enough for the app's dapp-kit
			// subscriber. Architecture § "no-restart on harmless changes".
			return [];
		},

		// Test seam — surfaced as a custom getter so unit tests can
		// inspect the resolved state without bringing up a real Vite
		// server. Vite's `api` slot is opaque (`Record<string, any>`)
		// by design.
		api: {
			__devstack: (): DevstackVitePluginInternals => {
				if (identity === null) throw new Error('plugin not yet configured');
				return { identity, stackContext, dispatch };
			},
			getResolvedConfig: (): ResolvedConfig | null => resolvedConfig,
		},
	} as Plugin;
};
