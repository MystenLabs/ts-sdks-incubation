// Warm boot-cache fingerprint — the baseline-invalidation key.
//
// `--warm` captures a baseline snapshot after the first good boot and
// restores it on later boots UNLESS the inputs changed. This module
// computes the input fingerprint: a stable hex sha256 over a CANONICAL
// document of everything that, if it changed, MUST re-capture the
// baseline rather than restore a now-stale one.
//
// The signals, most-to-least direct:
//
//   - `configSource` — sha256 of the resolved `devstack.config.ts`
//     bytes. PRIMARY signal: per-plugin option edits live as text in
//     that file, so a byte change there already catches them. Config
//     must exist; an unreadable config is a hard `WarmFingerprintError`.
//   - `members` — id/role/section/deps/watch of every plugin, sorted by
//     id so member reordering does not churn the key.
//   - `options` — the (display-stripped) `DevstackOptions`, canonically
//     stringified so key ordering never churns the key.
//   - `moveSources` — content hashes of `*.move` / `Move.toml` /
//     `Move.lock` reached from each member's declared `watch.paths`.
//     Those paths may be GLOBS (e.g. `${sourcePath}/**​/*.move`,
//     `${sourcePath}/Move.toml`) — see `resolveWatchInputs` for how globs
//     collapse to a base directory and literal files are hashed directly.
//     Captures Move-package source edits that a config byte-diff cannot see.
//   - `envImageOverrides` — set image-override env vars, so pointing the
//     stack at a different container image invalidates the baseline.
//
// Pure-ish: the only ambient effect is `FileSystem` reads. No Docker, no
// supervisor, no snapshot service.

import { createHash } from 'node:crypto';
import { basename, isAbsolute, join, relative } from 'node:path';

import { Effect, FileSystem, Schema } from 'effect';

import type { SupervisedStack } from '../../substrate/runtime/supervisor/types.ts';

/** Stable snapshot id the warm baseline is captured under. Matches
 *  `SNAPSHOT_ID_PATTERN` in `../snapshot/descriptor.ts`
 *  (`[A-Za-z0-9][A-Za-z0-9_-]*`, 1-128 chars). */
export const WARM_BASELINE_SNAPSHOT_ID = 'warm-baseline';

/** Fingerprint document version. Bump when the canonical document's
 *  shape changes in a way that should invalidate every existing
 *  baseline (a v-bump alone shifts the hash). */
const WARM_FINGERPRINT_VERSION = 1 as const;

/** Tagged failure for fingerprint computation. The only failure mode is
 *  an unreadable `configPath` — the config is the primary signal and a
 *  warm boot cannot proceed without it. `cause` carries the underlying
 *  filesystem defect for cascade formatting. */
export class WarmFingerprintError extends Schema.TaggedErrorClass<WarmFingerprintError>()(
	'WarmFingerprintError',
	{
		detail: Schema.String,
		path: Schema.optional(Schema.String),
		cause: Schema.optional(Schema.Defect),
	},
) {}

// -----------------------------------------------------------------------------
// Canonical stringify — local, recursive, key-sorting. Deliberately NOT
// the snapshot service's canonicalizer: the warm fingerprint owns its own
// tiny serializer so it carries no dependency on the snapshot subtree.
// -----------------------------------------------------------------------------

/** Recursively key-sort an object graph into a canonical form. Object
 *  keys are sorted; array order is preserved (callers sort the arrays
 *  whose order is not meaningful before handing them here). `undefined`
 *  values inside objects are dropped so an explicit `key: undefined`
 *  hashes identically to an absent key. */
export const canonicalize = (value: unknown): unknown => {
	if (Array.isArray(value)) {
		return value.map((entry) => canonicalize(entry));
	}
	if (value !== null && typeof value === 'object') {
		const source = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(source).sort((a, b) => a.localeCompare(b))) {
			const entry = source[key];
			if (entry === undefined) continue;
			out[key] = canonicalize(entry);
		}
		return out;
	}
	return value;
};

/** Canonical JSON string of a value — `canonicalize` then
 *  `JSON.stringify`. The hash input. */
export const canonicalStringify = (value: unknown): string =>
	JSON.stringify(canonicalize(value));

const sha256Hex = (data: string | Uint8Array): string =>
	createHash('sha256').update(data).digest('hex');

// -----------------------------------------------------------------------------
// Move-source discovery — content (not mtime) hashes under watch roots.
// -----------------------------------------------------------------------------

/** A watched file whose CONTENTS feed the fingerprint: a Move manifest
 *  or any `.move` source. Mirrors the predicate in
 *  `plugins/sui/move/index.ts` so the warm key tracks the same files the
 *  build hashes. */
const isMoveSourceFile = (name: string): boolean =>
	name === 'Move.toml' || name === 'Move.lock' || name.endsWith('.move');

/** Directories the walk never descends into — build output, vendored
 *  deps, VCS, and dotdirs generally. */
const isSkippedDir = (name: string): boolean =>
	name === 'build' || name === 'node_modules' || name === '.git' || name.startsWith('.');

