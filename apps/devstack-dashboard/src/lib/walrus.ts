// Browser-direct Walrus reads over the node's Sui GraphQL endpoint.
//
// Unlike `chain.ts` (which talks gRPC `client.core.*`), Walrus's interesting
// state lives in on-chain *events* and *transactions* that the Sui GraphQL RPC
// exposes with first-class filters — so these reads go through the SDK's typed
// GraphQL client (`suiGraphqlClient`, from `sui-graphql.ts`) against the stack's
// `graphql` endpoint (CORS-open, same browser-direct pattern as the gRPC reads).
// The query documents are written with the SDK's schema-typed `graphql()` tag,
// so each selection is checked against the real Sui schema at compile time and
// its result type is inferred. No Walrus indexer is involved.
//
// What's reachable, and how:
//   - Recent blobs   — `transactions(filter: { function })` on the Walrus
//                       `system::register_blob` / `system::certify_blob` Move
//                       functions. Each tx's emitted `events::BlobRegistered` /
//                       `events::BlobCertified` event carries the blob's id,
//                       size, and epochs. Register events have the size; certify
//                       events mark it certified — we merge the two by `blob_id`.
//   - Storage epoch  — the latest `events::EpochChangeDone` / `EpochChangeStart`
//                       event's `epoch` field (the Walrus storage epoch, which
//                       advances independently of the Sui protocol epoch).
//   - Shard layout   — `events::ShardsReceived` events for the current epoch:
//                       one per storage node, each listing the shard indices it
//                       holds — giving real per-node shard counts + a total.
//
// The Walrus package id is read from the projection's package registry (the
// substrate publishes the deployed Walrus package as a `walrus.<name>` entry);
// it is never hardcoded, since it changes per deploy.

import { graphql, type ResultOf } from '@mysten/sui/graphql/schema';
import type { PackageProjection } from './types.ts';
import { isoToMillis, suiGraphqlClient, suiGraphqlUrl } from './sui-graphql.ts';

// --- Endpoint + package resolution ------------------------------------------

/**
 * The stack's Sui GraphQL base URL (the `graphql` endpoint), or null. Re-exported
 * from the shared Sui-GraphQL helper so Walrus call sites keep importing it here.
 */
export const walrusGraphqlUrl = suiGraphqlUrl;

/**
 * The deployed Walrus Move package id, read from the projection's packages. The
 * substrate publishes it under a `walrus[.<name>]` package entry; we match on a
 * `walrus` name/key prefix and prefer a local deployment. Returns null when the
 * stack has no Walrus package (e.g. a known/remote deployment with no local id).
 */
export const walrusPackageId = (packages: ReadonlyArray<PackageProjection>): string | null => {
	const isWalrus = (p: PackageProjection): boolean =>
		p.name.toLowerCase().startsWith('walrus') || p.key.toLowerCase().includes('walrus');
	const local = packages.find((p) => isWalrus(p) && p.kind === 'local');
	const any = local ?? packages.find(isWalrus);
	return any?.packageId ?? null;
};

// --- Event payload helpers --------------------------------------------------

const asString = (v: unknown): string | null =>
	typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null;

const asNumber = (v: unknown): number | null => {
	if (typeof v === 'number') return v;
	if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
	return null;
};

const asBool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

// --- Recent blobs -----------------------------------------------------------

/** A recent Walrus blob, assembled from its register/certify transactions. */
export interface RecentBlob {
	/** On-chain `blob_id` (u256, as the decimal string the event carries). */
	readonly blobId: string;
	/** The blob `Object` id (a `0x…` object), when present in the event. */
	readonly objectId: string | null;
	/** Encoded size in bytes (from the register event); null if only certified. */
	readonly size: number | null;
	/** Storage epoch the blob was registered in (null if only certify seen). */
	readonly registeredEpoch: number | null;
	/** Storage epoch the blob's storage runs through (`end_epoch`). */
	readonly endEpoch: number | null;
	/** Whether a `BlobCertified` event was seen for this blob. */
	readonly certified: boolean;
	/** Whether the blob was registered as deletable. */
	readonly deletable: boolean | null;
	/** Newest register/certify tx timestamp (epoch-millis), for "when". */
	readonly timestampMs: number | null;
	/** Newest register/certify transaction digest, for an explorer link. */
	readonly digest: string | null;
	/** Sender of the newest register/certify tx. */
	readonly sender: string | null;
}

