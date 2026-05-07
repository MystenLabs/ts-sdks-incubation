// App-level projection of the codegen-emitted typed manifest. Joins the
// service URLs, the registered mock-coin tokens, and the deepbook pools
// into the views the wallet UI reads — coin specs (with derived symbols),
// pool views (with base/quote symbols joined), and a flat account map.

import { defineManifestKind } from '@mysten-incubation/devstack';
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
interface CoinToken {
	name: string;
	type: string;
	decimals: number;
}

const deepbookPoolsKind = defineManifestKind<DeepbookPool>('deepbook.pools');
const coinTokensKind = defineManifestKind<CoinToken>('coin.tokens');

// Native SUI: every Sui network has it before any package is published.
const SUI_COIN: CoinSpec = {
	symbol: 'SUI',
	coinType: '0x2::sui::SUI',
	decimals: 9,
};

const coinsFromTokens: CoinSpec[] = coinTokensKind(manifest).map((t) => ({
	symbol: t.name.replace(/^m/, 'm').toUpperCase(),
	coinType: t.type,
	decimals: t.decimals,
}));

const allCoins: readonly CoinSpec[] = [SUI_COIN, ...coinsFromTokens];

const symbolFor = (coinType: string): string =>
	allCoins.find((c) => c.coinType === coinType)?.symbol ?? coinType.split('::').pop() ?? '?';

const pools: readonly PoolView[] = deepbookPoolsKind(manifest).map((p) => ({
	alias: p.name,
	poolId: p.poolId,
	baseCoinType: p.baseCoinType,
	quoteCoinType: p.quoteCoinType,
	baseSymbol: symbolFor(p.baseCoinType),
	quoteSymbol: symbolFor(p.quoteCoinType),
}));

const deepbookPkg = manifest.registry.packages.find((p) => p.name === 'deepbook');

export const deployment = {
	rpcUrl: manifest.registry.services.find((s) => s.name === 'sui-rpc')?.url ?? '',
	faucetUrl: manifest.registry.services.find((s) => s.name === 'sui-faucet')?.url,
	accounts: Object.fromEntries(manifest.registry.accounts.map((a) => [a.name, a.address])),
	coins: allCoins,
	pools,
	deepbookPackageId: deepbookPkg?.packageId,
	// Captured by the deepbook plugin's publish action — the
	// `Registry` shared object the SDK needs alongside `DEEPBOOK_PACKAGE_ID`
	// to bind pool keys to on-chain pool ids.
	deepbookRegistryId: deepbookPkg?.captured?.['registryId'] as string | undefined,
} as const;

export const isDeployed: boolean = Object.keys(deployment.accounts).length > 0;

export function findCoin(coinType: string): CoinSpec | undefined {
	return allCoins.find((c) => c.coinType === coinType);
}

export type Deployment = typeof deployment;
