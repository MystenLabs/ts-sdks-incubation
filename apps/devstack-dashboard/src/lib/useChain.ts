// React-query hooks over the browser-direct chain-read helpers in `chain.ts`.
//
// Every key is namespaced by `network` so switching stacks (which re-points the
// `rpc` endpoint and changes the chain) never serves cross-network cache hits.
// Callers resolve the node's gRPC base URL with `suiRpcUrl(projection.endpoints)`
// and the network with `projection.identity.network`, then pass both in; hooks
// stay disabled until an `rpcUrl` is available.

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import {
	fetchBalances,
	fetchChainHead,
	fetchCoinMeta,
	fetchDynamicFields,
	fetchEpochInfo,
	fetchLatestTransactions,
	fetchObject,
	fetchPackage,
	fetchReferenceGasPrice,
	fetchSuiBalance,
	fetchTotalSupply,
	fetchTransaction,
} from './chain.ts';
import type {
	BalanceView,
	ChainHead,
	CoinInfo,
	DynamicFieldView,
	EpochInfo,
	ObjectDetail,
	PackageDetail,
	TxDetail,
	TxSummary,
} from './explorerTypes.ts';

/** What every chain hook needs: the node gRPC URL + a network cache namespace. */
export interface ChainSource {
	/** The stack's `rpc` endpoint URL, or null when unavailable (hooks disabled). */
	readonly rpcUrl: string | null;
	/** Network identity (`projection.identity.network`) — the cache namespace. */
	readonly network: string;
}

// Chain data is fast-moving but cheap; head/epoch refetch often, detail reads
// are effectively immutable for a given digest/id/version.
const HEAD_STALE_MS = 2_000;
const EPOCH_STALE_MS = 10_000;
const DETAIL_STALE_MS = 30_000;

const enabled = (source: ChainSource): boolean => source.rpcUrl !== null;

/** Head-of-chain info (chain id, epoch, latest executed checkpoint). */
export const useChainHead = (source: ChainSource): UseQueryResult<ChainHead> =>
	useQuery({
		queryKey: ['chain', source.network, 'head'],
		queryFn: () => fetchChainHead(source.rpcUrl as string),
		enabled: enabled(source),
		staleTime: HEAD_STALE_MS,
		refetchInterval: HEAD_STALE_MS,
	});

/** Current epoch + system-state summary. */
export const useEpochInfo = (source: ChainSource): UseQueryResult<EpochInfo> =>
	useQuery({
		queryKey: ['chain', source.network, 'epoch'],
		queryFn: () => fetchEpochInfo(source.rpcUrl as string),
		enabled: enabled(source),
		staleTime: EPOCH_STALE_MS,
		refetchInterval: EPOCH_STALE_MS,
	});

/** Reference gas price (MIST). */
export const useReferenceGasPrice = (source: ChainSource): UseQueryResult<number> =>
	useQuery({
		queryKey: ['chain', source.network, 'gasPrice'],
		queryFn: () => fetchReferenceGasPrice(source.rpcUrl as string),
		enabled: enabled(source),
		staleTime: EPOCH_STALE_MS,
	});

/** Latest transactions, walked back from the head checkpoint. */
export const useLatestTransactions = (
	source: ChainSource,
	limit = 25,
): UseQueryResult<TxSummary[]> =>
	useQuery({
		queryKey: ['chain', source.network, 'latestTx', limit],
		queryFn: () => fetchLatestTransactions(source.rpcUrl as string, limit),
		enabled: enabled(source),
		staleTime: HEAD_STALE_MS,
		refetchInterval: HEAD_STALE_MS * 2,
	});

/** Full transaction detail by digest. */
export const useTransaction = (
	source: ChainSource,
	digest: string | null,
): UseQueryResult<TxDetail> =>
	useQuery({
		queryKey: ['chain', source.network, 'tx', digest],
		queryFn: () => fetchTransaction(source.rpcUrl as string, digest as string),
		enabled: enabled(source) && digest !== null,
		staleTime: DETAIL_STALE_MS,
	});

/** Object detail (+ first page of dynamic fields) by id. */
export const useObject = (source: ChainSource, id: string | null): UseQueryResult<ObjectDetail> =>
	useQuery({
		queryKey: ['chain', source.network, 'object', id],
		queryFn: () => fetchObject(source.rpcUrl as string, id as string),
		enabled: enabled(source) && id !== null,
		staleTime: DETAIL_STALE_MS,
	});

/** Dynamic fields under a parent object (first page). */
export const useDynamicFields = (
	source: ChainSource,
	parentId: string | null,
): UseQueryResult<DynamicFieldView[]> =>
	useQuery({
		queryKey: ['chain', source.network, 'dynamicFields', parentId],
		queryFn: () => fetchDynamicFields(source.rpcUrl as string, parentId as string),
		enabled: enabled(source) && parentId !== null,
		staleTime: DETAIL_STALE_MS,
	});

/** Package detail (modules + function signatures) by id. */
export const usePackage = (source: ChainSource, id: string | null): UseQueryResult<PackageDetail> =>
	useQuery({
		queryKey: ['chain', source.network, 'package', id],
		queryFn: () => fetchPackage(source.rpcUrl as string, id as string),
		enabled: enabled(source) && id !== null,
		staleTime: DETAIL_STALE_MS,
	});

/** Coin metadata + supply by coin type. */
export const useCoinMeta = (
	source: ChainSource,
	coinType: string | null,
): UseQueryResult<CoinInfo | null> =>
	useQuery({
		queryKey: ['chain', source.network, 'coinMeta', coinType],
		queryFn: () => fetchCoinMeta(source.rpcUrl as string, coinType as string),
		enabled: enabled(source) && coinType !== null,
		staleTime: DETAIL_STALE_MS,
	});

/**
 * Total supply (base units, as a string) for a coin, read from its TreasuryCap
 * object. Gated on a non-null `treasuryCapId` (and rpcUrl). Treated as detail-
 * stable: supply only moves on mint/burn, so a longer stale window is fine.
 */
export const useTotalSupply = (
	source: ChainSource,
	treasuryCapId: string | null,
): UseQueryResult<string | null> =>
	useQuery({
		queryKey: ['chain', source.network, 'totalSupply', treasuryCapId],
		queryFn: () => fetchTotalSupply(source.rpcUrl as string, treasuryCapId as string),
		enabled: enabled(source) && treasuryCapId !== null,
		staleTime: HEAD_STALE_MS,
		refetchInterval: HEAD_STALE_MS * 4,
	});

/** All non-zero balances owned by an address. */
export const useBalances = (
	source: ChainSource,
	owner: string | null,
): UseQueryResult<BalanceView[]> =>
	useQuery({
		queryKey: ['chain', source.network, 'balances', owner],
		queryFn: () => fetchBalances(source.rpcUrl as string, owner as string),
		enabled: enabled(source) && owner !== null,
		staleTime: HEAD_STALE_MS,
	});

/** SUI balance (MIST) for an address. */
export const useSuiBalance = (
	source: ChainSource,
	owner: string | null,
): UseQueryResult<string> =>
	useQuery({
		queryKey: ['chain', source.network, 'suiBalance', owner],
		queryFn: () => fetchSuiBalance(source.rpcUrl as string, owner as string),
		enabled: enabled(source) && owner !== null,
		staleTime: HEAD_STALE_MS,
	});
