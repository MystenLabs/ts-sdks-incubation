// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { getChainRegistry } from '../../src/chains/index.js';
import { feeFromBps, formatUsdc, parseUsdc } from '../../src/utils/amount.js';
import {
	bytesToHex,
	fromBytes32,
	hexToBytes,
	isValidAddress,
	MESSAGE_V2,
	parseMessageV2,
	toBytes32,
} from '../../src/utils/bytes.js';

const chains = getChainRegistry('mainnet');
const evm = chains.find((c) => c.key === 'base')!;
const sui = chains.find((c) => c.key === 'sui')!;
const solana = chains.find((c) => c.key === 'solana')!;

describe('amount', () => {
	it('parses and formats USDC', () => {
		expect(parseUsdc('1')).toBe(1_000_000n);
		expect(parseUsdc('0.5')).toBe(500_000n);
		expect(parseUsdc('12.345678')).toBe(12_345_678n);
		expect(() => parseUsdc('1.2345678')).toThrow();
		expect(() => parseUsdc('abc')).toThrow();
		expect(formatUsdc(1_000_000n)).toBe('1');
		expect(formatUsdc(1_234_500n)).toBe('1.2345');
		expect(formatUsdc('10')).toBe('0.00001');
	});

	it('rounds fees up', () => {
		expect(feeFromBps(1_000_000n, 1)).toBe(100n);
		expect(feeFromBps(1n, 1)).toBe(1n);
		expect(feeFromBps(1_000_000n, 0)).toBe(0n);
	});
});

describe('bytes32 encoding', () => {
	it('left-pads EVM addresses', () => {
		const hex = bytesToHex(toBytes32('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', evm));
		expect(hex).toBe('0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
		expect(fromBytes32(hexToBytes(hex), evm)).toBe('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
	});

	it('normalises short Sui addresses to 32 bytes', () => {
		expect(bytesToHex(toBytes32('0x' + '0'.repeat(63) + '6', sui))).toBe(`0x${'0'.repeat(63)}6`);
		expect(() => toBytes32('0x6', sui)).toThrow(/Invalid Sui address/);
	});

	it('round-trips Solana public keys', () => {
		const key = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
		expect(fromBytes32(toBytes32(key, solana), solana)).toBe(key);
	});

	it('validates per ecosystem', () => {
		expect(isValidAddress('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', evm)).toBe(true);
		expect(isValidAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', evm)).toBe(false);
		expect(isValidAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', solana)).toBe(true);
		// A truncated Sui address must not pass: the SDK requires the full 32 bytes.
		expect(isValidAddress('0xdeadbeef', sui)).toBe(false);
		expect(isValidAddress('0x' + 'ab'.repeat(32), sui)).toBe(true);
		// Mixed-case EVM addresses must carry a valid checksum.
		expect(isValidAddress('0xA0B86991c6218b36c1d19D4a2e9Eb0cE3606eB48', evm)).toBe(false);
	});
});

describe('parseMessageV2', () => {
	it('decodes header and burn body fields', () => {
		const header = new Uint8Array(MESSAGE_V2.body);
		const view = new DataView(header.buffer);
		view.setUint32(MESSAGE_V2.version, 1);
		view.setUint32(MESSAGE_V2.sourceDomain, 8);
		view.setUint32(MESSAGE_V2.destinationDomain, 6);
		header.fill(0xab, MESSAGE_V2.nonce, MESSAGE_V2.nonce + 32);
		view.setUint32(MESSAGE_V2.minFinalityThreshold, 2000);
		view.setUint32(MESSAGE_V2.finalityThresholdExecuted, 2000);

		const body = new Uint8Array(MESSAGE_V2.bodyFields.hookData + 3);
		const bodyView = new DataView(body.buffer);
		bodyView.setUint32(MESSAGE_V2.bodyFields.version, 1);
		body.set(
			toBytes32('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', evm),
			MESSAGE_V2.bodyFields.burnToken,
		);
		body[MESSAGE_V2.bodyFields.amount + 31] = 7;
		body.set([1, 2, 3], MESSAGE_V2.bodyFields.hookData);

		const message = new Uint8Array(header.length + body.length);
		message.set(header);
		message.set(body, header.length);

		const parsed = parseMessageV2(bytesToHex(message));
		expect(parsed.version).toBe(1);
		expect(parsed.sourceDomain).toBe(8);
		expect(parsed.destinationDomain).toBe(6);
		expect(parsed.nonce.every((b) => b === 0xab)).toBe(true);
		expect(parsed.minFinalityThreshold).toBe(2000);
		expect(parsed.body.amount).toBe(7n);
		expect(fromBytes32(parsed.body.burnToken, evm)).toBe(
			'0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
		);
		expect(Array.from(parsed.body.hookData)).toEqual([1, 2, 3]);
	});
});

describe('formatDuration', () => {
	it('picks a unit from the upper bound and collapses tight ranges', async () => {
		const { formatDuration } = await import('../../src/utils/duration.js');
		expect(formatDuration(5, 12)).toBe('5 to 12 seconds');
		expect(formatDuration(3, 20)).toBe('3 to 20 seconds');
		expect(formatDuration(20, 40)).toBe('20 to 40 seconds');
		expect(formatDuration(900, 1140)).toBe('15 to 19 minutes');
		expect(formatDuration(1500, 2100)).toBe('25 to 35 minutes');
		expect(formatDuration(21600, 115200)).toBe('6 to 32 hours');
		expect(formatDuration(1, 5)).toBe('1 to 5 seconds');
		expect(formatDuration(8, 8)).toBe('~8 seconds');
		expect(formatDuration(5, 6)).toBe('~6 seconds');
		expect(formatDuration(68, 68)).toBe('~1 minute');
		expect(formatDuration(45, 90)).toBe('~2 minutes');
	});
});

describe('wait progress', () => {
	it('formats elapsed time and remaining ranges', async () => {
		const { formatElapsed, waitProgress } = await import('../../src/utils/duration.js');
		expect(formatElapsed(0)).toBe('0:00');
		expect(formatElapsed(252)).toBe('4:12');
		expect(formatElapsed(3728)).toBe('1:02:08');
		const start = 1_000_000;
		const p = waitProgress(start, 900, 1140, start + 252_000);
		expect(Math.round(p.elapsedSeconds)).toBe(252);
		expect(p.remaining).toBe('11 to 15 minutes');
		expect(p.overdue).toBe(false);
		expect(p.fraction).toBeCloseTo(252 / 1140, 3);
		const late = waitProgress(start, 900, 1140, start + 1_000_000);
		expect(late.remaining).toBe('up to 2 minutes');
		const over = waitProgress(start, 900, 1140, start + 2_000_000);
		expect(over.overdue).toBe(true);
		expect(over.remaining).toBeNull();
		expect(over.fraction).toBe(1);
	});
});
