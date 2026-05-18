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

export const STATE_DIR_ENV = 'DEVSTACK_STATE_DIR';
export const STACK_NAME_ENV = 'DEVSTACK_STACK';
const DEFAULT_STATE_DIR = '.devstack';
const ACTIVE_FILE = 'active';
const DEFAULT_STACK = 'main';

/** Env-aware state-dir resolution. Reads `DEVSTACK_STATE_DIR` at call
 *  time so per-test or shell-wrapper overrides applied after module
 *  load take effect. */
export const stateDir = (): string => process.env[STATE_DIR_ENV] ?? DEFAULT_STATE_DIR;

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
