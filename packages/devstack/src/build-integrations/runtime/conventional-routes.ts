// Conventional-routes table — substrate-owned defaults for the
// "config-load before manifest" cold-start path.
//
// Build integrations (Playwright, vitest, …) that need an endpoint URL
// BEFORE the supervisor has written the manifest go through
// `coldStartUrl(endpoint, { routes, ... })`. The route table itself is
// a parameter — `runtime/coldStartUrl` deliberately stays
// service-name-blind. THIS module supplies the conventional table the
// router plugin would populate at supervise-time, so build integrations
// don't each carry their own copy.
//
// Add a new built-in service: add one entry here AND ship a Routable
// plugin that publishes the matching `<service>` hostname at the same
// port. Architecture invariant "conventional URL convergence" — the
// fallback returned by `coldStartUrl({ routes })` MUST equal the URL
// the router publishes once the manifest exists.
//
// This is the L5 cold-start mirror of the router plugin's runtime
// table. The L5 surface (Playwright / vitest) consults it once; the
// runtime table wins as soon as the manifest is on disk.

import {
	conventionalRoutesFromHints,
	type ConventionalRoute,
	type ConventionalRouteHint,
} from './cold-start-url.ts';

/**
 * The Traefik entrypoint port the supervisor's router maps every
 * conventional endpoint to. All built-in routes share this single port
 * because Traefik dispatches by Host header, not by port. If a future
 * plugin requires a distinct entrypoint port it would extend
 * `BUILT_IN_CONVENTIONAL_HINTS` AND extend the router profile to add
 * the entrypoint; until then, one port covers every built-in.
 */
export const DEFAULT_ROUTER_ENTRYPOINT_PORT = 5175 as const;

/**
 * Endpoint-name aliases the conventional-route resolver folds before
 * looking up a row. Lets in-spec helpers reach `endpoint('app')` or
 * `endpoint('wallet')` without knowing the router's canonical
 * spelling (`'dev'` / `'wallet-app'`). Aliases are bidirectional in
 * intent — the table key is the alias users type; the value is the
 * service segment routed in the manifest.
 */
export const BUILT_IN_ENDPOINT_ALIASES = {
	app: 'dev',
	wallet: 'wallet-app',
} as const;

/**
 * Conventional endpoint→service hints for every built-in plugin that
 * publishes a Routable. Build integrations consume this through
 * `builtInConventionalRoutes()` rather than each carrying their own
 * copy. The substrate stays open: callers may extend by passing extra
 * hints to `coldStartUrl` directly.
 */
export const BUILT_IN_CONVENTIONAL_HINTS: ReadonlyArray<ConventionalRouteHint> = [
	{ endpoint: 'app', service: 'dev' },
	{ endpoint: 'dev', service: 'dev' },
	{ endpoint: 'sui-rpc', service: 'sui-rpc' },
	{ endpoint: 'sui-faucet', service: 'sui-faucet' },
	{ endpoint: 'walrus-aggregator', service: 'walrus-aggregator' },
	{ endpoint: 'walrus-publisher', service: 'walrus-publisher' },
	{ endpoint: 'seal', service: 'seal' },
	{ endpoint: 'wallet', service: 'api' },
	{ endpoint: 'wallet-app', service: 'api' },
];

/**
 * Resolve the built-in conventional route table. `port` overrides the
 * default entrypoint port (set by env / explicit caller option). The
 * resulting `Map` is the shape `coldStartUrl({ routes })` consumes.
 */
export const builtInConventionalRoutes = (
	port: number = DEFAULT_ROUTER_ENTRYPOINT_PORT,
): ReadonlyMap<string, ConventionalRoute> =>
	conventionalRoutesFromHints(BUILT_IN_CONVENTIONAL_HINTS, port);

/**
 * Look up the alias-resolved endpoint key for a user-typed name.
 * Returns the input unchanged when no alias is registered.
 */
export const resolveBuiltInEndpointAlias = (endpointNameOrAlias: string): string => {
	const aliases: Readonly<Record<string, string>> = BUILT_IN_ENDPOINT_ALIASES;
	return aliases[endpointNameOrAlias] ?? endpointNameOrAlias;
};
