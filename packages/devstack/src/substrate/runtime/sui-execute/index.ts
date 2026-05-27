// sui-execute — substrate helper for the Sui-SDK transaction
// roundtrip.
//
// ARCHITECTURE NOTE — substrate-name-awareness escape hatch:
//
// This module is the ONE blessed substrate-side Sui-aware module.
// The substrate is otherwise strictly name-blind (see ARCHITECTURE.md
// §"Substrate name-blindness"), but the "build → sign → execute →
// wait → project" roundtrip is duplicated verbatim across
// `plugins/package/publish-executor.ts` and `plugins/action/execute.ts`
// — ~80% identical line-for-line — and the same shape is needed for
// `seal` (deploy + key-server registration), `coin.mint`, `action`,
// and `deepbook` (publish + pool creation).
//
// Lifting the dispatch here gives every Sui-tx plugin one well-tested
// surface and surfaces the SDK-envelope shape decisions (`include:
// { effects, objectTypes }`, `$kind` projection, `FailedTransaction`
// detection) ONCE.
//
// Boundary discipline:
//
//   - This module is L1-adjacent: it lives under `substrate/runtime/`
//     but consumes opaque shapes (`unknown` SDK client; opaque
//     signer closure). It does NOT import from `plugins/sui/*` or
//     `@mysten/sui/*` — the caller passes in the resolved SDK ref
//     and the signer; the substrate just orchestrates the roundtrip.
//   - The return shape (`ExecutedReceipt`) is name-blind: a flat
//     digest + a uniform `objectChanges` array. Callers map to their
//     domain shape (PublishReceipt, ActionReceipt, MintReceipt, …).
//   - Failures route through `SuiExecuteError` whose `phase`
//     discriminates the failing step. Callers map to their plugin's
//     phase taxonomy in their produce body's `mapError` closure.

import { Effect, Schema, Scope } from 'effect';
import type { ClientWithCoreApi } from '@mysten/sui/client';

// ---------------------------------------------------------------------------
// Errors — substrate-style Schema.TaggedErrorClass
// ---------------------------------------------------------------------------

/** Tagged failure during one step of the Sui-tx roundtrip. `phase`
 *  discriminates which step failed so callers can map to their
 *  plugin's phase taxonomy (publish-tx, sign, parse, …) without
 *  losing the original cause. */
export class SuiExecuteError extends Schema.TaggedErrorClass<SuiExecuteError>()('SuiExecuteError', {
	phase: Schema.Literals([
		'serialize',
		'sign',
		'execute',
		'failed-transaction',
		'no-digest',
		'wait-for-finality',
	]),
	signerName: Schema.String,
	signerAddress: Schema.String,
	message: Schema.String,
	/** Echoed digest when the SDK returned one but a later step
	 *  failed — surfaces in cause-walker output. */
	digest: Schema.optional(Schema.String),
	cause: Schema.optional(Schema.Defect),
}) {}

// ---------------------------------------------------------------------------
// Inputs / outputs — opaque at the substrate boundary
// ---------------------------------------------------------------------------

/** The SDK client this helper drives. Accepts any `ClientWithCoreApi`
 *  (the published cross-transport surface from `@mysten/sui/client`).
 *  `executeSuiTx` calls `client.core.executeTransaction` /
 *  `client.core.waitForTransaction` per STYLE_GUIDE §16. */
export type SuiExecuteClient = ClientWithCoreApi;

/** Serialised transaction-build callback. Returns the BCS bytes ready
 *  for signing. The caller owns the `Transaction` construction — the
 *  substrate does not import `@mysten/sui/transactions` — and resolves
 *  it via `Transaction.build({ client })`. */
export type SerializedTxBuilder = () => Promise<Uint8Array>;

export interface TransactionSignerScope<SignError = unknown> {
	readonly signTransaction: (
		tx: Uint8Array,
	) => Effect.Effect<{ readonly bytes: string; readonly signature: string }, SignError>;
}

/** Resolved signer — narrow slice of `AccountValue`. */
export interface ResolvedSigner {
	readonly name: string;
	readonly address: string;
	readonly signTransaction: (
		tx: Uint8Array,
	) => Effect.Effect<{ readonly bytes: string; readonly signature: string }, unknown>;
	readonly withTransactionSigner: <A, E, R>(
		body: (signer: TransactionSignerScope) => Effect.Effect<A, E, R>,
	) => Effect.Effect<A, E, R>;
}

