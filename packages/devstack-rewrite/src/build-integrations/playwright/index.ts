// Playwright build-integration — public barrel.
//
// Architecture (distilled/23-build-integrations.md § Playwright):
// apps' `playwright.config.ts` collapses to one call into
// `defineDevstackPlaywrightConfig`; in-spec helpers (`connectAs`,
// `selectAccount`, `loadStackManifest`, the wallet adapter) import
// from the same subpath.
//
// Layer position: L4 (surface). Reads the manifest + env; never
// writes; never subscribes to engine events; never imports a plugin
// by service name. The vite build-integration owns the dev-server
// port allocation; this surface only READS the URL it picks.
//
// Optional peer: `@playwright/test`. We do not import the peer at
// module init — the structural types in this barrel and its children
// keep the preset loadable without it (matching the vitest preset).

import {
	buildPlaywrightConfig,
	type DefineDevstackPlaywrightConfigOptions,
	type PlaywrightTestConfigShape,
} from './config.ts';

// -----------------------------------------------------------------------------
// Primary entry — `defineDevstackPlaywrightConfig`
// -----------------------------------------------------------------------------

/**
 * Construct the canonical Playwright config for a devstack example
 * app. Apps call this once from `playwright.config.ts` and pass the
 * result to Playwright's `defineConfig` (or export it directly —
 * Playwright accepts a config-shaped object).
 *
 * Defaults applied:
 *   - `workers: 1`, `fullyParallel: false` (single supervisor per
 *     stack; architecture invariant).
 *   - `testDir: './e2e'`, Chromium-only project.
 *   - `webServer.command: 'pnpm dev'`, `reuseExistingServer: !CI`,
 *     timeout 300s, graceful SIGTERM + 10s.
 *   - `baseURL` and `webServer.url` resolved from the manifest's
 *     `app` endpoint, with cold-start fallback to the conventional
 *     URL when the manifest is absent.
 *   - `globalSetup` is NOT pre-wired (Playwright accepts only a
 *     module-path string here; the preset can't wire a function
 *     factory). Apps that want the bundled hook import
 *     `buildGlobalSetup()` from this barrel and ship a thin
 *     `e2e/global-setup.ts` shim that re-exports the result as
 *     `default`.
 *
 * Override knobs:
 *   - `endpointKey`: pick a different endpoint than `app` for the
 *     base URL.
 *   - `baseURL`: bypass discovery entirely with a literal URL.
 *   - `command`: change the `webServer` command (e.g. `npm run dev`).
 *   - `globalSetup`: pass `null` to opt out, or a module path to
 *     override.
 *   - `extend`: full top-level override escape hatch.
 */
export const defineDevstackPlaywrightConfig = (
	options: DefineDevstackPlaywrightConfigOptions = {},
): PlaywrightTestConfigShape => buildPlaywrightConfig(options);

// -----------------------------------------------------------------------------
// Re-exports — the helpers in-spec tests import from this subpath
// -----------------------------------------------------------------------------

export type { DefineDevstackPlaywrightConfigOptions, PlaywrightTestConfigShape } from './config.ts';
export { buildPlaywrightConfig } from './config.ts';

export type {
	ResolveStackContextOptions,
	ResolvedEndpoint,
	StackContext,
} from './stack-context.ts';
export {
	PLAYWRIGHT_ENV,
	conventionalUrlFor,
	discoverManifestPath,
	makeStackContext,
	readManifestSync,
	readStackContext,
	resolveEndpointUrl,
} from './stack-context.ts';

export type {
	DefineGlobalSetupOptions,
	PlaywrightGlobalSetup,
	PlaywrightStackFixture,
} from './global-setup.ts';
export { STACK_CONTEXT_SLOT, buildGlobalSetup, readStashedFixture } from './global-setup.ts';

export type {
	DevAccount,
	PlaywrightPageLike,
	SignTxRequest,
	SignTxResponse,
	WalletAdapter,
	WalletAdapterOptions,
} from './wallet-context.ts';
export {
	DAPP_KIT_SLOT,
	WALLET_ENDPOINT_KEY,
	connectAs,
	createWalletAdapter,
	loadStackManifest,
	selectAccount,
} from './wallet-context.ts';

export type { PlaywrightIntegrationError } from './errors.ts';
export {
	PlaywrightEndpointNotFoundError,
	PlaywrightManifestDiscoveryError,
	PlaywrightManifestShapeError,
	PlaywrightWalletAdapterError,
} from './errors.ts';
