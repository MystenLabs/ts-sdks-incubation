// `resolveAppDir()` — the canonical "where does the user's devstack
// app live?" resolver. Reads `DEVSTACK_APP_DIR` at call time so
// per-test or shell-wrapper overrides applied AFTER module load take
// effect (matters for vitest's per-test `process.env` mutation pattern
// and for CLI subcommands launched from a different directory).
//
// Eleven call sites used to inline `process.env.DEVSTACK_APP_DIR ??
// process.cwd()` — the helper centralizes the precedence so a future
// change (e.g. honoring `--app-dir` on the CLI) has one site to flip.

/** Env var that overrides the auto-detected app directory. */
export const APP_DIR_ENV = 'DEVSTACK_APP_DIR';

/** Resolve the app dir from `DEVSTACK_APP_DIR` or `process.cwd()`. */
export const resolveAppDir = (): string => process.env[APP_DIR_ENV] ?? process.cwd();
