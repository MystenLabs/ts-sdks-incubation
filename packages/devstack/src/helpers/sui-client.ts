// Sui JSON-RPC client constructors for plugin actions. Two entry
// points:
//
//   `createLocalSuiClient(url, network?)` — bare constructor, useful
//   when the caller has the URL in hand (e.g. arena's e2e fixture).
//
//   `openSuiRpcClient(ctx)` — the common case in plugin run/getStatus
//   bodies: pulls the URL out of `ctx.registry.services.require('sui-
//   rpc')` and passes `ctx.network`. Replaces the ~9-site copy of
//   `createLocalSuiClient(ctx.registry.services.require('sui-rpc').
//   url, ctx.network)` that DRY-flagged in the project review.

import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import type { ActionRunContext, Network } from '../core/types.js';

/** Constructs a `SuiJsonRpcClient` against `url`. The `network` label is
 * cosmetic in the client (used for transaction display); defaults to
 * `'localnet'` since plugin code is the primary caller. */
export function createLocalSuiClient(url: string, network: Network = 'localnet'): SuiJsonRpcClient {
	return new SuiJsonRpcClient({ url, network });
}

/** Resolve the action's sui-rpc service URL + network, return a ready
 * `SuiJsonRpcClient`. Throws if no `sui-rpc` service is registered. */
export function openSuiRpcClient(ctx: ActionRunContext): SuiJsonRpcClient {
	return createLocalSuiClient(ctx.registry.services.require('sui-rpc').url, ctx.network);
}
