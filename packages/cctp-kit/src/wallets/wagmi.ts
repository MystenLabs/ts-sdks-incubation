// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
	getAccount,
	getWalletClient,
	switchChain,
	watchAccount,
	disconnect as wagmiDisconnect,
} from '@wagmi/core';
import type { Config } from '@wagmi/core';
import type { EvmChainDefinition } from '../chains/types.js';
import { WalletNetworkError } from '../utils/errors.js';
import type { EvmWalletAdapter, WalletAccount } from './types.js';

export interface WagmiEvmWalletOptions {
	/** Called when the widget needs the user to connect; hosts usually open their own modal here. */
	openConnect?: () => Promise<void> | void;
}

/**
 * Wrap a host's wagmi `Config` so the widget reuses the host's existing EVM connection
 * instead of mounting its own. Works with any wagmi config, including the one produced by
 * RainbowKit, ConnectKit, Privy, Dynamic or AppKit's wagmi adapter.
 */
export function createEvmWalletFromWagmiConfig(
	config: Config,
	options: WagmiEvmWalletOptions = {},
): EvmWalletAdapter {
	const toAccount = (): WalletAccount | null => {
		const account = getAccount(config);
		return account.address ? { address: account.address } : null;
	};

	return {
		ecosystem: 'evm',
		getAccount: toAccount,
		subscribe(listener) {
			return watchAccount(config, { onChange: () => listener(toAccount()) });
		},
		async connect() {
			if (!options.openConnect) {
				throw new Error(
					'No EVM wallet is connected and the host did not provide an `openConnect` handler.',
				);
			}
			await options.openConnect();
		},
		async disconnect() {
			await wagmiDisconnect(config);
		},
		async getWalletClient(chain: EvmChainDefinition) {
			// Ask the wallet itself. What wagmi remembers is only as good as the wallet's notice
			// that it changed network, and some wallets give none when switched by hand.
			const walletChainId = async () => {
				const { connector, chainId } = getAccount(config);
				return (await connector?.getChainId?.().catch(() => undefined)) ?? chainId;
			};
			if ((await walletChainId()) !== chain.chainId) {
				try {
					await switchChain(config, {
						chainId: chain.chainId,
						addEthereumChainParameter: {
							chainName: chain.viemChain.name,
							nativeCurrency: chain.viemChain.nativeCurrency,
							rpcUrls: chain.rpcUrls,
							blockExplorerUrls: chain.viemChain.blockExplorers
								? [chain.viemChain.blockExplorers.default.url]
								: undefined,
						},
					});
				} catch (error) {
					// Some wallets cannot be told to switch, and wagmi reports that as the user
					// rejecting a request. Some switch and answer with an error all the same. What
					// counts is where the wallet is now.
					if ((await walletChainId()) !== chain.chainId) {
						throw new WalletNetworkError(
							`Your wallet is on another network. Switch it to ${chain.name} in the wallet, then try again.`,
							{ cause: error },
						);
					}
				}
			}
			return getWalletClient(config, { chainId: chain.chainId });
		},
	};
}
