// Regression tests for `seal/mode/live.ts:validateLiveInputs`.
//
// Pins:
//   - the testnet known deployment carries NO `keyServerObjectId`
//     until a real id is sourced; callers MUST supply one.
//   - explicit overrides flow through verbatim.
//
// `validateLiveInputs` is a synchronous pure function — no Effect
// harness required.

import { describe, expect, it } from 'vitest';

import { KNOWN_DEPLOYMENTS, validateLiveInputs } from '../../../../src/plugins/seal/mode/live.ts';

describe('KNOWN_DEPLOYMENTS — testnet entry shape', () => {
	it('testnet.keyServerObjectId is null until a real id is sourced', () => {
		expect(KNOWN_DEPLOYMENTS.testnet.keyServerObjectId).toBeNull();
	});

	it('testnet.keyServerUrl is the public mysten-testnet-1 endpoint', () => {
		expect(KNOWN_DEPLOYMENTS.testnet.keyServerUrl).toBe(
			'https://seal-keyserver.testnet.mystenlabs.com',
		);
	});
});

describe('validateLiveInputs — testnet without override', () => {
	it('throws SealConfigError when no objectId is supplied', () => {
		let thrown: unknown = null;
		try {
			validateLiveInputs({ name: 'seal', network: 'testnet' });
		} catch (err) {
			thrown = err;
		}
		expect(thrown).not.toBeNull();
		expect(typeof thrown).toBe('object');
		expect((thrown as { _tag?: string })._tag).toBe('SealConfigError');
		expect((thrown as { field?: string }).field).toBe('objectId');
	});
});

describe('validateLiveInputs — explicit overrides', () => {
	it('uses caller-supplied objectId + keyServerUrl when both are present', () => {
		const result = validateLiveInputs({
			name: 'seal',
			network: 'testnet',
			objectId: '0xabc',
			keyServerUrl: 'https://override.example/keyserver',
		});
		expect(result.objectId).toBe('0xabc');
		expect(result.keyServerUrl).toBe('https://override.example/keyserver');
	});

	it('uses caller-supplied objectId with the network-default URL', () => {
		const result = validateLiveInputs({
			name: 'seal',
			network: 'testnet',
			objectId: '0xabc',
		});
		expect(result.objectId).toBe('0xabc');
		expect(result.keyServerUrl).toBe(KNOWN_DEPLOYMENTS.testnet.keyServerUrl);
	});

	it('accepts a fully-custom configuration (no network)', () => {
		const result = validateLiveInputs({
			name: 'seal',
			objectId: '0xdef',
			keyServerUrl: 'https://custom.example/keyserver',
		});
		expect(result.objectId).toBe('0xdef');
		expect(result.keyServerUrl).toBe('https://custom.example/keyserver');
	});
});

describe('validateLiveInputs — mainnet / devnet', () => {
	it('mainnet without overrides throws SealConfigError (entry is null)', () => {
		let thrown: unknown = null;
		try {
			validateLiveInputs({ name: 'seal', network: 'mainnet' });
		} catch (err) {
			thrown = err;
		}
		expect((thrown as { _tag?: string } | null)?._tag).toBe('SealConfigError');
	});

	it('devnet without overrides throws SealConfigError (entry is null)', () => {
		let thrown: unknown = null;
		try {
			validateLiveInputs({ name: 'seal', network: 'devnet' });
		} catch (err) {
			thrown = err;
		}
		expect((thrown as { _tag?: string } | null)?._tag).toBe('SealConfigError');
	});
});
