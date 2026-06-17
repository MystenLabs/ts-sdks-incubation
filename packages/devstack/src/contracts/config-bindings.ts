// Unified config-binding contract.
//
// THE PROBLEM THIS SOLVES. A config-emitting plugin used to maintain TWO
// near-duplicate projectors:
//   - a LIVE one (boot): bakes concrete resolved values (real ids, rpc
//     URLs) into the loadable id-config (`assembleIdConfig`), and
//   - a STATIC one (the stack-free `codegen` verb): emits
//     `rawExpr(resolve…())` into the committed `config.ts` so the tree
//     carries NO on-chain id.
// Two hand-written projectors per plugin is error-prone: forget the static
// path and the committed tree is incomplete (broken clean-clone build);
// the fixed typed id-config channel also can't carry arbitrary plugin live
// values (deepbook pool ids, coin types, walrus/seal endpoints).
//
// THE UNIFICATION. A plugin declares its `config.ts` contributions ONCE as
// a `ConfigBindingSet`. BOTH paths are DERIVED from it:
//   - `configCodegenable(set, 'static')` → the committed-tree decl whose
//     aggregate emits `rawExpr(resolveValue(...))` / typed-sugar resolvers
//     (and pure literals as literals).
//   - `configCodegenable(set, { mode: 'live', state })` → the boot decl
//     whose aggregate bakes concrete values, AND whose values feed the
//     loadable id-config (typed channel + the generic `values` channel).
//
// One declaration, two derivations — no parallel projectors to drift.

import { Effect } from 'effect';

import type { CodegenableDecl } from './codegenable.ts';
import { rawExpr } from './codegenable.ts';
import type { JsonValue } from '../orchestrators/codegen/id-config.ts';

// -----------------------------------------------------------------------------
// Binding shape
// -----------------------------------------------------------------------------

/** A typed-sugar resolver a binding may target instead of the generic
 *  `resolveValue(namespace, key)` channel. Each maps to a `config-runtime.ts`
 *  function: `id` → `resolveId(<arg>)`, `network` → `resolveNetwork()`,
 *  `networks` → `resolveNetworks()`. Sugar bindings also feed the TYPED
 *  id-config fields (`mvrOverrides`/`network`/`networks`), not the generic
 *  `values` channel — that keeps `config.network`/`config.mvrOverrides`
 *  readable by apps exactly as before. */
export type ConfigSugarResolver =
	| { readonly kind: 'id'; readonly mvrPlaceholder: string }
	| { readonly kind: 'network' }
	| { readonly kind: 'networks' };

/**
 * One config-binding. A plugin returns a list of these ONCE; the framework
 * derives both the live and static behaviors from them.
 *
 * Variants:
 *   - `literal`: the SAME value in both paths (e.g. the package `mvr`
 *     placeholder string, a network NAME you decide is static). Emitted
 *     verbatim in `config.ts`; mirrored into the live id-config too.
 *   - `resolved`: runtime-resolved. STATIC emits a resolver `rawExpr`;
 *     LIVE computes the concrete value via `live(state)` and routes it into
 *     the id-config — through the typed channel for a `sugar` resolver, or
 *     through the generic `values[namespace][key]` channel otherwise.
 */
