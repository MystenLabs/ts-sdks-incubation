// Regression: `pickCreatedPool` must match each pool spec POSITIONALLY
// against the created `Pool<Base, Quote>` object type. All missing pools
// are created in ONE batched transaction, so the receipt's
// `objectChanges` carries every created pool together. The original
// `type.includes(base) && type.includes(quote)` matcher cross-matched a
// reversed pair (`DEEP/SUI` + `SUI/DEEP`) — both `Pool<…>` changes
// satisfied both specs, so two specs collapsed onto the SAME objectId
// and a real pool was dropped. The fix parses the `Pool<Base, Quote>`
// generic arguments and compares them by position (normalized), so each
// spec resolves to its own pool id.

import { describe, expect, it } from '@effect/vitest';
import { Effect, type Scope } from 'effect';
import { normalizeStructTag } from '@mysten/sui/utils';
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

import type { ResolvedSigner } from '../../../src/plugins/sui/exec/index.ts';
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

// SDK stub: `simulateTransaction` returns no existing pool (empty
// commandResults → `get_pool_id_by_asset` reads as not-found → every
// spec takes the create path), and `executeTransaction` returns the
// supplied success receipt.
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

// Pass-through publisher: run `produce`, propagate its value/error
// verbatim — bypasses cache + verify so we assert the produce body's
// pool-id resolution directly.
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

const DEEP = '0xdeep::deep::DEEP';
const SUI = '0x2::sui::SUI';

// gRPC `objectTypes` are emitted fully address-normalized (the SDK pads
// `0x2` and every package address). Build the receipt's pool type
// strings the same way so the fixture mirrors a real receipt — and so
// the reversed-pair collision is the genuine failure mode the old
// `includes && includes` matcher exhibited.
const poolType = (base: string, quote: string): string =>
	normalizeStructTag(`0xpkg::pool::Pool<${base}, ${quote}>`);

const poolSpec = (
	name: string,
	baseCoinType: string,
	quoteCoinType: string,
): ResolvedDeepbookPoolSpec => ({
	name,
	base: name.split('-')[0] ?? name,
	quote: name.split('-')[1] ?? name,
	baseCoinType,
	quoteCoinType,
	tickSize: 1n,
	lotSize: 1n,
	minSize: 1n,
	whitelisted: true,
	stablePool: false,
});

// A batched-create receipt: one `Created` Pool<…> change per pool, plus
// the registry mutation noise that the real tx also emits.
const createdReceipt = (
	pools: ReadonlyArray<{ readonly objectId: string; readonly poolType: string }>,
) => ({
	$kind: 'Transaction',
	Transaction: {
		digest: '0xbatched-create',
		effects: {
			changedObjects: [
				{ objectId: '0xreg', idOperation: 'Mutated' },
				...pools.map((p) => ({ objectId: p.objectId, idOperation: 'Created' })),
			],
		},
		objectTypes: Object.fromEntries([
			['0xreg', '0xpkg::registry::Registry'],
			...pools.map((p) => [p.objectId, p.poolType] as const),
		]),
	},
});

describe('deepbook createDeepbookPools — positional pool matching', () => {
	it.effect('resolves reversed-pair pools (DEEP/SUI + SUI/DEEP) to distinct pool ids', () =>
		Effect.gen(function* () {
			// Both pools share the exact same coin pair in reversed order.
			// `Pool<DEEP, SUI>` and `Pool<SUI, DEEP>` each contain BOTH coin
			// type substrings, so the old `includes && includes` matcher
			// returned the FIRST `Pool<…>` change for both specs.
			const specs: ReadonlyArray<ResolvedDeepbookPoolSpec> = [
				poolSpec('deep-sui', DEEP, SUI),
				poolSpec('sui-deep', SUI, DEEP),
			];
			const sdk = stubSdk(
				createdReceipt([
					{ objectId: '0xpool-deep-sui', poolType: poolType(DEEP, SUI) },
					{ objectId: '0xpool-sui-deep', poolType: poolType(SUI, DEEP) },
				]),
			);

			const result = yield* createDeepbookPools(
				passthroughPublisher,
				sdk,
				'localnet',
				stubSigner,
				deployment,
				specs,
			).pipe(Effect.scoped);

			const byName = new Map(result.pools.map((pool) => [pool.name, pool.poolId]));
			expect(byName.get('deep-sui')).toBe('0xpool-deep-sui');
			expect(byName.get('sui-deep')).toBe('0xpool-sui-deep');
			// The two specs MUST NOT collapse onto one objectId.
			expect(byName.get('deep-sui')).not.toBe(byName.get('sui-deep'));
		}),
	);

	it.effect('does not cross-match when one coin type is a substring of another', () =>
		Effect.gen(function* () {
			// `DEEP` is a substring of `DEEPX`; a substring matcher on the
			// quote would let the DEEP/SUI spec match the DEEPX/SUI pool.
			const DEEPX = '0xdeepx::deepx::DEEPX';
			const specs: ReadonlyArray<ResolvedDeepbookPoolSpec> = [
				poolSpec('deep-sui', DEEP, SUI),
				poolSpec('deepx-sui', DEEPX, SUI),
			];
			const sdk = stubSdk(
				createdReceipt([
					{ objectId: '0xpool-deepx-sui', poolType: poolType(DEEPX, SUI) },
					{ objectId: '0xpool-deep-sui', poolType: poolType(DEEP, SUI) },
				]),
			);

			const result = yield* createDeepbookPools(
				passthroughPublisher,
				sdk,
				'localnet',
				stubSigner,
				deployment,
				specs,
			).pipe(Effect.scoped);

			const byName = new Map(result.pools.map((pool) => [pool.name, pool.poolId]));
			expect(byName.get('deep-sui')).toBe('0xpool-deep-sui');
			expect(byName.get('deepx-sui')).toBe('0xpool-deepx-sui');
		}),
	);
});
