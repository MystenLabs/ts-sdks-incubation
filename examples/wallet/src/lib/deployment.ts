// App-level projection of the devstack manifest. Joins the
// endpoint URLs, the registered mock-coin tokens, and the deepbook
// pools (from `manifest.app.extras.deepbookPools`) into the views the
// wallet UI reads — coin specs (with derived symbols), pool views
// (with base/quote symbols joined), and a flat account map.

import { manifest } from '../generated/manifest.js';

export interface CoinSpec {
	symbol: string;
	coinType: string;
	decimals: number;
}

export interface PoolView {
	alias: string;
	poolId: string;
	baseCoinType: string;
	quoteCoinType: string;
	baseSymbol: string;
	quoteSymbol: string;
}

interface DeepbookPool {
	name: string;
	poolId: string;
	baseCoinType: string;
	quoteCoinType: string;
}

const SUI_COIN: CoinSpec = {
	symbol: 'SUI',
	coinType: '0x2::sui::SUI',
	decimals: 9,
};

const coinsFromTokens: CoinSpec[] = Object.entries(manifest.coins).map(([name, t]) => ({
	symbol: name.toUpperCase(),
	coinType: t.type,
	decimals: t.decimals,
}));

const allCoins: readonly CoinSpec[] = [SUI_COIN, ...coinsFromTokens];

const symbolFor = (coinType: string): string =>
	allCoins.find((c) => c.coinType === coinType)?.symbol ?? coinType.split('::').pop() ?? '?';

const deepbookPoolsExtra = manifest.app.extras.deepbookPools as
	| { pools: DeepbookPool[] }
	| undefined;
const rawPools = deepbookPoolsExtra?.pools ?? [];

const pools: readonly PoolView[] = rawPools.map((p) => ({
	alias: p.name,
	poolId: p.poolId,
	baseCoinType: p.baseCoinType,
	quoteCoinType: p.quoteCoinType,
	baseSymbol: symbolFor(p.baseCoinType),
	quoteSymbol: symbolFor(p.quoteCoinType),
}));

const deepbookPkg = manifest.packages.deepbook;

export const deployment = {
	rpcUrl: manifest.services.sui?.rpc.url ?? '',
	faucetUrl: manifest.services.sui?.faucet?.url,
	accounts: Object.fromEntries(
		Object.entries(manifest.accounts).map(([name, a]) => [name, a.address]),
	),
	coins: allCoins,
	pools,
	deepbookPackageId: deepbookPkg?.id,
	deepbookRegistryId: deepbookPkg?.captured?.registryId,
} as const;

export const isDeployed: boolean = Object.keys(deployment.accounts).length > 0;

export function findCoin(coinType: string): CoinSpec | undefined {
	return allCoins.find((c) => c.coinType === coinType);
}

export type Deployment = typeof deployment;
