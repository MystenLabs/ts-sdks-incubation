// Generic mint — wraps `0x2::coin::mint_and_transfer<T>` in the
// `ArtifactPublisher` substrate primitive.
//
// Distilled-doc 13-coin.md §"Lifecycle" §"mintFromTreasury":
//
//   - Cache key:    (chainId, treasuryCapId, recipient, amount)
//   - Verify:       lenient probe on the cached minted-coin id
//                   (Invariant 1 — vanish-detection)
//   - Produce:      sign + execute the `mint_and_transfer<T>` tx,
//                   find the minted `Coin<T>` in objectChanges
//   - Register:     in-memory note of the mint (no global registry —
//                   the resolved value carries everything callers
//                   need).
//
// Best-effort cache writes (distilled-doc Invariant 2): the mint
// already settled on chain; a state-store IO defect just means the
// next supervisor cycle re-mints. Don't let a StateStore failure
// roll back the mint.
//
// Substrate constraint: the `ArtifactPublisher.publish` shape
// already covers cache + verify + produce + register-on-every-cycle.
// We compose its spec; the substrate dispatches.

import { Effect, Schema, type Scope } from 'effect';
import { Transaction } from '@mysten/sui/transactions';

import type { ChainId, ContentHash } from '../../substrate/brand.ts';
import { contentHash as brandContentHash } from '../../substrate/brand.ts';
import { decodeUnknown } from '../../substrate/runtime/runtime-decode.ts';
import type {
	ArtifactPublishError,
	ArtifactPublisher,
} from '../../primitives/artifact-publisher.ts';
import type { ClientWithCoreApi } from '../sui/index.ts';
import { coinError, type CoinError } from './errors.ts';
import { CoinSpans } from './spans.ts';
import { isSuiFrameworkObjectForCoin } from './type-strings.ts';

/** Sign+execute surface narrowed from `AccountValue.signAndExecute`.
 *  We don't import `AccountValue` directly to avoid a layering cycle —
 *  the Account plugin imports nothing from coin, so coin re-publishes
 *  the structural shape. Mirrors the SDK's discriminated
 *  `TransactionResult` return shape — on-chain failures are a return
 *  variant (`$kind: 'FailedTransaction'`), not an error. */
export interface MintSignAndExecuteResult {
	readonly $kind: 'Transaction' | 'FailedTransaction';
	readonly Transaction?: {
		readonly digest: string;
		readonly objectChanges: ReadonlyArray<unknown>;
	};
	readonly FailedTransaction?: {
		readonly digest: string;
		readonly executionError?: string;
	};
}

export interface MintTransactionSigner {
	readonly signAndExecute: (
		tx: Uint8Array,
	) => Effect.Effect<
		MintSignAndExecuteResult,
		{ readonly _tag: 'AccountSignError'; readonly message: string }
	>;
}

export interface MintSigner extends MintTransactionSigner {
	readonly address: string;
	readonly withTransactionSigner: <A, E, R>(
		body: (signer: MintTransactionSigner) => Effect.Effect<A, E, R>,
	) => Effect.Effect<A, E, R>;
}

/** Cached payload — the stable id verify re-confirms on every cycle.
 *  Distilled-doc invariant: the probe MUST consume a STABLE on-chain
 *  identifier (the minted Coin<T>'s objectId), NOT a derived hash. */
export interface CachedMint {
	readonly digest: string;
	readonly mintedCoinId: string;
	readonly recipient: string;
	/** `amount.toString()` — bigint isn't serializable. */
	readonly amount: string;
}

/** Verify-schema: what we expect when probing the minted coin.
 *  IMPORTANT (chain-probe schema constraint from the last sweep):
 *  schema literal uses ONLY service-free combinators. */
export const MintedCoinVerifyShape = Schema.Struct({
	objectId: Schema.String,
	type: Schema.String,
});

/** Build the cache-key content hash. Distilled-doc 13-coin.md
 *  §"Persistence model": key shape is
 *  `coin/mint/<chainId>/<treasuryCapId>/<signerAddress>/<recipient>/<amount>`.
 *  The substrate's artifact publisher folds in chainId via the
 *  `chain` parameter; we fold the remaining columns into `contentHash`.
 *
 *  `signerAddress` is folded in because the producing signer is part
 *  of the cache identity — reusing the same `(treasuryCap, recipient,
 *  amount)` under a different signer MUST miss the cache so the new
 *  signer actually re-executes the mint. Mirrors the symmetric
 *  `publisherAddress` fold in `plugins/package/mode-local.ts:149-152`.
 *  Backlog #6. */
