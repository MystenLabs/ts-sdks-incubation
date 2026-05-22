import {
	DeepBookClient,
	testnetCoins,
	testnetPackageIds,
	testnetPools,
	type Level2TicksFromMid,
	type PoolBookParams,
	type PoolTradeParams,
	type VaultBalances,
} from '@mysten/deepbook-v3';
import { getJsonRpcFullnodeUrl, SuiJsonRpcClient } from '@mysten/sui/jsonRpc';

import { deployment } from './deployment.js';
import { KNOWN_DEEPBOOK_TESTNET } from './known-testnet.js';

export { formatAge, formatNumber, formatPercent, shortId } from './format.js';

export const MARKET_KEYS = ['SUI_DBUSDC', 'DEEP_DBUSDC', 'DEEP_SUI', 'WAL_DBUSDC'] as const;
export type MarketKey = (typeof MARKET_KEYS)[number];

export interface MarketRow {
	readonly key: MarketKey;
	readonly baseCoin: string;
	readonly quoteCoin: string;
	readonly poolId: string;
	readonly baseType: string;
	readonly quoteType: string;
}

export type QueryProbe<T> =
	| {
			readonly status: 'ok';
			readonly value: T;
	  }
	| {
			readonly status: 'error';
			readonly message: string;
	  };

export interface PythPriceProbe {
	readonly coinKey: string;
	readonly feedId: string;
	readonly priceInfoObjectId: string;
	readonly arrivalTimeSeconds: number;
	readonly ageSeconds: number;
}

export interface MarketSnapshot {
	readonly market: MarketRow;
	readonly completedAt: string;
	readonly packageId: string;
	readonly registryId: string;
	readonly pythStateId: string;
	readonly poolId: QueryProbe<string>;
	readonly registered: QueryProbe<boolean>;
	readonly midPrice: QueryProbe<number>;
	readonly vaultBalances: QueryProbe<VaultBalances>;
	readonly tradeParams: QueryProbe<PoolTradeParams>;
	readonly bookParams: QueryProbe<PoolBookParams>;
	readonly orderBook: QueryProbe<Level2TicksFromMid>;
	readonly pythPrices: ReadonlyArray<QueryProbe<PythPriceProbe>>;
}

export const marketRows: ReadonlyArray<MarketRow> = MARKET_KEYS.map((key) => {
	const pool = testnetPools[key];
	if (!pool) throw new Error(`Missing DeepBook testnet pool: ${key}`);
	const base = testnetCoins[pool.baseCoin];
	const quote = testnetCoins[pool.quoteCoin];
	if (!base) throw new Error(`Missing DeepBook testnet coin: ${pool.baseCoin}`);
	if (!quote) throw new Error(`Missing DeepBook testnet coin: ${pool.quoteCoin}`);

	return {
		key,
		baseCoin: pool.baseCoin,
		quoteCoin: pool.quoteCoin,
		poolId: pool.address,
		baseType: base.type,
		quoteType: quote.type,
	};
});

export const bindingHealth = {
	packageMatchesSdk: deployment.deepbook.packageId === KNOWN_DEEPBOOK_TESTNET.packageId,
	registryMatchesSdk: deployment.deepbook.registryId === KNOWN_DEEPBOOK_TESTNET.registryId,
	pythMatchesSdk:
		deployment.deepbook.pyth?.stateId === KNOWN_DEEPBOOK_TESTNET.pythStateId &&
		deployment.deepbook.pyth?.wormholeStateId === KNOWN_DEEPBOOK_TESTNET.wormholeStateId,
	hasPyth: deployment.deepbook.pyth !== null,
	marketCount: marketRows.length,
} as const;

export function marketLabel(row: Pick<MarketRow, 'baseCoin' | 'quoteCoin'>): string {
	return `${row.baseCoin}/${row.quoteCoin}`;
}

