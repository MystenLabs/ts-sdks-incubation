// Dashboard plugin — Routable contribution.
//
// The dashboard's HTTP/GraphQL server is a host process (not a docker
// container) listening on a loopback port the substrate's port broker
// hands us. The router (Traefik) fronts the loopback port under a
// stack-scoped hostname like `dashboard.<app>.localhost:<router-port>`.
//
// Mirrors `plugins/wallet/routable.ts`. The entrypoint declared here must
// be aggregated into `plugins/router-entrypoints.ts` so Traefik opens the
// listener port.

import type { EntrypointDecl, RoutableDecl } from '../../contracts/routable.ts';

export const DASHBOARD_ENDPOINT_NAME = 'dashboard';
export const DASHBOARD_ROUTE_ROLE = 'api' as const;
export const DASHBOARD_ENTRYPOINT_PORT = 9810;

export const DASHBOARD_ENTRYPOINTS: ReadonlyArray<EntrypointDecl> = [
	{ name: DASHBOARD_ENDPOINT_NAME, port: DASHBOARD_ENTRYPOINT_PORT, protocol: 'http' },
];

/** Construct the Routable decl for the stack-scoped dashboard endpoint. */
export const makeDashboardRoutable = (parts: {
	readonly app: string;
	readonly stack: string;
	readonly port: number;
}): RoutableDecl => ({
	kind: 'routable',
	endpointName: DASHBOARD_ENDPOINT_NAME,
	dispatchId: {
		serviceKey: `dashboard.${parts.app}.${parts.stack}`,
		role: DASHBOARD_ROUTE_ROLE,
	},
	upstream: { type: 'host-loopback', port: parts.port },
	cors: true,
	wireProtocol: 'http',
});
