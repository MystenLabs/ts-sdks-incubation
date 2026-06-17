// Playwright `globalSetup` that boots a dedicated stack for the run and
// tears it down on completion — the PROGRAMMATIC mirror of the vitest
// global-setup (`build-integrations/vitest/global-setup.ts`).
//
// Why this exists / why NOT `webServer`: Playwright's `webServer` shells
// out (`pnpm dev` → sh → node) and, on teardown, `process.kill(-pid)`s the
// group but resolves graceful-close the instant the LAUNCHED process closes
// — pnpm exits in ~200ms, long before the supervisor finishes its container
// drain, after which Playwright SIGKILLs the group and orphans the Docker
// containers. So we DON'T use `webServer` at all: we boot the stack in-process
// here via `runStack` (whose `start` awaits readiness AND post-acquire codegen)
// and tear it down via `handle.stop` + `awaitShutdown` (a clean graceful drain
// that stops the containers), exactly like the vitest path.
//
// Lifecycle:
//   setup    → load config, runStack(identity.stack=<DEVSTACK_STACK>), await ready
//   handoff  → publish DEVSTACK_STACK + DEVSTACK_MANIFEST_PATH, stash the
//              fixture on globalThis for in-runner helpers (spec workers fall
//              back to a disk manifest read keyed on DEVSTACK_STACK + cwd)
//   teardown → return a fn that stops the supervisor + best-effort `wipe`
//
// Escape hatch (reuse an already-running stack — or read-only validation):
//   `DEVSTACK_TEST_REUSE=1` / `{ reuse: true }` / an explicit `manifestPath`
//   take the read-only path: no boot, no teardown — just validate + stash
//   against the existing manifest.
//
// This module imports only the CLI-free `api/` surface (`runStack`,
// `loadDevstackConfig`) so the playwright entry never pulls the CLI/TUI graph.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Effect } from 'effect';

import { loadDevstackConfig } from '../../api/load-config.ts';
import { runStack, type RunHandle } from '../../api/run-stack.ts';
import { BUILT_IN_ENDPOINT_ALIASES } from '../runtime/conventional-routes.ts';
import { discoverSingleStackManifestPath } from '../runtime/discover.ts';
import { resolveDiscoveryEnv } from '../runtime/resolve-discovery-env.ts';
import { WALLET_ENDPOINT_KEY } from '../runtime/wallet-paths.ts';
import {
	PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY,
	type PlaywrightStackFixture as RuntimePlaywrightStackFixture,
} from '../runtime/playwright-stack-context-slot.ts';
import {
	PLAYWRIGHT_ENV,
	readStackContext,
	type ResolveStackContextOptions,
	type StackContext,
} from './stack-context.ts';
import { PlaywrightManifestDiscoveryError } from './errors.ts';

// -----------------------------------------------------------------------------
// Public shapes
// -----------------------------------------------------------------------------

/** Playwright's `globalSetup` signature: a setup function that optionally
 *  returns a teardown function. We model it explicitly so the preset
 *  compiles without `@playwright/test`. */
export type PlaywrightGlobalSetup = () => Promise<void | (() => Promise<void>)>;

/**
 * Re-export of the substrate-owned fixture shape (the slot global-setup
 * stashes for in-runner helpers). Spec WORKERS don't see this globalThis
 * slot — they read the manifest off disk — but in-runner code and a
 * single-process driver do.
 */
export type PlaywrightStackFixture = RuntimePlaywrightStackFixture;

export interface DefineGlobalSetupOptions extends ResolveStackContextOptions {
	/** Stack to boot. Default: `DEVSTACK_STACK` if set, else `'test'`.
	 *  (Browser e2e examples set `DEVSTACK_STACK=e2e` in their `test:e2e`
	 *  script, isolating them from a developer's dev stack.) */
	readonly stack?: string;
	/** Path to the app's `devstack.config.ts`. Default: walk-up from cwd. */
	readonly configPath?: string;
	/** Runtime root holding `stacks/<stack>/manifest.json`. Default:
	 *  `DEVSTACK_RUNTIME_ROOT` / `DEVSTACK_STATE_DIR` / `.devstack`. */
	readonly runtimeRoot?: string;
	/** Read-only path: attach to an already-running stack (no boot, no
	 *  teardown). Default `false`; also enabled by `DEVSTACK_TEST_REUSE=1`
	 *  or by passing an explicit `manifestPath`. */
	readonly reuse?: boolean;
	/** Hard cap (ms) for the stack to reach ready. Default 300_000 (5 min). */
	readonly bootTimeoutMs?: number;
	/** Fail fast if the resolved manifest exposes zero endpoints. */
	readonly requireNonEmptyEndpoints?: boolean;
	/** Fail fast if any of these endpoint names is absent. */
	readonly requireEndpoints?: ReadonlyArray<string>;
	/** Stash the resolved context on `globalThis` for in-runner helpers.
	 *  Default `true`. */
	readonly preloadContext?: boolean;
}

// -----------------------------------------------------------------------------
// Defaults + small helpers (mirrored from the vitest global-setup)
// -----------------------------------------------------------------------------

