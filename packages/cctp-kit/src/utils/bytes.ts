// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { isValidSuiAddress, normalizeSuiAddress } from '@mysten/sui/utils';
import { fromBase58, toBase58 } from '@mysten/sui/utils';
import { getAddress, isAddress } from 'viem';
import type { ChainDefinition } from '../chains/types.js';

export type Hex = `0x${string}`;

export function hexToBytes(hex: string): Uint8Array {
	const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
	if (clean.length % 2 !== 0) throw new Error('Invalid hex string length');
	const out = new Uint8Array(clean.length / 2);
	for (let i = 0; i < out.length; i++) {
		const byte = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
		if (Number.isNaN(byte)) throw new Error('Invalid hex string');
		out[i] = byte;
	}
	return out;
}

export function bytesToHex(bytes: Uint8Array): Hex {
	let out = '';
	for (const b of bytes) out += b.toString(16).padStart(2, '0');
	return `0x${out}`;
}

/** 20-byte EVM address; mixed-case input must carry a valid EIP-55 checksum. */
export function isHexAddress(value: string): value is Hex {
	return isAddress(value, { strict: true });
}

/** Full 32-byte Sui address (the SDK's rule), so a truncated paste never passes. */
export function isSuiAddress(value: string): boolean {
	return isValidSuiAddress(value);
}

export function isSolanaAddress(value: string): boolean {
	try {
		return fromBase58(value).length === 32;
	} catch {
		return false;
	}
}

/**
 * Encode a destination address as the 32-byte `mintRecipient` CCTP expects:
 * EVM addresses are left-padded with zeros, Sui addresses are already 32 bytes,
 * Solana addresses are base58-decoded public keys.
 */
export function toBytes32(address: string, chain: ChainDefinition): Uint8Array {
	switch (chain.ecosystem) {
		case 'evm': {
			if (!isHexAddress(address)) throw new Error(`Invalid EVM address: ${address}`);
			const out = new Uint8Array(32);
			out.set(hexToBytes(address), 12);
			return out;
		}
		case 'sui': {
			if (!isSuiAddress(address)) throw new Error(`Invalid Sui address: ${address}`);
			return hexToBytes(normalizeSuiAddress(address).slice(2));
		}
		case 'solana': {
			if (!isSolanaAddress(address)) throw new Error(`Invalid Solana address: ${address}`);
			return fromBase58(address);
		}
	}
}

export function bytes32ToHex(address: string, chain: ChainDefinition): Hex {
	return bytesToHex(toBytes32(address, chain));
}

/** Decode a 32-byte CCTP address field back into the chain's native address format. */
export function fromBytes32(bytes: Uint8Array, chain: ChainDefinition): string {
	if (bytes.length !== 32) throw new Error('Expected 32 bytes');
	switch (chain.ecosystem) {
		case 'evm':
			return bytesToHex(bytes.slice(12));
		case 'sui':
			return bytesToHex(bytes);
		case 'solana':
			return toBase58(bytes);
	}
}

/** Canonical form for storage: checksummed EVM, normalised Sui, Solana as given. */
export function normalizeAddress(address: string, chain: ChainDefinition): string {
	switch (chain.ecosystem) {
		case 'evm':
			return getAddress(address);
		case 'sui':
			return normalizeSuiAddress(address);
		case 'solana':
			return address;
	}
}

export function isValidAddress(address: string, chain: ChainDefinition): boolean {
	switch (chain.ecosystem) {
		case 'evm':
			return isHexAddress(address);
		case 'sui':
			return isSuiAddress(address);
		case 'solana':
			return isSolanaAddress(address);
	}
}

/** Offsets of fields in a CCTP v2 message (identical across EVM, Sui and Solana). */
export const MESSAGE_V2 = {
	version: 0,
	sourceDomain: 4,
	destinationDomain: 8,
	nonce: 12,
	sender: 44,
	recipient: 76,
	destinationCaller: 108,
	minFinalityThreshold: 140,
	finalityThresholdExecuted: 144,
	body: 148,
	/** Offsets inside the BurnMessage body. */
	bodyFields: {
		version: 0,
		burnToken: 4,
		mintRecipient: 36,
		amount: 68,
		messageSender: 100,
		maxFee: 132,
		feeExecuted: 164,
		expirationBlock: 196,
		hookData: 228,
	},
} as const;

export interface ParsedMessageV2 {
	version: number;
	sourceDomain: number;
	destinationDomain: number;
	nonce: Uint8Array;
	sender: Uint8Array;
	recipient: Uint8Array;
	destinationCaller: Uint8Array;
	minFinalityThreshold: number;
	finalityThresholdExecuted: number;
	body: {
		version: number;
		burnToken: Uint8Array;
		mintRecipient: Uint8Array;
		amount: bigint;
		messageSender: Uint8Array;
		maxFee: bigint;
		feeExecuted: bigint;
		expirationBlock: bigint;
		hookData: Uint8Array;
	};
}

function u32(bytes: Uint8Array, offset: number): number {
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);
}

function u256(bytes: Uint8Array, offset: number): bigint {
	let value = 0n;
	for (let i = 0; i < 32; i++) value = (value << 8n) | BigInt(bytes[offset + i]!);
	return value;
}

/**
 * Whether these bytes are a CCTP v2 burn message for `destinationDomain`. For picking the
 * message out of what a claim transaction was given.
 */
export function isMessageV2For(bytes: Uint8Array, destinationDomain: number): boolean {
	if (bytes.length < MESSAGE_V2.body + MESSAGE_V2.bodyFields.hookData) return false;
	return (
		u32(bytes, MESSAGE_V2.version) === 1 &&
		u32(bytes, MESSAGE_V2.destinationDomain) === destinationDomain
	);
}

export function parseMessageV2(messageHex: string): ParsedMessageV2 {
	const bytes = hexToBytes(messageHex);
	const bf = MESSAGE_V2.bodyFields;
	const body = bytes.slice(MESSAGE_V2.body);
	if (body.length < bf.hookData) throw new Error('Message body too short for a BurnMessage');
	return {
		version: u32(bytes, MESSAGE_V2.version),
		sourceDomain: u32(bytes, MESSAGE_V2.sourceDomain),
		destinationDomain: u32(bytes, MESSAGE_V2.destinationDomain),
		nonce: bytes.slice(MESSAGE_V2.nonce, MESSAGE_V2.nonce + 32),
		sender: bytes.slice(MESSAGE_V2.sender, MESSAGE_V2.sender + 32),
		recipient: bytes.slice(MESSAGE_V2.recipient, MESSAGE_V2.recipient + 32),
		destinationCaller: bytes.slice(MESSAGE_V2.destinationCaller, MESSAGE_V2.destinationCaller + 32),
		minFinalityThreshold: u32(bytes, MESSAGE_V2.minFinalityThreshold),
		finalityThresholdExecuted: u32(bytes, MESSAGE_V2.finalityThresholdExecuted),
		body: {
			version: u32(body, bf.version),
			burnToken: body.slice(bf.burnToken, bf.burnToken + 32),
			mintRecipient: body.slice(bf.mintRecipient, bf.mintRecipient + 32),
			amount: u256(body, bf.amount),
			messageSender: body.slice(bf.messageSender, bf.messageSender + 32),
			maxFee: u256(body, bf.maxFee),
			feeExecuted: u256(body, bf.feeExecuted),
			expirationBlock: u256(body, bf.expirationBlock),
			hookData: body.slice(bf.hookData),
		},
	};
}
