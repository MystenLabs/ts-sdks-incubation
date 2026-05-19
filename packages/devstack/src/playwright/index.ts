// Public surface for `@mysten-incubation/devstack/playwright`.
//
// Spec authors should import everything they need from this one
// subpath; the de-facto contract is exercised by all six example apps
// under `examples/{wallet,arena,token-studio,private-content,deepbook-full,_template}`
// and is the only supported entry point for playwright integrations.
//
// Three concern groups:
//
//   - **Config**: `defineDevstackPlaywrightConfig` (one-call config), plus
//     `webServer` / `baseURL` (escape hatches for callers that want to
//     assemble a custom `PlaywrightTestConfig` by hand).
//   - **In-spec helpers**: `connectAs(page, label)` + `selectAccount(loc, name)`
//     for UI flows, and `loadStackManifest()` / `loadStackKeypair(name)` for
//     specs that need to escape the UI and submit transactions via the SDK.
//   - **Re-exports**: `test`, `expect` from `@playwright/test` so specs only
//     import from this one module.
//
// Adding a new helper here is the canonical place for any reusable
// pattern that spans multiple example apps' e2e suites.

// In-spec UI helpers — `connectAs` drives the dApp Kit dev-wallet flow;
// `selectAccount` is a `<select>`-by-text shim.
export { connectAs, selectAccount } from './helpers.js';

// Manifest + keypair loaders for specs that need to escape the UI and
// submit transactions directly via the SDK. Folds in the on-disk path
// folklore (`.devstack/stacks/<stack>/{manifest.json,runtime/accounts/<name>.key}`)
// so individual specs don't re-implement it.
export {
	loadStackKeypair,
	loadStackManifest,
	type LoadStackKeypairOptions,
	type LoadStackManifestOptions,
} from './artifacts.js';

// Low-level `webServer` block + `use.baseURL` resolver. Most specs reach
// for `defineDevstackPlaywrightConfig` instead, which calls these for you.
export { baseURL, webServer, type BaseURLOptions, type WebServerOptions } from './web-server.js';

// One-call canonical playwright config. Apps reduce their entire
// `playwright.config.ts` to:
//
//   import { defineDevstackPlaywrightConfig } from '@mysten-incubation/devstack/playwright';
//   export default defineDevstackPlaywrightConfig();
export {
	defineDevstackPlaywrightConfig,
	type DevstackPlaywrightConfigOptions,
} from './define-config.js';

// Re-export Playwright's `test`/`expect` so callers can import everything
// from a single module:
// `import { test, expect, connectAs } from '@mysten-incubation/devstack/playwright'`.
export { expect, test } from '@playwright/test';
