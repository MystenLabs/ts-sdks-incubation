import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit, Option, Schema } from 'effect';

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

	// -------------------------------------------------------------------------
	// `isNotFound` discrimination — separates terminal "the object/tx does
	// not exist on chain" errors from transient "the endpoint/network is
	// flaky" errors. Pre-fix, the substring heuristic matched the bare
	// "not found" / "not exist" tokens, which also fire on network-layer
	// errors like "endpoint does not exist" — those got misclassified as
	// terminal and never retried. Post-fix, the patterns require the
	// "object" / "transaction" / "no such object" anchors so endpoint and
	// DNS prose stay in the transient bucket.
	// -------------------------------------------------------------------------

	describe('not-found vs transient classification (lenient null-coercion)', () => {
		it.effect('classifies "object not found" as terminal (lenient → null, no retry)', () =>
			Effect.gen(function* () {
				const sdk = sdkWithCore({
					getObject: async () => {
						throw new Error('Object 0xabc not found at version 42');
					},
				});
				const probe = makeSuiChainProbe(sdk, 'sui:localnet');

				// Lenient mode coerces BOTH not-found and transient to
				// null, so the surface signal here is "did the probe
				// surface null cleanly". The discriminator matters at the
				// strict-mode boundary — which we exercise below.
				const lenientResult = yield* probe.get(
					{ kind: 'object', objectId: '0xabc' },
					ProbeObjectShape,
					'lenient',
				);
				expect(lenientResult).toBeNull();
			}),
		);

		it.effect('classifies "object does not exist" as terminal under strict mode', () =>
			Effect.gen(function* () {
				const sdk = sdkWithCore({
					getObject: async () => {
						throw new Error('Object 0xdeadbeef does not exist');
					},
				});
				const probe = makeSuiChainProbe(sdk, 'sui:localnet');
				const exit = yield* probe
					.get({ kind: 'object', objectId: '0xdeadbeef' }, ProbeObjectShape, 'strict')
					.pipe(Effect.exit);
				const err = Exit.findErrorOption(exit);
				expect(Option.isSome(err)).toBe(true);
				if (Option.isSome(err)) expect(err.value.reason).toBe('not-found');
			}),
		);

		it.effect(
			'classifies network "endpoint does not exist" as TRANSIENT (does NOT misclassify as terminal)',
			() =>
				// Regression: pre-fix the bare "does not exist" substring
				// match caught endpoint/DNS prose and misclassified
				// network-layer errors as terminal. Post-fix, the pattern
				// requires the object/transaction anchor.
				Effect.gen(function* () {
					const sdk = sdkWithCore({
						getObject: async () => {
							throw new Error('grpc endpoint does not exist: connection refused');
						},
					});
					const probe = makeSuiChainProbe(sdk, 'sui:localnet');
					const exit = yield* probe
						.get({ kind: 'object', objectId: '0xnetfail' }, ProbeObjectShape, 'strict')
						.pipe(Effect.exit);
					const err = Exit.findErrorOption(exit);
					expect(Option.isSome(err)).toBe(true);
					if (Option.isSome(err)) expect(err.value.reason).toBe('transient');
				}),
		);

		it.effect(
			'classifies bare "not found" in stack-trace prose as TRANSIENT (not terminal)',
			() =>
				// Regression: pre-fix matched bare `not found` anywhere in
				// the message. Random library stack traces sometimes carry
				// "Could not bind port ... not found" or similar; those
				// must stay in the transient bucket so the substrate's
				// lenient retry can re-probe.
				Effect.gen(function* () {
					const sdk = sdkWithCore({
						getObject: async () => {
							throw new Error(
								'TypeError: Cannot read properties of undefined (reading "not found")',
							);
						},
					});
					const probe = makeSuiChainProbe(sdk, 'sui:localnet');
					const exit = yield* probe
						.get({ kind: 'object', objectId: '0xstacktrace' }, ProbeObjectShape, 'strict')
						.pipe(Effect.exit);
					const err = Exit.findErrorOption(exit);
					expect(Option.isSome(err)).toBe(true);
					if (Option.isSome(err)) expect(err.value.reason).toBe('transient');
				}),
		);

		it.effect('classifies "transaction not found" as terminal', () =>
			Effect.gen(function* () {
				const sdk = sdkWithCore({
					getTransaction: async () => {
						throw new Error('Transaction abc123 not found');
					},
				});
				const probe = makeSuiChainProbe(sdk, 'sui:localnet');
				const exit = yield* probe
					.get({ kind: 'transaction', digest: 'abc123' }, ProbeTransactionShape, 'strict')
					.pipe(Effect.exit);
				const err = Exit.findErrorOption(exit);
				expect(Option.isSome(err)).toBe(true);
				if (Option.isSome(err)) expect(err.value.reason).toBe('not-found');
			}),
		);

		it.effect('classifies "no such object" as terminal', () =>
			Effect.gen(function* () {
				const sdk = sdkWithCore({
					getObject: async () => {
						throw new Error('No such object: 0xfeed');
					},
				});
				const probe = makeSuiChainProbe(sdk, 'sui:localnet');
				const exit = yield* probe
					.get({ kind: 'object', objectId: '0xfeed' }, ProbeObjectShape, 'strict')
					.pipe(Effect.exit);
				const err = Exit.findErrorOption(exit);
				expect(Option.isSome(err)).toBe(true);
				if (Option.isSome(err)) expect(err.value.reason).toBe('not-found');
			}),
		);
	});
});
