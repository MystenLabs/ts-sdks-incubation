// Compile-time + runtime smoke that `sealKnownKeyServer` provides
// `SealKeyServer` from a known-deployment lookup, and that it does NOT
// carry a `SealKeyManager` layer (we don't own the master key). We
// exercise the factory's own `__layer` directly to keep the test off the
// filesystem — the full `provideDevstack` path drags in `StateStoreLive`,
// which acquires a real lock file. The other half of the matrix
// (`sealLocalKeygen` providing both interfaces) is covered by the
// integration runs in `examples/private-content`.

import { Effect, Exit, Layer } from 'effect';
import { layer as NodeFileSystemLayer } from '@effect/platform-node/NodeFileSystem';
import { describe, expect, it } from '@effect/vitest';
import { EngineLive } from '../engine/engine.js';
import {
	SealKeyManager,
	SealKeyServer,
	type SealKeyServerEntry,
} from './seal.js';
import { knownDeployments } from '../engine/known-deployments.js';
import { EndpointRegistryLive } from '../engine/registries.js';
import { sealKnownKeyServer } from './seal/internal.js';

// -----------------------------------------------------------------------------
// Type-level shape compatibility — `SealKeyServerEntry` must remain
// structurally assignable to `@mysten/seal`'s `KeyServerConfig`. We
// don't take a runtime dep on `@mysten/seal` (peer dep — consumers
// bring it), so we mirror the SDK type here as `_ExpectedKeyServerConfig`
// and assert structural assignability via an `extends` check. Runtime
// no-op; compile-time guard against drift.
type _ExpectedKeyServerConfig = {
	objectId: string;
	weight: number;
	apiKeyName?: string;
	apiKey?: string;
	aggregatorUrl?: string;
};
type _SealKeyServerEntryCheck = SealKeyServerEntry extends _ExpectedKeyServerConfig
	? true
	: never;
const _sealKeyServerEntryCheck: _SealKeyServerEntryCheck = true;
void _sealKeyServerEntryCheck;

// `provide` wraps the build with engine lifecycle hooks; tests need
// `EngineLive`. The known-key-server body also calls
// `EndpointRegistry.publish`, so we add the in-memory `EndpointRegistry`
// layer to the base — without it the build trips `ServiceNotFound`
// before the projection ever runs.
const TestBaseLayer = Layer.mergeAll(EngineLive, NodeFileSystemLayer, EndpointRegistryLive);

describe('sealKnownKeyServer', () => {
	it.effect('provides SealKeyServer from a network lookup', () =>
		Effect.gen(function* () {
			const member = sealKnownKeyServer({ network: 'testnet' });

			const keyServer = yield* Effect.gen(function* () {
				return yield* SealKeyServer;
			}).pipe(Effect.provide(Layer.provide(member.__layer, TestBaseLayer)));

			const expected = knownDeployments.seal.testnet!;
			expect(keyServer.keyServerUrl).toBe(expected.keyServerUrl);
			expect(keyServer.objectId).toBe(expected.keyServerObjectId);
			// SDK-ready serverConfigs — known-mode wraps the single
			// registry entry as one element with weight 1. The shape is
			// what `new SealClient({ serverConfigs })` takes verbatim.
			expect(keyServer.serverConfigs).toEqual([
				{ objectId: expected.keyServerObjectId, weight: 1 },
			]);
		}),
	);

	it.effect('does NOT provide SealKeyManager', () =>
		Effect.gen(function* () {
			const member = sealKnownKeyServer({ network: 'testnet' });

			// Yielding `SealKeyManager` against a known-key-server-only
			// layer surfaces as a runtime resolution failure — we don't
			// own the master key, so there's no manager layer. Cast
			// through unknown because the layer's `R` channel doesn't
			// expose SealKeyManager (correct at the type level — we're
			// exercising the runtime fallback).
			const program: Effect.Effect<'resolved', never, SealKeyManager> = Effect.gen(function* () {
				yield* SealKeyManager;
				return 'resolved' as const;
			});
			const exit = yield* (program as unknown as Effect.Effect<'resolved', unknown, never>).pipe(
				Effect.provide(Layer.provide(member.__layer, TestBaseLayer)),
				Effect.exit,
			);

			expect(Exit.isFailure(exit)).toBe(true);
		}),
	);

	it.effect('explicit keyServerUrl overrides the network lookup', () =>
		Effect.gen(function* () {
			const member = sealKnownKeyServer({
				network: 'testnet',
				keyServerUrl: 'https://custom.example/key-server',
			});

			const keyServer = yield* Effect.gen(function* () {
				return yield* SealKeyServer;
			}).pipe(Effect.provide(Layer.provide(member.__layer, TestBaseLayer)));
			expect(keyServer.keyServerUrl).toBe('https://custom.example/key-server');
		}),
	);

	it('throws at factory time when neither network nor required fields are provided', () => {
		// Contract: without a `network` to fall back on, the required
		// fields (objectId/publicKey/keyServerUrl) must be set explicitly.
		// The factory raises synchronously so misconfiguration surfaces
		// at the call site, not at deferred Layer.build time.
		expect(() => sealKnownKeyServer({})).toThrow(/missing required fields/);
	});
});
