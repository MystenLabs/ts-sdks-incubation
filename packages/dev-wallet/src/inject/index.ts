// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Page-register entry for the devstack dev wallet.
//
// This is the single function the devstack Vite plugin injects into a dev
// page. It constructs a `DevWallet` backed by the token-based
// `DevstackSignerAdapter` (headless — signs over HTTP, no popup), registers
// it on the page via wallet-standard (so dApp Kit auto-discovers it),
// mounts the floating wallet UI, and wires the
// `globalThis.__devstackDAppKit__.selectAccount(name)` slot the Playwright
// `connectAs` helper drives.
//
// Account selection rides the wallet-standard protocol — see
// `DevWallet.setSelectedAccount`. The slot resolves a friendly account
// NAME (`alice`) to its address via the generated `accounts` map, then
// makes it dApp Kit's ACTIVE account by briefly narrowing the wallet's
// exposed accounts to it (so dApp Kit's `change`-handler reconciliation
// switches to it) and then WIDENING back to the full set (so the dApp
// keeps seeing all accounts — alice / bob / carol — while the requested
// one stays active). No reference to the app's dApp Kit instance is
// needed. See `selectAccount` below for the two-phase detail.

import type { AutoApprovePolicy } from '../wallet/dev-wallet.js';
import { DevWallet } from '../wallet/dev-wallet.js';
import { DevstackSignerAdapter } from '../adapters/devstack-adapter.js';

/** dApp Kit's default localStorage key for its "selected wallet + address"
 *  (mirrored from `@mysten/dapp-kit-core`'s `DEFAULT_STORAGE_KEY` — kept as
 *  a literal to avoid a dependency on dapp-kit from dev-wallet). */
const DAPP_KIT_STORAGE_KEY = 'mysten-dapp-kit:selected-wallet-and-address';

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
	/** Chain id the wallet's network maps to (e.g. `'sui:local'` from
	 *  `devWallet.chain`). The network name is derived from it
	 *  (`sui:local` → `local`); defaults to `localnet`. */
	readonly chain?: string;
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
}

/**
 * Construct + register the devstack dev wallet on the current page and wire
 * the Playwright `connectAs` slot. Idempotent: a second call is a no-op and
 * returns the existing instance.
 */
