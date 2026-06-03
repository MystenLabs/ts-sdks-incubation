// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useRef, useState } from 'react';

import type { DevWallet } from '../wallet/dev-wallet.js';
import {
	mountAndRegisterDevWallet,
	type MountAndRegisterDevWalletOptions,
} from '../wallet/mount-and-register.js';

export interface UseDevWalletOptions extends MountAndRegisterDevWalletOptions {
	/** Whether to create an initial account after initialization (if adapter supports it). Defaults to true. */
	createInitialAccount?: boolean;
}

export interface UseDevWalletResult {
	wallet: DevWallet | null;
	/** Initialization error, if any (e.g. IndexedDB quota exceeded, adapter failure). */
	error: Error | null;
	/** True while the wallet is being initialized. */
	loading: boolean;
}

/**
 * React hook that initializes a DevWallet, registers it with the wallet-standard
 * registry, and optionally mounts the wallet drawer UI.
 *
 * The adapters are captured on first render and used for the wallet's
 * lifetime. Pass stable references (created outside the component or via useMemo).
 *
 * @example
 * ```tsx
 * const adapters = useMemo(() => [new InMemorySignerAdapter()], []);
 *
 * const wallet = useDevWallet({ adapters, networks: { devnet: 'https://fullnode.devnet.sui.io:443' } });
 * ```
 */
export function useDevWallet(options: UseDevWalletOptions): UseDevWalletResult {
	const [wallet, setWallet] = useState<DevWallet | null>(null);
	const [error, setError] = useState<Error | null>(null);
	const [loading, setLoading] = useState(true);
	const optionsRef = useRef(options);
	optionsRef.current = options;

	useEffect(() => {
		let cancelled = false;
		let dispose: (() => void) | undefined;

		// The hook keeps `createInitialAccount` defaulting to TRUE: its typical
		// adapters (WebCrypto / InMemory) start empty and need a starter account,
		// whereas the core helper defaults it off for managed/remote adapters.
		mountAndRegisterDevWallet({ createInitialAccount: true, ...optionsRef.current })
			.then((result) => {
				if (cancelled) {
					result.dispose();
					return;
				}
				dispose = result.dispose;
				setWallet(result.wallet);
				setLoading(false);
			})
			.catch((err) => {
				if (!cancelled) {
					setError(err instanceof Error ? err : new Error(String(err)));
					setLoading(false);
				}
			});

		return () => {
			cancelled = true;
			dispose?.();
		};
	}, []); // eslint-disable-line react-hooks/exhaustive-deps

	return useMemo(() => ({ wallet, error, loading }), [wallet, error, loading]);
}
