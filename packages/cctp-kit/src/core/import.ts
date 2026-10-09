// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { fromBase58 } from '@mysten/sui/utils';
import type { ChainDefinition, ChainKey, Network } from '../chains/types.js';
import type { IrisMessage } from '../iris/client.js';
import { fromBytes32, hexToBytes, isHexAddress } from '../utils/bytes.js';
import type { TransferRecord, TransferSpeed } from './types.js';

export type HashKind = 'evm' | 'sui' | 'solana' | 'unknown';

/** Classify a transaction identifier by shape: 0x + 64 hex is EVM, 32-byte base58 is a Sui digest, 64-byte base58 is a Solana signature. */
export function classifyTxHash(txHash: string): HashKind {
	const value = txHash.trim();
	if (/^0x[0-9a-fA-F]{64}$/.test(value)) return 'evm';
	try {
		const bytes = fromBase58(value);
		if (bytes.length === 32) return 'sui';
		if (bytes.length === 64) return 'solana';
	} catch {
		// not base58
	}
	return 'unknown';
}

/** The host a link points at, without a leading "www."; null when it is not a link. */
function hostOf(link: string): string | null {
	try {
		return new URL(link.includes('://') ? link : `https://${link}`).hostname.replace(/^www\./, '');
	} catch {
		return null;
	}
}

/**
 * Read what someone pasted to track a transfer: the transaction identifier itself, or a block
 * explorer's link to it, which is what a phone's share button hands over. A link to one of the
 * kit's own explorers also says which chain the transaction is on.
 */
export function parseTxReference(
	pasted: string,
	chains: ChainDefinition[],
): { txHash: string; chain?: ChainKey } {
	const value = pasted.trim();
	if (classifyTxHash(value) !== 'unknown') return { txHash: value };
	const candidates = value.split(/[/?#&=\s]+/).filter((part) => classifyTxHash(part) !== 'unknown');
	const host = hostOf(value);
	const explorers = chains.filter((c) => hostOf(c.explorerUrl) === host);
	for (const txHash of candidates) {
		const chain = explorers.find((c) => c.ecosystem === classifyTxHash(txHash));
		if (chain) return { txHash, chain: chain.key };
	}
	// On an explorer the kit knows, anything else of that shape is not a transaction there: a
	// Sui address looks exactly like an EVM transaction hash.
	if (explorers.length > 0 || candidates.length === 0) return { txHash: value };
	return { txHash: candidates[0]! };
}

/**
 * Resolve the source chain for a hash. Sui digests and Solana signatures are unambiguous;
 * EVM hashes need a hint because every EVM chain shares the format.
 */
export function resolveSourceChain(
	txHash: string,
	chains: ChainDefinition[],
	hint?: ChainKey,
): ChainDefinition {
	const kind = classifyTxHash(txHash);
	if (kind === 'unknown') {
		throw new Error('That does not look like a transaction hash, or a link to one');
	}
	if (hint) {
		const chain = chains.find((c) => c.key === hint);
		if (!chain) throw new Error(`Unknown chain "${hint}"`);
		if (chain.ecosystem !== kind) {
			throw new Error(`That hash is a ${kind} transaction, not ${chain.name}`);
		}
		return chain;
	}
	if (kind === 'evm') throw new Error('Select the chain this EVM transaction was sent on');
	const chain = chains.find((c) => c.ecosystem === kind);
	if (!chain) throw new Error(`${kind} is not enabled in this kit`);
	return chain;
}

export interface BurnDetails {
	amount: bigint;
	destinationDomain: number;
	/** 32-byte mint recipient. */
	mintRecipient: Uint8Array;
	/** Source address in the source chain's native format, if known. */
	sender?: string;
	minFinalityThreshold?: number;
	maxFee?: bigint;
}

/** Extract burn details from an Iris message, if Circle has decoded it (it has not while pending). */
export function burnDetailsFromIris(message: IrisMessage): BurnDetails | null {
	const decoded = message.decodedMessage;
	const body = decoded?.decodedMessageBody;
	if (!decoded || !body) return null;
	return {
		amount: BigInt(body.amount),
		destinationDomain: Number(decoded.destinationDomain),
		mintRecipient: addressToBytes32(body.mintRecipient),
		sender: body.messageSender,
		minFinalityThreshold: decoded.minFinalityThreshold
			? Number(decoded.minFinalityThreshold)
			: undefined,
		maxFee: body.maxFee ? BigInt(body.maxFee) : undefined,
	};
}

/** Build a persisted record for a transfer that was not started by this kit. */
export function buildImportedRecord(args: {
	network: Network;
	chains: ChainDefinition[];
	from: ChainDefinition;
	txHash: string;
	details: BurnDetails;
	message?: IrisMessage | null;
	now?: number;
	/** Recipient wallet when it differs from the raw mint recipient (Solana: the token account's owner). */
	recipient?: string;
	/** When the burn was confirmed on the source chain; the wait timer counts from here. */
	burnedAt?: number;
}): TransferRecord {
	const now = args.now ?? Date.now();
	const to = args.chains.find((c) => c.domain === args.details.destinationDomain);
	if (!to) {
		throw new Error(
			`Destination domain ${args.details.destinationDomain} is not enabled in this kit`,
		);
	}
	const speed: TransferSpeed = args.details.minFinalityThreshold === 1000 ? 'fast' : 'standard';
	const attested =
		!!args.message &&
		args.message.status === 'complete' &&
		typeof args.message.attestation === 'string' &&
		args.message.attestation.startsWith('0x') &&
		!!args.message.message &&
		args.message.message.length > 2;

	return {
		id: `import-${args.txHash.slice(0, 12)}-${now.toString(36)}`,
		network: args.network,
		from: args.from.key,
		to: to.key,
		amount: args.details.amount.toString(),
		maxFee: (args.details.maxFee ?? 0n).toString(),
		speed,
		sender: normalizeSender(args.details.sender, args.from),
		recipient: args.recipient ?? fromBytes32(args.details.mintRecipient, to),
		status: attested ? 'readyToMint' : 'attesting',
		sourceTxHash: args.txHash,
		message: attested ? args.message!.message : undefined,
		attestation: attested ? args.message!.attestation : undefined,
		createdAt: args.burnedAt ?? now,
		updatedAt: now,
		// What was burned was read from Circle, or from a transaction that succeeded on its chain.
		sourceConfirmed: true,
		burnedAt: args.burnedAt,
		attestingSince: args.burnedAt ?? now,
	};
}

/**
 * Circle decodes addresses to the chain's native format (20-byte EVM address, 32-byte Sui
 * address, base58 Solana key). Bring any of those back to the 32-byte CCTP field.
 */
export function addressToBytes32(value: string): Uint8Array {
	if (/^0x[0-9a-fA-F]{64}$/.test(value)) return hexToBytes(value);
	if (/^0x[0-9a-fA-F]{40}$/.test(value)) {
		const out = new Uint8Array(32);
		out.set(hexToBytes(value), 12);
		return out;
	}
	try {
		const bytes = fromBase58(value);
		if (bytes.length === 32) return bytes;
	} catch {
		// not base58
	}
	throw new Error(`Unrecognised address format: ${value}`);
}

function normalizeSender(sender: string | undefined, from: ChainDefinition): string {
	if (!sender) return '';
	// Iris reports the message sender as a 32-byte value; EVM callers expect a 20-byte address.
	if (from.ecosystem === 'evm' && /^0x[0-9a-fA-F]{64}$/.test(sender)) {
		return fromBytes32(hexToBytes(sender), from);
	}
	if (from.ecosystem === 'evm' && isHexAddress(sender)) return sender;
	return sender;
}
