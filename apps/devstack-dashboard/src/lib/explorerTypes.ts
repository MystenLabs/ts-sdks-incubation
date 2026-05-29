// View-model types for the browser-side Sui explorer. The chain-read helpers in
// `chain.ts` map the raw `@mysten/sui/grpc` core/ledger shapes onto these
// flattened, display-ready records; the Explorer panel and the `ui/` atoms
// consume only these — no panel touches the protobuf surface directly.
//
// `TxObjectChange` / `TxBalanceChange` / `TxGas` are re-exported from the
// `TxEffectsView` atom so the canonical effects shape lives in one place: the
// `TxDetail.effects` field below is structurally a `TxEffects`, so a mapped
// transaction can be passed straight to `<TxEffectsView tx={tx.effects} />`.

import type { TxBalanceChange, TxEffects, TxGas, TxObjectChange } from '../ui/index.ts';

export type { TxBalanceChange, TxEffects, TxGas, TxObjectChange };

/** Transaction execution outcome, normalized from the gRPC `ExecutionStatus`. */
export type TxStatus = 'success' | 'failure';

/** A row in the Explorer "Latest transactions" list (cheap, list-shaped). */
export interface TxSummary {
	readonly digest: string;
	/** Sender address (`0x…`), or null when unavailable. */
	readonly sender: string | null;
	/** Coarse kind label (`ProgrammableTransaction`, `Genesis`, …). */
	readonly kind: string;
	/** Total gas used in MIST (computation + storage − rebate). */
	readonly gas: number;
	readonly status: TxStatus;
	/** Checkpoint sequence number this tx was included in. */
	readonly checkpoint: number;
	/** Checkpoint timestamp in epoch-millis, or null. */
	readonly timestampMs: number | null;
}

/** A single Move event within a transaction's detail. */
export interface TxEvent {
	readonly type: string;
	/** Parsed JSON representation of the event's Move struct, when available. */
	readonly fields: Record<string, unknown> | null;
}

/** Full transaction detail, including the `effects` block for `TxEffectsView`. */
export interface TxDetail {
	readonly digest: string;
	readonly status: TxStatus;
	readonly kind: string;
	readonly sender: string | null;
	readonly checkpoint: number | null;
	readonly timestampMs: number | null;
	/** Effects (gas + balance/object changes), shaped for `TxEffectsView`. */
	readonly effects: TxEffects;
	readonly events: ReadonlyArray<TxEvent>;
	/** PTB command summaries (one human-readable line each). */
	readonly commands: ReadonlyArray<string>;
	readonly balanceChanges: ReadonlyArray<TxBalanceChange>;
	readonly objectChanges: ReadonlyArray<TxObjectChange>;
}

/** Object ownership, flattened from the gRPC `ObjectOwner` discriminated union. */
export interface ObjectOwnerView {
	readonly kind:
		| 'AddressOwner'
		| 'ObjectOwner'
		| 'Shared'
		| 'Immutable'
		| 'ConsensusAddressOwner'
		| 'Unknown';
	/** Owning address/object id for Address/Object/ConsensusAddress owners. */
	readonly address: string | null;
}

/** A dynamic field entry under an object. */
export interface DynamicFieldView {
	/** The dynamic-field object id (navigable). */
	readonly id: string;
	/** Stringified field name. */
	readonly name: string;
	/** Value type tag. */
	readonly type: string;
	/** Whether it's a dynamic *object* field (vs a plain dynamic field). */
	readonly isObject: boolean;
}

/** Full object detail. */
export interface ObjectDetail {
	readonly id: string;
	readonly version: string;
	readonly digest: string;
	readonly type: string;
	readonly owner: ObjectOwnerView;
	readonly previousTx: string | null;
	/** Parsed JSON of the object's Move struct content, when available. */
	readonly fields: Record<string, unknown> | null;
	readonly dynamicFields: ReadonlyArray<DynamicFieldView>;
}

/** A Move function signature within a package module. */
export interface PackageFunctionView {
	readonly name: string;
	readonly visibility: 'public' | 'friend' | 'private' | 'unknown';
	readonly isEntry: boolean;
	/** Parameter count (positional). */
	readonly params: number;
}

/** A Move module within a package. */
export interface PackageModuleView {
	readonly name: string;
	readonly functions: ReadonlyArray<PackageFunctionView>;
}

/** Full package detail. */
export interface PackageDetail {
	readonly id: string;
	readonly version: string | null;
	readonly modules: ReadonlyArray<PackageModuleView>;
}

/** Epoch + system-state summary for the Explorer home KPIs. */
export interface EpochInfo {
	readonly epoch: number;
	readonly protocolVersion: number;
	readonly referenceGasPrice: number;
	readonly epochStartMs: number;
	/** Epoch duration in ms (from system parameters), when available. */
	readonly epochDurationMs: number | null;
}

/** Head-of-chain service info (chain id + latest executed checkpoint). */
export interface ChainHead {
	readonly chainId: string | null;
	readonly chain: string | null;
	readonly epoch: number;
	readonly checkpoint: number;
	/** Latest executed checkpoint timestamp in epoch-millis, or null. */
	readonly timestampMs: number | null;
	/** Lowest checkpoint for which data is available (pruning watermark). */
	readonly lowestAvailableCheckpoint: number | null;
}

/** Coin metadata + on-chain supply. */
export interface CoinInfo {
	readonly coinType: string;
	readonly name: string;
	readonly symbol: string;
	readonly description: string;
	readonly decimals: number;
	readonly iconUrl: string | null;
	/** Treasury-cap object id, when discoverable. */
	readonly metadataId: string | null;
}

/** One coin balance for an address. */
export interface BalanceView {
	readonly coinType: string;
	/** Total balance in the coin's base units (MIST for SUI), as a string. */
	readonly balance: string;
}
