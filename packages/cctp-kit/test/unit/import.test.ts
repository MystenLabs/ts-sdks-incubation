// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { getChainRegistry } from '../../src/chains/index.js';
import {
	buildImportedRecord,
	burnDetailsFromIris,
	classifyTxHash,
	resolveSourceChain,
} from '../../src/core/import.js';
import type { IrisMessage } from '../../src/iris/client.js';
import { bytesToHex, toBytes32 } from '../../src/utils/bytes.js';

const chains = getChainRegistry('mainnet');
const ethereum = chains.find((c) => c.key === 'ethereum')!;
const sui = chains.find((c) => c.key === 'sui')!;
const EVM_HASH = '0x3cb8a0da8120eb4c11481b003344ca5c3dae8bd261907ad96775919f06293cee';
const SUI_DIGEST = 'C1v6NwPuxdXmaag9Wjcnq4TX65fh5QQj5nDVaSGeM39M';

describe('classifyTxHash / resolveSourceChain', () => {
	it('classifies by shape', () => {
		expect(classifyTxHash(EVM_HASH)).toBe('evm');
		expect(classifyTxHash(SUI_DIGEST)).toBe('sui');
		expect(classifyTxHash('0'.repeat(88))).toBe('unknown');
		expect(classifyTxHash('nope')).toBe('unknown');
	});

	it('needs a chain for EVM hashes and rejects mismatches', () => {
		expect(() => resolveSourceChain(EVM_HASH, chains)).toThrow(/Select the chain/);
		expect(resolveSourceChain(EVM_HASH, chains, 'base').key).toBe('base');
		expect(resolveSourceChain(SUI_DIGEST, chains).key).toBe('sui');
		expect(() => resolveSourceChain(SUI_DIGEST, chains, 'base')).toThrow(/sui transaction/);
	});
});

describe('addressToBytes32', () => {
	it('accepts native EVM, Sui and Solana formats', async () => {
		const { addressToBytes32 } = await import('../../src/core/import.js');
		expect(bytesToHex(addressToBytes32('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'))).toBe(
			'0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
		);
		expect(addressToBytes32('0x' + 'ab'.repeat(32)).length).toBe(32);
		expect(addressToBytes32('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v').length).toBe(32);
		expect(() => addressToBytes32('nope')).toThrow(/Unrecognised/);
	});
});

describe('buildImportedRecord', () => {
	const recipient = '0xe164189245bd1459c2529e5867031681d87db03aaeeb705571c630b18769297f';
	const attested: IrisMessage = {
		message: '0x' + 'aa'.repeat(200),
		attestation: '0x' + 'bb'.repeat(130),
		eventNonce: '0x' + '11'.repeat(32),
		cctpVersion: 2,
		status: 'complete',
		decodedMessage: {
			sourceDomain: '0',
			destinationDomain: '8',
			nonce: '0x' + '11'.repeat(32),
			sender: '0x28b5a0e9c621a5badaa536219b3a228c8168cf5d',
			recipient: '0x' + '22'.repeat(32),
			destinationCaller: '0x' + '00'.repeat(32),
			minFinalityThreshold: '2000',
			finalityThresholdExecuted: '2000',
			messageBody: '0x',
			decodedMessageBody: {
				burnToken: '0x' + '00'.repeat(12) + 'a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
				mintRecipient: recipient,
				amount: '250000',
				messageSender: '0x' + '00'.repeat(12) + '1254000000000000000000000000000000005a98',
				maxFee: '0',
			},
		},
	};

	it('maps an attested Iris message to a readyToMint record', () => {
		const details = burnDetailsFromIris(attested)!;
		const record = buildImportedRecord({
			network: 'mainnet',
			chains,
			from: ethereum,
			txHash: EVM_HASH,
			details,
			message: attested,
			now: 1_000,
		});
		expect(record.from).toBe('ethereum');
		expect(record.to).toBe('sui');
		expect(record.amount).toBe('250000');
		expect(record.speed).toBe('standard');
		expect(record.recipient).toBe(recipient);
		expect(record.sender).toBe('0x1254000000000000000000000000000000005a98');
		expect(record.status).toBe('readyToMint');
		expect(record.message).toBe(attested.message);
		// Without a known burn time the wait counts from the import.
		expect(record.attestingSince).toBe(1_000);
		const dated = buildImportedRecord({
			network: 'mainnet',
			chains,
			from: ethereum,
			txHash: EVM_HASH,
			details,
			message: attested,
			now: 1_000,
			burnedAt: 500,
		});
		expect(dated.burnedAt).toBe(500);
		// What it describes was read from Circle or from a mined burn, so it is not checked again.
		expect(dated.sourceConfirmed).toBe(true);
		expect(dated.attestingSince).toBe(500);
		expect(dated.createdAt).toBe(500);
		expect(record.sourceTxHash).toBe(EVM_HASH);
	});

	it('falls back to attesting when the message is still pending', () => {
		const pending: IrisMessage = {
			...attested,
			status: 'pending_confirmations',
			attestation: 'PENDING',
			message: '0x',
			decodedMessage: {
				...attested.decodedMessage!,
				destinationDomain: '1',
				decodedMessageBody: {
					...attested.decodedMessage!.decodedMessageBody!,
					mintRecipient: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
					amount: '1',
				},
			},
		};
		const decodedDetails = burnDetailsFromIris(pending)!;
		expect(decodedDetails.mintRecipient.length).toBe(32);
		const record = buildImportedRecord({
			network: 'mainnet',
			chains,
			from: sui,
			txHash: SUI_DIGEST,
			details: {
				amount: 1n,
				destinationDomain: 1,
				mintRecipient: toBytes32('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', ethereum),
			},
			message: pending,
		});
		expect(record.status).toBe('attesting');
		expect(record.to).toBe('avalanche');
		expect(record.recipient).toBe('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
		expect(record.attestation).toBeUndefined();
	});

	it('rejects destinations the kit does not know', () => {
		expect(() =>
			buildImportedRecord({
				network: 'mainnet',
				chains,
				from: ethereum,
				txHash: EVM_HASH,
				details: { amount: 1n, destinationDomain: 99, mintRecipient: new Uint8Array(32) },
			}),
		).toThrow(/Destination domain 99/);
		expect(bytesToHex(new Uint8Array(32)).length).toBe(66);
	});
});
