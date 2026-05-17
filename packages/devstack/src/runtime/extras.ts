// Extras config service — the user's raw `app.extras` input (Effect /
// function / plain record), made available to every consumer that
// needs to project them.
//
// Two consumers today: `manifest-emit` (writes the resolved blob into
// `app.extras` on disk) and `codegen/emitters/stack-handle` (emits
// `<output>/extras.ts` with the same blob as typed literals).
//
// The service holds the RAW input, not the resolved value, so it can
// be provided at the infra layer (alongside Identity, StateStoreConfig)
// without running the user's Effect before its dependencies (user refs
// like `Account('alice')`) have acquired. Consumers call `resolveExtras`
// inside their own scope — by the time they fire, every user ref has
// been built into the user layer and is in context.

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

/** Runtime service carrying the user's raw extras input. Consumers
 *  (`manifest-emit`, `StackHandleEmitter`) yield this and then
 *  `resolveExtras(yield* Extras)` inside their own scope, by which point
 *  the refs the user's Effect depends on are guaranteed acquired. */
export class Extras extends Context.Service<Extras, ExtrasInput | undefined>()(
	'@devstack/Extras',
) {}

/** Live layer for `Extras`. `Layer.succeed` so providing the layer is
 *  synchronous — no Effect runs at build time, only when a consumer
 *  yields the resolved value. */
export const ExtrasLive = (raw: ExtrasInput | undefined): Layer.Layer<Extras> =>
	Layer.succeed(Extras, raw);

/** Empty-extras layer for tests / paths that don't wire user extras. */
export const ExtrasEmpty: Layer.Layer<Extras> = ExtrasLive(undefined);