/** Flat per-object change record. Mirrors the union of fields that
 *  `PublishObjectChange` (package) and `ActionObjectChange` (action)
 *  expose so callers can pick whichever subset they surface. */
export interface ExecutedObjectChange {
	readonly objectId: string;
	readonly objectType?: string;
	readonly outputState?: string;
	readonly idOperation?: string;
}

/** Result of one successful execute round. Callers map this to their
 *  domain shape (PublishReceipt, ActionReceipt, MintReceipt, …). */
export interface ExecutedReceipt {
	readonly digest: string;
	readonly objectChanges: ReadonlyArray<ExecutedObjectChange>;
}

// ---------------------------------------------------------------------------
// SDK envelope projection (matches publish-executor + action.execute)
// ---------------------------------------------------------------------------

interface RawExecuteEnvelope {
	readonly $kind?: 'Transaction' | 'FailedTransaction';
	readonly Transaction?: {
		readonly digest?: string;
		readonly effects?: {
			readonly changedObjects?: ReadonlyArray<{
				readonly objectId?: string;
				readonly outputState?: string;
				readonly idOperation?: string;
			}>;
		};
		readonly objectTypes?: Readonly<Record<string, string>>;
	};
	readonly FailedTransaction?: {
		readonly digest?: string;
		readonly status?: { readonly error?: string };
	};
}

// ---------------------------------------------------------------------------
// The helper
// ---------------------------------------------------------------------------

/** Drive the serialize → sign → execute → wait → project pipeline.
 *
 *  The caller passes:
 *   - `client`: an opaque SDK client exposing `executeTransaction` +
 *     `waitForTransaction` (matches the cast in both existing
 *     duplicates).
 *   - `signer`: a `ResolvedSigner` slice with an account-owned
 *     transaction scope. The build/sign/execute/wait pipeline runs
 *     inside that scope so gas/object-version resolution cannot race
 *     another transaction from the same address.
 *   - `build`: a closure returning the serialised tx bytes (the
 *     caller constructed the `Transaction` and resolved gas via
 *     `tx.build({ client })`).
 *   - `awaitFinality`: opt-out for the `waitForTransaction` step.
 *     Defaults to `true`. Some callers (action ready-probe) need it;
 *     others (mode-local publish ready probe path) wait separately
 *     via `getObject` polling and can pass `false`.
 *
 *  All failures surface as `SuiExecuteError` with a `phase`
 *  discriminator the caller maps to its plugin's phase taxonomy.
 */
