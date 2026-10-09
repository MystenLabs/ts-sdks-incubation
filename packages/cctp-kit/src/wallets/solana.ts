// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { SendTransactionError } from '@solana/web3.js';
import type { Connection, Signer, Transaction as SolanaTransaction } from '@solana/web3.js';
import { toBase58 } from '@mysten/sui/utils';
import { sleep } from '../utils/sleep.js';

/** The parts of a Solana wallet provider this kit uses. AppKit's providers implement all of them. */
export interface SolanaProviderLike {
	publicKey?: { toBase58(): string };
	signAndSendTransaction(transaction: SolanaTransaction, options?: unknown): Promise<string>;
	/** Signs with the wallet and returns the transaction, which the wallet may have changed. */
	signTransaction?(transaction: SolanaTransaction): Promise<SolanaTransaction>;
	/** Signs with the wallet and submits through the given connection. */
	sendTransaction?(
		transaction: SolanaTransaction,
		connection: Connection,
		options?: unknown,
	): Promise<string>;
}

const SEND_ATTEMPTS = 3;
const SEND_RETRY_MS = 1_000;

/**
 * Have the wallet sign a transaction, add the signatures of `signers`, and send it.
 *
 * The wallet signs first. Wallets add instructions of their own before they sign (a priority
 * fee, safety checks), which changes the message, and a signature made before that change is
 * no longer valid. Phantom's documentation asks for this order for any transaction with more
 * than one signer.
 */
export async function signAndSendSolanaTransaction(
	provider: SolanaProviderLike,
	transaction: SolanaTransaction,
	connection: Connection,
	signers: Signer[] = [],
): Promise<string> {
	if (signers.length === 0) {
		// Prefer submitting through the kit's own RPC (with its fallbacks) when the provider allows.
		if (typeof provider.sendTransaction === 'function') {
			return provider.sendTransaction(transaction, connection);
		}
		return provider.signAndSendTransaction(transaction);
	}
	if (typeof provider.signTransaction === 'function') {
		const signed = await provider.signTransaction(transaction);
		signed.partialSign(...signers);
		// `serialize` checks every signature against the message that is about to be sent.
		const raw = signed.serialize();
		// Set once a send has ended without an answer. From then on the transaction may be on
		// its way, whatever a later send is told.
		let unanswered = false;
		for (let attempt = 1; ; attempt++) {
			try {
				return await connection.sendRawTransaction(raw);
			} catch (error) {
				const alreadySeen = /already been processed/i.test(messageOf(error));
				// The node saying no settles it only while nothing else has been sent. After a
				// send that got no answer, a refusal says nothing about that earlier send.
				if (wasRefusedByTheNode(error) && !alreadySeen && !unanswered) throw error;
				unanswered = true;
				// No answer (the connection dropped), or the node says it has already seen this
				// transaction: it may be on its way. Sending the same signed bytes again cannot
				// burn twice. After that, hand back the signature, which is known before anything
				// is sent, so the caller tracks it until the chain shows what became of it. To
				// report a failure here would invite a second burn beside one that may land.
				if (attempt === SEND_ATTEMPTS || alreadySeen) {
					if (!signed.signature) throw error;
					return toBase58(signed.signature);
				}
				await sleep(SEND_RETRY_MS);
			}
		}
	}
	// A wallet that can only sign and send in one step has to be given our signatures first.
	transaction.partialSign(...signers);
	return provider.signAndSendTransaction(transaction);
}

/**
 * Whether a failed send is the node saying no: an RPC error (the transaction failed its
 * checks) or an HTTP 4xx (the request was turned away). Either way it was not passed on.
 */
function wasRefusedByTheNode(error: unknown): boolean {
	if (error instanceof SendTransactionError) return true;
	return /^4\d\d\b/.test(messageOf(error));
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
