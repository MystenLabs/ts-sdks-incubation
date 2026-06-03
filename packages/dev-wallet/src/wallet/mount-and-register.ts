// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { DevWalletDockStyle } from '../ui/dev-wallet-panel.js';
import { DevWallet, type DevWalletConfig } from './dev-wallet.js';

export interface MountAndRegisterDevWalletOptions extends DevWalletConfig {
	/** Call `adapter.initialize()` on every adapter before registering. Defaults to true. */
	autoInitialize?: boolean;
	/**
	 * Create an initial account after initialization when no adapter has any
	 * accounts (uses the first adapter that supports `createAccount`). Defaults
	 * to false — most managed/remote adapters (devstack, CLI) bring their own
	 * accounts and must NOT have a throwaway one fabricated.
	 */
	createInitialAccount?: boolean;
	/** Mount the floating wallet drawer UI (no-op when `document` is undefined). Defaults to true. */
	mountUI?: boolean;
	/** Floating dock presentation when `mountUI` is true. */
	dockStyle?: DevWalletDockStyle;
	/** Container element for the UI drawer. Defaults to `document.body`. */
	container?: HTMLElement;
	/** Called with the `DevWallet` once constructed, before the UI is mounted
	 *  and the wallet is registered. */
	onWalletCreated?: (wallet: DevWallet) => void;
}

export interface MountAndRegisterDevWalletResult {
	readonly wallet: DevWallet;
	/** Unmount the UI, unregister from wallet-standard, and destroy the wallet (+ adapters). */
	readonly dispose: () => void;
}

/**
 * Construct a {@link DevWallet} from adapters, initialize the adapters, mount
 * the drawer UI, register it with the wallet-standard registry, and return the
 * wallet plus a single `dispose()` that tears all of that down again.
 *
 * This is the imperative "bring a dev wallet up on the page" path shared by the
 * React hook (`useDevWallet`), the dApp-Kit initializer (`devWalletInitializer`),
 * and the devstack page-register entry (`src/inject`). Those call sites only
 * differ in HOW they obtain `adapters` / `networks` — the construct → init →
 * mount → register → dispose sequence is identical, so it lives here once.
 */
export async function mountAndRegisterDevWallet(
	options: MountAndRegisterDevWalletOptions,
): Promise<MountAndRegisterDevWalletResult> {
	const {
		autoInitialize = true,
		createInitialAccount = false,
		mountUI = true,
		dockStyle,
		container,
		onWalletCreated,
		...walletConfig
	} = options;

	if (autoInitialize) {
		await Promise.all(walletConfig.adapters.map((a) => a.initialize()));
	}

	if (createInitialAccount) {
		const hasAccounts = walletConfig.adapters.some((a) => a.getAccounts().length > 0);
		if (!hasAccounts) {
			const creatableAdapter = walletConfig.adapters.find(
				(a) => a.createAccount && a.getAccounts().length === 0,
			);
			if (creatableAdapter?.createAccount) {
				await creatableAdapter.createAccount({ label: 'Dev Account' });
			}
		}
	}

	const wallet = new DevWallet(walletConfig);
	onWalletCreated?.(wallet);

	let unmountUI: (() => void) | undefined;
	if (mountUI && typeof document !== 'undefined') {
		const { mountDevWallet } = await import('../ui/mount.js');
		unmountUI = mountDevWallet(wallet, { container, dockStyle });
	}

	const unregister = wallet.register();

	return {
		wallet,
		dispose() {
			unmountUI?.();
			unregister();
			wallet.destroy();
		},
	};
}
