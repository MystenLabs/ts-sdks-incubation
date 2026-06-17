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

const devstackNetwork = 'localnet' as const;

// `config.network`/`config.networks` are runtime-resolved (the active
// network name + its connection map are injected via `__DEVSTACK_IDS__`, not
// baked into the committed tree). The map is index-signature typed, so look
// up the active entry once and fail loudly if it is missing rather than
// silently using `undefined`.
const activeNetwork = config.networks[config.network];
if (activeNetwork === undefined) {
	throw new Error(`[devstack] no network entry for "${config.network}"`);
}

export const dAppKit = createDAppKit({
	networks: [devstackNetwork],
	defaultNetwork: devstackNetwork,
	autoConnect: import.meta.env.DEV,
	createClient() {
		return new SuiGrpcClient({
			network: devstackNetwork,
			baseUrl: activeNetwork.rpc,
			// `config.mvrOverrides` is the codegen-emitted active-network
			// name→id map: each generated Move binding defaults its `package`
			// to `@local/<name>` (e.g. `@local/connect-four`), and this map
			// resolves that name to its deployed id. App code consumes the
			// bindings' MVR defaults and never touches `config.packages.*`.
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
