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
// IMPORTANT: this decl exists ONLY when a vite plugin is enabled on
// the same stack (the task's "Routable contribution: wallet UI URL
// (when the vite plugin is enabled)"). The factory in `index.ts`
// adds it conditionally — see `wallet({ enableRouter: true })`.

import type { EntrypointDecl, RoutableDecl } from '../../contracts/routable.ts';

// ----------------------------------------------------------------------
// Endpoint name constant
// ----------------------------------------------------------------------

/** Canonical endpoint name. The router orchestrator surfaces this in
 *  the manifest under `endpoints['wallet-app']`; downstream consumers
 *  (codegen, TUI, doctor) read it by this key.
 *
 *  Stable across rewrite + legacy so existing consumers don't break. */
export const WALLET_ENDPOINT_NAME = 'wallet-app' as const;
export const WALLET_ROUTE_ROLE = 'api' as const;
export const WALLET_ENTRYPOINT_PORT = 6173;

export const WALLET_ENTRYPOINTS: ReadonlyArray<EntrypointDecl> = [
	{ name: WALLET_ENDPOINT_NAME, port: WALLET_ENTRYPOINT_PORT, protocol: 'http' },
];

// ----------------------------------------------------------------------
// Decl
// ----------------------------------------------------------------------

/** Construct the Routable decl. Plugin emits this only when a vite
 *  plugin is enabled on the same stack — otherwise there's no browser
 *  pairing target and the router edge is wasted. */
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
