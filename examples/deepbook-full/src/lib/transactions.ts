import { DeepBookClient } from '@mysten/deepbook-v3';
import type { ClientWithCoreApi } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';

import { deepbookConfig } from '../generated/deepbook-config.js';

/**
 * Memoized DeepBook SDK client built from the codegen-emitted
 * `deepbookConfig`. Re-keyed per `(suiClient, sender)` because the SDK
 * stamps the sender on every produced tx via `setSenderIfNotSet`.
 *
 * Phase 5 of the deepbook plugin expansion folds the entire
 * `coins` + `pools` + `marginPools` + `packageIds` projection into
 * `deepbookConfig`; consumers spread it as `{...deepbookConfig, address}`.
 */
let cached: { suiClient: ClientWithCoreApi; sender: string; client: DeepBookClient } | null = null;

export function getDeepBookClient(
	suiClient: ClientWithCoreApi,
	sender: string,
): DeepBookClient {
	if (cached !== null && cached.suiClient === suiClient && cached.sender === sender) {
		return cached.client;
	}
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
 * Build a limit-order transaction against a DeepBook v3 pool using the
 * SDK. `poolKey` is the alias from `deepbookConfig.pools` (i.e. the
 * pool name from the devstack config).
 */
export function buildLimitOrderTx(args: {
	suiClient: ClientWithCoreApi;
	sender: string;
	poolAlias: string;
	balanceManagerKey: string;
	price: bigint;
	quantity: bigint;
	isBid: boolean;
}): Transaction {
	const { suiClient, sender, poolAlias, balanceManagerKey, price, quantity, isBid } = args;
	const dbc = getDeepBookClient(suiClient, sender);
	const tx = new Transaction();
	dbc.deepBook.placeLimitOrder({
		poolKey: poolAlias,
		balanceManagerKey,
		clientOrderId: String(Date.now()),
		price,
		quantity,
		isBid,
	})(tx);
	return tx;
}
