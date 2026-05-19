// Compile-time + runtime smoke that `deepbookKnownPackage` provides
// `DeepbookCoreTag` (so consumers `yield* DeepbookCoreTag` resolve against it)
// and that it does NOT carry an admin layer. We exercise the factory's
// own `__layer` directly to keep the test off the filesystem — the full
// `provideDevstack` path drags in `StateStoreLive`, which acquires a
// real lock file. The other half of the matrix (`deepbookLocalDeploy`
// providing all three interfaces) is covered by the integration runs in
// `examples/wallet`.
//
// The cache-on-resume describe below DOES touch the StateStore — it pre-
// warms a cache entry under a per-test tmpdir, then proves the create-
// pools tx is skipped on the next composite acquire by handing the
// member a signer whose `signAndExecute` is `Effect.die`. If the cache
// regresses, the die surfaces as a typed failure.

import * as nodeCrypto from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import { Effect, Exit, Layer } from 'effect';
import { layer as NodeFileSystemLayer } from '@effect/platform-node/NodeFileSystem';
import { describe, expect, it } from '@effect/vitest';
import { EngineLive } from '../engine/engine.js';
import { LeasingLive } from '../engine/leasing.js';
import {
	CoinRegistryLive,
	DeepbookStateRegistryLive,
	PackageRegistryLive,
} from '../engine/registries.js';
import { StateStore, StateStoreConfig, StateStoreLive } from '../engine/state-store.js';
import { DeepbookAdminTag, DeepbookCoreTag, type DeepbookCore } from './deepbook.js';
import { SuiTag, type Sui } from './sui.js';
import type { Account, SignAndExecuteError } from '../engine/shared.js';
import { tag } from '../advanced/tag.js';
import { deepbookKnownPackage, deepbookLocalDeploy } from './deepbook/index.js';

// -----------------------------------------------------------------------------
// Type-level compat: our `packageIds` shape must be assignable to the SDK's
// `DeepbookPackageIds` interface (every field `?: string` upstream). The
// check exercises the structural relationship without importing
// `@mysten/deepbook-v3` types — we keep that package as an optional peer dep.
// -----------------------------------------------------------------------------
type _ExpectedDeepbookPackageIds = {
	DEEPBOOK_PACKAGE_ID?: string;
	REGISTRY_ID?: string;
	DEEP_TREASURY_ID?: string;
	MARGIN_PACKAGE_ID?: string;
	MARGIN_REGISTRY_ID?: string;
	LIQUIDATION_PACKAGE_ID?: string;
};
// Compile-time assertion: our `packageIds` satisfies SDK's
// `DeepbookPackageIds` shape. Breaks the build if a future edit drops
// SDK compat (a renamed field, a wrong type, etc).
type _DeepbookCheck = DeepbookCore['packageIds'] extends _ExpectedDeepbookPackageIds ? true : never;
const _deepbookCheck: _DeepbookCheck = true;
void _deepbookCheck;

// `provide` wraps the build with engine lifecycle hooks; tests need
// `EngineLive` (and `EngineLive` itself needs `NodeFileSystemLayer` via
// StateStore — but only if we touch StateStore, which we don't here).
// `EngineLive` is a pure in-memory Ref, so it satisfies the wrap with
// no fs touch.
const TestBaseLayer = Layer.mergeAll(EngineLive, NodeFileSystemLayer, DeepbookStateRegistryLive);

