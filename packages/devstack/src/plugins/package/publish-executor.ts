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
//      `postPublishReadyHint` — the SDK already retries / waits for
//      index visibility internally. The probe is hint-only: transient
//      `getObject` misses (cold index race) are intentionally
//      swallowed because the publisher account's `signAndExecute` has
//      already awaited `waitForTransaction(digest)`.
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
import { formatUnknownError } from '../../substrate/runtime/format-unknown-error.ts';
import {
	buildForkImpersonationTransactionBytes,
	formatExecutedFailure,
	signAndDispatch,
	type SuiSdkShim,
} from '../sui/index.ts';
import { runMoveBuild, type BuildOutput } from './build.ts';
import type { LocalPackagePublishOutput, PackagePublishObjectChange } from './publish-output.ts';
import { publishError, type PublishError } from './errors.ts';
import type { PublishExecutor } from './mode-local.ts';
import { PackageSpans } from './spans.ts';

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
	const objectId = change.objectId;
	return Effect.tryPromise({
		try: () =>
			sdk.core.getObject({
				objectId,
				include: { json: true },
			}),
		catch: (cause) => cause,
	}).pipe(
		Effect.map((raw) => ({
			...change,
			...(raw === null ? {} : projectHydratedObjectFields(raw)),
		})),
		// Hydration is best-effort — a cold-cache `getObject` miss must
		// not fail the publish. Log at debug so the miss is visible (the
		// `tryPromise` catch wraps the original cause; cause-detail
		// extraction is non-trivial here, so we log the objectId — the
		// fact that this happened is the actionable signal).
		Effect.catch((cause) =>
			Effect.logDebug('package: hydrate-created-object cache miss').pipe(
				Effect.annotateLogs({ objectId, cause: String(cause) }),
				Effect.as(change),
			),
		),
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
const publishChangesFromTxResult = (tx: TxResult): ReadonlyArray<PackagePublishObjectChange> => {
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
		const objectType = typeof projected.objectType === 'string' ? projected.objectType : undefined;
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
	/** Fork mode — real signers (not just impersonate) must build offline
	 *  with explicit gas, because the sui-fork binary has no
	 *  `simulate_transaction` for the SDK's gas-estimating `tx.build`. */
	readonly forkMode?: boolean;
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

			// Both real-signer and impersonate paths route through the
			// account's `signAndExecute` (which signs, executes, waits,
			// and projects to the SDK-shaped `SignAndExecuteResult`
			// discriminated union). The impersonate path internally
			// hands off to `fork.impersonate`; the real-signer path
			// goes through the SDK directly. `signAndDispatch` compacts
			// the build → sign → execute → $kind dispatch boilerplate.
			const { digest, objectChanges } = yield* signAndDispatch({
				signerSource: inputs.account,
				buildTxBytes: () =>
					// Serialise while the account lease is held. Non-fork real
					// signers use the SDK resolver. Fork mode (impersonate OR real
					// signer) must build offline with explicit gas fields: the
					// sui-fork binary has no simulate_transaction, so the SDK's
					// gas-estimating build path fails. The real-vs-empty-signature
					// split happens later in the account's signAndExecute.
					inputs.account.source === 'impersonate' || inputs.forkMode === true
						? buildForkImpersonationTransactionBytes(
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
						: Effect.tryPromise({
								try: () => tx.build({ client: inputs.sdk.client }),
								catch: (cause): PublishError =>
									publishError('publish-tx', {
										sourcePath,
										packageName,
										message:
											`Transaction.build failed for package '${packageName}': ` +
											formatUnknownError(cause),
										cause,
									}),
							}),
				mapSignError: (cause): PublishError =>
					publishError('publish-tx', {
						sourcePath,
						packageName,
						message:
							`account.signAndExecute failed for publisher '${inputs.account.name}' ` +
							`(address=${inputs.account.address}): ${formatUnknownError(cause)}`,
						cause,
					}),
				onFailed: (failure) =>
					Effect.fail(
						publishError('publish-tx', {
							sourcePath,
							packageName,
							message:
								`executeTransaction returned FailedTransaction ` + formatExecutedFailure(failure),
						}),
					),
				onSuccess: (txResult: TxResult) =>
					Effect.succeed({
						digest: txResult.digest,
						objectChanges: publishChangesFromTxResult(txResult),
					}),
			});

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
			Effect.withSpan('devstack.plugin.package.publish-tx', {
				attributes: { [PackageSpans.publish.packageName]: packageName },
			}),
		),

	// Post-publish ready HINT — a best-effort second-layer probe. The publish
	// account's `signAndExecute` already calls `waitForTransaction(digest)`
	// before returning, so the read on `packageId` here only catches the
	// "tx written but object not yet queryable" race. It MUST NOT fail the
	// publish: a transient / not-yet-indexed read is expected. The failure is
	// logged at debug (§18) so the miss stays visible rather than silently
	// swallowed, then the hint succeeds regardless.
	postPublishReadyHint: (packageId: string): Effect.Effect<void, PublishError, Scope.Scope> =>
		Effect.tryPromise(() => inputs.sdk.core.getObject({ objectId: packageId })).pipe(
			Effect.asVoid,
			Effect.catch((cause) =>
				Effect.logDebug('package: post-publish ready-hint read failed').pipe(
					Effect.annotateLogs({ packageId, cause: String(cause) }),
				),
			),
			Effect.withSpan('devstack.plugin.package.post-publish-ready-hint', {
				attributes: { [PackageSpans.publish.packageId]: packageId },
			}),
		),
});
