// withPhasePreservingProduce — substrate helper for the
// "Ref-stash typed error across ArtifactPublishError wrap" pattern.
//
// Background: `ArtifactPublisher.publish` requires the `produce` Effect
// to surface failures as `ArtifactPublishError` (substrate contract —
// the substrate is name-blind, so domain-typed errors cannot reach the
// substrate's failure channel). For most plugins this is fine: the
// produce body's typed error is projected directly to
// `artifactPublishError('produce-failed', message)` via `mapError` and
// the plugin caller sees a generic ArtifactPublishError it then maps
// back to its domain (e.g. deepbook's `mapArtifactError`).
//
// But the Action plugin needs to preserve the original typed error's
// `phase` discriminator across the wrap: the user-supplied body Effect
// emits `ActionError` with one of several `phase` literals
// (`'sign' | 'parse' | …`), and consumers `catchTag('ActionError')`
// expecting that `phase` to survive. The substrate's wrap would
// uniformly stamp every failure as `phase: 'sign'`.
//
// This helper captures the pattern: stash the typed error in a Ref
// before the mapError boundary, then recover it on the
// `ArtifactPublishError` recovery seam. Only `reason: 'produce-failed'`
// surfaces a stashed typed error — the substrate-side reasons
// (`verify-exhausted`, `cache-corrupt`) have no upstream typed error
// and propagate as ArtifactPublishError untouched.
//
// Boundary discipline: lives under `substrate/runtime/` because the
// pattern is generic over any tagged typed error — no plugin-domain
// shape leaks in. The single piece of plugin knowledge the helper
// requires (the `wrapProduceError` projection) is passed in by the
// caller.
//
// Currently consumed by the Action plugin (`plugins/action/service.ts`).
// The Package plugin (`plugins/package/mode-local.ts:149-152`) has a
// similar shape ripe for migration but has not yet adopted the helper —
// migrate when the next package-plugin pass surfaces.

import { Effect, Ref } from 'effect';

import { type ArtifactPublishError } from '../../primitives/artifact-publisher.ts';

/** Wrap a domain-typed `produce` Effect so the typed error survives the
 *  substrate's `ArtifactPublishError` boundary.
 *
 *  Inputs:
 *   - `produce`: the typed produce Effect (`<Produced, TypedError, R>`).
 *     This is the Effect the caller would otherwise place in
 *     `ArtifactSpec.produce` directly.
 *   - `wrapProduceError`: projects `TypedError` to `ArtifactPublishError`
 *     for the substrate-facing channel. Mirrors the `Effect.mapError`
 *     closure callers would write inline.
 *
 *  Returns `{ wrappedProduce, recoverTypedError }`:
 *   - `wrappedProduce`: the Effect to place in `ArtifactSpec.produce` —
 *     surfaces only `ArtifactPublishError` (substrate contract) but
 *     stashes the typed cause into the Ref before the wrap.
 *   - `recoverTypedError`: a `pipe`-able recovery step. Apply via
 *     `.pipe(recoverTypedError)` AFTER `publisher.publish(...)` to
 *     restore the typed error channel. `reason: 'produce-failed'` lifts
 *     the stashed typed error; other reasons propagate untouched. */
export const withPhasePreservingProduce = <Produced, TypedError, R>(params: {
	readonly produce: Effect.Effect<Produced, TypedError, R>;
	readonly wrapProduceError: (err: TypedError) => ArtifactPublishError;
}): Effect.Effect<
	{
		readonly wrappedProduce: Effect.Effect<Produced, ArtifactPublishError, R>;
		readonly recoverTypedError: <A, E, RR>(
			self: Effect.Effect<A, E, RR>,
		) => Effect.Effect<A, TypedError | Exclude<E, ArtifactPublishError>, RR>;
	},
	never,
	never
> =>
	Effect.gen(function* () {
		// Stash slot — typed `TypedError | null`. Set on `produce` failure
		// BEFORE the mapError boundary so the outer recovery can read it.
		const stashed = yield* Ref.make<TypedError | null>(null);

		const wrappedProduce: Effect.Effect<Produced, ArtifactPublishError, R> = params.produce.pipe(
			// Stash the typed error before the mapError boundary so the
			// outer recovery path can re-raise with the original tag
			// (and phase, for `ActionError`-style discriminators) intact.
			Effect.tapError((err) => Ref.set(stashed, err)),
			Effect.mapError(params.wrapProduceError),
		);

		const recoverTypedError = <A, E, RR>(
			self: Effect.Effect<A, E, RR>,
		): Effect.Effect<A, TypedError | Exclude<E, ArtifactPublishError>, RR> =>
			(self as Effect.Effect<A, E | ArtifactPublishError, RR>).pipe(
				// Recover the stashed typed error if produce raised one.
				// `verify-exhausted` / `cache-corrupt` are substrate-side
				// signals with no upstream typed error — they propagate
				// untouched.
				Effect.catchTag('ArtifactPublishError', (err) =>
					Effect.gen(function* () {
						const seen = yield* Ref.get(stashed);
						const typedErr = err as ArtifactPublishError;
						if (seen !== null && typedErr.reason === 'produce-failed') {
							return yield* Effect.fail(seen);
						}
						return yield* Effect.fail(typedErr);
					}),
				),
			) as Effect.Effect<A, TypedError | Exclude<E, ArtifactPublishError>, RR>;

		return { wrappedProduce, recoverTypedError };
	});
