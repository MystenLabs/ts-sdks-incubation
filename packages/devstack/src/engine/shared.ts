// Shared types used by every primitive.
//
// We deliberately do NOT re-export gRPC's `Transaction` envelope from
// `@mysten/sui/grpc` — that shape is wire-level and changes between
// SDK versions. Instead, we keep a stable internal `SuiObjectChange`
// shape that mirrors the small subset of `objectChanges` semantics
// primitives actually consume (`type`, `objectId`, `objectType`,
// `packageId`). `account.ts` maps the gRPC `TransactionResult` into a
// `TxResult` carrying this stable shape on every signAndExecute.

import type { Transaction } from '@mysten/sui/transactions';
import type { Effect } from 'effect';

export type { Transaction };

/**
 * Devstack-internal projection of an on-chain object change.
 *
 * Pre-Phase-1 this re-exported `@mysten/sui/jsonRpc`'s `SuiObjectChange`
 * union verbatim. The gRPC client returns a different shape
 * (`effects.changedObjects[]` keyed by `idOperation`) so we synthesize
 * this stable union from gRPC results in `account.ts`. The fields here
 * are the strict subset that downstream primitives actually consume:
 *
 *   - `pickCreatedByType` reads `type === 'created'` + `objectType`.
 *   - `publishMove` looks for `type === 'published'` to extract
 *     `packageId`.
 *   - `services/seal/internal.ts` / `services/deepbook/local-deploy.ts`
 *     read `type === 'created'` + `objectType` + `objectId`.
 *
 * Higher-level fields (`sender`, `recipient`, `version`, `digest`) the
 * JSON-RPC shape carried are no longer surfaced — primitives that
 * needed them switched to follow-up `client.core.getObject` calls
 * before this migration. The narrow union below keeps the migration
 * behavior-preserving for every consumer in this repo.
 */
export type SuiObjectChange =
	| {
			readonly type: 'created';
			readonly objectId: string;
			readonly objectType: string;
			/**
			 * Address-owner of the object post-creation, when it has one.
			 * Populated from gRPC's `outputOwner.AddressOwner`; coins/caps
			 * transferred to a shared/object/immutable owner at publish time
			 * land here as `undefined`. Surfaced for the coin-discovery pass
			 * (Phase 0 of `notes/coin-auto-discovery.md`) — a `TreasuryCap`
			 * not owned by the publisher signs as "read-only coin" and skips
			 * mint-strategy registration.
			 */
			readonly owner?: string;
	  }
	| {
			readonly type: 'mutated';
			readonly objectId: string;
			readonly objectType: string;
			/** See `created.owner` — same semantics. */
			readonly owner?: string;
	  }
	| {
			readonly type: 'deleted';
			readonly objectId: string;
			readonly objectType: string;
	  }
	| {
			readonly type: 'published';
			readonly packageId: string;
	  };

/**
 * Devstack-internal projection of transaction effects. Mirrors the
 * minimal surface every primitive that yields a `TxResult.effects` cares
 * about: `.status.status` (`'success'` or `'failure'`) plus an optional
 * `.status.error` string. Other gRPC effect fields (gas usage, dependency
 * digests, ledger version) are intentionally NOT surfaced — primitives
 * that need them go through the client directly.
 */
export interface TxEffects {
	readonly status: {
		readonly status: 'success' | 'failure';
		readonly error?: string;
	};
}

/**
 * Result returned by every `Account.signAndExecute(...)`.
 *
 * Folded together post-execution by `account.ts::mapTxResult` from the
 * raw gRPC `TransactionResult`. `objectChanges` is synthesized — see
 * the {@link SuiObjectChange} docs.
 */
export interface TxResult {
	readonly digest: string;
	readonly effects: TxEffects;
	readonly objectChanges: ReadonlyArray<SuiObjectChange>;
	readonly balanceChanges: ReadonlyArray<BalanceChange> | undefined;
}

/** Balance-change projection. Stable across gRPC SDK versions.
 *
 *  Phase -1 (gRPC migration): the gRPC SDK's `BalanceChange` carries
 *  `address` (the affected account's Sui address) where the legacy
 *  JSON-RPC shape used `owner` with the full `ObjectOwner` discriminated
 *  union. gRPC normalizes coin-balance ownership to an address (coins
 *  are always address-owned, never shared or immutable), so the
 *  projection here folds to a plain address string. */
export interface BalanceChange {
	readonly address: string;
	readonly coinType: string;
	readonly amount: string;
}

export interface SignAndExecuteOptions {
	readonly gasBudget?: bigint;
	readonly waitForLocalExecution?: boolean;
}

// An Account's signAndExecute returns an Effect — the client is closed
// over at construction time, so R = never. The user yields it inside
// their Effect.gen body.
export interface SignAndExecuteError {
	readonly _tag: 'SignAndExecuteError';
	readonly message: string;
	readonly cause?: unknown;
}

/**
 * The resolved per-account contract every per-name account `LayeredTag`
 * produced by `Account(name, opts?)` yields.
 *
 * **Signer conformance** — this shape mirrors `@mysten/sui/cryptography`'s
 * abstract `Signer` class surface (`sign{Transaction,PersonalMessage}` /
 * `getKeyScheme` (as `scheme`) / `getPublicKey` (as `publicKey`) /
 * `toSuiAddress` (as `address`)) but in the Effect idiom — every signing
 * closure returns an `Effect<..., SignAndExecuteError>` rather than the
 * SDK's `Promise<...>`. Plugin authors writing factories that need a
 * structural-Signer can either accept `DevstackSigner` (the SDK's raw
 * `Signer` class — see `/advanced` re-export) for non-Effect callsites,
 * or `LayeredTag<any, Account, any, any>` for Effect-native ones. The
 * `'signer'` branch of `AccountSpec` accepts a raw `Signer` and adapts
 * it to this Effect-flavored contract internally.
 */
export interface Account {
	readonly name: string;
	readonly address: string;
	readonly publicKey: Uint8Array;
	// Lowercased to match @mysten/sui's `decodeSuiPrivateKey(…).schema.toLowerCase()`
	// and the on-chain Move type conventions. The runtime impl calls
	// `signer.getKeyScheme().toLowerCase()` in services/account.ts.
	readonly scheme: 'ed25519' | 'secp256k1' | 'secp256r1';
	/**
	 * Where the account's signing material comes from. Optional —
	 * pre-Phase-4 callers don't set it. The wallet server's
	 * `handleAccounts` surfaces it to the browser-side adapter so the
	 * accounts panel can render an "(impersonation)" label on
	 * fork-mode accounts (Phase 4 P4.18). `'impersonate'` means devstack
	 * holds NO keys for this address — every signing request routes
	 * through `executeImpersonated` instead.
	 */
	readonly source?: 'real' | 'impersonate';
	signAndExecute(
		transaction: Transaction,
		options?: SignAndExecuteOptions,
	): Effect.Effect<TxResult, SignAndExecuteError>;
	// Takes pre-built tx bytes (the dapp-kit wallet adapter ships them
	// to the wallet server as base64; the server decodes once and hands
	// the Uint8Array to this method). Returns the @mysten/sui Signer's
	// native `{ bytes, signature }` shape so callers can forward to
	// `executeTransactionBlock` without re-serialization.
	signTransaction(
		transactionBytes: Uint8Array,
	): Effect.Effect<{ signature: string; bytes: string }, SignAndExecuteError>;
	signPersonalMessage(
		messageBytes: Uint8Array,
	): Effect.Effect<{ signature: string; bytes: string }, SignAndExecuteError>;
}
