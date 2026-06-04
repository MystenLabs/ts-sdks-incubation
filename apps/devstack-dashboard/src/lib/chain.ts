// Direct chain access. Chain data is read straight from the Sui node over gRPC
// (`client.core.*`, the modern non-JSON-RPC surface) rather than proxied through
// the dashboard's control-plane GraphQL API. The node's gRPC endpoint is the
// stack's `rpc` endpoint (router-fronted, CORS-open).
//
// The gRPC client (and its protobuf runtime) is a heavy dependency, so it is
// imported lazily on first use — chain reads are on-demand, so the core bundle
// stays lean and only loads it when a chain feature is actually used.

import type { SuiClientTypes } from '@mysten/sui/client';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import type {
	BalanceView,
	ChainHead,
	CoinInfo,
	DynamicFieldView,
	EntityKind,
	EpochInfo,
	ObjectDetail,
	ObjectOwnerView,
	OwnedObjectView,
	PackageDetail,
	PackageModuleView,
	TxBalanceChange,
	TxDetail,
	TxEvent,
	TxObjectChange,
	TxStatus,
	TxSummary,
} from './explorerTypes.ts';
import type { Endpoint } from './types.ts';

/** The Sui node's gRPC base URL — the stack's `rpc` endpoint, if present. */
export const suiRpcUrl = (endpoints: ReadonlyArray<Endpoint>): string | null =>
	endpoints.find((e) => e.name.toLowerCase() === 'rpc')?.url ?? null;

const clients = new Map<string, SuiGrpcClient>();

/** A cached `SuiGrpcClient` for the given node base URL (lazily imported). */
export const chainClient = async (rpcUrl: string): Promise<SuiGrpcClient> => {
	const existing = clients.get(rpcUrl);
	if (existing) return existing;
	const { SuiGrpcClient } = await import('@mysten/sui/grpc');
	// `localnet` is the right discriminator for devstack's local/forked nodes;
	// it only affects MVR/wallet-standard niceties, not core reads.
	const client = new SuiGrpcClient({ baseUrl: rpcUrl, network: 'localnet' });
	clients.set(rpcUrl, client);
	return client;
};

// --- Read helpers -----------------------------------------------------------
//
// Each helper takes the node's `rpcUrl` and returns a flattened view-model from
// `explorerTypes.ts` — panels and `useChain` hooks never touch the raw protobuf
// / `client.core.*` shapes. All numbers that arrive as `bigint`/string are
// narrowed to `number` (safe for devstack's local checkpoint/epoch ranges).

const SUI_TYPE = '0x2::sui::SUI';

const num = (v: bigint | string | number | null | undefined): number =>
	v === null || v === undefined ? 0 : typeof v === 'bigint' ? Number(v) : Number(v);

/** Convert a protobuf `Timestamp` ({ seconds, nanos }) to epoch-millis. */
const tsToMillis = (ts: { seconds?: bigint; nanos?: number } | undefined): number | null => {
	if (!ts) return null;
	return Number(ts.seconds ?? 0n) * 1000 + Math.floor((ts.nanos ?? 0) / 1e6);
};

const statusOf = (status: SuiClientTypes.ExecutionStatus | undefined): TxStatus =>
	status?.success ? 'success' : 'failure';

const ownerView = (owner: SuiClientTypes.ObjectOwner | null | undefined): ObjectOwnerView => {
	if (!owner) return { kind: 'Unknown', address: null };
	switch (owner.$kind) {
		case 'AddressOwner':
			return { kind: 'AddressOwner', address: owner.AddressOwner };
		case 'ObjectOwner':
			return { kind: 'ObjectOwner', address: owner.ObjectOwner };
		case 'ConsensusAddressOwner':
			return { kind: 'ConsensusAddressOwner', address: owner.ConsensusAddressOwner.owner };
		case 'Shared':
			return { kind: 'Shared', address: null };
		case 'Immutable':
			return { kind: 'Immutable', address: null };
		default:
			return { kind: 'Unknown', address: null };
	}
};

const gasView = (effects: SuiClientTypes.TransactionEffects | undefined) => {
	const g = effects?.gasUsed;
	return {
		computation: num(g?.computationCost),
		storage: num(g?.storageCost),
		rebate: num(g?.storageRebate),
		budget: 0,
		price: 0,
	};
};

const balanceChangeViews = (
	changes: SuiClientTypes.BalanceChange[] | undefined,
): TxBalanceChange[] =>
	(changes ?? []).map((c) => ({ owner: c.address, coin: c.coinType, amount: num(c.amount) }));

const CHANGE_KIND: Record<SuiClientTypes.ChangedObject['idOperation'], TxObjectChange['kind']> = {
	Created: 'created',
	Deleted: 'deleted',
	None: 'mutated',
	Unknown: 'mutated',
};

