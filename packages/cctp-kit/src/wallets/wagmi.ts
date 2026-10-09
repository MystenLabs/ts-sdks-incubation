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
import { CctpKitError, WalletNetworkError } from '../utils/errors.js';
import { sleep } from '../utils/sleep.js';
import type { EvmWalletAdapter, WalletAccount } from './types.js';

/** How long a wallet is given to answer a request to switch network. Someone has to read it. */
const SWITCH_WAIT_MS = 120_000;

/** Wait for a request to finish, for no longer than `ms`. Resolves with what went wrong, if anything. */
async function settled(request: Promise<unknown>, ms: number): Promise<unknown> {
	const giveUp = new AbortController();
	const outcome = await Promise.race([
		request.then(
			() => undefined,
			(error: unknown) => error,
		),
		sleep(ms, giveUp.signal).then(
			() => new Error('The wallet did not answer the request to switch network'),
			() => undefined,
		),
	]);
	giveUp.abort();
	return outcome;
}

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
			if (!getAccount(config).address) {
				throw new CctpKitError(`Connect an EVM wallet to continue on ${chain.name}.`);
			}
			// Ask the wallet itself. What wagmi remembers is only as good as the wallet's notice
			// that it changed network, and some wallets give none when switched by hand.
			const walletChainId = async () => {
				const { connector, chainId } = getAccount(config);
				return (await connector?.getChainId?.().catch(() => undefined)) ?? chainId;
			};
			if ((await walletChainId()) !== chain.chainId) {
				// A wallet may refuse, which wagmi reports as the user rejecting a request. It may
				// never answer, and wagmi waits on that for good. It may answer yes and stay where it
				// was, or switch and answer with an error. What counts is where it is afterwards.
				const cause = await settled(
					switchChain(config, {
						chainId: chain.chainId,
						addEthereumChainParameter: {
							chainName: chain.viemChain.name,
							nativeCurrency: chain.viemChain.nativeCurrency,
							rpcUrls: chain.rpcUrls,
							blockExplorerUrls: chain.viemChain.blockExplorers
								? [chain.viemChain.blockExplorers.default.url]
								: undefined,
						},
					}),
					SWITCH_WAIT_MS,
				);
				if ((await walletChainId()) !== chain.chainId) {
					throw new WalletNetworkError(
						`Your wallet is on another network. Switch it to ${chain.name} in the wallet, then try again.`,
						{ cause },
					);
				}
			}
			return getWalletClient(config, { chainId: chain.chainId });
		},
	};
}
