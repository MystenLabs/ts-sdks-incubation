// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { FINALITY_BY_CHAIN } from './finality.js';
import type { SolanaChainDefinition } from './types.js';

/**
 * Circle CCTP v2 on Solana (domain 5). Program ids come from circlefin/solana-cctp-contracts
 * (examples/Anchor.toml and the v2 IDLs); Circle uses the same ids on mainnet-beta and devnet.
 */
const MESSAGE_TRANSMITTER_V2 = 'CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC';
const TOKEN_MESSENGER_MINTER_V2 = 'CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe';

export const SOLANA_MAINNET: SolanaChainDefinition = {
	ecosystem: 'solana',
	key: 'solana',
	name: 'Solana',
	domain: 5,
	isTestnet: false,
	cluster: 'mainnet-beta',
	caipChainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
	fastTransferAsSource: true,
	explorerUrl: 'https://solscan.io',
	rpcUrls: ['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'],
	finality: FINALITY_BY_CHAIN.solana,
	usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
	messageTransmitterV2: MESSAGE_TRANSMITTER_V2,
	tokenMessengerMinterV2: TOKEN_MESSENGER_MINTER_V2,
};

export const SOLANA_DEVNET: SolanaChainDefinition = {
	ecosystem: 'solana',
	key: 'solana',
	name: 'Solana Devnet',
	domain: 5,
	isTestnet: true,
	cluster: 'devnet',
	caipChainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
	fastTransferAsSource: true,
	explorerUrl: 'https://explorer.solana.com/?cluster=devnet',
	rpcUrls: ['https://api.devnet.solana.com'],
	finality: FINALITY_BY_CHAIN.solana,
	usdcMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
	messageTransmitterV2: MESSAGE_TRANSMITTER_V2,
	tokenMessengerMinterV2: TOKEN_MESSENGER_MINTER_V2,
};
