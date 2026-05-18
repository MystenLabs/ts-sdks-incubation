// Conventional URL contract — the `<stack>.<service>.<app>.localhost:<port>`
// hostname/port shape every primitive routes through. Used as a cold-start
// fallback when no manifest exists on disk yet (e.g. Playwright's
// `webServer({ endpoint })` resolving at config-load time before
// `devstack up` has materialized a stack). The `CONVENTIONAL_ROUTES` table
// is in lockstep with each primitive's `traefik.entrypoints=<name>` label —
// when the supervisor wires the real stack, the URL it publishes converges
// with what this map computes.

import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { EndpointName } from './endpoint-names.js';

/** Endpoint → (router-service-name, traefik entrypoint port) mapping.
 *  Matches the supervisor's wire-up in `services/{dev,wallet,sui,walrus,
 *  seal}` — each routes via `<stack>.<service>.<app>.localhost:<port>`
 *  on the matching traefik entrypoint. Used when the manifest doesn't
 *  exist yet so `webServer({ endpoint })` can still produce a URL for
 *  playwright's config-load step. */
export const CONVENTIONAL_ROUTES: Record<string, { service: string; port: number }> = {
	// Both names route to the same dev service. `DEV_SERVER_PRIMARY` is the
	// canonical lookup key in the manifest (see `runtime/service.ts`'s
	// `groupApp`); `DEV_SERVER_FALLBACK` is what the built-in `Dev()`
	// factory publishes today. Listing both lets cold-start succeed for
	// either name.
	[EndpointName.DEV_SERVER_PRIMARY]: { service: 'dev', port: 5175 },
	[EndpointName.DEV_SERVER_FALLBACK]: { service: 'dev', port: 5175 },
	[EndpointName.WALLET_APP]: { service: 'wallet', port: 5180 },
	[EndpointName.SUI_RPC]: { service: 'sui', port: 9000 },
	[EndpointName.SUI_FAUCET]: { service: 'faucet', port: 9123 },
	[EndpointName.SUI_GRAPHQL]: { service: 'graphql', port: 9125 },
	[EndpointName.WALRUS_AGGREGATOR]: { service: 'walrus-agg', port: 9185 },
	[EndpointName.WALRUS_PUBLISHER]: { service: 'walrus-pub', port: 9185 },
	[EndpointName.SEAL_KEY_SERVER]: { service: 'seal', port: 2024 },
};

/** Read the `name` field out of `<dir>/package.json`. Returns the
 *  un-scoped basename so `@org/foo` → `foo`. Mirrors `deriveAppName`
 *  in the engine so the conventional URL fallback matches the
 *  supervisor's eventual routing. */
export const readAppName = (dir: string): string | undefined => {
	try {
		const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')) as {
			name?: string;
		};
		if (typeof pkg.name !== 'string') return undefined;
		const stripped = pkg.name.replace(/^@[^/]+\//, '').replace(/^[^a-zA-Z0-9]+/, '');
		return stripped.length > 0 ? stripped : undefined;
	} catch {
		return undefined;
	}
};

/** Compute the conventional URL for `endpoint`, or `undefined` if the
 *  endpoint isn't in `CONVENTIONAL_ROUTES`. `stack` defaults to
 *  `process.env.DEVSTACK_STACK ?? 'main'`; `app` defaults to the local
 *  `package.json` name (un-scoped) and finally `basename(process.cwd())`.
 *  Both are injectable so the function is unit-testable without
 *  depending on environment / cwd state. */
export const conventionalUrl = (
	endpoint: string,
	opts?: { stack?: string; app?: string },
): string | undefined => {
	const route = CONVENTIONAL_ROUTES[endpoint];
	if (route === undefined) return undefined;
	const stack = opts?.stack ?? process.env.DEVSTACK_STACK ?? 'main';
	const app = opts?.app ?? readAppName(process.cwd()) ?? basename(process.cwd());
	const host =
		stack === 'main'
			? `${route.service}.${app}.localhost`
			: `${stack}.${route.service}.${app}.localhost`;
	return `http://${host}:${route.port}`;
};
