// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { WalletLayer } from './core/types.js';
import { createAppKitWallets } from './wallets/appkit.js';
import type { AppKitWalletOptions } from './wallets/appkit.js';

export { createAppKitWallets } from './wallets/appkit.js';
export type { AppKitWalletOptions } from './wallets/appkit.js';

/**
 * The ready-made EVM and Solana wallet layer, built on Reown AppKit:
 *
 *     createCctpKit({ dAppKit, wallets: { layer: appKitWallets({ projectId }) } });
 *
 * It is its own entry point because it is the only part of the kit that needs the Reown
 * packages. A host that passes its own adapters never imports this, so its bundler never has to
 * resolve them. AppKit itself is still loaded lazily, the first time a non-Sui wallet is needed.
 */
export function appKitWallets(options: AppKitWalletOptions = {}): WalletLayer {
	return ({ network, chains }) => createAppKitWallets({ network, chains, ...options });
}
