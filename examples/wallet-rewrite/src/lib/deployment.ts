// App-level projection of the devstack manifest. Joins the endpoint
// URLs, the registered mock-coin tokens, and a flat account name →
// address map.

import { accounts as generatedAccounts } from '../generated/accounts.js';
import { coins as generatedCoins } from '../generated/coins.js';
import { services } from '../generated/services.js';

export interface CoinSpec {
	symbol: string;
	coinType: string;
	decimals: number;
}

const SUI_COIN: CoinSpec = {
	symbol: 'SUI',
	coinType: '0x2::sui::SUI',
	decimals: 9,
};

const accounts = Object.fromEntries(
	Object.entries(generatedAccounts).map(([name, account]) => [name, account.address]),
) as { readonly [K in keyof typeof generatedAccounts]: (typeof generatedAccounts)[K]['address'] };

const coinsFromDiscovery: CoinSpec[] = Object.entries(generatedCoins).map(([symbol, c]) => ({
	symbol,
	coinType: c.fullCoinType,
	decimals: c.decimals,
}));

const allCoins: readonly CoinSpec[] = [SUI_COIN, ...coinsFromDiscovery];

export const deployment = {
	rpcUrl: services.sui?.rpc.url ?? '',
	faucetUrl: services.sui?.faucet?.url,
	accounts,
	coins: allCoins,
} as const;

export const isDeployed: boolean = Object.keys(deployment.accounts).length > 0;

export function findCoin(coinType: string): CoinSpec | undefined {
	return allCoins.find((c) => c.coinType === coinType);
}

export type Deployment = typeof deployment;
