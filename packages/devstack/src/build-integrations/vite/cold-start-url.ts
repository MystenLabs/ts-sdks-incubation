// Cold-start URL — the URL the app's dev server is reachable at
// BEFORE the supervisor has emitted a manifest.
//
// Architecture § Per-integration requirements / Vite: the preset must
// produce a stable URL at config-load time so Playwright (the
// downstream integration) can poll for readiness via `webServer.url`
// before the supervisor writes the real manifest. Vite itself uses
// this URL for the HMR client port and to surface a canonical entry
// URL via `viteDevServer.printUrls`.
//
// Pattern (mirrors v3 conventional routes):
//
//   main stack:        dev.<app>.localhost:<routerPort>
//   non-main stack:    dev.<stack>.<app>.localhost:<routerPort>
//
// The router (L3 orchestrator) owns the wildcard `.localhost` host
// space; the vite integration MUST keep its allowlist in sync (set
// in `config.ts`). Convergence with the eventual manifest is an
// architectural invariant (`distilled/23-build-integrations.md`
// § "Edge cases: cold-start with no manifest").

import {
	conventionalRouteHost,
	conventionalRouteUrl,
	type ConventionalRoute,
} from '../runtime/index.ts';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** Public router port the cold-start URL points at. The router
 *  pins this; the vite preset's HMR clientPort matches. Pulled into a
 *  named constant so the two sites stay in sync. */
export const DEFAULT_ROUTER_PUBLIC_PORT = 5175;

/** Hostname infix that distinguishes the dev-server entrypoint from
 *  service endpoints (`<service>.<stack>.<app>.localhost`). The
 *  router emits routes for both shapes; this constant pins the
 *  dev-server one. */
export const DEV_HOST_INFIX = 'dev';

const DEV_SERVER_ROUTE: ConventionalRoute = {
	service: DEV_HOST_INFIX,
	port: DEFAULT_ROUTER_PUBLIC_PORT,
	wireProtocol: 'http',
};

// -----------------------------------------------------------------------------
// API
// -----------------------------------------------------------------------------

export interface ColdStartUrlInput {
	readonly app: string;
	readonly stack: string;
	/** Public router port. Default `DEFAULT_ROUTER_PUBLIC_PORT`. */
	readonly routerPort?: number;
	/** Override scheme. Default `'http'`. */
	readonly scheme?: 'http' | 'https';
}

/**
 * Compute the canonical entry URL for this app/stack. Stable at
 * config-load time; does not consult the manifest. Used as the
 * `webServer.url` baseline before the manifest exists.
 */
export const coldStartUrl = (input: ColdStartUrlInput): string => {
	const scheme = input.scheme ?? 'http';
	return conventionalRouteUrl({
		route: { ...DEV_SERVER_ROUTE, port: input.routerPort ?? DEFAULT_ROUTER_PUBLIC_PORT },
		service: DEV_HOST_INFIX,
		app: input.app,
		stack: input.stack,
		scheme,
		trailingSlash: true,
	});
};

/**
 * Hostname-only variant (no scheme, no port). Used for Vite's
 * `server.allowedHosts` allowlist where the host is matched literally.
 */
export const coldStartHost = (input: Omit<ColdStartUrlInput, 'routerPort' | 'scheme'>): string =>
	conventionalRouteHost({
		service: DEV_HOST_INFIX,
		app: input.app,
		stack: input.stack,
	});
