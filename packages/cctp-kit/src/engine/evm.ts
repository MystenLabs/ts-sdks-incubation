// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createPublicClient, fallback, http, parseAbi, parseEventLogs } from 'viem';
import type { Hex, PublicClient, WalletClient } from 'viem';
import type { EvmChainDefinition } from '../chains/types.js';
import { TransactionRevertedError } from '../utils/errors.js';

export const ERC20_ABI = parseAbi([
	'function balanceOf(address owner) view returns (uint256)',
	'function allowance(address owner, address spender) view returns (uint256)',
	'function approve(address spender, uint256 amount) returns (bool)',
]);

/** Minimal CCTP v2 ABI fragments (TokenMessengerV2 / MessageTransmitterV2). */
export const TOKEN_MESSENGER_V2_ABI = parseAbi([
	'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)',
	'function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)',
	'event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)',
]);

export const MESSAGE_TRANSMITTER_V2_ABI = parseAbi([
	'function receiveMessage(bytes message, bytes attestation) returns (bool)',
	'function usedNonces(bytes32 nonce) view returns (uint256)',
	'event MessageSent(bytes message)',
	'event MessageReceived(address indexed caller, uint32 sourceDomain, bytes32 indexed nonce, bytes32 sender, uint32 indexed finalityThresholdExecuted, bytes messageBody)',
]);

const publicClients = new Map<string, PublicClient>();

export function getEvmPublicClient(chain: EvmChainDefinition): PublicClient {
	const key = `${chain.chainId}:${chain.rpcUrls.join(',')}`;
	let client = publicClients.get(key);
	if (!client) {
		client = createPublicClient({
			chain: chain.viemChain,
			transport: fallback(
				chain.rpcUrls.map((url) => http(url, { timeout: 10_000, retryCount: 1 })),
			),
		});
		publicClients.set(key, client);
	}
	return client;
}

export async function getEvmUsdcBalance(chain: EvmChainDefinition, owner: Hex): Promise<bigint> {
	return getEvmPublicClient(chain).readContract({
		address: chain.usdcAddress,
		abi: ERC20_ABI,
		functionName: 'balanceOf',
		args: [owner],
	});
}

export async function getEvmUsdcAllowance(chain: EvmChainDefinition, owner: Hex): Promise<bigint> {
	return getEvmPublicClient(chain).readContract({
		address: chain.usdcAddress,
		abi: ERC20_ABI,
		functionName: 'allowance',
		args: [owner, chain.tokenMessengerV2],
	});
}

function requireAccount(walletClient: WalletClient) {
	if (!walletClient.account) throw new Error('Wallet client has no account');
	return walletClient.account;
}

export async function approveEvmUsdc(
	walletClient: WalletClient,
	chain: EvmChainDefinition,
	amount: bigint,
): Promise<Hex> {
	const hash = await walletClient.writeContract({
		account: requireAccount(walletClient),
		chain: chain.viemChain,
		address: chain.usdcAddress,
		abi: ERC20_ABI,
		functionName: 'approve',
		args: [chain.tokenMessengerV2, amount],
	});
	return waitForEvmReceipt(chain, hash);
}

export interface EvmDepositForBurnParams {
	amount: bigint;
	destinationDomain: number;
	/** 32-byte recipient, hex encoded. */
	mintRecipient: Hex;
	/** 32-byte destination caller, hex encoded; zero means anyone can mint. */
	destinationCaller?: Hex;
	maxFee: bigint;
	minFinalityThreshold: number;
}

const ZERO_BYTES32: Hex = `0x${'00'.repeat(32)}`;

export async function evmDepositForBurn(
	walletClient: WalletClient,
	chain: EvmChainDefinition,
	params: EvmDepositForBurnParams,
): Promise<Hex> {
	return walletClient.writeContract({
		account: requireAccount(walletClient),
		chain: chain.viemChain,
		address: chain.tokenMessengerV2,
		abi: TOKEN_MESSENGER_V2_ABI,
		functionName: 'depositForBurn',
		args: [
			params.amount,
			params.destinationDomain,
			params.mintRecipient,
			chain.usdcAddress,
			params.destinationCaller ?? ZERO_BYTES32,
			params.maxFee,
			params.minFinalityThreshold,
		],
	});
}

