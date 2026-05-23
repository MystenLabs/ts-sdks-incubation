// User-owned dapp-kit wiring. Devstack generates the wallet URL/pair token;
// this app owns the Sui client and wallet-standard adapter construction.

import { createDAppKit } from '@mysten/dapp-kit-react';
import { devWalletInitializer } from '@mysten-incubation/dev-wallet';
import { DevstackSignerAdapter, parseDevstackToken } from '@mysten-incubation/dev-wallet/adapters';
import { SuiGrpcClient } from '@mysten/sui/grpc';

import { accounts } from './generated/accounts.js';
import { dappKitConfig } from './generated/dapp-kit/config.js';
import { suiNetwork } from './generated/sui/network.js';

const deepbookNetwork = 'localnet' as const;
const autoApprove = import.meta.env.VITE_DEEPBOOK_TRADER_AUTO_APPROVE === '1';

export const dAppKit = createDAppKit({
	networks: [deepbookNetwork],
	defaultNetwork: deepbookNetwork,
	createClient() {
		return new SuiGrpcClient({
			network: deepbookNetwork,
			baseUrl: suiNetwork.rpcUrl,
		});
	},
	walletInitializers: [
		devWalletInitializer({
			adapters: [
				new DevstackSignerAdapter({
					serverOrigin: dappKitConfig.walletUrl,
					token: parseDevstackToken(dappKitConfig.pairUrl),
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
	publisher: accounts.publisher.address,
	trader: accounts.trader.address,
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
