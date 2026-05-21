// Substrate context helpers — tiny utilities over `Context`.
//
// Closes one duplication: three sites in `supervisor.ts` open-coded the
// `Context.getOption(ctx, tag)` + `Option.isSome ? value : fallback`
// shape (Logger, RuntimeRoot, CapabilitySinks). The shape was always
// the same — widen the supervisor's name-blind `pluginContext`, look
// up an optional service, fall back when the caller didn't layer it
// in. One helper, no drift.

import { Context, Effect, Option } from 'effect';

/**
 * Read an optional service from a `Context`, or fall back.
 *
 * The `pluginContext` at the supervisor boundary is typed
 * `Context.Context<never>` — the substrate is service-name-blind, so
 * the lookup widens internally to read the optional service.
 *
 * Used at sites where the fallback is a plain value.
 */
export const getOrDefault = <S, I>(
	ctx: Context.Context<never>,
	tag: Context.Key<I, S>,
	fallback: S,
): S => {
	const opt = Context.getOption(ctx as Context.Context<I>, tag);
	return Option.isSome(opt) ? opt.value : fallback;
};

/**
 * Effectful variant of `getOrDefault`. Same lookup; the fallback is
 * an `Effect` so it can build a Layer / acquire a scoped resource
 * only when the optional service isn't present.
 *
 * Used at the CapabilitySinks site — the fallback builds the default
 * sinks Layer; we only want to pay that cost when the caller didn't
 * pre-build one.
 */
export const getOrDefaultEffect = <S, I, E, R>(
	ctx: Context.Context<never>,
	tag: Context.Key<I, S>,
	fallback: Effect.Effect<S, E, R>,
): Effect.Effect<S, E, R> => {
	const opt = Context.getOption(ctx as Context.Context<I>, tag);
	return Option.isSome(opt) ? Effect.succeed(opt.value) : fallback;
};
