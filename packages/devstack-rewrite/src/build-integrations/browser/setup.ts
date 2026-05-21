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

import { type DAppKitSlot, writeDAppKitSlot } from '../runtime/index.ts';
import { BrowserSetupConfigInvalidError, BrowserSetupConfigNotFoundError } from './errors.ts';

/** Shape of the codegen-emitted dapp-kit config module. Kept minimal
 *  here: the setup file only cares about getting *something* into the
 *  global slot. The full type is owned by codegen's emitter. */
export interface DAppKitConfigModule {
	readonly default: unknown;
}

/**
 * Default codegen-emitted dapp-kit config path. Resolved by the
 * bundler relative to the consumer app's root. The
 * `__DEVSTACK_DAPP_KIT_CONFIG_PATH__` define constant emitted by the
 * config builder (`defineDevstackBrowserConfig({ dappKitConfigPath })`)
 * overrides this at build time when the user surfaces a custom path.
 */
const DEFAULT_DAPP_KIT_CONFIG_PATH = '/.devstack/codegen/dapp-kit-config';

/** Compile-time-replaced configurable path. Defined by the vitest
 *  config builder via Vite's `define`. Falls back to the default
 *  when the consumer hasn't customized the path. */
declare const __DEVSTACK_DAPP_KIT_CONFIG_PATH__: string | undefined;

const resolveConfigPath = (override: string | undefined): string => {
	if (override !== undefined && override !== '') return override;
	if (
		typeof __DEVSTACK_DAPP_KIT_CONFIG_PATH__ === 'string' &&
		__DEVSTACK_DAPP_KIT_CONFIG_PATH__.length > 0
	) {
		return __DEVSTACK_DAPP_KIT_CONFIG_PATH__;
	}
	return DEFAULT_DAPP_KIT_CONFIG_PATH;
};

/**
 * Load the codegen-emitted dapp-kit config and populate the global
 * slot. Errors are thrown synchronously so vitest fails the page with
 * a structured tag rather than letting specs run against a missing
 * slot.
 *
 * `path` overrides both the build-time `define` constant and the
 * conventional default. Apps wiring a non-standard codegen output
 * directory pass it explicitly here, or via
 * `defineDevstackBrowserConfig({ dappKitConfigPath })` (which the
 * config builder threads down via a Vite `define`).
 */
export async function setupDevstackBrowserGlobals(path?: string): Promise<void> {
	const resolved = resolveConfigPath(path);
	let mod: DAppKitConfigModule;
	try {
		mod = (await import(/* @vite-ignore */ resolved)) as DAppKitConfigModule;
	} catch (_cause) {
		throw new BrowserSetupConfigNotFoundError({
			message: `failed to import dapp-kit config at ${resolved}`,
			searchedPath: resolved,
			hint: 'run `devstack up` once to emit codegen artifacts',
		});
	}

	const cfg = mod.default;
	if (cfg == null || typeof cfg !== 'object') {
		throw new BrowserSetupConfigInvalidError({
			message: `dapp-kit config at ${resolved} did not export a config object`,
			cause: cfg,
		});
	}

	// `cfg` is validated above as a non-null object; the emitter
	// (codegen) owns the precise shape and is the only writer
	// type-checked against `DAppKitSlot`.
	writeDAppKitSlot(cfg as DAppKitSlot);
}

// Top-level await runs at setup-file evaluation time. Vitest awaits
// the module before running any spec. The build-time define constant
// surfaces the configurable path; consumers that need to override at
// runtime should call `setupDevstackBrowserGlobals(path)` from their
// own setup file instead.
await setupDevstackBrowserGlobals();
