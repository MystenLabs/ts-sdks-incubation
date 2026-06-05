// Wallet plugin — Routable contribution.
//
// The wallet's HTTP server is a HOST PROCESS (not a docker container)
// listening on a loopback port the substrate's port broker hands us.
// The router (Traefik) fronts the loopback port under a stack-scoped
// hostname like `wallet.<app>.localhost:<router-port>`.
//
// This contribution is what tells the router about the upstream. The
// router orchestrator reads the decl, mints the stack-scoped hostname,
// and writes the file-provider YAML without ever naming the wallet
// plugin.
//
// The wallet always emits this decl. The router is the standard app
// and wallet entrypoint, while the loopback URL remains an internal
// fallback for tests and direct host tooling.

import type { EntrypointDecl, RoutableDecl } from '../../contracts/routable.ts';

// The routed-endpoint identity constants live in the name-blind
// contract so L5 build integrations can consume them without importing
// this L2 plugin module; re-exported here so plugin-internal callers
// (and the conventional-routes alias table) keep one source of truth.
export { WALLET_ENDPOINT_NAME, WALLET_ENDPOINT_KEY } from '../../contracts/wallet-protocol.ts';

import { WALLET_ENDPOINT_NAME } from '../../contracts/wallet-protocol.ts';

export const WALLET_ROUTE_ROLE = 'api' as const;
export const WALLET_ENTRYPOINT_PORT = 6173;

export const WALLET_ENTRYPOINTS: ReadonlyArray<EntrypointDecl> = [
	{ name: WALLET_ENDPOINT_NAME, port: WALLET_ENTRYPOINT_PORT, protocol: 'http' },
];

// ----------------------------------------------------------------------
// Decl
// ----------------------------------------------------------------------

/** Construct the Routable decl for the stack-scoped wallet endpoint. */
export const makeWalletRoutable = (parts: {
	readonly app: string;
	readonly stack: string;
	readonly port: number;
}): RoutableDecl => ({
	kind: 'routable',
	endpointName: WALLET_ENDPOINT_NAME,
	dispatchId: {
		// Convention: `<plugin>.<app>.<stack>` keeps dispatch-file
		// listings readable; the router still hashes the full
		// `(app, stack, serviceKey, role)` tuple for uniqueness.
		serviceKey: `wallet.${parts.app}.${parts.stack}`,
		role: WALLET_ROUTE_ROLE,
	},
	upstream: { type: 'host-loopback', port: parts.port },
	cors: true,
	wireProtocol: 'http',
});
