// Compile-time + runtime smoke that `walrusKnownDeployment` provides
// the network/nodes view (and proxy when URLs are available) from a
// known-deployment lookup, and that it does NOT carry an admin layer.
// We exercise the factory's own `__layer` directly to keep the test off
// the filesystem — the full `provideDevstack` path drags in
// `StateStoreLive`, which acquires a real lock file. The other half of
// the matrix (`walrusLocalCluster` providing all four interfaces) is
// covered by the integration runs in `examples/wallet` /
// `examples/private-content`.

import { Effect, Exit, Layer } from 'effect';
import { layer as NodeFileSystemLayer } from '@effect/platform-node/NodeFileSystem';
import { describe, expect, it } from '@effect/vitest';
import { EngineLive } from '../internal/engine.js';
import {
	WalrusAdmin,
	WalrusNetwork,
	WalrusNodes,
	type WalrusNetworkShape,
} from '../interfaces/walrus.js';
import { knownDeployments } from '../internal/known-deployments.js';
import { walrusKnownDeployment } from './walrus/index.js';

// -----------------------------------------------------------------------------
// Type-level shape compatibility — `WalrusNetworkShape.packageConfig`
// must remain structurally assignable to `@mysten/walrus`'s
// `WalrusPackageConfig`. We don't take a runtime dep on `@mysten/walrus`
// (it's a peer dep — consumers bring it), so we mirror the SDK type
// here as `_ExpectedWalrusPackageConfig` and assert structural
// assignability via an `extends` check that fails at compile time if
// the shape ever drifts. Runtime no-op; compile-time guard.
type _ExpectedWalrusPackageConfig = {
	systemObjectId: string;
	stakingPoolId: string;
	exchangeIds?: string[];
};
type _WalrusPackageConfigCheck =
	WalrusNetworkShape['packageConfig'] extends _ExpectedWalrusPackageConfig ? true : never;
const _walrusPackageConfigCheck: _WalrusPackageConfigCheck = true;
void _walrusPackageConfigCheck;

// `provideTag` wraps the build with engine lifecycle hooks; tests need
// `EngineLive` (and `EngineLive` itself needs `NodeFileSystemLayer` via
// StateStore — but only if we touch StateStore, which we don't here).
const TestBaseLayer = Layer.mergeAll(EngineLive, NodeFileSystemLayer);

describe('walrusKnownDeployment', () => {
	it.effect('provides WalrusNetwork + WalrusNodes from a network lookup with explicit nodes', () =>
		Effect.gen(function* () {
			// The registry intentionally omits `nodes` (testnet has 100+,
			// dynamically fetched from the staking pool by @mysten/walrus).
			// Pass an explicit (empty) committee here so the factory
			// doesn't throw; the chain-state fields come from the lookup.
			const member = walrusKnownDeployment({ network: 'testnet', nodes: [] });

			const { network, nodes } = yield* Effect.gen(function* () {
				const n = yield* WalrusNetwork;
				const ns = yield* WalrusNodes;
				return { network: n, nodes: ns };
			}).pipe(Effect.provide(Layer.provide(member.__layer, TestBaseLayer)));

			const expected = knownDeployments.walrus.testnet!;
			expect(network.systemObjectId).toBe(expected.systemObjectId);
			expect(network.stakingPoolId).toBe(expected.stakingPoolId);
			expect(network.subsidiesPackageId).toBe(expected.subsidiesPackageId);
			expect(network.exchangeIds).toEqual(expected.exchangeIds);
			expect(network.network).toBe('testnet');
			expect(nodes.nodes.length).toBe(0);
			// SDK-ready packageConfig — values mirror the top-level fields
			// and the shape is the one `@mysten/walrus`'s WalrusClient
			// takes verbatim.
			expect(network.packageConfig.systemObjectId).toBe(expected.systemObjectId);
			expect(network.packageConfig.stakingPoolId).toBe(expected.stakingPoolId);
			expect(network.packageConfig.exchangeIds).toEqual(expected.exchangeIds);
		}),
	);

	it.effect('does NOT provide WalrusAdmin', () =>
		Effect.gen(function* () {
			const member = walrusKnownDeployment({ network: 'testnet', nodes: [] });

			// Yielding `WalrusAdmin` against a known-deployment-only layer
			// surfaces as a runtime resolution failure — no admin layer to
			// satisfy the dependency. Cast through unknown because the
			// layer's `R` channel doesn't expose WalrusAdmin (correct at
			// the type level — we're exercising the runtime fallback).
			const program: Effect.Effect<'resolved', never, WalrusAdmin> = Effect.gen(function* () {
				yield* WalrusAdmin;
				return 'resolved' as const;
			});
			const exit = yield* (program as unknown as Effect.Effect<'resolved', unknown, never>).pipe(
				Effect.provide(Layer.provide(member.__layer, TestBaseLayer)),
				Effect.exit,
			);

			expect(Exit.isFailure(exit)).toBe(true);
		}),
	);

	it.effect('explicit systemObjectId overrides the network lookup', () =>
		Effect.gen(function* () {
			const member = walrusKnownDeployment({
				network: 'testnet',
				systemObjectId: '0xCAFE',
				nodes: [],
			});

			const network = yield* Effect.gen(function* () {
				return yield* WalrusNetwork;
			}).pipe(Effect.provide(Layer.provide(member.__layer, TestBaseLayer)));
			expect(network.systemObjectId).toBe('0xCAFE');
		}),
	);

	it('throws at factory time when neither network nor required fields are provided', () => {
		// Contract: without a `network` to fall back on, the required
		// chain-state ids must be set explicitly. The factory raises
		// synchronously so misconfiguration surfaces at the call site,
		// not at deferred Layer.build time.
		expect(() => walrusKnownDeployment({})).toThrow(/systemObjectId/);
	});

	it('throws at factory time when `nodes` is not supplied for a registered network', () => {
		// The walrus committee isn't statically registered (testnet has
		// 100+ nodes, fetched dynamically by @mysten/walrus). Calling
		// `walrusKnownDeployment({ network: 'testnet' })` without an
		// explicit `nodes` array must fail fast at factory time rather
		// than handing back an empty committee that would silently break
		// downstream blob reads.
		expect(() => walrusKnownDeployment({ network: 'testnet' })).toThrow(/committee/);
	});
});
