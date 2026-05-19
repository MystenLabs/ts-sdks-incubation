// Display-friendly path shortening for user-facing surfaces (TUI rows,
// log messages, error bodies). Absolute filesystem paths in the output
// are visually noisy and machine-specific — a path like
// `/Users/<long-name>/code/<long-org>/<long-repo>/examples/private-content/src/generated`
// burns half the row's detail column on context the user already knows
// (they're sitting IN that directory). Relativize against the dev loop's
// natural anchors instead.
//
// Precedence:
//   1. Inside `process.cwd()` → relative to cwd (`src/generated`,
//      `move/vault/sources/foo.move`). The common case for everything
//      the user typed.
//   2. Inside `$HOME` → home-relative with `~` (`~/.devstack/foo`,
//      `~/.docker/config.json`). Catches devstack/docker config paths.
//   3. Otherwise → original absolute path. System paths
//      (`/usr/local/bin/sui`) and absolute paths outside the dev tree
//      keep their full form because anything shorter loses information.
//
// Relative paths that climb out of cwd (e.g. `../../../var/foo`) past a
// configured ladder of depth fall through to absolute too — once you're
// climbing more parent dirs than walking forward, the shortened form
// is harder to read than the original.

import * as nodePath from 'node:path';
import { homedir } from 'node:os';

const MAX_PARENT_CLIMBS = 3;

const home = ((): string => {
	try {
		return homedir();
	} catch {
		return '';
	}
})();

/**
 * Convert an absolute filesystem path into the shortest meaningful form
 * for display. Non-absolute inputs and unknown paths are returned as-is
 * (callers are trusted not to pre-relativize). Cross-platform safe:
 * uses Node's `path` so the separator matches the host OS.
 */
export const displayPath = (input: string): string => {
	if (input.length === 0) return input;
	if (!nodePath.isAbsolute(input)) return input;
	const cwd = process.cwd();
	const rel = nodePath.relative(cwd, input);
	const climbs = countParentClimbs(rel);
	if (climbs <= MAX_PARENT_CLIMBS) {
		// `path.relative(cwd, cwd) === ''` — surface as `.` so the row
		// doesn't render as empty when something points exactly at cwd.
		return rel.length === 0 ? '.' : rel;
	}
	if (home.length > 0 && (input === home || input.startsWith(home + nodePath.sep))) {
		const tail = input.slice(home.length);
		return `~${tail}`;
	}
	return input;
};

const countParentClimbs = (rel: string): number => {
	let i = 0;
	let depth = 0;
	const sep = nodePath.sep;
	while (rel.startsWith(`..${sep}`, i)) {
		depth += 1;
		i += 3; // `..` + separator
	}
	if (rel.slice(i) === '..') depth += 1;
	return depth;
};
