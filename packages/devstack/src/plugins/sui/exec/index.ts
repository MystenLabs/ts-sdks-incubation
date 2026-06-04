// sui-execute — the Sui-SDK transaction roundtrip.
//
// Lives in `plugins/sui`; wraps `@mysten/sui` tx signing + execution.
// Drives the "build → sign → execute → wait → project" roundtrip that
// is otherwise duplicated verbatim across `plugins/package/publish-
// executor.ts` and `plugins/action/execute.ts` — ~80% identical
// line-for-line — and is also needed for `seal` (deploy + key-server
// registration), `coin.mint`, `action`, and `deepbook` (publish + pool
// creation).
//
// Lifting the dispatch here gives every Sui-tx plugin one well-tested
// surface and surfaces the SDK-envelope shape decisions (`include:
// { effects, objectTypes }`, `$kind` projection, `FailedTransaction`
// detection) ONCE.
//
// Boundary discipline:
//
//   - Consumes the published `ClientWithCoreApi` surface from
//     `@mysten/sui/client` plus an opaque resolved-signer closure. The
//     caller passes in the resolved SDK ref and the signer; this helper
//     just orchestrates the roundtrip.
//   - The return shape (`ExecutedReceipt`) is domain-neutral: a flat
//     digest + a uniform `objectChanges` array. Callers map to their
//     domain shape (PublishReceipt, ActionReceipt, MintReceipt, …).
//   - Transport / protocol failures (serialize, sign, execute, no-digest,
//     wait-for-finality) route through `SuiExecuteError` whose `phase`
//     discriminates the failing step. Callers map to their plugin's
//     phase taxonomy in their produce body's `mapError` closure.
//   - On-chain `FailedTransaction` is a RETURN-CHANNEL variant of
//     `SuiExecuteResult`, NOT an error — mirrors `account.signAndExecute`
//     and STYLE_GUIDE §2's return-channel discriminated-union rule.
//     Callers dispatch on `$kind` after the call.

import { Effect, Schema, Scope } from 'effect';
import type { ClientWithCoreApi } from '@mysten/sui/client';

import { formatUnknownError } from '../../../substrate/runtime/format-unknown-error.ts';

// ---------------------------------------------------------------------------
// Errors — substrate-style Schema.TaggedErrorClass
// ---------------------------------------------------------------------------

/** Tagged failure during one step of the Sui-tx roundtrip. `phase`
 *  discriminates which step failed so callers can map to their
 *  plugin's phase taxonomy (publish-tx, sign, parse, …) without
 *  losing the original cause.
 *
 *  On-chain `FailedTransaction` is NOT a phase here — it surfaces as
 *  the `$kind: 'FailedTransaction'` variant of `SuiExecuteResult`
 *  (return channel). Only transport / protocol failures live in this
 *  taxonomy. See STYLE_GUIDE §2. */
export class SuiExecuteError extends Schema.TaggedErrorClass<SuiExecuteError>()('SuiExecuteError', {
	phase: Schema.Literals(['serialize', 'sign', 'execute', 'no-digest', 'wait-for-finality']),
	signerName: Schema.String,
	signerAddress: Schema.String,
	message: Schema.String,
	/** Echoed digest when the SDK returned one but a later step
	 *  failed — surfaces in cause-walker output. */
	digest: Schema.optional(Schema.String),
	cause: Schema.optional(Schema.Defect),
}) {}

// ---------------------------------------------------------------------------
// Inputs / outputs
// ---------------------------------------------------------------------------

/** The SDK client this helper drives. Accepts any `ClientWithCoreApi`
 *  (the published cross-transport surface from `@mysten/sui/client`).
 *  `executeSuiTx` calls `client.core.executeTransaction` /
 *  `client.core.waitForTransaction` per STYLE_GUIDE §16. File-local: the
 *  `executeSuiTx` params type is the public surface; callers pass a
 *  `ClientWithCoreApi` directly. */
type SuiExecuteClient = ClientWithCoreApi;

/** Serialised transaction-build callback. Returns the BCS bytes ready
 *  for signing. The caller owns the `Transaction` construction (this
 *  helper does not import `@mysten/sui/transactions`) and resolves it
 *  via `Transaction.build({ client })`. */
