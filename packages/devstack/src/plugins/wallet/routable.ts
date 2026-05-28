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

// ----------------------------------------------------------------------
// Endpoint name constant
// ----------------------------------------------------------------------

/** Canonical endpoint name. The router orchestrator surfaces this in
 *  the manifest under `endpoints['wallet-app']`; downstream consumers
 *  (codegen, TUI, doctor) read it by this key.
 *
 *  Stable across rewrite + legacy so existing consumers don't break. */
export const WALLET_ENDPOINT_NAME = 'wallet-app' as const;

/** Conventional short alias for the wallet endpoint. Build integrations
 *  (Playwright, vitest helpers) and the conventional-routes alias table
 *  look the endpoint up under this name; the substrate's alias resolver
 *  folds `'wallet'` → `WALLET_ENDPOINT_NAME` (`'wallet-app'`) before
 *  consulting the manifest.
 *
 *  Owned here because the alias is a wallet-plugin convention — adding
 *  it next to the canonical name keeps both in lockstep when the
 *  plugin's HTTP server is renamed. The L5 bridge in
 *  `build-integrations/runtime/wallet-paths.ts` re-exports this for
 *  layer-discipline reasons; the conventional-routes table in
 *  `build-integrations/runtime/conventional-routes.ts` consumes the
 *  same constant so there is exactly one source of truth. */
export const WALLET_ENDPOINT_ALIAS = 'wallet' as const;

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
