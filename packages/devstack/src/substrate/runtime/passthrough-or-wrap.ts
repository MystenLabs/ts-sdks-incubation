// passthroughOrWrap — collapse the recurring "let known tagged errors
// through; wrap everything else into one canonical plugin-side error"
// shape that every plugin's outer pipeline implements.
//
// Plugins routinely compose `Effect.gen` bodies whose aggregate `E`
// channel includes substrate-side errors with shapes the plugin author
// doesn't statically know (artifact-publisher produce bodies, dependency
// reads). `Effect.catchTags` requires a statically-known tagged union, so
// the recurring pattern is either a long catchTags chain that re-fails
// each known tag, or a runtime `_tag` discriminator check that walks the
// known list and wraps the rest. Both shapes spell out the same logic in
// 10-20 lines per plugin.
//
// This helper centralizes that: caller supplies the list of known tagged
// `_tag` literals plus a `mkUnknown` constructor; helper returns an
// Effect operator that lets known errors through unchanged (typed E
// channel preserved at the call site) and wraps anything else through
// `mkUnknown`.
//
// Distilled-doc § Invariants: already-typed errors must NOT be re-wrapped
// by the catch-all unknown handler. Putting this in one place enforces
// that invariant by construction.

import { Effect } from 'effect';

/** Internal: build the operator from a known-tag set + unknown
 *  wrapper. Shared by both the direct and curried entry points. */
const buildPassthroughOrWrap =
	<KnownE extends { readonly _tag: string }, UnknownE>(
		knownTags: ReadonlyArray<KnownE['_tag']>,
		mkUnknown: (cause: unknown) => UnknownE,
	) =>
	<A, R, EIn = KnownE>(self: Effect.Effect<A, EIn, R>): Effect.Effect<A, KnownE | UnknownE, R> => {
		const known = new Set<string>(knownTags);
		return self.pipe(
			Effect.catch((err: unknown): Effect.Effect<never, KnownE | UnknownE> => {
				if (
					typeof err === 'object' &&
					err !== null &&
					'_tag' in err &&
					typeof (err as { _tag: unknown })._tag === 'string' &&
					known.has((err as { _tag: string })._tag)
				) {
					return Effect.fail(err as KnownE);
				}
				return Effect.fail(mkUnknown(err));
			}),
		);
	};

/** Operator that catches every error: lets through tagged errors whose
 *  `_tag` is in `knownTags`, wraps everything else through `mkUnknown`.
 *
 *  Use this for the outer plugin-pipeline catch where the aggregate E
 *  channel mixes plugin-typed errors with substrate-side unknowns. The
 *  output E channel is `KnownE | UnknownE` — callers parameterize
 *  `KnownE` at the call site (the runtime `_tag` check is the
 *  load-bearing part; the type parameter is documentation + a downstream
 *  narrowing aid).
 *
 *  Two call shapes:
 *  - Direct: `passthroughOrWrap<KnownE, UnknownE>(tags, mkUnknown)` —
 *    explicit on both type params.
 *  - Curried: `passthroughOrWrap.for<KnownE>()(tags, mkUnknown)` — pin
 *    `KnownE` up front so TS infers `UnknownE` from `mkUnknown`'s
 *    return type at the second call. Preferred when `KnownE` is a
 *    plugin-side union that doesn't appear in the args. */
export const passthroughOrWrap: {
	<KnownE extends { readonly _tag: string }, UnknownE>(
		knownTags: ReadonlyArray<KnownE['_tag']>,
		mkUnknown: (cause: unknown) => UnknownE,
	): <A, R, EIn = KnownE>(self: Effect.Effect<A, EIn, R>) => Effect.Effect<A, KnownE | UnknownE, R>;
	for: <KnownE extends { readonly _tag: string }>() => <UnknownE>(
		knownTags: ReadonlyArray<KnownE['_tag']>,
		mkUnknown: (cause: unknown) => UnknownE,
	) => <A, R, EIn = KnownE>(
		self: Effect.Effect<A, EIn, R>,
	) => Effect.Effect<A, KnownE | UnknownE, R>;
} = Object.assign(buildPassthroughOrWrap, {
	for:
		<KnownE extends { readonly _tag: string }>() =>
		<UnknownE>(knownTags: ReadonlyArray<KnownE['_tag']>, mkUnknown: (cause: unknown) => UnknownE) =>
			buildPassthroughOrWrap<KnownE, UnknownE>(knownTags, mkUnknown),
});