const DEFAULT_BOOT_TIMEOUT_MS = 300_000;
const DEFAULT_RUNTIME_ROOT = '.devstack';
/** Default stack when `DEVSTACK_STACK` is unset. Examples override via the
 *  `test:e2e` script; this is only the bare fallback. */
const DEFAULT_TEST_STACK = 'test';

const isTruthyEnv = (value: string | undefined): boolean =>
	value === '1' || value === 'true' || value === 'yes';

const resolveStackName = (
	options: DefineGlobalSetupOptions,
	env: Record<string, string | undefined>,
): string => {
	const fromEnv = env[PLAYWRIGHT_ENV.STACK];
	return options.stack ?? (fromEnv && fromEnv !== '' ? fromEnv : DEFAULT_TEST_STACK);
};

const resolveRuntimeRoot = (
	options: DefineGlobalSetupOptions,
	env: Record<string, string | undefined>,
): string =>
	options.runtimeRoot ??
	(env.DEVSTACK_RUNTIME_ROOT || env.DEVSTACK_STATE_DIR || undefined) ??
	DEFAULT_RUNTIME_ROOT;

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

/** After the in-process supervisor exits, graceful shutdown only STOPS the
 *  stack's containers (devstack keeps them for warm restarts). An ephemeral
 *  e2e stack should leave nothing behind, so run the production `devstack
 *  wipe` verb (force-removes containers + networks + volumes + per-stack
 *  state). Best-effort: failure never fails the test run, and a leftover
 *  stopped stack is force-recreated by the next boot. Skip with
 *  `DEVSTACK_TEST_KEEP=1` to leave the stack up for debugging. */
const wipeStack = (stack: string, runtimeRoot: string, cwd: string): Promise<void> =>
	new Promise((resolve) => {
		// The CLI entry ships beside this module in the built package:
		// dist/build-integrations/playwright/global-setup.mjs → dist/cli/main.mjs.
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
		child.unref();
		const done = (): void => resolve();
		child.on('error', done);
		child.on('exit', done);
		const timer = setTimeout(() => {
			child.kill();
			resolve();
		}, 120_000);
		timer.unref?.();
	});

const publishHandoff = (stack: string, manifestPath: string): void => {
	process.env[PLAYWRIGHT_ENV.STACK] = stack;
	process.env[PLAYWRIGHT_ENV.MANIFEST_PATH] = manifestPath;
};

// -----------------------------------------------------------------------------
// Context read (reuse / post-boot) + single-stack fallback
// -----------------------------------------------------------------------------

const stackOptionWasExplicit = (options: ResolveStackContextOptions): boolean => {
	const env = options.env ?? (process.env as Record<string, string | undefined>);
	return (
		options.stack !== undefined ||
		options.manifestPath !== undefined ||
		env[PLAYWRIGHT_ENV.STACK] !== undefined ||
		env[PLAYWRIGHT_ENV.MANIFEST_PATH] !== undefined
	);
};

const findSingleStackManifestPath = (options: ResolveStackContextOptions): string | null => {
	if (stackOptionWasExplicit(options)) return null;
	const env = options.env ?? (process.env as Record<string, string | undefined>);
	const { stateDir } = resolveDiscoveryEnv(
		env,
		options.stateDir !== undefined ? { stateDir: options.stateDir } : {},
	);
	return discoverSingleStackManifestPath({
		...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
		stateDir,
	});
};

const readContextForSetup = (options: ResolveStackContextOptions): StackContext => {
	try {
		return readStackContext(options);
	} catch (cause) {
		if (!(cause instanceof PlaywrightManifestDiscoveryError)) throw cause;
		const inferredManifestPath = findSingleStackManifestPath(options);
		if (inferredManifestPath === null) throw cause;
		return readStackContext({ ...options, manifestPath: inferredManifestPath });
	}
};

const validateContext = (ctx: StackContext, options: DefineGlobalSetupOptions): void => {
	if (options.requireNonEmptyEndpoints === true && ctx.endpointNames.length === 0) {
		throw new Error(
			`devstack manifest at ${ctx.manifestPath} has no endpoints. ` +
				`The supervisor likely failed before its eager snapshot write; ` +
				`check the boot logs for plugin acquire errors.`,
		);
	}
	const required = options.requireEndpoints ?? [];
	const missing: string[] = [];
	for (const key of required) {
		if (ctx.endpointMaybe(key) === null) missing.push(key);
	}
	if (missing.length > 0) {
		throw new Error(
			`devstack manifest at ${ctx.manifestPath} is missing required endpoints: ` +
				`${missing.join(', ')}. available endpoint names: ` +
				`${ctx.endpointNames.join(', ') || '(none)'}. ` +
				`raw manifest keys: ${ctx.manifestEndpointKeys.join(', ') || '(none)'}.`,
		);
	}
};

// -----------------------------------------------------------------------------
// Global stash (in-runner fixture; spec workers fall back to disk)
// -----------------------------------------------------------------------------

/** The slot on `globalThis` where the prewarmed stack context lives.
 *  In-spec helpers (`wallet-context.ts`) read from here when present. */
export const STACK_CONTEXT_SLOT = PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY;

