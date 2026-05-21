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

import type { DispatchId, RoutableDecl } from '../../contracts/routable.ts';

export const DEEPBOOK_SERVER_ENDPOINT_NAME = 'deepbook-server' as const;

export const buildServerDispatchId = (name: string): DispatchId => ({
	compositeKey: `deepbook:${name}`,
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
		containerPort: 9008,
	},
	cors: true,
	wireProtocol: 'http',
});
