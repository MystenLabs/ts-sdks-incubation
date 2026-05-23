// Deepbook plugin — Routable contributions.
//
// Two optional endpoints in local mode:
//
//   - `deepbook-server`  — Rust REST server (port 9008). HTTP, CORS.
//   - `deepbook-indexer` — Postgres-writing indexer (no HTTP), only
//                          the Prometheus scrape endpoint surfaces;
//                          we don't route it through Traefik today.
//
// Substrate's router mints hostnames from `(app, stack, dispatch-id)`
// — no service hostnames hardcoded in router code.

import type { DispatchId, EntrypointDecl, RoutableDecl } from '../../contracts/routable.ts';

export const DEEPBOOK_SERVER_ENDPOINT_NAME = 'deepbook-server' as const;
export const DEEPBOOK_SERVER_METRICS_ENDPOINT_NAME = 'deepbook-server-metrics' as const;
export const DEEPBOOK_INDEXER_METRICS_ENDPOINT_NAME = 'deepbook-indexer-metrics' as const;
export const DEEPBOOK_SERVER_ENTRYPOINT_PORT = 9008;
export const DEEPBOOK_SERVER_METRICS_ENTRYPOINT_PORT = 9186;
export const DEEPBOOK_INDEXER_METRICS_ENTRYPOINT_PORT = 9184;

export const DEEPBOOK_ENTRYPOINTS: ReadonlyArray<EntrypointDecl> = [
	{ name: DEEPBOOK_SERVER_ENDPOINT_NAME, port: DEEPBOOK_SERVER_ENTRYPOINT_PORT, protocol: 'http' },
	{
		name: DEEPBOOK_SERVER_METRICS_ENDPOINT_NAME,
		port: DEEPBOOK_SERVER_METRICS_ENTRYPOINT_PORT,
		protocol: 'http',
	},
	{
		name: DEEPBOOK_INDEXER_METRICS_ENDPOINT_NAME,
		port: DEEPBOOK_INDEXER_METRICS_ENTRYPOINT_PORT,
		protocol: 'http',
	},
];

export const buildServerDispatchId = (name: string): DispatchId => ({
	serviceKey: `deepbook:${name}`,
	role: 'server',
});

export const makeServerRoutable = (inputs: {
	readonly name: string;
	readonly containerName: string;
}): RoutableDecl => ({
	kind: 'routable',
	endpointName: DEEPBOOK_SERVER_ENDPOINT_NAME,
	dispatchId: buildServerDispatchId(inputs.name),
	upstream: {
		type: 'container',
		containerName: inputs.containerName,
		containerPort: DEEPBOOK_SERVER_ENTRYPOINT_PORT,
	},
	cors: true,
	wireProtocol: 'http',
});
