// NodePlugin contract — the universal plugin shape (architecture §1).
//
// Every L2 service and renderer satisfies this. The plugin's
// substrate-level type carries THREE generic pieces of information:
//
//   1. `Provides` — the typed identity of its resolved value (Tag).
//   2. `Consumes` — the typed upstream tag tuple.
//   3. `Caps`    — the literal-typed capability tuple.
//
// The `Caps` generic is load-bearing. Without it, capability decls erase
// to their union form and codegen-emitted shapes resolve to `never` for
// downstream consumers.

import type { Effect } from 'effect';
import type { CapabilityDecl } from '../contracts/index.ts';
import type { LiftedSiblingKey } from './lifted-sibling.ts';
import type { PluginKind, RebootCost } from './lifecycle.ts';
import type { AnyTag, ResolvedOf, Tag, TagIdOf } from './tag.ts';
import type { ChainId } from './brand.ts';
import type { Identity } from './identity.ts';

/** Member brand symbol. Distinguishes a `StackMember` from a
 *  trailing options bag at the variadic call site without requiring
 *  a delimiter. */
export const MEMBER_BRAND: unique symbol = Symbol.for('devstack.member');
export type MemberBrand = typeof MEMBER_BRAND;

export interface MemberBranded {
	readonly [MEMBER_BRAND]: true;
}

/** Plugin runtime context handed to `acquire`. Indexed by the
 *  upstream tag tuple's identity types.
 *
 *  Two accessors, same lookup:
 *
 *  - `get(tag)` — pass the tag directly. Typed against `Provided`; reduces
 *    cleanly when the consumes tuple is concrete at the call site.
 *  - `use(member)` — pass the upstream plugin MEMBER (the value returned
 *    by `account('alice')`, `localPackage(...)`, etc.). The member's
 *    literal-typed `provides` tag is extracted from the argument, so the
 *    returned resolved-value type reduces even when the outer plugin's
 *    `Consumes` generic carries the tuple (the case where `get(tag)`'s
 *    `T extends Provided` constraint widens to the substrate-erased
 *    `AnyTag` — the cast-as-escape-hatch documented in STYLE_GUIDE §14).
 *    Membership in `Consumes` is enforced structurally: a member whose
 *    provided tag id is not in the acquiring plugin's `Consumes` surfaces
 *    a `__MemberNotConsumedError<Id>` at the argument position. */
export interface BuildContext<Provided extends AnyTag> {
	get<T extends Provided>(tag: T): ResolvedOf<T>;
	use<M extends AnyMember>(
		member: M &
			(TagIdOf<M['provides']> extends TagIdOf<Provided>
				? unknown
				: __MemberNotConsumedError<TagIdOf<M['provides']>>),
	): ResolvedOf<M['provides']>;
}

/** Branded structured error — surfaced when `ctx.use(member)` is called
 *  with a member whose provided tag id is not in the acquiring plugin's
 *  `Consumes`. Mirrors the shape of `__MissingProvidersError` /
 *  `__SiblingHashConflictError` / `__UnsatisfiedWitnessesError` so the
 *  diagnostic names the offending tag id at the IDE call site. */
export interface __MemberNotConsumedError<NotConsumed extends string> {
	readonly __member_not_consumed: NotConsumed;
}

/**
 * Per-plugin error class metadata. Plugin-tagged errors live with
 * the plugin (architecture: per-plugin tagged errors).
 *
 * Plugins surface their error vocabulary via the optional
 * `errorContributions` field on `StackMember`; the supervisor's
 * harvest loop folds these into the substrate's `FormatterRegistry`
 * (consumed by the cascade formatter). The `formatter` slot is
 * optional — a plugin can register tags WITHOUT a custom renderer
 * (the cascade formatter's default render path handles the tagged
 * shape) and overlay a custom formatter when the default doesn't
 * surface a domain field nicely.
 */
export interface PluginErrorContribution {
	readonly _tag: 'PluginErrorContribution';
	readonly errorTags: ReadonlyArray<string>;
	/** Optional per-tag custom renderer. If absent, the cascade
	 *  formatter's default tagged-error rendering applies. Recurse is
	 *  the formatter-supplied callback for nested values (e.g. the
	 *  error's `cause` field). */
	readonly formatter?: (
		value: { readonly _tag: string } & Readonly<Record<string, unknown>>,
		recurse: (inner: unknown) => string,
	) => string | null;
}

