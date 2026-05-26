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
	PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY,
	type PlaywrightStackFixture as RuntimePlaywrightStackFixture,
} from '../runtime/playwright-stack-context-slot.ts';
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
 * The shape global-setup writes for in-spec tests to read. Tests do
 * NOT re-walk-up to find the manifest at every assertion — they read
 * this prepared fixture from `globalThis`, which is faster and avoids
 * a subtle cwd-mismatch class of failure when Playwright runs tests
 * from a worker process.
 *
 * Re-export of the substrate-owned `runtime/playwright-stack-context-slot`
 * shape so both consumer surfaces agree on one type. The matching
 * typed `declare global` block lives next to the slot key so callers
 * can read/write `globalThis[KEY]` without a cast.
 */
export type PlaywrightStackFixture = RuntimePlaywrightStackFixture;

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
			if (ctx.endpointNames.length === 0) {
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
			if (ctx.endpointMaybe(key) === null) missing.push(key);
		}
		if (missing.length > 0) {
			throw new Error(
				`devstack manifest at ${ctx.manifestPath} is missing required ` +
					`endpoints: ${missing.join(', ')}. ` +
					`available endpoint names: ${ctx.endpointNames.join(', ') || '(none)'}. ` +
					`raw manifest keys: ${ctx.manifestEndpointKeys.join(', ') || '(none)'}.`,
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
 *  to avoid a second disk read. Re-exported from the runtime slot
 *  module so consumers can import either side. */
export const STACK_CONTEXT_SLOT = PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY;

const stashStackContext = (ctx: StackContext): void => {
	const fixture: PlaywrightStackFixture = {
		endpoints: Object.fromEntries(ctx.endpointNames.map((name) => [name, ctx.endpoint(name)])),
		walletEndpoint: ctx.endpointMaybe('wallet'),
		manifestPath: ctx.manifestPath,
		stack: ctx.manifest.identity.stack,
		app: ctx.manifest.identity.app,
	};
	globalThis[PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY] = fixture;
};

/** Read the slot. Returns `null` if global-setup didn't run (e.g. the
 *  user opted out by passing `globalSetup: null`). */
export const readStashedFixture = (): PlaywrightStackFixture | null =>
	globalThis[PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY] ?? null;
