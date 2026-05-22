// Typed capability builder.
//
// Architecture open question #10 + Phase-3 type-system rules: replaces
// the fragile `as const` array. The variadic helper infers and
// preserves the per-decl narrow tuple shape WITHOUT requiring the
// plugin author to remember `as const`.
//
// Two surfaces:
//
//   - plain arrays (`[snapshotable(...), codegenable(...)]`) are the
//     plugin-authoring shape.
//   - `CapabilityBuilder` — fluent alternative (chainable
//     `.snapshot(decl).route(decl).codegen(decl)`) for cases where
//     branching is convenient.

import type {
	CapabilityDecl,
	CapabilityKind,
	CapabilityPayloadFor,
	ExactCapabilityPayload,
} from '../contracts/capability-decl.ts';
import type { CodegenableDecl } from '../contracts/codegenable.ts';
import type { LifenessClassifierDecl } from '../contracts/liveness-classifier.ts';
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

/**
 * Fluent capability builder. Each method appends one decl and
 * returns a new builder with the tuple's literal type extended.
 */
export interface CapabilityBuilder<Caps extends ReadonlyArray<CapabilityDecl>> {
	readonly snapshot: (
		decl: SnapshotableDecl,
	) => CapabilityBuilder<readonly [...Caps, SnapshotableDecl]>;
	readonly route: (decl: RoutableDecl) => CapabilityBuilder<readonly [...Caps, RoutableDecl]>;
	readonly codegen: <Emitter extends string>(
		decl: CodegenableDecl<Emitter>,
	) => CapabilityBuilder<readonly [...Caps, CodegenableDecl<Emitter>]>;
	readonly strategy: <Key extends string, Strategy>(
		decl: StrategyContributorDecl<Key, Strategy>,
	) => CapabilityBuilder<readonly [...Caps, StrategyContributorDecl<Key, Strategy>]>;
	readonly liveness: (
		decl: LifenessClassifierDecl,
	) => CapabilityBuilder<readonly [...Caps, LifenessClassifierDecl]>;
	readonly build: () => Caps;
}

/** Construct an empty capability builder. */
export function capabilityBuilder(): CapabilityBuilder<readonly []> {
	const make = <Caps extends ReadonlyArray<CapabilityDecl>>(
		acc: Caps,
	): CapabilityBuilder<Caps> => ({
		snapshot: (decl) => make([...acc, decl] as const),
		route: (decl) => make([...acc, decl] as const),
		codegen: (decl) => make([...acc, decl] as const),
		strategy: (decl) => make([...acc, decl] as const),
		liveness: (decl) => make([...acc, decl] as const),
		build: () => acc,
	});
	return make([] as const);
}
