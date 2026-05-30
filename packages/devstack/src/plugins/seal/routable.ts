// Seal plugin — Routable contribution.
//
// Distilled-doc invariant #5: the seal port (2024) is INTENTIONALLY
// shared across stacks. Traefik dispatches by Host: header from the
// well-known `seal-key-server` entrypoint. No host-port publish —
// two stacks of the same app coexist on the same well-known port.
//
// The substrate's router (architecture §4) mints the hostname from
// `(app, stack, dispatch-id)`. We provide:
//
//   - `endpointName`  — the well-known string `'seal-key-server'`.
//   - `dispatchId`    — `{serviceKey: 'seal:<name>', role: 'key-server'}`.
//                        The service key folds the seal instance
//                        name so multi-instance stacks (distilled-doc
//                        Open Question #7) don't collide.
//   - `upstream`      — container kind; the substrate resolves the
//                        container name from the lifecycle row.
//   - `cors: true`    — the @mysten/seal SDK's fetch calls require
//                        CORS allowance (distilled doc: localnet
//                        SDK browser flow).
//
// Distilled-doc invariant #1: the URL the router publishes for this
// routable decl MUST equal the URL we register on chain. The
// plugin's acquire body reads the router's published URL ONCE
// and threads the same value into the Move register call.

import type { DispatchId, EntrypointDecl, RoutableDecl } from '../../contracts/routable.ts';

/** Well-known endpoint name for the seal key-server. Conventional
 *  router entrypoint `'seal-key-server'` on port 2024. */
export const SEAL_KEY_SERVER_ENDPOINT_NAME = 'seal-key-server' as const;
export const SEAL_KEY_SERVER_ROUTE_ROLE = 'key-server' as const;
export const DEFAULT_KEY_SERVER_PORT = 2024 as const;

export const SEAL_ENTRYPOINTS: ReadonlyArray<EntrypointDecl> = [
	{ name: SEAL_KEY_SERVER_ENDPOINT_NAME, port: DEFAULT_KEY_SERVER_PORT, protocol: 'http' },
];

const DEFAULT_STACK = 'main';

const normalizeRouteSegment = (raw: string): string => raw.toLowerCase().replace(/\./g, '-');

/** Build the DispatchId for a seal instance. The service key
 *  encodes the instance name so multi-instance seal in the same
 *  stack mints distinct dispatch files.
 *
 *  Note: distilled-doc Open Question #7 — multi-instance seal is
 *  structurally supported but untested. The two routable decls
 *  would both claim the `'seal-key-server'` entrypoint and the
 *  same `key-server.<stack>.<app>.localhost` hostname. Until v2
 *  plans canonicalize multi-instance routing, treat one-seal-per-stack
 *  as the safe default. */
export const buildSealDispatchId = (name: string): DispatchId => ({
	serviceKey: `seal:${name}`,
	role: SEAL_KEY_SERVER_ROUTE_ROLE,
});

export const buildSealKeyServerPublicRoute = (inputs: {
	readonly app: string;
	readonly stack: string;
	readonly port: number;
}): { readonly hostname: string; readonly url: string } => {
	const role = normalizeRouteSegment(SEAL_KEY_SERVER_ROUTE_ROLE);
	const app = normalizeRouteSegment(inputs.app);
	const stack = normalizeRouteSegment(inputs.stack);
	const hostname =
		stack === DEFAULT_STACK ? `${role}.${app}.localhost` : `${role}.${stack}.${app}.localhost`;
	return {
		hostname,
		url: `http://${hostname}:${inputs.port}`,
	};
};

/** Build the Routable contribution. The substrate's router
 *  orchestrator consumes this; the actual hostname / URL minting
 *  happens there (architecture: routes-by-key, no hardcoded
 *  service hostnames in router code). */
export const makeSealRoutable = (inputs: {
	readonly name: string;
	readonly containerName: string;
}): RoutableDecl => ({
	kind: 'routable',
	endpointName: SEAL_KEY_SERVER_ENDPOINT_NAME,
	dispatchId: buildSealDispatchId(inputs.name),
	upstream: {
		type: 'container',
		containerName: inputs.containerName,
		containerPort: DEFAULT_KEY_SERVER_PORT,
	},
	cors: true,
	wireProtocol: 'http',
});
