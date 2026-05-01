import { useCurrentClient } from '@mysten/dapp-kit-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { deployment } from '../generated/deployment.js';
import { MANAGED_COIN_TYPE } from './coin.js';

export function useCoinMetadata() {
	const client = useCurrentClient();
	return useQuery({
		queryKey: ['coinMetadata', MANAGED_COIN_TYPE],
		queryFn: () => client.core.getCoinMetadata({ coinType: MANAGED_COIN_TYPE }),
	});
}

/**
 * Read total supply from the TreasuryCap object's JSON representation.
 * Sui's gRPC core API doesn't expose `getTotalSupply` directly, so we
 * read the cap object and parse the supply field out of it.
 */
export function useTotalSupply() {
	const client = useCurrentClient();
	return useQuery({
		queryKey: ['totalSupply', deployment.treasuryCapId],
		queryFn: async () => {
			const { object } = await client.core.getObject({
				objectId: deployment.treasuryCapId,
				include: { json: true },
			});
			const json = object.json as { total_supply?: { value?: string } } | undefined;
			return BigInt(json?.total_supply?.value ?? '0');
		},
	});
}

export function useCoinBalance(address: string | undefined) {
	const client = useCurrentClient();
	return useQuery({
		queryKey: ['balance', address, MANAGED_COIN_TYPE],
		queryFn: async () => {
			if (!address) return null;
			const result = await client.core.getBalance({
				owner: address,
				coinType: MANAGED_COIN_TYPE,
			});
			return result.balance;
		},
		enabled: !!address,
	});
}

/**
 * Returns a callback that invalidates every read of the coin's state — call
 * after a successful mint/transfer/burn so balances and supply re-fetch.
 */
export function useInvalidateCoinReads() {
	const qc = useQueryClient();
	return () => {
		qc.invalidateQueries({ predicate: (q) => Array.isArray(q.queryKey) });
	};
}
