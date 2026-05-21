// Browser build integration — vitest browser-mode setup file.
//
// Loaded automatically by `defineDevstackBrowserConfig()` via
// `test.setupFiles`. Runs once per browser-test page-load, BEFORE any
// spec executes.
//
// Responsibilities:
//   - Import the codegen-emitted dapp-kit config (network endpoints,
//     wallet bundle, account list) and assign it to the global slot
//     `globalThis.__devstackDAppKit__`.
//   - The slot contract is the same one Playwright's `connectAs` and
//     `selectAccount` helpers read from in e2e tests; browser-mode
//     tests reuse the same lookup path without needing a wallet UI
//     click.
//
// What this module is NOT:
//   - It does NOT start devstack. The test file owns lifecycle via
//     `@effect/vitest`'s `it.layer(stack.layer)`, exactly as in
//     node-mode vitest. See distilled/23-build-integrations.md § Vitest.
//   - It does NOT read the on-disk manifest directly; codegen has
//     already projected the manifest into a browser-safe
//     `dapp-kit-config` module. Reading the manifest here would pull
//     `node:fs` into the browser bundle, breaking the L4 boundary.
//
// Browser-bundle hygiene: this module's static imports MUST stay clear
// of `node:*` modules at module init (see distilled § Invariants:
// "Boundary partition"). The dapp-kit config import is dynamic and
// runs only once the bundler has resolved it; the errors module is
// pure Effect Data.
//
// Configurable knob: `defineDevstackBrowserConfig({ dappKitConfigPath })`
// surfaces the path the setup file should import. The config builder
// passes it down via a `define` constant
// (`__DEVSTACK_DAPP_KIT_CONFIG_PATH__`) that the bundler replaces at
// build time; this file reads that constant when present and falls
// back to the conventional codegen output.

import { setupDevstackBrowserGlobals } from './setup-globals.ts';

export { setupDevstackBrowserGlobals, type DAppKitConfigModule } from './setup-globals.ts';

// Top-level await runs at setup-file evaluation time. Vitest awaits
// the module before running any spec. Keep this side effect in the
// dedicated `./browser/setup` export; the public `./browser` barrel
// imports `./setup-globals.ts` directly so it stays importable before
// codegen artifacts exist.
await setupDevstackBrowserGlobals();
