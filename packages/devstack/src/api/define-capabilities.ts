// Typed contribution-decl authoring helpers.
//
// Plugin authors emit contributions inline from `start` via the typed
// `ctx` verbs (`ctx.codegen`/`ctx.endpoint`/`ctx.snapshotExtra`/
// `ctx.publish`/`ctx.provides`). These helpers build the payload-shaped
// decls those verbs accept, stamping the `kind` discriminant while
// preserving narrow payload types. The five contribution kinds are a
// closed union.

import type { CodegenableDecl } from '../contracts/codegenable.ts';
import type { ProjectionDecl, ProjectionEvent } from '../contracts/projection.ts';
import type { RoutableDecl } from '../contracts/routable.ts';
import type { SnapshotableDecl } from '../contracts/snapshotable.ts';
import type { StrategyContributorDecl } from '../contracts/strategy-contributor.ts';

export const codegenable = <const Emitter extends string>(
	decl: Omit<CodegenableDecl<Emitter>, 'kind'>,
): CodegenableDecl<Emitter> => ({ ...decl, kind: 'codegenable' });

export const snapshotable = (decl: Omit<SnapshotableDecl, 'kind'>): SnapshotableDecl => ({
	...decl,
	kind: 'snapshotable',
});

// Distributive `Omit` so the discriminated `RoutableHttpDecl | RoutableTcpDecl`
// preserves per-variant fields (notably `cors`, which lives on HTTP only).
type RoutableDeclInput = RoutableDecl extends infer T
	? T extends RoutableDecl
		? Omit<T, 'kind'>
		: never
	: never;

export const routable = (decl: RoutableDeclInput): RoutableDecl =>
	({ ...decl, kind: 'routable' }) as RoutableDecl;

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

export const strategyContributor = <const Key extends string, Strategy>(
	decl: Omit<StrategyContributorDecl<Key, Strategy>, 'kind'>,
): StrategyContributorDecl<Key, Strategy> => ({ ...decl, kind: 'strategy-contributor' });
