// Core: tag plumbing for factory-generated services.
//
// Three primitives, layered:
//
//   provide(TagClass, build)      — primary. Given an EXISTING
//                                   Context.Service class (typically
//                                   imported from a `src/services/` tag
//                                   class like `SuiTag` / `SealKeyServerTag`),
//                                   mutate it into a yieldable Ref by
//                                   stamping `__layer` / `key` onto it.
//                                   Multiple factories (`suiLocalnet`,
//                                   `suiTestnet`, …) can each call
//                                   `provide(SuiTag, …)` and they all
//                                   target the same `Sui` tag.
//
//   tag(name, build)              — sugar. Creates a one-off tag class
//                                   inline. Used by factories that don't
//                                   participate in a shared interface
//                                   (per-account tags, `action`, custom
//                                   plugins). Internally just creates a
//                                   throwaway class and calls provide.
//
//   composeTag(name, build, inner) — sugar around `tag` for composite
//                                   primitives that expose a single outer
//                                   tag whose body yields from inner
//                                   sibling tags. Use this when you want
//                                   the inner siblings to surface as
//                                   engine entries alongside the outer.
//                                   When you DON'T need a new outer tag
//                                   (e.g. a multi-interface acquire body
//                                   like walrusLocalCluster, or one with
//                                   thin projection layers like
//                                   sealLocalKeygen), use `composeLayers`
//                                   directly to assemble the Ref's
//                                   `__layers` array without inventing a
//                                   throwaway outer class.
//
//   composeLayers({primary, inner, projections}) — assemble a
//                                   provider-before-consumer ordered
//                                   layer list for a multi-layer Ref.
//                                   Replaces the comment-heavy hand-
//                                   rolled `__layers` arrays primitives
//                                   used to maintain.
//
// Each tag carries:
//   __layer  — the Layer.effect-wrapped producer for THIS tag.
//   __layers — every Layer needed to satisfy the parent in the runtime
//              graph: own __layer plus transitively-flattened inner
//              layers from composites. defineDevstack mergeAll's this.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Cause, Context, Effect, Layer, Scope } from 'effect';
import { EngineHandle } from '../engine/engine.js';
import { LongLivedScope } from '../engine/long-lived-scope.js';
import { prettyError } from '../engine/pretty-error.js';

// Per-build "what tag am I inside" reference. `withEngineLifecycle`
// overrides it with the wrapped tag's key right before running the
// build body; `setPhase` reads it to know which engine entry to update
// without each call site re-passing the key. The default empty value
// makes the helper a noop when read outside a wrapped build (e.g. unit
// tests that exercise a primitive's effect directly), keeping the
// failure mode silent rather than throwing.
export const CurrentTagKey = Context.Reference<string>('@devstack/CurrentTagKey', {
	defaultValue: () => '',
});

/**
 * Push a sub-phase narration onto the surrounding tag's entry — e.g.
 * `yield* setPhase('building image')` or `yield* setPhase('running
 * genesis')`. The tag key is resolved automatically from the ambient
 * `CurrentTagKey` reference that `withEngineLifecycle` provides, so
 * primitive authors don't have to thread it through manually. Outside
 * an engine-wrapped build (e.g. unit tests), this is a noop.
 */
export const setPhase = (phase: string): Effect.Effect<void> =>
	Effect.gen(function* () {
		const key = yield* CurrentTagKey;
		if (key.length === 0) return;
		const engineOpt = yield* Effect.serviceOption(EngineHandle);
		if (engineOpt._tag === 'None') return;
		yield* engineOpt.value.setPhase(key, phase);
	});

// Phantom brand that gives factory-generated tags nominal identity at
// the type level. Each `name: 'foo'` produces a distinct TagIdentity.
export interface TagIdentity<Name extends string> {
	readonly _tagBrand: 'devstack/tag';
	readonly _tagName: Name;
}

/**
 * Discriminator the TUI renders sections by. Services are long-running
 * daemons users connect to (URLs, ports); actions are one-shot work that
 * completes and produces an artifact (packageId, address, digest).
 */
