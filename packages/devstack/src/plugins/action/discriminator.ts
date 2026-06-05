// Action plugin — discriminator types.
//
// An action's cache key is `action/<chainId>/<contentHash>` where the
// content hash folds in:
//
//   - `actionName`   — symbolic action name (drives namespace + TUI
//                      attribution).
//   - `chainId`      — substrate-folded automatically (substrate-side
//                      of the artifact publisher cache key).
//   - `consumedKeys` — the literal resource ids of every entry in
//                      `dependsOn`. Folded so reordering/changing
//                      upstream deps invalidates the cache. Static —
//                      resolved at factory construction time.
//   - `discriminator` — OPTIONAL caller-supplied extra material. Two
//                      accepted shapes: a literal `string`, or a
//                      callback `(ctx, deps) => Effect<string>`
//                      receiving action helpers and resolved deps
//                      shaped by `dependsOn`. The callback form re-runs
//                      on EVERY acquire (hit OR miss) — a
//                      `cacheKey: Effect<string>` (16-action.md
//                      invariant 5/6).
//
// The dynamic discriminator covers the common case where the action's
// idempotency hinges on a value not known until upstream resolution
// completes, e.g. `cacheKey: Effect.gen(function* () {
// const pkg = yield* connectFour; return pkg.packageId; })`.

import type { Effect } from 'effect';

import type { ActionError } from './errors.ts';
import type { ActionBuildContext } from './build-context.ts';

/** Static portion of the discriminator (known at factory construction
 *  time). The substrate folds this into the content-hash so the
 *  cache key changes when these fields do. */
export interface StaticDiscriminator {
	/** Symbolic action name. */
	readonly actionName: string;
	/** Resource-id literals of every entry in `dependsOn`, in declaration
	 *  order. Reordering MUST invalidate the cache (`needs.map(n => n.key)`
	 *  is folded in order). */
	readonly dependencyResourceIds: ReadonlyArray<string>;
}

/** Dynamic portion (resolved at acquire time). Two accepted shapes:
 *
 *  - `string`    — literal cache-key fragment, used verbatim.
 *  - `(ctx, deps) => Effect<string, ActionError>` — callback receiving
 *                  action helpers and resolved deps in the same shape
 *                  as the body callback. The Effect is yielded at
 *                  acquire time so the callback can derive the
 *                  discriminator from upstream resolved values (e.g.
 *                  fold in a freshly-published package id). Re-runs
 *                  on EVERY acquire (hit OR miss). User errors
 *                  propagate as `ActionError({phase: 'discriminator'})`. */
export type DynamicDiscriminator<Deps = unknown> =
	| string
	| ((ctx: ActionBuildContext, deps: Deps) => Effect.Effect<string, ActionError>);

/** Build the content-hash input string from static + resolved-dynamic
 *  pieces. Canonical shape: newline-delimited so two strings with
 *  shared prefixes hash differently. */
export const composeDiscriminatorMaterial = (
	staticParts: StaticDiscriminator,
	resolvedDynamic: string | undefined,
): string => {
	const lines: string[] = [
		`action=${staticParts.actionName}`,
		`dependencies=${JSON.stringify(staticParts.dependencyResourceIds)}`,
	];
	if (resolvedDynamic !== undefined) {
		lines.push(`discriminator=${resolvedDynamic}`);
	}
	return lines.join('\n');
};
