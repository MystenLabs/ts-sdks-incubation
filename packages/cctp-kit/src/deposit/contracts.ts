// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ChainKey, Network } from '../chains/types.js';

/**
 * The deposit-address contracts (MystenLabs/cctpv2-claimer, `deposit-addresses/`), per network and
 * source chain. They are immutable: a new version is a new factory or program, at new addresses.
 */
export type DepositContract =
	| {
			ecosystem: 'evm';
			/** DepositFactory, deployed through the CREATE2 deployer at the same address on every chain. */
			factory: `0x${string}`;
			/** keccak256 of DepositForwarder's creation code. */
			forwarderCodeHash: `0x${string}`;
			/** USDC (6 decimals) the processor takes before burning. */
			keeperFee: bigint;
			/** The cap on Circle's Fast fee each burn authorizes. */
			maxCircleFeeBps: bigint;
	  }
	| {
			ecosystem: 'solana';
			program: string;
			keeperFee: bigint;
			maxCircleFeeBps: bigint;
	  };

/** The least that may reach Sui, after the Circle fee cap: the claimer's own minimum. */
export const MIN_NET_TO_SUI = 100_000n;

const FORWARDER_CODE_HASH =
	'0xfab669c66449ae84215c1d714382e34c25a51b1178030c245574fc156445190a' as const;

export const DEPOSIT_CONTRACTS: Record<Network, Partial<Record<ChainKey, DepositContract>>> = {
	testnet: {
		base: {
			ecosystem: 'evm',
			factory: '0xEAcED2C1480fe703Ba0AD3409Bfbf9676c2DB6a6',
			forwarderCodeHash: FORWARDER_CODE_HASH,
			keeperFee: 100_000n,
			maxCircleFeeBps: 5n,
		},
		solana: {
			ecosystem: 'solana',
			program: 'F6BTz5STPSc8QhKoRivg4Dp2RYZqB3JMU6cC3Wei4tqN',
			keeperFee: 100_000n,
			maxCircleFeeBps: 5n,
		},
	},
	// Nothing is deployed on mainnet yet.
	mainnet: {},
};

/**
 * What a deposit must hold before it can be processed: the keeper fee, plus enough that the burn,
 * less the Circle fee cap, still reaches the minimum. The contracts refuse anything less.
 */
export function minimumDeposit(contract: DepositContract): bigint {
	let burned = MIN_NET_TO_SUI;
	while (burned - (burned * contract.maxCircleFeeBps + 9_999n) / 10_000n < MIN_NET_TO_SUI) burned++;
	return contract.keeperFee + burned;
}
