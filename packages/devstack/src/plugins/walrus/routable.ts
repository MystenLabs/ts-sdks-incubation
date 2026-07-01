// Walrus plugin — Routable contributions.
//
// Distilled-doc reference (06-walrus.md §"Routes registered"):
// each storage node carries one Traefik route. The router binds host
// port 9185 once globally and dispatches by `Host:` header to the
// per-stack backend — `routerHostname(identity, 'walrus-node-<i>')`.
//
// For the local cluster:
//   - N × `walrus-node-<i>` routes — one per storage node, with
//     `cors: true` (walrus storage REST API lacks CORS headers). These
//     are HTTP public routes backed by HTTPS upstreams because Walrus
//     storage nodes self-sign TLS with their network key.
//   - 1 × `walrus-aggregator` route — release `walrus aggregator`
//     service container
//     exposing `GET /v1/blobs/:id` through a single app-facing URL.
//   - 1 × `walrus-publisher` route — release `walrus publisher`
//     service container
//     exposing `PUT /v1/blobs` through a single app-facing URL.
//   - 1 × `walrus-upload-relay` route — release `walrus-upload-relay`
//     service container
//     exposing the SDK upload relay API through a single app-facing URL.
//
// Known-deployment publishes no routes — the aggregator/publisher
// / upload-relay URLs land on the codegen-emitted `WalrusBindings`
// URL fields instead.

import type { EntrypointDecl, RoutableDecl } from '../../contracts/routable.ts';
import { WALRUS_ROUTER_PORT } from './storage-nodes.ts';
import type { WalrusClientService } from './client-services.ts';

export const WALRUS_NODE_ENDPOINT_PREFIX = 'walrus-node-' as const;
export const WALRUS_AGGREGATOR_ENDPOINT_NAME = 'walrus-aggregator' as const;
export const WALRUS_PUBLISHER_ENDPOINT_NAME = 'walrus-publisher' as const;
export const WALRUS_UPLOAD_RELAY_ENDPOINT_NAME = 'walrus-upload-relay' as const;

/** Upper bound on `nodeCount` — Traefik entrypoints are bound at boot,
 *  so the cluster's per-node routes need pre-declared entrypoint names.
 *  Validated at factory time in `mode/local-cluster.ts:resolveOptions`. */
export const WALRUS_MAX_NODE_COUNT = 8;

export const WALRUS_ENTRYPOINTS: ReadonlyArray<EntrypointDecl> = [
	...Array.from(
		{ length: WALRUS_MAX_NODE_COUNT },
		(_, i): EntrypointDecl => ({
			name: `${WALRUS_NODE_ENDPOINT_PREFIX}${i}`,
			port: WALRUS_ROUTER_PORT,
			protocol: 'http',
		}),
	),
	{ name: WALRUS_AGGREGATOR_ENDPOINT_NAME, port: WALRUS_ROUTER_PORT, protocol: 'http' },
	{ name: WALRUS_PUBLISHER_ENDPOINT_NAME, port: WALRUS_ROUTER_PORT, protocol: 'http' },
	{ name: WALRUS_UPLOAD_RELAY_ENDPOINT_NAME, port: WALRUS_ROUTER_PORT, protocol: 'http' },
];

/** Build the Routable contributions for the local cluster. `nodeCount`
 *  drives the per-node fan-out; the plugin's service key + route role
 *  identify the dispatch target. */
export const makeLocalRoutables = (args: {
	readonly app: string;
	readonly stack: string;
	readonly walrusName: string;
	readonly serviceKey: string;
	readonly nodeCount: number;
	readonly containerApiPort?: number;
	readonly aggregator?: WalrusClientService | null;
	readonly publisher?: WalrusClientService | null;
	readonly uploadRelay?: WalrusClientService | null;
}): ReadonlyArray<RoutableDecl> => {
	const containerPort = args.containerApiPort ?? WALRUS_ROUTER_PORT;
	const containerNameFor = (i: number): string =>
		`devstack-${args.app}-${args.stack}-walrus-${args.walrusName}-node-${i}`;
	const perNodeRoutes: ReadonlyArray<RoutableDecl> = Array.from(
		{ length: args.nodeCount },
		(_, i): RoutableDecl => ({
			kind: 'routable',
			endpointName: `${WALRUS_NODE_ENDPOINT_PREFIX}${i}`,
			dispatchId: {
				serviceKey: args.serviceKey,
				role: `${WALRUS_NODE_ENDPOINT_PREFIX}${i}`,
			},
			upstream: {
				type: 'container',
				containerName: containerNameFor(i),
				containerPort,
			},
			// Distilled-doc §"Routes registered": cors: true (walrus
			// storage REST API lacks CORS headers).
			cors: true,
			wireProtocol: 'https',
		}),
	);

	const serviceRoutes: RoutableDecl[] = [];
	const pushServiceRoute = (endpointName: string, service: WalrusClientService) => {
		serviceRoutes.push({
			kind: 'routable',
			endpointName,
			dispatchId: {
				serviceKey: args.serviceKey,
				role: endpointName,
			},
			upstream: {
				type: 'container',
				containerName: service.containerName,
				containerPort: service.containerPort,
			},
			cors: true,
			wireProtocol: 'http',
		});
	};
	if (args.aggregator !== undefined && args.aggregator !== null) {
		pushServiceRoute(WALRUS_AGGREGATOR_ENDPOINT_NAME, args.aggregator);
	}
	if (args.publisher !== undefined && args.publisher !== null) {
		pushServiceRoute(WALRUS_PUBLISHER_ENDPOINT_NAME, args.publisher);
	}
	if (args.uploadRelay !== undefined && args.uploadRelay !== null) {
		pushServiceRoute(WALRUS_UPLOAD_RELAY_ENDPOINT_NAME, args.uploadRelay);
	}

	return [...perNodeRoutes, ...serviceRoutes];
};
