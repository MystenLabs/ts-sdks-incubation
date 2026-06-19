// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Page-register entry for the devstack dev wallet.
//
// This is the single function the devstack Vite plugin injects into a dev
// page. It builds the token-based `DevstackSignerAdapter` (headless — signs
// over HTTP, no popup) + the routed-RPC network map, then hands those to the
// shared `mountAndRegisterDevWallet` core helper, which constructs the
// `DevWallet`, registers it via wallet-standard (so dApp Kit auto-discovers
// it), and mounts the floating wallet UI. The ONLY logic that lives here is
// the devstack-integration glue: the adapter-from-config and the routed-RPC
// network map.
//
// The wallet does NOT pre-connect or seed dApp Kit storage: a fresh page
// loads disconnected, dApp Kit's own `autoConnect` only re-connects a genuine
// prior session, and the Playwright `connectAs` helper performs an explicit
// connection through dApp Kit's public API. That test bridge is registered
// app-side via `@mysten-incubation/devstack/dapp-kit`'s
// `registerDAppKitForTesting(dAppKit)` (DEV-only) — it needs the app's dApp
// Kit instance, which the wallet has no reference to.

import type { SignerAdapter } from '../types.js';
import type { AutoApprovePolicy, DevWallet } from '../wallet/dev-wallet.js';
import { mountAndRegisterDevWallet } from '../wallet/mount-and-register.js';
import { DevstackSignerAdapter } from '../adapters/devstack-adapter.js';

/** Shape of a single entry in the dev `accounts` map (resolved off the
 *  injected deployment envelope via `resolveAccounts()`). Only `address` is
 *  consumed here. */
export interface DevstackAccountInfo {
	readonly address: string;
	readonly name?: string;
}

/** One network the dev wallet operates on — its routed RPC endpoint plus an
 *  optional faucet. The wallet advertises every key as the wallet-standard
 *  chain `sui:<name>` and routes signing/execution to whichever network dApp
 *  Kit has selected; the active network's `faucet` drives a fund flow. The
 *  `rpc` MUST be the SAME routed RPC the app's dApp Kit client uses for that
 *  network (a raw `127.0.0.1:9000` is CORS-blocked from the routed page
 *  origin). The wallet is agnostic to live-vs-local — local and live networks
 *  are passed through the same map. */
export interface DevstackNetworkInfo {
	/** Routed RPC endpoint for this network. */
	readonly rpc: string;
	/** Optional faucet endpoint for this network (absent on live mainnet /
	 *  fork stacks). */
	readonly faucet?: string | null;
}

export interface RegisterDevstackDevWalletConfig {
	/** Wallet-app origin (the dev-wallet connection's `walletUrl`). */
	readonly serverOrigin: string;
	/** Bearer pairing token (read by the Vite dev server from the wallet's
	 *  `0o600` side-channel token file), or null. */
	readonly token?: string | null;
	/** Dev name→account map (resolved off the injected deployment envelope via
	 *  `resolveAccounts()`). */
	readonly accounts: Readonly<Record<string, DevstackAccountInfo>>;
	/** The FULL network set the app supports — `{ <name>: { rpc, faucet? } }`,
	 *  covering BOTH the live local network and any live (devnet/testnet/…)
	 *  networks the deployment envelope carries. The wallet advertises each as
	 *  the wallet-standard chain `sui:<name>` and operates on whichever one
	 *  dApp Kit has selected, so it persists across a UI `switchNetwork` (only
	 *  the active chain changes — the wallet is registered once). When omitted
	 *  the wallet falls back to a single localnet entry (the non-routed default
	 *  — only correct for a bare localnet setup). */
	readonly networks?: Readonly<Record<string, DevstackNetworkInfo>>;
	/** The network the wallet opens on (its initial active network). Must be a
	 *  key of `networks`; defaults to the first `networks` key (`'localnet'`
	 *  when `networks` is omitted). */
	readonly defaultNetwork?: string;
	/** Auto-approve all signing requests (headless e2e). Defaults to false. */
	readonly autoApprove?: AutoApprovePolicy;
	/** Mount the floating wallet drawer UI. Defaults to true. */
	readonly mountUI?: boolean;
	/** Wallet display name. Defaults to `'Devstack'`. */
	readonly name?: string;
}

