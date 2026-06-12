// Shared discovery env-ladder resolver.
//
// ONE place that turns (caller options + env bag) into the resolved
// `{ stack, stateDir }` tuple every build integration discovers a
// manifest with. Before this existed the ladder was copy-pasted in
// `discover.ts`, the vitest loader, the playwright stack-context, and
// the playwright global-setup single-stack fallback — and the two
// playwright sites had drifted: they read only `DEVSTACK_STATE_DIR`
// and silently ignored `DEVSTACK_RUNTIME_ROOT`. Consolidating here
// makes that omission impossible and matches STYLE_GUIDE §7: "L5 build
// integrations use `build-integrations/runtime/` as the canonical
// substrate; per-integration reimplementations of manifest discovery
// consolidate there."
//
// The stack ladder mirrors the CLI's `resolveStackName`
// (`api/inference-network.ts`): explicit > `$DEVSTACK_STACK` > nearest
// package.json `name` > `'main'`. The package-name rung is opt-in via
// `options.cwd` and exists because `devstack up` in a bare app (no
// `stackName` in config, no env) names the stack after the package —
// a discovery ladder that hard-defaulted to `'main'` would look for a
// manifest the supervisor never wrote, so `pnpm test` (vitest loader),
// the playwright stack-context, and the vite plugin's cold start all
// missed a live stack.
//
// `DEVSTACK_MANIFEST_PATH` is deliberately NOT resolved here — it is a
// whole-path escape hatch handled inside `discoverManifestPath`
// (env-miss must throw, not fall through to the walk-up), so threading
// it through this stateDir/stack ladder would be the wrong layer.

import { DEFAULT_STACK_NAME, inferPackageNameFromCwd } from '../../api/inference-network.ts';

/** Default state-dir / runtime-root name when neither an explicit
 *  option nor any env override is present. Mirrors `DEFAULT_STATE_DIR`
 *  in `discover.ts` (same literal `.devstack`). */
export const DEFAULT_DISCOVERY_STATE_DIR = '.devstack';

/** Default stack name when neither an explicit option, `$DEVSTACK_STACK`,
 *  nor the (opt-in) package-name rung yields a value. Re-export of the
 *  CLI resolver's `DEFAULT_STACK_NAME` literal — the literal lives in
 *  `inference-network.ts` because this module imports its inference
 *  helper (see the module-cycle note there). */
export const DEFAULT_DISCOVERY_STACK = DEFAULT_STACK_NAME;

/** Env-var names the discovery ladder consults for the stack +
 *  state-dir rungs. `MANIFEST_PATH` lives here for documentation parity
 *  with the integration env tables but is resolved by
 *  `discoverManifestPath`, not this ladder. */
export const DISCOVERY_ENV = {
	STACK: 'DEVSTACK_STACK',
	RUNTIME_ROOT: 'DEVSTACK_RUNTIME_ROOT',
	/** Legacy alias for `RUNTIME_ROOT`; lower precedence. */
	STATE_DIR: 'DEVSTACK_STATE_DIR',
	MANIFEST_PATH: 'DEVSTACK_MANIFEST_PATH',
} as const;

export interface ResolveDiscoveryEnvOptions {
	/** Explicit stack name. Wins over `$DEVSTACK_STACK`. */
	readonly stack?: string;
	/** Explicit state-dir / runtime-root. Wins over both env vars. */
	readonly stateDir?: string;
	/** Walk-up start for the package-name rung of the stack ladder,
	 *  mirroring the CLI's `resolveStackName`. Opt-in: omit it and the
	 *  resolver stays side-effect-free (no fs reads). When provided,
	 *  the `package.json` walk-up runs LAZILY — only when both the
	 *  explicit and `$DEVSTACK_STACK` rungs miss. */
	readonly cwd?: string;
}

export interface ResolvedDiscoveryEnv {
	/** Resolved stack name (never empty). */
	readonly stack: string;
	/** Resolved state-dir / runtime-root (never empty). May be absolute
	 *  — `discoverManifestPath` degenerates the walk-up to a single
	 *  existence check in that case. */
	readonly stateDir: string;
}

const firstNonEmpty = (...candidates: ReadonlyArray<string | undefined>): string | undefined => {
	for (const candidate of candidates) {
		if (candidate !== undefined && candidate !== '') return candidate;
	}
	return undefined;
};

/**
 * Resolve the canonical stack + state-dir ladder.
 *
 * Precedence (highest → lowest):
 *   - stack:     `options.stack` > `$DEVSTACK_STACK`
 *                > nearest package.json `name` above `options.cwd`
 *                  (rung skipped when `cwd` is omitted)
 *                > `'main'`
 *   - stateDir:  `options.stateDir` > `$DEVSTACK_RUNTIME_ROOT`
 *                > `$DEVSTACK_STATE_DIR` > `'.devstack'`
 *
 * The stack ladder matches the CLI's `resolveStackName`, so discovery
 * agrees with `devstack up` about which stack a bare app runs (see the
 * module header). Empty-string env values are treated as unset (a blank
 * `DEVSTACK_STATE_DIR=` must not pin the state root to the cwd). No
 * `process.env` read — callers pass the bag (a fixture in tests) — and
 * no fs access unless `options.cwd` is provided AND the first two stack
 * rungs miss (the package.json walk-up is lazy).
 */
export const resolveDiscoveryEnv = (
	env: Readonly<Record<string, string | undefined>>,
	options: ResolveDiscoveryEnvOptions = {},
): ResolvedDiscoveryEnv => {
	const stackFromInputs = firstNonEmpty(options.stack?.trim(), env[DISCOVERY_ENV.STACK]?.trim());
	return {
		stack:
			stackFromInputs ??
			(options.cwd !== undefined ? inferPackageNameFromCwd(options.cwd) : undefined) ??
			DEFAULT_DISCOVERY_STACK,
		stateDir:
			firstNonEmpty(
				options.stateDir,
				env[DISCOVERY_ENV.RUNTIME_ROOT],
				env[DISCOVERY_ENV.STATE_DIR],
			) ?? DEFAULT_DISCOVERY_STATE_DIR,
	};
};
