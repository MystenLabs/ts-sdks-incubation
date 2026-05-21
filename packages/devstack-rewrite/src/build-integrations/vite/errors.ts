// Vite build-integration errors.
//
// Manifest discovery/shape errors come from `runtime/` (the canonical
// L5 read-side substrate). This module owns the vite-specific failures
// only: identity resolution and config-shape validation.

import { Data } from 'effect';

/** The plugin could not resolve `(app, stack)` from environment + cwd.
 *  Most commonly: `process.cwd()` is outside any known package tree and
 *  no `appName` was passed to the plugin. */
export class ViteIdentityResolutionError extends Data.TaggedError('ViteIdentityResolutionError')<{
	readonly message: string;
	readonly cwd: string;
	readonly hint: string;
}> {}

/** `defineDevstackViteConfig` was called with options the preset
 *  cannot reconcile (e.g. a negative port, an `appDir` that doesn't
 *  exist). Pure config-shape error; no I/O. */
export class ViteConfigOptionsError extends Data.TaggedError('ViteConfigOptionsError')<{
	readonly message: string;
	readonly field?: string;
}> {}

export type ViteIntegrationError = ViteIdentityResolutionError | ViteConfigOptionsError;
