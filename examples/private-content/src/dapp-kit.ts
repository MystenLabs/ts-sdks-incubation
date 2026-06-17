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
import { resolveActiveNetwork } from '@generated/config-runtime.js';

const devstackNetwork = 'localnet' as const;

/**
 * The MVR-resolved vault package id for the active network. Used by the
 * Seal IBE callsites (`SealClient.encrypt` / `SessionKey.create`) and the
 * Cap-type query string — consumers that are NOT tx moveCalls and so are
 * not resolved by the grpc client's MVR overrides. Sourced from the
 * codegen-emitted `mvrOverrides` (the active-network name→id map) rather
 * than indexing `byNetwork` by the runtime network name (whose key set is
 * the committed-tree literal, not an index signature). `undefined` when the
 * `@local/vault` placeholder is absent from the injected ids.
 */
export const vaultPackageId: string | undefined = config.mvrOverrides['@local/vault'];

// The active network's connection map is runtime-resolved (injected via
// `__DEVSTACK_IDS__`, not baked into the committed tree). `resolveActiveNetwork`
// returns the active entry with a non-undefined type and fails loudly if it is
// missing — no index-signature footgun.
const activeNetwork = resolveActiveNetwork();

export const dAppKit = createDAppKit({
	networks: [devstackNetwork],
	defaultNetwork: devstackNetwork,
	autoConnect: import.meta.env.DEV,
	createClient() {
		return new SuiGrpcClient({
			network: devstackNetwork,
			baseUrl: activeNetwork.rpc,
			// `config.mvrOverrides` is the codegen-emitted active-network
			// name→id map: the vault bindings default `options.package ??
			// '@local/vault'`, and this map resolves that name to the deployed
			// id so the app's Move calls never hard-code a package id.
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
