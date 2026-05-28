// Vitest build-integration — test-setup hooks.
//
// Architecture (distilled/23-build-integrations.md § Per-integration
// requirements → Vitest, § Lifecycle states): the preset itself does
// NOT boot devstack; it is the test file's job (via
// `@effect/vitest`'s `it.layer(stack.layer)`) to drive the lifecycle.
//
// But suites that talk to a LIVE devstack still need a small
// before/after surface to:
//   - Print a one-line advisory when `DEVSTACK_STACK` is unset (the
//     test would otherwise run against `main`, contending with
//     `pnpm dev`).
//   - Optionally verify the manifest is on disk before the first
//     `it.effect` fires (cheap probe, friendly error).
//   - Optionally project the manifest into a shared fixture handle
//     suites can `import { stackContext } from './setup-fixture.ts'`.
//
// This module is OPT-IN. A suite wires it via Vitest's `setupFiles`
// (or via the `useTestSetup` registrar below for programmatic
// composition). The preset wires it automatically when
// `opts.testSetup` is truthy.
//
// Hook firing order:
//   beforeAll  (once per file)
//     1. resolveVitestEnv → print stack/runtimeRoot advisory if needed
//     2. if requireDevstack: loadStackContext({required: true})
//        else:               loadStackContext() (may be undefined)
//     3. publish to the captured fixture so `getStackContext()` works
//        synchronously inside `it`/`test` bodies
//   afterAll   (once per file)
//     4. clear the captured fixture (so a stale handle doesn't survive
//        between watch runs)
//
// No teardown of the devstack itself — that's the supervisor's job;
// the preset is a pure reader.

import { expect } from 'vitest';

import {
	loadStackContext,
	type LoadStackContextOptions,
	type StackContext,
} from './stack-context.ts';
import { resolveVitestEnv, VITEST_ENV_VARS, RECOMMENDED_TEST_STACK } from './env.ts';
import { VitestSetupPreconditionError } from './errors.ts';

// -----------------------------------------------------------------------------
// Captured fixture — per-test-file handle
// -----------------------------------------------------------------------------
//
// Vitest workers reuse a single module-level binding across the test
// files they run. A bare `let captured` would carry a stale fixture from
// the prior file into a later file that forgot `useDevstackTestSetup`,
// silently steering `getStackContext()` at the wrong stack. Key by the
// vitest test path so each file gets its own slot.

const UNKNOWN_TEST_PATH_SENTINEL = '<unknown>';

// `expect.getState().testPath` is undefined outside an `it`/`test` body
// (e.g. in module-init or top-level `beforeAll` before vitest binds the
// per-file state). Reads in that window fall through the sentinel and
// still resolve so the pre-test-file setup path stays usable.
const currentTestPath = (): string => expect.getState().testPath ?? UNKNOWN_TEST_PATH_SENTINEL;

const capturedByPath = new Map<string, StackContext | undefined>();

/** Return the StackContext captured by `runDevstackBeforeAll`. Returns
 *  `undefined` until `beforeAll` has run (or when the suite ran with
 *  `requireDevstack: false` and no manifest exists). */
export const getStackContext = (): StackContext | undefined =>
	capturedByPath.get(currentTestPath());

/** Reset the captured fixture. Called by `runDevstackAfterAll`; also
 *  exported so test helpers can wipe between describe-block setups. */
export const clearStackContext = (): void => {
	capturedByPath.delete(currentTestPath());
};

// -----------------------------------------------------------------------------
// Options
// -----------------------------------------------------------------------------

export interface TestSetupOptions extends LoadStackContextOptions {
	/** When `true`, `beforeAll` throws if no manifest is on disk. Use
	 *  for suites that depend on a live devstack and would fail
	 *  confusingly later. Default `false` (manifest is best-effort). */
	readonly requireDevstack?: boolean;
	/** Suppress the stack-name advisory. Default `false`. */
	readonly silent?: boolean;
	/** Custom writer for the advisory line. Defaults to a stderr
	 *  writer (`process.stderr.write(line + '\n')`) — matches the
	 *  build-integration surface IO discipline (no `console.*` in
	 *  production paths). Tests substitute a buffer. */
	readonly writeAdvisory?: (line: string) => void;
}

// -----------------------------------------------------------------------------
// Hooks
// -----------------------------------------------------------------------------

/** `beforeAll` body. Exported as a plain function so callers can wire
 *  it into Vitest's hooks directly OR call it inline from a
 *  setup-file. */
export const runDevstackBeforeAll = (options: TestSetupOptions = {}): void => {
	const env = options.env ?? (process.env as Readonly<Record<string, string | undefined>>);
	const resolved = resolveVitestEnv(env);

	if (!options.silent && !resolved.stackWasExplicit) {
		const write =
			options.writeAdvisory ?? ((line: string) => void process.stderr.write(`${line}\n`));
		write(
			`[devstack/vitest] ${VITEST_ENV_VARS.STACK} is unset; tests will read the '${resolved.stack}' stack. ` +
				`Set ${VITEST_ENV_VARS.STACK}=${RECOMMENDED_TEST_STACK} in the test script to avoid contention with \`pnpm dev\`.`,
		);
	}

	const ctx = loadStackContext({
		...options,
		required: options.requireDevstack === true,
	});

	if (options.requireDevstack === true && ctx === undefined) {
		// `loadStackContext({required: true})` should have thrown.
		// Defensive — surfaces a clearer error if a future refactor
		// changes the required-miss semantics.
		throw new VitestSetupPreconditionError({
			message: `requireDevstack: true but loadStackContext returned undefined`,
			hint: 'this is a devstack bug; please file an issue',
		});
	}

	capturedByPath.set(currentTestPath(), ctx);
};

/** `afterAll` body. Currently just clears the captured fixture; the
 *  separate symbol lets us extend later (e.g. snapshot diagnostics)
 *  without touching consumer setup files. */
export const runDevstackAfterAll = (): void => {
	clearStackContext();
};

// -----------------------------------------------------------------------------
// Vitest hook registrar
// -----------------------------------------------------------------------------

/** Vitest's `beforeAll` / `afterAll` hook signatures. Match the
 *  `vitest`-package shapes without importing the module (so this file
 *  stays consumable by orchestrators that don't ship vitest as a
 *  hard dep). */
export interface VitestLifecycleHooks {
	readonly beforeAll: (fn: () => void | Promise<void>) => void;
	readonly afterAll: (fn: () => void | Promise<void>) => void;
}

/**
 * Wire the devstack setup/teardown into a vitest test file's hook
 * functions. Typical usage in a `test-setup.ts`:
 *
 *     import { beforeAll, afterAll } from 'vitest';
 *     import { useDevstackTestSetup }
 *       from '@mysten-incubation/devstack/vitest';
 *
 *     useDevstackTestSetup({ beforeAll, afterAll }, { requireDevstack: true });
 *
 * The preset wires this automatically when `opts.testSetup: true`.
 */
export const useDevstackTestSetup = (
	hooks: VitestLifecycleHooks,
	options: TestSetupOptions = {},
): void => {
	hooks.beforeAll(() => runDevstackBeforeAll(options));
	hooks.afterAll(() => runDevstackAfterAll());
};