describe('deepbookKnownPackage', () => {
	it.effect('provides DeepbookCoreTag from a network lookup', () =>
		Effect.gen(function* () {
			const member = deepbookKnownPackage({
				network: 'testnet',
				pools: [
					{
						name: 'sui_usdc',
						poolId: '0xpool1',
						baseType: '0x2::sui::SUI',
						quoteType: '0x...::usdc::USDC',
					},
				],
			});

			const core = yield* Effect.gen(function* () {
				return yield* DeepbookCoreTag;
			}).pipe(Effect.provide(Layer.provide(member.__layer, TestBaseLayer)));

			// Canonical testnet ids from `knownDeployments.deepbook.testnet`.
			expect(core.packageId.startsWith('0x')).toBe(true);
			expect(core.registryId.startsWith('0x')).toBe(true);
			expect(core.poolIds.size).toBe(1);
			expect(core.poolIds.get('sui_usdc')).toBe('0xpool1');

			// SDK-aligned `packageIds` view. SCREAMING_SNAKE_CASE fields are
			// consumed verbatim by `@mysten/deepbook-v3`'s `DeepBookClient`,
			// so the registry's camelCase entries must round-trip through the
			// factory unchanged.
			expect(core.packageIds.DEEPBOOK_PACKAGE_ID).toBe(core.packageId);
			expect(core.packageIds.REGISTRY_ID).toBe(core.registryId);
			expect(core.packageIds.DEEP_TREASURY_ID.startsWith('0x')).toBe(true);
			expect(core.packageIds.MARGIN_PACKAGE_ID?.startsWith('0x')).toBe(true);
			expect(core.packageIds.MARGIN_REGISTRY_ID?.startsWith('0x')).toBe(true);
			expect(core.packageIds.LIQUIDATION_PACKAGE_ID?.startsWith('0x')).toBe(true);
		}),
	);

	it.effect('does NOT provide DeepbookAdminTag', () =>
		Effect.gen(function* () {
			const member = deepbookKnownPackage({ network: 'testnet' });

			// Yielding `DeepbookAdminTag` against a known-package-only layer
			// surfaces as a runtime resolution failure — there's no admin
			// layer to satisfy the dependency. Cast through unknown because
			// the layer's `R` channel doesn't expose DeepbookAdminTag (correct
			// at the type level — we're exercising the runtime fallback).
			const program: Effect.Effect<'resolved', never, DeepbookAdminTag> = Effect.gen(function* () {
				yield* DeepbookAdminTag;
				return 'resolved' as const;
			});
			const exit = yield* (program as unknown as Effect.Effect<'resolved', unknown, never>).pipe(
				Effect.provide(Layer.provide(member.__layer, TestBaseLayer)),
				Effect.exit,
			);

			expect(Exit.isFailure(exit)).toBe(true);
		}),
	);

	it.effect('explicit packageId/registryId override the network lookup', () =>
		Effect.gen(function* () {
			const member = deepbookKnownPackage({
				packageId: '0xCAFE',
				registryId: '0xBEEF',
				pools: [],
			});

			const core = yield* Effect.gen(function* () {
				return yield* DeepbookCoreTag;
			}).pipe(Effect.provide(Layer.provide(member.__layer, TestBaseLayer)));
			expect(core.packageId).toBe('0xCAFE');
			expect(core.registryId).toBe('0xBEEF');

			// Explicit-override path: no registry lookup, so optional fields
			// fall back to empty / undefined (the deepbook client treats
			// missing fields as "feature not available" — see the SDK's
			// `DeepbookPackageIds` interface).
			expect(core.packageIds.DEEPBOOK_PACKAGE_ID).toBe('0xCAFE');
			expect(core.packageIds.REGISTRY_ID).toBe('0xBEEF');
			expect(core.packageIds.DEEP_TREASURY_ID).toBe('');
			expect(core.packageIds.MARGIN_PACKAGE_ID).toBeUndefined();
			expect(core.packageIds.MARGIN_REGISTRY_ID).toBeUndefined();
			expect(core.packageIds.LIQUIDATION_PACKAGE_ID).toBeUndefined();
		}),
	);
});