export const executeSuiTx = (params: {
	readonly client: SuiExecuteClient;
	readonly signer: ResolvedSigner;
	readonly build: SerializedTxBuilder;
	readonly awaitFinality?: boolean;
}): Effect.Effect<ExecutedReceipt, SuiExecuteError, Scope.Scope> =>
	params.signer
		.withTransactionSigner((lockedSigner) =>
			Effect.gen(function* () {
				const { client, signer, build } = params;
				const awaitFinality = params.awaitFinality ?? true;

				// 1. Serialise the transaction. Failures inside the build
				//    closure (e.g. `Transaction.build({ client })` rejection)
				//    surface as `phase: 'serialize'` so callers can attribute
				//    them at the call site.
				const txBytes = yield* Effect.tryPromise({
					try: () => build(),
					catch: (cause) =>
						new SuiExecuteError({
							phase: 'serialize',
							signerName: signer.name,
							signerAddress: signer.address,
							message:
								`Transaction.build failed for signer '${signer.name}' ` +
								`(address=${signer.address}): ` +
								(cause instanceof Error ? cause.message : String(cause)),
							cause,
						}),
				});

				// 2. Sign with the resolved signer. The signer's own typed
				//    error surfaces in `cause`; we collapse to `phase: 'sign'`
				//    so the cascade-formatter can walk the cause chain.
				const signed = yield* lockedSigner.signTransaction(txBytes).pipe(
					Effect.mapError(
						(cause) =>
							new SuiExecuteError({
								phase: 'sign',
								signerName: signer.name,
								signerAddress: signer.address,
								message:
									`signer.signTransaction failed for '${signer.name}' ` +
									`(address=${signer.address}).`,
								cause,
							}),
					),
				);

				// 3. Execute via the SDK. We always request `effects: true` and
				//    `objectTypes: true` because every existing caller needs
				//    `changedObjects` + types to project to its domain shape.
				const raw = yield* Effect.tryPromise({
					try: () =>
						client.core.executeTransaction({
							transaction: txBytes,
							signatures: [signed.signature],
							include: { effects: true, objectTypes: true },
						}),
					catch: (cause) =>
						new SuiExecuteError({
							phase: 'execute',
							signerName: signer.name,
							signerAddress: signer.address,
							message:
								`executeTransaction rejected for signer '${signer.name}': ` +
								(cause instanceof Error ? cause.message : String(cause)),
							cause,
						}),
				});

				// 4. Project the envelope. `$kind === 'FailedTransaction'`
				//    surfaces as a discrete phase so callers can distinguish
				//    transport failures from on-chain rejection.
				const env = raw as RawExecuteEnvelope;
				if (env.$kind === 'FailedTransaction') {
					const failedDigest = env.FailedTransaction?.digest;
					if (awaitFinality && failedDigest !== undefined) {
						yield* Effect.tryPromise({
							try: () => client.core.waitForTransaction({ digest: failedDigest }),
							catch: (cause) =>
								new SuiExecuteError({
									phase: 'wait-for-finality',
									signerName: signer.name,
									signerAddress: signer.address,
									digest: failedDigest,
									message: `waitForTransaction(${failedDigest}) failed.`,
									cause,
								}),
						});
					}
					return yield* Effect.fail(
						new SuiExecuteError({
							phase: 'failed-transaction',
							signerName: signer.name,
							signerAddress: signer.address,
							digest: env.FailedTransaction?.digest,
							message:
								`executeTransaction returned FailedTransaction ` +
								`(digest=${env.FailedTransaction?.digest ?? '<unknown>'}): ` +
								(env.FailedTransaction?.status?.error ?? '<no error>'),
						}),
					);
				}
				const txOk = env.Transaction;
				if (txOk?.digest === undefined) {
					return yield* Effect.fail(
						new SuiExecuteError({
							phase: 'no-digest',
							signerName: signer.name,
							signerAddress: signer.address,
							message: `executeTransaction returned no digest. Raw=${JSON.stringify(raw).slice(0, 300)}`,
						}),
					);
				}

				// 5. Wait for finality (opt-out — some callers wait separately).
				if (awaitFinality) {
					yield* Effect.tryPromise({
						try: () => client.core.waitForTransaction({ digest: txOk.digest! }),
						catch: (cause) =>
							new SuiExecuteError({
								phase: 'wait-for-finality',
								signerName: signer.name,
								signerAddress: signer.address,
								digest: txOk.digest,
								message: `waitForTransaction(${txOk.digest}) failed.`,
								cause,
							}),
					});
				}

				// 6. Project changedObjects flat. Callers pick which entries
				//    they care about (published / created / mutated / by-type
				//    substring).
				const objectTypes = txOk.objectTypes ?? {};
				const objectChanges: Array<ExecutedObjectChange> = [];
				for (const ch of txOk.effects?.changedObjects ?? []) {
					if (typeof ch.objectId !== 'string') continue;
					const objectType = objectTypes[ch.objectId];
					const entry: { -readonly [K in keyof ExecutedObjectChange]: ExecutedObjectChange[K] } = {
						objectId: ch.objectId,
					};
					if (objectType !== undefined) entry.objectType = objectType;
					if (ch.outputState !== undefined) entry.outputState = ch.outputState;
					if (ch.idOperation !== undefined) entry.idOperation = ch.idOperation;
					objectChanges.push(entry);
				}

				return { digest: txOk.digest, objectChanges };
			}),
		)
		.pipe(
			Effect.withSpan('substrate.sui-execute', {
				attributes: {
					'sui-execute.signer': params.signer.name,
					'sui-execute.address': params.signer.address,
				},
			}),
		);

/** Decode a possibly URI-encoded SDK error message. The Sui SDK
 *  emits `decodeURIComponent`-able strings for some error paths
 *  (notably stale-object-version reports). Falls back to the raw
 *  message on decode failure. */
const decodeMessage = (message: string): string => {
	try {
		return decodeURIComponent(message);
	} catch {
		return message;
	}
};

/** Typed predicate for the SDK's "stale object version" transient
 *  failure — the Move VM refuses a transaction that references an
 *  object reference older than the current chain version. Consumers
 *  retry with fresh refs; pair with `STALE_OBJECT_VERSION_RETRY_PROFILE`
 *  from `retry-policy.ts`. Detection sniffs the SDK message because the
 *  underlying gRPC error class doesn't expose a structured discriminator
 *  for this case. */
export const isSuiStaleObjectVersionError = (err: SuiExecuteError): boolean => {
	const message = decodeMessage(err.message);
	return message.includes('needs to be rebuilt because object') && message.includes('current version');
};
