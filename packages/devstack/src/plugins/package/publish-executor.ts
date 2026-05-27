// Concrete `PublishExecutor` — wires the Move build, publish-tx
// builder, and post-publish ready-probe over (a) the resolved
// `SuiClient` from the Sui dependency and (b) the publisher account's signer
// from the account dependency.
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
//      `LocalPackagePublishOutput`.
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

import type { AccountValue, TxResult } from '../account/index.ts';
import type { ContainerRuntime, ImageRef } from '../../contracts/container-runtime.ts';
import type { ChainId } from '../../substrate/brand.ts';
import { buildForkImpersonationTransactionBytes } from '../sui/index.ts';
import { runMoveBuild, type BuildOutput } from './build.ts';
import type { LocalPackagePublishOutput, PackagePublishObjectChange } from './publish-output.ts';
import { publishError, type PublishError } from './errors.ts';
import type { PublishExecutor } from './mode-local.ts';
import { PackageSpans } from './spans.ts';
import type { SuiSdkShim } from '../sui/index.ts';

const shouldHydrateCreatedObject = (change: PackagePublishObjectChange): boolean =>
	change.type === 'created' &&
	change.objectId !== undefined &&
	change.objectType !== undefined &&
	(change.objectType.includes('::coin::TreasuryCap<') ||
		change.objectType.includes('::coin::CoinMetadata<') ||
		change.objectType.includes('::coin_registry::Currency<'));

const projectObjectPayload = (raw: unknown): unknown => {
	if (raw !== null && typeof raw === 'object' && 'object' in raw) {
		return (raw as { readonly object?: unknown }).object;
	}
	return raw;
};

const projectHydratedObjectFields = (
	raw: unknown,
): Pick<PackagePublishObjectChange, 'owner' | 'json'> => {
	const object = projectObjectPayload(raw);
	if (object === null || typeof object !== 'object') return {};
	const payload = object as { readonly owner?: unknown; readonly json?: unknown };
	return {
		...(payload.owner === undefined ? {} : { owner: payload.owner }),
		...(payload.json === undefined ? {} : { json: payload.json }),
	};
};

const hydrateCreatedObject = (
	sdk: SuiSdkShim,
	change: PackagePublishObjectChange,
): Effect.Effect<PackagePublishObjectChange> => {
	if (!shouldHydrateCreatedObject(change) || change.objectId === undefined) {
		return Effect.succeed(change);
	}
	return Effect.tryPromise({
		try: () =>
			sdk.core.getObject({
				objectId: change.objectId!,
				include: { json: true },
			}),
		catch: () => null,
	}).pipe(
		Effect.map((raw) => ({
			...change,
			...(raw === null ? {} : projectHydratedObjectFields(raw)),
		})),
		Effect.catch(() => Effect.succeed(change)),
	);
};

const hydrateCreatedObjects = (
	sdk: SuiSdkShim,
	changes: ReadonlyArray<PackagePublishObjectChange>,
): Effect.Effect<ReadonlyArray<PackagePublishObjectChange>> =>
	Effect.forEach(changes, (change) => hydrateCreatedObject(sdk, change), {
		concurrency: 'unbounded',
	});

/** Project an account TxResult's flat `objectChanges` (`{type,
 *  objectId, objectType?, ...}`) into the publish-output
 *  `PackagePublishObjectChange[]` shape. The account plugin's
 *  projection already classifies entries by `type`
 *  (`published` for `outputState: 'PackageWrite'`, `created` for
 *  `idOperation: 'Created'`, `mutated` otherwise); we just narrow
 *  to the entries we care about (published + created) and drop the
 *  extras. */
const publishChangesFromTxResult = (
	tx: TxResult,
): ReadonlyArray<PackagePublishObjectChange> => {
	const out: Array<PackagePublishObjectChange> = [];
	for (const change of tx.objectChanges) {
		if (typeof change !== 'object' || change === null) continue;
		const projected = change as {
			readonly type?: string;
			readonly objectId?: unknown;
			readonly objectType?: unknown;
		};
		if (typeof projected.objectId !== 'string') continue;
		if (projected.type !== 'published' && projected.type !== 'created') continue;
		const objectType =
			typeof projected.objectType === 'string' ? projected.objectType : undefined;
		out.push({
			type: projected.type,
			objectId: projected.objectId,
			...(objectType !== undefined ? { objectType } : {}),
		});
	}
	return out;
};