export async function registerDevstackDevWallet(
	config: RegisterDevstackDevWalletConfig,
): Promise<RegisterDevstackDevWalletResult> {
	const existing = (globalThis as { __devstackDevWallet__?: RegisterDevstackDevWalletResult })
		.__devstackDevWallet__;
	if (existing !== undefined) return existing;

	const { mountUI = true, autoApprove = false } = config;
	const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

	// Resolve friendly name → address up-front (sync — no I/O) so the
	// `connectAs` slot can be wired BEFORE the async adapter init below.
	const addressByName: Record<string, string> = {};
	for (const [name, info] of Object.entries(config.accounts)) {
		addressByName[name] = info.address;
	}

	// The slot (`__devstackDAppKit__.selectAccount`) and the
	// `__DEV_WALLET_INJECTED__` marker are published SYNCHRONOUSLY, before we
	// await adapter init / wallet registration. The app's dev-only
	// "Open as …" buttons (and the Playwright `connectAs` helper) can fire
	// the instant the page renders — earlier than the wallet finishes coming
	// up. Wiring the slot eagerly (with `selectAccount` awaiting an internal
	// `ready` deferred) means such an early call WAITS for the wallet instead
	// of hitting an `undefined` slot and silently no-op-ing (which left the
	// app's first signing call with "No wallet is connected.").
	let resolveReady!: (handles: {
		wallet: DevWallet;
		seedConnection: (address: string) => void;
	}) => void;
	const ready = new Promise<{ wallet: DevWallet; seedConnection: (address: string) => void }>(
		(resolve) => {
			resolveReady = resolve;
		},
	);

	const selectAccount = async (accountName: string): Promise<void> => {
		const address = addressByName[accountName];
		if (address === undefined) {
			throw new Error(
				`Unknown devstack account "${accountName}". Available: ${
					Object.keys(addressByName).join(', ') || '(none)'
				}`,
			);
		}
		// Wait for the wallet to finish coming up (adapter init + register)
		// before driving selection — see the eager-slot rationale above.
		const { wallet, seedConnection } = await ready;
		// Make `address` dApp Kit's ACTIVE account WITHOUT permanently hiding
		// the wallet's other accounts (the dApp lists all of them — alice /
		// bob / carol). We exploit dApp Kit's `change`-handler reconciliation
		// (`manageWalletConnection` → `resolveWalletAccount`): when the
		// currently-connected account is no longer in `wallet.accounts`, dApp
		// Kit falls back to `wallet.accounts[0]`; when it IS present, dApp Kit
		// keeps it.
		//
		// So we drive selection in two phases, with NO reference to the app's
		// dApp Kit instance (selection rides wallet-standard):
		//
		//   1. NARROW to `[address]` + emit `change`. Whatever was active is
		//      now gone, so dApp Kit resolves to `accounts[0]` — which is the
		//      requested account (the only exposed one). Active = requested.
		//   2. WIDEN back to ALL accounts + emit `change`. The active account
		//      (requested) is still present, so dApp Kit's resolver matches it
		//      (`uiWalletAccountsAreSame`, address + same wallet) and KEEPS it.
		//      Exposed = all; active = requested.
		//
		// Race: dApp Kit's storage-driven auto-connect runs async on mount, so
		// a `connectAs(...)` immediately after page load can fire before it
		// settles. We seed storage to the requested account (so a fresh-page
		// auto-connect lands there directly) and re-emit the NARROW change on a
		// short bounded cadence; whichever narrow emit lands AFTER auto-connect
		// finishes pins the active account to the requested one. We WIDEN only
		// once, after the cadence, so the dApp ends with the full list visible.
		// The loop caps at ~3s (within the e2e's 30s action timeout);
		// re-emitting is idempotent.
		seedConnection(address);
		wallet.setSelectedAccount(address);
		for (let i = 0; i < 20; i++) {
			await sleep(150);
			wallet.setSelectedAccount(address);
		}
		// Restore the full exposed account set; the requested account stays
		// active (see phase 2 above).
		wallet.setSelectedAccount(null);
	};

	// Publish the slot SYNCHRONOUSLY, exposing the `connectAs` entry point
	// (`selectAccount`) that the Playwright helper drives. App UIs that
	// render a labelled account picker read the connected wallet's account
	// list straight from dApp Kit (`useCurrentWallet().accounts`, each
	// account's `label` = the devstack account name) — the slot no longer
	// re-publishes that directory.
	(
		globalThis as {
			__devstackDAppKit__?: {
				selectAccount?: typeof selectAccount;
			};
		}
	).__devstackDAppKit__ = { selectAccount };
	globalThis.__DEV_WALLET_INJECTED__ = true;

	const adapter = new DevstackSignerAdapter({
		serverOrigin: config.serverOrigin,
		token: config.token ?? null,
		name: config.name ?? 'Devstack',
	});
	await adapter.initialize();

	// The wallet EXECUTES (and simulates) `signAndExecuteTransaction` with
	// its OWN client — adapter signing is HTTP (server-side keys), but
	// execution goes through the wallet's network client. That client MUST
	// hit the same routed RPC the app's dApp Kit uses (a raw 127.0.0.1 RPC
	// is CORS-blocked from the routed page origin). dApp Kit forwards a
	// `sui:<appNetwork>` chain whose network name we can't know generically,
	// so we point EVERY standard Sui network (plus the chain-derived name)
	// at the one routed RPC — whatever chain arrives resolves to it. (The
	// old per-app initializer delegated to dApp Kit's `getClient`.)
	const rpcUrl = config.rpcUrl ?? 'http://127.0.0.1:9000';
	const chainNetwork = config.chain?.split(':')[1];
	const networks: Record<string, string> = {
		devnet: rpcUrl,
		testnet: rpcUrl,
		localnet: rpcUrl,
		mainnet: rpcUrl,
	};
	if (chainNetwork !== undefined) networks[chainNetwork] = rpcUrl;

	const wallet = new DevWallet({
		adapters: [adapter],
		name: config.name ?? 'Devstack',
		autoApprove,
		networks,
		activeNetwork: chainNetwork ?? 'localnet',
	});

	let unmountUI: (() => void) | undefined;
	if (mountUI && typeof document !== 'undefined') {
		const { mountDevWallet } = await import('../ui/mount.js');
		unmountUI = mountDevWallet(wallet);
	}

	const unregister = wallet.register();

	// Pre-seed dApp Kit's "selected wallet + address" storage so its
	// storage-driven auto-connect (`autoConnect: true`) connects to the dev
	// wallet on page load WITHOUT a manual "Connect Wallet" click — a fresh
	// page has no prior authorization otherwise. dApp Kit keys the wallet by
	// `wallet.id ?? wallet.name`; DevWallet has no `id`, so it's the name.
	// Value format mirrors dApp Kit's `saveAccountToStorage`:
	// `${walletId.replace(':','_')}:${address}:${intents}`.
	const walletId = (wallet.name ?? 'Devstack').replace(/:/g, '_');
	const seedConnection = (address: string): void => {
		if (typeof localStorage === 'undefined') return;
		try {
			localStorage.setItem(DAPP_KIT_STORAGE_KEY, `${walletId}:${address}:`);
		} catch {
			// localStorage unavailable (private mode / SSR) — selectAccount
			// still narrows + emits change; only first-load auto-connect is lost.
		}
	};

	const firstAddress = Object.values(addressByName)[0];
	if (firstAddress !== undefined) seedConnection(firstAddress);

	// Unblock any `selectAccount` calls that arrived before the wallet was
	// ready (see the eager-slot wiring near the top of this function).
	resolveReady({ wallet, seedConnection });

	const result: RegisterDevstackDevWalletResult = {
		wallet,
		dispose() {
			unmountUI?.();
			unregister();
			wallet.destroy();
			globalThis.__DEV_WALLET_INJECTED__ = false;
			delete (globalThis as { __devstackDevWallet__?: unknown }).__devstackDevWallet__;
		},
	};
	(
		globalThis as { __devstackDevWallet__?: RegisterDevstackDevWalletResult }
	).__devstackDevWallet__ = result;
	return result;
}