export function snapshotStatus(
	snapshot: MarketSnapshot | null,
): 'idle' | 'live' | 'partial' | 'offline' {
	if (!snapshot) return 'idle';
	const probes: ReadonlyArray<QueryProbe<unknown>> = [
		snapshot.poolId,
		snapshot.registered,
		snapshot.midPrice,
		snapshot.vaultBalances,
		snapshot.tradeParams,
		snapshot.bookParams,
		snapshot.orderBook,
		...snapshot.pythPrices,
	];
	const okCount = probes.filter((probe) => probe.status === 'ok').length;
	if (okCount === probes.length) return 'live';
	if (okCount > 0) return 'partial';
	return 'offline';
}

export async function readMarketSnapshot(marketKey: MarketKey): Promise<MarketSnapshot> {
	const market = marketRows.find((row) => row.key === marketKey);
	if (!market) throw new Error(`Unknown DeepBook market: ${marketKey}`);

	const deepBook = createDeepBookClient();
	const pythCoins = [market.baseCoin, market.quoteCoin].filter(hasPythPrice);

	const [poolId, registered, midPrice, vaultBalances, tradeParams, bookParams, orderBook] =
		await Promise.all([
			probe(() => deepBook.poolId(marketKey)),
			probe(() => deepBook.registeredPool(marketKey)),
			probe(() => deepBook.midPrice(marketKey)),
			probe(() => deepBook.vaultBalances(marketKey)),
			probe(() => deepBook.poolTradeParams(marketKey)),
			probe(() => deepBook.poolBookParams(marketKey)),
			probe(() => deepBook.getLevel2TicksFromMid(marketKey, 8)),
		]);
	const pythPrices = await Promise.all(
		pythCoins.map((coinKey) => probe(() => readPythPrice(deepBook, coinKey))),
	);

	return {
		market,
		completedAt: new Date().toISOString(),
		packageId: deployment.deepbook.packageId,
		registryId: deployment.deepbook.registryId,
		pythStateId: deployment.deepbook.pyth?.stateId ?? KNOWN_DEEPBOOK_TESTNET.pythStateId,
		poolId,
		registered,
		midPrice,
		vaultBalances,
		tradeParams,
		bookParams,
		orderBook,
		pythPrices,
	};
}

function createDeepBookClient(): DeepBookClient {
	const client = new SuiJsonRpcClient({
		network: 'testnet',
		url: getJsonRpcFullnodeUrl('testnet'),
	});

	const pyth = deployment.deepbook.pyth
		? {
				pythStateId: deployment.deepbook.pyth.stateId,
				wormholeStateId: deployment.deepbook.pyth.wormholeStateId,
			}
		: {
				pythStateId: KNOWN_DEEPBOOK_TESTNET.pythStateId,
				wormholeStateId: KNOWN_DEEPBOOK_TESTNET.wormholeStateId,
			};

	return new DeepBookClient({
		client,
		network: 'testnet',
		address: deployment.accounts.alice.address,
		coins: testnetCoins,
		pools: testnetPools,
		packageIds: {
			...testnetPackageIds,
			DEEPBOOK_PACKAGE_ID: deployment.deepbook.packageId,
			REGISTRY_ID: deployment.deepbook.registryId,
		},
		pyth,
	});
}

async function probe<T>(run: () => Promise<T>): Promise<QueryProbe<T>> {
	try {
		return { status: 'ok', value: await run() };
	} catch (error) {
		return { status: 'error', message: error instanceof Error ? error.message : String(error) };
	}
}

function hasPythPrice(coinKey: string): boolean {
	const coin = testnetCoins[coinKey];
	return Boolean(coin?.feed && coin.priceInfoObjectId);
}

async function readPythPrice(deepBook: DeepBookClient, coinKey: string): Promise<PythPriceProbe> {
	const coin = testnetCoins[coinKey];
	if (!coin) throw new Error(`Missing DeepBook testnet coin: ${coinKey}`);
	const arrivalTimeSeconds = await deepBook.getPriceInfoObjectAge(coinKey);
	const nowSeconds = Date.now() / 1000;

	return {
		coinKey,
		feedId: coin.feed ?? '',
		priceInfoObjectId: coin.priceInfoObjectId ?? '',
		arrivalTimeSeconds,
		ageSeconds: Math.max(0, nowSeconds - arrivalTimeSeconds),
	};
}
