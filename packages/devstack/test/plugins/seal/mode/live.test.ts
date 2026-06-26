// Regression tests for `seal/mode/live.ts:validateLiveInputs`.
//
// Pins the locked-decision resolution rules:
//   - testnet zero-config = BOTH independent servers (weight 1 each).
//   - `{ server: 'committee' }` resolves the testnet committee (no apiKey).
//   - mainnet default = committee, which REQUIRES the non-secret `apiKeyName`
//     (throws otherwise); the secret apiKey VALUE is never carried by devstack.
//   - a committee resolve emits `apiKeyName` (never an apiKey) on the entry.
//   - a verbatim `serverConfigs` override that embeds an `apiKey` is rejected.
//   - `mainnet({ server: 'independent' })` throws (none ships).
//   - a verbatim `serverConfigs` override wins.
//   - `verifyKeyServers` defaults to `true` on a live resolve; honored when set.
//
// `validateLiveInputs` is a synchronous pure function — no Effect
// harness required.

import { describe, expect, it } from 'vitest';

import { KNOWN_DEPLOYMENTS, validateLiveInputs } from '../../../../src/plugins/seal/mode/live.ts';

const TESTNET_INDEP_1 = '0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75';
const TESTNET_INDEP_2 = '0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8';
const TESTNET_COMMITTEE = '0xb012378c9f3799fb5b1a7083da74a4069e3c3f1c93de0b27212a5799ce1e1e98';
const MAINNET_COMMITTEE = '0x686098f1439237fff9f36b99c7329683c22979d2005c2465cb891acb012a7595';

describe('KNOWN_DEPLOYMENTS — shape', () => {
	it('testnet ships BOTH independent servers, weight defaults via resolution', () => {
		expect(KNOWN_DEPLOYMENTS.testnet.independent?.map((s) => s.objectId)).toEqual([
			TESTNET_INDEP_1,
			TESTNET_INDEP_2,
		]);
		expect(KNOWN_DEPLOYMENTS.testnet.defaultServer).toBe('independent');
	});

	it('testnet committee is 3-of-5 with a testnet aggregator and no apiKey', () => {
		const c = KNOWN_DEPLOYMENTS.testnet.committee;
		expect(c?.objectId).toBe(TESTNET_COMMITTEE);
		expect(c?.aggregatorUrl).toBe('https://seal-aggregator-testnet.mystenlabs.com');
		expect(c?.threshold).toEqual({ m: 3, n: 5 });
		expect(c?.requiresApiKey).toBe(false);
	});

	it('mainnet has NO independent default and a 5-of-8 committee requiring credentials', () => {
		expect(KNOWN_DEPLOYMENTS.mainnet.independent).toBeNull();
		expect(KNOWN_DEPLOYMENTS.mainnet.defaultServer).toBe('committee');
		const c = KNOWN_DEPLOYMENTS.mainnet.committee;
		expect(c?.objectId).toBe(MAINNET_COMMITTEE);
		expect(c?.aggregatorUrl).toBe('https://seal-aggregator-mainnet.mystenlabs.com');
		expect(c?.threshold).toEqual({ m: 5, n: 8 });
		expect(c?.requiresApiKey).toBe(true);
	});

	it('does not carry the stale seal-keyserver.testnet URL anywhere', () => {
		expect(JSON.stringify(KNOWN_DEPLOYMENTS)).not.toContain('seal-keyserver.testnet');
	});
});

describe('validateLiveInputs — testnet (independent default)', () => {
	it('zero-config resolves BOTH independent servers, weight 1 each', () => {
		const r = validateLiveInputs({ name: 'seal', network: 'testnet' });
		expect(r.serverConfigs).toEqual([
			{ objectId: TESTNET_INDEP_1, weight: 1 },
			{ objectId: TESTNET_INDEP_2, weight: 1 },
		]);
		// Legacy single fields derive from serverConfigs[0] / the chosen url.
		expect(r.objectId).toBe(TESTNET_INDEP_1);
		expect(r.keyServerUrl).toBe('https://seal-key-server-testnet-1.mystenlabs.com');
	});
});

