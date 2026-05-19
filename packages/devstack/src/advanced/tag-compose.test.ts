// Hidden-tag behaviour + composeLayers ordering tests.
//
// Pinned here (rather than `tag.test.ts`) because these exercise the
// integration between `withEngineLifecycle`'s hidden short-circuit and
// the engine's TUI state, plus the layer-order contract that
// `composeStackLayer` relies on. Two test groups:
//
//   1. Hidden tag: `tag(..., { hidden: true })` must run the build
//      and resolve the value, but never call into the EngineHandle —
//      no entry surfaces in `state.entries`, no `markAcquiring` /
//      `markReady` transitions, and `appendLog` / `appendTagLog` are
//      not invoked. A failure inside a hidden tag still propagates
//      to the consumer (we cover this too).
//
//   2. composeLayers ordering: `inner → primary → projections` is the
//      provider-before-consumer fold that `composeStackLayer`
//      depends on. Later registrations win when two layers target
//      the same Context.Reference (deterministic, last-wins).

import { Context, Effect, Layer, Ref } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { EngineHandle, EngineLive, type EngineHandleShape } from '../engine/engine.js';
import { composeLayers, tag } from './tag.js';

const buildEngine = (): Effect.Effect<EngineHandleShape> =>
	Effect.gen(function* () {
		const ctx = yield* Layer.build(EngineLive).pipe(Effect.scoped);
		return Context.get(ctx, EngineHandle);
	});

describe('hidden tag', () => {
	it.effect('build runs and value resolves without surfacing a TUI entry', () =>
		Effect.gen(function* () {
			const engine = yield* buildEngine();
			const observed = yield* Ref.make(false);

			const hidden = tag(
				'hidden-cache-warmer',
				Effect.gen(function* () {
					yield* Ref.set(observed, true);
					return { value: 42 };
				}),
				{ hidden: true },
			);

			// Build the layer + extract the value. The engine is in scope,
			// so withEngineLifecycle's hidden branch is exercised.
			const ctx = yield* Layer.build(hidden.__layer).pipe(
				Effect.scoped,
				Effect.provideService(EngineHandle, engine),
			);
			const value = Context.get(ctx, hidden);

			// Build body actually ran.
			expect(yield* Ref.get(observed)).toBe(true);
			expect(value).toEqual({ value: 42 });

			// Engine state is untouched — no entry, no log appended via
			// the markAcquiring / markReady / appendTagLog calls that the
			// non-hidden branch fires.
			const state = yield* Ref.get(engine.tuiState);
			expect(state.entries.find((e) => e.key === 'hidden-cache-warmer')).toBeUndefined();
		}),
	);

	it.effect('failure inside a hidden tag still propagates to the consumer', () =>
		Effect.gen(function* () {
			const engine = yield* buildEngine();

			const hidden = tag('hidden-fails', Effect.fail('boom' as const), { hidden: true });

			const built = yield* Layer.build(hidden.__layer).pipe(
				Effect.scoped,
				Effect.provideService(EngineHandle, engine),
				Effect.flip,
			);

			// Failure is preserved through the lifecycle wrap.
			expect(built).toBe('boom');
			// And the engine still hasn't observed an entry — hidden never
			// seeded one to mark failed against.
			const state = yield* Ref.get(engine.tuiState);
			expect(state.entries.find((e) => e.key === 'hidden-fails')).toBeUndefined();
		}),
	);

	it.effect('non-hidden tag does surface an entry (control case)', () =>
		Effect.gen(function* () {
			const engine = yield* buildEngine();

			const visible = tag('visible', Effect.succeed({ ok: true }), { kind: 'service' });

			yield* Layer.build(visible.__layer).pipe(
				Effect.scoped,
				Effect.provideService(EngineHandle, engine),
			);

			const state = yield* Ref.get(engine.tuiState);
			expect(state.entries.find((e) => e.key === 'visible')?.status).toBe('ready');
		}),
	);
});

describe('composeLayers ordering', () => {
	// All Layer.empty samples are cast to the wider Layer<any, any, any>
	// signature because `composeLayers`'s `inner` / `__layers` array
	// types use `any`-channel layers (matching what the surrounding
	// LayeredTag types expose). `Layer.empty` is `Layer<never, never,
	// never>`, which is contravariant on its ROut channel — TS won't
	// implicitly widen `never` to `any` on assignment, so we cast at the
	// boundary in tests that only need positional ordering.
	const emptyLayer = (): Layer.Layer<any, any, any> =>
		Layer.empty as unknown as Layer.Layer<any, any, any>;

	it.effect('inner → primary → projections is the emitted order', () =>
		Effect.gen(function* () {
			const innerA = emptyLayer();
			const innerB = emptyLayer();
			const primary = emptyLayer();
			const projA = emptyLayer();
			const projB = emptyLayer();

			const innerTag = { __layers: [innerA, innerB] };
			const layers = composeLayers({
				inner: [innerTag],
				primary,
				projections: [projA, projB],
			});

			expect(layers).toEqual([innerA, innerB, primary, projA, projB]);
		}),
	);

	it.effect('undefined inner entries are dropped (conditional inclusion)', () =>
		Effect.gen(function* () {
			const innerA = emptyLayer();
			const primary = emptyLayer();

			const layers = composeLayers({
				inner: [{ __layer: innerA }, undefined, undefined],
				primary,
			});

			expect(layers).toEqual([innerA, primary]);
		}),
	);

	it.effect('inner __layers takes precedence over __layer (transitive fan-out)', () =>
		Effect.gen(function* () {
			const a = emptyLayer();
			const b = emptyLayer();
			const wrong = emptyLayer();
			const primary = emptyLayer();

			// When both __layers and __layer are present, the transitively-
			// flattened __layers wins so inner composite tags surface their
			// full layer set, not just their own outer layer.
			const layers = composeLayers({
				inner: [{ __layers: [a, b], __layer: wrong }],
				primary,
			});

			expect(layers).toEqual([a, b, primary]);
		}),
	);

	it.effect('later layer wins on overlapping Context.Reference (deterministic last-wins)', () =>
		Effect.gen(function* () {
			class Marker extends Context.Service<Marker, string>()('@test/Marker') {}

			const first = Layer.succeed(Marker, 'first') as unknown as Layer.Layer<any, any, any>;
			const second = Layer.succeed(Marker, 'second') as unknown as Layer.Layer<any, any, any>;

			// composeLayers does NOT do the merge — `composeStackLayer`
			// folds with `provideMerge(layer, acc)`, so the LATER layer
			// in the array wins when both provide the same tag. Pin that
			// invariant here so a refactor of the fold reverses it
			// loudly.
			const layers = composeLayers({
				inner: [{ __layer: first }],
				primary: second,
			});

			// Mirror composeStackLayer's reduce: seed=empty, each layer
			// goes "in front" with the accumulator as its deps. Later
			// entries shadow earlier ones for the same tag.
			const merged = layers.reduce<Layer.Layer<any, any, any>>(
				(acc, layer) => Layer.provideMerge(layer, acc),
				emptyLayer(),
			);
			const ctx = yield* Layer.build(merged).pipe(Effect.scoped);
			expect(Context.get(ctx, Marker)).toBe('second');
		}),
	);
});
