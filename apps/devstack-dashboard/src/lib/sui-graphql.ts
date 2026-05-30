// Shared transport + reads for the node's Sui GraphQL endpoint (the new Sui
// GraphQL beta). This talks to the stack's `graphql` endpoint (CORS-open) via
// the official SDK's typed GraphQL client — distinct from `chain.ts` (gRPC
// `client.core.*`) and from the dashboard's own control-plane GraphQL (`api.ts`).
//
// gRPC `client.core` exposes object/balance reads keyed by address, but has no
// address→transactions query; the node's Sui GraphQL does, via the first-class
// `transactions(filter: …)` connection. `walrus.ts` also uses this transport for
// event/tx reads; the shared client factory + endpoint resolution live here so
// every Sui-GraphQL read (Walrus, address history, …) shares one shape.
//
// Queries are written with the SDK's `graphql()` tagged template
// (`@mysten/sui/graphql/schema`), which is pre-configured with the Sui GraphQL
// schema's introspection — so each document is type-checked against the real Sui
// schema at compile time (a wrong field name / shape is a `tsc` error), and the
// result types are inferred (no hand-rolled response interfaces). This is
// independent of the app's own gql.tada setup in `graphql.ts`, which is bound to
// the dashboard's control-plane schema.

import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { graphql } from '@mysten/sui/graphql/schema';
import type { Endpoint } from './types.ts';

// --- Endpoint resolution ----------------------------------------------------

/** The stack's Sui GraphQL query URL, or null. The `graphql` endpoint is
 *  registered as the bare host:port base, but the Sui GraphQL server serves
 *  queries under `/graphql` — so normalise the base onto that path (the SDK's
 *  `SuiGraphQLClient` POSTs to the URL verbatim, it does not append a path). */
export const suiGraphqlUrl = (endpoints: ReadonlyArray<Endpoint>): string | null => {
	const base = endpoints.find((e) => e.name.toLowerCase() === 'graphql')?.url;
	if (base === undefined) return null;
	const trimmed = base.replace(/\/+$/, '');
	return trimmed.endsWith('/graphql') ? trimmed : `${trimmed}/graphql`;
};

// --- GraphQL client ---------------------------------------------------------

const clients = new Map<string, SuiGraphQLClient>();

/**
 * A cached `SuiGraphQLClient` for the given node `graphql` URL, mirroring how
 * `chain.ts` lazily caches the `SuiGrpcClient`. `network: 'localnet'` is the
 * right discriminator for devstack's local/forked nodes — it only affects
 * MVR/name-service niceties, not the raw `transactions`/`events` reads here.
 */
export const suiGraphqlClient = (url: string): SuiGraphQLClient => {
	const existing = clients.get(url);
	if (existing) return existing;
	const client = new SuiGraphQLClient({ url, network: 'localnet' });
	clients.set(url, client);
	return client;
};

// --- Shared payload helpers -------------------------------------------------

/** Parse a `DateTime` (ISO string) to epoch-millis, or null. */
export const isoToMillis = (iso: string | null | undefined): number | null => {
	if (!iso) return null;
	const t = Date.parse(iso);
	return Number.isFinite(t) ? t : null;
};

// --- Address transaction history --------------------------------------------
//
// `transactions(filter: { sentAddress } | { affectedAddress })` is the address
// history surface. `sentAddress` is the transactions an address SIGNED (sent);
// `affectedAddress` is every transaction that touched it (received/affected:
// the superset that includes incoming transfers it didn't sign). Both filters
// and the per-tx selection below are verified against the live node schema:
//   - `digest`               — base58 tx digest (navigable to tx detail)
//   - `sender { address }`    — signer (`Address`), null for system txs
//   - `effects.status`        — `ExecutionStatus` enum: SUCCESS | FAILURE
//   - `effects.timestamp`     — `DateTime` (ISO), → epoch-millis for "when"
//   - `kind.__typename`       — the `TransactionKind` union member, e.g.
//                               `ProgrammableTransaction`, `GenesisTransaction`

/**
 * Which slice of transaction history to read.
 *   - `sent`     — txs an address signed (`sentAddress`)
 *   - `received` — every tx that touched an address (`affectedAddress`)
 *   - `object`   — every tx that used/affected an object (`affectedObject`)
 * The first two are the address view; `object` is the object view (an object id
 * isn't a signer, so its history is "transactions that use this object").
 */
export type TxDirection = 'sent' | 'received' | 'object';

/** Tx execution outcome, normalized from the GraphQL `ExecutionStatus` enum. */
export type TxOutcome = 'success' | 'failure' | 'unknown';

