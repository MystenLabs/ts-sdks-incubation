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
	// The switcher offers ONLY the networks actually present in the injected
	// deployment envelope (`config.networks`), not the static `networkNames`
	// superset (local + every committed `deployments/*.ts`). A prod build drops
	// local networks from the envelope, so the static list would let the user
	// select a network absent from `config.networks` — `config.forNetwork` (in
	// `createClient` below) then throws `DevstackConfigMissingError`. Filtering
	// the static tuple by envelope membership keeps the list and the resolvable
	// set in lockstep while PRESERVING the literal element union (so dApp Kit's
	// `switchNetwork` / `defaultNetwork` stay type-checked — `Object.keys` would
	// widen to `string`). `defaultNetwork` is the envelope's own default, so it
	// is always a member of `config.networks` and survives the filter.
	networks: [...config.networkNames].filter((n) => config.networks[n] !== undefined),
	defaultNetwork: config.defaultNetwork,
	autoConnect: __DEVSTACK_E2E__ === true,
	// `createClient` is called per network dApp Kit manages, with the network it
	// is building a client for — so EVERYTHING flows through dApp Kit's selected
	// network and stays in sync across a runtime `switchNetwork`. The connection
	// is runtime-resolved off the loaded deployment (injected via
	// `__DEVSTACK_DEPLOYMENT__`, never baked into the committed tree);
	// `config.forNetwork(network)` returns the network's resolved entry with a
	// non-undefined type and throws if the network isn't in the deployment.
	createClient(network) {
		const net = config.forNetwork(network);
		return new SuiGrpcClient({
			network,
			baseUrl: net.rpc,
			// `net.mvrOverrides` is THAT network's name→id map: each generated
			// Move binding defaults its `package` to the `@local/<name>` MVR
			// name (e.g. `@local/demo-coins`), and this map resolves it to the
			// published id — so every binding call resolves without app code
			// ever string-concatenating a package id.
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