// -----------------------------------------------------------------------------
// Resume-idempotency cache for `create-pools`
//
// Pre-populate the StateStore with a publishMove cache entry AND a
// deepbook pools cache entry, then build the composite tag against a
// signer whose `signAndExecute` is `Effect.die`. If the cache lookup
// resolves, neither publish nor create-pools run a tx — the die is
// never reached and the tag yields the cached pool shape. If the cache
// regresses, the die surfaces as a defect and `Exit.isFailure` flips.
//
// The publishMove cache key is
// `publishMove/<name>/<chainId>/<inputsHash>`, where `inputsHash` is the
// first 16 hex chars of sha256 over the canonical-JSON of `{sourceHash,
// signer}`. `sourceHash` is the first 16 hex chars of sha256 over
// (sorted) `<relpath>\0<content>\0` records for every `.move` +
// `Move.toml` file under the source dir. With a single `Move.toml`
// fixture the source hash is `sha256('Move.toml\0' + content + '\0')`.
// Mirrored inline below so a regression in either hash algorithm reads
// as a hash-mismatch here, not a silent cache-miss.
// -----------------------------------------------------------------------------

const computePublishMoveSourceHash = (relpath: string, content: string): string => {
	const h = nodeCrypto.createHash('sha256');
	h.update(`${relpath}\0`);
	h.update(content);
	h.update('\0');
	return h.digest('hex').slice(0, 16);
};

// Mirror `engine/cache.ts`'s canonical `inputsHash` derivation —
// `contentHash(JSON.stringify({sourceHash, signer}), {length: 16})`
// (JSON.stringify uses `jsonBigintReplacer` but neither field carries
// bigints here, so a plain stringify matches).
const computePublishMoveInputsHash = (sourceHash: string, signerAddress: string): string => {
	const inputs = { sourceHash, signer: signerAddress };
	const h = nodeCrypto.createHash('sha256');
	h.update(JSON.stringify(inputs));
	return h.digest('hex').slice(0, 16);
};

// Stable poolsHash mirror — must match the algorithm in
// `local-deploy.ts:hashPoolSpecs`. Sorted by name, bigints → decimal
// strings, JSON.stringify, sha256, first 16 hex chars.
const computePoolsHash = (
	specs: ReadonlyArray<{
		readonly name: string;
		readonly base: string;
		readonly quote: string;
		readonly tickSize: bigint;
		readonly lotSize: bigint;
		readonly minSize: bigint;
		readonly whitelisted: boolean;
		readonly stable: boolean;
	}>,
): string => {
	const canonical = specs
		.slice()
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
		.map((s) => ({
			name: s.name,
			base: s.base,
			quote: s.quote,
			tickSize: s.tickSize.toString(),
			lotSize: s.lotSize.toString(),
			minSize: s.minSize.toString(),
			whitelisted: s.whitelisted,
			stable: s.stable,
		}));
	return nodeCrypto
		.createHash('sha256')
		.update(JSON.stringify(canonical))
		.digest('hex')
		.slice(0, 16);
};

const mkTmpDir = (label: string) =>
	Effect.tryPromise({
		try: () => nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), `devstack-deepbook-${label}-`)),
		catch: (cause) => new Error(`failed to create tmpdir: ${String(cause)}`),
	}).pipe(Effect.orDie);

// `client.core.getObject` is the only chain probe the cache-hit path
// touches (verification step). Stub it to always resolve with the
// expected `objectType` so a cache hit is trusted; the BAD path
// (where the chain object is gone) is covered by the second
// `it.effect` below.
//
// Mirrors `@mysten/sui`'s real `GetObjectResponse` shape — the object's
// Move type is exposed via the nested `object.type` field, NOT a
// top-level `objectType`. Returning the type at the wrong level was
// the root cause of the resume-time MoveAbort: `verifyCached` read
// `.objectType`, always saw `undefined`, and invalidated the cache on
// every resume.
//
// `objectTypeFor(objectId)` returns the matching `Pool<base, quote>`
// type so verifyCached's post-HIGH-C4 objectType assertion succeeds.
// Defaults to `${packageId}::pool::Pool<0x2::sui::SUI,
// ${packageId}::usdc::USDC>` (the test fixture's only pool); pass
// an override for richer scenarios.
const makeMockSuiOk = (
	chainId: string,
	objectTypeFor?: (objectId: string) => string,
): Layer.Layer<SuiTag> =>
	Layer.succeed(SuiTag, {
		network: 'localnet',
		rpc: { host: 'http://localhost:9000' },
		chainId,
		faucet: undefined,
		client: {
			core: {
				getObject: async (_args: { objectId: string }) => ({
					object: {
						objectId: _args.objectId,
						type: objectTypeFor?.(_args.objectId),
					} as unknown,
				}),
			},
		} as unknown as Sui['client'],
		waitForTransactionsReady: () => Effect.void,
		runtime: 'bundled',
	});

