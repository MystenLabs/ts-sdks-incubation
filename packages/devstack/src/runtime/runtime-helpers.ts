// Plugin-author runtime helpers exposed via the `/authoring` barrel.
// Lives outside `plugins/*` so third-party plugins can consume it
// without reaching into a sibling plugin's source directory.

import type { ActionRunContext, LocalnetActionRunContext } from '../core/types.js';

/** Narrow `ActionRunContext` to localnet at a callback boundary, throwing
 * a labeled error otherwise. Plugin authors call this at the top of
 * Register/Seed/Emit callbacks that bind a host port or read `ctx.stack` —
 * the action factory's signatures are network-flexible, but callbacks
 * that materially require localnet need the type narrowed and a clear
 * error if they end up scheduled against a live net by mistake.
 *
 * The `pluginLabel` argument identifies the source in error messages
 * (e.g. `'seal.register'`, `'walrus.deploy'`). Built-in plugins pass
 * `'<plugin>.<action>'`. */
export function requireLocalnetCtx(
	ctx: ActionRunContext,
	pluginLabel: string,
): asserts ctx is LocalnetActionRunContext {
	if (ctx.network !== 'localnet') {
		throw new Error(`${pluginLabel}: requires localnet but got ${ctx.network}`);
	}
}