export type TagKind = 'service' | 'package' | 'account' | 'action' | 'app';

/**
 * User-facing projection of a tag's value into the dashboard row. The
 * selector runs once on successful build with the resolved shape.
 */
export interface TuiDisplay {
	/** Friendly label (e.g. 'sui localnet', 'publish hello', 'account alice'). Falls back to the tag key with the `@devstack/` prefix stripped. */
	readonly title?: string;
	/** Primary artifact — URL for services, packageId/address/digest for actions. */
	readonly primary?: string;
	/** Optional secondary chips rendered to the right of `primary` (e.g. '4 nodes', '12 modules'). */
	readonly extras?: ReadonlyArray<string>;
	/** Multiple labelled endpoints — used by primitives that expose several
	 * URLs (sui's rpc + faucet + graphql). Rendered as indented lines under
	 * the row. When present, the dashboard suppresses `primary` to avoid
	 * duplicating the same URL. */
	readonly endpoints?: ReadonlyArray<{ readonly label: string; readonly url: string }>;
}

/**
 * Lifecycle classification for a tag's resources.
 *
 * - `'per-cycle'` (default): the build's `Effect.acquireRelease` /
 *   `Effect.addFinalizer` resources attach to the per-cycle supervisor
 *   scope. On `r` hot-restart, all resources release and the build re-runs
 *   on the next cycle from a clean slate. Use for primitives that produce
 *   per-cycle artifacts (publishMove → new packageId per cycle is itself
 *   per-cycle, but the underlying Sui container survives; package itself
 *   is the per-cycle wrapper). Most things are per-cycle.
 *
 * - `'long-lived'`: the build's resources attach to the outer
 *   `LongLivedScope` instead. Resources survive `r` hot-restart and only
 *   release on process exit / Ctrl-C / `q`. Use for expensive infra users
 *   want to reuse across cycles (Sui localnet container, walrus storage
 *   nodes, indexer DB). When `LongLivedScope` is absent (standalone tests),
 *   falls back to per-cycle scope automatically.
 */
export type TagLifecycle = 'per-cycle' | 'long-lived';

/**
 * Optional knobs for `provide` / `tag`. `kind` classifies the row into
 * the Services or Actions section; `display` projects the resolved
 * value into the user-facing fields. `displayTitle` is a static
 * fallback rendered while the primitive is still acquiring (before the
 * resolved value exists to feed `display`).
 */
export interface ProvideOptions<A> {
	readonly kind?: TagKind;
	readonly display?: (shape: A) => TuiDisplay;
	/** Friendly name shown in the dashboard while `status === 'pending' | 'acquiring'`,
	 * before `display(value)` runs. Should match the title `display` emits to avoid
	 * a flicker on resolve. */
	readonly displayTitle?: string;
	/**
	 * Lifecycle classification — see {@link TagLifecycle}. When set to
	 * `'long-lived'`, the build effect runs with the ambient `Scope`
	 * substituted to `LongLivedScope`'s value (when present), so any
	 * `Effect.acquireRelease` / `Scope.addFinalizer` inside the build
	 * attaches to the long-lived scope and survives `r` hot-restart.
	 * Defaults to `'per-cycle'`.
	 */
	readonly lifecycle?: TagLifecycle;
	/**
	 * Hide this tag from the TUI dashboard. The build still runs and the
	 * value still resolves — the only effect is suppressing the row
	 * (no `markAcquiring`/`markReady`/`markFailed`/seed entry). Use for
	 * cache-warming primitives whose existence as a dedicated row adds
	 * clutter without surfacing actionable state (e.g. `gitFetch` of
	 * upstream Move sources). A failure inside a hidden tag still
	 * propagates through its consumer's failure path, so user-visible
	 * errors aren't lost.
	 */
	readonly hidden?: boolean;
	/**
	 * Filesystem paths (directories or files) whose content changes should
	 * trigger a hot-restart of the devstack. Aggregated by `defineDevstack`
	 * alongside the top-level `config.watch` so primitive authors can
	 * declare what they care about without forcing every config to repeat
	 * those paths. `publishMove` uses this to auto-watch its Move source
	 * tree; user code typically doesn't need to set it directly.
	 *
	 * Today this triggers a FULL-STACK restart (re-acquires every
	 * primitive, including expensive ones like the walrus committee).
	 * Selective per-primitive tear-down driven by which paths changed
	 * is tracked as future work — the `__watchPaths` field on the
	 * resulting tag is the surface that future implementation will key
	 * on, so declaring paths here today is forward-compatible.
	 */
	readonly watch?: ReadonlyArray<string>;
}

