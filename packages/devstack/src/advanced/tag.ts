// Core: tag plumbing for factory-generated services.
//
// Three primitives, layered:
//
//   provide(TagClass, build)      — primary. Given an EXISTING
//                                   Context.Service class (typically
//                                   imported from a `src/services/` tag
//                                   class like `SuiTag` / `SealKeyServerTag`),
//                                   mutate it into a yieldable LayeredTag by
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
//   composeLayers({primary, inner, projections}) — assemble a
//                                   provider-before-consumer ordered
//                                   layer list for a multi-layer LayeredTag.
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
import { Identity } from '../engine/identity.js';
import { annotateDevstackContext } from '../engine/observability.js';
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
 * Unique-symbol brand stamped onto every stack member (the struct
 * `provide` / `tag` returns). Discriminates a devstack tag from a plain
 * options object at runtime without resorting to a string-keyed field
 * check. Lives alongside the existing `__layer` (which remains the
 * actual Layer producer consumed elsewhere) — the brand exists purely
 * for type-safe runtime narrowing.
 */
export const DevstackTagBrand: unique symbol = Symbol.for('@devstack/tag-brand');

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
	/** Plugin name attribution — drives the leading `[plugin]` chip and the
	 * row's section color in the TUI. All services from the same plugin
	 * share a color so the user can scan by source ("blue = walrus"). In-tree
	 * plugins use a stable predefined map (see `tui/components.tsx`
	 * `pluginColor`); out-of-tree plugins fall back to a name-hash. */
	readonly plugin?: string;
}

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
	/** Plugin attribution — drives the leading `[plugin]` chip in the TUI and
	 * the row's section color (so all rows from one plugin share a color the
	 * user can learn). In-tree services pass their plugin's short name
	 * (`'sui'`, `'walrus'`, `'seal'`, `'deepbook'`, `'coin'`, `'wallet'`,
	 * `'move'`). Out-of-tree plugins pass any short string; the TUI falls
	 * back to a name-hash palette for plugins not in its predefined map. */
	readonly plugin?: string;
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
	 * Static upstream-dep declaration: the keys of OTHER stack members
	 * this primitive's build body yields (or otherwise depends on for
	 * ordering). Populated automatically from plugin-author primitives'
	 * `dependsOn:` arrays; composite primitives (walrus / seal / deepbook)
	 * declare it explicitly because their inner tags are scheduled the
	 * same way as top-level members.
	 *
	 * Accepts either a `LayeredTag` (its `.key` is read) or a bare string
	 * (the tag's key directly). The substrate flattens this list at
	 * factory time and stamps the result onto `StackMember.__upstreamKeys`
	 * — the field `buildDepGraph` (engine/dep-graph.ts) reads to compute
	 * the dep graph + downstream-closure for selective restart, and that
	 * Phase B's topological scheduler will read to lay out parallel
	 * build levels.
	 *
	 * For Phase A this field is data-only: the existing `composeStackLayer`
	 * fold still drives runtime ordering. Phase B replaces the fold with
	 * a topo-level scheduler that consults this declaration as the source
	 * of truth.
	 *
	 * Unknown / dangling references (a key not present in the stack) are
	 * tolerated by `buildDepGraph` and dropped — see `dep-graph.ts` for
	 * the rationale (a primitive's `dependsOn:` may mention a service the
	 * user didn't include in this particular stack composition).
	 */
	readonly upstreamKeys?: ReadonlyArray<LayeredTag<any, any, any, any> | string>;
	/**
	 * `.gitignore`-style patterns describing what should trigger a
	 * hot-restart of the devstack. Aggregated by `defineDevstack` alongside
	 * the top-level `config.watch`, then matched against fs events with
	 * gitignore semantics: an event fires iff it matches a positive
	 * pattern AND does not match any `!`-negated pattern.
	 *
	 * `publishMove` declares the package's Move source tree this way;
	 * `Codegen` declares its output directory as a `!`-negation so the
	 * atomic-rename swap on each cycle doesn't loop the watcher.
	 *
	 * Pattern syntax (subset of `.gitignore`):
	 *  - Bare path (no `*`/`?`/`!`) is a prefix include: `move/vault`
	 *    matches `move/vault` and everything beneath it.
	 *  - Leading `!` negates: `!**\/build/**` excludes `build/` anywhere.
	 *  - `*` matches anything except `/`. `?` matches one char.
	 *  - `**` matches zero or more path segments.
	 *  - Trailing `/` matches the directory and its contents.
	 *  - Relative patterns resolve against `process.cwd()` at compose
	 *    time; absolute patterns are used as-is. (Negation patterns
	 *    apply globally regardless of which positive pattern picked
	 *    the path up.)
	 *
	 * Today this triggers a FULL-STACK restart (re-acquires every
	 * primitive). Selective per-primitive tear-down driven by which paths
	 * changed is tracked as future work — the `__watchPaths` field on the
	 * resulting tag is the surface that future implementation will key
	 * on, so declaring paths here today is forward-compatible.
	 */
	readonly watch?: ReadonlyArray<string>;
}

// User-visible shape of a tag (LayeredTag). Extends Context.Service so it's
// yieldable with the right Effect prototype. Carries R/E as phantom
// parameters so devstack(...) can verify graph closure.
/**
 * Type-parameterized tag. `Name` is the tag's identity key, `A` is the
 * value shape consumers `yield*` to receive, `R` and `E` track required
 * services and possible errors. Plugin authors writing dependencies
 * typically use `LayeredTag<any, YourShape, any, any>`.
 */
export interface LayeredTag<Name extends string, A, R = never, E = never> extends Context.Service<
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
	/** `.gitignore`-style watch patterns (positive includes + `!`-negations).
	 * See `ProvideOptions.watch`. Aggregated by `devstack(...)` into the
	 * runtime watch set, compiled against `DEFAULT_WATCH_EXCLUDES` in
	 * `supervisor.ts::compileWatchFilter`. */
	readonly __watchPaths?: ReadonlyArray<string>;
	/** Plugin attribution — see `ProvideOptions.plugin`. Stamped onto the
	 * stack member so the supervisor's seed pass can color/sort entries
	 * before the build body even runs. */
	readonly __pluginName?: string;
	/** When `true`, the tag does not surface as a TUI row. See `ProvideOptions.hidden`. */
	readonly __hidden?: boolean;
	/**
	 * Static upstream-dep declaration (Phase A of
	 * `notes/parallel-graph-resolution.md`). Resolved at factory time
	 * from `ProvideOptions.upstreamKeys` — either a `LayeredTag`
	 * (the field reads its `.key`) or a bare string. `buildDepGraph`
	 * consumes this; Phase B's topological scheduler will too. Absence
	 * is treated as "this is a leaf / hand-rolled escape hatch" — the
	 * graph builder simply gets an empty upstream set, and the
	 * compose-time invariant warns but does not throw.
	 */
	readonly __upstreamKeys?: ReadonlyArray<string>;
	/** Unique-symbol brand identifying this object as a devstack stack
	 *  member. Stamped by `provide` / `tag`; checked at runtime by
	 *  variadic entry points (`devstack(...)`) to discriminate a LayeredTag
	 *  from a plain options object. */
	readonly [DevstackTagBrand]: true;
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
 * Per-primitive scope (Phase 2 of selective-restart): every Layer built
 * by `Layer.effect(TagClass, build)` already gets its own scope via
 * Effect's MemoMap (see `memoMapBuild` in `effect/Layer.ts`). The wrap
 * captures that ambient scope and registers it with the engine so the
 * supervisor can close just one primitive's resources on a watch-fire
 * (Phase 3's `engine.invalidateSubset`). Resources allocated by the
 * build body (containers via `Docker.run`, files via `Effect.acquireRelease`,
 * …) attach to this scope automatically — there is no per-primitive
 * lifecycle escape hatch anymore; every primitive's resources stay
 * alive up to the supervisor's outer scope, and selective invalidation
 * is the only way to release them before that outer scope closes.
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
		readonly plugin?: string;
	},
): Effect.Effect<A, E, R> =>
	Effect.gen(function* () {
		// The ambient `Scope` here is the per-primitive layer scope that
		// `memoMapBuild` forked off the supervisor scope. Capturing it
		// lets the engine close just this one primitive's resources when
		// Phase 3's `engine.invalidateSubset` fires for `name` — its
		// finalizers (container `docker stop`, files, etc.) release
		// without touching siblings. Registration is a noop outside a
		// devstack (engine absent — standalone tests).
		const primitiveScope = yield* Effect.scope;
		const engineOpt = yield* Effect.serviceOption(EngineHandle);
		// Stamp the three universal context annotations
		// (`service.name`, `devstack.stack`, `devstack.app`) onto the
		// ambient span so every primitive's `Effect.withSpan(...)` block
		// below is correlated within one supervisor cycle. The helper
		// requires `Identity`, which the supervisor's layer graph always
		// provides — so we gate on its presence (via `serviceOption`) and
		// pipe the resolved identity in to keep standalone-test builds
		// (which don't provide Identity) a noop without inflating the R
		// channel of the surrounding effect.
		const identityOpt = yield* Effect.serviceOption(Identity);
		const serviceLabel = classification.plugin ?? name;
		if (identityOpt._tag === 'Some') {
			yield* annotateDevstackContext(serviceLabel).pipe(
				Effect.provideService(Identity, identityOpt.value),
			);
		}
		if (engineOpt._tag === 'None') {
			// Still pin CurrentTagKey so `setPhase` calls inside the body
			// land on the no-engine branch without crashing on a missing
			// reference. The reference's defaultValue covers the
			// no-provider case too — this is belt-and-braces for clarity.
			return yield* build.pipe(Effect.provideService(CurrentTagKey, name));
		}
		// Hidden tags: the engine never sees this tag, so it can't render a
		// row for it. The build still runs and the value still resolves —
		// failures propagate through the consumer's normal failure path.
		// CurrentTagKey is intentionally left at the empty default so any
		// `setPhase` inside the body is a noop (we have no row to update).
		if (classification.hidden === true) {
			return yield* build.pipe(Effect.provideService(CurrentTagKey, ''));
		}
		const engine = engineOpt.value;
		yield* engine.registerPrimitiveScope(name, primitiveScope);
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
		return yield* build.pipe(
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
// `TagClass` and `LayeredTag` shapes satisfy this.
type AnyTagClass = Context.Key<any, any> & { readonly key: string };

/**
 * Resolve `ProvideOptions.upstreamKeys` to a flat list of string keys.
 * Accepts:
 *   - A `LayeredTag` (any-typed; we read its `.key`).
 *   - A bare string (treated as a tag key directly).
 *   - `undefined` entries (dropped; lets composite callers express
 *     conditional inclusion without a separate `push` loop).
 *
 * Returns an empty array when `upstreamKeys` is unset. Duplicates are
 * dropped — order-preserving — so two composites pulling in the same
 * inner tag don't produce a duplicate edge in `buildDepGraph`.
 */
export const resolveUpstreamKeys = (
	upstreamKeys: ReadonlyArray<LayeredTag<any, any, any, any> | string | undefined> | undefined,
): ReadonlyArray<string> => {
	if (upstreamKeys === undefined) return [];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const entry of upstreamKeys) {
		if (entry === undefined) continue;
		const key = typeof entry === 'string' ? entry : entry.key;
		if (typeof key !== 'string' || key.length === 0) continue;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(key);
	}
	return out;
};

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
 * Context.Service class itself doubles as a yieldable `LayeredTag` — gaining
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
	readonly __pluginName?: string;
	readonly __hidden?: boolean;
	readonly __upstreamKeys?: ReadonlyArray<string>;
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
		__pluginName?: string;
		__hidden?: boolean;
		__upstreamKeys?: ReadonlyArray<string>;
		[DevstackTagBrand]: true;
	} = { __layer: layer, key: TagClass.key, [DevstackTagBrand]: true as const };
	if (options.kind !== undefined) extras.__kind = options.kind;
	if (options.displayTitle !== undefined) extras.__displayTitle = options.displayTitle;
	if (options.watch !== undefined && options.watch.length > 0) {
		extras.__watchPaths = options.watch;
	}
	if (options.plugin !== undefined) extras.__pluginName = options.plugin;
	if (options.hidden === true) extras.__hidden = true;
	if (options.upstreamKeys !== undefined) {
		// Always stamp — even an empty array — so the compose-time
		// invariant in `composeStackLayer` can distinguish "primitive
		// has no upstreams" from "primitive forgot to declare". Composites
		// pass `upstreamKeys: []` when the primitive is genuinely a leaf
		// (e.g. `Sui()` has no in-stack upstream deps).
		extras.__upstreamKeys = resolveUpstreamKeys(options.upstreamKeys);
	}
	// Mutate the canonical class so it doubles as a yieldable StackMember.
	return Object.assign(TagClass, extras) as unknown as T & typeof extras;
};

