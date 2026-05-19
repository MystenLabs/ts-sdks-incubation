// Extras config service — the user's raw `app.extras` input (Effect /
// function / plain record), plus the resolved-once `ExtrasResolved`
// memoized Effect consumers actually read.
//
// Three consumers today: `manifest-emit` (writes the resolved blob into
// `app.extras` on disk), `codegen/emitters/stack-handle` (emits
// `<output>/extras.ts`), and `codegen/emitters/dapp-kit-config` (which
// reads through `gatherManifest`'s extras argument).
//
// Lives in `engine/` rather than `runtime/` so the supervisor can wire
// it without an upward dependency on `runtime/`. The `ExtrasInput` type
// is re-exported from `/advanced` so plugin authors composing devstack
// via `defineDevstack(...)` can spell the shape they pass through.
//
// HIGH: `ExtrasResolved` carries a memoized Effect — the user's input
// runs at most once across all consumers. The memoization is created
// at infra-layer build time so the cache is shared across all
// consumers within the same supervisor cycle; the actual resolve runs
// LATE (inside the first consumer's scope, where the user-stack tags
// the input depends on — e.g. `arena.openLobby` — are bound). Pre-fix,
// `ExtrasResolved` held the resolved record directly and the resolve
// ran at infra build time, which couldn't see user-stack tags and
// failed with `ServiceNotFound` on inputs that yielded an Action ref.

import { Context, Effect, Layer } from 'effect';

/** Three accepted shapes — same discriminator as the v3 `manifest()`
 *  factory. Plain object: copied as-is. Sync function: called once.
 *  Effect: yielded. R = any because the user's Effect can yield any
 *  ref in stack scope. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ExtrasInput =
	| Record<string, unknown>
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	| (() => Record<string, unknown> | Effect.Effect<Record<string, unknown>, any, any>)
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	| Effect.Effect<Record<string, unknown>, any, any>;

/** Resolve an `ExtrasInput` to an Effect yielding the record. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const resolveExtras = (
	raw: ExtrasInput | undefined,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Effect.Effect<Record<string, unknown>, any, any> => {
	if (raw === undefined) return Effect.succeed({});
	if (Effect.isEffect(raw)) return raw;
	if (typeof raw === 'function') {
		const v = raw();
		return Effect.isEffect(v) ? v : Effect.succeed(v);
	}
	return Effect.succeed(raw);
};

/** Runtime service carrying the user's raw extras input. Held mostly
 *  for tooling that wants to inspect what the user passed; emitter
 *  + manifest code reads `ExtrasResolved` instead. */
export class Extras extends Context.Service<Extras, ExtrasInput | undefined>()(
	'@devstack/Extras',
) {}

/** Memoized resolver for `app.extras`. The value yielded from this
 *  service is itself an Effect — `yield*` it (inside a consumer that
 *  runs in user-stack scope) to evaluate the user's input. The Effect
 *  is shared across all consumers within the same supervisor cycle,
 *  so the user's input runs at most once even with multiple readers
 *  (manifest-emit + `StackHandleEmitter` + `DappKitConfigEmitter`).
 *
 *  R = any because the user's input can yield any ref the surrounding
 *  user-stack layer exposes (`arena.openLobby`, a `Package` ref, etc.);
 *  consumers run inside that scope so the requirement is satisfied at
 *  read time. */
export class ExtrasResolved extends Context.Service<
	ExtrasResolved,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	Effect.Effect<Record<string, unknown>, any, any>
>()('@devstack/ExtrasResolved') {}

/** Live layer for `Extras` + `ExtrasResolved`. `Extras` is provided
 *  synchronously via `Layer.succeed`. `ExtrasResolved` is wired as a
 *  `Layer.effect` that builds the memoized Effect via `Effect.cached`
 *  at infra-layer build time — the cache is closed over by the
 *  resulting Effect, so subsequent `yield*`s from consumers reuse the
 *  first evaluation's result. */
export const ExtrasLive = (raw: ExtrasInput | undefined): Layer.Layer<Extras | ExtrasResolved> => {
	const rawLayer = Layer.succeed(Extras, raw);
	const resolvedLayer = Layer.effect(
		ExtrasResolved,
		// `Effect.cached(self)` returns `Effect<Effect<A, E, R>>`. We yield
		// the outer here (at layer build) and stash the inner cached Effect
		// in `ExtrasResolved`. The inner retains the user input's R, which
		// is satisfied at consumer-read time by the surrounding user-stack
		// scope.
		Effect.cached(resolveExtras(raw)),
	);
	return Layer.merge(rawLayer, resolvedLayer);
};

/** Empty-extras layer for tests / paths that don't wire user extras. */
export const ExtrasEmpty: Layer.Layer<Extras | ExtrasResolved> = ExtrasLive(undefined);
