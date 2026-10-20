// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { SendTransactionError } from '@solana/web3.js';
import type { Connection, Signer, Transaction, VersionedTransaction } from '@solana/web3.js';
import { toBase58 } from '@mysten/sui/utils';
import { sleep } from '../utils/sleep.js';

type SolanaTransaction = Transaction | VersionedTransaction;

/**
 * The parts of a Solana wallet provider this kit uses. AppKit's providers implement all of them,
 * for legacy and versioned transactions alike. They are properties rather than methods so that
 * a provider that takes only legacy transactions does not typecheck: claims are versioned.
 */
export interface SolanaProviderLike {
	publicKey?: { toBase58(): string };
	signAndSendTransaction: (transaction: SolanaTransaction, options?: unknown) => Promise<string>;
	/**
	 * Signs with the wallet and returns the transaction, of the kind it was given, which the
	 * wallet may have changed.
	 */
	signTransaction?: (transaction: SolanaTransaction) => Promise<SolanaTransaction>;
	/** Signs with the wallet and submits through the given connection. */
	sendTransaction?: (
		transaction: SolanaTransaction,
		connection: Connection,
		options?: unknown,
	) => Promise<string>;
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
		addSignatures(signed, signers);
		// A legacy `serialize` checks every signature against the message that is about to be
		// sent. A versioned one checks nothing, and the node refuses it if one does not verify.
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
					const signature = feePayerSignature(signed);
					if (!signature) throw error;
					return toBase58(signature);
				}
				await sleep(SEND_RETRY_MS);
			}
		}
	}
	// A wallet that can only sign and send in one step has to be given our signatures first.
	addSignatures(transaction, signers);
	return provider.signAndSendTransaction(transaction);
}

/**
 * Whether a transaction is versioned. Asked of its shape, as AppKit does, not with `instanceof`:
 * a wallet library hands back transactions built with its own copy of web3.js.
 */
function isVersioned(transaction: SolanaTransaction): transaction is VersionedTransaction {
	return 'version' in transaction;
}

function addSignatures(transaction: SolanaTransaction, signers: Signer[]): void {
	if (isVersioned(transaction)) transaction.sign(signers);
	else transaction.partialSign(...signers);
}

/** The fee payer's signature, which is the transaction's id, or null before the wallet signs. */
function feePayerSignature(transaction: SolanaTransaction): Uint8Array | null {
	if (!isVersioned(transaction)) return transaction.signature;
	const first = transaction.signatures[0];
	return first && first.some((byte) => byte !== 0) ? first : null;
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
