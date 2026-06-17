// Vitest `globalSetup` that boots a dedicated `test` stack for the run
// and tears it down on completion.
//
// Why this exists (distilled/23-build-integrations.md § Vitest): the
// per-file `setup.ts` preset is a passive manifest READER — it requires
// a stack someone already started. This module is the missing boot seam:
// `pnpm test` brings up its OWN isolated `test` stack so tests run in
// parallel to a developer's `pnpm dev` (`main`) stack without contending
// for ports / faucet / wallet, and without requiring the dev stack to be
// up at all.
//
// Lifecycle (the locked design — "boot fresh + teardown each run"):
//   setup    → load config, runStack(identity.stack='test'), await ready
//   handoff  → publish env (DEVSTACK_STACK + DEVSTACK_MANIFEST_PATH) so the
//              per-file workers' `loadStackContext` resolves THIS stack
//   teardown → stop + awaitShutdown (robust: still tears down a half-booted
//              stack so no `devstack.stack=test` containers leak)
//
// Escape hatch (reuse an already-running stack — e.g. your dev stack):
//   set `DEVSTACK_TEST_REUSE=1` (and optionally point `DEVSTACK_STACK` at
//   the running stack), or pass `{ reuse: true }`. Reuse mode does NOT
//   boot and does NOT tear down — it only publishes the env handoff to the
//   existing manifest.
//
// CRITICAL: vitest runs `globalSetup` in a SEPARATE process from the test
// workers, so the handoff is via `process.env` (which vitest forwards to
// workers), NOT an in-memory stash. We reuse the existing
// `DEVSTACK_MANIFEST_PATH` top-precedence rung (`env.ts`) that the engine
// already uses when it spawns child processes.
//
// This module imports only the CLI-free `api/` surface (`runStack`,
// `loadDevstackConfig`) so the vitest entrypoint never pulls the CLI/TUI
// graph into its bundle.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Effect } from 'effect';

import { loadDevstackConfig } from '../../api/load-config.ts';
import { runStack, type RunHandle } from '../../api/run-stack.ts';
import { DEFAULT_RUNTIME_ROOT, RECOMMENDED_TEST_STACK, VITEST_ENV_VARS } from './env.ts';
import { loadStackContext } from './stack-context.ts';

export interface DevstackVitestGlobalSetupOptions {
	/** Stack name to boot. Default: `DEVSTACK_STACK` if set, else
	 *  `RECOMMENDED_TEST_STACK` (`'test'`). The booted identity forces
	 *  this stack, so it coexists with a developer's `main` dev stack. */
	readonly stack?: string;
	/** Path to the app's `devstack.config.ts`. Default: walk-up from cwd. */
	readonly configPath?: string;
	/** Runtime root holding `stacks/<stack>/manifest.json`. Default:
	 *  `DEVSTACK_RUNTIME_ROOT` / `DEVSTACK_STATE_DIR` / `.devstack`. */
	readonly runtimeRoot?: string;
	/** Reuse an already-running stack instead of booting a fresh one (no
	 *  boot, no teardown). Default: `false` — also enabled by
	 *  `DEVSTACK_TEST_REUSE=1`. */
	readonly reuse?: boolean;
	/** Hard cap (ms) for the stack to reach ready. Default 300_000 (5 min)
	 *  — accounts for cold supervisor boot under Docker image pulls. */
	readonly bootTimeoutMs?: number;
}

/** Vitest's `globalSetup` contract: a setup function that optionally
 *  returns a teardown function. */
export type DevstackVitestGlobalSetup = () => Promise<() => Promise<void>>;

const DEFAULT_BOOT_TIMEOUT_MS = 300_000;

const isTruthyEnv = (value: string | undefined): boolean =>
	value === '1' || value === 'true' || value === 'yes';

const resolveRuntimeRoot = (
	opts: DevstackVitestGlobalSetupOptions,
	env: NodeJS.ProcessEnv,
): string =>
	opts.runtimeRoot ??
	(env[VITEST_ENV_VARS.RUNTIME_ROOT] || env[VITEST_ENV_VARS.RUNTIME_ROOT_LEGACY] || undefined) ??
	DEFAULT_RUNTIME_ROOT;

const resolveStackName = (
	opts: DevstackVitestGlobalSetupOptions,
	env: NodeJS.ProcessEnv,
): string => {
	const fromEnv = env[VITEST_ENV_VARS.STACK];
	return opts.stack ?? (fromEnv && fromEnv !== '' ? fromEnv : RECOMMENDED_TEST_STACK);
};

const withTimeout = async <A>(promise: Promise<A>, ms: number, label: string): Promise<A> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
};

const safeStop = async (handle: RunHandle): Promise<void> => {
	try {
		await Effect.runPromise(handle.stop);
	} catch {
		// best-effort — fall through to awaitShutdown
	}
	try {
		await Effect.runPromise(handle.awaitShutdown);
	} catch {
		// supervisor may have already exited; nothing more to do
	}
};

