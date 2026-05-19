// Conventional URL contract — the `<stack>.<service>.<app>.localhost:<port>`
// hostname/port shape every primitive routes through. Used as a cold-start
// fallback when no manifest exists on disk yet (e.g. Playwright's
// `webServer({ endpoint })` resolving at config-load time before
// `devstack up` has materialized a stack). The `CONVENTIONAL_ROUTES` table
// is derived from each endpoint's `defineEndpoint(...)` declaration in
// `runtime/endpoint-names.ts` — when the supervisor wires the real stack,
// the URL it publishes converges with what this map computes.

import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import {
	type ConventionalRoute,
	listEndpointDeclarations,
} from '../engine/define-endpoint.js';
// Side-effect import: registering the endpoint declarations populates
// `listEndpointDeclarations()`. The conventional-route table reads that
// registry, so it must run AFTER endpoint-names.ts has executed at
// module-init time.
import './endpoint-names.js';

/** Endpoint → (router-service-name, traefik entrypoint port) mapping.
 *  Derived from `defineEndpoint(...)` declarations — each entry that
 *  carries a `conventional: {service, port}` block surfaces here. Used
 *  when the manifest doesn't exist yet so `webServer({ endpoint })` can
 *  still produce a URL for playwright's config-load step. */
export const CONVENTIONAL_ROUTES: Record<string, ConventionalRoute> = (() => {
	const out: Record<string, ConventionalRoute> = {};
	for (const d of listEndpointDeclarations()) {
		if (d.conventional !== undefined) {
			out[d.name] = d.conventional;
		}
	}
	return out;
})();

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
