// Regression test for C5: substrate `executeSuiTx` surfaces on-chain
// `FailedTransaction` as a RETURN-channel variant. The deepbook
// `createDeepbookPools` caller MUST dispatch on `$kind` and map the
// FailedTransaction to a plugin-shaped `DeepbookPluginError` (via the
// ArtifactPublishError → mapArtifactError path) carrying the digest +
// execution error.

import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit, Option, type Scope } from 'effect';
import { vi } from 'vitest';

vi.mock('@mysten/sui/transactions', () => ({
	Transaction: class {
		setSender(_address: string): void {}
		setGasBudget(_value: number | bigint): void {}
		moveCall(_input: unknown): unknown {
			return { kind: 'movecall-result' };
		}
		object(id: string): unknown {
			return { kind: 'object', id };
		}
		readonly pure = {
			u64: (value: bigint | number) => ({ kind: 'u64', value }),
			bool: (value: boolean) => ({ kind: 'bool', value }),
		};
		build(): Promise<Uint8Array> {
			return Promise.resolve(new Uint8Array([7, 7, 7]));
		}
	},
}));

import type { ResolvedSigner } from '../../../src/substrate/runtime/sui-execute/index.ts';
import type { SuiSdkShim } from '../../../src/plugins/sui/index.ts';
import type {
	ArtifactPublisher,
	ArtifactPublishError,
} from '../../../src/primitives/artifact-publisher.ts';
import {
	createDeepbookPools,
	type DeepbookDeployment,
	type ResolvedDeepbookPoolSpec,
} from '../../../src/plugins/deepbook/deploy.ts';

const stubSigner: ResolvedSigner = {
	name: 'deepbook-admin',
	address: '0xdeep-admin',
	signTransaction: () => Effect.succeed({ bytes: 'aa', signature: 'sig' }),
	withTransactionSigner: (body) =>
		body({
			signTransaction: () => Effect.succeed({ bytes: 'aa', signature: 'sig' }),
		}),
};

const stubSdk = (executeResult: unknown): SuiSdkShim =>
	({
		client: {
			core: {
				simulateTransaction: async () => ({ commandResults: [] }),
				executeTransaction: async () => executeResult,
				waitForTransaction: async () => undefined,
			},
		},
		core: {
			simulateTransaction: async () => ({ commandResults: [] }),
			executeTransaction: async () => executeResult,
			waitForTransaction: async () => undefined,
		},
	}) as unknown as SuiSdkShim;

// Pass-through publisher: run `produce`, propagate its error/value
// verbatim — bypasses cache + verify since we want to assert the
// produce body's dispatch on $kind.
const passthroughPublisher: ArtifactPublisher = {
	publish: <Produced>(spec: {
		readonly produce: Effect.Effect<Produced, ArtifactPublishError, Scope.Scope>;
	}) => spec.produce,
} as unknown as ArtifactPublisher;

const deployment: DeepbookDeployment = {
	packageId: '0xpkg',
	registryId: '0xreg',
	adminCapId: '0xcap',
};

const pools: ReadonlyArray<ResolvedDeepbookPoolSpec> = [
	{
		name: 'usdc-sui',
		base: 'sui',
		quote: 'usdc',
		baseCoinType: '0x2::sui::SUI',
		quoteCoinType: '0xusdc::usdc::USDC',
		tickSize: 1n,
		lotSize: 1n,
		minSize: 1n,
		whitelisted: true,
		stablePool: false,
	},
];

describe('deepbook createDeepbookPools — FailedTransaction return dispatch', () => {
	it.effect('maps $kind:"FailedTransaction" to DeepbookPluginError(create-pools) with digest', () =>
		Effect.gen(function* () {
			const sdk = stubSdk({
				$kind: 'FailedTransaction',
				FailedTransaction: {
					digest: '0xbad-pool',
					status: { error: 'MoveAbort(pool::EBadParams)' },
				},
			});
			const exit = yield* Effect.exit(
				createDeepbookPools(
					passthroughPublisher,
					sdk,
					'localnet',
					stubSigner,
					deployment,
					pools,
				).pipe(Effect.scoped),
			);
			expect(Exit.isFailure(exit)).toBe(true);
			const err = Exit.findErrorOption(exit);
			expect(Option.isSome(err)).toBe(true);
			if (Option.isSome(err)) {
				expect(err.value._tag).toBe('DeepbookPluginError');
				expect(err.value.phase).toBe('create-pools');
				expect(err.value.message).toContain('0xbad-pool');
				expect(err.value.message).toContain('MoveAbort');
				expect(err.value.message).toContain('on-chain execution failed');
			}
		}),
	);

	it.effect('still maps transport SuiExecuteError to DeepbookPluginError', () =>
		Effect.gen(function* () {
			const sdk = {
				client: {
					core: {
						simulateTransaction: async () => ({ commandResults: [] }),
						executeTransaction: async () => {
							throw new Error('rpc unreachable');
						},
						waitForTransaction: async () => undefined,
					},
				},
				core: {
					simulateTransaction: async () => ({ commandResults: [] }),
					executeTransaction: async () => {
						throw new Error('rpc unreachable');
					},
				},
			} as unknown as SuiSdkShim;
			const exit = yield* Effect.exit(
				createDeepbookPools(
					passthroughPublisher,
					sdk,
					'localnet',
					stubSigner,
					deployment,
					pools,
				).pipe(Effect.scoped),
			);
			expect(Exit.isFailure(exit)).toBe(true);
			const err = Exit.findErrorOption(exit);
			expect(Option.isSome(err)).toBe(true);
			if (Option.isSome(err)) {
				expect(err.value._tag).toBe('DeepbookPluginError');
				expect(err.value.phase).toBe('create-pools');
				expect(err.value.message).toContain('rpc unreachable');
			}
		}),
	);
});