export const buildMintContentHash = (parts: {
	readonly treasuryCapId: string;
	readonly recipient: string;
	readonly amount: bigint;
	readonly signerAddress: string;
}): ContentHash =>
	brandContentHash(
		`mint/${parts.treasuryCapId}/${parts.signerAddress}/${parts.recipient}/${parts.amount.toString()}`,
	);

export interface MintInputs {
	readonly fullCoinType: string;
	readonly treasuryCapId: string;
	readonly recipient: string;
	readonly amount: bigint;
	readonly gasBudget?: bigint;
}

export interface MintResult {
	/** Tx digest of the producing mint. Surfaces the cached digest on
	 *  verify-hit (the substrate hands back the decoded `CachedMint`
	 *  payload, which carries it). */
	readonly digest: string;
	readonly mintedCoinId: string;
	readonly recipient: string;
	readonly amount: bigint;
	readonly fullCoinType: string;
}

/** Sui SDK shim for the verify probe + transaction build.
 *
 *  The `core.getObject` field is the verify-probe surface; the
 *  `client` field is the build-target the produce body hands to
 *  `Transaction.build({ client })`. */
export interface MintSdkShim {
	readonly core: {
		readonly getObject: (args: { readonly objectId: string }) => Promise<unknown>;
	};
	/** Client reference for `Transaction.build({ client })`. The Sui
	 *  barrel hands in the resolved `SuiGrpcClient`. */
	readonly client: ClientWithCoreApi;
}

/** Verify probe — checks the cached minted-coin still exists. Lenient:
 *  returns `null` for both not-found AND transient failure (distilled-
 *  doc invariant: the next cycle re-derives).
 *
 *  IMPORTANT (chain-probe schema constraint): the probe pipeline
 *  cannot inject services from the caller. We construct the schema
 *  literal at module scope (above) and call `decodeUnknownEffect` —
 *  which the substrate's `ChainProbe.get` does internally. This local
 *  verify mirrors the call-shape so the constraint is honored.
 *
 *  We model the verify here as an inline Effect because the cached
 *  minted-coin id is known only AFTER cache lookup — the substrate's
 *  `verify` Effect closes over the cached id. */
const buildVerifyProbe = (
	sdk: MintSdkShim,
	mintedCoinIdOpt: string | null,
): Effect.Effect<typeof MintedCoinVerifyShape.Type | null, never> =>
	Effect.gen(function* () {
		if (mintedCoinIdOpt === null) return null;
		const raw: unknown = yield* Effect.tryPromise({
			try: () => sdk.core.getObject({ objectId: mintedCoinIdOpt }),
			catch: () => 'transient' as const,
		}).pipe(
			// Lenient: not-found AND transient both coerce to null. The
			// artifact publisher's cache layer will then re-run produce.
			Effect.catch(() => Effect.succeed(null)),
		);
		if (raw === null || raw === undefined) return null;
		// Best-effort decode. A decode failure on the verify path is
		// treated as "object exists but shape changed unexpectedly" —
		// still null so the substrate re-mints rather than carry stale
		// data forward.
		return yield* decodeUnknown(MintedCoinVerifyShape, raw, {
			source: 'minted coin verify response',
			mkError: (issue) => issue,
		}).pipe(Effect.catch(() => Effect.succeed(null as typeof MintedCoinVerifyShape.Type | null)));
	});

/** Object-change shape narrowed for `pickCreatedCoin`. The gRPC
 *  client emits `objectType` as a fully-qualified Sui type string on
 *  `created` entries; we sniff for the `Coin<T>` substring (inner
 *  generic carries the full coin type, so the match is unambiguous —
 *  distilled-doc 13-coin.md Invariant 9). */
interface CreatedObjectChange {
	readonly type: 'created';
	readonly objectId: string;
	readonly objectType?: string;
}

/** Find the minted `Coin<T>` in a result's objectChanges. Returns the
 *  objectId of the first `created` entry whose `objectType` matches
 *  `0x2::coin::Coin<${fullCoinType}>` (or its address-normalized equivalent).
 *
 *  Returns `null` on no match — the caller maps that to a typed parse
 *  error.
 *
 *  The SDK can report the Sui framework address as compact `0x2` or
 *  fully padded `0x000...0002`, so this uses the shared type-string
 *  normalizer instead of substring matching. */
