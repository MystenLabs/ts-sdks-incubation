// `onChainArtifact(spec)` — substrate for the unified
// publish-cache-verify-register shape on-chain primitives use.
//
// Subsumes (in one helper):
//
//   1. `withCache(spec)` discipline.
//   2. A `register` step that runs on EVERY cycle, hit AND miss, after
//      the value is resolved.
//   3. The `tag(name, build, options)` wiring — name, kind, plugin,
//      displayTitle, hidden, watch.
//
// The `upstream` record is a typed `Record<Alias, LayeredTag<...>>` so
// that:
//
//   - The `inputs` / `verify` / `produce` / `register` callbacks
//     receive the resolved upstream values as a typed `deps` argument.
//     A primitive's body literally cannot consume a service that isn't
//     in `upstream` — the missing-upstream bug class becomes a
//     compile-time error.
//   - The dep declaration IS the dep graph. The resulting LayeredTag's
//     `__upstreamKeys` is auto-flattened from the record's values.
//   - No `yield* X` inside the spec body. The build's R channel is
//     `never` (everything is explicit), so the helper-internal
//     `withCache` / `ChainProbe` machinery are the only services that
//     need to be in scope at acquire time.

import { Effect } from 'effect';
import { withCache } from './cache.js';
import { SuiTag } from '../services/sui.js';
import { ChainProbe } from './chain-probe.js';
import { tag, type LayeredTag, type TagKind, type TuiDisplay } from '../advanced/tag.js';

// -----------------------------------------------------------------------------
// Resolved-upstream type machinery
// -----------------------------------------------------------------------------

/**
 * Map a record of upstream LayeredTags to a record of their resolved
 * value types. `{ signer: AccountTag }` (where AccountTag's shape is
 * `Account`) becomes `{ signer: Account }`. Conditionally-undefined
 * entries (`tag | undefined`) surface as `value | undefined` so
 * callers can express optional upstreams.
 */
export type Resolved<U extends Record<string, LayeredTag<any, any, any, any> | undefined>> = {
	readonly [K in keyof U]: U[K] extends LayeredTag<any, infer A, any, any>
		? A
		: U[K] extends LayeredTag<any, infer A, any, any> | undefined
			? A | undefined
			: never;
};

/** Union of E channels from the upstream record's tags — surfaces in
 *  the resulting LayeredTag's error channel. */
export type UpstreamE<U extends Record<string, LayeredTag<any, any, any, any> | undefined>> = {
	[K in keyof U]: U[K] extends LayeredTag<any, any, any, infer E> ? E : never;
}[keyof U];

// -----------------------------------------------------------------------------
// Spec contract
// -----------------------------------------------------------------------------

/**
 * Spec passed to `onChainArtifact`. The `upstream` record is the
 * single source of truth for this primitive's dependencies:
 *
 *   - The `inputs` / `verify` / `produce` / `register` callbacks
 *     receive the resolved upstream values as a typed `deps` argument.
 *   - The substrate auto-flattens `upstream` into the resulting tag's
 *     `__upstreamKeys` (consumed by `buildDepGraph` and the future
 *     topological scheduler).
 *
 * `inputs`, `verify`, `produce`, and `register` are NOT Effects. They
 * are functions returning Effects. This way they take the resolved
 * `deps` explicitly and don't need to be `Effect.gen` bodies that
 * yield context services — that's the load-bearing design property
 * that makes B11-class bugs unrepresentable.
 */
export interface OnChainArtifactSpec<
	Name extends string,
	U extends Record<string, LayeredTag<any, any, any, any> | undefined>,
	T,
	EVerify = never,
	EProduce = never,
	ERegister = never,
> {
	// ── Tag identity ──
	/** Tag identity key — same as `tag(name, ...)`'s `name` param. */
	readonly name: Name;
	/** TUI section — defaults to `'action'` (the common case for
	 *  on-chain publish steps). */
	readonly kind?: TagKind;
	/** Plugin attribution — short string (`'move'`, `'deepbook'`, …). */
	readonly plugin: string;
	/** Friendly title shown while the primitive is still acquiring. */
	readonly displayTitle?: string;
	/** Project the resolved value into the dashboard row. */
	readonly display?: (value: T) => TuiDisplay;
	/** Hide from the TUI dashboard. */
	readonly hidden?: boolean;
	/** `.gitignore`-style watch patterns. */
	readonly watch?: ReadonlyArray<string>;

	// ── Upstream record (the single source of truth) ──
	/**
	 * Record of resolved upstream LayeredTags. Each value is yielded
	 * once at acquire time; the resolved bundle is passed as `deps` to
	 * every callback below. Conditional upstreams (`undefined` for
	 * branches that don't use them) are supported — the resolved value
	 * surfaces as `undefined` and the substrate skips the yield.
	 *
	 * `SuiTag` and `ChainProbe` are NOT listed here — they're always in
	 * scope (the substrate yields them itself). Same goes for
	 * `StateStore` (the cache implementation uses it).
	 */
	readonly upstream: U;

	// ── Cache discipline ──
	/** Static identifier of the producing primitive — folds into the
	 *  cache key alongside `chainId`. Convention:
	 *  `'<service>/<artifact>'`, e.g. `'publishMove'`. */
	readonly namespace: string;
	/** Human label for cache log messages. Defaults to `namespace`. */
	readonly label?: string;

	/**
	 * Canonical hashable inputs whose hash forms the cache key. The
	 * shape MUST be deterministic — callers canonicalize (sorted nested
	 * keys, normalized bigints to strings) BEFORE returning. The
	 * resolved upstream record is passed in so the inputs can include
	 * e.g. `pkg.packageId` from a sibling `publishMove`.
	 */
	readonly inputs: (deps: Resolved<U>) => Effect.Effect<Record<string, unknown>>;

	/**
	 * Probe the chain to verify the cached value. Receives the cached
	 * value plus the typed `ChainProbe` accessor and the resolved
	 * upstream bundle. Return the cached value on success, `undefined`
	 * to invalidate. Errors flow through `withCache`'s
	 * `Effect.orElseSucceed(() => undefined)` convention — transient
	 * RPC failures over-derive on the next cycle.
	 */
	readonly verify: (args: {
		readonly cached: T;
		readonly chain: typeof ChainProbe.Service;
		readonly deps: Resolved<U>;
	}) => Effect.Effect<T | undefined, EVerify>;

	/** Produce a fresh value on cache miss / verify-fail. */
	readonly produce: (deps: Resolved<U>) => Effect.Effect<T, EProduce>;

	// ── Register step ──
	/**
	 * Runs on EVERY cycle (hit AND miss) AFTER the value is resolved,
	 * BEFORE it yields to downstream consumers. The publishMove pattern:
	 * registries are in-memory per engine invocation, so a cache hit
	 * MUST still surface the resolved package into PackageRegistry /
	 * CoinRegistry / EndpointRegistry / etc.
	 *
	 * Defaults to a noop when omitted.
	 */
	readonly register?: (args: {
		readonly value: T;
		readonly deps: Resolved<U>;
	}) => Effect.Effect<void, ERegister>;
}

