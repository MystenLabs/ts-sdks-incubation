// App-level projection of the devstack manifest. Joins the endpoint
// URLs, the codegen-emitted `deepbookConfig` (Phase 5), and the
// per-account address map into the views the UI reads.

import { accounts } from '../generated/accounts.js';
import { deepbookConfig } from '../generated/deepbook-config.js';
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

const decimalsFromScalar = (scalar: number): number => Math.round(Math.log10(scalar));

const coinsFromConfig: CoinSpec[] = Object.entries(deepbookConfig.coins)
	.filter(([symbol]) => symbol !== 'SUI')
	.map(([symbol, c]) => ({
		symbol,
		coinType: c.type,
		decimals: decimalsFromScalar(c.scalar),
	}));

export const allCoins: readonly CoinSpec[] = [SUI_COIN, ...coinsFromConfig];

// Deepbook server REST URL — surfaced through the manifest's
// `services.deepbook.server.rest` slot. May be `undefined` on cold boot
// before the server's container is reachable; consumers gate UI on
// presence.
const serverRest = (
	services as unknown as {
		deepbook?: { server?: { rest?: { url: string } } };
	}
).deepbook?.server?.rest?.url;

export const deployment = {
	rpcUrl: services.sui?.rpc.url ?? '',
	faucetUrl: services.sui?.faucet?.url,
	deepbookRestUrl: serverRest,
	accounts,
	coins: allCoins,
} as const;

export function findCoin(coinType: string): CoinSpec | undefined {
	return allCoins.find((c) => c.coinType === coinType);
}

export type Deployment = typeof deployment;