/** Resolve a (possibly relative) watch path against `appRoot`. */
const resolveWatchPath = (appRoot: string, watchPath: string): string =>
	isAbsolute(watchPath) ? watchPath : join(appRoot, watchPath);

/** Glob metacharacters. A watch path containing any of these is a glob
 *  pattern (e.g. `${sourcePath}/**​/*.move`), NOT a literal filesystem
 *  path — `readDirectory`-ing the raw string would find nothing. */
const hasGlobChars = (segment: string): boolean => /[*?[\]{}]/.test(segment);

/** Derive the longest leading NON-glob directory prefix of a (resolved)
 *  watch path. Splits on `/`, keeps segments up to (but excluding) the
 *  first one containing a glob char, and rejoins. `${root}/**​/*.move`
 *  and `${root}/Move.toml` both collapse to `${root}`, so overlapping
 *  globs under one package walk the same base once. A path with no glob
 *  chars returns itself unchanged. */
const globBaseDir = (resolved: string): string => {
	const segments = resolved.split('/');
	const base: string[] = [];
	for (const segment of segments) {
		if (hasGlobChars(segment)) break;
		base.push(segment);
	}
	// `split('/')` on an absolute path yields a leading '' segment, so
	// `join('/')` round-trips the leading slash; a relative path keeps its
	// shape. An empty base (first segment globbed) falls back to '.'.
	const joined = base.join('/');
	return joined === '' ? '.' : joined;
};

/** Walk one resolved watch root, collecting absolute paths of every Move
 *  source file under it. A missing root yields `[]` (not an error) — a
 *  plugin may declare a watch root that does not exist yet. */
const collectMoveSourcePaths = (
	root: string,
): Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const found: string[] = [];
		const walk = (dir: string): Effect.Effect<void, never> =>
			Effect.gen(function* () {
				const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
				for (const name of names) {
					const abs = join(dir, name);
					const stat = yield* fs.stat(abs).pipe(Effect.option);
					if (stat._tag === 'None') continue;
					if (stat.value.type === 'Directory') {
						if (isSkippedDir(name)) continue;
						yield* walk(abs);
					} else if (stat.value.type === 'File' && isMoveSourceFile(name)) {
						found.push(abs);
					}
				}
			});
		yield* walk(root);
		return found;
	});

/** Resolve every member's watch paths into the concrete set of
 *  filesystem inputs to hash, classifying each entry:
 *
 *   - GLOB (`*`/`?`/`[`/`{`): strip the glob tail to its longest leading
 *     non-glob directory prefix and walk THAT base (so
 *     `${root}/**​/*.move` collects all Move sources under `${root}`).
 *   - literal FILE (e.g. a `Move.toml`/`Move.lock` with no glob chars):
 *     hash it directly — `readDirectory` on a file finds nothing, so a
 *     literal-file watch entry must be handled as a file, not a root.
 *   - literal DIRECTORY: walk it as a Move-source root.
 *
 *  Returns de-duped `{ baseDirs, files }` so overlapping globs under one
 *  package (the `**​/*.move` + `Move.toml` + `Move.lock` triple
 *  `localPackage` emits) resolve to a SINGLE base dir, and a literal file
 *  that also lives under a walked base dir is not read twice (the walk
 *  owns it). Non-existent paths are silently skipped. */
const resolveWatchInputs = (
	stack: SupervisedStack,
	appRoot: string,
): Effect.Effect<
	{ readonly baseDirs: ReadonlyArray<string>; readonly files: ReadonlyArray<string> },
	never,
	FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const baseDirs = new Set<string>();
		const files = new Set<string>();
		for (const member of stack.members) {
			for (const watchPath of member.watch?.paths ?? []) {
				const resolved = resolveWatchPath(appRoot, watchPath);
				if (hasGlobChars(resolved)) {
					// Glob — walk the longest non-glob directory prefix.
					baseDirs.add(globBaseDir(resolved));
					continue;
				}
				// Literal path: classify by stat. Missing → silently skip.
				const stat = yield* fs.stat(resolved).pipe(Effect.option);
				if (stat._tag === 'None') continue;
				if (stat.value.type === 'Directory') {
					baseDirs.add(resolved);
				} else if (stat.value.type === 'File' && isMoveSourceFile(basename(resolved))) {
					// Only literal Move sources/manifests feed the key — mirrors
					// the `isMoveSourceFile` filter the directory walk applies.
					files.add(resolved);
				}
			}
		}
		// A literal file that also falls under a walked base dir is collected
		// by the walk; drop it from `files` so it is not hashed twice.
		const baseDirList = [...baseDirs];
		const standaloneFiles = [...files].filter(
			(file) => !baseDirList.some((dir) => file.startsWith(`${dir}/`)),
		);
		return { baseDirs: baseDirList, files: standaloneFiles };
	});

/** Read + content-hash every Move source under every member's watch
 *  paths, keyed by path RELATIVE to `appRoot` so the key is portable
 *  across machines. Glob watch entries (`${root}/**​/*.move`) walk their
 *  derived base directory; literal-file entries (`${root}/Move.toml`) are
 *  hashed directly. Unreadable files are skipped (best-effort), matching
 *  the missing-root tolerance. Sorted by key for stable ordering. */
