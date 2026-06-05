// Vitest build-integration config helpers.
//
// Architecture (distilled/23-build-integrations.md § Per-integration
// requirements → Vitest, § Outputs / capabilities, § Invariants):
//   - Canonical include/exclude: src globs in, e2e/dist/node_modules
//     out (`e2e/**` runs through the Playwright integration).
//   - `passWithNoTests: true` so codegen-derived stacks without unit
//     tests yet don't fail CI.
//   - `@effect/vitest` is declared as an optional peer — the preset
//     itself does not import it. Suites using `it.layer(stack.layer)`
//     bring it in directly.
//   - No-restart on harmless changes: watch ignores `<runtimeRoot>/**`
//     so the ~500ms manifest tick doesn't trigger a reload loop.
//
// Optional knobs:
//   - `testSetup: true | TestSetupOptions` wires the devstack
//     setup file (`./setup.ts`) automatically via `test.setupFiles`.
//   - `typecheck: true` opts INTO vitest's typecheck pass (off by
//     default — apps typically run `tsc` separately).
//   - `threads: 'single' | 'multi'` picks `pool: 'threads'` and toggles
//     `fileParallelism` (vitest 4 uses a top-level
//     `fileParallelism: false`) for stack-shared-state suites that
//     can't safely parallelize.
//   - Caller-provided `test` fields win over the preset's defaults.
//
// No I/O happens at config-build time (per architecture § Lifecycle
// states: vitest preset call is synchronous + side-effect free).

import type { ViteUserConfig } from 'vitest/config';

import type { TestSetupOptions } from './setup.ts';

// -----------------------------------------------------------------------------
// Public options
// -----------------------------------------------------------------------------

export interface DevstackVitestTestConfigOptions {
	/** Extra `test` fields. Caller-provided keys win over the preset's
	 *  defaults; the preset's include/exclude/passWithNoTests are the
	 *  start, the caller's fields are merged shallowly. */
	readonly test?: NonNullable<ViteUserConfig['test']>;
	/** Wire the devstack `beforeAll` / `afterAll` setup file. `true`
	 *  uses defaults; an options object configures the captured
	 *  fixture (e.g. `{ requireDevstack: true }`). Default: not wired. */
	readonly testSetup?: boolean | TestSetupOptions;
	/** Enable vitest's typecheck pass. Default `false` — most apps
	 *  run `tsc` outside vitest. */
	readonly typecheck?: boolean;
	/** Threading mode. `'single'` forces a single thread (needed when
	 *  tests share devstack state); `'multi'` keeps vitest's default
	 *  worker pool. Default: vitest default (`undefined`). */
	readonly threads?: 'single' | 'multi';
	/** Absolute path to a user-authored setup file. When set, it is
	 *  appended to `test.setupFiles` AFTER the devstack setup file (so
	 *  the user file sees the captured StackContext via
	 *  `getStackContext()`). */
	readonly setupFile?: string;
}

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

/** Path to the bundled devstack setup file. The preset injects this
 *  via `test.setupFiles` when `opts.testSetup` is truthy. The literal
 *  string is the module's import specifier so vitest resolves it like
 *  any other npm package; an apps-level resolver finds it via the
 *  package's `./vitest/setup` subpath (added to package.json
 *  `exports` alongside the integration). */
const DEVSTACK_SETUP_MODULE = '@mysten-incubation/devstack/vitest/setup';

/** Runtime-root prefix the watcher MUST ignore — per architecture §
 *  Invariants → "No-restart on harmless changes". The 500ms manifest
 *  tick would otherwise re-trigger reloads. */
const WATCH_IGNORED_PATTERNS = ['**/.devstack/**', '**/node_modules/**', '**/dist/**'];

// -----------------------------------------------------------------------------
// Public surface
// -----------------------------------------------------------------------------

/**
 * Build the devstack-owned part of Vitest's `test` block. Apps keep a
 * normal `defineConfig(...)` call and compose this value into it:
 *
 *     import { defineConfig } from 'vitest/config';
 *     import { devstackVitestServerConfig, devstackVitestTestConfig }
 *       from '@mysten-incubation/devstack/vitest';
 *
 *     export default defineConfig({
 *       server: devstackVitestServerConfig(),
 *       test: devstackVitestTestConfig(),
 *     });
 *
 * For chain-mode integration tests against a real devstack, build a
 * devstack handle and pass `handle.layer` to `@effect/vitest`'s
 * `it.layer(...)` directly. This helper does not boot devstack — the
 * test file owns its lifecycle.
 *
 * For suites that need a shared StackContext fixture (manifest read
 * once per file), opt into the setup file:
 *
 *     test: devstackVitestTestConfig({
 *       testSetup: { requireDevstack: true },
 *     })
 *
 * The setup file's `beforeAll` populates a captured fixture readable
 * via `getStackContext()` from inside `it`/`test` bodies.
 */
export const devstackVitestTestConfig = (
	options: DevstackVitestTestConfigOptions = {},
): NonNullable<ViteUserConfig['test']> => {
	const setupFiles: Array<string> = [];
	if (options.testSetup) {
		setupFiles.push(DEVSTACK_SETUP_MODULE);
	}
	if (options.setupFile !== undefined) {
		setupFiles.push(options.setupFile);
	}

	// Vitest 4 removed `poolOptions.threads.singleThread`. Top-level
	// `fileParallelism: false` is the replacement for single-threaded
	// runs (also pins `maxWorkers` to 1 per vitest's docs). Both
	// branches set `pool: 'threads'` explicitly so we don't depend on
	// vitest's default pool (which is `forks` in v4).
	const threadOverride =
		options.threads === 'single'
			? { pool: 'threads' as const, fileParallelism: false }
			: options.threads === 'multi'
				? { pool: 'threads' as const, fileParallelism: true }
				: {};

	const typecheckOverride = options.typecheck === true ? { typecheck: { enabled: true } } : {};

	return {
		include: ['src/**/*.{test,spec}.ts?(x)', 'test/**/*.{test,spec}.ts?(x)'],
		exclude: ['e2e/**', 'node_modules', 'dist', '.turbo', '**/.devstack/**'],
		passWithNoTests: true,
		...(setupFiles.length > 0 ? { setupFiles } : {}),
		...threadOverride,
		...typecheckOverride,
		// Caller overrides last. Shallow merge.
		...options.test,
	};
};

/** Build the devstack-owned part of Vitest's Vite server config.
 *  Callers that need additional server options should merge them in
 *  their own `defineConfig(...)` file. */
export const devstackVitestServerConfig = (): NonNullable<ViteUserConfig['server']> => ({
	watch: {
		// vite's chokidar watcher honors `ignored` even in test mode.
		ignored: WATCH_IGNORED_PATTERNS,
	},
});

// -----------------------------------------------------------------------------
// Test-visible internals (do not re-export from the integration barrel)
// -----------------------------------------------------------------------------

/** @internal — used by `test/build-integrations/vitest/config.test.ts`
 *  to assert the watcher ignored set without depending on a built
 *  config snapshot. */
export const _internal = {
	DEVSTACK_SETUP_MODULE,
	WATCH_IGNORED_PATTERNS,
} as const;
