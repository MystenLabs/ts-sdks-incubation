// `makeService(pluginName, kind, impl)` — higher-order helper that
// stamps the `__kind` + `__pluginName` discriminators onto a tag-shaped
// value (anything carrying `__layer` / `__layers`).
//
// Replaces the 24 hand-rolled `Object.assign(impl, { __kind, __pluginName })`
// sites that used to live in `services/{dev,wallet,deepbook,sui,
// postgres,pyth,walrus,seal}.ts`. The shape is identical — we just
// give it a name + a typed surface so call sites stop repeating the
// same three-line literal.
//
// The HOF lives in `/advanced` (next to `tag` / `provide` /
// `composeLayers`) so plugin authors writing out-of-tree services can
// reach for the same stamp. The in-tree `Wallet()` / `Sui()` / etc.
// factories were the original `Object.assign` sites; out-of-tree
// authors that mirror their pattern get the same affordance without
// re-deriving the field names.
//
// Returns the same object passed in (mutated via `Object.assign`) so
// any code that relied on referential equality with the bare impl
// continues to work — same invariant `provide` / `tag` already rely
// on for the canonical Context.Service mutation.

import type { TagKind } from './tag.js';

/**
 * Minimal shape `makeService` requires: any object that carries the
 * usual LayeredTag fields. We don't constrain to `LayeredTag<...>`
 * specifically because primitives like `dockerContainer` /
 * `walrusKnownDeployment` return tag-like values that satisfy the
 * runtime contract but aren't typed against the public
 * `LayeredTag<Name, A, R, E>` shape directly. The output is the same
 * object with the two extra fields, so consumers continue to see
 * whatever public type the impl already exposed plus the discriminators.
 */
interface TagLike {
	readonly __layer?: unknown;
	readonly __layers?: unknown;
}

/**
 * Stamp a tag-like value with `__kind` + `__pluginName` discriminators.
 *
 * @param pluginName - Short plugin attribution name; surfaces as the
 *   `[plugin]` chip in the TUI and drives the row's section color.
 *   In-tree: `'sui'`, `'wallet'`, `'walrus'`, `'seal'`, `'deepbook'`,
 *   `'postgres'`, `'pyth'`, `'dev'`. Out-of-tree: any short string.
 * @param kind - TUI kind discriminator. Most factories pass `'service'`
 *   (long-running) or `'action'` (one-shot). `'app'` reserves for
 *   dev-server-shaped tags (`Wallet`, `Dev`).
 * @param impl - The tag-like value to stamp. Returned with the two
 *   extra fields merged in via `Object.assign` (same mutation pattern
 *   `provide` uses for the canonical Context.Service class).
 *
 * @example
 * ```ts
 * export const Wallet = (opts?: WalletOptions) =>
 *   makeService('wallet', 'app', walletApp(walletOpts));
 * ```
 */
export const makeService = <T extends TagLike>(
	pluginName: string,
	kind: TagKind,
	impl: T,
): T & { readonly __kind: TagKind; readonly __pluginName: string } =>
	Object.assign(impl, { __kind: kind, __pluginName: pluginName } as const);
