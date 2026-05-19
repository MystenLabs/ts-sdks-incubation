// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ForkRelay } from '../adapters/fork-relay.js';
import type { DevWallet } from '../wallet/dev-wallet.js';
import './dev-wallet-panel.js';
import type { CoinRecord } from './utils.js';

/** @returns A cleanup function that removes the panel from the DOM. */
export function mountDevWallet(
	wallet: DevWallet,
	options?: {
		container?: HTMLElement;
		/** Pre-seeded coin metadata — pass the generated `coins` constant
		 *  from devstack codegen to skip per-coin RPC waterfalls on UI
		 *  load. See `DevWalletPanel.coins`. */
		coins?: CoinRecord | null;
		/** Phase 5 Subtopic 6 — fork admin relay. Construct via
		 *  `createForkRelayFromManifest(manifest)` and pass through;
		 *  the panel surfaces a Fork tab whenever this is non-null and
		 *  the active network ends in `-fork`. */
		forkRelay?: ForkRelay | null;
		/** Upstream label (`'mainnet'`, …) sourced from `meta.upstream`. */
		forkUpstream?: string;
	},
): () => void {
	const container = options?.container ?? document.body;

	const panel = document.createElement('dev-wallet-panel');
	panel.wallet = wallet;
	if (options?.coins !== undefined) panel.coins = options.coins;
	if (options?.forkRelay !== undefined) panel.forkRelay = options.forkRelay;
	if (options?.forkUpstream !== undefined) panel.forkUpstream = options.forkUpstream;
	container.appendChild(panel);

	return () => {
		panel.remove();
	};
}