/**
 * Watch path declaration consumed by L3 watch dispatcher.
 *
 * `paths` are glob patterns relative to the user's app root. The L0
 * thick watcher (minimatch + 250ms debounce + content-hash dedup)
 * filters before dispatch.
 */
export interface WatchDecl {
	readonly paths: ReadonlyArray<string>;
	/** If true, restart cascades to downstream consumers along
	 *  dep-graph edges. Default `true`. */
	readonly cascade?: boolean;
}

/**
 * Acquire-time context handed to a plugin's dynamic capability
 * factory AFTER `acquire` returns. Carries the resolved identity
 * triple + the on-disk runtime root so capability decls (snapshot
 * subtrees, codegen bindings, routable URLs) can stamp the REAL
 * values instead of factory-time placeholders.
 *
 * The substrate guarantees these fields are populated before the
 * factory runs (they come from the supervisor's plugin context).
 */
export interface AcquireContext {
	readonly identity: Identity;
	readonly chain: ChainId;
	readonly runtimeRoot: string;
}

/**
 * Dynamic capability factory — invoked POST-acquire with the
 * resolved value and the acquire context. Lets plugins construct
 * capability decls whose identity/chain/package-id fields reference
 * the actually-resolved data instead of placeholder strings.
 *
 * The static form (a plain `Caps` tuple) is still supported for
 * plugins that don't need acquire-time data.
 */
export type CapabilitiesFactory<Caps extends ReadonlyArray<CapabilityDecl>, Resolved> = (
	resolved: Resolved,
	ctx: AcquireContext,
) => Caps;

/**
 * Substrate-level plugin instance shape.
 *
 * Four generics:
 *  - `Provides` — the Tag this plugin resolves (its identity).
 *  - `Consumes` — typed upstream tag tuple.
 *  - `Caps`     — literal-typed capability decl tuple. MUST stay
 *                 narrow — see file header.
 *  - `Siblings` — literal-typed lifted-sibling-key tuple. Preserves
 *                 the literal `inputHash` so the stack-level dedup
 *                 conflict check can fire at compile time.
 */
export interface StackMember<
	Provides extends AnyTag,
	Consumes extends ReadonlyArray<AnyTag>,
	Caps extends ReadonlyArray<CapabilityDecl> = ReadonlyArray<CapabilityDecl>,
	Siblings extends ReadonlyArray<LiftedSiblingKey> = ReadonlyArray<LiftedSiblingKey>,
> extends MemberBranded {
	readonly provides: Provides;
	readonly consumes: Consumes;
	readonly kind: PluginKind;
	readonly rebootCost?: RebootCost;
	readonly watch?: WatchDecl;
	/**
	 * Acquire procedure. Effect-flavored: the build runs inside the
	 * plugin's Scope and may yield to substrate primitives. The
	 * returned value MUST match the provided tag's resolved shape.
	 *
	 * The error channel `E` is the union of the plugin's tagged
	 * errors plus engine-tagged errors injected by primitives the
	 * plugin uses (lease broker exhaustion, lock contention, etc.);
	 * the substrate-level shape stays open.
	 *
	 * The `R` channel carries the substrate-context services the
	 * acquire body yields (e.g. `IdentityContext`, `ContainerRuntimeService`,
	 * `RuntimeRoot`, `StackPathsService`, etc.). The supervisor's
	 * acquire path provides these BEFORE running the effect — so from
	 * the plugin's perspective, yielding any of them is type-safe and
	 * resolves to the live substrate instance. `Scope.Scope` is
	 * always available (the per-plugin scope owns acquire finalizers).
	 *
	 * The `any` on R is load-bearing: plugins declare their needs by
	 * yielding the services they want from within `Effect.gen`, and
	 * the inferred R is checked against the supervisor's provided set
	 * at the boundary where the supervisor casts to invoke the effect.
	 */
	readonly acquire: (
		ctx: BuildContext<Consumes[number]>,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	) => Effect.Effect<ResolvedOf<Provides>, any, any>;
	/**
	 * Capability tuple. Two accepted shapes:
	 *
	 *   (a) Static — a plain `Caps` tuple. Read at factory time, all
	 *       values known statically. Use this when the plugin's
	 *       decls don't reference acquire-resolved data.
	 *
	 *   (b) Dynamic — a function `(resolved, acquireCtx) => Caps`.
	 *       Invoked by the supervisor AFTER `acquire` succeeds,
	 *       with the resolved plugin value + the closed identity /
	 *       chain / runtimeRoot triple. Use this when decls want to
	 *       reference the real chain id, package id, network alias,
	 *       etc. (snapshot subtrees, codegen bindings, routable
	 *       URLs).
	 *
	 * Backwards-compatible — existing static-form plugins keep
	 * working unchanged.
	 */
	readonly capabilities?: Caps | CapabilitiesFactory<Caps, ResolvedOf<Provides>>;
	readonly liftedSiblings?: Siblings;
	/** Opaque display projection hint — renderer-interpreted only.
	 *  Engine never reads. */
	readonly displayHint?: unknown;
	/** Plugin-side error vocabulary. Harvested by the supervisor on
	 *  successful acquire and folded into the substrate's
	 *  `FormatterRegistry`. Substrate stays name-blind: it dispatches
	 *  on `_tag` strings the plugin declares, never on a plugin
	 *  identifier. Empty / absent => the cause walker still renders
	 *  the tagged shape via its default path. */
	readonly errorContributions?: ReadonlyArray<PluginErrorContribution>;
}

