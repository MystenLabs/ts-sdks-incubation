import { DeepBookClient } from '@mysten/deepbook-v3';
import type { ClientWithCoreApi } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';

import { deepbookConfig } from '../generated/deepbook-config.js';

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
 * Memoized DeepBook SDK client. Built lazily from the codegen-emitted
 * `deepbookConfig` the first time a swap fires — re-keyed per
 * `(suiClient, sender)` because the SDK stamps the sender on every
 * produced tx via `setSenderIfNotSet`.
 *
 * Phase 5 of the deepbook plugin expansion replaced ~70 lines of manual
 * coin/pool/packageIds projection with `...deepbookConfig`. The shape
 * mirrors `@mysten/deepbook-v3`'s `CoinMap` / `PoolMap` /
 * `DeepbookPackageIds` exports verbatim — see
 * packages/devstack/notes/deepbook-plugin-expansion.md § P5.14.
 */
let cached: { suiClient: ClientWithCoreApi; sender: string; client: DeepBookClient } | null = null;

function getDeepBookClient(suiClient: ClientWithCoreApi, sender: string): DeepBookClient {
	if (cached !== null && cached.suiClient === suiClient && cached.sender === sender) {
		return cached.client;
	}

	// `network: 'localnet'` is rejected by the SDK's default-config branch
	// (the SDK only ships mainnet/testnet defaults), so we provide explicit
	// `packageIds` / `coins` / `pools` from `deepbookConfig`. The network
	// field is just metadata at this point.
	const client = new DeepBookClient({
		client: suiClient,
		address: sender,
		network: 'localnet',
		coins: deepbookConfig.coins,
		pools: deepbookConfig.pools,
		packageIds: deepbookConfig.packageIds,
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
