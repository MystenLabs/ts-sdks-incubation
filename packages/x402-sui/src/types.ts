import type { ClientWithCoreApi, SuiClientTypes } from '@mysten/sui/client';

/**
 * Exact Sui payload: the client-signed transaction. On a facilitator-sponsored
 * payment the sponsor's signature is added at settlement.
 */
export type ExactSuiPayload = {
	/**
	 * Base64-encoded BCS transaction bytes.
	 */
	transaction: string;
	/**
	 * Base64-encoded serialized signature(s) over the transaction bytes. An array
	 * is needed when a second signer the client controls, such as its own gas
	 * sponsor, must sign. A single string is equivalent to a one-element array.
	 */
	signature: string | string[];
};

/**
 * The result of a {@link SuiExecutor}: the submitted transaction, an on-chain
 * failure, or a policy rejection. Balance changes need not be included; the
 * facilitator reads them from `waitForTransaction`.
 */
export type SuiExecutorResult =
	| { $kind: 'Transaction'; Transaction: SuiClientTypes.Transaction }
	| { $kind: 'FailedTransaction'; FailedTransaction: SuiClientTypes.Transaction }
	| { $kind: 'Rejected'; reason?: string; issues?: ReadonlyArray<{ message?: string }> };

/**
 * Submits facilitator-sponsored transactions, for example a gas sponsor that
 * adds its signature. Required when `feePayer` is set.
 */
export type SuiExecutor = (input: {
	transaction: Uint8Array;
	signatures: string[];
}) => Promise<SuiExecutorResult>;

/**
 * The identity of a settlement. `maxEpoch` is the transaction's last valid
 * epoch: a claim must be kept until that epoch has ended.
 */
export type SettlementKey = {
	network: string;
	digest: string;
	maxEpoch: string;
};

/**
 * The result of {@link SettlementGuard.claim}:
 *
 * - `claimed`: the key was free and the caller now holds it.
 * - `pending`: an earlier settlement of the key ended with an unknown outcome
 *   (`settlement_pending`). The caller now holds it and reconciles that attempt.
 * - `held`: the key is settled, or another settle holds it.
 */
export type SettlementClaim = 'claimed' | 'pending' | 'held';

/**
 * Records which transactions have been settled so the facilitator reports
 * success at most once per digest. The facilitator claims a key before
 * submitting. It keeps the claim on success, marks it pending when the outcome
 * is unknown, and releases it otherwise. Keep successful and pending claims
 * until the network is two epochs past `maxEpoch`: one epoch for the window to
 * end, and one of margin for a lagging fullnode.
 *
 * When several processes serve `/settle`, they MUST share one claim store with
 * atomic claims. A single process MAY keep claims in memory, as the default
 * {@link SettlementCache} does. Claims kept in memory are lost on restart. The
 * facilitator then falls back on a best-effort digest lookup before it submits,
 * so a facilitator that must not depend on node history SHOULD use a durable
 * store.
 */
export interface SettlementGuard {
	/**
	 * Atomically claim a key. A free key and a pending key both become held.
	 *
	 * @param key - The settlement identity
	 * @returns The claim result
	 */
	claim(key: SettlementKey): SettlementClaim | Promise<SettlementClaim>;

	/**
	 * Mark a held key as pending: its submission may still execute, and the next
	 * claim reconciles it.
	 *
	 * @param key - The settlement identity
	 */
	markPending(key: SettlementKey): void | Promise<void>;

	/**
	 * Release a held key after a settlement that did not succeed.
	 *
	 * @param key - The settlement identity
	 */
	release(key: SettlementKey): void | Promise<void>;

	/**
	 * Optional. Receives each epoch the facilitator reads from a network, so the
	 * store can drop claims more than one epoch past their `maxEpoch`.
	 *
	 * @param network - The CAIP-2 network id
	 * @param epoch - The network's current epoch
	 */
	observeEpoch?(network: string, epoch: bigint): void | Promise<void>;
}

/**
 * Per-network Sui client overrides. Any client implementing the core API works
 * (gRPC, GraphQL). Networks without an override use a gRPC client for the
 * public fullnode.
 */
export type SuiClientOptions = {
	/**
	 * Sui clients keyed by CAIP-2 network id (e.g. "sui:mainnet").
	 */
	clients?: Record<string, ClientWithCoreApi>;
};

/**
 * Facilitator options.
 */
export type FacilitatorSuiOptions = SuiClientOptions & {
	/**
	 * Submits facilitator-sponsored transactions. Required when `feePayer` is set.
	 */
	executeTransaction?: SuiExecutor;
	/**
	 * Gas sponsor address advertised as `extra.feePayer`. Clients set it as the
	 * gas owner, and `executeTransaction` must add its signature.
	 */
	feePayer?: string;
	/**
	 * Largest gas budget, in MIST, accepted on a sponsored payment. Defaults to
	 * {@link DEFAULT_MAX_SPONSORED_GAS_BUDGET}.
	 */
	maxSponsoredGasBudget?: bigint;
	/**
	 * Settlement dedup guard. Defaults to an in-process {@link SettlementCache}.
	 */
	settlementGuard?: SettlementGuard;
};
