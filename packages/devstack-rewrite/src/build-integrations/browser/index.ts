// Browser build integration — public surface for the
// `@mysten-incubation/devstack/browser` subpath.
//
// Architecture (distilled/23-build-integrations.md § Browser):
//   - A vitest browser-mode config preset that mirrors
//     `defineDevstackVitestConfig` but configures `@vitest/browser` so
//     specs run in a real browser instead of jsdom.
//   - A small setup module (`./setup`) wired in via `test.setupFiles`
//     that loads the codegen-emitted dapp-kit config into
//     `globalThis.__devstackDAppKit__`.
//   - Pure consumer of devstack artifacts: reads codegen output, never
//     subscribes to the engine, never starts a supervisor.
//
// Apps use this subpath instead of the node-mode `vitest` subpath
// whenever their unit tests need a real browser runtime (canvas, real
// Web Crypto, wallet web-component dispatch, dApp Kit DOM rendering).
//
// Browser-bundle hygiene: slot exports come from the slot-only runtime
// barrel. The config builder is evaluated by the test runner, not the
// browser; the setup file is browser-safe by construction.

export {
	defineDevstackBrowserConfig,
	type DevstackBrowserConfigOptions,
	type DevstackBrowserModeOptions,
} from './config.ts';

export { setupDevstackBrowserGlobals, type DAppKitConfigModule } from './setup.ts';

// Re-exports from the canonical `runtime/` substrate — the slot
// contract is shared across vite, playwright, and browser-mode vitest.
export { DAPP_KIT_SLOT_KEY, type DAppKitSlot } from '../runtime/browser.ts';

export {
	BrowserConfigOptionsError,
	BrowserSetupConfigInvalidError,
	BrowserSetupConfigNotFoundError,
	type BrowserIntegrationError,
} from './errors.ts';
