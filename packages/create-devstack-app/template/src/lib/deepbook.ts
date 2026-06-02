// Browser-side DeepBook integration over the generated `deepbook` binding.
//
// `deepbook` from `@generated/deepbook.js` is name-keyed; the default local
// DeX is the single `deepbook.deepbook` instance (package id, registry id,
// DEEP treasury, and a seeded DEEP/SUI pool). This lib constructs the
// deepbook-v3 SDK extension from those ids and drives a minimal order flow
// that the dev-wallet account (alice) can afford with only faucet SUI:
//
//   1. create + share a BalanceManager (tx 1, id captured from effects),
//   2. deposit a little SUI into it and place a resting limit BID below
//      market on DEEP/SUI with `payWithDeep: false` (tx 2).
//
// A below-market bid rests on the book rather than filling, so the demo
// proves an order reaches the pool without needing DEEP for fees or a
// matching ask. Fees on a `payWithDeep: false` order are taken from the
// input coin (SUI here), so faucet SUI is sufficient.

import {
	deepbook as deepbookExtension,
	DeepBookClient,
	OrderType,
	SelfMatchingOptions,
	type CoinMap,
	type DeepbookPackageIds,
	type PoolMap,
} from '@mysten/deepbook-v3';
import type { ClientWithCoreApi } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';

import { deepbook } from '@generated/deepbook.js';
import { config } from '@generated/config.js';

/** The single local DeX instance (name-keyed default). */
export const dex = deepbook.deepbook;

/** The seeded DEEP/SUI pool (first configured pool). */
const pool = dex.pools[0];
if (pool === undefined) {
	throw new Error('deepbook generated binding has no pools. Did `devstack apply` seed the DeX?');
}
export const defaultPool = pool;

const DEEP_SCALAR = 1_000_000;
const SUI_SCALAR = 1_000_000_000;

/** Coin keys match the pool's `base`/`quote` strings (DEEP / SUI). */
const COIN_SCALARS: Record<string, number> = {
	[defaultPool.base]: DEEP_SCALAR,
	[defaultPool.quote]: SUI_SCALAR,
};

const BALANCE_MANAGER_KEY = 'DEMO';

/** Demo order parameters — small enough for faucet SUI. A bid at 0.10
 *  SUI/DEEP for 1 DEEP rests below the seeded oracle mid (~3.45) so it
 *  posts to the book instead of crossing. */
export const DEMO_ORDER = {
	price: 0.1,
	quantity: 1,
	suiDeposit: 1, // SUI moved into the BalanceManager before ordering
} as const;

function addressFromCoinType(coinType: string): string {
	return coinType.split('::')[0] ?? '';
}

function buildPackageIds(): DeepbookPackageIds {
	return {
		DEEPBOOK_PACKAGE_ID: dex.packageId,
		REGISTRY_ID: dex.registryId,
		DEEP_TREASURY_ID: dex.deepTreasuryId ?? '',
	};
}

function buildCoinMap(): CoinMap {
	return {
		[defaultPool.base]: {
			address: addressFromCoinType(defaultPool.baseCoinType),
			type: defaultPool.baseCoinType,
			scalar: COIN_SCALARS[defaultPool.base] ?? DEEP_SCALAR,
		},
		[defaultPool.quote]: {
			address: addressFromCoinType(defaultPool.quoteCoinType),
			type: defaultPool.quoteCoinType,
			scalar: COIN_SCALARS[defaultPool.quote] ?? SUI_SCALAR,
		},
	};
}

function buildPoolMap(): PoolMap {
	return Object.fromEntries(
		dex.pools.map((p) => [p.name, { address: p.poolId, baseCoin: p.base, quoteCoin: p.quote }]),
	);
}

const pythConfig =
	dex.pyth && dex.pyth.stateId && dex.pyth.wormholeStateId
		? { pythStateId: dex.pyth.stateId, wormholeStateId: dex.pyth.wormholeStateId }
		: undefined;

/**
 * Construct a DeepBookClient bound to `address` and (optionally) a known
 * BalanceManager. The extension form is used for tx building; the bare
 * client is used for reads (`midPrice`). Both share the same config.
 */