// `last: N` returns the most recent N matching transactions (oldest→newest);
// we reverse client-side so the table reads newest-first. Each tx pulls its
// emitted blob event so we can read id/size/epochs without a second round-trip.
// The selection is type-checked against the Sui schema by `graphql()`:
// `effects.events.nodes.contents` is a `MoveValue` with `type { repr }` (the
// fully-qualified event type) + `json` (the parsed Move struct).
const RECENT_BLOBS_QUERY = graphql(`
	query WalrusBlobTxs($fn: String!, $limit: Int!) {
		transactions(last: $limit, filter: { function: $fn }) {
			nodes {
				digest
				sender {
					address
				}
				effects {
					timestamp
					events {
						nodes {
							contents {
								type {
									repr
								}
								json
							}
						}
					}
				}
			}
		}
	}
`);

/** One transaction node from `RECENT_BLOBS_QUERY` (schema-inferred). */
type TxNode = NonNullable<
	NonNullable<ResultOf<typeof RECENT_BLOBS_QUERY>['transactions']>['nodes']
>[number];

/** Mutable accumulator while merging register + certify events per blob. */
interface BlobAcc {
	objectId: string | null;
	size: number | null;
	registeredEpoch: number | null;
	endEpoch: number | null;
	certified: boolean;
	deletable: boolean | null;
	timestampMs: number | null;
	digest: string | null;
	sender: string | null;
}

const newest = (a: number | null, b: number | null): boolean =>
	b !== null && (a === null || b >= a);

/**
 * Fold one transaction's blob event into the accumulator map, keyed by blob id.
 * `kind` selects which fields the event is expected to carry (register events
 * have `size`; certify events flip `certified`).
 */
const foldTx = (
	acc: Map<string, BlobAcc>,
	tx: TxNode,
	kind: 'register' | 'certify',
	suffix: 'BlobRegistered' | 'BlobCertified',
): void => {
	const ts = isoToMillis(tx.effects?.timestamp);
	for (const ev of tx.effects?.events?.nodes ?? []) {
		const repr = ev.contents?.type?.repr ?? '';
		if (!repr.endsWith(`::events::${suffix}`)) continue;
		const json = (ev.contents?.json ?? {}) as Record<string, unknown>;
		const blobId = asString(json.blob_id);
		if (blobId === null) continue;
		const cur: BlobAcc = acc.get(blobId) ?? {
			objectId: null,
			size: null,
			registeredEpoch: null,
			endEpoch: null,
			certified: false,
			deletable: null,
			timestampMs: null,
			digest: null,
			sender: null,
		};
		cur.objectId = cur.objectId ?? asString(json.object_id);
		cur.endEpoch = asNumber(json.end_epoch) ?? cur.endEpoch;
		cur.deletable = cur.deletable ?? asBool(json.deletable);
		if (kind === 'register') {
			cur.size = asNumber(json.size) ?? cur.size;
			cur.registeredEpoch = asNumber(json.epoch) ?? cur.registeredEpoch;
		} else {
			cur.certified = true;
		}
		// Track the newest tx so "when"/digest/sender reflect the latest activity.
		if (newest(cur.timestampMs, ts)) {
			cur.timestampMs = ts;
			cur.digest = tx.digest ?? cur.digest;
			cur.sender = tx.sender?.address ?? cur.sender;
		}
		acc.set(blobId, cur);
	}
};

