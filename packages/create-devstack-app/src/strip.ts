// Fence stripper + plugin stripper for the scaffolder.
//
// Marker syntax (EXACT, from design-template.md "Marker syntax"):
//
//   // devstack:begin walrus
//   import { WalrusPanel } from './panels/WalrusPanel.js';
//   // devstack:end walrus
//
// Fences sit on whole-statement boundaries (import lines, array elements,
// config member lines) so removal never breaks syntax. For an UNSELECTED
// plugin the whole begin..end block is dropped (incl. both fence lines). For a
// SELECTED plugin only the two fence lines are removed, the body is kept.
//
// Every `begin <p>` MUST have a matching `end <p>`; an unmatched/mismatched
// fence throws (mirroring `replaceInFile`'s not-found-throws discipline).

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import {
	OPTIONAL_PLUGINS,
	PLUGIN_MANIFEST,
	type PluginId,
} from './plugin-manifest.js';

// Exact fence patterns. Capture group 1 = plugin id token. Allow trailing
// whitespace but nothing else after the id, so a stray `// devstack:begin`
// without an id (or with junk) does not silently match.
const BEGIN_RE = /^\s*\/\/ devstack:begin (\S+)\s*$/;
const END_RE = /^\s*\/\/ devstack:end (\S+)\s*$/;

/** True iff `text` contains at least one REAL fence line — a `begin` or `end`
 *  marker with an id token occupying a whole line — using the same per-line
 *  regexes the stripper relies on. Substring checks like
 *  `text.includes('// devstack:begin')` false-positive on prose/comments that
 *  merely mention the marker syntax; this does not. */
export function hasFenceLine(text: string): boolean {
	for (const line of text.split('\n')) {
		if (BEGIN_RE.test(line) || END_RE.test(line)) return true;
	}
	return false;
}

/** Text-file extensions the fence stripper scans. Shared fenced files are
 *  config/source: .ts/.tsx/.move plus the devstack/playwright configs. */
const TEXT_EXTS = new Set(['.ts', '.tsx', '.move', '.js', '.mjs', '.cts', '.mts']);

export interface StripFenceResult {
	/** The rewritten file contents. */
	readonly text: string;
	/** True if the result is content-empty (only blank lines remain). */
	readonly empty: boolean;
}

/**
 * Strip plugin fences from a single text blob.
 *
 * @param text     original file contents
 * @param selected the set of selected plugin ids (always includes `core`)
 * @returns the rewritten text and whether it is content-empty
 * @throws if a `begin` has no matching `end`, an `end` has no open `begin`,
 *         or a nested/mismatched fence is encountered
 */
export function stripFences(text: string, selected: ReadonlySet<PluginId>): StripFenceResult {
	// Preserve the original newline style and trailing-newline presence.
	const hadTrailingNewline = text.endsWith('\n');
	const lines = text.split('\n');
	// `split('\n')` on a trailing-newline file yields a final '' element; drop
	// it so we re-add the trailing newline consistently at the end.
	if (hadTrailingNewline) lines.pop();

	const out: string[] = [];
	// Fence stack: each frame is { plugin, keep } where `keep` is whether the
	// current (possibly nested) block's lines should survive. A block is kept
	// only if every enclosing plugin is selected.
	const stack: Array<{ plugin: string; keep: boolean }> = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? '';
		const begin = BEGIN_RE.exec(line);
		if (begin !== null) {
			const plugin = begin[1] as PluginId;
			const parentKeep = stack.length === 0 ? true : (stack[stack.length - 1]?.keep ?? true);
			const keep = parentKeep && selected.has(plugin);
			stack.push({ plugin, keep });
			// Fence line itself is always dropped.
			continue;
		}
		const end = END_RE.exec(line);
		if (end !== null) {
			const plugin = end[1];
			const top = stack.pop();
			if (top === undefined) {
				throw new Error(
					`fence stripper: unmatched '// devstack:end ${plugin}' (no open begin) at line ${i + 1}`,
				);
			}
			if (top.plugin !== plugin) {
				throw new Error(
					`fence stripper: mismatched fence — '// devstack:end ${plugin}' closes '// devstack:begin ${top.plugin}' at line ${i + 1}`,
				);
			}
			// Fence line itself is always dropped.
			continue;
		}
		// Body line: keep iff the enclosing block (if any) is kept.
		const keep = stack.length === 0 ? true : (stack[stack.length - 1]?.keep ?? true);
		if (keep) out.push(line);
	}

	if (stack.length > 0) {
		const open = stack[stack.length - 1];
		throw new Error(
			`fence stripper: unclosed '// devstack:begin ${open?.plugin}' (no matching end before EOF)`,
		);
	}

	const empty = out.every((l) => l.trim() === '');
	const text2 = hadTrailingNewline ? `${out.join('\n')}\n` : out.join('\n');
	return { text: text2, empty };
}

