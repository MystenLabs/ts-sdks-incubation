// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { normalizeSuiAddress } from '@mysten/sui/utils';
import type {
	Analyzer,
	AnalyzerResult,
	CoinFlow,
	CoinValueAnalysis,
	CoinValueAnalyzerOptions,
} from '@mysten/wallet-sdk';
import { analyzers, createAnalyzer } from '@mysten/wallet-sdk';

export interface AutoApprovalAnalyzerOptions {
	/**
	 * The wallet's own addresses, whose balance changes count against budgets. Defaults to the
	 * transaction sender. When set, the sender isn't added, so a transaction the wallet only
	 * sponsors can't offset the wallet's spending with the sender's inflows.
	 */
	senderAddresses?: string[];
}

interface AutoApprovalAnalyzeOptions {
	operationType?: string;
	getCoinPrices?: CoinValueAnalyzerOptions['getCoinPrices'];
	autoApproval?: AutoApprovalAnalyzerOptions;
}

const operationType = createAnalyzer({
	analyze: (options: Pick<AutoApprovalAnalyzeOptions, 'operationType'>) => () => ({
		result: options.operationType ?? null,
	}),
});

export const autoApprovalAnalyzer = createAnalyzer({
	dependencies: {
		operationType,
		bytes: analyzers.bytes,
		balanceFlows: analyzers.balanceFlows,
		accessLevel: analyzers.accessLevel,
		ownedObjects: analyzers.ownedObjects,
		digest: analyzers.digest,
	},
	analyze:
		(options: AutoApprovalAnalyzeOptions, tx) =>
		async ({ bytes, balanceFlows, accessLevel, ownedObjects, digest, operationType }) => {
			const sender = tx.getData().sender;
			const senderAddresses = uniqueNormalizedAddresses(
				options.autoApproval?.senderAddresses ?? (sender ? [sender] : []),
			);
			const senderBalanceFlows = aggregateBalanceFlowsForAddresses(
				balanceFlows.byAddress,
				senderAddresses,
			);

			const coinValues = options.getCoinPrices
				? await getCoinValues(senderBalanceFlows, options.getCoinPrices)
				: getCoinValuesUnavailable(senderBalanceFlows);

			return {
				result: {
					operationType,
					senderAddresses,
					bytes,
					balanceFlows,
					senderBalanceFlows,
					accessLevel,
					ownedObjects,
					digest,
					coinValues,
				},
			};
		},
});

export type AutoApprovalAnalysis =
	typeof autoApprovalAnalyzer extends Analyzer<infer R, any, any> ? R : never;
export type AutoApprovalResult = AnalyzerResult<AutoApprovalAnalysis>;

function uniqueNormalizedAddresses(addresses: string[]): string[] {
	return [...new Set(addresses.map((address) => normalizeSuiAddress(address)))];
}

function aggregateBalanceFlowsForAddresses(
	byAddress: Record<string, CoinFlow[]>,
	addresses: string[],
): CoinFlow[] {
	const senderAddresses = new Set(addresses);
	const flowsByCoinType = new Map<string, bigint>();

	for (const [address, flows] of Object.entries(byAddress)) {
		if (!senderAddresses.has(normalizeSuiAddress(address))) {
			continue;
		}

		for (const flow of flows) {
			flowsByCoinType.set(flow.coinType, (flowsByCoinType.get(flow.coinType) ?? 0n) + flow.amount);
		}
	}

	return Array.from(flowsByCoinType, ([coinType, amount]) => ({ coinType, amount })).filter(
		(flow) => flow.amount !== 0n,
	);
}

function getCoinValuesUnavailable(balanceFlows: CoinFlow[]): CoinValueAnalysis {
	const outflowCoinTypes = balanceFlows
		.filter((flow) => flow.amount < 0n)
		.map((flow) => flow.coinType);

	return { total: 0, coinTypesWithoutPrice: [...new Set(outflowCoinTypes)], coinTypes: [] };
}

async function getCoinValues(
	balanceFlows: CoinFlow[],
	getCoinPrices: CoinValueAnalyzerOptions['getCoinPrices'],
): Promise<CoinValueAnalysis> {
	const outflows = balanceFlows
		.filter((flow) => flow.amount < 0n)
		.map((flow) => ({ coinType: flow.coinType, amount: -flow.amount }));
	const prices = await getCoinPrices(outflows.map((flow) => flow.coinType));

	let total = 0;
	const coinTypesWithoutPrice: string[] = [];
	const coinTypes: CoinValueAnalysis['coinTypes'] = [];

	for (const flow of outflows) {
		const price = prices.find((price) => price.coinType === flow.coinType);
		if (price?.price != null) {
			const convertedAmount = (Number(flow.amount) / 10 ** price.decimals) * price.price;
			total += convertedAmount;
			coinTypes.push({
				coinType: flow.coinType,
				decimals: price.decimals,
				price: price.price,
				amount: flow.amount,
				convertedAmount,
			});
		} else {
			coinTypesWithoutPrice.push(flow.coinType);
		}
	}

	return { total, coinTypesWithoutPrice, coinTypes };
}