/**
 * Truncate a long on-chain id (Sui addresses, package ids, digests) to
 * the `0xabc…123` shape the dashboard uses. Inputs shorter than the cut
 * are returned unchanged.
 */
export const shortId = (id: string): string => {
	if (id.length <= 12) return id;
	const prefix = id.startsWith('0x') ? id.slice(0, 5) : id.slice(0, 5);
	const suffix = id.slice(-3);
	return `${prefix}…${suffix}`;
};

// User-visible shape of a tag (Ref). Extends Context.Service so it's
// yieldable with the right Effect prototype. Carries R/E as phantom
// parameters so devstack(...) can verify graph closure.
/**
 * Type-parameterized tag. `Name` is the tag's identity key, `A` is the
 * value shape consumers `yield*` to receive, `R` and `E` track required
 * services and possible errors. Plugin authors writing dependencies
 * typically use `Ref<any, YourShape, any, any>`.
 */
export interface Ref<Name extends string, A, R = never, E = never> extends Context.Service<
	TagIdentity<Name>,
	A
> {
	readonly key: Name;
	// The tag's own layer — the Layer.effect-wrapped producer. Internal:
	// `accounts.ts` and `sui.ts` read it directly today; new call sites
	// should compose via `composeLayers` instead of reaching for this
	// field.
	readonly __layer: Layer.Layer<TagIdentity<Name>, E, R>;
	// Transitively-flattened layer list: this tag's own layer plus every
	// inner layer it composes. defineDevstack mergeAll's this list per
	// stack member so inner tags built at factory time (seal's keygen,
	// deepbook's publish, …) are present in the runtime.
	readonly __layers: ReadonlyArray<Layer.Layer<any, any, any>>;
	/** Service vs action classification for TUI sectioning. Absence → 'other'. */
	readonly __kind?: TagKind;
	/** Friendly title surfaced by the dashboard while the tag is still `pending`
	 * (before `markAcquiring` triggers the in-build `setEntryTitle`). Mirrors
	 * the `displayTitle` option passed to `provide` / `tag`. Absence →
	 * fall back to the tag's key. */
	readonly __displayTitle?: string;
	/** Paths the tag's author wants watched for hot-restart. See `ProvideOptions.watch`.
	 * Aggregated by `devstack(...)` into the runtime watch set. */
	readonly __watchPaths?: ReadonlyArray<string>;
	/** When `true`, the tag does not surface as a TUI row. See `ProvideOptions.hidden`. */
	readonly __hidden?: boolean;
}

/**
 * Wrap a tag's build Effect so the engine observes its lifecycle:
 *
 *   pending → acquiring → ready | failed
 *
 * The wrap is applied at tag construction (inside `provide`) so primitive
 * authors don't have to remember to call the engine themselves. The
 * tradeoff is that `EngineHandle` ends up in the R channel of the inner
 * Effect — that's satisfied by `InfraLive` in `devstack(...)`, so user
 * code doesn't need to know about it. Phase tracking is left to authors
 * who add `Effect.withSpan('<tag>.<phase>')` inside `build` — the engine
 * doesn't peek at spans yet (Wave 10+).
 *
 * If a tag is built outside a devstack (e.g. inside a unit test that
 * provides only the tag's layer), `EngineHandle` would be a missing
 * dependency, so we resolve it via `Effect.serviceOption` and fall back
 * to a noop when absent.
 */