/** Erased member type for variadic upcasts. The two `any`s here are
 *  load-bearing — see `tag.ts` for the variance discussion. */
export type AnyMember = StackMember<
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	Tag<string, any>,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	ReadonlyArray<Tag<string, any>>,
	ReadonlyArray<CapabilityDecl>,
	ReadonlyArray<LiftedSiblingKey>
>;

/** Type-level helpers consumed by the API layer for missing-provider
 *  diagnosis (architecture open-question #11 — branded error types).
 *
 *  IMPORTANT: `Members extends ReadonlyArray<AnyMember>` as a constraint
 *  causes the compiler to widen `Members[K]` to `AnyMember` inside
 *  dependent computations — `Tag<infer Id, ...>` then collapses to
 *  `Id = string` because the constraint's tag is the wide
 *  `Tag<string, any>`. Helpers therefore take the wider
 *  `ReadonlyArray<unknown>` constraint and pattern-match the per-member
 *  shape locally. Callers still pass their `AnyMember`-shaped tuple;
 *  the constraint widening is purely a per-helper concern. */
export type ProvidedIdsOf<Members> =
	Members extends ReadonlyArray<unknown>
		? Members[number] extends { readonly provides: Tag<infer Id, unknown> }
			? Id
			: never
		: never;

/** ConsumedIdsOf — extracts the tag-id union consumed by any member.
 *
 *  IMPORTANT: the two-step shape
 *  `consumes: ReadonlyArray<infer C>; C extends Tag<infer Id, ...>` and
 *  the one-step `consumes: ReadonlyArray<Tag<infer Id, ...>>` BOTH
 *  widen `Id` to `string` when the member's `consumes` is the empty
 *  tuple `readonly []`. Empty-array element type infers as `never`,
 *  and `Tag<infer Id, ...>` on `never` collapses to `string` rather
 *  than `never`. Workaround: special-case the empty tuple via the
 *  `consumes['length']` discriminator before the inference site. */
export type ConsumedIdsOf<Members> =
	Members extends ReadonlyArray<unknown>
		? Members[number] extends infer M
			? M extends { readonly consumes: { readonly length: 0 } }
				? never
				: M extends { readonly consumes: ReadonlyArray<Tag<infer Id, unknown>> }
					? Id
					: never
			: never
		: never;

export type MissingProviders<Members> = Exclude<ConsumedIdsOf<Members>, ProvidedIdsOf<Members>>;

/**
 * Branded error type for missing-provider diagnostics. Replaces the
 * opaque "not assignable to parameter of type 'never'" diagnostic
 * (architecture open question #11).
 */
export interface __MissingProvidersError<Missing extends string> {
	readonly __missing_providers: Missing;
}