/** After the in-process supervisor has exited, graceful shutdown only
 *  STOPS the stack's containers (devstack keeps them for warm restarts).
 *  An ephemeral test stack should leave nothing behind, so run the
 *  production `devstack wipe` verb (force-removes containers + networks +
 *  volumes + per-stack on-disk state) for the booted stack. Best-effort:
 *  failure here never fails the test run, and a leftover stopped stack is
 *  force-recreated by the next boot anyway. Skip with `DEVSTACK_TEST_KEEP=1`
 *  to leave the stack up for debugging. */
const wipeStack = (stack: string, runtimeRoot: string, cwd: string): Promise<void> =>
	new Promise((resolve) => {
		// The CLI entry ships beside this module in the built package:
		// dist/build-integrations/vitest/global-setup.mjs → dist/cli/main.mjs.
		const cliEntry = fileURLToPath(new URL('../../cli/main.mjs', import.meta.url));
		if (!existsSync(cliEntry)) {
			resolve();
			return;
		}
		const child = spawn(process.execPath, [cliEntry, 'wipe', '--yes'], {
			cwd,
			env: { ...process.env, DEVSTACK_STACK: stack, DEVSTACK_RUNTIME_ROOT: runtimeRoot },
			stdio: 'ignore',
		});
		const done = () => resolve();
		child.on('error', done);
		child.on('exit', done);
		const timer = setTimeout(() => {
			child.kill();
			resolve();
		}, 120_000);
		timer.unref?.();
	});

/** Publish the env handoff vitest forwards to test workers, so per-file
 *  `getStackContext()` resolves the stack this setup booted/attached. */
const publishHandoff = (stack: string, runtimeRoot: string, manifestPath: string): void => {
	process.env[VITEST_ENV_VARS.STACK] = stack;
	process.env[VITEST_ENV_VARS.RUNTIME_ROOT] = runtimeRoot;
	process.env[VITEST_ENV_VARS.MANIFEST_PATH] = manifestPath;
};

/**
 * Build a vitest `globalSetup` that boots (or reuses) a dedicated test
 * stack. Wire it via `devstackVitestTestConfig({ autoBoot: true })`, or
 * reference the module path directly in `test.globalSetup`.
 */
export const devstackVitestGlobalSetup =
	(opts: DevstackVitestGlobalSetupOptions = {}): DevstackVitestGlobalSetup =>
	async () => {
		const env = process.env;
		const stack = resolveStackName(opts, env);
		const runtimeRoot = resolveRuntimeRoot(opts, env);
		const reuse = opts.reuse ?? isTruthyEnv(env.DEVSTACK_TEST_REUSE);

		// Reuse path: attach to an already-running stack. No boot, no teardown.
		if (reuse) {
			const ctx = loadStackContext({ stack, runtimeRoot, required: true });
			// `required: true` throws VitestManifestNotFoundError on miss.
			publishHandoff(stack, runtimeRoot, ctx!.manifestPath);
			return async () => {};
		}

		// Fresh boot (default). Load the app's stack the same way the CLI does.
		const loaded = await Effect.runPromise(loadDevstackConfig(opts.configPath)).catch((cause) => {
			throw new Error(
				`devstack autoBoot: failed to load devstack config — ${cause instanceof Error ? cause.message : String(cause)}`,
				{ cause },
			);
		});

		const handle = runStack(loaded.stack, {
			identity: { stack },
			appRoot: dirname(loaded.resolvedConfigPath),
			runtimeRoot,
			...(loaded.engine.options.codegen !== undefined
				? { codegen: loaded.engine.options.codegen }
				: {}),
		});

		try {
			await withTimeout(
				Effect.runPromise(handle.start),
				opts.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS,
				`devstack autoBoot: '${stack}' stack boot`,
			);
		} catch (cause) {
			await safeStop(handle);
			throw new Error(
				`devstack autoBoot: failed to boot the '${stack}' stack. ` +
					`If a '${stack}' stack is already running, stop it with \`devstack down ${stack}\` ` +
					`or set DEVSTACK_TEST_REUSE=1 to run tests against it. ` +
					`Cause: ${cause instanceof Error ? cause.message : String(cause)}`,
				{ cause },
			);
		}

		// Resolve the freshly-written manifest the workers will read.
		const ctx = loadStackContext({
			cwd: dirname(loaded.resolvedConfigPath),
			stack,
			runtimeRoot,
			required: true,
		});
		publishHandoff(stack, runtimeRoot, ctx!.manifestPath);

		const keep = isTruthyEnv(env.DEVSTACK_TEST_KEEP);
		return async () => {
			await safeStop(handle);
			if (!keep) {
				await wipeStack(stack, runtimeRoot, dirname(loaded.resolvedConfigPath));
			}
		};
	};

/** Default export = a ready-to-use vitest `globalSetup`. This is what
 *  `test.globalSetup: '@mysten-incubation/devstack/vitest/global-setup'`
 *  resolves to. */
export default devstackVitestGlobalSetup();