const withEngineLifecycle = <A, E, R>(
	name: string,
	build: Effect.Effect<A, E, R>,
	classification: {
		readonly kind?: TagKind;
		readonly display?: (shape: A) => TuiDisplay;
		readonly displayTitle?: string;
		readonly hidden?: boolean;
		readonly lifecycle?: TagLifecycle;
	},
): Effect.Effect<A, E, R> =>
	Effect.gen(function* () {
		// Lifecycle: when `'long-lived'` and `LongLivedScope` is present,
		// substitute the ambient `Scope` with the long-lived one so the
		// build's `Effect.acquireRelease` / `Scope.addFinalizer` resources
		// attach to a scope that survives per-cycle teardown. Standalone
		// callers (unit tests) leave `LongLivedScope` undefined and the
		// build keeps the per-cycle Layer scope, matching prior behavior.
		const longLivedScope =
			classification.lifecycle === 'long-lived' ? yield* LongLivedScope : undefined;
		const liftedBuild: Effect.Effect<A, E, R> =
			longLivedScope !== undefined
				? (build.pipe(Effect.provideService(Scope.Scope, longLivedScope)) as Effect.Effect<A, E, R>)
				: build;
		const engineOpt = yield* Effect.serviceOption(EngineHandle);
		if (engineOpt._tag === 'None') {
			// Still pin CurrentTagKey so `setPhase` calls inside the body
			// land on the no-engine branch without crashing on a missing
			// reference. The reference's defaultValue covers the
			// no-provider case too — this is belt-and-braces for clarity.
			return yield* liftedBuild.pipe(Effect.provideService(CurrentTagKey, name));
		}
		// Hidden tags: the engine never sees this tag, so it can't render a
		// row for it. The build still runs and the value still resolves —
		// failures propagate through the consumer's normal failure path.
		// CurrentTagKey is intentionally left at the empty default so any
		// `setPhase` inside the body is a noop (we have no row to update).
		if (classification.hidden === true) {
			return yield* liftedBuild.pipe(Effect.provideService(CurrentTagKey, ''));
		}
		const engine = engineOpt.value;
		yield* engine.markAcquiring(name, classification.kind);
		// Seed the row's title BEFORE the build body runs so the dashboard
		// shows `accounts.alice` instead of the raw key `account/alice` while
		// the primitive is still acquiring. `markReady` later overrides this
		// with `display(value).title`.
		if (classification.displayTitle !== undefined) {
			yield* engine.setEntryTitle(name, classification.displayTitle);
		}
		// `onExit` fires BEFORE the failure escapes the wrapped effect, so the
		// engine state (and the TUI's log buffer) reflect the failure even on
		// a failed `Layer.build`. The launch loop catches the build failure
		// and waits on `restartSignal`, leaving the rendered failure visible.
		//
		// On failure we ALSO push the full prettyError walk to the global log
		// stream via `appendLog`. `markFailed` already stashed a short summary
		// on the row; the log carries the multi-line stderr+phase tree the
		// user needs to debug — and lives in only ONE place (no per-row
		// duplicate, no umbrella "stack failed" suffix).
		return yield* liftedBuild.pipe(
			Effect.onExit((exit) =>
				exit._tag === 'Success'
					? engine.markReady(
							name,
							classification.display !== undefined ? classification.display(exit.value) : undefined,
						)
					: Effect.gen(function* () {
							yield* engine.markFailed(name, exit.cause);
							yield* engine.appendLog({
								ts: Date.now(),
								level: 'error',
								message: `${name}: ${summarizeCauseForLog(exit.cause)}`,
							});
						}),
			),
			// Pin the ambient tag-key reference so `setPhase` inside the
			// build body knows which engine entry to update without each
			// primitive re-passing the key.
			Effect.provideService(CurrentTagKey, name),
		);
	}) as Effect.Effect<A, E, R>;

