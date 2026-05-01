import type { ClientWithCoreApi } from '@mysten/sui/client';
import { type DevWalletChain, registerDevWallet } from './wallet.js';

export interface DevWalletConfig {
	label: string;
	secretKey: string;
}

/** Register a fixed set of dev wallets against a known client. */
export function registerDevWallets(args: {
	client: ClientWithCoreApi;
	wallets: readonly DevWalletConfig[];
	chain?: DevWalletChain;
}): () => void {
	const offs = args.wallets.map((w) =>
		registerDevWallet({
			label: w.label,
			secretKey: w.secretKey,
			client: args.client,
			chain: args.chain,
		}),
	);
	return () => {
		for (const off of offs) off();
	};
}

/**
 * Build a dapp-kit `WalletInitializer` that registers the given wallets at the
 * moment dApp Kit boots. The initializer pulls the active client from the kit
 * itself, so wallets always sign against whichever network the app is on.
 */
export function createDevWalletInitializer(args: {
	id?: string;
	wallets: readonly DevWalletConfig[];
	chain?: DevWalletChain;
}) {
	return {
		id: args.id ?? 'dev-wallets',
		initialize: (input: { getClient: (network?: string) => ClientWithCoreApi }) => {
			const off = registerDevWallets({
				client: input.getClient(),
				wallets: args.wallets,
				chain: args.chain,
			});
			return { unregister: off };
		},
	};
}
