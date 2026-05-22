// Cold-start URL — conventional-route fallback for callers that need
// an endpoint URL BEFORE the supervisor has written the manifest.
//
// Playwright's config loader runs ahead of the supervisor (it's the
// process that spawns `pnpm dev`, which boots the supervisor, which
// then writes the manifest). For `webServer.url` / `use.baseURL` to
// be resolvable at config-load time, the build-integration needs a
// derivation that doesn't require the manifest on disk.
//
// The derivation:
//
//   <service>.<stack-prefix>.<app>.localhost:<port>
//
// where:
//   - `<service>` and `<port>` come from the endpoint's Routable
//     declaration (its `conventional` hint, populated by the router
//     plugin).
//   - `<app>` is the un-scoped app name (from cwd's `package.json` or
//     an explicit override).
//   - `<stack-prefix>` comes from an explicit stack, `DEVSTACK_STACK`,
//     or the `main` default. Package metadata is not a stack selector
//     for build integrations; it only supplies the app name.
//   - `<stack-prefix>` is empty for the `main` stack and `.<stack>`
//     otherwise. Matches the router's hostname-minting rule so
//     conventional and post-manifest URLs converge.
//
// Architecture § invariants: "conventional URL convergence" — the
// fallback this function returns MUST equal the URL the supervisor's
// router publishes once the manifest exists. The shared invariant is
// enforced by deriving both from the same Routable declaration.
//
// This module does NOT import any service-specific endpoint names.
// The conventional-route table is supplied by the caller; the router
// plugin populates it from `RoutableDecl[].upstream` + a hard-coded
// conventional-port map. (Architecture: "engine knows zero service
// names" — the table is plugin-emitted.)

import { basename } from 'node:path';

import { NoConventionalRouteError } from './errors.ts';
import { readAppName, resolveBuildIntegrationStack } from './discover.ts';

/** One row of the conventional-route table. The supervisor's router
 *  plugin emits a `Map<endpointName, ConventionalRoute>` from its
 *  Routable contributions; cold-start URL resolution keys off it. */
export interface ConventionalRoute {
	/** `<service>` segment of the hostname — typically the
	 *  routable's `dispatchId.role`. */
	readonly service: string;
	/** Traefik entrypoint port — the router's public-facing port for
	 *  this endpoint kind. */
	readonly port: number;
	/** Wire protocol — `http` or `h2c`. Determines the URL scheme. */
	readonly wireProtocol: 'http' | 'h2c';
}

export interface ColdStartUrlOptions {
	/** Conventional-route table to consult. Supplied by the caller
	 *  (build integration), populated from the router plugin's
	 *  `RoutableDecl` contributions. Empty by default — calls that
	 *  don't pass a table will always throw, which is the right
	 *  behavior for "no router plugin = no fallback". */
	readonly routes: ReadonlyMap<string, ConventionalRoute>;
	/** Stack name. Defaults through `$DEVSTACK_STACK`, then `'main'`. */
	readonly stack?: string;
	/** App name (un-scoped). Defaults to reading `package.json` at
	 *  `cwd` (with the `@scope/` prefix stripped) and finally to
	 *  `basename(cwd)`. Injectable so unit tests don't depend on
	 *  filesystem state. */
	readonly app?: string;
	/** Starting directory for the app-name lookup. Defaults to
	 *  `process.cwd()`. */
	readonly cwd?: string;
	/** Host suffix owned by the router. Default: `.localhost`. */
	readonly hostSuffix?: string;
}

export interface ConventionalRouteHostInput {
	readonly service: string;
	readonly app: string;
	readonly stack: string;
	readonly hostSuffix?: string;
}

export interface ConventionalRouteUrlInput extends ConventionalRouteHostInput {
	readonly route: ConventionalRoute;
	readonly scheme?: 'http' | 'https';
	readonly trailingSlash?: boolean;
}

export interface ConventionalRouteHint {
	readonly endpoint: string;
	readonly service: string;
	readonly wireProtocol?: 'http' | 'h2c';
}

export const conventionalRouteHost = (input: ConventionalRouteHostInput): string => {
	const hostSuffix = input.hostSuffix ?? '.localhost';
	return input.stack === 'main'
		? `${input.service}.${input.app}${hostSuffix}`
		: `${input.service}.${input.stack}.${input.app}${hostSuffix}`;
};

export const conventionalRouteUrl = (input: ConventionalRouteUrlInput): string => {
	const scheme = input.scheme ?? 'http';
	const host = conventionalRouteHost(input);
	const url = `${scheme}://${host}:${input.route.port}`;
	return input.trailingSlash === true ? `${url}/` : url;
};

export const conventionalRoutesFromHints = (
	hints: ReadonlyArray<ConventionalRouteHint>,
	port: number,
): ReadonlyMap<string, ConventionalRoute> =>
	new Map(
		hints.map((hint): [string, ConventionalRoute] => [
			hint.endpoint,
			{
				service: hint.service,
				port,
				wireProtocol: hint.wireProtocol ?? 'http',
			},
		]),
	);

/**
 * Compute the conventional URL for `endpoint`. Throws
 * `NoConventionalRouteError` when the endpoint isn't in the supplied
 * `routes` table.
 *
 * Callers that prefer a `undefined`-on-miss surface should catch the
 * error or use `tryColdStartUrl` instead.
 */
export const coldStartUrl = (endpoint: string, opts: ColdStartUrlOptions): string => {
	const route = opts.routes.get(endpoint);
	if (route === undefined) {
		const supported = [...opts.routes.keys()].sort();
		throw new NoConventionalRouteError({
			endpoint,
			supported,
			message:
				`[devstack] endpoint ${JSON.stringify(endpoint)} has no conventional URL fallback. ` +
				`Supported endpoints: ${supported.length === 0 ? '(none)' : supported.join(', ')}. ` +
				`Check the endpoint name or write the manifest first via \`devstack up\`.`,
		});
	}
	const cwd = opts.cwd ?? process.cwd();
	const stack = resolveBuildIntegrationStack(opts.stack);
	const app = opts.app ?? readAppName(cwd) ?? basename(cwd);
	return conventionalRouteUrl({
		route,
		service: route.service,
		app,
		stack,
		...(opts.hostSuffix !== undefined ? { hostSuffix: opts.hostSuffix } : {}),
		scheme: route.wireProtocol === 'h2c' ? 'http' : 'http',
	});
};

/** `undefined`-on-miss variant. */
export const tryColdStartUrl = (
	endpoint: string,
	opts: ColdStartUrlOptions,
): string | undefined => {
	if (!opts.routes.has(endpoint)) return undefined;
	return coldStartUrl(endpoint, opts);
};
