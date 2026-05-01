// `createLocalSuiClient(url)` — minimal Sui JSON-RPC client for plugin
// actions. Defined in one place so the four example plugins (arena,
// wallet) and built-in plugins (seal) stop redefining it verbatim.

import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import type { Network } from '../core/types.js';

/** Constructs a `SuiJsonRpcClient` against `url`. The `network` label is
 * cosmetic in the client (used for transaction display); defaults to
 * `'localnet'` since plugin code is the primary caller. */
export function createLocalSuiClient(url: string, network: Network = 'localnet'): SuiJsonRpcClient {
	return new SuiJsonRpcClient({ url, network });
}
