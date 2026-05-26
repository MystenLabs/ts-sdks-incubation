// Typed contract for the `globalThis.__devstackPlaywrightStackContext__`
// fixture slot Playwright global-setup populates.
//
// Sibling to `dapp-kit-slot.ts` — one slot ownership per consumer keeps
// the typed `declare global` block minimal and lets the playwright
// surface import only what it needs.
//
// The slot's NAME is part of the cross-process contract: in-spec helpers
// (`wallet-context.ts`, fixture readers) look up `globalThis[KEY]` to
// avoid repeating the manifest disk read in every worker. Renames cascade
// through every consumer.
//
// This module evaluates in Node build-integration callers only — Playwright
// global-setup runs server-side. No `node:*` imports here so it stays
// importable from any TS context.

/** The literal property name on `globalThis` that global-setup writes
 *  the prewarmed stack fixture to. In-spec helpers read from here when
 *  present; absent => global-setup didn't run (user opted out via
 *  `globalSetup: null`). */
export const PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY =
	'__devstackPlaywrightStackContext__' as const;

/** Prewarmed stack fixture shape. Mirrors what global-setup builds from
 *  the manifest read; in-spec helpers consume it as a frozen view. */
export interface PlaywrightStackFixture {
	readonly endpoints: Readonly<Record<string, string>>;
	readonly walletEndpoint: string | null;
	readonly manifestPath: string;
	readonly stack: string;
	readonly app: string;
}

declare global {
	// eslint-disable-next-line no-var
	var __devstackPlaywrightStackContext__: PlaywrightStackFixture | undefined;
}
