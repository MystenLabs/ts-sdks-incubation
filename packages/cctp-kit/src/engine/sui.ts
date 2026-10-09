// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { bcs } from '@mysten/sui/bcs';
import { coinWithBalance, Transaction } from '@mysten/sui/transactions';
import type { ClientWithCoreApi } from '@mysten/sui/client';
import type { SuiChainDefinition } from '../chains/types.js';
import { bytesToHex } from '../utils/bytes.js';

export interface SuiDepositForBurnParams {
	sender: string;
	amount: bigint;
	destinationDomain: number;
	/** 32-byte recipient. */
	mintRecipient: Uint8Array;
	/** 32-byte destination caller; omit to allow anyone to mint. */
	destinationCaller?: Uint8Array;
	maxFee: bigint;
	minFinalityThreshold: number;
	hookData?: Uint8Array;
}

/**
 * Build the 3-call CCTP v2 burn PTB:
 *   token_messenger_minter_v2::deposit_for_burn::deposit_for_burn
 *   → stablecoin_handler::handler::burn
 *   → token_messenger_minter_v2::deposit_for_burn::complete_burn
 */
export function buildSuiBurnTransaction(
	chain: SuiChainDefinition,
	params: SuiDepositForBurnParams,
): Transaction {
	const tx = new Transaction();
	tx.setSender(params.sender);

	const coin = tx.add(coinWithBalance({ type: chain.usdcCoinType, balance: params.amount }));
	const { packages, objects } = chain;
	const usdcType = chain.usdcCoinType;

	const [burnReceipt, returnedCoin] = tx.moveCall({
		target: `${packages.tokenMessengerMinterV2}::deposit_for_burn::deposit_for_burn`,
		arguments: [
			coin,
			tx.pure.u32(params.destinationDomain),
			tx.pure.address(bytesToHex(params.mintRecipient)),
			tx.pure.address(params.destinationCaller ? bytesToHex(params.destinationCaller) : '0x0'),
			tx.pure.u256(params.maxFee),
			tx.pure.u32(params.minFinalityThreshold),
			tx.pure.vector('u8', Array.from(params.hookData ?? [])),
			tx.object(objects.tokenMessengerMinterState),
		],
		typeArguments: [usdcType],
	});

	const [completeBurnTicket] = tx.moveCall({
		target: `${packages.stablecoinHandler}::handler::burn`,
		arguments: [
			tx.object(objects.stablecoinHandlerState),
			burnReceipt,
			returnedCoin,
			tx.object(objects.denyList),
			tx.object(objects.treasury),
		],
	});

	tx.moveCall({
		target: `${packages.tokenMessengerMinterV2}::deposit_for_burn::complete_burn`,
		arguments: [
			completeBurnTicket,
			tx.object(objects.tokenMessengerMinterState),
			tx.object(objects.messageTransmitterState),
		],
		typeArguments: [usdcType, `${packages.stablecoinHandler}::handler::Auth`],
	});

	return tx;
}

/**
 * Build the 4-call CCTP v2 receive PTB:
 *   message_transmitter_v2::receive_message::receive_message
 *   → token_messenger_minter_v2::handle_receive_message::prepare_mint
 *   → stablecoin_handler::handler::mint
 *   → token_messenger_minter_v2::handle_receive_message::complete_mint
 *
 * Anyone may submit this when the message's destination caller is zero; USDC is minted to
 * the recipient encoded in the message, not to the transaction sender.
 */
export function buildSuiReceiveTransaction(
	chain: SuiChainDefinition,
	message: Uint8Array,
	attestation: Uint8Array,
	sender?: string,
): Transaction {
	const tx = new Transaction();
	if (sender) tx.setSender(sender);
	const { packages, objects } = chain;
	const usdcType = chain.usdcCoinType;

	const [receipt] = tx.moveCall({
		target: `${packages.messageTransmitterV2}::receive_message::receive_message`,
		arguments: [
			tx.pure.vector('u8', Array.from(message)),
			tx.pure.vector('u8', Array.from(attestation)),
			tx.object(objects.messageTransmitterState),
		],
	});

	const [mintReceipt] = tx.moveCall({
		target: `${packages.tokenMessengerMinterV2}::handle_receive_message::prepare_mint`,
		arguments: [receipt, tx.object(objects.tokenMessengerMinterState), tx.object(objects.clock)],
		typeArguments: [usdcType],
	});

	const [completeMintTicket] = tx.moveCall({
		target: `${packages.stablecoinHandler}::handler::mint`,
		arguments: [
			tx.object(objects.stablecoinHandlerState),
			mintReceipt,
			tx.object(objects.tokenMessengerMinterState),
			tx.object(objects.treasury),
			tx.object(objects.denyList),
		],
	});

	tx.moveCall({
		target: `${packages.tokenMessengerMinterV2}::handle_receive_message::complete_mint`,
		arguments: [
			completeMintTicket,
			tx.object(objects.tokenMessengerMinterState),
			tx.object(objects.messageTransmitterState),
		],
		typeArguments: [usdcType, `${packages.stablecoinHandler}::handler::Auth`],
	});

	return tx;
}

/**
 * Whether a message's nonce has been consumed on Sui, that is, whether it was already claimed.
 * Read by simulating the transmitter's public `is_nonce_used` view; nothing is signed or sent.
 */
export async function suiIsNonceUsed(
	client: ClientWithCoreApi,
	chain: SuiChainDefinition,
	nonce: Uint8Array,
): Promise<boolean> {
	const tx = new Transaction();
	// A simulation needs a sender, but this call reads state and does not care who asks.
	tx.setSender(`0x${'0'.repeat(64)}`);
	tx.moveCall({
		target: `${chain.packages.messageTransmitterV2}::state::is_nonce_used`,
		arguments: [
			tx.object(chain.objects.messageTransmitterState),
			tx.pure.u256(BigInt(bytesToHex(nonce))),
		],
	});
	const result = await client.core.simulateTransaction({
		transaction: tx,
		include: { commandResults: true },
	});
	const returned = result.commandResults?.[0]?.returnValues?.[0]?.bcs;
	if (!returned) throw new Error('The nonce lookup on Sui returned nothing');
	return bcs.Bool.parse(returned);
}

export async function getSuiUsdcBalance(
	client: ClientWithCoreApi,
	chain: SuiChainDefinition,
	owner: string,
): Promise<bigint> {
	const result = await client.core.getBalance({ owner, coinType: chain.usdcCoinType });
	return BigInt(result.balance.balance);
}

/** What `owner` holds of SUI, which is what pays for gas. */
export async function getSuiGasBalance(client: ClientWithCoreApi, owner: string): Promise<bigint> {
	const result = await client.core.getBalance({ owner, coinType: '0x2::sui::SUI' });
	return BigInt(result.balance.balance);
}

/** Checkpoint timestamp (ms) of a transaction that succeeded, or null. */
export async function getSuiTransactionTime(
	client: ClientWithCoreApi,
	digest: string,
): Promise<number | null> {
	const result = await client.core.getTransaction({ digest });
	// A transaction that failed burned nothing, so it has no burn time.
	return result.$kind === 'Transaction' ? (result.Transaction.timestampMs ?? null) : null;
}