// Full cause-tree render for the TUI log row. Tagged errors (DockerError /
// SuiError / …) carry structured fields (stderr, exitCode, phase) that the
// user needs to debug the failure — `Cause.prettyErrors[0]?.message` would
// collapse to just the outermost class's `message`, hiding the root cause.
// Multi-line is fine here because the log region renders entries verbatim.
const summarizeCauseForLog = (cause: Cause.Cause<unknown>): string => prettyError(cause);

// Minimum surface we need from a Context.Service class to build a Layer
// against it: a Context.Key (Layer.effect's first arg) plus the runtime
// `key: string` we read in withEngineLifecycle. Both `provide`'s
// `TagClass` and `Ref` shapes satisfy this.
type AnyTagClass = Context.Key<any, any> & { readonly key: string };

/**
 * Bind a build Effect to an externally-defined Context.Service class —
 * the primary primitive for implementing a shared interface.
 *
 * Use this when your factory is one of several implementations of the
 * same interface (e.g. `suiLocalnet` / `suiTestnet` / `suiMainnet` all
 * targeting `SuiTag`). Import the interface tag class from the matching
 * `src/services/X.ts` (e.g. `SuiTag` from `services/sui.ts`) and pass
 * it as `TagClass`. The same wrap as `tag` (engine lifecycle) is
 * applied, but no new tag class is created — the caller owns the tag.
 *
 * `provide` mutates `TagClass` via `Object.assign` so the canonical
 * Context.Service class itself doubles as a yieldable `Ref` — gaining
 * `__layer` / `key` / `__kind` / `__displayTitle` / `__watchPaths` while
 * keeping its `[Symbol.iterator]` (so `yield* TagClass` continues to
 * work). One canonical tag per stack means one provide call per
 * stack, so the mutation is one-shot in practice — calling two impl
 * factories targeting the same canonical tag in the same stack was
 * always a configuration error.
 */
export const provide = <T extends AnyTagClass, A, E = never, R = never>(
	TagClass: T,
	build: Effect.Effect<A, E, R>,
	options: ProvideOptions<A> = {},
): T & {
	readonly __layer: Layer.Layer<Context.Service.Identifier<T>, E, Exclude<R, Scope.Scope>>;
	readonly key: string;
	readonly __kind?: TagKind;
	readonly __displayTitle?: string;
	readonly __watchPaths?: ReadonlyArray<string>;
	readonly __hidden?: boolean;
} => {
	const wrapped = withEngineLifecycle(TagClass.key, build, options);
	// `Layer.effect`'s key is `Context.Key<I, S>`. The `as any` here is
	// the single load-bearing boundary cast in this file: the build's A
	// must match the tag's Shape, but TS can't infer S from the class
	// type without the caller annotating, so we accept it on faith. All
	// real call sites flow through provide, so this is also the only
	// place `as any` is needed at the Service boundary.
	const layer = Layer.effect(TagClass as Context.Key<Context.Service.Identifier<T>, A>, wrapped);
	const extras: {
		__layer: typeof layer;
		key: string;
		__kind?: TagKind;
		__displayTitle?: string;
		__watchPaths?: ReadonlyArray<string>;
		__hidden?: boolean;
	} = { __layer: layer, key: TagClass.key };
	if (options.kind !== undefined) extras.__kind = options.kind;
	if (options.displayTitle !== undefined) extras.__displayTitle = options.displayTitle;
	if (options.watch !== undefined && options.watch.length > 0) {
		extras.__watchPaths = options.watch;
	}
	if (options.hidden === true) extras.__hidden = true;
	// Mutate the canonical class so it doubles as a yieldable StackMember.
	return Object.assign(TagClass, extras) as unknown as T & typeof extras;
};

// Optional knobs for `tag`. `extraLayers` lets composite primitives
// surface their inner tags' layers without the caller having to know
// about the `__layers` field. Prefer `composeTag` over passing this by
// hand — it's the same shape but with the inner-tag flattening built in.
// `kind` + `display` flow through to the engine for TUI sectioning.
export interface TagOptions<A> extends ProvideOptions<A> {
	readonly extraLayers?: ReadonlyArray<Layer.Layer<any, any, any>>;
}

