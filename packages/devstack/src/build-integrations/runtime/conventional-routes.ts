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
import { WALLET_ENDPOINT_KEY, WALLET_ENDPOINT_NAME } from './wallet-paths.ts';
import type { ManifestEnvelope } from '../../substrate/manifest.ts';

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
 *
 * The wallet entry sources both sides from the wallet plugin (via the
 * L5 bridge in `wallet-paths.ts`) so there is exactly one source of
 * truth for the alias/canonical pairing — see `WALLET_ENDPOINT_KEY`
 * in `plugins/wallet/routable.ts`.
 */
export const BUILT_IN_ENDPOINT_ALIASES = {
	app: 'dev',
	[WALLET_ENDPOINT_KEY]: WALLET_ENDPOINT_NAME,
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
	{ endpoint: WALLET_ENDPOINT_KEY, service: 'api' },
	{ endpoint: WALLET_ENDPOINT_NAME, service: 'api' },
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

// -----------------------------------------------------------------------------
// Manifest-derived conventional routes
// -----------------------------------------------------------------------------
//
// Once the supervisor has written the manifest, the route table the
// router already published is the ground truth. Build integrations
// SHOULD prefer that over the hardcoded `BUILT_IN_CONVENTIONAL_HINTS`
// table — the hardcoded list is the cold-start fallback for callers
// running before the manifest exists (Playwright config-load, vitest
// preset bootstrap, dev-mode tests).
//
// The manifest's `endpoints` map carries each plugin's published
// endpoint name + URL; we project those into the `ConventionalRoute`
// shape `coldStartUrl({ routes })` expects so the same downstream
// code consumes either source.

/**
 * Build a route table from the live manifest. Each endpoint's
 * `endpointKey` becomes a route key; the URL is parsed back into its
 * host + port shape. The manifest-derived table is preferred over the
 * hardcoded fallback whenever it covers the caller's endpoint name.
 */
export const conventionalRoutesFromManifest = (
	envelope: ManifestEnvelope,
): ReadonlyMap<string, ConventionalRoute> => {
	const routes = new Map<string, ConventionalRoute>();
	for (const entry of Object.values(envelope.endpoints)) {
		const protocol = entry.wireProtocol === 'h2c' ? 'h2c' : 'http';
		const route = parseEndpointUrl(entry.url, protocol);
		if (route === null) continue;
		// Index by both the endpoint name and the raw endpointKey so
		// callers can look up either form.
		routes.set(entry.name, route);
		if (entry.endpointKey !== entry.name) {
			routes.set(entry.endpointKey, route);
		}
	}
	return routes;
};

/**
 * Merge the manifest-derived table over the hardcoded fallback so
 * callers always get the live entries when available, plus the
 * cold-start defaults for endpoints not yet registered. Used by
 * build integrations that prefer a single resolution call.
 */
export const conventionalRoutesPreferringManifest = (
	envelope: ManifestEnvelope | null,
	port: number = DEFAULT_ROUTER_ENTRYPOINT_PORT,
): ReadonlyMap<string, ConventionalRoute> => {
	const fallback = builtInConventionalRoutes(port);
	if (envelope === null) return fallback;
	const fromManifest = conventionalRoutesFromManifest(envelope);
	const merged = new Map<string, ConventionalRoute>(fallback);
	for (const [key, route] of fromManifest) {
		merged.set(key, route);
	}
	return merged;
};

/**
 * Project a manifest endpoint URL back into the conventional-route
 * row shape. URLs follow the router's convention
 * `<service>.<stack>.<app>.<suffix>:<port>` (or
 * `<service>.<app>.<suffix>:<port>` when `stack === 'main'`); we
 * recover the `service` segment + the explicit port. Returns `null`
 * when the URL is unparseable or missing a port (rare —
 * conventional-routes always carry an explicit port).
 */
const parseEndpointUrl = (
	rawUrl: string,
	wireProtocol: ConventionalRoute['wireProtocol'] = 'http',
): ConventionalRoute | null => {
	try {
		const url = new URL(rawUrl);
		const portNumber = url.port.length > 0 ? Number.parseInt(url.port, 10) : null;
		if (portNumber === null || !Number.isFinite(portNumber) || portNumber <= 0) return null;
		const service = url.hostname.split('.')[0];
		if (service === undefined || service.length === 0) return null;
		return { service, port: portNumber, wireProtocol };
	} catch {
		return null;
	}
};
