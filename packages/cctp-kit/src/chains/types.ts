// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Chain as ViemChain } from 'viem';
import type { FinalityEstimate } from './finality.js';

export type Network = 'mainnet' | 'testnet';
export type Ecosystem = 'sui' | 'evm' | 'solana';

/**
 * Stable, network-independent identifier for a chain. The same key resolves to the
 * mainnet or testnet deployment depending on the kit's `network`, so route config
 * written against mainnet keeps working on testnet.
 */
export type ChainKey =
	| 'sui'
	| 'solana'
	| 'ethereum'
	| 'avalanche'
	| 'optimism'
	| 'arbitrum'
	| 'base'
	| 'polygon'
	| 'unichain'
	| 'linea'
	| 'codex'
	| 'sonic'
	| 'worldchain'
	| 'monad'
	| 'sei'
	| 'xdc'
	| 'hyperevm'
	| 'ink'
	| 'plume'
	| 'arc'
	| 'edge'
	| 'injective'
	| 'morph'
	| 'pharos'
	| 'cronos'
	| 'plasma'
	| 'xlayer';

interface ChainBase {
	key: ChainKey;
	name: string;
	/** Circle CCTP domain id. */
	domain: number;
	isTestnet: boolean;
	/** Whether Circle offers Fast Transfer when this chain is the *source*. */
	fastTransferAsSource: boolean;
	explorerUrl: string;
	/** Ordered list of public RPC endpoints; the first is primary, the rest are fallbacks. */
	rpcUrls: string[];
	/** Icon URL (or data URI). `undefined` renders a text monogram. */
	icon?: string;
	/** Expected attestation wait when this chain is the source. */
	finality: FinalityEstimate;
}

export interface EvmChainDefinition extends ChainBase {
	ecosystem: 'evm';
	chainId: number;
	/** viem chain object; also used for `wallet_addEthereumChain`. */
	viemChain: ViemChain;
	usdcAddress: `0x${string}`;
	tokenMessengerV2: `0x${string}`;
	messageTransmitterV2: `0x${string}`;
}

export interface SuiChainDefinition extends ChainBase {
	ecosystem: 'sui';
	/** dapp-kit network name this definition applies to (`sui:<network>`). */
	suiNetwork: 'mainnet' | 'testnet';
	usdcCoinType: string;
	packages: {
		messageTransmitterV2: string;
		/** The *callable* token messenger package (the upgraded id when the package was upgraded). */
		tokenMessengerMinterV2: string;
		stablecoinHandler: string;
	};
	objects: {
		messageTransmitterState: string;
		tokenMessengerMinterState: string;
		stablecoinHandlerState: string;
		treasury: string;
		denyList: string;
		clock: string;
	};
}

export interface SolanaChainDefinition extends ChainBase {
	ecosystem: 'solana';
	cluster: 'mainnet-beta' | 'devnet';
	/** CAIP-2 reference used by AppKit / wallet-standard. */
	caipChainId: string;
	usdcMint: string;
	messageTransmitterV2: string;
	tokenMessengerMinterV2: string;
}

export type ChainDefinition = EvmChainDefinition | SuiChainDefinition | SolanaChainDefinition;

/** Circle finality thresholds (CCTP v2). */
export const FINALITY_THRESHOLD = {
	fast: 1000,
	standard: 2000,
} as const;

export const USDC_DECIMALS = 6;
