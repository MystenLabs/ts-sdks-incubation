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

/** Build the watch index from a resolved dep-graph's nodes. */
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

const REGEXP_SPECIALS = new Set('.+^${}()|[]\\'.split(''));

/**
 * Compile a watch glob to an anchored `RegExp`. Supports the only glob
 * features the package plugin emits (architecture § WatchDecl):
 *   - `**\/` — zero or more path segments (so `root/**\/*.move` matches both
 *     `root/x.move` and `root/sources/x.move`)
 *   - `**`   — any characters including `/` (trailing-segment form)
 *   - `*`    — any characters except `/` (within one segment)
 *   - `?`    — one character except `/`
 * Everything else is matched literally. This is the dependency-free stand-in
 * for the architecture's "minimatch" matcher — devstack pulls in no glob
 * library (cf. the hand-rolled `collectHashedSources`).
 */
const globToRegExp = (glob: string): RegExp => {
	let body = '';
	for (let i = 0; i < glob.length; i += 1) {
		const c = glob[i]!;
		if (c === '*' && glob[i + 1] === '*') {
			if (glob[i + 2] === '/') {
				body += '(?:.*/)?';
				i += 2;
			} else {
				body += '.*';
				i += 1;
			}
		} else if (c === '*') {
			body += '[^/]*';
		} else if (c === '?') {
			body += '[^/]';
		} else if (REGEXP_SPECIALS.has(c)) {
			body += `\\${c}`;
		} else {
			body += c;
		}
	}
	return new RegExp(`^${body}$`);
};

/** Glob-aware matcher — the production matcher the supervisor wires into
 *  `attribute`. Honors `**`, `*`, `?`; everything else is literal. Both
 *  sides are normalized to POSIX separators first: the watcher feeds paths
 *  from `join(root, filename)`, which is `\`-separated on Windows, while
 *  glob patterns are always `/`-separated. */
const toPosix = (p: string): string => p.replace(/\\/g, '/');

export const globMatch = (pattern: string, path: string): boolean =>
	globToRegExp(toPosix(pattern)).test(toPosix(path));

/** Literal directory prefix of a watch glob — the path up to (but not
 *  including) the first segment containing a glob metacharacter. Both
 *  `root/**\/*.move` and the exact `root/Move.toml` collapse to `root`,
 *  so the L0 watcher places ONE recursive watch per source tree. A
 *  pattern whose literal prefix has no directory separator — a bare
 *  basename (`Move.toml`), a leading glob (`*.move` ⇒ empty prefix), or a
 *  same-segment glob (`src*`) — collapses to `.` (the cwd), never to a
 *  bare filename: `fs.watch` must be handed a directory, and `globMatch`
 *  still filters the events. */
const literalRoot = (pattern: string): string => {
	const metaIdx = pattern.search(/[*?]/);
	const literal = metaIdx === -1 ? pattern : pattern.slice(0, metaIdx);
	const slash = literal.lastIndexOf('/');
	if (slash === 0) return '/'; // pattern sits at filesystem root
	return slash > 0 ? literal.slice(0, slash) : '.';
};

/** Distinct recursive-watch roots for a watch index — the directories the
 *  L0 file watcher hands to `fs.watch(root, { recursive: true })`. */
export const deriveWatchRoots = (index: ReadonlyArray<WatchEntry>): ReadonlyArray<string> => {
	const roots = new Set<string>();
	for (const entry of index) {
		for (const pattern of entry.paths) {
			roots.add(literalRoot(pattern));
		}
	}
	return [...roots];
};
