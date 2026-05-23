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
import type { ProjectionDecl } from '../contracts/projection.ts';
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

export const routable = (decl: Omit<RoutableDecl, 'kind'>): RoutableDecl =>
	capability('routable', decl) as RoutableDecl;

export const projection = (decl: Omit<ProjectionDecl, 'kind'>): ProjectionDecl =>
	capability('projection', decl);

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
