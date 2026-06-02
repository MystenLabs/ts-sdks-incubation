// Prod-safe accessor for the seeded dev-account directory (name → address).
//
// Token Studio's UI renders a labelled directory of the localnet's seeded
// accounts (the Balances table, the mint/transfer recipient pickers, the
// "connected as <name>" label). Those names live in the dev-only
// `@devstack-dev/accounts.js` map, which does NOT exist in a production
// build. This module is the prod-path boundary: it holds the directory in a
// module-level slot that `dapp-kit.dev.ts` fills (DEV only) and exposes a
// stable, empty-by-default view to the rest of the app.
//
// In a production `vite build`, `dapp-kit.dev.ts` is never imported, so the
// slot stays empty and the directory-driven UI simply renders nothing —
// real wallet-standard accounts still connect and transact normally.

import { useSyncExternalStore } from 'react';

export type DevAccounts = Readonly<Record<string, string>>;

let devAccounts: DevAccounts = {};
const subscribers = new Set<() => void>();

/** Called once by `dapp-kit.dev.ts` (DEV only) with the seeded directory. */
export function setDevAccounts(accounts: DevAccounts): void {
	devAccounts = accounts;
	for (const notify of subscribers) notify();
}

function subscribe(onChange: () => void): () => void {
	subscribers.add(onChange);
	return () => {
		subscribers.delete(onChange);
	};
}

/**
 * React hook returning the current seeded-account directory. Empty in prod;
 * populated reactively once the DEV-gated dapp-kit wiring publishes it.
 */
export function useDevAccounts(): DevAccounts {
	return useSyncExternalStore(subscribe, () => devAccounts, () => devAccounts);
}

/** Reverse lookup: address → seeded account name (`null` when unknown). */
export function devAccountLabel(address: string): string | null {
	for (const [name, addr] of Object.entries(devAccounts)) {
		if (addr === address) return name;
	}
	return null;
}