/** Mock Sui whose `getObject` succeeds for every objectId EXCEPT the
 *  ones listed in `missingIds`. Used by the "stale pool object" test to
 *  invalidate just the pools entry while leaving publishMove's verify
 *  probe (which independently checks the cached packageId per Phase C
 *  §4.2) on the happy path. Without the discriminator, the
 *  publishMove cache invalidation would fire FIRST and the dying
 *  signer would surface from the publish phase, not from the
 *  create-pools phase the test intends to exercise. */
const makeMockSuiMissingObject = (
	chainId: string,
	missingIds: ReadonlySet<string>,
): Layer.Layer<SuiTag> =>
	Layer.succeed(SuiTag, {
		network: 'localnet',
		rpc: { host: 'http://localhost:9000' },
		chainId,
		faucet: undefined,
		client: {
			core: {
				getObject: async (args: { objectId: string }) => {
					if (missingIds.has(args.objectId)) {
						throw new Error('object not found');
					}
					return { object: { objectId: args.objectId } as unknown };
				},
			},
		} as unknown as Sui['client'],
		waitForTransactionsReady: () => Effect.void,
		runtime: 'bundled',
	});

const mockStateConfig = (stateDir: string): Layer.Layer<StateStoreConfig> =>
	Layer.succeed(StateStoreConfig, {
		stack: 'test',
		network: 'localnet',
		stateDir,
	});

// Throwaway signer tag whose `signAndExecute` is `Effect.die`. Any tx
// submission during the cache-hit path surfaces as a defect — the test
// asserts the composite yield succeeds, which is only possible when
// neither publish nor create-pools issued a tx.
//
// The mock Account's `publicKey` slot has to type-bridge across
// `Uint8Array<ArrayBuffer>` (DOM lib's narrow shape) and the
// `Uint8Array<ArrayBufferLike>` Node hands out — easiest to allocate
// against a literal ArrayBuffer to side-step. We funnel through
// `Account` at the end so the Ref type lines up with the
// `signer` slot of `DeepbookLocalDeployOptions`.
const makeDyingSigner = (address: string) => {
	const account: Account = {
		name: 'mock-signer',
		address,
		publicKey: new Uint8Array(new ArrayBuffer(0)),
		scheme: 'ed25519',
		signAndExecute: () =>
			Effect.die('mock-signer.signAndExecute called — cache regression') as never,
		signTransaction: () =>
			Effect.fail({
				_tag: 'SignAndExecuteError',
				message: 'unreachable',
			} satisfies SignAndExecuteError),
		signPersonalMessage: () =>
			Effect.fail({
				_tag: 'SignAndExecuteError',
				message: 'unreachable',
			} satisfies SignAndExecuteError),
	};
	return tag('mock-signer', Effect.succeed(account));
};

// Per-test base — same shape as the deepbookKnownPackage suite but with
// StateStoreLive provided (we need a real persistence layer to seed and
// read the cache entries). FileSystem flows through NodeFileSystemLayer.
const CacheBaseLayer = Layer.mergeAll(
	EngineLive,
	NodeFileSystemLayer,
	LeasingLive,
	PackageRegistryLive,
	CoinRegistryLive,
	DeepbookStateRegistryLive,
);

