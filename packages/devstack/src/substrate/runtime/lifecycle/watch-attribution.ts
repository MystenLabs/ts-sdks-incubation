// Watch-path → owning plugin attribution.
//
// Architecture § L3 Watch dispatcher: "collects all plugin `watch`
// declarations, receives watcher events from L0 (which already
// debounced + dedup'd), triggers selective restart through the
// scheduler's invalidate-with-cascade."
//
// L0 owns the file watcher (debounce + content-hash dedup). The
// supervisor's role at watch time is just: given a fired path, which
// plugin row(s) should be invalidated? This module builds and queries
// that index. Selective-restart is the supervisor's concern; watch
// attribution stays pure.

import { Effect } from 'effect';

import type { PluginKey } from '../../brand.ts';
import type { DepNode } from './dep-graph.ts';

/** Per-plugin watch entry — a copy of the plugin's declared `watch`
 *  decl with the owning key attached. */
export interface WatchEntry {
	readonly pluginKey: PluginKey;
	readonly paths: ReadonlyArray<string>;
	/** Whether downstream consumers should cascade-invalidate when this
	 *  fires. Defaults to true (architecture § WatchDecl). */
	readonly cascade: boolean;
}

/** Build the watch index from a resolved dep-graph's nodes. Composite
 *  inner participants contribute their own watch paths — they're
 *  scheduled as first-class nodes, so their `watch` decl is honored
 *  identically. */
export const buildWatchIndex = (
	nodes: ReadonlyMap<PluginKey, DepNode>,
): ReadonlyArray<WatchEntry> => {
	const out: WatchEntry[] = [];
	for (const [key, node] of nodes) {
		const watch = node.member.watch;
		if (watch === undefined || watch.paths.length === 0) continue;
		out.push({
			pluginKey: key,
			paths: watch.paths,
			cascade: watch.cascade ?? true,
		});
	}
	return out;
};

/**
 * Given the firing `firedPath` (already debounced + content-hash dedup'd
 * by L0), return the plugin keys whose declared paths match.
 *
 * Matching is glob-aware via minimatch semantics — the substrate-level
 * attribution here delegates to a supplied `match` predicate to keep
 * this module dependency-free. The supervisor wires the matcher in.
 */
export const attribute = (
	index: ReadonlyArray<WatchEntry>,
	firedPath: string,
	match: (pattern: string, path: string) => boolean,
): ReadonlySet<PluginKey> => {
	const out = new Set<PluginKey>();
	for (const entry of index) {
		for (const pattern of entry.paths) {
			if (match(pattern, firedPath)) {
				out.add(entry.pluginKey);
				break;
			}
		}
	}
	return out;
};

/**
 * Effect-flavored wrapper — span-instrumented for tracing. Wraps the
 * pure `attribute` so the supervisor's invalidate-with-cascade trace
 * shows the watch fan-out alongside the dep-graph restart slice.
 */
export const attributeFire = (
	index: ReadonlyArray<WatchEntry>,
	firedPath: string,
	match: (pattern: string, path: string) => boolean,
): Effect.Effect<ReadonlySet<PluginKey>> =>
	Effect.gen(function* () {
		const keys = attribute(index, firedPath, match);
		yield* Effect.annotateCurrentSpan({
			'devstack.watch.firedPath': firedPath,
			'devstack.watch.matchedCount': keys.size,
		});
		return keys;
	}).pipe(Effect.withSpan('lifecycle.watch.attribute'));

/**
 * Default fallback matcher — exact-prefix only. Provided so unit
 * tests / single-stack boots without a real minimatch dependency
 * still function. The L0 thick watcher's minimatch is the production
 * matcher.
 */
export const exactPrefixMatch = (pattern: string, path: string): boolean =>
	path === pattern || path.startsWith(pattern.replace(/\*+$/, ''));
