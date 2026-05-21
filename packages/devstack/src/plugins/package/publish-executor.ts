// Concrete `PublishExecutor` — wires the Move build, publish-tx
// builder, and post-publish ready-probe over (a) the resolved
// `SuiClient` from `SuiTag` and (b) the publisher account's signer
// from a per-package `AccountTag`.
//
// Architecture: the executor is a small adapter — `mode-local.ts`
// owns the 5-phase produce body (scrub → build → publish-tx → wait-
// for-index → parse); this file just satisfies the `PublishExecutor`
// interface by:
//
//   1. Delegating `build` to `runMoveBuild` (the existing path-(a)/
//      path-(b)/path-(c) dispatcher in `build.ts`).
//   2. Constructing a `Transaction.publish({modules, dependencies})`
//      for `publishTx`, serialising via `tx.build({ client })`,
//      signing/executing inside the publisher account's transaction
//      critical section, and projecting the response to a
//      `PublishReceipt`.
//   3. Wrapping `sdk.core.waitForTransaction({ digest })` for
//      `waitForReady` — the SDK already retries / waits for index
//      visibility internally.
//
// Errors:
//   - Each method maps its concrete failure → a typed `PublishError`
//     whose `phase:` matches the produce-step taxonomy
//     (`build` / `publish-tx` / `parse`).
//   - Account sign failures roll into `publish-tx` with cause-chain
//     preserved; the cascade formatter unwraps them.

import { Effect, type Scope } from 'effect';

import { Transaction } from '@mysten/sui/transactions';

import type { AccountValue } from '../account/service.ts';
import type { ContainerRuntime, ImageRef } from '../../contracts/container-runtime.ts';
import type { ChainId } from '../../substrate/brand.ts';
import { runMoveBuild, type BuildOutput } from './build.ts';
import type { PublishObjectChange, PublishReceipt } from './publish-receipt.ts';
import { publishError, type PublishError } from './errors.ts';
import type { PublishExecutor } from './mode-local.ts';
import type { SuiSdkShim } from '../sui/chain-probe.ts';

// ---------------------------------------------------------------------------
// Per-acquire inputs threaded by the barrel
// ---------------------------------------------------------------------------

export interface PublishExecutorInputs {
	/** The resolved SDK shim from `SuiTag`. Carries `core.executeTransaction`,
	 *  `core.waitForTransaction`, plus the opaque `client` ref used by
	 *  `Transaction.build({ client })`. */
	readonly sdk: SuiSdkShim;
	/** Publisher account — provides `signAndExecute` (which internally
	 *  signs, submits via `executeTransaction`, and awaits finality via
	 *  `waitForTransaction`). The address surfaces as the publisher on
	 *  the receipt. */
	readonly account: AccountValue;
	/** Container runtime + image consumed by `runMoveBuild`'s path-(b)
	 *  (`docker run --rm`). Absent → path-(c) (host CLI). */
	readonly runtime?: ContainerRuntime | undefined;
	readonly buildImage?: ImageRef | undefined;
}

// ---------------------------------------------------------------------------
// Executor factory
// ---------------------------------------------------------------------------

/**
 * Construct a `PublishExecutor` from the barrel's resolved inputs.
 *
 * The factory exists so the barrel can compose the executor once per
 * acquire and hand the result to `acquireLocal`. Internally the three
 * methods are closures over the inputs; no per-call construction.
 */
