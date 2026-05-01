// Frontend-facing projection of the devstack manifest. The vite plugin reads
// the active stack's manifest at `.devstack/stacks/<active>/manifest.json`
// and re-exports it as `virtual:devstack-manifest`; this adapter narrows it
// into the keys the UI reads, with empty-shape fallbacks so the app
// renders before the first `localnet:up`.

import { manifest } from './manifest.js';

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

const registry = (manifest as { registry?: unknown }).registry as
	| {
			tokens?: Array<{ name: string; type: string; decimals: number }>;
			services?: Array<{ name: string; url: string }>;
			accounts?: Array<{ name: string; address: string }>;
			packages?: Array<{ name: string; packageId: string }>;
			wallet?: {
				pools?: Array<{
					name: string;
					poolId: string;
					baseCoinType: string;
					quoteCoinType: string;
				}>;
			};
	  }
	| undefined;

const services = registry?.services ?? [];
const accounts = registry?.accounts ?? [];
const packages = registry?.packages ?? [];
const tokens = registry?.tokens ?? [];
const walletPools = registry?.wallet?.pools ?? [];

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

const pools: readonly PoolView[] = walletPools.map((p) => ({
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
	accounts: accountMap as Record<string, string>,
	coins: allCoins,
	pools,
	deepbookPackageId: packages.find((p) => p.name === 'deepbook')?.packageId,
	publishedAt: manifest.emittedAt ?? '',
} as const;

export const isDeployed: boolean = Object.keys(deployment.accounts).length > 0;

export function findCoin(coinType: string): CoinSpec | undefined {
	return allCoins.find((c) => c.coinType === coinType);
}

export type Deployment = typeof deployment;