/**
 * Create a one-off tag from an Effect — the right primitive when you're
 * NOT implementing a shared interface (per-account tags from `Account()`,
 * custom plugins, `Action`, etc.). For factories that target an
 * interface tag class in `src/services/` (e.g. `SuiTag`, `SealKeyServerTag`),
 * use {@link provide} instead. For composites that build inner tags
 * inline, use {@link composeTag}.
 */
export const tag = <const Name extends string, A, E = never, R = never>(
	name: Name,
	build: Effect.Effect<A, E, R>,
	options: TagOptions<A> = {},
): Ref<Name, A, Exclude<R, Scope.Scope>, E> => {
	class T extends Context.Service<TagIdentity<Name>, A>()(name as Name) {}
	const provideOpts: ProvideOptions<A> = {
		...(options.kind !== undefined ? { kind: options.kind } : {}),
		...(options.display !== undefined ? { display: options.display } : {}),
		...(options.displayTitle !== undefined ? { displayTitle: options.displayTitle } : {}),
		...(options.watch !== undefined ? { watch: options.watch } : {}),
		...(options.hidden === true ? { hidden: true } : {}),
		...(options.lifecycle !== undefined ? { lifecycle: options.lifecycle } : {}),
	};
	const { __layer, key } = provide(T, build, provideOpts);
	// Order matters: `composeStackLayer` folds left-to-right with
	// `provideMerge(layer, acc)`, so each layer consumes services from
	// the accumulated acc. Providers must come BEFORE consumers. Inner
	// tags supplied via `extraLayers` provide the services the outer
	// tag's body yields, so they go first; the outer tag's own layer
	// (which consumes them) goes last.
	const __layers: ReadonlyArray<Layer.Layer<any, any, any>> = [
		...(options.extraLayers ?? []),
		__layer,
	];
	// The Object.assign result is typed as the throwaway `typeof T`, which
	// TS can't bridge to `Ref<Name, …>` even though both share the
	// same `TagIdentity<Name>`. Funnel through `unknown` to land on the
	// public type — the runtime shape is identical.
	const extras: {
		__layer: typeof __layer;
		__layers: typeof __layers;
		key: string;
		__kind?: TagKind;
		__displayTitle?: string;
		__watchPaths?: ReadonlyArray<string>;
		__hidden?: boolean;
	} = {
		__layer,
		__layers,
		key,
	};
	if (options.kind !== undefined) extras.__kind = options.kind;
	if (options.displayTitle !== undefined) extras.__displayTitle = options.displayTitle;
	if (options.watch !== undefined && options.watch.length > 0) {
		extras.__watchPaths = options.watch;
	}
	if (options.hidden === true) extras.__hidden = true;
	return Object.assign(T, extras) as unknown as Ref<Name, A, Exclude<R, Scope.Scope>, E>;
};

// composeTag — `tag` for composite primitives. Pass the inner tags
// the body yields; the returned tag's `__layers` includes its own layer
// plus the flattened transitive layers of every inner tag, so
// devstack(...) picks them all up from a single stack-member entry.
//
// The inner-tag yields inside `build` still need their R channel
// satisfied — that happens at Layer.build time via mergeAll, exactly as
// it does for tags listed at the top level of `config.stack`. composeTag
// just makes sure those layers actually reach mergeAll.
/**
 * Composite-tag helper. Aggregates inner tags' `__layers` into the outer
 * tag's transitive layer list. Use this when you need a single outer tag
 * whose body yields from inner sibling tags AND you want the siblings to
 * surface as engine entries alongside the outer. For multi-interface
 * acquire bodies (a single body producing several interface layers via
 * `Layer.effectContext` or thin projection layers), use
 * {@link composeLayers} directly — it assembles the `__layers` array
 * without inventing a throwaway outer tag class.
 *
 * The outer tag is built via `tag` so it carries its own throwaway
 * identity.
 */