/** Walk a directory tree yielding absolute file paths. */
function* walkFiles(dir: string): IterableIterator<string> {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			yield* walkFiles(full);
		} else if (entry.isFile()) {
			yield full;
		}
	}
}

function hasTextExt(path: string): boolean {
	const dot = path.lastIndexOf('.');
	if (dot < 0) return false;
	return TEXT_EXTS.has(path.slice(dot));
}

/** Remove a manifest file (tolerate missing — `rm -f`). */
function rmFileForce(path: string): void {
	rmSync(path, { force: true });
}

/** Remove a manifest dir recursively (tolerate missing — `rm -rf`). */
function rmDirForce(path: string): void {
	rmSync(path, { recursive: true, force: true });
}

interface PkgJson {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	[k: string]: unknown;
}

/**
 * Strip every unselected plugin from a scaffolded app directory in place.
 *
 *  1. Remove unselected plugins' manifest `files`/`dirs` (tolerating missing).
 *  2. Fence-strip every text file; delete files left content-empty.
 *  3. Structurally delete unselected plugins' `deps`/`devDeps` from
 *     package.json.
 *  4. Guard: grep the tree for any leftover `devstack:begin`/`devstack:end`
 *     and for imports of any removed module path — throw if found.
 *
 * `selected` must always contain `core`; the caller (bin/scaffold) guarantees
 * this, but we assert it defensively.
 */
export function stripPlugins(appDir: string, selected: ReadonlySet<PluginId>): void {
	if (!selected.has('core')) {
		throw new Error("stripPlugins: 'core' must always be selected.");
	}

	const removedModuleBasenames = new Set<string>();

	// (1) Remove unselected plugins' owned files/dirs.
	for (const id of OPTIONAL_PLUGINS) {
		if (selected.has(id)) continue;
		const entry = PLUGIN_MANIFEST[id];
		for (const f of entry.files) {
			rmFileForce(join(appDir, f));
			// Track the import basename so the guard can flag dangling imports,
			// e.g. removing src/lib/walrus.ts → flag `./lib/walrus` imports.
			removedModuleBasenames.add(moduleKey(f));
		}
		for (const d of entry.dirs) {
			rmDirForce(join(appDir, d));
		}
	}

	// (2) Fence-strip every text file; delete content-empty results.
	for (const file of walkFiles(appDir)) {
		if (!hasTextExt(file)) continue;
		const original = readFileSync(file, 'utf8');
		// Cheap fast-path: skip files with no REAL fences at all. Use the same
		// per-line regexes the stripper uses (id token + end-of-line) so prose
		// that merely mentions the marker syntax does not force a needless pass.
		if (!hasFenceLine(original)) {
			continue;
		}
		const { text, empty } = stripFences(original, selected);
		if (empty) {
			rmFileForce(file);
			removedModuleBasenames.add(moduleKey(relative(appDir, file)));
		} else if (text !== original) {
			writeFileSync(file, text);
		}
	}

	// (3) Structurally delete unselected deps/devDeps from package.json.
	const pkgPath = join(appDir, 'package.json');
	if (existsSync(pkgPath)) {
		const json = JSON.parse(readFileSync(pkgPath, 'utf8')) as PkgJson;
		let changed = false;
		for (const id of OPTIONAL_PLUGINS) {
			if (selected.has(id)) continue;
			const entry = PLUGIN_MANIFEST[id];
			for (const dep of entry.deps) {
				if (json.dependencies?.[dep] !== undefined) {
					delete json.dependencies[dep];
					changed = true;
				}
			}
			for (const dep of entry.devDeps ?? []) {
				if (json.devDependencies?.[dep] !== undefined) {
					delete json.devDependencies[dep];
					changed = true;
				}
			}
		}
		if (changed) {
			writeFileSync(pkgPath, `${JSON.stringify(json, null, '\t')}\n`);
		}
	}

	// (4) Guard: no leftover fences, no dangling imports of removed modules.
	assertNoLeftovers(appDir, removedModuleBasenames);
}