export const makePublishExecutor = (inputs: PublishExecutorInputs): PublishExecutor => ({
	scrubsInsideContainer: inputs.runtime !== undefined && inputs.buildImage !== undefined,

	// Build step — delegate to the Move-build dispatcher in `build.ts`.
	build: ({
		sourcePath,
		packageName,
		chainId,
	}: {
		readonly sourcePath: string;
		readonly packageName: string;
		readonly chainId: ChainId;
	}): Effect.Effect<BuildOutput, PublishError, Scope.Scope> =>
		runMoveBuild({
			sourcePath,
			packageName,
			chainId,
			...(inputs.runtime !== undefined ? { runtime: inputs.runtime } : {}),
			...(inputs.buildImage !== undefined ? { buildImage: inputs.buildImage } : {}),
		}),

	// Publish step — build + sign + execute the publish tx.
	publishTx: ({
		modules,
		dependencies,
		sourcePath,
		packageName,
	}: {
		readonly modules: ReadonlyArray<Uint8Array>;
		readonly dependencies: ReadonlyArray<string>;
		readonly sourcePath: string;
		readonly packageName: string;
	}): Effect.Effect<PublishReceipt, PublishError, Scope.Scope> =>
		Effect.gen(function* () {
			// Build the publish transaction. `tx.publish` accepts
			// `modules: number[][] | string[]` — coerce Uint8Array → number[].
			// `dependencies` is the array of dependency package ids from the
			// build output.
			//
			// `tx.publish` RETURNS the `UpgradeCap` (a value of `package::
			// UpgradeCap` — `key + store`, NO `drop`). The Move VM refuses
			// transactions that leave such values unused
			// (`UnusedValueWithoutDrop`); we MUST transfer the cap to a
			// concrete owner. Convention (matches v3 + dev-wallet's
			// MintNFT demo): transfer to the publisher account so the
			// stack-owner retains upgrade authority.
			const tx = new Transaction();
			tx.setSender(inputs.account.address);
			const upgradeCapArg = tx.publish({
				modules: modules.map((m) => Array.from(m)),
				dependencies: [...dependencies],
			});
			tx.transferObjects([upgradeCapArg], inputs.account.address);

			const sdkClient = inputs.sdk.client as {
				readonly executeTransaction: (args: {
					readonly transaction: Uint8Array;
					readonly signatures: ReadonlyArray<string>;
					readonly include?: {
						readonly effects?: boolean;
						readonly objectTypes?: boolean;
					};
				}) => Promise<unknown>;
				readonly waitForTransaction: (args: {
					readonly digest: string;
					readonly include?: { readonly effects?: boolean };
					readonly timeout?: number;
				}) => Promise<unknown>;
			};

			const rawResult = yield* inputs.account.withTransactionSigner((lockedSigner) =>
				Effect.gen(function* () {
					// Serialise while the account lease is held. `Transaction.build({ client })`
					// resolves gas budget + object versions through the SDK, so this must
					// serialize with signing and execution for same-address publishers.
					const txBytes = yield* Effect.tryPromise({
						try: () =>
							tx.build({
								client: inputs.sdk.client as Parameters<typeof tx.build>[0] extends
									| { client?: infer C }
									| undefined
									? C
									: never,
							}),
						catch: (cause): PublishError =>
							publishError('publish-tx', {
								sourcePath,
								packageName,
								message:
									`Transaction.build failed for package '${packageName}': ` +
									(cause instanceof Error ? cause.message : String(cause)),
								cause,
							}),
					});

					const signed = yield* lockedSigner.signTransaction(txBytes).pipe(
						Effect.mapError(
							(cause): PublishError =>
								publishError('publish-tx', {
									sourcePath,
									packageName,
									message:
										`account.signTransaction failed for publisher '${inputs.account.name}' ` +
										`(address=${inputs.account.address}): ${
											cause instanceof Error ? cause.message : String(cause)
										}`,
									cause,
								}),
						),
					);

					const raw = yield* Effect.tryPromise({
						try: () =>
							sdkClient.executeTransaction({
								transaction: txBytes,
								signatures: [signed.signature],
								// Include flags drive readMask paths in the SDK's
								// `executeTransaction` (see grpc/core.mjs). Effects
								// gives us `changedObjects` (PackageWrite + Created
								// upgrade cap); objectTypes maps changed ids →
								// fully-qualified type strings so the UpgradeCap is
								// identifiable unambiguously.
								include: { effects: true, objectTypes: true },
							}),
						catch: (cause): PublishError =>
							publishError('publish-tx', {
								sourcePath,
								packageName,
								message:
									`executeTransaction failed for publisher '${inputs.account.name}': ` +
									(cause instanceof Error ? cause.message : String(cause)),
								cause,
							}),
					});

					const envelope = raw as {
						readonly Transaction?: { readonly digest?: string };
						readonly FailedTransaction?: { readonly digest?: string };
					};
					const digest = envelope.Transaction?.digest ?? envelope.FailedTransaction?.digest;
					if (digest !== undefined) {
						yield* Effect.tryPromise({
							try: () =>
								sdkClient.waitForTransaction({
									digest,
								}),
							catch: (cause): PublishError =>
								publishError('publish-tx', {
									sourcePath,
									packageName,
									message: `waitForTransaction(${digest}) failed`,
									cause,
								}),
						});
					}
					return raw;
				}),
			);

			// Project the SDK's `TransactionResult` envelope to the
			// receipt shape. On `$kind: FailedTransaction` we raise a
			// publish-tx error; on the success branch we walk
			// `effects.changedObjects` for the published package id and
			// the upgrade cap.
			//
			// changedObjects entries are flat: `{objectId, inputState,
			// outputState, idOperation, ...}` — `outputState` is a
			// string literal (`'PackageWrite'` | `'ObjectWrite'` |
			// `'DoesNotExist'`), `idOperation` is a string literal
			// (`'Created'` | `'Deleted'` | `'None'`).
			const env = rawResult as {
				readonly $kind?: 'Transaction' | 'FailedTransaction';
				readonly Transaction?: {
					readonly digest?: string;
					readonly status?: { readonly success?: boolean; readonly error?: string };
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
			};
			if (env.$kind === 'FailedTransaction') {
				return yield* Effect.fail(
					publishError('publish-tx', {
						sourcePath,
						packageName,
						message:
							`executeTransaction returned FailedTransaction (digest=${env.FailedTransaction?.digest ?? '<unknown>'}): ` +
							(env.FailedTransaction?.status?.error ?? '<no error>'),
					}),
				);
			}
			const txOk = env.Transaction;
			if (txOk?.digest === undefined) {
				return yield* Effect.fail(
					publishError('publish-tx', {
						sourcePath,
						packageName,
						message: `executeTransaction returned no digest. Raw=${JSON.stringify(rawResult).slice(0, 300)}`,
					}),
				);
			}

			const objectChanges: Array<PublishObjectChange> = [];
			const objectTypes = txOk.objectTypes ?? {};
			for (const ch of txOk.effects?.changedObjects ?? []) {
				if (!ch.objectId) continue;
				const objectType = objectTypes[ch.objectId];
				if (ch.outputState === 'PackageWrite') {
					objectChanges.push({
						type: 'published',
						objectId: ch.objectId,
						...(objectType !== undefined ? { objectType } : {}),
					});
				} else if (ch.idOperation === 'Created') {
					objectChanges.push({
						type: 'created',
						objectId: ch.objectId,
						...(objectType !== undefined ? { objectType } : {}),
					});
				}
			}

			const published = objectChanges.find((c) => c.type === 'published');
			const upgradeCap = objectChanges.find(
				(c) => c.type === 'created' && (c.objectType?.endsWith('::package::UpgradeCap') ?? false),
			);

			const receipt: PublishReceipt = {
				digest: txOk.digest,
				packageId: published?.objectId ?? '',
				publisher: inputs.account.address,
				...(upgradeCap?.objectId !== undefined ? { upgradeCapId: upgradeCap.objectId } : {}),
				objectChanges,
			};

			return receipt;
		}).pipe(
			Effect.withSpan('package.publish-tx', {
				attributes: { 'package.publish.packageName': packageName },
			}),
		),

	// Wait-for-index step — post-publish ready-probe. The SDK's
	// `waitForTransaction` already polls fullnode index visibility
	// internally; we wrap it once with a typed PublishError on failure.
	waitForReady: (packageId: string): Effect.Effect<void, PublishError, Scope.Scope> =>
		Effect.tryPromise({
			try: async () => {
				// The publish account's `signAndExecute` already calls
				// `waitForTransaction(digest)` before returning; the read
				// on `packageId` here is a second-layer probe to catch the
				// "tx written but object not yet queryable" race the
				// chain-probe verify step also guards against. Falls
				// through silently — if the follow-up `getObject` succeeds
				// the index is ready, else the next verify cycle picks it
				// up.
				try {
					await inputs.sdk.core.getObject({ objectId: packageId });
				} catch {
					// A stale object read here is non-fatal — the next
					// produce phase (parse) only inspects the receipt.
				}
			},
			catch: (cause): PublishError =>
				publishError('parse', {
					sourcePath: '<wait-for-ready>',
					packageName: packageId,
					message: `waitForReady(${packageId}) failed`,
					cause,
				}),
		}).pipe(
			Effect.withSpan('package.wait-for-ready', {
				attributes: { 'package.publish.packageId': packageId },
			}),
		),
});
