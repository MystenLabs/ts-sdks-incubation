// Surface-area smoke for `provideDevstack`. The interesting deep
// behavior (per-tag wiring, StateStoreConfig path resolution, infra
// merges) is covered by `composeStackLayer` tests and the integration
// runs in `examples/`. This file locks the public API shape so callers
// don't accidentally regress on the function signature or its return
// type.
//
// We intentionally do NOT build the layer here — `provideDevstack`
// composes infra that acquires real lock files / docker labels, so
// runtime-build coverage belongs in the example integration runs. The
// tests below pin the call surface: it returns a Layer, accepts both
// empty and non-empty stacks, and accepts the documented options
// without throwing at composition time.

import { Layer } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { provideDevstack } from './provide-devstack.js';
import { suiTestnet } from './primitives/sui.js';

describe('provideDevstack', () => {
	it('returns a Layer when called with a non-empty stack', () => {
		// `suiTestnet()` flows its `__layer` through unchanged — the
		// factory's hidden layer must compose into a valid Layer without
		// needing the layer to actually build (that would hit the network).
		const layer = provideDevstack([suiTestnet()]);
		expect(Layer.isLayer(layer)).toBe(true);
	});

	it('returns a Layer when called with an empty stack', () => {
		// Empty stack is a legitimate degenerate case — callers building
		// up the stack programmatically may hand off `[]` initially and
		// `Effect.provide` it as a no-op. Must not blow up at compose time.
		const layer = provideDevstack([]);
		expect(Layer.isLayer(layer)).toBe(true);
	});

	it('accepts every documented option without throwing at compose time', () => {
		// The composition step reads the options synchronously to wire
		// StateStoreConfig + Identity into InfraLive. If a future refactor
		// regresses on option threading (e.g. passes `undefined` through
		// where a defaulted string is expected) this throws at
		// `Layer.succeed(StateStoreConfig, ...)` and the test catches it
		// before the bug ships.
		const layer = provideDevstack([], {
			stackName: 'foo',
			network: 'mainnet',
			stateDir: '/tmp/devstack-test-only',
		});
		expect(Layer.isLayer(layer)).toBe(true);
	});
});
