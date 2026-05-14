// Compile-time + runtime smoke that `deepbookKnownPackage` provides
// `DeepbookCore` (so consumers `yield* DeepbookCore` resolve against it)
// and that it does NOT carry an admin layer. We exercise the factory's
// own `__layer` directly to keep the test off the filesystem — the full
// `provideDevstack` path drags in `StateStoreLive`, which acquires a
// real lock file. The other half of the matrix (`deepbookLocalDeploy`
// providing all three interfaces) is covered by the integration runs in
// `examples/wallet`.

import { Effect, Exit, Layer } from 'effect';
import { layer as NodeFileSystemLayer } from '@effect/platform-node/NodeFileSystem';
import { describe, expect, it } from '@effect/vitest';
import { EngineLive } from '../internal/engine.js';
import { DeepbookAdmin, DeepbookCore, type DeepbookCoreShape } from '../interfaces/deepbook.js';
import { deepbookKnownPackage } from './deepbook.js';

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
type _DeepbookCheck =
	DeepbookCoreShape['packageIds'] extends _ExpectedDeepbookPackageIds ? true : never;
const _deepbookCheck: _DeepbookCheck = true;
void _deepbookCheck;

// `provideTag` wraps the build with engine lifecycle hooks; tests need
// `EngineLive` (and `EngineLive` itself needs `NodeFileSystemLayer` via
// StateStore — but only if we touch StateStore, which we don't here).
// `EngineLive` is a pure in-memory Ref, so it satisfies the wrap with
// no fs touch.
const TestBaseLayer = Layer.mergeAll(EngineLive, NodeFileSystemLayer);

describe('deepbookKnownPackage', () => {
	it.effect('provides DeepbookCore from a network lookup', () =>
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
				return yield* DeepbookCore;
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

	it.effect('does NOT provide DeepbookAdmin', () =>
		Effect.gen(function* () {
			const member = deepbookKnownPackage({ network: 'testnet' });

			// Yielding `DeepbookAdmin` against a known-package-only layer
			// surfaces as a runtime resolution failure — there's no admin
			// layer to satisfy the dependency. Cast through unknown because
			// the layer's `R` channel doesn't expose DeepbookAdmin (correct
			// at the type level — we're exercising the runtime fallback).
			const program: Effect.Effect<'resolved', never, DeepbookAdmin> = Effect.gen(function* () {
				yield* DeepbookAdmin;
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
				return yield* DeepbookCore;
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
