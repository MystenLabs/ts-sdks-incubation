// Shared resolution of the active stack name across CLI subcommands.
//
// Precedence mirrors `engine/supervisor.ts:567`:
//   1. explicit `--stack <name>` flag (provided by the caller)
//   2. `DEVSTACK_STACK` env var
//   3. `<DEVSTACK_STATE_DIR>/active` file
//   4. fallback to `'main'`
//
// Without this consolidation, `stack.ts`, `snapshot.ts`, `wipe.ts`,
// `manifest.ts`, and `status.ts` each rolled their own copy — drift
// between them produced cross-stack surprises ("`DEVSTACK_STACK=foo
// devstack wipe` cleared `main`").

import { Effect, FileSystem, Option, Path } from 'effect';
import * as nodePath from 'node:path';

export const STATE_DIR_ENV = 'DEVSTACK_STATE_DIR';
export const STACK_NAME_ENV = 'DEVSTACK_STACK';
const DEFAULT_STATE_DIR = '.devstack';
const ACTIVE_FILE = 'active';
const DEFAULT_STACK = 'main';

/** Env-aware state-dir resolution. Reads `DEVSTACK_STATE_DIR` at call
 *  time so per-test or shell-wrapper overrides applied after module
 *  load take effect. */
export const stateDir = (): string => process.env[STATE_DIR_ENV] ?? DEFAULT_STATE_DIR;

// `resolveAppDir` + `APP_DIR_ENV` live in `engine/resolve-app-dir.ts`
// so engine-internal modules (state-store, service-paths, snapshot,
// docker inventory) don't have to import upward through `cli/`. The
// `cli/stack-resolution.ts` re-export keeps the historic import path
// working for CLI consumers.
import { APP_DIR_ENV as APP_DIR_ENV_RAW, resolveAppDir } from '../engine/resolve-app-dir.js';
export { resolveAppDir };
export const APP_DIR_ENV = APP_DIR_ENV_RAW;

/** Resolve the state directory using the canonical CLI precedence:
 *  explicit `--state-dir` override → `DEVSTACK_STATE_DIR` env →
 *  `<appDir>/.devstack`. Relative paths are resolved against `appDir`
 *  (defaults to `resolveAppDir()`); absolute paths are returned as-is.
 *  `appDir` itself is the caller's responsibility — most CLI commands
 *  compute it once at action entry and may want to reuse the same
 *  value across multiple resolutions. */
export const resolveStateDir = (args: {
	readonly override: Option.Option<string>;
	readonly appDir?: string;
}): string => {
	const appDir = args.appDir ?? resolveAppDir();
	const resolve = (raw: string): string =>
		nodePath.isAbsolute(raw) ? raw : nodePath.join(appDir, raw);
	if (Option.isSome(args.override)) return resolve(args.override.value);
	const env = process.env[STATE_DIR_ENV];
	if (env !== undefined && env.length > 0) return resolve(env);
	return nodePath.join(appDir, DEFAULT_STATE_DIR);
};

/** Read `<DEVSTACK_STATE_DIR>/active`, or `None` if missing/empty. */
export const readActiveStack = (
	fs: FileSystem.FileSystem,
	path: Path.Path,
): Effect.Effect<Option.Option<string>> =>
	Effect.gen(function* () {
		const activePath = path.join(stateDir(), ACTIVE_FILE);
		const exists = yield* fs.exists(activePath).pipe(Effect.orElseSucceed(() => false));
		if (!exists) return Option.none<string>();
		const txt = yield* fs.readFileString(activePath).pipe(Effect.orElseSucceed(() => ''));
		const trimmed = txt.trim();
		return trimmed.length === 0 ? Option.none<string>() : Option.some(trimmed);
	});

/** Resolve the active stack name from explicit override → env → active
 *  file → fallback. The optional `override` matches the `--stack` flag
 *  shape used by snapshot / stack / wipe. */
export const resolveStack = (
	fs: FileSystem.FileSystem,
	path: Path.Path,
	override: Option.Option<string>,
): Effect.Effect<string> =>
	Effect.gen(function* () {
		if (Option.isSome(override)) return override.value;
		const envStack = process.env[STACK_NAME_ENV];
		if (envStack !== undefined && envStack.length > 0) return envStack;
		const active = yield* readActiveStack(fs, path);
		return Option.getOrElse(active, () => DEFAULT_STACK);
	});

/** Env-only resolution — for callsites that don't have FileSystem in
 *  scope (e.g. `wipe.ts` resolving the default for its `--stack` flag).
 *  Precedence shrinks to: explicit override → env → `'main'`. */
export const resolveStackFromEnv = (override: string | undefined): string => {
	if (override !== undefined && override.length > 0) return override;
	const env = process.env[STACK_NAME_ENV];
	if (env !== undefined && env.length > 0) return env;
	return DEFAULT_STACK;
};

/** Per-stack fork data directory — `.devstack/stacks/<stack>/sui-fork/data/`.
 *  Mirrors `engine/sui-fork/meta.ts:resolveForkDataDir` but lives here so
 *  CLI subcommands (`devstack fork status`, `devstack fork cache list`,
 *  doctor's fork-data-dir size check) can resolve without depending on
 *  the engine surface.
 *
 *  Phase 4 P4.3 / P4.15 path layout. */
export const resolveForkDataDir = (args: { readonly stack: string }): string => {
	const stateRoot = resolveStateDir({ override: Option.none() });
	return nodePath.join(stateRoot, 'stacks', args.stack, 'sui-fork', 'data');
};

/** Per-stack fork meta path — `.devstack/stacks/<stack>/sui-fork/meta.json`.
 *  The CLI's fork subcommands + doctor read this for the static config-hash
 *  side; live runtime state (last checkpoint, clock) comes from the
 *  running container's gRPC. */
export const resolveForkMetaPath = (args: { readonly stack: string }): string => {
	const stateRoot = resolveStateDir({ override: Option.none() });
	return nodePath.join(stateRoot, 'stacks', args.stack, 'sui-fork', 'meta.json');
};

/** Shared upstream cache root — `.devstack/sui-fork-cache/`. Per-chainId
 *  subdirectories are written by the supervisor at acquire time. */
export const resolveForkCacheRoot = (): string => {
	const stateRoot = resolveStateDir({ override: Option.none() });
	return nodePath.join(stateRoot, 'sui-fork-cache');
};
