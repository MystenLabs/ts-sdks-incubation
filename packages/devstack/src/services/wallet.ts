// Wallet(opts) — the dev-only signing-server UI. Thin facade over
// `walletApp(...)`. The plan's "always explicit" rule lives here:
// `devstack(...)` does NOT auto-mount a wallet; users opt in by
// constructing this ref and passing it to `devstack(...)`.
//
// Singleton: one wallet per stack. The tag name is the canonical
// `EndpointName.WALLET_APP` ('wallet-app'). Multiple wallets per stack
// are not supported; use separate stacks for separate wallet UIs.
//
// **Lifecycle classification** (post-launch sweep §3.7 / P7):
//   - **Ambient:** NO. Explicit opt-in only — `devstack(...)` never
//     auto-mounts a wallet; users construct `Wallet({...})` and pass
//     it as a ref (contrast: `Faucet`, which IS ambient).
//   - **Cardinality:** singleton per stack, pinned to the canonical
//     `EndpointName.WALLET_APP` tag name.
//   - **Process model:** long-lived host process (not a docker
//     container). A Node `http.Server` binds on the loopback port for
//     the duration of the surrounding scope; a traefik file-provider
//     YAML fronts it under a stack-scoped `*.localhost` hostname.
//   - **Per-cycle vs long-lived state:** the HTTP listener, the
//     allocator-held port, and the file-provider YAML are **per-cycle**
//     (acquired/released by scope finalizers — see `wallet.test.ts`
//     pinning EADDRINUSE-free teardown). The pairing **token** is
//     **long-lived** across cycles: it's persisted under the state-
//     store at `wallet/token` and re-read on warm starts and snapshot
//     restores so browser-side pairings the user already completed
//     keep working without a re-pair UX.
//   - **Snapshot participation:** persists the token file only; the
//     HTTP server, allocator-held port, and traefik file-provider are
//     re-derived on resume.

import { walletApp, type WalletAppOptions } from './wallet/internal.js';
import type { Account } from '../engine/shared.js';
import type { LayeredTag } from '../advanced/tag.js';
import { makeService } from '../advanced/make-service.js';

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
	return makeService('wallet', 'app', walletApp(walletOpts));
};
