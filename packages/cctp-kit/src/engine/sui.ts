// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { bcs } from '@mysten/sui/bcs';
import { coinWithBalance, Transaction } from '@mysten/sui/transactions';
import type { TransactionObjectArgument } from '@mysten/sui/transactions';
import type { ClientWithCoreApi } from '@mysten/sui/client';
import type { SuiChainDefinition } from '../chains/types.js';
import { fromBase64 } from '@mysten/sui/utils';
import { bytesToHex, isMessageV2For } from '../utils/bytes.js';

export interface SuiDepositForBurnParams {
	/** Burned whole, so it must hold exactly the amount to send. */
	coin: TransactionObjectArgument;
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
 * The 3-call CCTP v2 burn, as a transaction thunk for `tx.add()`:
 *   token_messenger_minter_v2::deposit_for_burn::deposit_for_burn
 *   → stablecoin_handler::handler::burn
 *   → token_messenger_minter_v2::deposit_for_burn::complete_burn
 */
export function suiDepositForBurn(chain: SuiChainDefinition, params: SuiDepositForBurnParams) {
	return (tx: Transaction): void => {
		const { packages, objects } = chain;
		const usdcType = chain.usdcCoinType;

		const [burnReceipt, returnedCoin] = tx.moveCall({
			target: `${packages.tokenMessengerMinterV2}::deposit_for_burn::deposit_for_burn`,
			arguments: [
				params.coin,
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
	};
}

export interface SuiBurnTransactionParams extends Omit<SuiDepositForBurnParams, 'coin'> {
	sender: string;
	/** Base units, taken from the sender's own USDC. */
	amount: bigint;
}

/** A transaction that burns `amount` of the sender's own USDC. */
export function buildSuiBurnTransaction(
	chain: SuiChainDefinition,
	{ sender, amount, ...burn }: SuiBurnTransactionParams,
): Transaction {
	const tx = new Transaction();
	tx.setSender(sender);
	const coin = tx.add(coinWithBalance({ type: chain.usdcCoinType, balance: amount }));
	tx.add(suiDepositForBurn(chain, { ...burn, coin }));
	return tx;
}

/**
 * The 4-call CCTP v2 receive, as a transaction thunk for `tx.add()`:
 *   message_transmitter_v2::receive_message::receive_message
 *   → token_messenger_minter_v2::handle_receive_message::prepare_mint
 *   → stablecoin_handler::handler::mint
 *   → token_messenger_minter_v2::handle_receive_message::complete_mint
 *
 * Anyone may submit this when the message's destination caller is zero. Circle's handler sends the
 * USDC to the message's recipient, so later calls in the transaction cannot use it.
 */
export function suiReceiveMessage(
	chain: SuiChainDefinition,
	message: Uint8Array,
	attestation: Uint8Array,
) {
	return (tx: Transaction): void => {
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
	};
}

/** A transaction that claims one attested message on Sui. */
export function buildSuiReceiveTransaction(
	chain: SuiChainDefinition,
	message: Uint8Array,
	attestation: Uint8Array,
	sender?: string,
): Transaction {
	const tx = new Transaction();
	if (sender) tx.setSender(sender);
	tx.add(suiReceiveMessage(chain, message, attestation));
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

/**
 * The CCTP message a Sui transaction claimed, or null when it claimed none. A claim hands the
 * message to `receive_message` as plain bytes, so it is among the transaction's own inputs,
 * whoever built the transaction.
 */
export async function getSuiClaimedMessage(
	client: ClientWithCoreApi,
	chain: SuiChainDefinition,
	digest: string,
): Promise<Uint8Array | null> {
	const result = await client.core.getTransaction({ digest, include: { transaction: true } });
	if (result.$kind !== 'Transaction') return null;
	for (const input of result.Transaction.transaction.inputs) {
		const pure = 'Pure' in input ? input.Pure : undefined;
		if (!pure) continue;
		try {
			const bytes = Uint8Array.from(bcs.vector(bcs.u8()).parse(fromBase64(pure.bytes)));
			if (isMessageV2For(bytes, chain.domain)) return bytes;
		} catch {
			// Some other argument.
		}
	}
	return null;
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