// Optional knobs for `tag`. `extraLayers` lets composite primitives
// surface their inner tags' layers without the caller having to know
// about the `__layers` field. Prefer `composeLayers` for primitives
// that compose multiple inner tags into a single LayeredTag — it returns the
// `__layers` array directly without an intermediary outer-tag class.
// `kind` + `display` flow through to the engine for TUI sectioning.
export interface TagOptions<A> extends ProvideOptions<A> {
	readonly extraLayers?: ReadonlyArray<Layer.Layer<any, any, any>>;
}

/**
 * Create a one-off tag from an Effect — the right primitive when you're
 * NOT implementing a shared interface (per-account tags from `Account()`,
 * custom plugins, `Action`, etc.). For factories that target an
 * interface tag class in `src/services/` (e.g. `SuiTag`, `SealKeyServerTag`),
 * use {@link provide} instead. For composites that aggregate multiple
 * inner tags into one LayeredTag, use {@link composeLayers}.
 */
export const tag = <const Name extends string, A, E = never, R = never>(
	name: Name,
	build: Effect.Effect<A, E, R>,
	options: TagOptions<A> = {},
): LayeredTag<Name, A, Exclude<R, Scope.Scope>, E> => {
	class T extends Context.Service<TagIdentity<Name>, A>()(name as Name) {}
	const provideOpts: ProvideOptions<A> = {
		...(options.kind !== undefined ? { kind: options.kind } : {}),
		...(options.display !== undefined ? { display: options.display } : {}),
		...(options.displayTitle !== undefined ? { displayTitle: options.displayTitle } : {}),
		...(options.watch !== undefined ? { watch: options.watch } : {}),
		...(options.plugin !== undefined ? { plugin: options.plugin } : {}),
		...(options.hidden === true ? { hidden: true } : {}),
		...(options.upstreamKeys !== undefined ? { upstreamKeys: options.upstreamKeys } : {}),
	};
	const { __layer, key, __upstreamKeys } = provide(T, build, provideOpts);
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
	// TS can't bridge to `LayeredTag<Name, …>` even though both share the
	// same `TagIdentity<Name>`. Funnel through `unknown` to land on the
	// public type — the runtime shape is identical.
	const extras: {
		__layer: typeof __layer;
		__layers: typeof __layers;
		key: string;
		__kind?: TagKind;
		__displayTitle?: string;
		__watchPaths?: ReadonlyArray<string>;
		__pluginName?: string;
		__hidden?: boolean;
		__upstreamKeys?: ReadonlyArray<string>;
		[DevstackTagBrand]: true;
	} = {
		__layer,
		__layers,
		key,
		[DevstackTagBrand]: true as const,
	};
	if (options.kind !== undefined) extras.__kind = options.kind;
	if (options.displayTitle !== undefined) extras.__displayTitle = options.displayTitle;
	if (options.watch !== undefined && options.watch.length > 0) {
		extras.__watchPaths = options.watch;
	}
	if (options.plugin !== undefined) extras.__pluginName = options.plugin;
	if (options.hidden === true) extras.__hidden = true;
	if (__upstreamKeys !== undefined) extras.__upstreamKeys = __upstreamKeys;
	return Object.assign(T, extras) as unknown as LayeredTag<Name, A, Exclude<R, Scope.Scope>, E>;
};

