// Typed contract for the `globalThis.__devstackDAppKit__` side-channel.
//
// One module owns the slot literal, the typed shape, the global
// augmentation, and the typed accessors — Vite, Playwright, browser-
// mode vitest, and codegen all key off this single source. Living in
// `runtime/` (the canonical L5 read-side substrate) is the right home;
// the slot is consumed equally by Vite (config + plugin), Playwright
// (in-spec `selectAccount`), and the browser preset (setup file), so
// putting it under any one integration would force the others to
// cross-import an integration-specific module.
//
// This module evaluates in the browser bundle AND in the Node process
// of build-integration callers. Discipline: no `node:*` imports here.

/** The literal property name on `globalThis` that the app writes the
 *  kit handle to. Renames here cascade through every consumer
 *  (Playwright config-load, in-spec helpers, app-side dapp-kit-config
 *  emit). The slot's name is part of the contract. */
export const DAPP_KIT_SLOT_KEY = '__devstackDAppKit__' as const;

/**
 * Typed shape of the slot. The app's codegen-emitted
 * `dapp-kit-config.ts` writes this shape into the global slot; in-spec
 * helpers (Playwright `selectAccount`, browser-mode tests) read it.
 *
 * Only the load-bearing fields the wallet + Playwright helpers already
 * need are typed here. Future fields (network switcher, custom-element
 * panel handles, snapshot-restore listener) extend the shape; the
 * codegen emitter and this module move in lockstep.
 */
export interface DAppKitSlot {
	/** Stable identity for the slot — confirms the writer agrees on
	 *  contract version. Bumped only on breaking shape changes. */
	readonly slotVersion: 1;
	/** Identity tuple lifted from the manifest envelope. The
	 *  in-spec helper uses this to assert it's talking to the
	 *  expected stack. */
	readonly identity: {
		readonly app: string;
		readonly stack: string;
		readonly chain: string;
	};
	/** Endpoints the app's UI needs at module init (RPC, faucet,
	 *  wallet, walrus). Keyed by endpoint name. */
	readonly endpoints: Readonly<Record<string, { readonly url: string }>>;
	/** Architecture flags surfaced to the app's runtime — purely for
	 *  feature gating (e.g. `wallet.devLabel`). The opaque type lets
	 *  the codegen emitter ship typed projections this contract
	 *  doesn't dictate. */
	readonly flags: Readonly<Record<string, unknown>>;
	/**
	 * Account switcher entry point — populated by the codegen-emitted
	 * dapp-kit module. Playwright's `selectAccount` calls this. Optional
	 * because the slot contract version 1 ships without account switching
	 * for apps that don't wire the dev-wallet; future contract versions
	 * may promote it to required.
	 */
	readonly selectAccount?: (accountName: string) => void | Promise<void>;
}

declare global {
	// eslint-disable-next-line no-var
	var __devstackDAppKit__: DAppKitSlot | undefined;
}

/** Read the slot. Returns `undefined` when the app hasn't loaded its
 *  dapp-kit module yet. Callers handle both arms — pre-init access
 *  is legal during HMR and during a Playwright `connectAs` that
 *  races the page's onload. */
export const readDAppKitSlot = (): DAppKitSlot | undefined =>
	(globalThis as unknown as Record<string, DAppKitSlot | undefined>)[DAPP_KIT_SLOT_KEY];

/** Write the slot. Used by the codegen-emitted `dapp-kit-config.ts`
 *  module and by the browser-mode setup file. Idempotent — re-writes
 *  replace the value, do not merge. HMR-safe: writing during a hot
 *  update fires no observers, so the app's React tree picks up the
 *  new value on next render. */
export const writeDAppKitSlot = (value: DAppKitSlot): void => {
	(globalThis as unknown as Record<string, DAppKitSlot>)[DAPP_KIT_SLOT_KEY] = value;
};

/** Clear the slot. Used by Playwright teardown when re-running a
 *  spec; surfaced here so test teardown doesn't reach into the
 *  global scope directly. */
export const clearDAppKitSlot = (): void => {
	delete (globalThis as unknown as Record<string, unknown>)[DAPP_KIT_SLOT_KEY];
};
