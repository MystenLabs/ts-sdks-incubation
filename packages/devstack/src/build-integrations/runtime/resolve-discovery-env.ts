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
// `DEVSTACK_MANIFEST_PATH` is deliberately NOT resolved here — it is a
// whole-path escape hatch handled inside `discoverManifestPath`
// (env-miss must throw, not fall through to the walk-up), so threading
// it through this stateDir/stack ladder would be the wrong layer.

/** Default state-dir / runtime-root name when neither an explicit
 *  option nor any env override is present. Mirrors `DEFAULT_STATE_DIR`
 *  in `discover.ts` (same literal `.devstack`). */
export const DEFAULT_DISCOVERY_STATE_DIR = '.devstack';

/** Default stack name when neither an explicit option nor
 *  `$DEVSTACK_STACK` yields a value. */
export const DEFAULT_DISCOVERY_STACK = 'main';

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
 * Precedence (highest → lowest), identical for both rungs:
 *   - stack:     `options.stack` > `$DEVSTACK_STACK` > `'main'`
 *   - stateDir:  `options.stateDir` > `$DEVSTACK_RUNTIME_ROOT`
 *                > `$DEVSTACK_STATE_DIR` > `'.devstack'`
 *
 * Empty-string env values are treated as unset (a blank
 * `DEVSTACK_STATE_DIR=` must not pin the state root to the cwd). Pure —
 * no `process.env` read; callers pass the bag (a fixture in tests).
 */
export const resolveDiscoveryEnv = (
	env: Readonly<Record<string, string | undefined>>,
	options: ResolveDiscoveryEnvOptions = {},
): ResolvedDiscoveryEnv => ({
	stack:
		firstNonEmpty(options.stack?.trim(), env[DISCOVERY_ENV.STACK]?.trim()) ??
		DEFAULT_DISCOVERY_STACK,
	stateDir:
		firstNonEmpty(
			options.stateDir,
			env[DISCOVERY_ENV.RUNTIME_ROOT],
			env[DISCOVERY_ENV.STATE_DIR],
		) ?? DEFAULT_DISCOVERY_STATE_DIR,
});
