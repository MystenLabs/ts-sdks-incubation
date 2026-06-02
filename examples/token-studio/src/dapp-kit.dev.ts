// Dev-only dapp-kit wiring. NEVER imported in a production bundle:
// `dapp-kit.ts` reaches this module exclusively through a dynamic import
// gated on `import.meta.env.DEV`, so the gitignored `@devstack-dev/*`
// modules (which only exist after a local `devstack apply`) stay out of
// the prod graph.
//
// Three responsibilities:
//   1. Build the real devstack dev-wallet initializer from the generated
//      wallet endpoint + pair token.
//   2. Populate the `globalThis.__devstackDAppKit__.selectAccount` slot the
//      Playwright `connectAs` helper drives, using the dev-only `accounts`
//      name→address map.
//   3. Publish the same seeded-accounts directory on the dev slot so the
//      prod-safe `./lib/dev-accounts.ts` accessor can surface the labelled
//      balances/recipient pickers in DEV without any prod-path module
//      importing `@devstack-dev/*`.

import { devWalletInitializer } from '@mysten-incubation/dev-wallet';
import { DevstackSignerAdapter, parseDevstackToken } from '@mysten-incubation/dev-wallet/adapters';

import { accounts } from '@devstack-dev/accounts.js';
import { devWallet } from '@devstack-dev/dev-wallet.js';
import { dAppKit } from './dapp-kit.js';
import { setDevAccounts } from './lib/dev-accounts.js';

const autoApprove = import.meta.env.VITE_TOKEN_STUDIO_AUTO_APPROVE === '1';

/**
 * Construct the devstack dev-wallet initializer. Called by the lazy
 * wrapper in `dapp-kit.ts` the first time the kit initializes its wallets.
 * Wiring the `connectAs` slot + accounts directory here (rather than at
 * construction) keeps the accounts map and the dev wallet entirely out of
 * the prod bundle.
 */
export async function createDevWalletInitializer() {
	publishDevAccounts();
	wireConnectAsSlot();
	return devWalletInitializer({
		adapters: [
			new DevstackSignerAdapter({
				serverOrigin: devWallet.walletUrl,
				token: parseDevstackToken(devWallet.pairUrl),
				name: 'Devstack',
			}),
		],
		autoConnect: true,
		autoApprove,
		createInitialAccount: false,
		mountUI: true,
	});
}

const accountAddressByName: Record<string, string> = {
	alice: accounts.alice.address,
	bob: accounts.bob.address,
	carol: accounts.carol.address,
};

/** Hand the seeded-accounts directory to the prod-safe accessor (DEV only). */
function publishDevAccounts(): void {
	setDevAccounts(accountAddressByName);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const withWalletStoreMounted = async <T>(run: () => Promise<T>): Promise<T> => {
	const unlisten = dAppKit.stores.$wallets.listen(() => {});
	try {
		return await run();
	} finally {
		unlisten();
	}
};

const findDevWalletAccount = async (accountName: string) => {
	const address = accountAddressByName[accountName];
	if (address === undefined) {
		throw new Error(
			`Unknown devstack account "${accountName}". Available: ${Object.keys(
				accountAddressByName,
			).join(', ')}`,
		);
	}

	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		for (const wallet of dAppKit.stores.$wallets.get()) {
			const account = wallet.accounts.find(
				(candidate) => candidate.address.toLowerCase() === address.toLowerCase(),
			);
			if (account !== undefined) return { wallet, account };
		}
		await sleep(50);
	}

	throw new Error(`Dev Wallet account "${accountName}" (${address}) was not registered`);
};

const selectAccount = async (accountName: string) => {
	await withWalletStoreMounted(async () => {
		const { wallet, account } = await findDevWalletAccount(accountName);
		const connection = dAppKit.stores.$connection.get();
		if (connection.wallet === null) {
			await dAppKit.connectWallet({ wallet, account });
			return;
		}
		dAppKit.switchAccount({ account });
	});
};

/** Expose the narrow slot contract the Playwright `connectAs` helper consumes. */
function wireConnectAsSlot(): void {
	(
		globalThis as { __devstackDAppKit__?: { selectAccount?: typeof selectAccount } }
	).__devstackDAppKit__ = { selectAccount };
}
