// Action plugin — discriminator types.
//
// An action's cache key is `action/<chainId>/<contentHash>` where the
// content hash folds in:
//
//   - `actionName`   — symbolic action name (drives namespace + TUI
//                      attribution).
//   - `chainId`      — substrate-folded automatically (substrate-side
//                      of the OCA cache key).
//   - `consumedKeys` — the literal tag-ids of every entry in
//                      `consumes:`. Folded so reordering/changing
//                      upstream deps invalidates the cache. Static —
//                      resolved at factory construction time.
//   - `discriminator` — OPTIONAL caller-supplied extra material. Two
//                      accepted shapes: a literal `string`, or a
//                      callback `(ctx) => Effect<string>` receiving
//                      the action's BuildContext so the body can
//                      derive the discriminator from upstream resolved
//                      refs (e.g. hash a freshly-published package
//                      id). The callback form re-runs on EVERY acquire
//                      (hit OR miss) — mirrors v3's `cacheKey:
//                      Effect<string>` semantics (16-action.md
//                      invariant 5/6).
//
// The dynamic discriminator covers the common case where the action's
// idempotency hinges on a value not known until upstream resolution
// completes. The v3 example: `cacheKey: Effect.gen(function* () {
// const pkg = yield* connectFour; return pkg.packageId; })`.

import type { Effect } from 'effect';

import type { AnyTag } from '../../substrate/tag.ts';
import type { ActionError } from './errors.ts';
import type { ActionBuildContext } from './build-context.ts';

/** Static portion of the discriminator (known at factory construction
 *  time). The substrate folds this into the content-hash so the
 *  cache key changes when these fields do. */
export interface StaticDiscriminator {
	/** Symbolic action name. */
	readonly actionName: string;
	/** Tag-id literals of every entry in `consumes:`, in declaration
	 *  order. Reordering MUST invalidate the cache (this is the v3
	 *  behavior — `needs.map(n => n.key)` was folded in order). */
	readonly consumedTagIds: ReadonlyArray<string>;
}

/** Dynamic portion (resolved at acquire time). Two accepted shapes:
 *
 *  - `string`    — literal cache-key fragment, used verbatim.
 *  - `(ctx) => Effect<string, ActionError>` — callback receiving the
 *                  action's `ActionBuildContext` (same shape the body
 *                  callback receives). The Effect is yielded at
 *                  acquire time so the callback can derive the
 *                  discriminator from upstream resolved values (e.g.
 *                  fold in a freshly-published package id). Re-runs
 *                  on EVERY acquire (hit OR miss). User errors
 *                  propagate as `ActionError({phase: 'discriminator'})`. */
export type DynamicDiscriminator<Consumes extends ReadonlyArray<AnyTag> = ReadonlyArray<AnyTag>> =
	| string
	| ((ctx: ActionBuildContext<Consumes>) => Effect.Effect<string, ActionError>);

/** Build the content-hash input string from static + resolved-dynamic
 *  pieces. Canonical shape: newline-delimited so two strings with
 *  shared prefixes hash differently. */
export const composeDiscriminatorMaterial = (
	staticParts: StaticDiscriminator,
	resolvedDynamic: string | undefined,
): string => {
	const lines: string[] = [
		`action=${staticParts.actionName}`,
		`consumes=${staticParts.consumedTagIds.join(',')}`,
	];
	if (resolvedDynamic !== undefined) {
		lines.push(`discriminator=${resolvedDynamic}`);
	}
	return lines.join('\n');
};
