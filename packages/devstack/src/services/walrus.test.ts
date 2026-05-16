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
import { EngineLive } from '../engine/engine.js';
import {
	WalrusAdminTag,
	WalrusNetworkTag,
	WalrusNodesTag,
	type WalrusNetwork,
} from './walrus.js';
import { knownDeployments } from '../engine/known-deployments.js';
import { routerHostname, routerId } from '../engine/router-hostname.js';
import { walrusKnownDeployment } from './walrus/index.js';

// -----------------------------------------------------------------------------
// Type-level shape compatibility — `WalrusNetwork.packageConfig`
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
	WalrusNetwork['packageConfig'] extends _ExpectedWalrusPackageConfig ? true : never;
const _walrusPackageConfigCheck: _WalrusPackageConfigCheck = true;
void _walrusPackageConfigCheck;

// `provide` wraps the build with engine lifecycle hooks; tests need
// `EngineLive` (and `EngineLive` itself needs `NodeFileSystemLayer` via
// StateStore — but only if we touch StateStore, which we don't here).
const TestBaseLayer = Layer.mergeAll(EngineLive, NodeFileSystemLayer);

// Stack-scoped hostnames the walrus deploy phase plugs into
// `WALRUS_PUBLIC_HOSTS` (and that nodes register on chain as their
// `network_address`). Pin the expected shape so a regression in
// `routerHostname` / `routerId` doesn't silently misroute the on-chain
// committee record off-stack. The router layer matches against `Host:`
// header — these are EXACTLY the values that have to land on the
// docker labels and on chain.
describe('walrus storage-node router hostnames', () => {
	const id = (app: string, stack: string) =>
		({ app, stack, network: 'localnet' as const }) as const;

	it('main stack — main-stack hostnames omit the stack prefix', () => {
		expect(routerHostname(id('private-content', 'main'), 'walrus-node-0')).toBe(
			'walrus-node-0.private-content.localhost',
		);
		expect(routerHostname(id('private-content', 'main'), 'walrus-node-3')).toBe(
			'walrus-node-3.private-content.localhost',
		);
	});

	it('non-main stack — stack prefix isolates parallel committees', () => {
		expect(routerHostname(id('arena', 'test'), 'walrus-node-0')).toBe(
			'test.walrus-node-0.arena.localhost',
		);
		// A second parallel stack of the SAME app must produce a
		// disjoint hostname, otherwise the on-chain `network_address`
		// would collide and traefik would route Stack B's traffic into
		// Stack A's container.
		expect(routerHostname(id('arena', 'worker-3'), 'walrus-node-0')).toBe(
			'worker-3.walrus-node-0.arena.localhost',
		);
	});

	it('routerId composes the per-node label namespace', () => {
		// The label set `traefik.http.routers.<id>.*` keys on this; two
		// parallel stacks must not stamp the same id or one stack's
		// labels would overwrite the other's in the router config.
		expect(routerId(id('private-content', 'main'), 'walrus-node-0')).toBe(
			'private-content-main-walrus-node-0',
		);
		expect(routerId(id('arena', 'test'), 'walrus-node-2')).toBe('arena-test-walrus-node-2');
	});
});

describe('walrusKnownDeployment', () => {
	it.effect('provides WalrusNetworkTag + WalrusNodesTag from a network lookup with explicit nodes', () =>
		Effect.gen(function* () {
			// The registry intentionally omits `nodes` (testnet has 100+,
			// dynamically fetched from the staking pool by @mysten/walrus).
			// Pass an explicit (empty) committee here so the factory
			// doesn't throw; the chain-state fields come from the lookup.
			const member = walrusKnownDeployment({ network: 'testnet', nodes: [] });

			const { network, nodes } = yield* Effect.gen(function* () {
				const n = yield* WalrusNetworkTag;
				const ns = yield* WalrusNodesTag;
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

	it.effect('does NOT provide WalrusAdminTag', () =>
		Effect.gen(function* () {
			const member = walrusKnownDeployment({ network: 'testnet', nodes: [] });

			// Yielding `WalrusAdminTag` against a known-deployment-only layer
			// surfaces as a runtime resolution failure — no admin layer to
			// satisfy the dependency. Cast through unknown because the
			// layer's `R` channel doesn't expose WalrusAdminTag (correct at
			// the type level — we're exercising the runtime fallback).
			const program: Effect.Effect<'resolved', never, WalrusAdminTag> = Effect.gen(function* () {
				yield* WalrusAdminTag;
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
				return yield* WalrusNetworkTag;
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