export async function evmReceiveMessage(
	walletClient: WalletClient,
	chain: EvmChainDefinition,
	message: Hex,
	attestation: Hex,
): Promise<Hex> {
	return walletClient.writeContract({
		account: requireAccount(walletClient),
		chain: chain.viemChain,
		address: chain.messageTransmitterV2,
		abi: MESSAGE_TRANSMITTER_V2_ABI,
		functionName: 'receiveMessage',
		args: [message, attestation],
	});
}

export async function evmIsNonceUsed(chain: EvmChainDefinition, nonce: Hex): Promise<boolean> {
	const used = await getEvmPublicClient(chain).readContract({
		address: chain.messageTransmitterV2,
		abi: MESSAGE_TRANSMITTER_V2_ABI,
		functionName: 'usedNonces',
		args: [nonce],
	});
	return used !== 0n;
}

/**
 * Wait for a transaction to be mined and return the hash it was mined under. That is another
 * hash when the user sped it up in the wallet: the same call, resubmitted at a higher fee.
 *
 * Throws `TransactionRevertedError` only when the transaction can no longer take effect: it
 * was mined and reverted, or it was cancelled or replaced by something else in the wallet. Any
 * other rejection (viem gives up after three minutes, or the RPC fails) means the outcome is
 * unknown and the transaction may still be mined.
 */
export async function waitForEvmReceipt(chain: EvmChainDefinition, hash: Hex): Promise<Hex> {
	const seen: { replacement: 'cancelled' | 'replaced' | 'repriced' | null } = { replacement: null };
	const receipt = await getEvmPublicClient(chain).waitForTransactionReceipt({
		hash,
		onReplaced: ({ reason }) => {
			seen.replacement = reason;
		},
	});
	if (seen.replacement === 'cancelled' || seen.replacement === 'replaced') {
		throw new TransactionRevertedError(
			`Transaction ${hash} was ${seen.replacement} in the wallet before it was mined on ${chain.name}`,
		);
	}
	if (receipt.status !== 'success') {
		throw new TransactionRevertedError(
			`Transaction ${receipt.transactionHash} reverted on ${chain.name}`,
		);
	}
	return receipt.transactionHash;
}

export interface EvmBurnDetails {
	amount: bigint;
	destinationDomain: number;
	mintRecipient: Hex;
	depositor: Hex;
	maxFee: bigint;
	minFinalityThreshold: number;
}

/** Read a `DepositForBurn` event back from a mined transaction, or null if it is not a CCTP v2 burn. */
export async function getEvmBurnDetails(
	chain: EvmChainDefinition,
	txHash: Hex,
): Promise<EvmBurnDetails | null> {
	const receipt = await getEvmPublicClient(chain).getTransactionReceipt({ hash: txHash });
	if (receipt.status !== 'success') return null;
	const [log] = parseEventLogs({
		abi: TOKEN_MESSENGER_V2_ABI,
		eventName: 'DepositForBurn',
		logs: receipt.logs.filter(
			(l) => l.address.toLowerCase() === chain.tokenMessengerV2.toLowerCase(),
		),
	});
	if (!log) return null;
	return {
		amount: log.args.amount,
		destinationDomain: log.args.destinationDomain,
		mintRecipient: log.args.mintRecipient,
		depositor: log.args.depositor,
		maxFee: log.args.maxFee,
		minFinalityThreshold: log.args.minFinalityThreshold,
	};
}

/** Block timestamp (ms) of a mined transaction that succeeded, or null. */
export async function getEvmTransactionTime(
	chain: EvmChainDefinition,
	txHash: Hex,
): Promise<number | null> {
	const client = getEvmPublicClient(chain);
	const receipt = await client.getTransactionReceipt({ hash: txHash }).catch(() => null);
	// A transaction that reverted burned nothing, so it has no burn time.
	if (!receipt || receipt.status !== 'success') return null;
	const block = await client.getBlock({ blockNumber: receipt.blockNumber });
	return Number(block.timestamp) * 1000;
}
