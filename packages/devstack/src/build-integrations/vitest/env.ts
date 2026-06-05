// Vitest build-integration — env-var contract.
//
// Architecture (distilled/23-build-integrations.md § Inputs /
// dependencies, distilled/24-examples.md § Lifecycle / invocation
// patterns): test runs MUST set `DEVSTACK_STACK=test` so they don't
// contend with a parallel `pnpm dev` on the `main` stack. The
// supervisor's port allocator + manifest discovery key off this var
// to keep two stacks coexisting.
//
// `DEVSTACK_RUNTIME_ROOT` is the optional override for the on-disk
// state root that contains `stacks/<stack>/manifest.json`.
//
// `DEVSTACK_MANIFEST_PATH` is the top-of-the-precedence-ladder escape
// hatch the engine writes; build integrations also honor it. Listed
// here for completeness — the typical vitest run does not set it.
//
// NOTE: this module is a pure declaration of names + defaults. No env
// reads happen at module import time; readers fetch on demand so
// tests can stub `process.env` per-case.

import { DEFAULT_DISCOVERY_STACK } from '../runtime/resolve-discovery-env.ts';

// -----------------------------------------------------------------------------
// Canonical env-var names
// -----------------------------------------------------------------------------

/** Env-var names the vitest integration consults. Centralized so
 *  test-setup printouts can name the var the caller forgot to set. */
export const VITEST_ENV_VARS = {
	/** Stack name; the canonical signal for "isolate this test run
	 *  from other stacks". Tests SHOULD set this to `'test'`. */
	STACK: 'DEVSTACK_STACK',
	/** Override for the runtime root that holds
	 *  `stacks/<stack>/manifest.json`. Defaults to `.devstack`. */
	RUNTIME_ROOT: 'DEVSTACK_RUNTIME_ROOT',
	/** Alias for `RUNTIME_ROOT`. New callers should use `RUNTIME_ROOT`. */
	RUNTIME_ROOT_LEGACY: 'DEVSTACK_STATE_DIR',
	/** Top-precedence absolute path to a specific manifest file. The
	 *  engine sets this when it spawns child processes; rarely set
	 *  by hand. */
	MANIFEST_PATH: 'DEVSTACK_MANIFEST_PATH',
} as const;

export type VitestEnvVarName = (typeof VITEST_ENV_VARS)[keyof typeof VITEST_ENV_VARS];

// -----------------------------------------------------------------------------
// Defaults
// -----------------------------------------------------------------------------

/** Default stack name when `DEVSTACK_STACK` is unset. Re-exported from
 *  the discovery ladder's `DEFAULT_DISCOVERY_STACK` (single source of
 *  truth) — but tests should explicitly set `DEVSTACK_STACK=test`
 *  rather than rely on this. */
export const DEFAULT_STACK_NAME = DEFAULT_DISCOVERY_STACK;

/** Default runtime root when no runtime-root override is set. */
export const DEFAULT_RUNTIME_ROOT = '.devstack';

/** The recommended stack name for test runs — the value the
 *  `test`-script env should set. Exported as a constant so example
 *  apps' `package.json` can wire it from one symbol if a future
 *  scaffolder lands. */
export const RECOMMENDED_TEST_STACK = 'test';

// -----------------------------------------------------------------------------
// Pure resolvers — no module-init side effects
// -----------------------------------------------------------------------------

export interface ResolvedVitestEnv {
	readonly stack: string;
	readonly runtimeRoot: string;
	readonly manifestPathOverride: string | undefined;
	/** True when the caller's env explicitly set `DEVSTACK_STACK`. The
	 *  test-setup hook uses this to print a louder advisory when a
	 *  user runs `pnpm test` without the recommended wiring. */
	readonly stackWasExplicit: boolean;
}

/** Resolve the vitest env contract from an arbitrary env bag.
 *  Side-effect free — tests pass a fixture; production code passes
 *  `process.env`. */
export const resolveVitestEnv = (
	env: Readonly<Record<string, string | undefined>>,
): ResolvedVitestEnv => {
	const stackRaw = env[VITEST_ENV_VARS.STACK];
	const stack = stackRaw !== undefined && stackRaw !== '' ? stackRaw : DEFAULT_STACK_NAME;
	const runtimeRoot =
		env[VITEST_ENV_VARS.RUNTIME_ROOT] ??
		env[VITEST_ENV_VARS.RUNTIME_ROOT_LEGACY] ??
		DEFAULT_RUNTIME_ROOT;
	const manifestPathOverride = env[VITEST_ENV_VARS.MANIFEST_PATH];
	return {
		stack,
		runtimeRoot: runtimeRoot === '' ? DEFAULT_RUNTIME_ROOT : runtimeRoot,
		manifestPathOverride:
			manifestPathOverride !== undefined && manifestPathOverride !== ''
				? manifestPathOverride
				: undefined,
		stackWasExplicit: stackRaw !== undefined && stackRaw !== '',
	};
};