export const composeTag = <const Name extends string, A, E = never, R = never>(
	name: Name,
	build: Effect.Effect<A, E, R>,
	innerTags: ReadonlyArray<HasLayers>,
	options: ProvideOptions<A> = {},
): Ref<Name, A, Exclude<R, Scope.Scope>, E> => {
	const extraLayers = flattenInnerLayers(innerTags);
	const merged: TagOptions<A> = {
		extraLayers,
		...(options.kind !== undefined ? { kind: options.kind } : {}),
		...(options.display !== undefined ? { display: options.display } : {}),
		...(options.displayTitle !== undefined ? { displayTitle: options.displayTitle } : {}),
		...(options.lifecycle !== undefined ? { lifecycle: options.lifecycle } : {}),
	};
	return tag(name, build, merged);
};

// Anything that exposes a layer or a transitive layer list — the shape
// `composeLayers` and `composeTag` accept for the `inner` slot. Tags
// produced by `provide` / `tag` / `composeTag` satisfy this, as do
// Refs returned by composite primitives.
interface HasLayers {
	readonly __layer?: Layer.Layer<any, any, any>;
	readonly __layers?: ReadonlyArray<Layer.Layer<any, any, any>>;
}

// Flatten an inner-tag-ish into its layer contribution: prefer the
// transitively-flattened `__layers` list when present, fall back to the
// single `__layer`, drop entries with neither (or `undefined` entries,
// which callers use to express conditional inclusion without a separate
// branch).
const flattenInnerLayers = (
	inner: ReadonlyArray<HasLayers | undefined>,
): ReadonlyArray<Layer.Layer<any, any, any>> =>
	inner.flatMap((t) => {
		if (t === undefined) return [] as ReadonlyArray<Layer.Layer<any, any, any>>;
		if (t.__layers !== undefined) return t.__layers;
		if (t.__layer !== undefined) return [t.__layer];
		return [] as ReadonlyArray<Layer.Layer<any, any, any>>;
	});

export interface ComposeLayersOptions {
	/** Inner sibling tags whose layers must surface alongside `primary`.
	 *  Each entry contributes its `__layers` (preferred) or `__layer`.
	 *  `undefined` entries are dropped — callers use this to express
	 *  conditional inclusion (`[image, source, publish]` where some are
	 *  only defined on certain branches) without a separate `push` loop. */
	readonly inner?: ReadonlyArray<HasLayers | undefined>;
	/** The primary layer for this Ref. Goes after `inner` (so its body
	 *  can consume inner-tag services) but before `projections`. */
	readonly primary: Layer.Layer<any, any, any>;
	/** Thin projection layers that read from `primary` to satisfy
	 *  additional interface tags (e.g. `SealKeyServerTag` + `SealKeyManagerTag`
	 *  both reading from the internal seal tag). Go last because they
	 *  consume `primary`'s output. */
	readonly projections?: ReadonlyArray<Layer.Layer<any, any, any>>;
}

/**
 * Build a provider-before-consumer ordered `__layers` array for a
 * multi-layer Ref. Replaces the comment-heavy hand-rolled
 * `[...inner.__layers, primary, ...projections]` pattern in
 * walrus / seal / deepbook with a single call.
 *
 * Ordering rationale: `composeStackLayer` folds left-to-right with
 * `provideMerge(layer, acc)`, so each new layer consumes services from
 * the accumulated acc. Providers must come BEFORE consumers — inner
 * sibling tags' layers feed `primary`'s body, and `primary`'s output
 * feeds the projection layers' bodies, so the canonical order is
 * `inner → primary → projections`.
 */
export const composeLayers = (
	opts: ComposeLayersOptions,
): ReadonlyArray<Layer.Layer<any, any, any>> => [
	...flattenInnerLayers(opts.inner ?? []),
	opts.primary,
	...(opts.projections ?? []),
];

// Phantom extractors for devstack(...).
export type TagRequires<T> = T extends Ref<any, any, infer R, any> ? R : never;
export type TagErrors<T> = T extends Ref<any, any, any, infer E> ? E : never;
export type TagProvides<T> = T extends Ref<infer N, any, any, any> ? TagIdentity<N> : never;
