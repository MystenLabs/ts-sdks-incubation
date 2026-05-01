import { useCurrentClient } from '@mysten/dapp-kit-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

// Native SUI coin type — the constant lives at sui-framework address 0x2.
export const SUI_COIN_TYPE = '0x2::sui::SUI';

// FRICTION: this hook + invalidation pattern is a near-duplicate of
// examples/token-studio/src/lib/queries.ts. Phase 2 should ship `useCoinBalance`
// and `useSignAndExecute` in a shared package — every coin-aware app will
// write these.
export function useCoinBalance(address: string | undefined, coinType: string) {
	const client = useCurrentClient();
	return useQuery({
		queryKey: ['balance', address, coinType],
		queryFn: async () => {
			if (!address) return null;
			const result = await client.core.getBalance({ owner: address, coinType });
			return result.balance;
		},
		enabled: !!address,
	});
}

export const useSuiBalance = (address: string | undefined) =>
	useCoinBalance(address, SUI_COIN_TYPE);

export function useInvalidateBalances() {
	const qc = useQueryClient();
	return () => {
		qc.invalidateQueries({ queryKey: ['balance'] });
	};
}