// ---------------------------------------------------------------------------
// Per-acquire inputs threaded by the barrel
// ---------------------------------------------------------------------------

export interface PublishExecutorInputs {
	/** The resolved SDK shim from the Sui dependency. Carries `core.executeTransaction`,
	 *  `core.waitForTransaction`, plus the opaque `client` ref used by
	 *  `Transaction.build({ client })`. */
	readonly sdk: SuiSdkShim;
	/** Publisher account — provides `signAndExecute` (which internally
	 *  signs, submits via `executeTransaction`, and awaits finality via
	 *  `waitForTransaction`). The address surfaces as the publisher on
	 *  the output. */
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
	}): Effect.Effect<LocalPackagePublishOutput, PublishError, Scope.Scope> =>
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

			const { digest, objectChanges } = yield* inputs.account.withTransactionSigner(
				(lockedSigner) =>
					Effect.gen(function* () {
						// Serialise while the account lease is held. Real signers use the SDK resolver;
						// fork impersonation must build offline with explicit gas fields because the
						// fork binary does not support the normal gas-selection simulation path.
						const txBytes =
							inputs.account.source === 'impersonate'
								? yield* buildForkImpersonationTransactionBytes(
										tx,
										inputs.account.address,
										inputs.sdk.core,
									).pipe(
										Effect.mapError(
											(cause): PublishError =>
												publishError('publish-tx', {
													sourcePath,
													packageName,
													message:
														`Fork impersonation Transaction.build failed for package '${packageName}': ` +
														cause.message,
													cause,
												}),
										),
									)
								: yield* Effect.tryPromise({
										try: () =>
											tx.build({ client: inputs.sdk.client }),
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

						// Both real-signer and impersonate paths route through the
						// account's `signAndExecute` (which signs, executes, waits,
						// and projects to the SDK-shaped `SignAndExecuteResult`
						// discriminated union). The impersonate path internally
						// hands off to `fork.impersonate`; the real-signer path
						// goes through the SDK directly. Either way, callers
						// dispatch on `$kind` here.
						const result = yield* lockedSigner.signAndExecute(txBytes).pipe(
							Effect.mapError(
								(cause): PublishError =>
									publishError('publish-tx', {
										sourcePath,
										packageName,
										message:
											`account.signAndExecute failed for publisher '${inputs.account.name}' ` +
											`(address=${inputs.account.address}): ${
												cause instanceof Error ? cause.message : String(cause)
											}`,
										cause,
									}),
							),
						);
						if (result.$kind === 'FailedTransaction') {
							const failed = result.FailedTransaction;
							const errorTail =
								failed.executionError !== undefined
									? `: ${failed.executionError}`
									: ' (no validator error attached).';
							return yield* Effect.fail(
								publishError('publish-tx', {
									sourcePath,
									packageName,
									message:
										`executeTransaction returned FailedTransaction ` +
										`(digest=${failed.digest})${errorTail}`,
								}),
							);
						}
						return {
							digest: result.Transaction.digest,
							objectChanges: publishChangesFromTxResult(result.Transaction),
						};
					}),
			);

			const published = objectChanges.find((c) => c.type === 'published');
			const upgradeCap = objectChanges.find(
				(c) => c.type === 'created' && (c.objectType?.endsWith('::package::UpgradeCap') ?? false),
			);
			const hydratedObjectChanges = yield* hydrateCreatedObjects(inputs.sdk, objectChanges);

			const output: LocalPackagePublishOutput = {
				digest,
				packageId: published?.objectId ?? '',
				publisher: inputs.account.address,
				...(upgradeCap?.objectId !== undefined ? { upgradeCapId: upgradeCap.objectId } : {}),
				objectChanges: hydratedObjectChanges,
			};

			return output;
		}).pipe(
			Effect.withSpan('package.publish-tx', {
				attributes: { [PackageSpans.publish.packageName]: packageName },
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
					// produce phase (parse) only inspects the output.
				}
			},
			catch: (cause): PublishError =>
				// `sourcePath` is intentionally omitted — this probe only
				// has the resolved on-chain `packageId` in scope. The
				// `mode-local` re-stamp pass back-fills from the outer
				// inputs when the error bubbles through.
				publishError('parse', {
					packageName: packageId,
					message: `waitForReady(${packageId}) failed`,
					cause,
				}),
		}).pipe(
			Effect.withSpan('package.wait-for-ready', {
				attributes: { [PackageSpans.publish.packageId]: packageId },
			}),
		),
});
