// setupDevstack(handle) — the Playwright global-setup/teardown wrapper.
// Three behaviors matter:
//
//   1. globalSetup runs the handle's layer build to completion exactly
//      once. Layer-acquire side effects must fire on first call.
//   2. globalTeardown runs every finalizer the layer registered.
//   3. On build failure, the layer's acquired-so-far finalizers still
//      run (Batch 5b fix — without `tapCause(Scope.close)` an
//      early-acquired primitive's finalizer never fires and resources
//      leak).

import { Context, Effect, Layer } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { setupDevstack } from './setup-devstack.js';
import type { DevstackHandle } from '../engine/supervisor.js';

// A tiny test-local service tag — we don't need anything from it, but
// `Layer.effect` requires a Context tag to assemble a layer around an
// acquire body.
class CounterTag extends Context.Service<CounterTag, { readonly n: number }>()('@test/Counter') {}

class OtherTag extends Context.Service<OtherTag, { readonly n: number }>()('@test/Other') {}

// Helper: assemble a fake `DevstackHandle` whose `.layer` is a simple
// layer made via Layer.effect. The supervisor's surface is wider, but
// `setupDevstack` only reads `.layer`.
const fakeHandle = (layer: Layer.Layer<unknown, unknown, unknown>): DevstackHandle =>
	({
		layer,
		config: { stack: [] },
		run: () => Promise.resolve(),
		runMain: () => {},
		launchEffect: () => Effect.void as Effect.Effect<void, unknown, never>,
	}) as unknown as DevstackHandle;

describe('setupDevstack — happy path', () => {
	it('globalSetup runs the layer build; globalTeardown runs finalizers', async () => {
		let acquireCount = 0;
		let teardownCount = 0;

		// Effect.addFinalizer wires the teardown into the scope the layer
		// build is constructed against — matches the production shape
		// (docker.run, allocate-port, etc. all register finalizers this way).
		const counterLayer = Layer.effect(
			CounterTag,
			Effect.gen(function* () {
				acquireCount += 1;
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => {
						teardownCount += 1;
					}),
				);
				return { n: acquireCount };
			}),
		) as unknown as Layer.Layer<unknown, unknown, unknown>;

		const fixture = setupDevstack(fakeHandle(counterLayer));

		expect(acquireCount).toBe(0);
		expect(teardownCount).toBe(0);

		await fixture.globalSetup();
		// Layer build executed the acquire body.
		expect(acquireCount).toBe(1);
		// But not the finalizer — the scope is still open.
		expect(teardownCount).toBe(0);

		await fixture.globalTeardown();
		// Scope.close fired the finalizer.
		expect(teardownCount).toBe(1);
	});

	it('globalSetup called twice throws (idempotence is a footgun)', async () => {
		const fixture = setupDevstack(
			fakeHandle(Layer.empty as unknown as Layer.Layer<unknown, unknown, unknown>),
		);
		await fixture.globalSetup();
		await expect(fixture.globalSetup()).rejects.toThrow(/called twice/);
	});

	it('globalTeardown on a never-set-up fixture is a noop (Playwright may invoke teardown unconditionally)', async () => {
		const fixture = setupDevstack(
			fakeHandle(Layer.empty as unknown as Layer.Layer<unknown, unknown, unknown>),
		);
		await expect(fixture.globalTeardown()).resolves.toBeUndefined();
	});
});

describe('setupDevstack — build failure', () => {
	it('on layer-build failure the partially-acquired scope is closed (Batch 5b fix)', async () => {
		// Two sub-layers: the first acquires cleanly + registers a teardown
		// finalizer; the second fails during acquire. The fix's invariant:
		// even though the build never completes, the first layer's
		// finalizer MUST still run.
		let firstAcquired = false;
		let firstTorndown = false;

		const firstLayer = Layer.effect(
			CounterTag,
			Effect.gen(function* () {
				firstAcquired = true;
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => {
						firstTorndown = true;
					}),
				);
				return { n: 1 };
			}),
		);

		const failingLayer = Layer.effect(
			OtherTag,
			Effect.fail(new Error('boom — second primitive failed to acquire')),
		);

		// Merge so both sub-layers fire as part of one build. The second's
		// failure surfaces while the first's acquire has already succeeded.
		const composite = Layer.mergeAll(firstLayer, failingLayer) as unknown as Layer.Layer<
			unknown,
			unknown,
			unknown
		>;

		const fixture = setupDevstack(fakeHandle(composite));

		await expect(fixture.globalSetup()).rejects.toBeDefined();

		// Partially-acquired first layer's finalizer fired before the throw
		// propagated. Without the tapCause → Scope.close path,
		// `firstTorndown` would still be false here.
		expect(firstAcquired).toBe(true);
		expect(firstTorndown).toBe(true);
	});
});