const objectChangeViews = (
	effects: SuiClientTypes.TransactionEffects | undefined,
	objectTypes: Record<string, string> | undefined,
): TxObjectChange[] =>
	(effects?.changedObjects ?? []).map((o) => ({
		kind: CHANGE_KIND[o.idOperation] ?? 'mutated',
		id: o.objectId,
		type: objectTypes?.[o.objectId] ?? '',
	}));

const eventViews = (events: SuiClientTypes.Event[] | undefined): TxEvent[] =>
	(events ?? []).map((e) => ({ type: e.eventType, fields: e.json }));

/** PTB command one-liners, derived from the parsed transaction data when present. */
const commandSummaries = (tx: SuiClientTypes.Transaction): string[] => {
	const data = tx.transaction;
	if (!data) return [];
	// `TransactionData` (SerializedTransactionDataV2): commands carry a `$kind`.
	const commands = (data as { commands?: ReadonlyArray<{ $kind?: string }> }).commands;
	if (!commands) return [];
	return commands.map((c, i) => c.$kind ?? `command ${i}`);
};

const txKind = (tx: SuiClientTypes.Transaction): string => {
	const kind = (tx.transaction as { kind?: { $kind?: string } } | undefined)?.kind?.$kind;
	return kind ?? 'ProgrammableTransaction';
};

const senderOf = (tx: SuiClientTypes.Transaction): string | null =>
	(tx.transaction as { sender?: string } | undefined)?.sender ?? null;

/** Head-of-chain info: chain id, current epoch, latest executed checkpoint. */
export const fetchChainHead = async (rpcUrl: string): Promise<ChainHead> => {
	const client = await chainClient(rpcUrl);
	const { response } = await client.ledgerService.getServiceInfo({});
	const head = response.checkpointHeight ?? 0n;
	// `getServiceInfo` carries no transaction total — only the head checkpoint's
	// `CheckpointSummary.total_network_transactions` (running count since genesis)
	// exposes it. Read just that field from the head checkpoint so callers can
	// derive a real TPS from Δ(totalTransactions)/Δt across head ticks.
	let totalTransactions: number | null = null;
	try {
		const { response: cp } = await client.ledgerService.getCheckpoint({
			checkpointId: { oneofKind: 'sequenceNumber', sequenceNumber: head },
			readMask: { paths: ['summary.total_network_transactions'] },
		});
		const total = cp.checkpoint?.summary?.totalNetworkTransactions;
		totalTransactions = total === undefined ? null : num(total);
	} catch {
		// Node may not have the head checkpoint yet (just starting); keep null.
		totalTransactions = null;
	}
	return {
		chainId: response.chainId ?? null,
		chain: response.chain ?? null,
		epoch: num(response.epoch),
		checkpoint: num(response.checkpointHeight),
		timestampMs: tsToMillis(response.timestamp),
		lowestAvailableCheckpoint:
			response.lowestAvailableCheckpoint === undefined
				? null
				: num(response.lowestAvailableCheckpoint),
		totalTransactions,
	};
};

/** Reference gas price (MIST). */
export const fetchReferenceGasPrice = async (rpcUrl: string): Promise<number> => {
	const client = await chainClient(rpcUrl);
	const { referenceGasPrice } = await client.core.getReferenceGasPrice();
	return num(referenceGasPrice);
};

/** Current epoch + system-state summary. */
export const fetchEpochInfo = async (rpcUrl: string): Promise<EpochInfo> => {
	const client = await chainClient(rpcUrl);
	const { systemState } = await client.core.getCurrentSystemState();
	return {
		epoch: num(systemState.epoch),
		protocolVersion: num(systemState.protocolVersion),
		referenceGasPrice: num(systemState.referenceGasPrice),
		epochStartMs: num(systemState.epochStartTimestampMs),
		epochDurationMs: systemState.parameters?.epochDurationMs
			? num(systemState.parameters.epochDurationMs)
			: null,
	};
};

/**
 * Latest transactions, derived by walking checkpoints back from the head (there
 * is no "latest N transactions" RPC). Reads the head checkpoint height via
 * `getServiceInfo`, then `getCheckpoint` per sequence (newest first) pulling the
 * per-tx digest/effects/timestamp, until `limit` transactions are collected.
 */
