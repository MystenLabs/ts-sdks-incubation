// Tag identity — typed value flow between plugins.
//
// A Tag captures:
//   1. a unique identity (a literal string),
//   2. the resolved value's shape,
//   3. an opaque plugin-key for runtime dispatch.
//
// Phantom variance rule: the resolved-value phantom uses *return-position*
// (covariant) variance. A parameter-position phantom (`(x: T) => T`) is
// contravariant on `T`, which silently breaks the upcast
// `Tag<'sui', narrow>` → `Tag<string, unknown>` that the variadic composer
// relies on.
//
// Tag covariance soundness gap (architecture § NodePlugin "Tag usage
// constraint"): two tag values with the same `id` but different
// declared shapes compare equal at the type level. Acceptable today
// because tags are constructed once at a plugin barrel and not passed
// as runtime values.

import type { PluginKey } from './brand.ts';
import { pluginKey } from './brand.ts';

// Runtime symbol — must exist at runtime because `defineTag` writes a
// computed-property field keyed on it. Per-realm (`Symbol(...)`) is
// sufficient: the brand exists for type-level identity. Using
// `Symbol.for` would needlessly pollute the global symbol registry.
const _tagId = Symbol('devstack:tag-id');

export interface Tag<Id extends string, Resolved> {
	readonly key: PluginKey;
	readonly id: Id;
	readonly [_tagId]: Id;
	/** Covariant (return-only) phantom — see file header. */
	readonly _resolved?: () => Resolved;
}

/** Construct a tag once at the plugin's barrel. Do not pass tag
 *  values as runtime data; see the soundness-gap note above. */
export function defineTag<Id extends string, Resolved>(
	id: Id,
	owningPluginKey: string,
): Tag<Id, Resolved> {
	return {
		key: pluginKey(owningPluginKey),
		id,
		[_tagId]: id,
	} as Tag<Id, Resolved>;
}

/** Extract resolved-value type. */
export type ResolvedOf<T> = T extends Tag<infer _Id, infer R> ? R : never;

/** Extract id literal. */
export type TagIdOf<T> = T extends Tag<infer Id, infer _R> ? Id : never;

/** Erased tag for variadic upcasts. Uses `any` deliberately — the
 *  variance-sound `unknown` form breaks the upcast pattern (see
 *  type-prototype findings §4). Internal-only. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTag = Tag<string, any>;
