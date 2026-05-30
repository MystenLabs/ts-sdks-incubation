// Typed capability helpers. Plugin authors return plain capability
// arrays from `definePlugin({ capabilities })`; these helpers add the
// discriminant while preserving narrow payload types.

import type {
	CapabilityDecl,
	CapabilityKind,
	CapabilityPayloadFor,
	ExactCapabilityPayload,
} from '../contracts/capability-decl.ts';
import type { CodegenableDecl } from '../contracts/codegenable.ts';
import type { ProjectionDecl, ProjectionEvent } from '../contracts/projection.ts';
import type { RoutableDecl } from '../contracts/routable.ts';
import type { SnapshotableDecl } from '../contracts/snapshotable.ts';
import type { StrategyContributorDecl } from '../contracts/strategy-contributor.ts';
import type {
	CapabilitySink,
	ContributionKind,
	HarvestContext,
} from '../substrate/runtime/capability-sinks/service.ts';
import type { Effect, Scope } from 'effect';

export const capability = <
	const Kind extends string,
	const Data extends CapabilityPayloadFor<Kind>,
>(
	kind: Kind,
	data: Data & ExactCapabilityPayload<Kind, Data>,
): CapabilityDecl<Kind> & Readonly<Data> =>
	({
		...data,
		kind,
	}) as CapabilityDecl<Kind> & Readonly<Data>;

export const defineCapability =
	<const Kind extends string>(kind: Kind) =>
	<const Data extends CapabilityPayloadFor<Kind>>(
		data: Data & ExactCapabilityPayload<Kind, Data>,
	) =>
		capability<Kind, Data>(kind, data);

export const codegenable = <const Emitter extends string>(
	decl: Omit<CodegenableDecl<Emitter>, 'kind'>,
): CodegenableDecl<Emitter> => capability('codegenable', decl);

export const snapshotable = (decl: Omit<SnapshotableDecl, 'kind'>): SnapshotableDecl =>
	capability('snapshotable', decl);

// Distributive `Omit` so the discriminated `RoutableHttpDecl | RoutableTcpDecl`
// preserves per-variant fields (notably `cors`, which lives on HTTP only).
type RoutableDeclInput = RoutableDecl extends infer T
	? T extends RoutableDecl
		? Omit<T, 'kind'>
		: never
	: never;

export const routable = (decl: RoutableDeclInput): RoutableDecl =>
	capability('routable', decl) as RoutableDecl;

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
	if ('event' in input) return capability('projection', input);
	return capability('projection', {
		event: {
			tag: 'projection.updated',
			kind: input.kind,
			key: input.key,
			payload: input.payload,
			at: input.at ?? Date.now(),
		},
	});
};

export const strategyContributor = <const Key extends string, Strategy>(
	decl: Omit<StrategyContributorDecl<Key, Strategy>, 'kind'>,
): StrategyContributorDecl<Key, Strategy> => capability('strategy-contributor', decl);

export const capabilitySink = <
	const Kind extends ContributionKind,
	Decl extends Kind extends CapabilityKind
		? Extract<CapabilityDecl, { readonly kind: Kind }>
		: Readonly<{ readonly kind: Kind } & object>,
>(
	kind: Kind,
	accept: (decl: Decl, ctx: HarvestContext) => Effect.Effect<void, never, Scope.Scope>,
): CapabilitySink<Kind, Decl> => ({ kind, accept });
