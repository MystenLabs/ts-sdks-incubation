// Hostname helper for the shared Traefik router.
//
// Every primitive that surfaces an HTTP-like endpoint runs behind a
// single long-lived Traefik instance (see `./docker/router.ts`). The
// hostname convention is:
//
//   main stack:        `<service>.<app>.localhost`
//   non-main stack:    `<stack>.<service>.<app>.localhost`
//
// `*.localhost` resolves to 127.0.0.1 per RFC 6761 in every browser
// and in Node's DNS resolver — no `/etc/hosts` edits required.
//
// Examples (app=arena, service=sui):
//   stack=main → `sui.arena.localhost`
//   stack=test → `test.sui.arena.localhost`
//
// Traefik routers stamped on each container's labels then match
// `Host(...)` headers and route to the right backend.

import type { IdentityShape } from './identity.js';

export const routerHostname = (identity: IdentityShape, service: string): string =>
	identity.stack === 'main'
		? `${service}.${identity.app}.localhost`
		: `${identity.stack}.${service}.${identity.app}.localhost`;

// Composed unique router id for traefik labels: `<app>-<stack>-<service>`.
// Used as both `traefik.http.routers.<id>.*` and
// `traefik.http.services.<id>.*` so per-stack labels don't collide.
//
// Allowed chars match docker's label-value constraint (no `.`, `/`,
// or whitespace); we normalize the `service` segment by folding `.`
// to `-` so callers can pass through values like `sui.localnet`.
export const routerId = (identity: IdentityShape, service: string): string => {
	const flat = service.replaceAll('.', '-');
	return `${identity.app}-${identity.stack}-${flat}`;
};