export interface RegisterDevstackDevWalletResult {
	readonly wallet: DevWallet;
	/** Unregister the wallet, unmount the UI, and tear down the adapter. */
	readonly dispose: () => void;
}

/** Global marker so tests / the plugin can assert injection happened. */
declare global {
	// eslint-disable-next-line no-var
	var __DEV_WALLET_INJECTED__: boolean | undefined;
	/** In-flight (or settled) registration promise. Published BEFORE the first
	 *  `await` so concurrent evaluations (HMR / double import) coalesce onto a
	 *  single registration instead of each constructing + registering + mounting
	 *  their own wallet. See `registerDevstackDevWallet`. */
	// eslint-disable-next-line no-var
	var __devstackDevWalletPromise__: Promise<RegisterDevstackDevWalletResult> | undefined;
}

/**
 * Construct + register the devstack dev wallet on the current page and wire
 * the Playwright `connectAs` slot. Idempotent: a second call is a no-op and
 * returns the existing instance.
 *
 * Idempotency is enforced SYNCHRONOUSLY: an in-flight registration promise is
 * published on `globalThis.__devstackDevWalletPromise__` before the first
 * `await`, so two evaluations that race in before the first one finishes both
 * resolve to the SAME wallet instead of double-registering.
 */
export function registerDevstackDevWallet(
	config: RegisterDevstackDevWalletConfig,
): Promise<RegisterDevstackDevWalletResult> {
	const g = globalThis as {
		__devstackDevWallet__?: RegisterDevstackDevWalletResult;
		__devstackDevWalletPromise__?: Promise<RegisterDevstackDevWalletResult>;
	};
	// Fast path: a prior call already completed.
	if (g.__devstackDevWallet__ !== undefined) return Promise.resolve(g.__devstackDevWallet__);
	// In-flight path: a prior call is still booting — share its promise. This
	// guard runs before any `await`, so it closes the double-init window that a
	// post-registration-only marker leaves open under HMR / double import.
	if (g.__devstackDevWalletPromise__ !== undefined) return g.__devstackDevWalletPromise__;

	const promise = registerDevstackDevWalletImpl(config);
	g.__devstackDevWalletPromise__ = promise;
	// On failure, clear the in-flight promise so a later call can retry instead
	// of being stuck awaiting a rejected registration.
	promise.catch(() => {
		if (g.__devstackDevWalletPromise__ === promise) {
			g.__devstackDevWalletPromise__ = undefined;
		}
	});
	return promise;
}

