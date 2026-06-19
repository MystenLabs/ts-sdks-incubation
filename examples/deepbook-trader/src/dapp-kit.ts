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

const deepbookNetwork = 'localnet' as const;

export const dAppKit = createDAppKit({
	networks: [deepbookNetwork],
	defaultNetwork: deepbookNetwork,
	autoConnect: import.meta.env.DEV,
	// `createClient` is called per network dApp Kit manages, with the network it
	// is building a client for — so EVERYTHING flows through dApp Kit's selected
	// network and stays in sync across a runtime `switchNetwork`. The connection
	// is runtime-resolved off the loaded deployment (injected via
	// `__DEVSTACK_IDS__`, never baked into the committed tree);
	// `config.forNetwork(network)` returns the network's resolved entry with a
	// non-undefined type and fails loudly if absent — no
	// `config.networks[config.network]` index-signature footgun.
	createClient(network) {
		const deployment = config.forNetwork(network);
		return new SuiGrpcClient({
			network,
			baseUrl: deployment.rpc,
			// `config.mvrOverrides` is the codegen-emitted active-network
			// name→id map: each generated Move binding defaults its `package`
			// to the `@local/<name>` MVR name (e.g. `@local/demo-coins`), and
			// this map resolves it to the published id — so every binding call
			// resolves without app code ever string-concatenating a package id.
			mvr: { overrides: { packages: config.mvrOverrides } },
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
