// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useContext } from 'react';
import { useStore } from '@nanostores/react';
import type { CctpKit } from '../core/index.js';
import type { WalletState } from '../core/store.js';
import type { TransferRecord } from '../core/types.js';
import { CctpKitContext } from './CctpKitProvider.js';

/** The kit from context, or the explicitly passed instance (mirrors dapp-kit's `useDAppKit`). */
export function useCctpKit(kit?: CctpKit): CctpKit {
	const fromContext = useContext(CctpKitContext);
	const instance = kit ?? fromContext;
	if (!instance) {
		throw new Error('No CctpKit instance found. Wrap your app in <CctpKitProvider> or pass `kit`.');
	}
	return instance;
}

/** Every record stored in this browser for the kit's network, whoever made it. */
export function useCctpTransfers(options?: { kit?: CctpKit }): TransferRecord[] {
	return useStore(useCctpKit(options?.kit).stores.$transfers);
}

/** What the widget lists: transfers in progress, plus completed ones of the connected wallets. */
export function useCctpHistory(options?: { kit?: CctpKit }): TransferRecord[] {
	return useStore(useCctpKit(options?.kit).stores.$history);
}

export function useActiveCctpTransfer(options?: { kit?: CctpKit }): TransferRecord | null {
	return useStore(useCctpKit(options?.kit).stores.$activeTransfer);
}

export function useCctpWallets(options?: { kit?: CctpKit }): WalletState {
	return useStore(useCctpKit(options?.kit).stores.$wallets);
}
