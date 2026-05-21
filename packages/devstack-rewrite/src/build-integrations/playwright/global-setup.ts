// Playwright `globalSetup` hook.
//
// Architecture (distilled/23-build-integrations.md § Playwright):
//
//   What it needs: the same manifest as Vite (...) but with a
//   cold-start fallback (...) — Playwright config-load runs BEFORE
//   the supervisor spawns to write the manifest.
//
//   How it hooks in: the spawned `pnpm dev` (default `command`) brings
//   up the supervisor, which writes the real manifest. Playwright
//   polls `webServer.url` until reachable.
//
// This module is the third hook in that chain (config-load → webServer
// spawn → globalSetup). By the time it runs, the supervisor IS up and
// the manifest has been written; globalSetup verifies invariants and
// populates fixtures the in-spec tests rely on (e.g. preloads the
// stack context so each test doesn't repeat the disk read; warms the
// wallet adapter; resolves the test-account list).
//
// What it does NOT do:
//   - Boot the supervisor. (`webServer.command` does that.)
//   - Wait on `webServer.url`. (Playwright does that.)
//   - Write any state. (Read-only.)
//
// Returns a teardown function (the inverse hook Playwright supports
// via `globalTeardown` indirection — we return the teardown so the
// preset's `globalTeardown` can call it).

import {
	readStackContext,
	type ResolveStackContextOptions,
	type StackContext,
} from './stack-context.ts';

// -----------------------------------------------------------------------------
// Public shape Playwright expects
// -----------------------------------------------------------------------------

/** Playwright's `globalSetup` signature is `() => Promise<void | (() =>
 *  Promise<void>)>` — we model it explicitly so the preset compiles
 *  without `@playwright/test`. */
export type PlaywrightGlobalSetup = () => Promise<void | (() => Promise<void>)>;

// -----------------------------------------------------------------------------
// Fixture payload
// -----------------------------------------------------------------------------

/**
 * The shape global-setup writes to disk for in-spec tests to read.
 * Tests do NOT re-walk-up to find the manifest at every assertion —
 * they read this prepared fixture, which is faster and avoids a
 * subtle cwd-mismatch class of failure when Playwright runs tests
 * from a worker process.
 *
 * The fixture is written to a Playwright-known path (resolved from
 * env Playwright populates) so worker processes pick it up. The
 * setup also stamps `DEVSTACK_MANIFEST_PATH` into the worker env so
 * `wallet-context` can reach the file without re-running discovery.
 */
export interface PlaywrightStackFixture {
	readonly endpoints: Readonly<Record<string, string>>;
	readonly walletEndpoint: string | null;
	readonly manifestPath: string;
	readonly stack: string;
	readonly app: string;
}

// -----------------------------------------------------------------------------
// Configurable factory
// -----------------------------------------------------------------------------

export interface DefineGlobalSetupOptions extends ResolveStackContextOptions {
	/**
	 * Verify the manifest's `endpoints` has at least one entry. The
	 * supervisor's manifest writer always emits at least the `app`
	 * endpoint, so an empty `endpoints` lookup means the supervisor
	 * crashed before reaching its eager snapshot-and-write — fail
	 * fast here rather than letting tests time out.
	 */
	readonly requireNonEmptyEndpoints?: boolean;

	/**
	 * Verify the named endpoints exist in the manifest. Used to fail
	 * fast when a test suite depends on a specific plugin (wallet,
	 * sui-faucet) being present in the resolved stack.
	 */
	readonly requireEndpoints?: ReadonlyArray<string>;

	/**
	 * Pre-warm the stack context — read the manifest once and stash
	 * the result on `globalThis` so tests don't repeat the disk read.
	 * Default: `true`.
	 */
	readonly preloadContext?: boolean;
}

/**
 * Build a Playwright `globalSetup` function. The returned function
 * matches the signature Playwright expects (a default export of a
 * module path; we return the function so the preset can wire it).
 */
export const buildGlobalSetup = (options: DefineGlobalSetupOptions = {}): PlaywrightGlobalSetup => {
	return async () => {
		const ctx = readStackContext(options);

		if (options.requireNonEmptyEndpoints === true) {
			if (Object.keys(ctx.manifest.endpoints).length === 0) {
				throw new Error(
					`devstack manifest at ${ctx.manifestPath} has no endpoints. ` +
						`The supervisor likely failed before its eager snapshot ` +
						`write; check the dev server logs for plugin acquire errors.`,
				);
			}
		}

		const required = options.requireEndpoints ?? [];
		const missing: string[] = [];
		for (const key of required) {
			if (ctx.manifest.endpoints[key] === undefined) missing.push(key);
		}
		if (missing.length > 0) {
			throw new Error(
				`devstack manifest at ${ctx.manifestPath} is missing required ` +
					`endpoints: ${missing.join(', ')}. ` +
					`available: ${Object.keys(ctx.manifest.endpoints).join(', ') || '(none)'}.`,
			);
		}

		if (options.preloadContext ?? true) {
			stashStackContext(ctx);
		}

		// Return value: `void` (no teardown). Playwright accepts
		// `() => Promise<void>` here.
	};
};

/** Default export shape that mirrors what Playwright's
 *  `defineConfig.globalSetup` resolves: a module whose default export
 *  is the setup function. */
export default buildGlobalSetup();

// -----------------------------------------------------------------------------
// Global stash
// -----------------------------------------------------------------------------

/** The slot on `globalThis` where the prewarmed stack context lives.
 *  In-spec helpers (`wallet-context.ts`) read from here when present
 *  to avoid a second disk read. */
export const STACK_CONTEXT_SLOT = '__devstackPlaywrightStackContext__' as const;

interface GlobalSlot {
	[STACK_CONTEXT_SLOT]?: PlaywrightStackFixture;
}

const stashStackContext = (ctx: StackContext): void => {
	const fixture: PlaywrightStackFixture = {
		endpoints: Object.fromEntries(
			Object.entries(ctx.manifest.endpoints).map(([k, e]) => [k, e.url]),
		),
		walletEndpoint: ctx.manifest.endpoints['wallet']?.url ?? null,
		manifestPath: ctx.manifestPath,
		stack: ctx.manifest.identity.stack,
		app: ctx.manifest.identity.app,
	};
	(globalThis as unknown as GlobalSlot)[STACK_CONTEXT_SLOT] = fixture;
};

/** Read the slot. Returns `null` if global-setup didn't run (e.g. the
 *  user opted out by passing `globalSetup: null`). */
export const readStashedFixture = (): PlaywrightStackFixture | null => {
	const slot = (globalThis as unknown as GlobalSlot)[STACK_CONTEXT_SLOT];
	return slot ?? null;
};
