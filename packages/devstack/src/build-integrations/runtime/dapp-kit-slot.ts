// Typed contract for the `globalThis.__devstackDAppKit__` test bridge.
//
// This is intentionally narrow: app code writes only the account
// switcher Playwright needs. It is not a place to stash the full
// dAppKit instance or manifest projection.
//
// This module evaluates in browser bundles and in Node build
// integration callers. Discipline: no `node:*` imports here.

/** The literal property name on `globalThis` that the app writes the
 *  kit handle to. Renames here cascade through every consumer
 *  (Playwright config-load, in-spec helpers, app-side dapp-kit
 *  emit). The slot's name is part of the contract. */
export const DAPP_KIT_SLOT_KEY = '__devstackDAppKit__' as const;

export interface DAppKitSlot {
	/** Account switcher entry point consumed by Playwright's
	 *  `connectAs` / `selectAccount` helpers. App dev-account UIs do NOT
	 *  read accounts from this slot — they read the connected wallet's
	 *  account list directly from dApp Kit (each account's `label` is the
	 *  devstack account name). */
	readonly selectAccount?: (accountName: string) => void | Promise<void>;
	/** Network switcher entry point consumed by Playwright's `switchNetwork`
	 *  helper. Calls dApp Kit's public `switchNetwork(network)` — the same
	 *  bridge mechanism as `selectAccount`, one level over (network instead of
	 *  account). The dev wallet stays registered across the switch; only the
	 *  active network/client changes. */
	readonly switchNetwork?: (network: string) => void | Promise<void>;
	/** Reads dApp Kit's current network name (`stores.$currentNetwork`) so the
	 *  helper can assert the switch took effect. */
	readonly currentNetwork?: () => string;
}

declare global {
	// eslint-disable-next-line no-var
	var __devstackDAppKit__: DAppKitSlot | undefined;
}
