// Sui(opts?) — the canonical sui factory. Collapses the four v3 sui
// factories (suiLocalnet / suiTestnet / suiMainnet / suiCustom) behind
// a single `network` option. Default network is `'localnet'`.
//
// Phase 2 delegates to the existing v3 factories; Phase 6 will inline
// the bodies once the old factories are deleted from the public surface.

import {
	suiCustom,
	suiLocalnet,
	suiMainnet,
	suiTestnet,
	type SuiCustomOptions,
	type SuiLocalnetOptions,
	type SuiMainnetOptions,
	type SuiTestnetOptions,
} from '../primitives/sui.js';
import { withSection } from './ref.js';

export interface SuiOptions {
	/** Which sui network to provide. Defaults to `'localnet'`, which
	 *  spins up a local sui-test-validator container with embedded
	 *  faucet + GraphQL. `'testnet'`/`'mainnet'` produce RPC-only
	 *  handles pointing at the public fullnodes. Pass an object form
	 *  (`{ rpc, faucet? }`) for custom RPC endpoints (corporate fullnodes,
	 *  pinned forks, air-gapped mirrors). */
	readonly network?:
		| 'localnet'
		| 'testnet'
		| 'mainnet'
		| { readonly rpc: string; readonly faucet?: string };

	/** Pass-through extras for the localnet variant. Ignored on testnet /
	 *  mainnet / custom. */
	readonly localnet?: Omit<SuiLocalnetOptions, never>;
	/** Pass-through extras for testnet. */
	readonly testnet?: Omit<SuiTestnetOptions, never>;
	/** Pass-through extras for mainnet. */
	readonly mainnet?: Omit<SuiMainnetOptions, never>;
}

/** The canonical sui factory. Returns a Ref that's both an Effect Layer
 *  and an Effect tag (`yield* Sui` gives the `SuiShape`).
 *
 *  Defaults to localnet. Pass `{ network: 'testnet' }` to switch nets, or
 *  `{ network: { rpc, faucet } }` for a custom RPC. */
export const Sui = (opts: SuiOptions = {}) => {
	const net = opts.network ?? 'localnet';
	if (typeof net === 'object') {
		const customOpts: SuiCustomOptions = {
			rpcUrl: net.rpc,
			...(net.faucet !== undefined ? { faucetUrl: net.faucet } : {}),
		};
		return withSection(suiCustom(customOpts), 'service');
	}
	if (net === 'testnet') return withSection(suiTestnet(opts.testnet ?? {}), 'service');
	if (net === 'mainnet') return withSection(suiMainnet(opts.mainnet ?? {}), 'service');
	return withSection(suiLocalnet(opts.localnet ?? {}), 'service');
};
