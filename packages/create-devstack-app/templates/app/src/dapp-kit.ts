// User-owned dapp-kit wiring (prod-safe).
//
// The browser RPC + active network come from the generated runtime config
// (`@generated/config.js`) — safe in every build. The dev wallet is not
// wired here: in DEV the devstack Vite plugin injects the dev wallet on the
// page (dApp Kit auto-discovers it via wallet-standard); in production the
// page carries no dev wallet and standard wallets register themselves.

import { createDAppKit } from '@mysten/dapp-kit-react';
import { registerDAppKitForTesting } from '@mysten-incubation/devstack/dapp-kit';
import { SuiGrpcClient } from '@mysten/sui/grpc';

import { config } from '@generated/config.js';

// Injected by the devstack Vite plugin (`true` iff `DEVSTACK_E2E` is set).
// `undefined` in a normal prod build — used to gate e2e-only auto-connect.
declare const __DEVSTACK_E2E__: boolean | undefined;

export const dAppKit = createDAppKit({
	// The full network set the app supports comes from the generated runtime
	// config (`NETWORK_NAMES` — local plus any committed `deployments/*.ts`),
	// so dApp Kit's `switchNetwork` / `defaultNetwork` are type-checked against
	// the literal network union. Spread into a mutable copy: `networkNames` is
	// the `as const` readonly tuple, and dApp Kit's `networks` wants a mutable
	// array; the spread preserves the literal element union (no widening to
	// `string`).
	networks: [...config.networkNames],
	defaultNetwork: config.defaultNetwork,
	autoConnect: __DEVSTACK_E2E__ === true,
	// `createClient` is called per network dApp Kit manages, with the network it
	// is building a client for — so EVERYTHING flows through dApp Kit's selected
	// network and stays in sync across a runtime `switchNetwork`. The connection
	// is resolved off the loaded deployment (injected via `__DEVSTACK_IDS__`, not
	// baked into the committed tree); `config.forNetwork(network)` returns that
	// network's resolved entry — a non-undefined type that throws if the
	// network isn't in the deployment.
	createClient(network) {
		const net = config.forNetwork(network);
		return new SuiGrpcClient({
			network,
			baseUrl: net.rpc,
			// `net.mvrOverrides` is THAT network's name→id map: each generated
			// Move binding defaults its `package` to `@local/<name>`, and this
			// map points that name at the deployed id so no real MVR registry is
			// hit. App code resolves packages by name and never touches
			// `config.packages.*.packageId`.
			mvr: { overrides: net.mvrOverrides },
		});
	},
});

// Register this dApp Kit instance with the devstack test bridge so the
// Playwright `connectAs` helper can drive a real connection during e2e.
// DEV-only: a production build strips this branch and never injects the dev
// wallet, so the app ships with no test surface.
if (import.meta.env.DEV) {
	registerDAppKitForTesting(dAppKit);
}

declare module '@mysten/dapp-kit-react' {
	interface Register {
		dAppKit: typeof dAppKit;
	}
}
