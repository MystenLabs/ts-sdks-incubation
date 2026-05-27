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

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { ManifestDiscoveryError } from './errors.ts';
import {
	DEFAULT_STACK_NAME,
	inferPackageNameFromCwd,
	readPackageName,
} from '../../api/inference-network.ts';

/** Default name of the supervisor's per-user state directory. Mirrors
 *  the L0 path resolver. Held here as a literal so the discover walk
 *  doesn't reach into the substrate package. */
export const DEFAULT_STATE_DIR = '.devstack';

/** Default stack name when neither `opts.stack` nor `$DEVSTACK_STACK`
 *  yields a useful value. */
export const DEFAULT_STACK = DEFAULT_STACK_NAME;

export const resolveBuildIntegrationStack = (
	explicit: string | undefined,
	env: Readonly<Record<string, string | undefined>> = process.env,
): string => {
	const selected = explicit ?? env.DEVSTACK_STACK;
	const trimmed = selected?.trim();
	return trimmed !== undefined && trimmed.length > 0 ? trimmed : DEFAULT_STACK;
};

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
	/** State-dir name. Defaults to `$DEVSTACK_STATE_DIR ?? '.devstack'`.
	 *  Absolute paths are honored — the walk-up degenerates into a
	 *  single existence check in that case. */
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

export interface BuildIntegrationIdentity {
	readonly app: string | undefined;
	readonly stack: string;
	readonly stateDir: string;
	readonly manifestPath: string;
}

export interface DiscoverBuildIntegrationIdentityOptions {
	/** Resolution cwd. Defaults to `process.cwd()`. */
	readonly cwd?: string;
	/** Explicit app name. Overrides env + package.json walk-up. */
	readonly app?: string;
	/** Explicit stack name. Overrides `DEVSTACK_STACK`; otherwise
	 *  defaults to `main`. */
	readonly stack?: string;
	/** Explicit state-dir name. Overrides `DEVSTACK_STATE_DIR`. */
	readonly stateDir?: string;
	/** Env bag for tests and config loaders. Defaults to `process.env`. */
	readonly env?: Readonly<Record<string, string | undefined>>;
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

/** Resolve the framework-neutral identity tuple build integrations
 *  need at config-load time. The manifest path is returned even when
 *  it does not exist yet so cold-start callers can still compute
 *  conventional URLs and watch-ignore paths. */
export const discoverBuildIntegrationIdentity = (
	options: DiscoverBuildIntegrationIdentityOptions = {},
): BuildIntegrationIdentity => {
	const env = options.env ?? (process.env as Readonly<Record<string, string | undefined>>);
	const cwd = options.cwd ?? process.cwd();
	const stack = resolveBuildIntegrationStack(options.stack, env);
	const stateDirName = options.stateDir ?? env.DEVSTACK_STATE_DIR ?? DEFAULT_STATE_DIR;

	const discovered = discoverManifestPath({ cwd, stack, stateDir: stateDirName, env });
	const manifestPath = discovered ?? resolve(cwd, stateDirName, 'stacks', stack, 'manifest.json');
	const stateDir =
		discovered !== undefined ? dirname(dirname(dirname(discovered))) : resolve(cwd, stateDirName);
	const app = options.app ?? env.DEVSTACK_APP ?? readAppNameWalkup(cwd);

	return { app, stack, stateDir, manifestPath };
};

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
	if (envOverride !== undefined && envOverride !== '') {
		const resolved = resolve(envOverride);
		if (existsSync(resolved)) return resolved;
		if (opts.required === true) {
			throw new ManifestDiscoveryError({
				phase: 'env-missing',
				path: resolved,
				message:
					`[devstack] DEVSTACK_MANIFEST_PATH points at ${resolved}, but no file exists there. ` +
					`Unset the env var or run \`devstack up\` to write the manifest.`,
			});
		}
		return undefined;
	}
	if (opts.override !== undefined && opts.override !== '') {
		const resolved = resolve(opts.override);
		if (existsSync(resolved)) return resolved;
		if (opts.required === true) {
			throw new ManifestDiscoveryError({
				phase: 'override-missing',
				path: resolved,
				message:
					`[devstack] explicit manifest path ${resolved} does not exist. ` +
					`Run \`devstack up\` to write the manifest first.`,
			});
		}
		return undefined;
	}
	const startDir = opts.cwd ?? process.cwd();
	const stack = resolveBuildIntegrationStack(opts.stack, env);
	const stateDir = opts.stateDir ?? env.DEVSTACK_STATE_DIR ?? DEFAULT_STATE_DIR;
	let dir = resolve(startDir);
	while (true) {
		const candidate = join(dir, stateDir, 'stacks', stack, 'manifest.json');
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	if (opts.required === true) {
		const expected = resolve(startDir, stateDir, 'stacks', stack, 'manifest.json');
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
