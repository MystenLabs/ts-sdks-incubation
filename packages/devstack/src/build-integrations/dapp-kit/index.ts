// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0
//
// dApp Kit test bridge — registers an app's dApp Kit instance so the Playwright
// `connectAs` helper can drive a REAL connection during e2e.
//
// This is a TESTING feature, not an app feature. The app calls
// `registerDAppKitForTesting(dAppKit)` DEV-only (it is a no-op consumer in
// production: a `vite build` strips the `import.meta.env.DEV` branch and the
// dev wallet is never injected). It performs NO connection on its own — the app
// loads disconnected, dApp Kit's own `autoConnect` only re-connects a genuine
// prior session, and an actual connection happens solely when a test calls the
// published slot.
//
// The connection goes through dApp Kit's public API (`connectWallet` /
// `switchAccount`) — no localStorage seeding, no narrowing/widening the
// wallet's exposed accounts.
//
// Browser-safe: this module (and the `dapp-kit-slot` contract it imports) must
// never pull in `node:*` — it is bundled into app pages by Vite.

import { DAPP_KIT_SLOT_KEY, type DAppKitSlot } from '../runtime/dapp-kit-slot.ts';

/** A wallet-standard account as surfaced by dApp Kit. The dev wallet sets each
 *  account's `label` to its devstack account name (`alice`, `bob`, …). */
interface UiWalletAccountLike {
	readonly address: string;
	readonly label?: string;
}

interface UiWalletLike {
	readonly name: string;
	readonly accounts: readonly UiWalletAccountLike[];
}

/**
 * The slice of a dApp Kit instance this bridge drives, generic over the app's
 * concrete wallet type `W` (inferred from `$wallets`). The account type is
 * DERIVED as `W['accounts'][number]` rather than inferred separately, so the
 * objects pulled from `$wallets` flow back into `connectWallet` /
 * `switchAccount` as their real (branded `UiWallet` / `UiWalletAccount`) types
 * — a structural stand-in is not assignable to dApp Kit's branded parameters.
 * The app passes its real `createDAppKit(...)` return value and `W` is inferred.
 */
export interface TestableDAppKit<W extends UiWalletLike> {
	connectWallet(args: { wallet: W; account: W['accounts'][number] }): Promise<unknown>;
	switchAccount(args: { account: W['accounts'][number] }): void;
	readonly stores: {
		readonly $wallets: { get(): readonly W[] };
		readonly $connection: {
			get(): { readonly isConnected: boolean; readonly wallet: { readonly name: string } | null };
		};
	};
}

/** How long `selectAccount` waits for the dev wallet (and the requested
 *  account) to register before giving up — the wallet comes up asynchronously,
 *  so a `connectAs(...)` fired right after page load may beat it. */
const RESOLVE_TIMEOUT_MS = 10_000;
const RESOLVE_POLL_MS = 50;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Register `dAppKit` with the `globalThis.__devstackDAppKit__` test slot that
 * Playwright's `connectAs` / `selectAccount` helpers drive. Call once, DEV-only,
 * after `createDAppKit(...)`:
 *
 * ```ts
 * export const dAppKit = createDAppKit({ ... });
 * if (import.meta.env.DEV) registerDAppKitForTesting(dAppKit);
 * ```
 *
 * The published `selectAccount` performs a real connection: if already connected
 * to the dev wallet it switches the active account; otherwise it connects,
 * selecting the requested account. Account names resolve to the dev wallet's
 * wallet-standard accounts by `label` (the devstack account name).
 */
export function registerDAppKitForTesting<W extends UiWalletLike>(
	dAppKit: TestableDAppKit<W>,
): void {
	const resolveLabelledAccount = async (
		accountName: string,
	): Promise<{ wallet: W; account: W['accounts'][number] } | null> => {
		const deadline = Date.now() + RESOLVE_TIMEOUT_MS;
		for (;;) {
			for (const wallet of dAppKit.stores.$wallets.get()) {
				const account = wallet.accounts.find((candidate) => candidate.label === accountName);
				if (account !== undefined) return { wallet, account };
			}
			if (Date.now() >= deadline) return null;
			await sleep(RESOLVE_POLL_MS);
		}
	};

	const selectAccount = async (accountName: string): Promise<void> => {
		const found = await resolveLabelledAccount(accountName);
		if (found === null) {
			throw new Error(
				`connectAs("${accountName}"): no dev-wallet account labelled "${accountName}" ` +
					`registered within ${RESOLVE_TIMEOUT_MS}ms. Confirm the dev wallet is injected ` +
					`and the account name exists.`,
			);
		}
		const { wallet, account } = found;
		const connection = dAppKit.stores.$connection.get();
		if (connection.isConnected && connection.wallet?.name === wallet.name) {
			// Already connected to the dev wallet — just switch the active account.
			dAppKit.switchAccount({ account });
			return;
		}
		await dAppKit.connectWallet({ wallet, account });
	};

	(globalThis as { [DAPP_KIT_SLOT_KEY]?: DAppKitSlot }).__devstackDAppKit__ = { selectAccount };
}