export const pickCreatedCoin = (
	changes: ReadonlyArray<unknown>,
	fullCoinType: string,
): string | null => {
	for (const change of changes) {
		if (!isCreatedObjectChange(change)) continue;
		if (
			typeof change.objectType === 'string' &&
			isSuiFrameworkObjectForCoin(change.objectType, 'Coin', fullCoinType)
		) {
			return change.objectId;
		}
	}
	return null;
};

const isCreatedObjectChange = (raw: unknown): raw is CreatedObjectChange => {
	if (raw === null || typeof raw !== 'object') return false;
	const r = raw as { type?: unknown; objectId?: unknown };
	return r.type === 'created' && typeof r.objectId === 'string';
};

/** Build the `ArtifactPublisher` spec for one mint round.
 *
 *  Substrate dispatches: cache lookup, verify-on-hit, produce-on-
 *  miss-or-verify-fail, register-on-every-cycle. We hand it the
 *  procedures; the substrate handles best-effort cache writes per
 *  Invariant 2.
 *
 *  The substrate's `publish` returns the `CachedMint` payload on every
 *  path (decoded cached payload on verify-hit, fresh produce on miss);
 *  we project it directly to `MintResult`. */
export const performMint = (
	publisher: ArtifactPublisher,
	chain: ChainId,
	signer: MintSigner,
	sdk: MintSdkShim,
	inputs: MintInputs,
): Effect.Effect<MintResult, CoinError | ArtifactPublishError, Scope.Scope> =>
	Effect.gen(function* () {
		const cacheHash = buildMintContentHash({
			treasuryCapId: inputs.treasuryCapId,
			recipient: inputs.recipient,
			amount: inputs.amount,
			signerAddress: signer.address,
		});

		const cached: CachedMint = yield* publisher.publish<
			CachedMint,
			typeof MintedCoinVerifyShape.Type
		>({
			namespace: 'coin-mint',
			chain,
			contentHash: cacheHash,
			verifySchema: MintedCoinVerifyShape,
			// Verify probe runs on cache hit. The artifact publisher threads the
			// cached payload through to its internal probe — our
			// closure here just hands back a "null = miss" signal
			// when the cached id has vanished on chain.
			//
			// The artifact publisher substrate now threads the decoded
			// `CachedMint` into `verify(cached)`; we pull
			// `mintedCoinId` off it and probe the chain. Lenient
			// mode masks transient + not-found → null → substrate
			// re-mints rather than carry a stale digest forward.
			verify: (cached) => buildVerifyProbe(sdk, cached.mintedCoinId),
			produce: Effect.gen(function* () {
				yield* Effect.annotateCurrentSpan({
					[CoinSpans.mint.recipient]: inputs.recipient,
					[CoinSpans.mint.fullCoinType]: inputs.fullCoinType,
					[CoinSpans.mint.amount]: inputs.amount.toString(),
				});

				const result = yield* signer.withTransactionSigner((lockedSigner) =>
					Effect.gen(function* () {
						// 1. Build the Move tx — distilled-doc 13-coin.md
						//    Invariant 9 pins the call shape:
						//    `0x2::coin::mint_and_transfer<T>(cap, amount, recipient)`.
						const tx = new Transaction();
						if (inputs.gasBudget !== undefined) {
							tx.setGasBudget(inputs.gasBudget);
						}
						tx.setSender(signer.address);
						tx.moveCall({
							target: '0x2::coin::mint_and_transfer',
							typeArguments: [inputs.fullCoinType],
							arguments: [
								tx.object(inputs.treasuryCapId),
								tx.pure.u64(inputs.amount),
								tx.pure.address(inputs.recipient),
							],
						});

						// 2. Serialize the tx to BCS bytes while the account lease
						//    is held. `Transaction.build` resolves gas + object-version
						//    placeholders via the client.
						const txBytes = yield* Effect.tryPromise({
							try: () =>
								tx.build({ client: sdk.client }),
							catch: (cause): ArtifactPublishError => ({
								_tag: 'ArtifactPublishError',
								reason: 'produce-failed',
								detail:
									`coin.mint(${inputs.fullCoinType}): Transaction.build failed — ` +
									`${cause instanceof Error ? cause.message : String(cause)}`,
							}),
						});

						// 3. Sign + execute via the Account-supplied signer. Map
						//    `AccountSignError` → `ArtifactPublishError`. The
						//    Account plugin's signer handles waitForTransaction internally.
						return yield* lockedSigner.signAndExecute(txBytes).pipe(
							Effect.mapError(
								(cause): ArtifactPublishError => ({
									_tag: 'ArtifactPublishError',
									reason: 'produce-failed',
									detail:
										`coin.mint(${inputs.fullCoinType}): signAndExecute failed — ` + cause.message,
								}),
							),
						);
					}),
				);

				// 4a. Dispatch on the SDK-shaped discriminated result. On-chain
				//     failures (FailedTransaction) are a return value, not an
				//     error — surface them as a produce-failed artifact error so
				//     the cache treats this as a re-run candidate.
				if (result.$kind === 'FailedTransaction') {
					const failed = result.FailedTransaction!;
					const errorTail =
						failed.executionError !== undefined
							? `: ${failed.executionError}`
							: ' (no validator error attached).';
					return yield* Effect.fail({
						_tag: 'ArtifactPublishError' as const,
						reason: 'produce-failed' as const,
						detail:
							`coin.mint(${inputs.fullCoinType}): transaction execution failed on-chain ` +
							`(digest=${failed.digest})${errorTail}`,
					} satisfies ArtifactPublishError);
				}
				const ok = result.Transaction!;

				// 4b. Find the minted `Coin<T>` in objectChanges via the
				//     inner-generic match (distilled-doc Invariant 9).
				//     `mint_and_transfer` emits a fresh `Coin<T>` owned by
				//     the recipient; look it up by the
				//     `0x2::coin::Coin<${fullCoinType}>` substring.
				const mintedCoinId = pickCreatedCoin(ok.objectChanges, inputs.fullCoinType);
				if (mintedCoinId === null) {
					return yield* Effect.fail({
						_tag: 'ArtifactPublishError' as const,
						reason: 'produce-failed' as const,
						detail:
							`coin.mint(${inputs.fullCoinType}): minted Coin<T> not found in ` +
							`objectChanges (digest=${ok.digest}). ` +
							mintParseError(inputs.fullCoinType, 'minted Coin<T> absent in objectChanges')
								.message,
					} satisfies ArtifactPublishError);
				}

				yield* Effect.annotateCurrentSpan({
					[CoinSpans.mint.digest]: ok.digest,
					[CoinSpans.mint.mintedCoinId]: mintedCoinId,
				});

				// 5. Return the cached payload. The artifact publisher caches it under
				//    the content hash; the next cycle's verify probe (on
				//    cache hit) will lenient-probe `mintedCoinId`.
				return {
					digest: ok.digest,
					mintedCoinId,
					recipient: inputs.recipient,
					amount: inputs.amount.toString(),
				} satisfies CachedMint;
			}),
			// Register on EVERY cycle (hit AND miss). Distilled-doc
			// Invariant 6. Coin mint has no global registry to feed —
			// the resolved-value carries everything; this is a no-op.
			register: () => Effect.void,
		});

		// Project the cached payload to MintResult. The substrate
		// hands back the decoded `CachedMint` on every path.
		return {
			digest: cached.digest,
			mintedCoinId: cached.mintedCoinId,
			recipient: cached.recipient,
			amount: BigInt(cached.amount),
			fullCoinType: inputs.fullCoinType,
		};
	}).pipe(
		Effect.withSpan('coin.mint', {
			attributes: {
				[CoinSpans.mint.recipient]: inputs.recipient,
				[CoinSpans.mint.fullCoinType]: inputs.fullCoinType,
				[CoinSpans.mint.amount]: inputs.amount.toString(),
			},
		}),
	);

/** Project an artifact publisher-wire error back to a CoinError when the consumer
 *  wants a coin-side tagged shape. The artifact publisher boundary is generic; this
 *  helper recovers the typed `mint-tx` / `mint-parse` phase the cause
 *  walker uses. */
export const mintTxError = (fullCoinType: string, message: string, cause?: unknown): CoinError =>
	coinError('mint-tx', {
		identifier: fullCoinType,
		message,
		...(cause !== undefined ? { cause } : {}),
	});

export const mintParseError = (fullCoinType: string, message: string): CoinError =>
	coinError('mint-parse', {
		identifier: fullCoinType,
		message,
	});
