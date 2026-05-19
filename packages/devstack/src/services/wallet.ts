// Wallet(opts) — the dev-only signing-server UI. Thin facade over
// `walletApp(...)`. The plan's "always explicit" rule lives here:
// `devstack(...)` does NOT auto-mount a wallet; users opt in by
// constructing this ref and passing it to `devstack(...)`.
//
// Singleton: one wallet per stack. The tag name is the canonical
// `EndpointName.WALLET_APP` ('wallet-app'). Multiple wallets per stack
// are not supported; use separate stacks for separate wallet UIs.

import { walletApp, type WalletAppOptions } from './wallet/internal.js';
import type { Account } from '../engine/shared.js';
import type { LayeredTag } from '../advanced/tag.js';

export interface WalletOptions {
	/** Account refs whose signers the wallet UI exposes. Each is yielded
	 *  for ordering so accounts are funded before the wallet accepts
	 *  signing requests. */
	readonly accounts: ReadonlyArray<LayeredTag<any, Account, any, any>>;
	/** Extra CORS origins, on top of the auto-derived
	 *  `http://dev.<app>.localhost` and `http://localhost`. */
	readonly allowedOrigins?: ReadonlyArray<string>;
	/** Preferred host port. Defaults to 5180. */
	readonly port?: number;
	/** Interface to bind. Defaults to the security-hardened `'127.0.0.1'` loopback. */
	readonly bindAddress?: string;
}

/** Wallet UI factory. Singleton — one per stack. Returns a LayeredTag
 *  pinned to the canonical `EndpointName.WALLET_APP` tag name. */
export const Wallet = (opts: WalletOptions) => {
	const walletOpts: WalletAppOptions = {
		accounts: opts.accounts,
		...(opts.allowedOrigins !== undefined ? { allowedOrigins: opts.allowedOrigins } : {}),
		...(opts.port !== undefined ? { port: opts.port } : {}),
		...(opts.bindAddress !== undefined ? { bindAddress: opts.bindAddress } : {}),
	};
	return Object.assign(walletApp(walletOpts), { __kind: 'app' as const, __pluginName: 'wallet' });
};