/**
 * Recent blobs, assembled from the Walrus `register_blob` + `certify_blob`
 * transactions on the node's Sui GraphQL. Both function streams are queried in
 * parallel and merged by `blob_id`: register events supply size + epochs, certify
 * events mark the blob certified. Returns newest-first, capped at `limit`.
 */
export const fetchRecentBlobs = async (
	graphqlUrl: string,
	packageId: string,
	limit = 25,
): Promise<ReadonlyArray<RecentBlob>> => {
	const client = suiGraphqlClient(graphqlUrl);
	const run = (fn: string) =>
		client
			.query({ query: RECENT_BLOBS_QUERY, variables: { fn, limit } })
			.then(({ data, errors }) => {
				if (errors?.length) throw new Error(errors.map((e) => e.message).join('; '));
				return data?.transactions?.nodes ?? [];
			});
	const [registers, certifies] = await Promise.all([
		run(`${packageId}::system::register_blob`),
		run(`${packageId}::system::certify_blob`),
	]);
	const acc = new Map<string, BlobAcc>();
	for (const tx of registers) foldTx(acc, tx, 'register', 'BlobRegistered');
	for (const tx of certifies) foldTx(acc, tx, 'certify', 'BlobCertified');
	return [...acc.entries()]
		.map(([blobId, b]) => ({ blobId, ...b }))
		.sort((a, b) => (b.timestampMs ?? 0) - (a.timestampMs ?? 0))
		.slice(0, limit);
};

// --- Storage epoch ----------------------------------------------------------

const LATEST_EVENT_QUERY = graphql(`
	query WalrusLatestEvent($type: String!) {
		events(last: 1, filter: { type: $type }) {
			nodes {
				contents {
					json
				}
				timestamp
			}
		}
	}
`);

/** The current Walrus storage epoch + when it last advanced. */
export interface WalrusEpoch {
	readonly epoch: number;
	readonly changedAtMs: number | null;
}

/**
 * The current Walrus storage epoch, read from the latest epoch-change event. We
 * prefer `EpochChangeDone` (the epoch that just *became* current); if none has
 * fired yet we fall back to `EpochChangeStart`. Returns null when neither event
 * exists (a freshly-booted cluster still in epoch 0 with no transitions).
 */
export const fetchWalrusEpoch = async (
	graphqlUrl: string,
	packageId: string,
): Promise<WalrusEpoch | null> => {
	const client = suiGraphqlClient(graphqlUrl);
	for (const name of ['EpochChangeDone', 'EpochChangeStart'] as const) {
		const { data, errors } = await client.query({
			query: LATEST_EVENT_QUERY,
			variables: { type: `${packageId}::events::${name}` },
		});
		if (errors?.length) throw new Error(errors.map((e) => e.message).join('; '));
		const node = data?.events?.nodes[0];
		if (!node?.contents) continue;
		const epoch = asNumber((node.contents.json as Record<string, unknown>).epoch);
		if (epoch !== null) return { epoch, changedAtMs: isoToMillis(node.timestamp) };
	}
	return null;
};

// --- Shard layout -----------------------------------------------------------

/** Per-node shard assignment for the current epoch. */
export interface ShardAssignment {
	/** Storage epoch these assignments are for. */
	readonly epoch: number;
	/** Number of distinct storage nodes that received shards this epoch. */
	readonly nodeCount: number;
	/** Total shards assigned across all nodes this epoch. */
	readonly totalShards: number;
	/** Shards held per node, in event order (one entry per `ShardsReceived`). */
	readonly perNode: ReadonlyArray<number>;
}

// `ShardsReceived` is emitted once per node when an epoch's shard set is handed
// over; reading the most recent N (one per node, a few epochs deep) and keeping
// the highest-epoch batch yields the current shard distribution.
const SHARDS_QUERY = graphql(`
	query WalrusShards($type: String!) {
		events(last: 32, filter: { type: $type }) {
			nodes {
				contents {
					json
				}
			}
		}
	}
`);