describe('deepbookLocalDeploy — create-pools resume cache', () => {
	it.effect('cache hit skips both publish and create-pools txs', () =>
		Effect.gen(function* () {
			const tmpdir = yield* mkTmpDir('cache-hit');
			const chainId = 'test-chain-cache-hit';
			const fakePackageId = '0xDEEPB00C';
			const fakePoolId = '0xP00L1';

			// Fixture Move source — single `Move.toml` so the publishMove
			// sourceHash is deterministic and we can pre-warm the cache.
			const moveSrcDir = nodePath.join(tmpdir, 'move-fixture');
			yield* Effect.tryPromise({
				try: () => nodeFs.mkdir(moveSrcDir, { recursive: true }),
				catch: (cause) => new Error(String(cause)),
			}).pipe(Effect.orDie);
			const moveTomlContent = '[package]\nname = "deepbook"\nedition = "2024.beta"\n';
			yield* Effect.tryPromise({
				try: () => nodeFs.writeFile(nodePath.join(moveSrcDir, 'Move.toml'), moveTomlContent),
				catch: (cause) => new Error(String(cause)),
			}).pipe(Effect.orDie);

			const sourceHash = computePublishMoveSourceHash('Move.toml', moveTomlContent);
			const inputsHash = computePublishMoveInputsHash(sourceHash, '0xCAFE');
			const publishMoveKey = `publishMove/deepbook.publish/${chainId}/${inputsHash}`;

			// Pool spec — match `deepbookLocalDeploy`'s `specs` shape so the
			// resolvedSpecs sent into `hashPoolSpecs` round-trip to the same
			// key as the production code.
			const baseType = '0x2::sui::SUI';
			const quoteType = `${fakePackageId}::usdc::USDC`;
			const poolSpec = {
				name: 'sui_usdc',
				base: baseType,
				quote: quoteType,
				tickSize: 1_000n,
				lotSize: 1_000_000n,
				minSize: 10_000_000n,
				whitelisted: true,
				stable: false,
			};
			const poolsHash = computePoolsHash([poolSpec]);
			const poolsKey = `deepbook/pools/${chainId}/${fakePackageId}/${poolsHash}`;

			// Build a `Ref` of type Account by yielding through
			// `tag` — its `__layer` provides the tag identity. The body
			// returns an Account whose `signAndExecute` is `Effect.die`.
			const signerTag = makeDyingSigner('0xCAFE');

			const member = deepbookLocalDeploy({
				name: 'deepbook',
				signer: signerTag,
				movePackagePath: moveSrcDir,
				pools: [
					{
						name: 'sui_usdc',
						base: baseType,
						quote: quoteType,
						tickSize: poolSpec.tickSize,
						lotSize: poolSpec.lotSize,
						minSize: poolSpec.minSize,
					},
				],
			});

			const expectedPoolType = `${fakePackageId}::pool::Pool<${baseType}, ${quoteType}>`;
			const supportLayer = Layer.mergeAll(
				CacheBaseLayer,
				makeMockSuiOk(chainId, () => expectedPoolType),
				Layer.provideMerge(
					Layer.provide(StateStoreLive, mockStateConfig(tmpdir)),
					NodeFileSystemLayer,
				),
				signerTag.__layer,
			);

			// Pre-warm both caches. `state.put` synchronously updates the
			// in-memory Ref AND persists to disk; the deepbookLocalDeploy
			// composite yield below picks up the values via the same Live
			// layer instance (Layer is memoized within a single build).
			yield* Effect.gen(function* () {
				const state = yield* StateStore;
				yield* state.put(publishMoveKey, {
					name: 'deepbook.publish',
					packageId: fakePackageId,
					upgradeCapId: '0xCAP',
					captured: {
						registryId: '0xREG',
						adminCapId: '0xADMIN',
					},
					coins: {},
					sourcePath: moveSrcDir,
					mvrPlaceholder: '@local/deepbook-publish',
				});
				yield* state.put(poolsKey, {
					pools: [
						{
							name: 'sui_usdc',
							poolId: fakePoolId,
							base: baseType,
							quote: quoteType,
							tickSize: poolSpec.tickSize,
							lotSize: poolSpec.lotSize,
							minSize: poolSpec.minSize,
						},
					],
				});
			}).pipe(Effect.provide(supportLayer));

			// Compose the deepbook layers with `provideMerge` so each
			// layer can consume services published by the prior layer —
			// the same fold composeStackLayer does in production. With
			// plain `mergeAll`, the composite's `yield* publish` would
			// see `deepbook.publish` as unsatisfied because the publish
			// layer would be a sibling, not a provider.
			//
			// We drop the trailing three layers (`coreLayer` /
			// `adminLayer` / `marketMakerLayer`) — those are the
			// `DeepbookCoreTag` / `DeepbookAdminTag` / `DeepbookMarketMaker`
			// interface bindings, and the market-maker layer mints a
			// BalanceManager upfront (a separate tx that would also
			// hit the dying signer). That's an orthogonal non-
			// idempotency concern, out of scope for the create-pools
			// cache fix.
			const compositeLayers = (member.__layers as ReadonlyArray<Layer.Layer<any, any, any>>).slice(
				0,
				-3,
			);
			const memberLayer = compositeLayers.reduce<Layer.Layer<any, any, any>>(
				(acc, layer) => Layer.provideMerge(layer, acc),
				Layer.empty as unknown as Layer.Layer<any, any, any>,
			);
			const deployed = yield* Effect.gen(function* () {
				return yield* member;
			}).pipe(Effect.provide(Layer.provide(memberLayer, supportLayer)));

			expect(deployed.packageId).toBe(fakePackageId);
			expect(deployed.adminCapId).toBe('0xADMIN');
			expect(deployed.registryId).toBe('0xREG');
			expect(deployed.poolIds.size).toBe(1);
			expect(deployed.poolIds.get('sui_usdc')).toBe(fakePoolId);
			expect((deployed.pools as Record<string, { poolId: string }>).sui_usdc.poolId).toBe(
				fakePoolId,
			);
			// Reaching this point at all proves the cache hit short-
			// circuited both publish AND create-pools: the mock signer's
			// `signAndExecute` is `Effect.die`, so any tx submission
			// during the acquire would have surfaced as a defect.
		}),
	);

	it.effect('cache hit but stale pool object invalidates and rebuilds', () =>
		Effect.gen(function* () {
			const tmpdir = yield* mkTmpDir('cache-stale');
			const chainId = 'test-chain-cache-stale';
			const fakePackageId = '0xDEEPB00D';
			const stalePoolId = '0xSTALE';

			const moveSrcDir = nodePath.join(tmpdir, 'move-fixture');
			yield* Effect.tryPromise({
				try: () => nodeFs.mkdir(moveSrcDir, { recursive: true }),
				catch: (cause) => new Error(String(cause)),
			}).pipe(Effect.orDie);
			const moveTomlContent = '[package]\nname = "deepbook"\nedition = "2024.beta"\n';
			yield* Effect.tryPromise({
				try: () => nodeFs.writeFile(nodePath.join(moveSrcDir, 'Move.toml'), moveTomlContent),
				catch: (cause) => new Error(String(cause)),
			}).pipe(Effect.orDie);

			const sourceHash = computePublishMoveSourceHash('Move.toml', moveTomlContent);
			const inputsHash = computePublishMoveInputsHash(sourceHash, '0xCAFE');
			const publishMoveKey = `publishMove/deepbook.publish/${chainId}/${inputsHash}`;
			const baseType = '0x2::sui::SUI';
			const quoteType = `${fakePackageId}::usdc::USDC`;
			const poolSpec = {
				name: 'sui_usdc',
				base: baseType,
				quote: quoteType,
				tickSize: 1_000n,
				lotSize: 1_000_000n,
				minSize: 10_000_000n,
				whitelisted: true,
				stable: false,
			};
			const poolsHash = computePoolsHash([poolSpec]);
			const poolsKey = `deepbook/pools/${chainId}/${fakePackageId}/${poolsHash}`;

			const signerTag = makeDyingSigner('0xCAFE');
			const member = deepbookLocalDeploy({
				name: 'deepbook',
				signer: signerTag,
				movePackagePath: moveSrcDir,
				pools: [
					{
						name: 'sui_usdc',
						base: baseType,
						quote: quoteType,
						tickSize: poolSpec.tickSize,
						lotSize: poolSpec.lotSize,
						minSize: poolSpec.minSize,
					},
				],
			});

			// Same support shape as the happy-path test, but the Sui mock
			// reports the stale pool object as missing while still letting
			// publishMove's verify probe of the cached packageId succeed.
			// Per Phase C §4.2 both layers have independent verify probes;
			// without the discriminator the publishMove invalidation would
			// fire first and short-circuit the test's create-pools
			// invalidation path. The cache is still warmed —
			// verification then fails, the entry is invalidated, and the
			// dying signer's `Effect.die` fires from the `create-pools` tx
			// (proving the invalidation path actually re-enters tx work).
			const supportLayer = Layer.mergeAll(
				CacheBaseLayer,
				makeMockSuiMissingObject(chainId, new Set([stalePoolId])),
				Layer.provideMerge(
					Layer.provide(StateStoreLive, mockStateConfig(tmpdir)),
					NodeFileSystemLayer,
				),
				signerTag.__layer,
			);

			yield* Effect.gen(function* () {
				const state = yield* StateStore;
				yield* state.put(publishMoveKey, {
					name: 'deepbook.publish',
					packageId: fakePackageId,
					upgradeCapId: '0xCAP',
					captured: { registryId: '0xREG', adminCapId: '0xADMIN' },
					coins: {},
					sourcePath: moveSrcDir,
					mvrPlaceholder: '@local/deepbook-publish',
				});
				yield* state.put(poolsKey, {
					pools: [
						{
							name: 'sui_usdc',
							poolId: stalePoolId,
							base: baseType,
							quote: quoteType,
							tickSize: poolSpec.tickSize,
							lotSize: poolSpec.lotSize,
							minSize: poolSpec.minSize,
						},
					],
				});
			}).pipe(Effect.provide(supportLayer));

			// See the happy-path test for why we slice off the trailing
			// three layers (the interface bindings + market-maker BM
			// mint).
			const compositeLayers = (member.__layers as ReadonlyArray<Layer.Layer<any, any, any>>).slice(
				0,
				-3,
			);
			const memberLayer = compositeLayers.reduce<Layer.Layer<any, any, any>>(
				(acc, layer) => Layer.provideMerge(layer, acc),
				Layer.empty as unknown as Layer.Layer<any, any, any>,
			);
			const exit = yield* Effect.gen(function* () {
				return yield* member;
			}).pipe(Effect.provide(Layer.provide(memberLayer, supportLayer)), Effect.exit);

			// Stale verification path → invalidate cache → re-enter
			// create-pools → mock signer dies. We don't care about the
			// exact defect text, only that the composite did NOT silently
			// succeed (which would mean the cache was trusted despite the
			// chain not having the object).
			expect(Exit.isFailure(exit)).toBe(true);

			// Cache entry was removed during the verify-fail branch.
			const remaining = yield* Effect.gen(function* () {
				const state = yield* StateStore;
				return yield* state.get(poolsKey);
			}).pipe(Effect.provide(supportLayer));
			expect(remaining._tag).toBe('None');
		}),
	);
});