export const fetchLatestTransactions = async (rpcUrl: string, limit = 25): Promise<TxSummary[]> => {
	const client = await chainClient(rpcUrl);
	const { response: info } = await client.ledgerService.getServiceInfo({});
	const head = info.checkpointHeight ?? 0n;
	const out: TxSummary[] = [];
	// Request only what the list needs from each checkpoint.
	const readMask = {
		paths: [
			'sequence_number',
			'transactions.digest',
			'transactions.timestamp',
			'transactions.transaction.kind',
			'transactions.transaction.sender',
			'transactions.effects.status',
			'transactions.effects.gas_used',
		],
	};
	for (let seq = head; seq >= 0n && out.length < limit; seq -= 1n) {
		const { response } = await client.ledgerService.getCheckpoint({
			checkpointId: { oneofKind: 'sequenceNumber', sequenceNumber: seq },
			readMask,
		});
		const cp = response.checkpoint;
		if (!cp) continue;
		const cpSeq = num(cp.sequenceNumber);
		// Newest-first within the checkpoint too.
		for (const t of [...cp.transactions].reverse()) {
			if (out.length >= limit) break;
			out.push({
				digest: t.digest ?? '',
				sender: t.transaction?.sender ?? null,
				// Low-level `TransactionKind` carries a `data` oneof — use its
				// discriminator (`programmableTransaction`, `genesis`, …) as the label.
				kind: t.transaction?.kind?.data?.oneofKind ?? 'transaction',
				gas:
					num(t.effects?.gasUsed?.computationCost) +
					num(t.effects?.gasUsed?.storageCost) -
					num(t.effects?.gasUsed?.storageRebate),
				status: t.effects?.status?.success ? 'success' : 'failure',
				checkpoint: cpSeq,
				timestampMs: tsToMillis(t.timestamp),
			});
		}
		if (seq === 0n) break;
	}
	return out;
};

/** Full transaction detail (effects + events + balance/object changes). */
export const fetchTransaction = async (rpcUrl: string, digest: string): Promise<TxDetail> => {
	const client = await chainClient(rpcUrl);
	const result = await client.core.getTransaction({
		digest,
		include: {
			effects: true,
			events: true,
			balanceChanges: true,
			objectTypes: true,
			transaction: true,
		},
	});
	const tx = result.$kind === 'Transaction' ? result.Transaction : result.FailedTransaction;
	const balanceChanges = balanceChangeViews(tx.balanceChanges);
	const objectChanges = objectChangeViews(tx.effects, tx.objectTypes);
	return {
		digest: tx.digest,
		status: statusOf(tx.status),
		kind: txKind(tx),
		sender: senderOf(tx),
		checkpoint: tx.effects ? num(tx.effects.version) : null,
		timestampMs: null,
		effects: { gas: gasView(tx.effects), balanceChanges, objectChanges },
		events: eventViews(tx.events),
		commands: commandSummaries(tx),
		balanceChanges,
		objectChanges,
	};
};

/** Object detail (+ first page of dynamic fields). */
export const fetchObject = async (rpcUrl: string, objectId: string): Promise<ObjectDetail> => {
	const client = await chainClient(rpcUrl);
	const [{ object }, dynamicFields] = await Promise.all([
		client.core.getObject({ objectId, include: { json: true, previousTransaction: true } }),
		fetchDynamicFields(rpcUrl, objectId).catch(() => [] as DynamicFieldView[]),
	]);
	return {
		id: object.objectId,
		version: object.version,
		digest: object.digest,
		type: object.type,
		owner: ownerView(object.owner),
		previousTx: object.previousTransaction ?? null,
		fields: object.json ?? null,
		dynamicFields,
	};
};

/**
 * Resolve what a `0x…` id is. Addresses, objects, and packages are byte-identical
 * (`0x` + 64 hex) so the only honest way to tell them apart is to probe the node:
 *
 *  1. `movePackageService.getPackage` — succeeds only for a published package.
 *  2. else `core.getObject` — exists ⇒ it's an object; and if that object is a
 *     Move package (the gRPC `objectType` for a package is the literal string
 *     `"package"`), report `'package'` too ("an object can be a package").
 *  3. else (neither package nor object) ⇒ treat it as a plain `'address'`.
 *
 * Both `getPackage` and `getObject` *throw* on not-found, so each probe is wrapped
 * — a miss falls through to the next branch rather than propagating.
 */
export const resolveEntity = async (rpcUrl: string, id: string): Promise<EntityKind> => {
	const client = await chainClient(rpcUrl);
	try {
		await client.movePackageService.getPackage({ packageId: id });
		return 'package';
	} catch {
		// Not a package — fall through to the object probe.
	}
	try {
		const { object } = await client.core.getObject({ objectId: id });
		// A package fetched as an object reports `objectType === 'package'`.
		return object.type === 'package' ? 'package' : 'object';
	} catch {
		// Neither a package nor an existing object ⇒ a bare address.
		return 'address';
	}
};

