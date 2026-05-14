import { DeepBookClient } from '@mysten/deepbook-v3';
import type { CoinMap, PoolMap } from '@mysten/deepbook-v3';
import type { ClientWithCoreApi } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';

import { deployment } from './deployment.js';

const SUI_COIN_TYPE = '0x2::sui::SUI';

/**
 * Build a transaction that sends `amount` (raw base units) of `coinType` to
 * `recipient`. `useGasCoin: true` is the right default for SUI sends —
 * the SDK splits from the gas coin, leaving the rest of the sender's SUI
 * coins untouched for gas selection. With `useGasCoin: false`, the SDK's
 * resolver merges every owned SUI coin into a single source for the send,
 * leaving the gas-coin selector with nothing and failing with "No valid
 * gas coins found" on accounts that don't have an address-balance
 * deposit. The flag is a no-op for non-SUI coins.
 */
export async function buildSendTx(args: {
	coinType: string;
	amount: bigint;
	recipient: string;
}): Promise<Transaction> {
	const { coinType, amount, recipient } = args;
	const tx = new Transaction();
	const coin = tx.coin({ balance: amount, type: coinType, useGasCoin: true });
	tx.transferObjects([coin], recipient);
	return tx;
}

/**
 * Memoized DeepBook SDK client. Built lazily from the manifest the first
 * time a swap fires — re-keyed per `(suiClient, sender)` because the SDK
 * stamps the sender on every produced tx via `setSenderIfNotSet` (the
 * actual signer is still the wallet, but the SDK uses this for things
 * like pre-flight balance lookups).
 *
 * The SDK takes a coin/pool registry keyed by symbol/alias rather than by
 * type/objectId; we project the wallet's `deployment` shape into those
 * keys here. Localnet has no pre-baked coin map (the upstream
 * `mainnetCoins` / `testnetCoins` defaults reference real-network coin
 * objects), so we provide our own.
 */
let cached: { suiClient: ClientWithCoreApi; sender: string; client: DeepBookClient } | null = null;

function getDeepBookClient(suiClient: ClientWithCoreApi, sender: string): DeepBookClient {
	if (cached !== null && cached.suiClient === suiClient && cached.sender === sender) {
		return cached.client;
	}
	const { deepbookPackageId, deepbookRegistryId } = deployment;
	if (deepbookPackageId === undefined) {
		throw new Error('deepbook package not in manifest — run `pnpm localnet:up`');
	}
	if (deepbookRegistryId === undefined) {
		throw new Error('deepbook registry id not captured in manifest');
	}

	// Coin map keyed by symbol. SUI + DEEP land first; everything else
	// flows from the registry's coin tokens. `--with-unpublished-deps`
	// bakes the `token` sub-package under the parent address, so DEEP
	// lives at the deepbook package id. DEEP_SCALAR is 1e6 per the SDK
	// constants — the SDK uses it to convert human-readable values into
	// on-chain u64 (we always pass `bigint`, which the SDK uses raw).
	const coins: CoinMap = {
		SUI: { address: '0x2', type: SUI_COIN_TYPE, scalar: 1_000_000_000 },
		DEEP: {
			address: deepbookPackageId,
			type: `${deepbookPackageId}::deep::DEEP`,
			scalar: 1_000_000,
		},
	};
	for (const c of deployment.coins) {
		if (c.coinType === SUI_COIN_TYPE) continue;
		const address = c.coinType.split('::')[0];
		if (address === undefined) continue;
		coins[c.symbol] = { address, type: c.coinType, scalar: 10 ** c.decimals };
	}

	// Pool map keyed by alias. The SDK looks coins up by symbol, so we
	// reverse-map our pool's coin types into the symbols above. A pool
	// whose base/quote coin isn't in the wallet's deployment surface is
	// a bug in the manifest projection — fail loudly.
	const symbolByType = new Map<string, string>();
	for (const [key, v] of Object.entries(coins)) symbolByType.set(v.type, key);
	const pools: PoolMap = {};
	for (const p of deployment.pools) {
		const baseSymbol = symbolByType.get(p.baseCoinType);
		const quoteSymbol = symbolByType.get(p.quoteCoinType);
		if (baseSymbol === undefined || quoteSymbol === undefined) {
			throw new Error(
				`pool ${p.alias}: ${p.baseCoinType} / ${p.quoteCoinType} not in coin map`,
			);
		}
		pools[p.alias] = { address: p.poolId, baseCoin: baseSymbol, quoteCoin: quoteSymbol };
	}

	const client = new DeepBookClient({
		client: suiClient,
		address: sender,
		// `network: 'localnet'` is rejected by the default-config branch
		// (the SDK only ships mainnet/testnet defaults), so we provide an
		// explicit `packageIds` and the network field is just metadata.
		network: 'localnet',
		coins,
		pools,
		packageIds: {
			DEEPBOOK_PACKAGE_ID: deepbookPackageId,
			REGISTRY_ID: deepbookRegistryId,
			// DEEP_TREASURY_ID is unused for the whitelisted-pool swap
			// path (`deepAmount: 0` produces a zero `Coin<DEEP>` via
			// `coinWithBalance`, which never touches the treasury).
			DEEP_TREASURY_ID: '0x0',
		},
	});

	cached = { suiClient, sender, client };
	return client;
}

/**
 * Build a swap transaction against a DeepBook v3 pool using the
 * official SDK. Whitelisted-pool path: `deepAmount: 0` makes the SDK
 * emit a zero `Coin<DEEP>` placeholder; pools created by the
 * devstack `deepbook()` plugin have `whitelisted: true` so the
 * matcher waives the DEEP fee.
 *
 * The SDK accepts `amount` / `minOut` as either `number` (multiplied
 * by the coin's `scalar` = 10^decimals) or `bigint` (used raw on-
 * chain). We pass `bigint` so the caller stays in raw base units —
 * matching what the form's `parseCoinAmount` already produces and
 * keeping rounding behavior in the caller's hands.
 */
export async function buildDeepbookSwapTx(args: {
	suiClient: ClientWithCoreApi;
	sender: string;
	poolAlias: string;
	direction: 'base_to_quote' | 'quote_to_base';
	amountIn: bigint;
	minOut: bigint;
}): Promise<Transaction> {
	const { suiClient, sender, poolAlias, direction, amountIn, minOut } = args;
	const dbc = getDeepBookClient(suiClient, sender);
	const tx = new Transaction();
	const swap =
		direction === 'base_to_quote'
			? dbc.deepBook.swapExactBaseForQuote
			: dbc.deepBook.swapExactQuoteForBase;
	const [outBase, outQuote, outDeep] = swap({
		poolKey: poolAlias,
		amount: amountIn,
		deepAmount: 0n,
		minOut,
	})(tx);
	tx.transferObjects([outBase, outQuote, outDeep], sender);
	return tx;
}