/**
 * Per-node shard assignments for the current epoch, derived from the
 * `ShardsReceived` events (one per storage node). Keeps only the events for the
 * highest epoch seen. Returns null when no shard events exist.
 */
export const fetchShardAssignments = async (
	graphqlUrl: string,
	packageId: string,
): Promise<ShardAssignment | null> => {
	const client = suiGraphqlClient(graphqlUrl);
	const { data, errors } = await client.query({
		query: SHARDS_QUERY,
		variables: { type: `${packageId}::events::ShardsReceived` },
	});
	if (errors?.length) throw new Error(errors.map((e) => e.message).join('; '));
	let maxEpoch = -1;
	const counts: number[] = [];
	for (const node of data?.events?.nodes ?? []) {
		const json = (node.contents?.json ?? {}) as Record<string, unknown>;
		const epoch = asNumber(json.epoch);
		const shards = Array.isArray(json.shards) ? json.shards.length : null;
		if (epoch === null || shards === null) continue;
		if (epoch > maxEpoch) {
			maxEpoch = epoch;
			counts.length = 0;
		}
		if (epoch === maxEpoch) counts.push(shards);
	}
	if (maxEpoch < 0) return null;
	return {
		epoch: maxEpoch,
		nodeCount: counts.length,
		totalShards: counts.reduce((a, b) => a + b, 0),
		perNode: counts,
	};
};

// --- React-query hooks ------------------------------------------------------
//
// Keyed by `network` (the cache namespace) + the walrus package id, so switching
// stacks never serves cross-network/cross-deploy results. Each hook stays
// disabled until both the GraphQL URL and the package id are resolved.

import { useQuery, type UseQueryResult } from '@tanstack/react-query';

/** What every Walrus GraphQL hook needs: the node's GraphQL URL + pkg id. */
export interface WalrusSource {
	readonly graphqlUrl: string | null;
	readonly packageId: string | null;
	/** Network identity (`projection.identity.network`) — the cache namespace. */
	readonly network: string;
}

const RECENT_STALE_MS = 5_000;
const EPOCH_STALE_MS = 15_000;

const ready = (s: WalrusSource): boolean => s.graphqlUrl !== null && s.packageId !== null;

/** Recent Walrus blobs (register/certify), newest-first. */
export const useRecentBlobs = (
	source: WalrusSource,
	limit = 25,
): UseQueryResult<ReadonlyArray<RecentBlob>> =>
	useQuery({
		queryKey: ['walrus', source.network, source.packageId, 'recentBlobs', limit],
		queryFn: () => fetchRecentBlobs(source.graphqlUrl as string, source.packageId as string, limit),
		enabled: ready(source),
		staleTime: RECENT_STALE_MS,
		refetchInterval: RECENT_STALE_MS * 2,
	});

/** Current Walrus storage epoch. */
export const useWalrusEpoch = (source: WalrusSource): UseQueryResult<WalrusEpoch | null> =>
	useQuery({
		queryKey: ['walrus', source.network, source.packageId, 'epoch'],
		queryFn: () => fetchWalrusEpoch(source.graphqlUrl as string, source.packageId as string),
		enabled: ready(source),
		staleTime: EPOCH_STALE_MS,
		refetchInterval: EPOCH_STALE_MS,
	});

/** Per-node shard assignments for the current epoch. */
export const useShardAssignments = (source: WalrusSource): UseQueryResult<ShardAssignment | null> =>
	useQuery({
		queryKey: ['walrus', source.network, source.packageId, 'shards'],
		queryFn: () => fetchShardAssignments(source.graphqlUrl as string, source.packageId as string),
		enabled: ready(source),
		staleTime: EPOCH_STALE_MS,
		refetchInterval: EPOCH_STALE_MS,
	});