let stashGeneration = 0;

const stashStackContext = (ctx: StackContext): void => {
	const endpoints: Record<string, string> = Object.fromEntries(
		ctx.endpointNames.map((name) => [name, ctx.endpoint(name)]),
	);
	for (const [alias, canonical] of Object.entries(BUILT_IN_ENDPOINT_ALIASES)) {
		if (alias in endpoints) continue;
		const url = endpoints[canonical];
		if (url !== undefined) endpoints[alias] = url;
	}
	stashGeneration += 1;
	const fixture: PlaywrightStackFixture = {
		endpoints,
		walletEndpoint: ctx.endpointMaybe(WALLET_ENDPOINT_KEY),
		manifestPath: ctx.manifestPath,
		stack: ctx.manifest.identity.stack,
		app: ctx.manifest.identity.app,
		generation: stashGeneration,
	};
	// Advise on overwrite: a second populate means global-setup ran twice in
	// one process (a Playwright retry re-running it). The bumped `generation`
	// lets cache-holders detect the rotation and re-read.
	const previous = globalThis[PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY];
	if (previous !== undefined) {
		try {
			process.stderr.write(
				`[devstack/playwright] global-setup re-ran (generation ${previous.generation} → ` +
					`${fixture.generation}); downstream consumers should re-read ` +
					`globalThis[${PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY}].\n`,
			);
		} catch {
			// stderr EPIPE — swallow; the advisory is best-effort.
		}
	}
	globalThis[PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY] = fixture;
};

/** Read the slot. Returns `null` if global-setup didn't run in this process
 *  (e.g. a spec worker, or `globalSetup: null`). Callers MUST fall back to a
 *  disk manifest read. */
export const readStashedFixture = (): PlaywrightStackFixture | null =>
	globalThis[PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY] ?? null;

// -----------------------------------------------------------------------------
// Builder
// -----------------------------------------------------------------------------

/**
 * Build a Playwright `globalSetup` that boots (or, in reuse/read-only mode,
 * attaches to) a dedicated stack and returns a teardown. Wire it as the
 * config's `globalSetup` module path — `devstackPlaywrightBaseConfig`
 * references this module's default export.
 */
export const buildGlobalSetup = (options: DefineGlobalSetupOptions = {}): PlaywrightGlobalSetup => {
	return async () => {
		const env = options.env ?? (process.env as Record<string, string | undefined>);
		const readOnly =
			(options.reuse ?? isTruthyEnv(env.DEVSTACK_TEST_REUSE)) || options.manifestPath !== undefined;

		// Read-only path: attach to / validate an existing manifest. No boot,
		// no teardown. (Reuse escape hatch + the unit-test seam.)
		if (readOnly) {
			const ctx = readContextForSetup(options);
			validateContext(ctx, options);
			if (options.preloadContext ?? true) stashStackContext(ctx);
			return async () => {};
		}

		// Fresh boot (default): load the app's stack the same way the CLI does
		// and run it in-process. `start` resolves once every plugin is ready
		// AND post-acquire codegen has emitted.
		const stack = resolveStackName(options, env);
		const runtimeRoot = resolveRuntimeRoot(options, env);
		const loaded = await Effect.runPromise(loadDevstackConfig(options.configPath)).catch(
			(cause: unknown) => {
				throw new Error(
					`devstack playwright globalSetup: failed to load devstack config — ${
						cause instanceof Error ? cause.message : String(cause)
					}`,
					{ cause },
				);
			},
		);
		const appRoot = dirname(loaded.resolvedConfigPath);

		const handle = runStack(loaded.stack, {
			identity: { stack },
			appRoot,
			runtimeRoot,
			...(loaded.engine.options.codegen !== undefined
				? { codegen: loaded.engine.options.codegen }
				: {}),
		});

		try {
			await withTimeout(
				Effect.runPromise(handle.start),
				options.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS,
				`devstack playwright globalSetup: '${stack}' stack boot`,
			);
		} catch (cause) {
			await safeStop(handle);
			throw new Error(
				`devstack playwright globalSetup: failed to boot the '${stack}' stack. ` +
					`If a '${stack}' stack is already running, set DEVSTACK_TEST_REUSE=1 to ` +
					`run against it. Cause: ${cause instanceof Error ? cause.message : String(cause)}`,
				{ cause },
			);
		}

		const ctx = readContextForSetup({ ...options, stack, stateDir: runtimeRoot, cwd: appRoot });
		validateContext(ctx, options);
		publishHandoff(stack, ctx.manifestPath);
		if (options.preloadContext ?? true) stashStackContext(ctx);

		const keep = isTruthyEnv(env.DEVSTACK_TEST_KEEP);
		return async () => {
			await safeStop(handle);
			if (!keep) await wipeStack(stack, runtimeRoot, appRoot);
		};
	};
};

/** Default export = a ready-to-use Playwright `globalSetup` (boots the stack
 *  resolved from `DEVSTACK_STACK`, tears it down on completion). This is what
 *  `globalSetup: '@mysten-incubation/devstack/playwright/global-setup'`
 *  resolves to. */
export default buildGlobalSetup();
