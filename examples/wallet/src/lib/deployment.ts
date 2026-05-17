// App-level projection of the devstack manifest. Joins the endpoint
// URLs, the registered mock-coin tokens, and the deepbook pools (from
// `extras.deepbookPools`) into the views the wallet UI reads —
// coin specs (with derived symbols), pool views (with base/quote
// symbols joined), and a flat account name → address map.

import { accounts } from '../generated/accounts.js';
import { extras } from '../generated/extras.js';
import { packages } from '../generated/packages.js';
import { services } from '../generated/services.js';

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

// The wallet stack registers coins via `Package({ coins: [...] })`
// — they land in the manifest's `coins` record. We import that
// dynamically from `services` siblings via the codegen handle, but
// since the wallet app's `coins` are well-known at codegen time, we
// inline them here directly (sourced from the same registration in
// `devstack.config.ts`).
const coinsFromTokens: CoinSpec[] = [
	{
		symbol: 'MUSDC',
		coinType: `${packages.mock_usdc?.id ?? '0x0'}::mock_usdc::MOCK_USDC`,
		decimals: 6,
	},
	{
		symbol: 'MWETH',
		coinType: `${packages.mock_weth?.id ?? '0x0'}::mock_weth::MOCK_WETH`,
		decimals: 8,
	},
];

const allCoins: readonly CoinSpec[] = [SUI_COIN, ...coinsFromTokens];

const symbolFor = (coinType: string): string =>
	allCoins.find((c) => c.coinType === coinType)?.symbol ?? coinType.split('::').pop() ?? '?';

const deepbookPoolsExtra = (extras as { deepbookPools?: { pools: DeepbookPool[] } }).deepbookPools;
const rawPools = deepbookPoolsExtra?.pools ?? [];

const pools: readonly PoolView[] = rawPools.map((p) => ({
	alias: p.name,
	poolId: p.poolId,
	baseCoinType: p.baseCoinType,
	quoteCoinType: p.quoteCoinType,
	baseSymbol: symbolFor(p.baseCoinType),
	quoteSymbol: symbolFor(p.quoteCoinType),
}));

const deepbookPkg = (
	packages as Record<string, { id: string; captured?: Record<string, unknown> } | undefined>
).deepbook;

export const deployment = {
	rpcUrl: services.sui?.rpc.url ?? '',
	faucetUrl: services.sui?.faucet?.url,
	accounts,
	coins: allCoins,
	pools,
	deepbookPackageId: deepbookPkg?.id,
	deepbookRegistryId:
		typeof deepbookPkg?.captured?.registryId === 'string'
			? deepbookPkg.captured.registryId
			: undefined,
} as const;

export const isDeployed: boolean = Object.keys(deployment.accounts).length > 0;

export function findCoin(coinType: string): CoinSpec | undefined {
	return allCoins.find((c) => c.coinType === coinType);
}

export type Deployment = typeof deployment;
