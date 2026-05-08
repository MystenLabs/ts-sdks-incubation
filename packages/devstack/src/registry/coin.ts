// Typed helpers for the coin registry namespace.
//
// Tokens (fungible coins) live under `registry.ns('coin').tokens` rather
// than as a core Registry kind: not every app uses fungible coins, so
// surfacing them on the `Registry` interface alongside `packages`,
// `accounts`, `services` was misleading. Apps and plugins that DO
// register coins (sui's mock-coin examples, walrus's WAL token, deepbook
// pools that resolve `@reg/<name>` references) go through this typed
// accessor instead.

import type { Token } from '../core/types.js';
import { defineRegistryKind } from './index.js';

/** Typed accessor for the `coin.tokens` registry namespace. Pin the type
 * once at module top-level — call sites read like
 * `coinTokens(ctx.registry).register({ name: 'mUSDC', ... })` and the
 * returned query gives `Token`-typed `find`/`list`/`require`. */
export const coinTokens = defineRegistryKind<Token>('coin.tokens');