// Anything that exposes a layer or a transitive layer list — the shape
// `composeLayers` accepts for the `inner` slot. Tags produced by
// `provide` / `tag` satisfy this, as do LayeredTags returned by composite
// primitives.
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
	/** The primary layer for this LayeredTag. Goes after `inner` (so its body
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
 * multi-layer LayeredTag. Replaces the comment-heavy hand-rolled
 * `[...inner.__layers, primary, ...projections]` pattern in
 * walrus / seal / deepbook with a single call.
 *
 * Ordering rationale: `composeStackLayer` folds left-to-right with
 * `provideMerge(layer, acc)`, so each new layer consumes services from
 * the accumulated acc. Providers must come BEFORE consumers — inner
 * sibling tags' layers feed `primary`'s body, and `primary`'s output
 * feeds the projection layers' bodies, so the canonical order is
 * `inner → primary → projections`.
 *
 * Single-tag vs composite-tag rule
 * ---
 * Reach for `composeLayers` (composite-tag shape — `primary` + zero or
 * more `projections`) when admin and read capabilities must be
 * type-separable in user code: Walrus splits into
 * `WalrusNetworkTag` (read-only) and the writable layer; Seal splits
 * into `SealKeyServerTag` + `SealKeyManagerTag`; Deepbook follows the
 * same pattern. The projection layers consume `primary`'s resolved
 * value and republish it into a narrower interface tag, so a consumer
 * yielding the read-only tag can't accidentally call admin methods.
 *
 * Use the single-tag shape (`tag(...)` / `provide(...)` with no
 * `composeLayers` call) when the resolved value is one cohesive bundle
 * with no admin / read split — `Sui()`, `Faucet()`, `Account()`,
 * `Package()`. The composite shape adds the projection-layer overhead
 * for no API win when there's nothing to separate.
 *
 * Discriminator naming: tagged-union options on factories use `kind:`
 * as the discriminator field (`AccountSpec` is the precedent —
 * `{kind: 'env', key: ...}`, `{kind: 'keystore', alias: ...}`). New
 * tagged-union options in `/advanced` follow the same rule; don't
 * introduce a new discriminator name (`from`, `type`, `mode`, `tag`).
 *
 * Per-job factories with a single semantic that dispatch on input
 * shape — `Coin('SYMBOL')`, `Coin.fromPackage(pkg, witness)`,
 * `Coin('0x...::T')`, `Coin.builtin('sui')` — do NOT use a
 * discriminator field. The input shape selects the branch and TS
 * narrows automatically. Use that precedent when "this thing has one
 * job; overload on input shape" applies.
 */
export const composeLayers = (
	opts: ComposeLayersOptions,
): ReadonlyArray<Layer.Layer<any, any, any>> => [
	...flattenInnerLayers(opts.inner ?? []),
	opts.primary,
	...(opts.projections ?? []),
];
