// Browser build integration — side-effect-free setup helper.
//
// The public `@mysten-incubation/devstack/browser` barrel imports this
// module, so this file must not load the generated dapp-kit config at
// module evaluation time. The setup-file side effect lives only in
// `./setup.ts`, which Vitest loads through the dedicated
// `@mysten-incubation/devstack/browser/setup` export.

import { type DAppKitSlot, writeDAppKitSlot } from '../runtime/browser.ts';
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
	} catch {
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