async function registerDevstackDevWalletImpl(
	config: RegisterDevstackDevWalletConfig,
): Promise<RegisterDevstackDevWalletResult> {
	const { mountUI = true, autoApprove = false } = config;
	globalThis.__DEV_WALLET_INJECTED__ = true;

	// Resolve the FULL network set up front so it can be advertised both on
	// the wallet (its `chains`) and on every devstack account (per-account
	// `chains`) — fork/custom networks must be signable from both surfaces.
	const networkInfos: Readonly<Record<string, DevstackNetworkInfo>> =
		config.networks !== undefined && Object.keys(config.networks).length > 0
			? config.networks
			: { localnet: { rpc: 'http://127.0.0.1:9000' } };
	const networkNames = Object.keys(networkInfos);

	const adapter = new DevstackSignerAdapter({
		serverOrigin: config.serverOrigin,
		token: config.token ?? null,
		name: config.name ?? 'Devstack',
		networks: networkNames,
	});

	// The wallet EXECUTES (and simulates) `signAndExecuteTransaction` with
	// its OWN client — adapter signing is HTTP (server-side keys), but
	// execution goes through the wallet's network client. That client MUST
	// hit the same routed RPC the app's dApp Kit uses (a raw 127.0.0.1 RPC
	// is CORS-blocked from the routed page origin).
	//
	// Expose the FULL network set the app supports (local + any live networks
	// from the deployment envelope) so the wallet operates on whichever
	// network dApp Kit has selected. The wallet is registered ONCE via
	// wallet-standard and advertises each key as the wallet-standard chain
	// `sui:<network>` (matching the `sui:<network>` dApp Kit forwards for
	// signing — the `sui:` prefix lives only at the wallet-standard boundary);
	// a UI `switchNetwork` just changes the active chain, it never
	// re-registers. The wallet does NOT know live-vs-local — both flow through
	// the same map. Omitting `networks` falls back to a single localnet entry
	// (the legacy non-routed default — resolved as `networkInfos` above).
	const networks: Record<string, string> = {};
	const faucets: Record<string, string> = {};
	for (const [net, info] of Object.entries(networkInfos)) {
		networks[net] = info.rpc;
		if (info.faucet !== undefined && info.faucet !== null && info.faucet.length > 0) {
			faucets[net] = info.faucet;
		}
	}
	// The wallet opens on the requested default (the dApp-Kit default network),
	// falling back to the first declared network.
	const activeNetwork =
		config.defaultNetwork !== undefined && networks[config.defaultNetwork] !== undefined
			? config.defaultNetwork
			: (Object.keys(networks)[0] ?? 'localnet');

	// Delegate the construct → init-adapter → mount-UI → register → dispose
	// sequence to the shared dev-wallet core helper. The `DevstackSignerAdapter`
	// brings the stack's server-resolved accounts (alice/bob/carol — headless
	// HTTP signing) and is always present. The optional `WebCryptoSignerAdapter`
	// lets the user create their OWN accounts in the wallet UI, persisted in
	// IndexedDB across reloads (non-extractable WebCrypto keys, NOT in-memory) —
	// but it depends on the OPTIONAL `@mysten/signers` peer. Load it dynamically
	// and gate on its presence: an app that doesn't install `@mysten/signers`
	// still gets a working dev wallet (just without create-your-own-account)
	// instead of a hard inject crash on the unresolved peer. `createInitialAccount`
	// stays off — the devstack adapter already supplies accounts, so we never
	// fabricate a throwaway key; the WebCrypto adapter starts empty until the
	// user adds one.
	const adapters: SignerAdapter[] = [adapter];
	try {
		const { WebCryptoSignerAdapter } = await import('../adapters/webcrypto-adapter.js');
		adapters.push(new WebCryptoSignerAdapter());
	} catch (error) {
		console.info(
			'[dev-wallet] @mysten/signers is not installed — WebCrypto account creation is ' +
				'disabled. Install @mysten/signers to enable creating your own accounts in the ' +
				'dev wallet.',
			error,
		);
	}

	const { wallet, dispose: disposeWallet } = await mountAndRegisterDevWallet({
		adapters,
		name: config.name ?? 'Devstack',
		autoApprove,
		// Auto-approve `standard:connect` whenever signing is auto-approved — both
		// are the headless-e2e signal (`DEVSTACK_AUTO_APPROVE`). The test bridge's
		// explicit `connectWallet(...)` invokes the wallet's connect; without this
		// it would queue a pending request and block on UI approval that never
		// comes. In normal dev (no auto-approve) a human approves the connect.
		autoConnect: Boolean(autoApprove),
		networks,
		faucets,
		activeNetwork,
		mountUI,
	});

	const result: RegisterDevstackDevWalletResult = {
		wallet,
		dispose() {
			disposeWallet();
			globalThis.__DEV_WALLET_INJECTED__ = false;
			delete (globalThis as { __devstackDevWallet__?: unknown }).__devstackDevWallet__;
			// Clear the in-flight/settled registration promise too, so a
			// subsequent `registerDevstackDevWallet` re-initializes rather than
			// handing back the disposed instance.
			delete (globalThis as { __devstackDevWalletPromise__?: unknown })
				.__devstackDevWalletPromise__;
		},
	};
	(
		globalThis as { __devstackDevWallet__?: RegisterDevstackDevWalletResult }
	).__devstackDevWallet__ = result;
	return result;
}
