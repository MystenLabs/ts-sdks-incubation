import { useCurrentClient } from '@mysten/dapp-kit-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

export { useSignAndExecute, type UseSignAndExecuteOptions } from '@mysten-incubation/devstack/react';

// Native SUI coin type — the constant lives at sui-framework address 0x2.
export const SUI_COIN_TYPE = '0x2::sui::SUI';

// Polls every 2s so balances stay current after txs that didn't go through
// `useSignAndExecute` (e.g. the dev-wallet's Faucet panel) and therefore
// didn't invalidate the query keys.
const BALANCE_POLL_MS = 2_000;

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
		refetchInterval: BALANCE_POLL_MS,
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