/** Objects owned by an address (first page), for the address view. */
export const fetchOwnedObjects = async (
	rpcUrl: string,
	owner: string,
	limit = 50,
): Promise<OwnedObjectView[]> => {
	const client = await chainClient(rpcUrl);
	const { objects } = await client.core.listOwnedObjects({ owner, limit });
	return objects.map((o) => ({
		id: o.objectId,
		version: o.version,
		type: o.type,
	}));
};

/** Dynamic fields under a parent object (first page). */
export const fetchDynamicFields = async (
	rpcUrl: string,
	parentId: string,
	limit = 50,
): Promise<DynamicFieldView[]> => {
	const client = await chainClient(rpcUrl);
	const { dynamicFields } = await client.core.listDynamicFields({ parentId, limit });
	return dynamicFields.map((f) => ({
		id: f.$kind === 'DynamicObject' ? f.childId : f.fieldId,
		name: f.name.type,
		type: f.valueType,
		isObject: f.$kind === 'DynamicObject',
	}));
};

/** Package detail — modules with their function signatures. */
export const fetchPackage = async (rpcUrl: string, packageId: string): Promise<PackageDetail> => {
	const client = await chainClient(rpcUrl);
	// `GetPackageRequest` in @mysten/sui 2.17.0 has no `read_mask`; the response
	// always carries the full package (modules + function descriptors).
	const { response } = await client.movePackageService.getPackage({ packageId });
	const pkg = response.package;
	const modules: PackageModuleView[] = (pkg?.modules ?? []).map((m) => ({
		name: m.name ?? '',
		functions: (m.functions ?? []).map((fn) => ({
			name: fn.name ?? '',
			// FunctionDescriptor.Visibility enum: PRIVATE=1, PUBLIC=2, FRIEND=3.
			visibility:
				fn.visibility === 2
					? 'public'
					: fn.visibility === 3
						? 'friend'
						: fn.visibility === 1
							? 'private'
							: 'unknown',
			isEntry: fn.isEntry ?? false,
			params: fn.parameters?.length ?? 0,
		})),
	}));
	return {
		id: pkg?.storageId ?? packageId,
		version: pkg?.version === undefined ? null : num(pkg.version).toString(),
		modules,
	};
};

/** Coin metadata + addressing facts for a coin type. */
export const fetchCoinMeta = async (rpcUrl: string, coinType: string): Promise<CoinInfo | null> => {
	const client = await chainClient(rpcUrl);
	const { coinMetadata } = await client.core.getCoinMetadata({ coinType });
	if (!coinMetadata) return null;
	return {
		coinType,
		name: coinMetadata.name,
		symbol: coinMetadata.symbol,
		description: coinMetadata.description,
		decimals: coinMetadata.decimals,
		iconUrl: coinMetadata.iconUrl,
		metadataId: coinMetadata.id,
	};
};

/**
 * Total supply of a coin, read from its `TreasuryCap` object. A `TreasuryCap<T>`
 * wraps a `Supply<T>` under `total_supply`, whose `value: u64` is the minted
 * total (base units). The parsed Move `json` shape can nest the value either as
 * `total_supply.value` or `total_supply.fields.value` depending on the node's
 * BCS→JSON projection, so both are probed. Returns the raw base-unit string
 * (decimals are applied by the caller), or null when unreadable.
 */
export const fetchTotalSupply = async (
	rpcUrl: string,
	treasuryCapId: string,
): Promise<string | null> => {
	const client = await chainClient(rpcUrl);
	const { object } = await client.core.getObject({
		objectId: treasuryCapId,
		include: { json: true },
	});
	const fields = object.json as Record<string, unknown> | null | undefined;
	if (!fields) return null;
	const supply = fields.total_supply as Record<string, unknown> | null | undefined;
	if (!supply) return null;
	// Defensive: the inner `Supply` struct may be flattened (`{ value }`) or kept
	// under a nested `fields` envelope (`{ fields: { value } }`).
	const inner = (supply.fields as Record<string, unknown> | undefined) ?? supply;
	const value = inner.value;
	if (value === undefined || value === null) return null;
	return String(value);
};

/** All non-zero balances owned by an address (first page). */
export const fetchBalances = async (rpcUrl: string, owner: string): Promise<BalanceView[]> => {
	const client = await chainClient(rpcUrl);
	const { balances } = await client.core.listBalances({ owner });
	return balances.map((b) => ({ coinType: b.coinType, balance: b.balance }));
};

/** SUI balance for an address (MIST, as a string). */
export const fetchSuiBalance = async (rpcUrl: string, owner: string): Promise<string> => {
	const client = await chainClient(rpcUrl);
	const { balance } = await client.core.getBalance({ owner, coinType: SUI_TYPE });
	return balance.balance;
};
