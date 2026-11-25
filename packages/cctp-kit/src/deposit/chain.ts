// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { PublicKey } from '@solana/web3.js';
import { parseAbiItem } from 'viem';
import type { ChainDefinition } from '../chains/types.js';
import { getEvmPublicClient, getEvmUsdcBalance } from '../engine/evm.js';
import { getSolanaUsdcBalance, withSolanaConnection } from '../engine/solana.js';
import type { DepositAddress } from './address.js';
import type { IncomingDeposit } from './watcher.js';

const TRANSFER = parseAbiItem(
	'event Transfer(address indexed from, address indexed to, uint256 value)',
);
// About an hour of blocks on a 2-second chain, within what public endpoints serve to getLogs.
const LOOKBACK_BLOCKS = 1_800n;

/** USDC at the deposit address, read from the source chain. */
export async function depositBalance(
	chain: ChainDefinition,
	deposit: DepositAddress,
): Promise<bigint> {
	if (chain.ecosystem === 'evm') {
		return getEvmUsdcBalance(chain, deposit.address as `0x${string}`);
	}
	if (chain.ecosystem === 'solana')
		return getSolanaUsdcBalance(chain, new PublicKey(deposit.address));
	throw new Error(`No deposits on ${chain.name}`);
}

/**
 * The latest transfer into the deposit address, so the widget can show the user the transaction
 * that funded it before anything is burned. Best effort: null when none is found.
 */
export async function findIncomingDeposit(
	chain: ChainDefinition,
	deposit: DepositAddress,
): Promise<IncomingDeposit | null> {
	if (chain.ecosystem === 'evm') {
		const client = getEvmPublicClient(chain);
		const latest = await client.getBlockNumber();
		const logs = await client.getLogs({
			address: chain.usdcAddress,
			event: TRANSFER,
			args: { to: deposit.address as `0x${string}` },
			fromBlock: latest > LOOKBACK_BLOCKS ? latest - LOOKBACK_BLOCKS : 0n,
			toBlock: latest,
		});
		const last = logs.at(-1);
		return last?.transactionHash ? { txHash: last.transactionHash, amount: last.args.value } : null;
	}
	if (chain.ecosystem === 'solana' && deposit.tokenAccount) {
		const [latest] = await withSolanaConnection(chain, (connection) =>
			connection.getSignaturesForAddress(new PublicKey(deposit.tokenAccount!), { limit: 1 }),
		);
		return latest && !latest.err ? { txHash: latest.signature } : null;
	}
	return null;
}
