// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { PublicKey } from '@solana/web3.js';
import { Buffer } from 'buffer';
import {
	encodeAbiParameters,
	getAddress,
	getContractAddress,
	isAddress,
	keccak256,
	parseAbiParameters,
} from 'viem';
import type { ChainDefinition } from '../chains/types.js';
import { getAssociatedTokenAddress } from '../engine/solana.js';
import type { DepositContract } from './contracts.js';

/** The owner of a deposit address nobody can recover from: the zero address, or Solana's default key. */
export const EVM_NO_RECOVERY = '0x0000000000000000000000000000000000000000';
export const SOLANA_NO_RECOVERY = PublicKey.default.toBase58();

export interface DepositAddress {
	/** Where to send USDC. On Solana it is the deposit account, and wallets pay its USDC token account. */
	address: string;
	/** Solana only: the USDC token account that actually holds the deposit. */
	tokenAccount?: string;
	/** The recovery address, or null for a Sui-only deposit address. */
	owner: string | null;
}

const SUI_ADDRESS = /^0x[0-9a-fA-F]{64}$/;

/**
 * Derive the deposit address for (recovery address, Sui recipient) on one source chain, the same
 * way the contracts do. Nothing is asked of the network or the service: a client that derives the
 * address itself does not have to trust anyone with where its users send funds.
 */
export function deriveDepositAddress(args: {
	chain: ChainDefinition;
	contract: DepositContract;
	/** A full 32-byte Sui address. */
	recipient: string;
	/** The recovery address on the source chain; leave it out for a Sui-only address. */
	owner?: string | null;
}): DepositAddress {
	const { chain, contract } = args;
	if (!SUI_ADDRESS.test(args.recipient))
		throw new Error('Enter a full Sui address (0x and 64 hex)');
	const sui = args.recipient.toLowerCase() as `0x${string}`;
	const owner = args.owner?.trim() || null;

	if (contract.ecosystem === 'evm') {
		if (chain.ecosystem !== 'evm') throw new Error(`${chain.name} is not an EVM chain`);
		if (owner && !isAddress(owner, { strict: false })) {
			throw new Error(`The recovery address is not a ${chain.name} address`);
		}
		const address = getContractAddress({
			opcode: 'CREATE2',
			from: contract.factory,
			salt: keccak256(
				encodeAbiParameters(parseAbiParameters('address, bytes32'), [
					getAddress(owner ?? EVM_NO_RECOVERY),
					sui,
				]),
			),
			bytecodeHash: contract.forwarderCodeHash,
		});
		return { address, owner: owner ? getAddress(owner) : null };
	}

	if (chain.ecosystem !== 'solana') throw new Error(`${chain.name} is not Solana`);
	let ownerKey = PublicKey.default;
	if (owner) {
		try {
			ownerKey = new PublicKey(owner);
		} catch {
			throw new Error('The recovery address is not a Solana address');
		}
	}
	const [deposit] = PublicKey.findProgramAddressSync(
		[Buffer.from('deposit'), ownerKey.toBuffer(), Buffer.from(sui.slice(2), 'hex')],
		new PublicKey(contract.program),
	);
	return {
		address: deposit.toBase58(),
		tokenAccount: getAssociatedTokenAddress(new PublicKey(chain.usdcMint), deposit).toBase58(),
		owner: owner ? ownerKey.toBase58() : null,
	};
}

/** Addresses compare case-insensitively on EVM, exactly on Solana. */
export function sameAddress(a: string, b: string): boolean {
	return a.startsWith('0x') ? a.toLowerCase() === b.toLowerCase() : a === b;
}
