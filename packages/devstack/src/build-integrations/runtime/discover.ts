// Manifest discovery — sync walk-up resolver.
//
// Read-side L5 (consumer) bridge between the on-disk manifest the
// supervisor writes and the apps / build tools that need to find it.
//
// Precedence (top to bottom):
//
//   1. `DEVSTACK_MANIFEST_PATH` env var — top-level escape hatch. Wins
//      over every other input. If set to a missing file, returns
//      `undefined` (or throws when `required: true`).
//   2. `override` argument — caller-explicit path. Same precedence
//      semantics as the env var, one rung lower.
//   3. Walk up from `opts.cwd ?? process.cwd()`. At each directory,
//      check `<stateDir>/stacks/<stack>/manifest.json`. Build
//      integrations resolve `<stack>` from explicit option, then
//      `DEVSTACK_STACK`, then `main`; package metadata is app identity,
//      not an implicit manifest stack selector. The walk stops at the
//      filesystem root.
//
// Stack-scoped ONLY. The supervisor writes to
// `<stateDir>/stacks/<stack>/manifest.json` exclusively; a hit at a
// flat `<stateDir>/manifest.json` would be stale data from a deleted
// stack, which would silently steer consumers at the wrong URLs /
// package ids. Architecture § invariants: "stack-scoped paths only —
// a stale flat manifest must NOT be returned."
//
// Sync because the only host-process that drives this resolver is
// Playwright config-load, and Playwright's loader API is sync. Cost is
// a handful of `existsSync` calls — cheap.

import { existsSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { ManifestDiscoveryError } from './errors.ts';
import {
	DEFAULT_DISCOVERY_STACK,
	DEFAULT_DISCOVERY_STATE_DIR,
	resolveDiscoveryEnv,
} from './resolve-discovery-env.ts';
import { inferPackageNameFromCwd, readPackageName } from '../../api/inference-network.ts';

/** Default name of the supervisor's per-user state directory. Mirrors
 *  the L0 path resolver. Held here as a literal so the discover walk
 *  doesn't reach into the substrate package. Re-export of the
 *  shared-resolver default so this module's public surface is stable. */
export const DEFAULT_STATE_DIR = DEFAULT_DISCOVERY_STATE_DIR;

/** Default stack name when neither `opts.stack` nor `$DEVSTACK_STACK`
 *  yields a useful value. */
export const DEFAULT_STACK = DEFAULT_DISCOVERY_STACK;

export const resolveBuildIntegrationStack = (
	explicit: string | undefined,
	env: Readonly<Record<string, string | undefined>> = process.env,
): string => resolveDiscoveryEnv(env, explicit !== undefined ? { stack: explicit } : {}).stack;

export interface DiscoverManifestPathOptions {
	/** Caller-supplied override path. Bypasses the walk-up but is still
	 *  existence-checked. Lower precedence than
	 *  `DEVSTACK_MANIFEST_PATH`. */
	readonly override?: string;
	/** Starting directory for the walk-up. Defaults to
	 *  `process.cwd()`. */
	readonly cwd?: string;
	/** Stack name. Defaults through `$DEVSTACK_STACK`, then `'main'`. */
	readonly stack?: string;
	/** State-dir name. Defaults through `$DEVSTACK_RUNTIME_ROOT`, then
	 *  the legacy `$DEVSTACK_STATE_DIR`, then `'.devstack'` (see
	 *  `resolveDiscoveryEnv`). Absolute paths are honored — the walk-up
	 *  degenerates into a single existence check in that case. */
	readonly stateDir?: string;
	/** Env bag for the env-precedence step. Defaults to `process.env`.
	 *  Tests pass a fixture (often `{}`) to suppress leaks from the
	 *  ambient environment. */
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** When `true`, throw `ManifestDiscoveryError` on miss instead of
	 *  returning `undefined`. Default `false` (lets callers that treat
	 *  "no manifest" as cold-start branch cleanly). */
	readonly required?: boolean;
}

/** Read `name` out of `<dir>/package.json`, strip the `@scope/`
 *  prefix and any leading non-alphanumerics. Returns `undefined`
 *  when the file is missing / unreadable / has no name field. */
export const readAppName = readPackageName;

/** Walk up from `cwd` to find the closest `package.json` and return
 *  its un-scoped `name` field. Returns `undefined` if no package.json
 *  is reachable. Bounded to 32 levels — defense against pathological
 *  symlink loops. */
export const readAppNameWalkup = inferPackageNameFromCwd;

/**
 * Locate an existing devstack manifest on disk. Sync — Playwright's
 * config loader and apps' startup paths both depend on this being
 * synchronous.
 *
 * Returns the absolute path of the first match per the precedence
 * documented at the top of this module, or `undefined` if no candidate
 * exists. Pass `{ required: true }` to throw `ManifestDiscoveryError`
 * on miss instead.
 */
export function discoverManifestPath(opts: DiscoverManifestPathOptions = {}): string | undefined {
	const env = opts.env ?? (process.env as Readonly<Record<string, string | undefined>>);
	const envOverride = env.DEVSTACK_MANIFEST_PATH;
	// Env + override misses ALWAYS throw — the `required: false` knob
	// only suppresses walk-up-not-found, not "the user explicitly
	// pointed at a missing file." Silently falling back to walk-up on
	// a typo'd env var would steer callers at a stale ancestor manifest.
	if (envOverride !== undefined && envOverride !== '') {
		const resolved = resolve(envOverride);
		if (existsSync(resolved)) return resolved;
		throw new ManifestDiscoveryError({
			phase: 'env-missing',
			path: resolved,
			message:
				`[devstack] DEVSTACK_MANIFEST_PATH points at ${resolved}, but no file exists there. ` +
				`Unset the env var or run \`devstack up\` to write the manifest.`,
		});
	}
	if (opts.override !== undefined && opts.override !== '') {
		const resolved = resolve(opts.override);
		if (existsSync(resolved)) return resolved;
		throw new ManifestDiscoveryError({
			phase: 'override-missing',
			path: resolved,
			message:
				`[devstack] explicit manifest path ${resolved} does not exist. ` +
				`Run \`devstack up\` to write the manifest first.`,
		});
	}
	const startDir = opts.cwd ?? process.cwd();
	const { stack, stateDir } = resolveDiscoveryEnv(env, {
		...(opts.stack !== undefined ? { stack: opts.stack } : {}),
		...(opts.stateDir !== undefined ? { stateDir: opts.stateDir } : {}),
	});
	// An absolute `stateDir` / `DEVSTACK_RUNTIME_ROOT` pins the state
	// root, so the cwd walk-up is meaningless — `path.join` would also
	// drop the leading `dir` segment and mis-resolve the candidate.
	// Degenerate to a single existence check, mirroring
	// `discoverSingleStackManifestPath`.
	const candidates = isAbsolute(stateDir)
		? [join(stateDir, 'stacks', stack, 'manifest.json')]
		: (() => {
				const acc: string[] = [];
				let dir = resolve(startDir);
				while (true) {
					acc.push(join(dir, stateDir, 'stacks', stack, 'manifest.json'));
					const parent = dirname(dir);
					if (parent === dir) return acc;
					dir = parent;
				}
			})();
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	if (opts.required === true) {
		const expected = isAbsolute(stateDir)
			? join(stateDir, 'stacks', stack, 'manifest.json')
			: resolve(startDir, stateDir, 'stacks', stack, 'manifest.json');
		throw new ManifestDiscoveryError({
			phase: 'walk-up',
			path: expected,
			message:
				`[devstack] no manifest.json found walking up from ${startDir} ` +
				`(looked for ${stateDir}/stacks/${stack}/manifest.json at each level). ` +
				`Run \`devstack up\` — it writes the manifest at ${expected}.`,
		});
	}
	return undefined;
}

export interface DiscoverSingleStackManifestPathOptions {
	/** Starting directory for the walk-up. Defaults to `process.cwd()`. */
	readonly cwd?: string;
	/** State-dir name. Defaults to `.devstack`. Absolute paths are
	 *  honored — the walk-up degenerates into a single existence check
	 *  in that case. */
	readonly stateDir?: string;
}

/**
 * Walks up from `cwd` looking for a `<stateDir>` that contains EXACTLY
 * ONE stack subdirectory; returns that stack's `manifest.json` path.
 * Returns `null` when zero or >1 stacks are found at every ancestor.
 *
 * Used by integrations that need a no-explicit-stack auto-detect mode
 * (Playwright preset; future Vitest cold-start). The contract:
 *
 *   - At each ancestor, list `<ancestor>/<stateDir>/stacks/*`.
 *   - If exactly one stack dir with a `manifest.json` exists at that
 *     level: return its path. Stop walking.
 *   - If >1 stacks exist at that level: ambiguous → return `null` (do
 *     NOT continue walking past an ambiguous level).
 *   - If 0 stacks exist at that level: continue walking up.
 *   - If the filesystem root is reached without resolution: return
 *     `null`.
 *
 * Pure — does not consult env vars. Callers do their own gating (the
 * Playwright preset only invokes this when no explicit stack was
 * supplied via option or env).
 */
export const discoverSingleStackManifestPath = (
	options: DiscoverSingleStackManifestPathOptions = {},
): string | null => {
	const cwd = resolve(options.cwd ?? process.cwd());
	const stateDirName = options.stateDir ?? DEFAULT_STATE_DIR;
	const startDirs = isAbsolute(stateDirName)
		? [stateDirName]
		: (() => {
				const dirs: string[] = [];
				let dir = cwd;
				while (true) {
					dirs.push(join(dir, stateDirName));
					const parent = dirname(dir);
					if (parent === dir) return dirs;
					dir = parent;
				}
			})();

	for (const stateDir of startDirs) {
		const stacksDir = join(stateDir, 'stacks');
		if (!existsSync(stacksDir)) continue;
		const manifests = readdirSync(stacksDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(stacksDir, entry.name, 'manifest.json'))
			.filter((path) => existsSync(path))
			.sort();
		if (manifests.length === 1) return manifests[0]!;
		if (manifests.length > 1) return null;
	}
	return null;
};