/** Derive an import-key from a template-relative source path:
 *  `src/lib/walrus.ts` → `lib/walrus`, `src/panels/WalrusPanel.tsx`
 *  → `panels/WalrusPanel`. Used to detect dangling imports after removal. */
function moduleKey(relPath: string): string {
	let p = relPath.replace(/\\/g, '/');
	if (p.startsWith('src/')) p = p.slice('src/'.length);
	return p.replace(/\.(tsx?|m?[jt]s|cts|mts)$/, '');
}

/** Throw if any text file still contains a fence marker, or imports a removed
 *  module path (matched by its import key, e.g. `./lib/walrus`,
 *  `./panels/WalrusPanel`). */
function assertNoLeftovers(appDir: string, removedModuleKeys: ReadonlySet<string>): void {
	for (const file of walkFiles(appDir)) {
		if (!hasTextExt(file)) continue;
		const text = readFileSync(file, 'utf8');
		// Detect leftover fences with the SAME per-line regexes the stripper
		// uses (real id token + end-of-line), not a substring match — so prose
		// or comments that merely mention the `// devstack:begin` marker syntax
		// don't false-positive.
		if (hasFenceLine(text)) {
			throw new Error(
				`stripPlugins guard: leftover devstack fence in ${relative(appDir, file)} after stripping.`,
			);
		}
		for (const key of removedModuleKeys) {
			// Match `from './lib/walrus.js'`, `import('./panels/WalrusPanel')`,
			// etc. We look for the key preceded by a path separator and bounded
			// by a quote / extension, to avoid false positives on substrings.
			const re = new RegExp(`['"\`][^'"\`]*/${escapeRegExp(key)}(\\.[a-z]+)?['"\`]`);
			if (re.test(text)) {
				throw new Error(
					`stripPlugins guard: ${relative(appDir, file)} still imports removed module '${key}'.`,
				);
			}
		}
	}
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Validate that every `begin` has a matching `end` in a blob (no stripping).
 *  Throws on imbalance. Useful for asserting the authored template's fences are
 *  well-formed before stripping. */
export function assertFencesBalanced(text: string, label: string): void {
	const stack: string[] = [];
	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? '';
		const begin = BEGIN_RE.exec(line);
		if (begin !== null) {
			stack.push(begin[1] as string);
			continue;
		}
		const end = END_RE.exec(line);
		if (end !== null) {
			const top = stack.pop();
			if (top === undefined) {
				throw new Error(`${label}: unmatched '// devstack:end ${end[1]}' at line ${i + 1}`);
			}
			if (top !== end[1]) {
				throw new Error(
					`${label}: mismatched fence '// devstack:end ${end[1]}' closes '// devstack:begin ${top}' at line ${i + 1}`,
				);
			}
		}
	}
	if (stack.length > 0) {
		throw new Error(`${label}: unclosed '// devstack:begin ${stack[stack.length - 1]}'`);
	}
}
