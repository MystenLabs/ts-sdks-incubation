// React-query hooks over the browser-direct chain-read helpers in `chain.ts`.
//
// Every key is namespaced by `network` so switching stacks (which re-points the
// `rpc` endpoint and changes the chain) never serves cross-network cache hits.
// Callers resolve the node's gRPC base URL with `suiRpcUrl(projection.endpoints)`
// and the network with `projection.identity.network`, then pass both in; hooks
// stay disabled until an `rpcUrl` is available.

import { useEffect, useRef, useState } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import {
	fetchBalances,
	fetchChainHead,
	fetchCoinMeta,
	fetchDynamicFields,
	fetchEpochInfo,
	fetchLatestTransactions,
	fetchObject,
	fetchOwnedObjects,
	fetchPackage,
	fetchReferenceGasPrice,
	fetchSuiBalance,
	fetchTotalSupply,
	fetchTransaction,
} from './chain.ts';
import {
	type CoinCap,
	type DeepbookInfo,
	fetchCoinCaps,
	fetchDeepbookInfo,
	fetchMode,
	fetchPostgresStats,
	fetchSealInfo,
	type PostgresStats,
	type SealInfo,
	type StackMode,
} from './api.ts';
import type {
	BalanceView,
	ChainHead,
	CoinInfo,
	DynamicFieldView,
	EpochInfo,
	ObjectDetail,
	OwnedObjectView,
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

/** Objects owned by an address (first page), for the address view. */
export const useOwnedObjects = (
	source: ChainSource,
	address: string | null,
): UseQueryResult<OwnedObjectView[]> =>
	useQuery({
		queryKey: ['chain', source.network, 'ownedObjects', address],
		queryFn: () => fetchOwnedObjects(source.rpcUrl as string, address as string),
		enabled: enabled(source) && address !== null,
		staleTime: HEAD_STALE_MS,
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

/**
 * All non-zero balances owned by an address, for the address view. Same read as
 * `useBalances` (and the same cache key), named for the address-view call site.
 */
export const useAddressBalances = (
	source: ChainSource,
	address: string | null,
): UseQueryResult<BalanceView[]> => useBalances(source, address);

/** SUI balance (MIST) for an address. */
export const useSuiBalance = (source: ChainSource, owner: string | null): UseQueryResult<string> =>
	useQuery({
		queryKey: ['chain', source.network, 'suiBalance', owner],
		queryFn: () => fetchSuiBalance(source.rpcUrl as string, owner as string),
		enabled: enabled(source) && owner !== null,
		staleTime: HEAD_STALE_MS,
	});

// --- Control-plane domain hooks ---------------------------------------------
//
// React-query wrappers over the per-plugin `fetch*` helpers in `api.ts`. Keyed
// by `endpoint` + `network` so switching stacks never serves a stale domain
// result. Plugin panels consume these instead of hand-rolling load/error state.

const DOMAIN_STALE_MS = 10_000;

/** Resolved stack mode (`local` | `fork` | `live`), or null when unset. */
export const useMode = (endpoint: string, network: string): UseQueryResult<StackMode> =>
	useQuery({
		queryKey: ['domain', network, endpoint, 'mode'],
		queryFn: () => fetchMode(endpoint),
		staleTime: DOMAIN_STALE_MS,
	});

/** DeepBook deployments + pools. */
export const useDeepbookInfo = (
	endpoint: string,
	network: string,
): UseQueryResult<ReadonlyArray<DeepbookInfo>> =>
	useQuery({
		queryKey: ['domain', network, endpoint, 'deepbook'],
		queryFn: () => fetchDeepbookInfo(endpoint),
		staleTime: DOMAIN_STALE_MS,
	});

/** Seal key-server deployments. */
export const useSealInfo = (
	endpoint: string,
	network: string,
): UseQueryResult<ReadonlyArray<SealInfo>> =>
	useQuery({
		queryKey: ['domain', network, endpoint, 'seal'],
		queryFn: () => fetchSealInfo(endpoint),
		staleTime: DOMAIN_STALE_MS,
	});

/** Coin treasury-cap registry. */
export const useCoinCaps = (
	endpoint: string,
	network: string,
): UseQueryResult<ReadonlyArray<CoinCap>> =>
	useQuery({
		queryKey: ['domain', network, endpoint, 'coinCaps'],
		queryFn: () => fetchCoinCaps(endpoint),
		staleTime: DOMAIN_STALE_MS,
	});

/** Postgres wire-protocol stats per plugin instance. */
export const usePostgresStats = (
	endpoint: string,
	network: string,
): UseQueryResult<ReadonlyArray<PostgresStats>> =>
	useQuery({
		queryKey: ['domain', network, endpoint, 'postgresStats'],
		queryFn: () => fetchPostgresStats(endpoint),
		staleTime: DOMAIN_STALE_MS,
	});

// --- Live rolling series + chain rate ---------------------------------------

/** Cap on how many samples a rolling mini-series retains. */
const SERIES_CAP = 24;

/**
 * A short rolling numeric series accumulated from live ticks. `sample` is fed a
 * fresh value on each update; identical consecutive values are skipped so the
 * series only grows when the underlying metric actually moves. Resets when
 * `resetKey` changes (e.g. switching networks). Honest by construction — it only
 * ever holds values observed while the consumer was mounted.
 */
export const useRollingSeries = (
	resetKey: string,
): readonly [ReadonlyArray<number>, (v: number) => void] => {
	const [series, setSeries] = useState<ReadonlyArray<number>>([]);
	const last = useRef<number | null>(null);
	useEffect(() => {
		last.current = null;
		setSeries([]);
	}, [resetKey]);
	const sample = (v: number) => {
		if (!Number.isFinite(v) || last.current === v) return;
		last.current = v;
		setSeries((prev) => [...prev, v].slice(-SERIES_CAP));
	};
	return [series, sample];
};

/**
 * Derive a live rate (per second) from head ticks. Prefers REAL TPS from
 * Δ(totalTransactions)/Δt; falls back to the honest checkpoint rate (cp/s) when
 * the transaction total isn't available. Returns the rate and whether it's true
 * TPS (drives the label). Resets when `resetKey` (the network) changes.
 */
export const useChainRate = (
	resetKey: string,
	checkpoint: number | null,
	totalTx: number | null,
	headTs: number | null,
): { rate: number | null; isTps: boolean } => {
	const prev = useRef<{ cp: number; tx: number | null; t: number } | null>(null);
	const [rate, setRate] = useState<number | null>(null);
	const [isTps, setIsTps] = useState(false);
	useEffect(() => {
		prev.current = null;
		setRate(null);
		setIsTps(false);
	}, [resetKey]);
	useEffect(() => {
		if (checkpoint === null) return;
		const now = headTs ?? Date.now();
		const last = prev.current;
		if (last && now > last.t) {
			const dt = now - last.t;
			let value: number | null = null;
			if (totalTx !== null && last.tx !== null) {
				const tps = ((totalTx - last.tx) * 1000) / dt;
				if (Number.isFinite(tps) && tps >= 0) {
					value = tps;
					setIsTps(true);
				}
			}
			if (value === null) {
				const cps = ((checkpoint - last.cp) * 1000) / dt;
				if (Number.isFinite(cps) && cps >= 0) value = cps;
			}
			if (value !== null) setRate(value);
		}
		prev.current = { cp: checkpoint, tx: totalTx, t: now };
		// eslint-disable-next-line react-hooks/exhaustive-deps -- keyed off head movement only
	}, [checkpoint, totalTx, headTs]);
	return { rate, isTps };
};
