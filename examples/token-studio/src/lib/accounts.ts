// Connected-wallet account directory.
//
// Token Studio's UI renders a labelled directory of accounts (the Balances
// table, the mint/transfer recipient pickers, the "connected as <name>"
// label). That directory is simply the accounts the CONNECTED WALLET
// exposes to the dApp, read straight from dApp Kit — no injected global.
//
// In DEV the devstack dev wallet exposes its seeded accounts (alice / bob /
// carol), each carrying `label` = the devstack account name and `address`.
// In production a real wallet exposes whatever account(s) the user
// authorized; the same UI renders them with their wallet-provided labels.
// When no wallet is connected the list is empty and the directory-driven UI
// renders nothing.

import { useCurrentWallet } from '@mysten/dapp-kit-react';

/** A single account from the connected wallet: its address and a friendly
 *  label (the devstack account name in DEV; the wallet's label otherwise,
 *  falling back to the address when the wallet provides none). */
export interface ConnectedAccount {
	readonly name: string;
	readonly address: string;
}

/**
 * The connected wallet's full account list, in wallet order. Empty when no
 * wallet is connected. The dev wallet exposes ALL its seeded accounts (it
 * does not narrow to the active one), so this lists alice / bob / carol.
 */
export function useConnectedAccounts(): ConnectedAccount[] {
	const wallet = useCurrentWallet();
	if (!wallet) return [];
	return wallet.accounts.map((account) => ({
		name: account.label ?? account.address,
		address: account.address,
	}));
}

/** Friendly label for `address` among the connected accounts (`null` when
 *  unknown). Hook form — derives from the connected wallet's account list. */
export function useAccountLabel(address: string | null | undefined): string | null {
	const accounts = useConnectedAccounts();
	if (!address) return null;
	return accounts.find((a) => a.address === address)?.name ?? null;
}