/** One row in an address's transaction history. */
export interface AddressTransaction {
	/** Base58 transaction digest (navigable to the tx detail view). */
	readonly digest: string;
	/** Signer address (`0x…`), or null for system transactions. */
	readonly sender: string | null;
	/** Execution outcome. */
	readonly status: TxOutcome;
	/** Coarse kind label, e.g. `ProgrammableTransaction` (the union member). */
	readonly kind: string;
	/** Effects timestamp in epoch-millis, or null. */
	readonly timestampMs: number | null;
}

// `last: N` returns the most recent N matching transactions (the connection
// pages oldest-first, so `first: N` would return the EARLIEST N — ancient
// history on a busy id); we then sort newest-first client-side so the table
// reads top-down. The per-tx selection is type-checked against the Sui schema
// by `graphql()`:
//   - `effects.status` is the `ExecutionStatus` enum (SUCCESS | FAILURE)
//   - `kind.__typename` is the `TransactionKind` union member
// `sentAddress` filters to txs the address signed; `affectedAddress` to every tx
// that touched it (the received/affected superset).
const ADDRESS_TXS_SENT = graphql(`
	query AddressSentTxs($addr: SuiAddress!, $limit: Int!) {
		transactions(last: $limit, filter: { sentAddress: $addr }) {
			nodes {
				digest
				sender {
					address
				}
				effects {
					status
					timestamp
				}
				kind {
					__typename
				}
			}
		}
	}
`);

const ADDRESS_TXS_RECEIVED = graphql(`
	query AddressReceivedTxs($addr: SuiAddress!, $limit: Int!) {
		transactions(last: $limit, filter: { affectedAddress: $addr }) {
			nodes {
				digest
				sender {
					address
				}
				effects {
					status
					timestamp
				}
				kind {
					__typename
				}
			}
		}
	}
`);

const OBJECT_TXS_AFFECTED = graphql(`
	query ObjectAffectedTxs($addr: SuiAddress!, $limit: Int!) {
		transactions(last: $limit, filter: { affectedObject: $addr }) {
			nodes {
				digest
				sender {
					address
				}
				effects {
					status
					timestamp
				}
				kind {
					__typename
				}
			}
		}
	}
`);

const toOutcome = (status: 'SUCCESS' | 'FAILURE' | null | undefined): TxOutcome =>
	status === 'SUCCESS' ? 'success' : status === 'FAILURE' ? 'failure' : 'unknown';

/**
 * Recent transactions for one filter on an id's history. `sent` filters by
 * `sentAddress` (signed by the address); `received` by `affectedAddress` (every
 * tx that touched it); `object` by `affectedObject` (every tx that used/affected
 * the object). Returns newest-first, capped at `limit`. Transactions without a
 * digest are dropped (a digest is required to navigate to the tx detail).
 */
export const fetchAddressTransactions = async (
	graphqlUrl: string,
	address: string,
	direction: TxDirection,
	limit = 25,
): Promise<ReadonlyArray<AddressTransaction>> => {
	const query =
		direction === 'sent'
			? ADDRESS_TXS_SENT
			: direction === 'object'
				? OBJECT_TXS_AFFECTED
				: ADDRESS_TXS_RECEIVED;
	const client = suiGraphqlClient(graphqlUrl);
	const { data, errors } = await client.query({ query, variables: { addr: address, limit } });
	if (errors?.length) throw new Error(errors.map((e) => e.message).join('; '));
	return (data?.transactions?.nodes ?? [])
		.flatMap(
			(n): ReadonlyArray<AddressTransaction> =>
				n.digest === null
					? []
					: [
							{
								digest: n.digest,
								sender: n.sender?.address ?? null,
								status: toOutcome(n.effects?.status),
								kind: n.kind?.__typename ?? 'Transaction',
								timestampMs: isoToMillis(n.effects?.timestamp),
							},
						],
		)
		.sort((a, b) => (b.timestampMs ?? 0) - (a.timestampMs ?? 0));
};

// --- React-query hook -------------------------------------------------------

import { useQuery, type UseQueryResult } from '@tanstack/react-query';

const ADDRESS_TXS_STALE_MS = 5_000;

/**
 * An address's recent transactions (one direction). Disabled until the GraphQL
 * URL is resolved — so on stacks without a `graphql` endpoint the query never
 * runs and the caller renders an honest "unavailable" state. Keyed by URL +
 * address + direction so switching stacks/addresses never serves stale results.
 */
export const useAddressTransactions = (
	graphqlUrl: string | null,
	address: string,
	direction: TxDirection,
	limit = 25,
): UseQueryResult<ReadonlyArray<AddressTransaction>> =>
	useQuery({
		queryKey: ['sui-graphql', graphqlUrl, 'addressTxs', address, direction, limit],
		queryFn: () => fetchAddressTransactions(graphqlUrl as string, address, direction, limit),
		enabled: graphqlUrl !== null && address !== '',
		staleTime: ADDRESS_TXS_STALE_MS,
		refetchInterval: ADDRESS_TXS_STALE_MS * 2,
	});
