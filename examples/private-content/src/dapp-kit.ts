// User-owned dapp-kit wiring. The generated devstack config provides
// the wallet URL/pair token; the app owns client construction.

import { createDAppKit } from '@mysten/dapp-kit-react';
import { devWalletInitializer } from '@mysten-incubation/dev-wallet';
import { DevstackSignerAdapter, parseDevstackToken } from '@mysten-incubation/dev-wallet/adapters';
import { SuiGrpcClient } from '@mysten/sui/grpc';

import { config } from '@generated/config.js';
import { accounts } from '@devstack-dev/accounts.js';
import { devWallet } from '@devstack-dev/dev-wallet.js';

const devstackNetwork = 'localnet' as const;
const autoApprove = import.meta.env.VITE_PRIVATE_CONTENT_AUTO_APPROVE === '1';

export const dAppKit = createDAppKit({
	networks: [devstackNetwork],
	defaultNetwork: devstackNetwork,
	createClient() {
		return new SuiGrpcClient({
			network: devstackNetwork,
			baseUrl: config.networks[config.network].rpc,
		});
	},
	walletInitializers: [
		devWalletInitializer({
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
		}),
	],
});

const accountAddressByName: Record<string, string> = {
	alice: accounts.alice.address,
	bob: accounts.bob.address,
	publisher: accounts.publisher.address,
};

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

// Expose the narrow slot contract the Playwright `connectAs` helper consumes.
(
	globalThis as { __devstackDAppKit__?: { selectAccount?: typeof selectAccount } }
).__devstackDAppKit__ = { selectAccount };

declare module '@mysten/dapp-kit-react' {
	interface Register {
		dAppKit: typeof dAppKit;
	}
}
