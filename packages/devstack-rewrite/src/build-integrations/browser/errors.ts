// Browser build integration — typed errors surfaced from the
// `defineDevstackBrowserConfig` preset and its companion setup module.
//
// The browser integration is a thin reader: it builds a vitest
// browser-mode config and exposes a setup hook that loads the
// codegen-emitted `dapp-kit-config` into the global slot
// `globalThis.__devstackDAppKit__`. Both surfaces can fail in
// well-understood ways; this module owns the tagged-error vocabulary
// so callers (and the cascade formatter) can catch by `_tag` rather
// than string-matching.
//
// Architecture (distilled/23-build-integrations.md § Browser): the
// browser subpath must not pull in `node:*` modules at module init.
// These tagged errors are plain `Data.TaggedError` values — pure data,
// no fs / path imports — so they're safe to evaluate in a browser
// bundle alongside the rest of this subpath.

import { Data } from 'effect';

// -----------------------------------------------------------------------------
// Tagged errors
// -----------------------------------------------------------------------------

/** The codegen-emitted dapp-kit config module could not be located or
 *  failed to import at browser-test setup time. Usually means
 *  `devstack up` hasn't emitted artifacts yet, or the configured
 *  `dappKitConfigPath` doesn't match the codegen output directory. */
export class BrowserSetupConfigNotFoundError extends Data.TaggedError(
	'BrowserSetupConfigNotFoundError',
)<{
	readonly message: string;
	readonly searchedPath: string;
	readonly hint?: string;
}> {}

/** The codegen-emitted dapp-kit config imported but did not match the
 *  expected shape (missing the network/wallet fields the global slot
 *  contract requires). Carries the offending value's shape summary. */
export class BrowserSetupConfigInvalidError extends Data.TaggedError(
	'BrowserSetupConfigInvalidError',
)<{
	readonly message: string;
	readonly cause?: unknown;
}> {}

/** `defineDevstackBrowserConfig` was called with options the preset
 *  cannot reconcile (e.g. browser-mode disabled while a browser-only
 *  field was supplied). Pure config-shape error; no I/O. */
export class BrowserConfigOptionsError extends Data.TaggedError('BrowserConfigOptionsError')<{
	readonly message: string;
	readonly field?: string;
}> {}

// -----------------------------------------------------------------------------
// Union
// -----------------------------------------------------------------------------

export type BrowserIntegrationError =
	| BrowserSetupConfigNotFoundError
	| BrowserSetupConfigInvalidError
	| BrowserConfigOptionsError;
