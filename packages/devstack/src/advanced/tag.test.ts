// Unit tests for the tag substrate's lifecycle wrap.
//
// Per Phase 2 of selective-restart, every primitive's resources attach
// to its own layer scope automatically — there is no `lifecycle` option
// anymore. These tests pin:
//
//   1. The build's `Effect.addFinalizer` attaches to the ambient Layer
//      scope (the per-primitive scope Effect's MemoMap forks for each
//      Layer.effect).
//   2. The shape of a `tag` return value (key, __layer, __layers).
//   3. The deletion of the `lifecycle` field — a meta-test using
//      `@ts-expect-error` so a future re-introduction fails typecheck.

import { Effect, Exit, Layer, Ref, Scope } from 'effect';
import { describe, expect, it } from 'vitest';
import { it as itEffect } from '@effect/vitest';
import { tag } from './tag.js';

describe('tag() lifecycle wrap', () => {
	itEffect.effect("build's finalizer attaches to the ambient (per-primitive) scope", () =>
		Effect.gen(function* () {
			const finalizerFired = yield* Ref.make(false);

			const sample = tag(
				'lifecycle-default',
				Effect.gen(function* () {
					yield* Effect.addFinalizer(() => Ref.set(finalizerFired, true));
					return { ok: true };
				}),
			);

			// Build the layer inside a fresh per-cycle scope.
			const perCycle = yield* Scope.make();
			yield* Effect.scoped(Layer.build(sample.__layer)).pipe(Scope.provide(perCycle));

			// Closing the per-cycle scope fires the finalizer — there is no
			// long-lived escape hatch anymore.
			yield* Scope.close(perCycle, Exit.void);
			expect(yield* Ref.get(finalizerFired)).toBe(true);
		}),
	);
});

// A trivial smoke test that the tag shape stays intact: key, __layer, __layers.
describe('tag() shape', () => {
	it('surfaces __layer and __layers', () => {
		const t = tag('shape', Effect.succeed({ ok: true }));
		expect(t.key).toBe('shape');
		expect(t.__layer).toBeDefined();
		expect(t.__layers.length).toBeGreaterThan(0);
	});

	it('rejects `lifecycle` at the type level (P2.T3 — option deletion meta-test)', () => {
		// Type-level negative assertion: the `lifecycle` field used to be
		// part of `TagOptions` / `ProvideOptions`; Phase 2 of selective-restart
		// deleted it. If a future change re-adds it the `@ts-expect-error`
		// directive flags as unused, surfacing the regression at typecheck.
		// @ts-expect-error — `lifecycle` is no longer a valid TagOption.
		void tag('lifecycle-removed', Effect.succeed({ ok: true }), { lifecycle: 'long-lived' });
		expect(true).toBe(true);
	});
});