export type ConfigBinding<State = unknown> =
	| {
			readonly variant: 'literal';
			/** Path into the `config.ts` object literal, e.g. `['network']`
			 *  or `['packages', 'connect_four', 'mvr']`. */
			readonly configPath: ReadonlyArray<string>;
			/** The literal value (identical in both paths). */
			readonly value: JsonValue;
	  }
	| {
			readonly variant: 'resolved';
			/** Path into the `config.ts` object literal. */
			readonly configPath: ReadonlyArray<string>;
			/** Generic-channel coordinates. Always present so the live path
			 *  can populate `idConfig.values[namespace][key]` even for a
			 *  sugar-resolved binding (the sugar ALSO feeds the typed field;
			 *  `values` is harmless redundancy and keeps the guard simple). */
			readonly namespace: string;
			readonly key: string;
			/** When set, the static path emits the typed-sugar resolver
			 *  (`resolveId`/`resolveNetwork`/`resolveNetworks`) and the live
			 *  path additionally feeds the TYPED id-config field. When
			 *  omitted, the static path emits `resolveValue(namespace, key)`
			 *  and the live value lands ONLY in the generic `values` channel. */
			readonly sugar?: ConfigSugarResolver;
			/** The field's STATIC TypeScript type, as a source string (e.g.
			 *  `'string'`, `'string | null'`, or a structural literal type for a
			 *  composite). When set, the static path emits
			 *  `resolveValue(ns, key) as <tsType>` so the committed value carries
			 *  its concrete type instead of the `unknown` the generic channel
			 *  returns. Ignored for sugar bindings (those use the typed resolver
			 *  whose return type is already concrete). When omitted, the static
			 *  path emits a bare `resolveValue(ns, key)` (type `unknown`). */
			readonly tsType?: string;
			/** Compute the concrete value at boot from acquired plugin state.
			 *  Only invoked on the LIVE path. */
			readonly live: (state: State) => JsonValue;
	  };

/**
 * A plugin's full `config.ts` contribution, declared ONCE.
 *
 * `bucket` is always `'config.ts'` for the typed app config; carried as a
 * field so the orchestrator stays name-blind (it reads the bucket off the
 * decl rather than hard-coding it).
 */
export interface ConfigBindingSet<State = unknown> {
	/** Aggregate bucket the bindings fold into (always `'config.ts'` today;
	 *  a field so the orchestrator never hard-codes it). */
	readonly bucket: string;
	/** Diagnostic tag for span attributes (e.g. `'sui-network'`,
	 *  `'package'`). The orchestrator MUST NOT branch on it. */
	readonly kind: string;
	/** The emitter name the derived `CodegenableDecl` carries. */
	readonly emitterName: string;
	/** A non-empty placeholder output path (the decl is `aggregateOnly`,
	 *  so the file is never written — but path-resolution must not see ''). */
	readonly outputPath: string;
	/** When `true`, the derived decl sets `allowEmitterNameRepetition`
	 *  (one decl per item, e.g. one `package` per published package). */
	readonly allowEmitterNameRepetition?: boolean;
	/** The bindings. */
	readonly bindings: ReadonlyArray<ConfigBinding<State>>;
}

// -----------------------------------------------------------------------------
// Derivation
// -----------------------------------------------------------------------------

/** Set `value` at `path` inside `root`, creating intermediate objects. */
const setAtPath = (
	root: Record<string, unknown>,
	path: ReadonlyArray<string>,
	value: unknown,
): void => {
	let cursor = root;
	for (let i = 0; i < path.length - 1; i++) {
		const segment = path[i]!;
		const next = cursor[segment];
		if (typeof next === 'object' && next !== null && !Array.isArray(next)) {
			cursor = next as Record<string, unknown>;
		} else {
			const created: Record<string, unknown> = {};
			cursor[segment] = created;
			cursor = created;
		}
	}
	cursor[path[path.length - 1]!] = value;
};

/** The `rawExpr` the STATIC path emits for a resolved binding. */
const staticExprFor = <State>(
	binding: Extract<ConfigBinding<State>, { variant: 'resolved' }>,
): ReturnType<typeof rawExpr> => {
	const sugar = binding.sugar;
	if (sugar === undefined) {
		const call = `resolveValue(${JSON.stringify(binding.namespace)}, ${JSON.stringify(binding.key)})`;
		// A `tsType` carries the field's concrete static type so the committed
		// value typechecks against the app's usage (the generic channel returns
		// `unknown`). Emit the call as a typed cast; bare otherwise.
		return rawExpr(binding.tsType === undefined ? call : `${call} as ${binding.tsType}`);
	}
	switch (sugar.kind) {
		case 'id':
			return rawExpr(`resolveId(${JSON.stringify(sugar.mvrPlaceholder)})`);
		case 'network':
			return rawExpr('resolveNetwork()');
		case 'networks':
			return rawExpr('resolveNetworks()');
	}
};

