// App-level projection of the devstack manifest. Joins the endpoint
// URLs, the registered mock-coin tokens, and the deepbook pools (now
// sourced from the codegen-emitted `deepbookConfig`) into the views the
// wallet UI reads — coin specs (with derived symbols), pool views (with
// base/quote symbols joined), and a flat account name → address map.
//
// Phase 5 of the deepbook plugin expansion moved the deepbook pool +
// coin + packageIds projection from the hand-written `extras.deepbookPools`
// shape into the codegen-emitted `generated/deepbook-config.ts`. This
// file consumes `deepbookConfig` directly — no more manifest-traversal
// dance for pool ids or treasury caps. See
// packages/devstack/notes/deepbook-plugin-expansion.md § P5.13.

import { accounts } from '../generated/accounts.js';
import { deepbookConfig } from '../generated/deepbook-config.js';
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

const SUI_COIN: CoinSpec = {
	symbol: 'SUI',
	coinType: '0x2::sui::SUI',
	decimals: 9,
};

// The wallet stack registers coins automatically via `Package(...)`
// coin auto-discovery — they land in the manifest's `coins` record.
// Decimals aren't on `deepbookConfig.coins` (the SDK uses `scalar`
// instead, which is `10^decimals`), so we derive
// `decimals = log10(scalar)` for the wallet UI's formatting needs.
const decimalsFromScalar = (scalar: number): number => Math.round(Math.log10(scalar));

const coinsFromConfig: CoinSpec[] = Object.entries(deepbookConfig.coins)
	.filter(([symbol]) => symbol !== 'SUI')
	.map(([symbol, c]) => ({
		symbol,
		coinType: c.type,
		decimals: decimalsFromScalar(c.scalar),
	}));

const allCoins: readonly CoinSpec[] = [SUI_COIN, ...coinsFromConfig];

// `deepbookConfig.pools` is alias-keyed with `{address, baseCoin, quoteCoin}`
// where `baseCoin` / `quoteCoin` are SDK symbol keys. Map them back to
// fully-qualified Move types for the wallet UI's per-pool balance row
// lookups.
const pools: readonly PoolView[] = Object.entries(deepbookConfig.pools).map(
	([alias, p]: [string, { address: string; baseCoin: string; quoteCoin: string }]) => {
		const baseCoin = (deepbookConfig.coins as Record<string, { type: string }>)[p.baseCoin];
		const quoteCoin = (deepbookConfig.coins as Record<string, { type: string }>)[p.quoteCoin];
		return {
			alias,
			poolId: p.address,
			baseCoinType: baseCoin?.type ?? '',
			quoteCoinType: quoteCoin?.type ?? '',
			baseSymbol: p.baseCoin,
			quoteSymbol: p.quoteCoin,
		};
	},
);

const deepbookPkg = (
	packages as Record<string, { id: string; captured?: Record<string, unknown> } | undefined>
).deepbook;

export const deployment = {
	rpcUrl: services.sui?.rpc.url ?? '',
	faucetUrl: services.sui?.faucet?.url,
	accounts,
	coins: allCoins,
	pools,
	deepbookPackageId: deepbookPkg?.id ?? deepbookConfig.packageIds.DEEPBOOK_PACKAGE_ID,
	deepbookRegistryId: deepbookConfig.packageIds.REGISTRY_ID,
} as const;

export const isDeployed: boolean = Object.keys(deployment.accounts).length > 0;

export function findCoin(coinType: string): CoinSpec | undefined {
	return allCoins.find((c) => c.coinType === coinType);
}

export type Deployment = typeof deployment;
