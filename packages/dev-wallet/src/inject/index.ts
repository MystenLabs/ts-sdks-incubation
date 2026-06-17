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

/** Shape of a single entry in the generated `accounts` map
 *  (`generated-extras/accounts.ts`). Only `address` is consumed here. */
export interface DevstackAccountInfo {
	readonly address: string;
	readonly name?: string;
}

export interface RegisterDevstackDevWalletConfig {
	/** Wallet-app origin (`devWallet.walletUrl`). */
	readonly serverOrigin: string;
	/** Bearer token (`parseDevstackToken(devWallet.pairUrl)`), or null. */
	readonly token?: string | null;
	/** Generated name→account map (`accounts` from `generated-extras/accounts.ts`). */
	readonly accounts: Readonly<Record<string, DevstackAccountInfo>>;
	/** RPC endpoint the wallet uses to execute `signAndExecuteTransaction`
	 *  (and simulate). MUST be the SAME routed RPC the app's dApp Kit client
	 *  uses (`config.networks[config.network].rpc`) — a raw `127.0.0.1:9000`
	 *  is CORS-blocked from the routed page origin. When omitted the wallet
	 *  falls back to localnet defaults (only correct for non-routed setups). */
	readonly rpcUrl?: string;
	/** Network name the wallet's accounts are scoped to (e.g. `'localnet'`
	 *  from `devWallet.network`). The wallet advertises the wallet-standard
	 *  chain `sui:<network>` derived from it; defaults to `localnet`. */
	readonly network?: string;
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

	const adapter = new DevstackSignerAdapter({
		serverOrigin: config.serverOrigin,
		token: config.token ?? null,
		name: config.name ?? 'Devstack',
	});

	// The wallet EXECUTES (and simulates) `signAndExecuteTransaction` with
	// its OWN client — adapter signing is HTTP (server-side keys), but
	// execution goes through the wallet's network client. That client MUST
	// hit the same routed RPC the app's dApp Kit uses (a raw 127.0.0.1 RPC
	// is CORS-blocked from the routed page origin).
	//
	// Expose a SINGLE network — the active stack's — so the wallet's network
	// switcher shows one entry that matches dApp Kit, not a list of unused
	// devnet/testnet/mainnet. `mountAndRegisterDevWallet` advertises the
	// wallet-standard chain `sui:<network>` derived from this key, matching the
	// `sui:<network>` dApp Kit forwards for signing — the `sui:` prefix lives
	// only here, at the wallet-standard boundary.
	const rpcUrl = config.rpcUrl ?? 'http://127.0.0.1:9000';
	const activeNetwork = config.network ?? 'localnet';
	const networks: Record<string, string> = { [activeNetwork]: rpcUrl };

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
