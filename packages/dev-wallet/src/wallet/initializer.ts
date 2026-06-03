// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ClientWithCoreApi } from '@mysten/sui/client';
import type { WalletIcon } from '@mysten/wallet-standard';

import type { DevWalletDockStyle } from '../ui/dev-wallet-panel.js';
import type { SignerAdapter } from '../types.js';
import type { DevWallet, AutoApprovePolicy } from './dev-wallet.js';
import { mountAndRegisterDevWallet } from './mount-and-register.js';

/**
 * Configuration for the dev wallet initializer.
 * Unlike {@link DevWalletConfig}, `networks` and `clientFactory` are omitted — they come
 * from the dApp Kit context at initialization time.
 */
export interface DevWalletInitializerConfig {
	adapters: SignerAdapter[];
	name?: string;
	icon?: WalletIcon;
	autoApprove?: AutoApprovePolicy;
	autoConnect?: boolean;
	/** Call `adapter.initialize()` automatically. Defaults to true. */
	autoInitialize?: boolean;
	/** Create an initial account after initialization if no accounts exist. Defaults to true. */
	createInitialAccount?: boolean;
	/** Mount the floating wallet drawer UI. Defaults to false. */
	mountUI?: boolean;
	/** Floating dock presentation when `mountUI` is true. Defaults to `corner-pill`. */
	dockStyle?: DevWalletDockStyle;
	/** Container element for the UI drawer. Defaults to document.body. */
	container?: HTMLElement;
	/** Called with the DevWallet instance after creation. */
	onWalletCreated?: (wallet: DevWallet) => void;
}

/**
 * Creates a wallet initializer for `createDAppKit({ walletInitializers: [...] })`.
 * The wallet uses dApp Kit's networks and client factory and is unregistered when dApp Kit tears down.
 *
 * @example
 * ```ts
 * import { createDAppKit } from '@mysten/dapp-kit-react';
 * import { devWalletInitializer } from '@mysten-incubation/dev-wallet';
 * import { WebCryptoSignerAdapter } from '@mysten-incubation/dev-wallet/adapters';
 *
 * const dAppKit = createDAppKit({
 *   networks: ['devnet', 'testnet'],
 *   createClient(network) { ... },
 *   walletInitializers: [
 *     devWalletInitializer({
 *       adapters: [new WebCryptoSignerAdapter()],
 *       autoConnect: true,
 *       mountUI: true,
 *     }),
 *   ],
 * });
 * ```
 */
export function devWalletInitializer(config: DevWalletInitializerConfig): {
	id: string;
	initialize(input: {
		networks: readonly string[];
		getClient: (network?: string) => ClientWithCoreApi;
	}): Promise<{ unregister: () => void }>;
} {
	return {
		id: 'dev-wallet-initializer',
		async initialize({ networks, getClient }) {
			// Map dApp Kit networks to DevWallet format.
			// DevWallet needs a Record<string, string> of network name → URL, but
			// the clientFactory we provide delegates to getClient, so the URLs are
			// never actually used. We use placeholder values.
			const networkUrls: Record<string, string> = {};
			for (const network of networks) {
				networkUrls[network] = `dapp-kit://${network}`;
			}

			// Delegate the construct → init-adapter → mount-UI → register → dispose
			// sequence to the shared core helper; this initializer only supplies the
			// dApp-Kit-sourced networks + client factory and the `onWalletCreated`
			// hook. `createInitialAccount`/`autoInitialize` default to TRUE here (the
			// initializer's historical behavior — its adapters start empty); `mountUI`
			// defaults to FALSE (dApp Kit typically renders its own connect UI).
			const { dispose } = await mountAndRegisterDevWallet({
				adapters: config.adapters,
				networks: networkUrls,
				name: config.name,
				icon: config.icon,
				autoApprove: config.autoApprove,
				autoConnect: config.autoConnect,
				clientFactory: (network) => getClient(network),
				autoInitialize: config.autoInitialize ?? true,
				createInitialAccount: config.createInitialAccount ?? true,
				mountUI: config.mountUI ?? false,
				dockStyle: config.dockStyle,
				container: config.container,
				onWalletCreated: config.onWalletCreated,
			});

			return { unregister: dispose };
		},
	};
}