// -----------------------------------------------------------------------------
// onChainArtifact
// -----------------------------------------------------------------------------

/**
 * Compose `withCache` + the `register` step + `tag` into the single
 * shape every on-chain primitive should adopt.
 *
 * The returned `LayeredTag` exposes the resolved value `T` directly —
 * downstream consumers `yield* tagId` and get the post-register value.
 *
 * Cache key shape (inherited from `withCache`):
 *
 *   `${namespace}/${chainId}/${contentHash(canonical(inputs))}`
 *
 * `chainId` is resolved at acquire time from `SuiTag.chainId`.
 */
export const onChainArtifact = <
	const Name extends string,
	U extends Record<string, LayeredTag<any, any, any, any> | undefined>,
	T,
	EVerify = never,
	EProduce = never,
	ERegister = never,
>(
	spec: OnChainArtifactSpec<Name, U, T, EVerify, EProduce, ERegister>,
): LayeredTag<Name, T, never, EVerify | EProduce | ERegister | UpstreamE<U>> => {
	// Resolve the upstream bundle once at acquire time. The order of
	// these yields doesn't affect the dep graph (`__upstreamKeys` is
	// auto-flattened from the record below).
	// Note: `yield* dep` adds the tag's identity to the R channel and its
	// E to the error channel. `tag()`'s `Layer.effect` wrap ties off the
	// identities via the supervisor's layer graph, leaving the final
	// LayeredTag with `R = never`.
	const resolveUpstream = Effect.gen(function* () {
		const out: Record<string, unknown> = {};
		for (const [alias, dep] of Object.entries(spec.upstream)) {
			if (dep === undefined) {
				out[alias] = undefined;
				continue;
			}
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			out[alias] = yield* dep as unknown as Effect.Effect<unknown, any, any>;
		}
		return out as Resolved<U>;
	});

	const build = Effect.gen(function* () {
		const deps = yield* resolveUpstream;
		const sui = yield* SuiTag;
		const chain = yield* ChainProbe;
		const value = yield* withCache({
			namespace: spec.namespace,
			chainId: sui.chainId,
			inputs: spec.inputs(deps),
			...(spec.label !== undefined ? { label: spec.label } : {}),
			verify: (cached: T) => spec.verify({ cached, chain, deps }),
			produce: spec.produce(deps),
		});
		if (spec.register !== undefined) {
			yield* spec.register({ value, deps });
		}
		return value;
	}) as Effect.Effect<T, EVerify | EProduce | ERegister | UpstreamE<U>>;

	// Auto-flatten the upstream record into the existing `upstreamKeys:`
	// field on `tag()`. Conditional `undefined` entries are filtered
	// before forwarding so the array of LayeredTags is well-typed.
	const upstreamTags = Object.values(spec.upstream).filter(
		(d): d is LayeredTag<any, any, any, any> => d !== undefined,
	);

	// Surface each upstream tag's `__layers` so the supervisor's layer
	// graph provides their identities at the same scope as this tag's
	// own build. Without this, `yield* dep` inside the build body would
	// fail with "Service not found" because the upstream tag's Layer
	// wouldn't be in the graph when our `Layer.effect(...)` runs.
	const extraLayers = upstreamTags.flatMap((u) => u.__layers ?? []);

	const tagOptions = {
		plugin: spec.plugin,
		upstreamKeys: upstreamTags,
		extraLayers,
		...(spec.kind !== undefined ? { kind: spec.kind } : { kind: 'action' as TagKind }),
		...(spec.display !== undefined
			? { display: spec.display as (value: unknown) => TuiDisplay }
			: {}),
		...(spec.displayTitle !== undefined ? { displayTitle: spec.displayTitle } : {}),
		...(spec.hidden === true ? { hidden: true } : {}),
		...(spec.watch !== undefined ? { watch: spec.watch } : {}),
	};

	return tag(spec.name, build, tagOptions) as LayeredTag<
		Name,
		T,
		never,
		EVerify | EProduce | ERegister | UpstreamE<U>
	>;
};
