// Unit tests for the tag substrate's `lifecycle` option.
//
// `lifecycle: 'long-lived'` redirects a build's `Scope`-attached finalizers
// to the ambient `LongLivedScope` reference (when present) instead of the
// per-cycle scope `Layer.effect` would otherwise hand to the build. This
// is the mechanism the auto-attached Docker.run / SuiBuildContainer
// finalizers already use internally; the `lifecycle` option exposes it as
// a declarative knob plugin-author tags can opt into.

import { Effect, Exit, Layer, Ref, Scope } from 'effect';
import { describe, expect, it } from 'vitest';
import { it as itEffect } from '@effect/vitest';
import { tag } from './tag.js';
import { LongLivedScope } from '../engine/long-lived-scope.js';

describe('tag() lifecycle option', () => {
	itEffect.effect(
		"'long-lived' attaches the build's finalizer to LongLivedScope, not the per-cycle scope",
		() =>
			Effect.gen(function* () {
				const finalizerFired = yield* Ref.make(false);

				const longLived = yield* Scope.make();

				const sample = tag(
					'lifecycle-long-lived',
					Effect.gen(function* () {
						yield* Effect.addFinalizer(() => Ref.set(finalizerFired, true));
						return { ok: true };
					}),
					{ lifecycle: 'long-lived' },
				);

				// Build the layer inside a per-cycle scope; provide LongLivedScope
				// so the lifecycle redirect kicks in. The build returns its value
				// and the per-cycle scope keeps Layer-internal bookkeeping, but
				// the user's finalizer should now belong to longLived.
				const perCycle = yield* Scope.make();
				yield* Effect.scoped(Layer.build(sample.__layer)).pipe(
					Scope.provide(perCycle),
					Effect.provideService(LongLivedScope, longLived),
				);

				// Per-cycle scope closes; finalizer must NOT fire because it's
				// attached to longLived.
				yield* Scope.close(perCycle, Exit.void);
				expect(yield* Ref.get(finalizerFired)).toBe(false);

				// longLived closes; finalizer fires.
				yield* Scope.close(longLived, Exit.void);
				expect(yield* Ref.get(finalizerFired)).toBe(true);
			}),
	);

	itEffect.effect("'per-cycle' (default) attaches the finalizer to the per-cycle scope", () =>
		Effect.gen(function* () {
			const finalizerFired = yield* Ref.make(false);
			const longLived = yield* Scope.make();

			const sample = tag(
				'lifecycle-per-cycle',
				Effect.gen(function* () {
					yield* Effect.addFinalizer(() => Ref.set(finalizerFired, true));
					return { ok: true };
				}),
				// no lifecycle → defaults to per-cycle
			);

			const perCycle = yield* Scope.make();
			yield* Effect.scoped(Layer.build(sample.__layer)).pipe(
				Scope.provide(perCycle),
				Effect.provideService(LongLivedScope, longLived),
			);

			// Closing per-cycle fires the finalizer immediately even though
			// LongLivedScope is in context — the lifecycle redirect only
			// fires when explicitly opted in.
			yield* Scope.close(perCycle, Exit.void);
			expect(yield* Ref.get(finalizerFired)).toBe(true);

			yield* Scope.close(longLived, Exit.void);
		}),
	);

	itEffect.effect("'long-lived' without LongLivedScope falls back to per-cycle", () =>
		Effect.gen(function* () {
			const finalizerFired = yield* Ref.make(false);

			const sample = tag(
				'lifecycle-long-lived-no-outer',
				Effect.gen(function* () {
					yield* Effect.addFinalizer(() => Ref.set(finalizerFired, true));
					return { ok: true };
				}),
				{ lifecycle: 'long-lived' },
			);

			// No LongLivedScope provided (defaultValue undefined) → fall back
			// to the per-cycle scope. Matches standalone-test ergonomics:
			// every long-lived tag works without a supervisor wrapper.
			const perCycle = yield* Scope.make();
			yield* Effect.scoped(Layer.build(sample.__layer)).pipe(Scope.provide(perCycle));

			yield* Scope.close(perCycle, Exit.void);
			expect(yield* Ref.get(finalizerFired)).toBe(true);
		}),
	);
});

// A trivial smoke test that the lifecycle option doesn't break the
// existing tag shape (key, __layer, __layers).
describe('tag() shape with lifecycle option', () => {
	it("a 'long-lived' tag still surfaces __layer and __layers", () => {
		const t = tag('shape', Effect.succeed({ ok: true }), { lifecycle: 'long-lived' });
		expect(t.key).toBe('shape');
		expect(t.__layer).toBeDefined();
		expect(t.__layers.length).toBeGreaterThan(0);
	});
});
