// Internal plugin helper — sibling-keyed bucket config bindings.
//
// THE PROBLEM. The own-bucket service plugins (coin → `coins.ts`,
// deepbook → `deepbook.ts`, walrus → `walrus.ts`, seal → `seal.ts`) used
// to emit ONLY a LIVE codegen decl that BAKED concrete on-chain ids / coin
// types / endpoint URLs into the committed tree. They had no stack-free
// `staticCodegen` hook, so the committed `src/generated/<bucket>.ts` either
// did not exist on a fresh clone or carried baked runtime values — exactly
// the live-only-field failure the unified config-binding API exists to
// prevent (see `contracts/config-bindings.ts`).
//
// THE UNIFICATION. These plugins declare their bucket contribution ONCE as
// a `ConfigBindingSet` whose `configPath`s are rooted under the instance
// KEY (the coin symbol, the deepbook/seal instance name). Both behaviors
// derive from it:
//   - LIVE (boot, `devstack up`): `configCodegenable(set, {mode:'live'})`
//     feeds the concrete values into `idConfig.values[namespace][key]` (the
//     generic resolver channel `assembleIdConfig` folds bucket-blind),
//     written to the gitignored `devstack-ids.json`. It writes NO per-stack
//     generated source — the committed `src/generated` tree is the only
//     bindings source, and the live ids reach it at build/dev time via the
//     injected `__DEVSTACK_IDS__` global.
//   - STATIC (committed tree, the `codegen` verb):
//     `configCodegenable(set, 'static')` emits `resolveValue(namespace,key)`
//     raw expressions, so the committed `<bucket>.ts` carries NO baked id /
//     coin type / URL — the app resolves them at build/dev time via the
//     injected `__DEVSTACK_IDS__` global.
//
// One declaration, two derivations — no parallel projectors to drift.

import type { CodegenableDecl } from '../../contracts/codegenable.ts';
import {
	configCodegenable,
	type ConfigBinding,
	type ConfigBindingSet,
} from '../../contracts/config-bindings.ts';
import type { JsonValue } from '../../orchestrators/codegen/id-config.ts';

/** One field of an instance's bucket entry, classified as either a pure
 *  STRUCTURAL literal (a name / mode / decimals — the same in both paths)
 *  or a runtime-RESOLVED value (an on-chain id, coin type, or endpoint URL —
 *  the static path emits `resolveValue`, the live path feeds the concrete
 *  value into the id-config). The `key` is the leaf field name written under
 *  the instance key in the bucket object literal. */
export type BucketField<State> =
	| { readonly key: string; readonly variant: 'literal'; readonly value: JsonValue }
	| {
			readonly key: string;
			readonly variant: 'resolved';
			/** `resolveValue(namespace, valueKey)` coordinates. `valueKey`
			 *  defaults to `key` when omitted. */
			readonly valueKey?: string;
			/** The field's STATIC TypeScript type as a source string (see
			 *  `ConfigBinding.tsType`). When set, the static path emits
			 *  `resolveValue(...) as <tsType>` so the committed value carries its
			 *  concrete type instead of `unknown`. */
			readonly tsType?: string;
			readonly live: (state: State) => JsonValue;
	  };

export interface SiblingBucketSpec<State> {
	/** The aggregate bucket filename, e.g. `'coins.ts'`. */
	readonly bucket: string;
	/** Diagnostic kind tag (e.g. `'coin'`) — the orchestrator never
	 *  branches on it. */
	readonly kind: string;
	/** The emitter name the derived decl carries (literal, e.g.
	 *  `coin/<symbol>`). */
	readonly emitterName: string;
	/** A non-empty dead output path (the decl is `aggregateOnly`). */
	readonly outputPath: string;
	/** The instance key the entry lives under in the bucket object
	 *  (e.g. the coin symbol, the deepbook instance name). */
	readonly instanceKey: string;
	/** The `resolveValue` namespace shared by every resolved field
	 *  (e.g. `coin:<symbol>`, `deepbook:<name>`). */
	readonly namespace: string;
	/** The instance's fields. */
	readonly fields: ReadonlyArray<BucketField<State>>;
	/** When `true`, the derived decl sets `allowEmitterNameRepetition`
	 *  (sibling instances share an emitter-name prefix). */
	readonly allowEmitterNameRepetition?: boolean;
}

/** Build the `ConfigBindingSet` for a sibling-keyed bucket instance. The
 *  `configPath` of every binding is rooted at the instance key, so distinct
 *  instances deep-merge into one `<bucket>.ts` exporting
 *  `{ <instanceKey>: { ...fields } }`. */
export const siblingBucketBindings = <State>(
	spec: SiblingBucketSpec<State>,
): ConfigBindingSet<State> => {
	const bindings: Array<ConfigBinding<State>> = spec.fields.map((field) => {
		const configPath = [spec.instanceKey, field.key] as const;
		if (field.variant === 'literal') {
			return { variant: 'literal', configPath: [...configPath], value: field.value };
		}
		return {
			variant: 'resolved',
			configPath: [...configPath],
			namespace: spec.namespace,
			key: field.valueKey ?? field.key,
			// No `sugar` — these are generic `resolveValue` bindings (the typed
			// id-config channel only carries network/packages/mvrOverrides).
			...(field.tsType !== undefined ? { tsType: field.tsType } : {}),
			live: field.live,
		};
	});
	return {
		bucket: spec.bucket,
		kind: spec.kind,
		emitterName: spec.emitterName,
		outputPath: spec.outputPath,
		...(spec.allowEmitterNameRepetition === true ? { allowEmitterNameRepetition: true } : {}),
		bindings,
	};
};

/** Derive the LIVE bucket decl — feeds concrete values into the generic
 *  id-config `values` channel (no per-stack generated file is written). */
export const liveBucketCodegen = <State>(
	spec: SiblingBucketSpec<State>,
	state: State,
): CodegenableDecl =>
	configCodegenable(siblingBucketBindings(spec), { mode: 'live', state });

/** Derive the STATIC (stack-free) bucket decl — emits
 *  `resolveValue(namespace, key)` for resolved fields, literals for the
 *  rest. The committed `<bucket>.ts` carries no baked runtime value. */
export const staticBucketCodegen = <State>(
	spec: SiblingBucketSpec<State>,
): CodegenableDecl => configCodegenable(siblingBucketBindings(spec), 'static');
