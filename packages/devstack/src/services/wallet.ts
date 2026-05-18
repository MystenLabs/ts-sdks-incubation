// Wallet(opts) — the dev-only signing-server UI. Thin facade over
// `walletApp(...)`. The plan's "always explicit" rule lives here:
// `devstack(...)` does NOT auto-mount a wallet; users opt in by
// constructing this ref and passing it to `devstack(...)`.

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
	/** Override tag name. Defaults to `'wallet-app'`. */
	readonly name?: string;
}

/** Wallet UI factory. Returns a LayeredTag. */
export const Wallet = (opts: WalletOptions) => {
	const walletOpts: WalletAppOptions<string> = {
		accounts: opts.accounts,
		...(opts.allowedOrigins !== undefined ? { allowedOrigins: opts.allowedOrigins } : {}),
		...(opts.port !== undefined ? { port: opts.port } : {}),
		...(opts.bindAddress !== undefined ? { bindAddress: opts.bindAddress } : {}),
		...(opts.name !== undefined ? { name: opts.name } : {}),
	};
	return Object.assign(walletApp(walletOpts), { __kind: 'app' as const });
};