type SerializedTxBuilder = () => Promise<Uint8Array>;

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
interface ExecutedObjectChange {
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

/** On-chain failure projection. The transaction was delivered +
 *  executed by the validator but the on-chain execution failed.
 *  Carries the digest (for log correlation) plus the validator's
 *  stringified error when one was attached. `executionError` is
 *  omitted when the SDK returns no message (STYLE_GUIDE §5: no
 *  sentinel placeholders at resolved-value surfaces). An envelope
 *  without a digest fails at projection with
 *  `SuiExecuteError(phase: 'no-digest')`.
 *
 *  This is the single source of truth for the on-chain-failure shape
 *  across the devstack: `account.SignAndExecuteResult`'s
 *  `FailedTransaction` variant carries it directly; every plugin that
 *  renders one of these failures into a user-facing error message goes
 *  through `formatExecutedFailure` (below). */
export interface ExecutedFailure {
	readonly digest: string;
	readonly executionError?: string;
}

/** Render the canonical "digest + executionError-or-noted-absent" tail
 *  used by every plugin's `FailedTransaction` surface. Pure projection;
 *  does not throw.
 *
 *  Used at the call site as e.g.
 *  `\`seal publish ... ${formatExecutedFailure(result.FailedTransaction)}\``.
 *  Centralising the wording means future tweaks propagate uniformly
 *  across the seal / coin / walrus / deepbook / action / package
 *  surfaces. */
export const formatExecutedFailure = (failure: ExecutedFailure): string =>
	failure.executionError !== undefined
		? `at ${failure.digest}: ${failure.executionError}`
		: `at ${failure.digest} (no validator error attached)`;

/** Outcome of `executeSuiTx`. Mirrors the SDK's discriminated
 *  `SuiClientTypes.TransactionResult` shape — on-chain failures are a
 *  RETURN VALUE (callers dispatch on `$kind`), NOT an error. Only
 *  transport / protocol failures (sign refused, RPC unreachable,
 *  finality wait broke, no digest) surface through `SuiExecuteError`.
 *  See STYLE_GUIDE §2 for the return-channel discipline this matches. */
type SuiExecuteResult =
	| { readonly $kind: 'Transaction'; readonly Transaction: ExecutedReceipt }
	| { readonly $kind: 'FailedTransaction'; readonly FailedTransaction: ExecutedFailure };

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

/** Pull the digest out of a raw `executeTransaction` envelope without
 *  committing to success vs on-chain failure. `FailedTransaction`
 *  carries its digest under a sibling key, so callers that only need
 *  the digest (impersonate / one-shot dispatch paths that don't run
 *  the full `executeSuiTx` projection) read it through this projector
 *  rather than re-deriving the `$kind`-branching shape inline.
 *  Returns `undefined` for a malformed envelope; callers decide
 *  whether a missing digest is a failure. */
export const extractExecuteDigest = (raw: unknown): string | undefined => {
	const env = raw as RawExecuteEnvelope;
	return env.$kind === 'FailedTransaction'
		? env.FailedTransaction?.digest
		: env.Transaction?.digest;
};

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
 *  Returns a `SuiExecuteResult` discriminated union — callers dispatch
 *  on `$kind` to distinguish on-chain success (`'Transaction'`) from
 *  on-chain rejection (`'FailedTransaction'`). Transport / protocol
 *  failures (serialize, sign, execute, no-digest, wait-for-finality)
 *  surface as `SuiExecuteError` with a `phase` discriminator the
 *  caller maps to its plugin's phase taxonomy.
 */
export const executeSuiTx = (params: {
	readonly client: SuiExecuteClient;
	readonly signer: ResolvedSigner;
	readonly build: SerializedTxBuilder;
	readonly awaitFinality?: boolean;
}): Effect.Effect<SuiExecuteResult, SuiExecuteError, Scope.Scope> =>
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
								formatUnknownError(cause),
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
								formatUnknownError(cause),
							cause,
						}),
				});

				// 4. Project the envelope. `$kind === 'FailedTransaction'`
				//    surfaces as a return-channel variant — on-chain
				//    rejection is a normal outcome, NOT a transport failure
				//    (STYLE_GUIDE §2). Callers dispatch on `$kind` and map
				//    to their plugin's on-chain-failure shape.
				const env = raw as RawExecuteEnvelope;
				if (env.$kind === 'FailedTransaction') {
					const failedDigest = env.FailedTransaction?.digest;
					if (failedDigest === undefined) {
						return yield* Effect.fail(
							new SuiExecuteError({
								phase: 'no-digest',
								signerName: signer.name,
								signerAddress: signer.address,
								message:
									`executeTransaction returned FailedTransaction with no digest. ` +
									`Raw=${JSON.stringify(raw).slice(0, 300)}`,
							}),
						);
					}
					if (awaitFinality) {
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
					const executionError = env.FailedTransaction?.status?.error;
					return {
						$kind: 'FailedTransaction',
						FailedTransaction: {
							digest: failedDigest,
							...(executionError !== undefined ? { executionError } : {}),
						},
					} satisfies SuiExecuteResult;
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

				return {
					$kind: 'Transaction',
					Transaction: { digest: txOk.digest, objectChanges },
				} satisfies SuiExecuteResult;
			}),
		)
		.pipe(
			Effect.withSpan('devstack.plugin.sui.execute', {
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
	return (
		message.includes('needs to be rebuilt because object') && message.includes('current version')
	);
};

