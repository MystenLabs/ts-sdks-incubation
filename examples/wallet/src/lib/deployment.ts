// App-level projection of the codegen-emitted typed manifest. Joins the
// service URLs, the registered mock-coin tokens, and the deepbook pools
// into the views the wallet UI reads — coin specs (with derived symbols),
// pool views (with base/quote symbols joined), and a flat account map.

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

interface DeepbookNamespace {
	pools?: ReadonlyArray<{
		name: string;
		poolId: string;
		baseCoinType: string;
		quoteCoinType: string;
	}>;
}

interface CoinNamespace {
	tokens?: ReadonlyArray<{ name: string; type: string; decimals: number }>;
}

const services = manifest.registry.services;
const accounts = manifest.registry.accounts;
const packages = manifest.registry.packages;
const tokens = (manifest.registry.coin as CoinNamespace | undefined)?.tokens ?? [];
const deepbookPools =
	(manifest.registry.deepbook as DeepbookNamespace | undefined)?.pools ?? [];

const accountMap: Record<string, string> = Object.fromEntries(
	accounts.map((a) => [a.name, a.address]),
);

// Native SUI: every Sui network has it before any package is published.
const SUI_COIN: CoinSpec = {
	symbol: 'SUI',
	coinType: '0x2::sui::SUI',
	decimals: 9,
};

const coinsFromTokens: CoinSpec[] = tokens.map((t) => ({
	symbol: t.name.replace(/^m/, 'm').toUpperCase(),
	coinType: t.type,
	decimals: t.decimals,
}));

const allCoins: readonly CoinSpec[] = [SUI_COIN, ...coinsFromTokens];

const symbolFor = (coinType: string): string =>
	allCoins.find((c) => c.coinType === coinType)?.symbol ?? coinType.split('::').pop() ?? '?';

const pools: readonly PoolView[] = deepbookPools.map((p) => ({
	alias: p.name,
	poolId: p.poolId,
	baseCoinType: p.baseCoinType,
	quoteCoinType: p.quoteCoinType,
	baseSymbol: symbolFor(p.baseCoinType),
	quoteSymbol: symbolFor(p.quoteCoinType),
}));

export const deployment = {
	rpcUrl: services.find((s) => s.name === 'sui-rpc')?.url ?? '',
	faucetUrl: services.find((s) => s.name === 'sui-faucet')?.url,
	accounts: accountMap,
	coins: allCoins,
	pools,
	deepbookPackageId: packages.find((p) => p.name === 'deepbook')?.packageId,
} as const;

export const isDeployed: boolean = Object.keys(deployment.accounts).length > 0;

export function findCoin(coinType: string): CoinSpec | undefined {
	return allCoins.find((c) => c.coinType === coinType);
}

export type Deployment = typeof deployment;