/** Build the STATIC (committed-tree) aggregate projection from a binding
 *  set — `rawExpr(resolve…())` for resolved bindings, literals for the
 *  rest. Pure: needs no acquired state. */
export const projectStaticConfig = <State>(
	set: ConfigBindingSet<State>,
): Record<string, unknown> => {
	const root: Record<string, unknown> = {};
	for (const binding of set.bindings) {
		const value = binding.variant === 'literal' ? binding.value : staticExprFor(binding);
		setAtPath(root, binding.configPath, value);
	}
	return root;
};

/** Build the LIVE (boot) aggregate projection from a binding set against
 *  the acquired plugin state — concrete resolved values everywhere. */
export const projectLiveConfig = <State>(
	set: ConfigBindingSet<State>,
	state: State,
): Record<string, unknown> => {
	const root: Record<string, unknown> = {};
	for (const binding of set.bindings) {
		const value = binding.variant === 'literal' ? binding.value : binding.live(state);
		setAtPath(root, binding.configPath, value);
	}
	return root;
};

/**
 * Derive the live `idConfig.values[namespace][key]` contributions of a
 * binding set. Only `resolved` bindings WITHOUT a `sugar` resolver land in
 * the generic channel (sugar bindings feed the typed id-config fields,
 * sliced from the live `config.ts` bucket by `idConfigFromBucket`). The
 * generic channel is the part the fixed typed schema can't carry.
 */
export const liveValuesOf = <State>(
	set: ConfigBindingSet<State>,
	state: State,
): Record<string, Record<string, JsonValue>> => {
	const out: Record<string, Record<string, JsonValue>> = {};
	for (const binding of set.bindings) {
		if (binding.variant !== 'resolved' || binding.sugar !== undefined) continue;
		const ns = (out[binding.namespace] ??= {});
		ns[binding.key] = binding.live(state);
	}
	return out;
};

/**
 * Derive a `CodegenableDecl` from a binding set.
 *
 * `'static'` → the committed-tree decl (stack-free `codegen` verb). Its
 * aggregate emits `rawExpr(resolve…())` for resolved bindings.
 *
 * `{ mode: 'live', state }` → the boot decl. Its aggregate bakes concrete
 * values from `state`; boot's `assembleIdConfig` reads those back into the
 * loadable id-config (typed channel + the generic `values` channel).
 */
export const configCodegenable = <State>(
	set: ConfigBindingSet<State>,
	how: 'static' | { readonly mode: 'live'; readonly state: State },
): CodegenableDecl => {
	const live = how !== 'static';
	const projected = live ? projectLiveConfig(set, how.state) : projectStaticConfig(set);
	const idConfigValues = live ? liveValuesOf(set, how.state) : {};
	return {
		kind: 'codegenable',
		emitterName: set.emitterName,
		outputPath: set.outputPath,
		aggregateOnly: true,
		...(set.allowEmitterNameRepetition === true ? { allowEmitterNameRepetition: true } : {}),
		aggregate: {
			kind: set.kind,
			bucket: set.bucket,
			// The projection is precomputed above (pure over `set`/`state`);
			// the orchestrator calls `project(exported)` with the emitted map
			// but the value is already fixed, so we ignore the argument.
			project: () => projected,
			// Only the live aggregate feeds the generic id-config channel.
			...(live && Object.keys(idConfigValues).length > 0 ? { idConfigValues } : {}),
		},
		emit: (ctx) =>
			Effect.sync(() => {
				// A placeholder export so the emitter runs; the projection is
				// what the aggregate folds. Kept minimal + name-stable.
				ctx.exportConst('__configBindings', set.kind);
				return ctx.done();
			}),
	};
};