const computeMoveSources = (
	stack: SupervisedStack,
	appRoot: string,
): Effect.Effect<Record<string, string>, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const { baseDirs, files } = yield* resolveWatchInputs(stack, appRoot);
		// De-dup the concrete absolute paths to hash: every Move source under
		// each base dir, plus each standalone literal file.
		const absSet = new Set<string>();
		for (const dir of baseDirs) {
			for (const abs of yield* collectMoveSourcePaths(dir)) absSet.add(abs);
		}
		for (const file of files) absSet.add(file);
		const hashes: Record<string, string> = {};
		for (const abs of absSet) {
			const bytes = yield* fs.readFile(abs).pipe(Effect.option);
			if (bytes._tag === 'None') continue;
			const relKey = relative(appRoot, abs);
			hashes[relKey] = sha256Hex(bytes.value);
		}
		const sorted: Record<string, string> = {};
		for (const key of Object.keys(hashes).sort((a, b) => a.localeCompare(b))) {
			sorted[key] = hashes[key]!;
		}
		return sorted;
	});

// -----------------------------------------------------------------------------
// Env image overrides — a different image must invalidate the baseline.
// -----------------------------------------------------------------------------

/** Image-override env var matchers. Mirrors the reads in
 *  `plugins/sui/mode/fork.ts` (`DEVSTACK_SUI_FORK_IMAGE`),
 *  `plugins/seal/bootstrap-assets/cargo-image.ts`
 *  (`SEAL_CARGO_IMAGE_OVERRIDE`), and
 *  `plugins/walrus/bootstrap-assets/cargo-image.ts`
 *  (`WALRUS_CARGO_IMAGE_OVERRIDE`) — generically so a new
 *  similarly-named override is captured without editing this list. */
const isImageOverrideEnvKey = (key: string): boolean =>
	/^DEVSTACK_.*_IMAGE$/.test(key) ||
	key.endsWith('_CARGO_IMAGE_OVERRIDE') ||
	key.endsWith('_FORK_IMAGE');

/** `KEY=value` pairs for every set image-override env var, sorted by
 *  key. Empty-string values are treated as unset (devstack's `readEnv`
 *  convention) and skipped. */
const collectEnvImageOverrides = (): ReadonlyArray<string> => {
	const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
		?.env;
	if (env === undefined) return [];
	const pairs: string[] = [];
	for (const key of Object.keys(env)) {
		if (!isImageOverrideEnvKey(key)) continue;
		const value = env[key];
		if (value === undefined || value === '') continue;
		pairs.push(`${key}=${value}`);
	}
	return pairs.sort((a, b) => a.localeCompare(b));
};

// -----------------------------------------------------------------------------
// Options projection — strip display-only fields the baseline must ignore.
// -----------------------------------------------------------------------------

/** Project `DevstackOptions` to the fingerprint-relevant subset: drop
 *  `renderer`, which is a display choice (tui/plain/silent) that must
 *  NOT invalidate a captured baseline. Everything else feeds the hash
 *  via `canonicalize`. */
const fingerprintOptions = (options: SupervisedStack['options']): unknown => {
	const { renderer: _renderer, ...rest } = options;
	return rest;
};

// -----------------------------------------------------------------------------
// The fingerprint.
// -----------------------------------------------------------------------------

/**
 * Compute the warm-baseline fingerprint — a hex sha256 over the
 * canonical input document. Two boots whose inputs are equivalent
 * produce the same fingerprint (restore the baseline); any input change
 * produces a different one (re-capture).
 *
 * Fails only when `configPath` cannot be read — the config is the
 * primary signal and a warm boot must not silently proceed without it.
 */
export const computeWarmFingerprint = (args: {
	readonly stack: SupervisedStack;
	readonly appRoot: string;
	readonly configPath: string;
	readonly devstackVersion: string;
}): Effect.Effect<string, WarmFingerprintError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const { stack, appRoot, configPath, devstackVersion } = args;

		const configBytes = yield* fs.readFile(configPath).pipe(
			Effect.mapError(
				(cause) =>
					new WarmFingerprintError({
						detail: `warm fingerprint: config unreadable at ${configPath}`,
						path: configPath,
						cause,
					}),
			),
		);

		const members = stack.members
			.map((plugin) => ({
				id: plugin.id,
				role: plugin.role,
				section: plugin.section,
				deps: [...plugin.dependsOn.map((dep) => dep.id)].sort((a, b) => a.localeCompare(b)),
				watch: [...(plugin.watch?.paths ?? [])].sort((a, b) => a.localeCompare(b)),
			}))
			.sort((a, b) => a.id.localeCompare(b.id));

		const moveSources = yield* computeMoveSources(stack, appRoot);

		const doc = {
			v: WARM_FINGERPRINT_VERSION,
			devstackVersion,
			configSource: sha256Hex(configBytes),
			members,
			options: fingerprintOptions(stack.options),
			moveSources,
			envImageOverrides: collectEnvImageOverrides(),
		};

		return sha256Hex(canonicalStringify(doc));
	});
