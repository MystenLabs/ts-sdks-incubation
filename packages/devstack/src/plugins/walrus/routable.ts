// Walrus plugin — Routable contributions.
//
// Distilled-doc reference (06-walrus.md §"Routes registered"):
// each storage node carries one Traefik route. The router binds host
// port 9185 once globally and dispatches by `Host:` header to the
// per-stack backend — `routerHostname(identity, 'walrus-node-<i>')`.
//
// For the local cluster:
//   - N × `walrus-node-<i>` routes — one per storage node, with
//     `cors: true` (walrus storage REST API lacks CORS headers).
//   - 1 × `walrus-aggregator` alias — same backend as `walrus-node-0`,
//     surfaces the conventional alias for SDK consumers.
//   - 1 × `walrus-publisher` alias — collapsed onto the same backend
//     (distilled-doc §"Endpoints" — "collapsed onto a single Traefik
//     vhost").
//
// Known-deployment publishes no routes — the aggregator/publisher
// URLs land on the codegen-emitted `WalrusBindings.{aggregator,
// publisher}Url` instead.

import type { EntrypointDecl, RoutableDecl } from '../../contracts/routable.ts';
import { WALRUS_ROUTER_PORT } from './storage-nodes.ts';

export const WALRUS_NODE_ENDPOINT_PREFIX = 'walrus-node-' as const;
export const WALRUS_AGGREGATOR_ENDPOINT_NAME = 'walrus-aggregator' as const;
export const WALRUS_PUBLISHER_ENDPOINT_NAME = 'walrus-publisher' as const;

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
			wireProtocol: 'http',
		}),
	);

	// Aggregator + publisher aliases — collapsed onto node-0 per the
	// distilled doc. The aggregator and publisher are conventional
	// endpoint names that downstream HTTP consumers look up via the
	// substrate's endpoint registry.
	const aggregator: RoutableDecl = {
		kind: 'routable',
		endpointName: WALRUS_AGGREGATOR_ENDPOINT_NAME,
		dispatchId: {
			serviceKey: args.serviceKey,
			role: WALRUS_AGGREGATOR_ENDPOINT_NAME,
		},
		upstream: { type: 'container', containerName: containerNameFor(0), containerPort },
		cors: true,
		wireProtocol: 'http',
	};
	const publisher: RoutableDecl = {
		kind: 'routable',
		endpointName: WALRUS_PUBLISHER_ENDPOINT_NAME,
		dispatchId: {
			serviceKey: args.serviceKey,
			role: WALRUS_PUBLISHER_ENDPOINT_NAME,
		},
		upstream: { type: 'container', containerName: containerNameFor(0), containerPort },
		cors: true,
		wireProtocol: 'http',
	};

	return [...perNodeRoutes, aggregator, publisher];
};