export function buildDeepbookClient(
	suiClient: ClientWithCoreApi,
	address: string,
	balanceManagerAddress?: string,
): DeepBookClient {
	return new DeepBookClient({
		client: suiClient as ConstructorParameters<typeof DeepBookClient>[0]['client'],
		address,
		network: 'localnet',
		packageIds: buildPackageIds(),
		coins: buildCoinMap(),
		pools: buildPoolMap(),
		...(pythConfig ? { pyth: pythConfig } : {}),
		...(balanceManagerAddress
			? { balanceManagers: { [BALANCE_MANAGER_KEY]: { address: balanceManagerAddress } } }
			: {}),
	});
}

/** Register the deepbook extension on a sui client (used in panels that
 *  prefer the `$extend` form). Mirrors `examples/deepbook-trader`. */
export function deepbookRegistration(address: string, balanceManagerAddress?: string) {
	return deepbookExtension({
		address,
		packageIds: buildPackageIds(),
		coins: buildCoinMap(),
		pools: buildPoolMap(),
		...(pythConfig ? { pyth: pythConfig } : {}),
		...(balanceManagerAddress
			? { balanceManagers: { [BALANCE_MANAGER_KEY]: { address: balanceManagerAddress } } }
			: {}),
	});
}

export interface PoolInfo {
	readonly name: string;
	readonly poolId: string;
	readonly base: string;
	readonly quote: string;
	readonly packageId: string;
	readonly registryId: string;
}

/** Static pool info pulled straight from the generated binding. */
export function getPool(): PoolInfo {
	return {
		name: defaultPool.name,
		poolId: defaultPool.poolId,
		base: defaultPool.base,
		quote: defaultPool.quote,
		packageId: dex.packageId,
		registryId: dex.registryId,
	};
}

/** Read the current mid price from the on-chain book. Returns `null` when
 *  the book has no two-sided liquidity yet (common on a fresh localnet). */
export async function readMidPrice(suiClient: ClientWithCoreApi): Promise<number | null> {
	const client = buildDeepbookClient(suiClient, addressFromCoinType(defaultPool.baseCoinType));
	try {
		return await client.midPrice(defaultPool.name);
	} catch {
		return null;
	}
}

/** Tx 1: create and share a fresh BalanceManager. The shared object's id
 *  is read out of the transaction effects by the panel. */
export function buildCreateManagerTx(suiClient: ClientWithCoreApi, address: string): Transaction {
	const client = buildDeepbookClient(suiClient, address);
	const tx = new Transaction();
	tx.add(client.balanceManager.createAndShareBalanceManager());
	return tx;
}

/**
 * Tx 2: deposit `DEMO_ORDER.suiDeposit` SUI into the BalanceManager, then
 * place a resting limit BID on DEEP/SUI with `payWithDeep: false`. POST_ONLY
 * guarantees the order rests (never crosses), which is exactly the proof we
 * want: an order object lands on the pool.
 */
export function buildDepositAndOrderTx(args: {
	suiClient: ClientWithCoreApi;
	address: string;
	balanceManagerAddress: string;
	clientOrderId: string;
}): Transaction {
	const client = buildDeepbookClient(args.suiClient, args.address, args.balanceManagerAddress);
	const tx = new Transaction();
	tx.add(
		client.balanceManager.depositIntoManager(
			BALANCE_MANAGER_KEY,
			defaultPool.quote,
			DEMO_ORDER.suiDeposit,
		),
	);
	tx.add(
		client.deepBook.placeLimitOrder({
			poolKey: defaultPool.name,
			balanceManagerKey: BALANCE_MANAGER_KEY,
			clientOrderId: args.clientOrderId,
			price: DEMO_ORDER.price,
			quantity: DEMO_ORDER.quantity,
			isBid: true,
			payWithDeep: false,
			orderType: OrderType.POST_ONLY,
			selfMatchingOption: SelfMatchingOptions.SELF_MATCHING_ALLOWED,
		}),
	);
	return tx;
}

/** Network block for the active network (rpc/chain/etc). */
export function activeNetwork() {
	return config.networks[config.network];
}
