// Typed contribution-decl authoring helpers.
//
// Plugin authors emit contributions inline from `start` via the typed
// `ctx` verbs (`ctx.codegen`/`ctx.endpoint`/`ctx.snapshotExtra`/
// `ctx.publish`/`ctx.provides`). This helper builds the payload-shaped
// decl `ctx.publish` accepts, stamping the `kind` discriminant while
// preserving narrow payload types. `projection` is the one helper with
// live plugin-author call sites; the remaining contribution kinds
// (codegenable / routable / snapshotable / strategy-contributor) are
// built inline by the built-in plugins as object literals.

import type { ProjectionDecl, ProjectionEvent } from '../contracts/projection.ts';

/** Build a `ProjectionDecl` envelope from a `{kind, key, payload}`
 *  shorthand. Stamps `tag: 'projection.updated'` and (when `at` is
 *  omitted) the current `Date.now()`. Callers that want the projection
 *  payload's `updatedAt` field to match the envelope's `at` should pass
 *  `at` explicitly. Plugin authors should prefer this shorthand over
 *  building the full envelope by hand — the substrate reserves the
 *  right to extend the envelope shape (e.g. add cause metadata)
 *  without consumers re-spelling each emission site. */
export const projection = (
	input:
		| (Omit<ProjectionEvent, 'tag' | 'at'> & { readonly at?: number })
		| Omit<ProjectionDecl, 'kind'>,
): ProjectionDecl => {
	if ('event' in input) return { ...input, kind: 'projection' };
	return {
		kind: 'projection',
		event: {
			tag: 'projection.updated',
			kind: input.kind,
			key: input.key,
			payload: input.payload,
			at: input.at ?? Date.now(),
		},
	};
};
