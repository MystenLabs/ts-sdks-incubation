import { describe, expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';

import { makeSuiChainProbe, type SuiSdkShim } from '../../../src/plugins/sui/chain-probe.ts';

const ProbeObjectShape = Schema.Struct({
	objectId: Schema.String,
	type: Schema.String,
});

const ProbeTransactionShape = Schema.Struct({
	digest: Schema.String,
});

const sdkWithCore = (core: Partial<SuiSdkShim['core']>): SuiSdkShim => ({
	core: {
		getObject: async () => {
			throw new Error('getObject not stubbed');
		},
		getTransaction: async () => {
			throw new Error('getTransaction not stubbed');
		},
		getBalance: async () => {
			throw new Error('getBalance not stubbed');
		},
		listCoins: async () => {
			throw new Error('listCoins not stubbed');
		},
		executeTransaction: async () => ({}),
		waitForTransaction: async () => ({}),
		...core,
	},
	client: {} as never,
});

describe('makeSuiChainProbe', () => {
	it.effect('decodes object probes from the Sui SDK response wrapper', () =>
		Effect.gen(function* () {
			const sdk = sdkWithCore({
				getObject: async ({ objectId }) => ({
					object: {
						objectId,
						type: 'package',
						version: '1',
						owner: { $kind: 'Immutable', Immutable: true },
					},
				}),
			});
			const probe = makeSuiChainProbe(sdk, 'sui:localnet');

			const result = yield* probe.get(
				{ kind: 'object', objectId: '0xabc' },
				ProbeObjectShape,
				'lenient',
			);

			expect(result).toEqual({ objectId: '0xabc', type: 'package' });
		}),
	);

	it.effect('still decodes already-projected object payloads', () =>
		Effect.gen(function* () {
			const sdk = sdkWithCore({
				getObject: async ({ objectId }) => ({
					objectId,
					type: 'package',
				}),
			});
			const probe = makeSuiChainProbe(sdk, 'sui:localnet');

			const result = yield* probe.get(
				{ kind: 'object', objectId: '0xdef' },
				ProbeObjectShape,
				'lenient',
			);

			expect(result).toEqual({ objectId: '0xdef', type: 'package' });
		}),
	);

	it.effect('decodes transaction probes without object projection', () =>
		Effect.gen(function* () {
			const sdk = sdkWithCore({
				getTransaction: async ({ digest }) => ({ digest }),
			});
			const probe = makeSuiChainProbe(sdk, 'sui:localnet');

			const result = yield* probe.get(
				{ kind: 'transaction', digest: 'abc123' },
				ProbeTransactionShape,
				'lenient',
			);

			expect(result).toEqual({ digest: 'abc123' });
		}),
	);

	it.effect('decodes transaction probes from the Sui SDK transaction envelope', () =>
		Effect.gen(function* () {
			const sdk = sdkWithCore({
				getTransaction: async ({ digest }) => ({
					$kind: 'Transaction',
					Transaction: {
						digest,
						status: { success: true },
					},
				}),
			});
			const probe = makeSuiChainProbe(sdk, 'sui:localnet');

			const result = yield* probe.get(
				{ kind: 'transaction', digest: 'abc123' },
				ProbeTransactionShape,
				'lenient',
			);

			expect(result).toEqual({ digest: 'abc123' });
		}),
	);
});