describe('validateLiveInputs — committee opt-in', () => {
	it('testnet committee resolves a single entry with aggregatorUrl, no apiKey', () => {
		const r = validateLiveInputs({ name: 'seal', network: 'testnet', server: 'committee' });
		expect(r.serverConfigs).toEqual([
			{
				objectId: TESTNET_COMMITTEE,
				weight: 1,
				aggregatorUrl: 'https://seal-aggregator-testnet.mystenlabs.com',
			},
		]);
		expect(r.keyServerUrl).toBe('https://seal-aggregator-testnet.mystenlabs.com');
	});

	it('mainnet committee with apiKeyName carries the NON-secret name and NO apiKey', () => {
		const r = validateLiveInputs({
			name: 'seal',
			network: 'mainnet',
			apiKeyName: 'X-API-Key',
		});
		expect(r.serverConfigs).toEqual([
			{
				objectId: MAINNET_COMMITTEE,
				weight: 1,
				aggregatorUrl: 'https://seal-aggregator-mainnet.mystenlabs.com',
				apiKeyName: 'X-API-Key',
			},
		]);
		// devstack never carries the secret apiKey VALUE — the app injects it at
		// runtime when constructing SealClient (committed config + deployment.json
		// are world-readable).
		expect(r.serverConfigs[0]).not.toHaveProperty('apiKey');
		expect(JSON.stringify(r.serverConfigs)).not.toContain('apiKey"');
	});
});

describe('validateLiveInputs — config errors', () => {
	it('mainnet committee WITHOUT apiKeyName is a SealConfigError (field apiKeyName)', () => {
		let thrown: unknown = null;
		try {
			validateLiveInputs({ name: 'seal', network: 'mainnet' });
		} catch (err) {
			thrown = err;
		}
		expect((thrown as { _tag?: string } | null)?._tag).toBe('SealConfigError');
		expect((thrown as { field?: string } | null)?.field).toBe('apiKeyName');
	});

	it('a verbatim serverConfigs override that embeds an apiKey is a SealConfigError (field serverConfigs)', () => {
		let thrown: unknown = null;
		try {
			validateLiveInputs({
				name: 'seal',
				serverConfigs: [
					{
						objectId: '0xabc',
						weight: 1,
						aggregatorUrl: 'https://custom.example/agg',
						apiKeyName: 'X-API-Key',
						apiKey: 'secret-key',
					},
				],
			});
		} catch (err) {
			thrown = err;
		}
		expect((thrown as { _tag?: string } | null)?._tag).toBe('SealConfigError');
		expect((thrown as { field?: string } | null)?.field).toBe('serverConfigs');
	});

	it('mainnet({ server: independent }) throws (none ships)', () => {
		let thrown: unknown = null;
		try {
			validateLiveInputs({ name: 'seal', network: 'mainnet', server: 'independent' });
		} catch (err) {
			thrown = err;
		}
		expect((thrown as { _tag?: string } | null)?._tag).toBe('SealConfigError');
		expect((thrown as { field?: string } | null)?.field).toBe('server');
	});

	it('an unknown network with no serverConfigs is a SealConfigError', () => {
		let thrown: unknown = null;
		try {
			validateLiveInputs({ name: 'seal', network: 'devnet' });
		} catch (err) {
			thrown = err;
		}
		expect((thrown as { _tag?: string } | null)?._tag).toBe('SealConfigError');
	});
});

describe('validateLiveInputs — verbatim serverConfigs override', () => {
	it('uses caller-supplied serverConfigs and derives legacy fields', () => {
		const r = validateLiveInputs({
			name: 'seal',
			serverConfigs: [
				{ objectId: '0xdef', weight: 2, aggregatorUrl: 'https://custom.example/agg' },
			],
		});
		expect(r.serverConfigs).toEqual([
			{ objectId: '0xdef', weight: 2, aggregatorUrl: 'https://custom.example/agg' },
		]);
		expect(r.objectId).toBe('0xdef');
		expect(r.keyServerUrl).toBe('https://custom.example/agg');
	});

	it('an empty serverConfigs override is a SealConfigError', () => {
		let thrown: unknown = null;
		try {
			validateLiveInputs({ name: 'seal', serverConfigs: [] });
		} catch (err) {
			thrown = err;
		}
		expect((thrown as { _tag?: string } | null)?._tag).toBe('SealConfigError');
	});
});

describe('validateLiveInputs — verifyKeyServers resolution', () => {
	it('defaults to true for a live testnet resolve (real Mysten servers)', () => {
		const r = validateLiveInputs({ name: 'seal', network: 'testnet' });
		expect(r.verifyKeyServers).toBe(true);
	});

	it('defaults to true for a live mainnet committee resolve', () => {
		const r = validateLiveInputs({ name: 'seal', network: 'mainnet', apiKeyName: 'X-API-Key' });
		expect(r.verifyKeyServers).toBe(true);
	});

	it('honors an explicit { verifyKeyServers: false }', () => {
		const r = validateLiveInputs({
			name: 'seal',
			network: 'testnet',
			verifyKeyServers: false,
		});
		expect(r.verifyKeyServers).toBe(false);
	});
});
