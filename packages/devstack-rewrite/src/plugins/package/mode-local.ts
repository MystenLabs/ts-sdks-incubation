// Local mode — build from source + publish.
//
// This is the canonical implementation of the
// `OnChainArtifactPublisher` substrate primitive (distilled doc
// §Generic on-chain-artifact-publish pattern). The five-phase shape:
//
//   1. Inputs       — `{ sourceHash, signerAddress }` →
//                     `contentHash(inputs)`.
//   2. Cache key    — `<namespace=package>/<chainId>/<contentHash>`.
//                     Substrate folds in chainId for us; we hand
//                     it the namespace + contentHash.
//   3. Verify       — `chainProbe.get({ objectId: cachedId },
//                     PackageObjectSchema, 'lenient')`. Lenient mode
//                     coerces transient RPC failure → null
//                     → re-derive (cheap over-derive vs spurious
//                     eviction — distilled doc §Constraint "lenient
//                     verify is cheaper than aggressive eviction").
//   4. Produce      — scrub locks → build → publish-tx → wait-for-
//                     index. Each phase narrates to TUI via span
//                     annotation.
//   5. Register     — write registry entry on EVERY cycle (hit AND
//                     miss). Distilled doc Invariant 6.
//
// The publish receipt is exposed on the resolved value so the Coin
// plugin can consume it (see `publish-receipt.ts` for the placement
// rationale).

import { Effect, Schema, type Scope } from 'effect';

import { contentHash as brandContentHash, type ChainId } from '../../substrate/brand.ts';
import type {
	OnChainArtifactError,
	OnChainArtifactPublisher,
} from '../../primitives/on-chain-artifact.ts';
import type { ChainProbe } from '../../contracts/chain-probe.ts';
import type { SuiProbeKey } from '../sui/chain-probe.ts';
import { hashMoveSources, scrubLocksHost, type BuildOutput } from './build.ts';
import {
	pickPublishedChange,
	pickUpgradeCapChange,
	type PublishObjectChange,
	type PublishReceipt,
} from './publish-receipt.ts';
import { mvrSlugify } from './dep-resolution.ts';
import { type PackageRegistry, type ResolvedLocalPackage } from './registry.ts';
import { publishError, type PublishError } from './errors.ts';

/** Cache-stored payload — the stable id verify re-confirms on
 *  every cycle. Distilled doc Invariant 8: the probe MUST consume
 *  a stable identifier (the packageId), NOT a derived hash. */
export interface CachedPackageEntry {
	readonly packageId: string;
	readonly upgradeCapId?: string;
	readonly publisher: string;
	readonly mvrPlaceholder: string;
	readonly captured: Readonly<Record<string, string>>;
	readonly receipt?: PublishReceipt;
}

/** Verify-schema: what we expect when probing `getObject(packageId)`.
 *  Minimal — the substrate's `ChainProbe` decodes against this; any
 *  decode failure surfaces structured. */
export const PackageVerifyShape = Schema.Struct({
	objectId: Schema.String,
	// A Move package's `type` is the literal `"package"` wrapper;
	// the SDK's exact shape varies — we keep it open as `Unknown`
	// and rely on objectId presence for the "exists" signal.
	type: Schema.Unknown,
});

/**
 * Publish-tx executor — narrow shim that abstracts the concrete
 * `@mysten/sui` wiring (Transaction builder, signer, fullnode
 * ready-probe). The mode-local produce body composes its 5-phase
 * shape against this interface; the concrete implementation lives in
 * `publish-executor.ts` and is constructed once per acquire by the
 * barrel from the resolved `SuiClient` + publisher `AccountValue` +
 * `ContainerRuntime`.
 *
 * The shim parallels `coin/mint.ts::MintSigner` + `MintSdkShim`. We
 * keep them split (publish vs sign vs ready-probe) so the produce
 * body can attribute span annotations per phase + so failures map
 * back to a typed `PublishError` phase enum.
 */
export interface PublishExecutor {
	/** Build the Move source tree into `{ modules, dependencies }`.
	 *  Dispatches between (a) per-app build container, (b) fresh
	 *  `docker run --rm`, (c) host `sui` CLI. The produce body just
	 *  calls and propagates `PublishError`. */
	readonly build: (inputs: {
		readonly sourcePath: string;
		readonly packageName: string;
		readonly chainId: ChainId;
	}) => Effect.Effect<BuildOutput, PublishError, Scope.Scope>;

	/** Construct + sign + execute a `Transaction.publish({modules,
	 *  dependencies})` against the publisher account. Returns the
	 *  receipt projection that downstream consumers (Coin, manifest,
	 *  capture spec) need. Distilled doc §Move-specific concerns —
	 *  the receipt is the source of `published` change + the
	 *  `UpgradeCap` `created` change. */
	readonly publishTx: (inputs: {
		readonly modules: ReadonlyArray<Uint8Array>;
		readonly dependencies: ReadonlyArray<string>;
		readonly sourcePath: string;
		readonly packageName: string;
	}) => Effect.Effect<PublishReceipt, PublishError, Scope.Scope>;

	/** Post-publish fullnode/indexer ready-probe. Distilled doc
	 *  Invariant 5: publish-tx commit precedes index visibility.
	 *  Polls `getObject(packageId)` until success or a 10s ceiling
	 *  at ~200ms cadence. Failure raises `PublishError('parse')`
	 *  per the distilled doc's phase catalog ("stuck indexer"). */
	readonly waitForReady: (packageId: string) => Effect.Effect<void, PublishError, Scope.Scope>;
}

export interface LocalModeInputs {
	readonly packageName: string;
	readonly sourcePath: string;
	readonly chainId: ChainId;
	readonly publisherAddress: string;
	readonly mvrOverride?: string;
	readonly captureSpec?: (receipt: PublishReceipt) => Readonly<Record<string, string>>;
	/** Publish executor — constructed per-acquire by the barrel from
	 *  the resolved SuiClient + publisher account + ContainerRuntime
	 *  (see `publish-executor.ts`). */
	readonly executor: PublishExecutor;
}

export interface LocalModeOutputs {
	readonly resolved: ResolvedLocalPackage;
	readonly receipt: PublishReceipt | null;
}

/**
 * Build the content hash for the publish cache key. Distilled doc
 * §Move-specific: inputs are `(sourceHash, signerAddress)`. The
 * `hashMoveSources` helper already normalises Move.lock pinned
 * sections via the shared `stripPinnedSections`; we fold the
 * publisher address in here as a stable string so reusing the
 * same source under a different signer correctly misses (Invariant
 * 4: "Signer MUST be an explicit upstream").
 */
const LOCAL_PACKAGE_CACHE_SCHEMA_VERSION = 'v2';

const combineInputsHash = (sourceHash: string, publisherAddress: string) =>
	brandContentHash(
		`${LOCAL_PACKAGE_CACHE_SCHEMA_VERSION}::source=${sourceHash}::publisher=${publisherAddress}`,
	);

/**
 * Verify probe — lenient `getObject(packageId)`. Returns the decoded
 * shape on success; null for BOTH not-found AND transient (distilled
 * doc Invariant 7 + the "lenient verify cheaper than aggressive
 * eviction" Constraint).
 *
 * The cached id is hinted in via parameter. The OCA substrate is
 * expected to thread the cached payload through to this closure on
 * cache hit; today we get the id from the registry's previous-cycle
 * entry (in-process, per-supervisor lookup — see `acquireLocal`
 * below). When no hint exists (first cycle / cold boot), we
 * short-circuit to null so the substrate runs `produce`.
 *
 * Mirrors `coin/mint.ts::buildVerifyProbe` exactly so the two OCA
 * consumers stay shape-aligned.
 */
const buildVerifyProbe = (
	probe: ChainProbe<SuiProbeKey>,
	cachedPackageIdHint: string | null,
): Effect.Effect<typeof PackageVerifyShape.Type | null, never> =>
	Effect.gen(function* () {
		if (cachedPackageIdHint === null) return null;
		// Lenient mode in the underlying probe already coerces
		// not-found AND transient → null. We just forward.
		const result: typeof PackageVerifyShape.Type | null = yield* probe
			.get({ kind: 'object', objectId: cachedPackageIdHint }, PackageVerifyShape, 'lenient')
			.pipe(
				// The probe's own error channel is `ChainProbeError`; under
				// lenient mode only `decode-failed` surfaces (not-found +
				// transient already coerce to null). A decode failure on
				// verify is treated as "stale shape" — null so the substrate
				// re-publishes rather than carry forward a mismatch.
				Effect.catch(() => Effect.succeed(null as typeof PackageVerifyShape.Type | null)),
			);
		return result;
	});

/**
 * Compose the OnChainArtifactSpec for a local publish.
 *
 * The substrate-side `OnChainArtifactPublisher.publish` consumes
 * this spec and handles:
 *
 *   - cache lookup under `<namespace>/<chainId>/<contentHash>`;
 *   - verify (lenient) when there's a hit;
 *   - re-running `produce` on miss OR verify-fail;
 *   - calling `register` on EVERY cycle.
 */
export const acquireLocal = (
	publisher: OnChainArtifactPublisher,
	probe: ChainProbe<SuiProbeKey>,
	registry: PackageRegistry,
	inputs: LocalModeInputs,
): Effect.Effect<LocalModeOutputs, PublishError | OnChainArtifactError, Scope.Scope> =>
	Effect.gen(function* () {
		// Distilled doc §Move-specific: hash inputs are `(sourceHash,
		// signerAddress)`. The hashing helper strips Move.lock pinned
		// sections (Invariant 2) so warm restarts hit the cache.
		const sourceHash = yield* hashMoveSources(inputs.sourcePath);
		const inputsHash = combineInputsHash(sourceHash, inputs.publisherAddress);

		const mvrPlaceholder = mvrSlugify(inputs.mvrOverride ?? inputs.packageName);

		// The in-process registry is consulted on the `register`
		// callback (verify-hit path) to recover `mvrPlaceholder` +
		// `captured` columns when the substrate hands back the bare
		// `{objectId, type}` verify shape; see the register body below.
		const priorEntry = yield* registry.find(inputs.packageName);

		// We capture the produce-side receipt out-of-band so the
		// returned `LocalModeOutputs.receipt` can expose it; the OCA
		// substrate's `Produced | Verified` discrimination collapses
		// the receipt away.
		let producedReceipt: PublishReceipt | null = null;

		const resolved = yield* publisher.publish<CachedPackageEntry, typeof PackageVerifyShape.Type>({
			namespace: 'package',
			chain: inputs.chainId,
			contentHash: inputsHash,
			verifySchema: PackageVerifyShape,
			verify: (cached) =>
				cached.receipt === undefined
					? Effect.succeed(null)
					: buildVerifyProbe(probe, cached.packageId),
			// Produce: scrub → build → publish-tx → wait-for-index → parse.
			// PublishError is the plugin-internal phase taxonomy; we map
			// it to `OnChainArtifactError` at the substrate boundary.
			produce: Effect.gen(function* () {
				yield* Effect.annotateCurrentSpan({
					'package.publish.package': inputs.packageName,
					'package.publish.sourcePath': inputs.sourcePath,
					'package.publish.chainId': inputs.chainId,
					'package.publish.publisher': inputs.publisherAddress,
				});

				// Produce 1/5 — scrub locks. Distilled doc §Move-specific
				// concerns + Invariant 14: strip pinned sections from BOTH
				// the package's own Move.lock AND every
				// `~/.move/git/**/Move.lock` (vendored dep caches) before
				// invoking the build. Uses the unified `stripPinnedSections`
				// (re-exported through `build.ts` → from
				// `../sui/move-lock-scrub.ts`) — NO duplicate.
				yield* Effect.annotateCurrentSpan({ 'package.publish.phase': 'scrub' });
				yield* scrubLocksHost(inputs.sourcePath, '~/.move');

				// Produce 2/5 — build. Executor dispatches between (a)
				// per-app build container, (b) `docker run --rm`, (c) host
				// `sui` CLI.
				yield* Effect.annotateCurrentSpan({ 'package.publish.phase': 'build' });
				const buildOutput: BuildOutput = yield* inputs.executor
					.build({
						sourcePath: inputs.sourcePath,
						packageName: inputs.packageName,
						chainId: inputs.chainId,
					})
					.pipe(
						Effect.catchTag(
							'PublishError',
							(err): Effect.Effect<BuildOutput, PublishError> =>
								// Re-stamp sourcePath/packageName if the underlying
								// caller omitted them (every throw site MUST surface
								// the context — see distilled doc §Opportunities).
								Effect.fail(
									err.sourcePath
										? err
										: {
												...err,
												sourcePath: inputs.sourcePath,
												packageName: inputs.packageName,
											},
								),
						),
					);

				// Produce 3/5 — publish-tx. Construct `Transaction.publish`,
				// sign + execute via the publisher's account signer, decode
				// the receipt.
				yield* Effect.annotateCurrentSpan({ 'package.publish.phase': 'publish-tx' });
				const receipt: PublishReceipt = yield* inputs.executor.publishTx({
					modules: buildOutput.modules,
					dependencies: buildOutput.dependencies,
					sourcePath: inputs.sourcePath,
					packageName: inputs.packageName,
				});
				producedReceipt = receipt;

				// Produce 4/5 — wait-for-index. Distilled doc Invariant 5:
				// publish-tx commit precedes index visibility. Without this
				// gate, downstream tx builders fail with "Dependent package
				// not found". Failure surfaces as `PublishError('parse')`
				// per the distilled doc's phase catalog ("stuck indexer").
				yield* Effect.annotateCurrentSpan({ 'package.publish.phase': 'waiting-for-index' });
				yield* inputs.executor.waitForReady(receipt.packageId);

				// Produce 5/5 — parse. Distilled doc §Move-specific
				// concerns: pick the `'published'` change for packageId;
				// pick the `UpgradeCap`-typed `'created'` change for the
				// upgrade cap.
				yield* Effect.annotateCurrentSpan({ 'package.publish.phase': 'parse' });
				const published = pickPublishedChange(receipt.objectChanges);
				if (!published?.objectId) {
					return yield* Effect.fail(
						publishError('parse', {
							sourcePath: inputs.sourcePath,
							packageName: inputs.packageName,
							message:
								'no "published" change in receipt — SDK shape drift (distilled doc §Edge cases)',
						}),
					);
				}
				const upgradeCap: PublishObjectChange | undefined = pickUpgradeCapChange(
					receipt.objectChanges,
				);

				// Capture spec — user-declared projection from receipt to
				// typed object id map. Distilled doc §Outputs + Invariant:
				// safe to swallow individual key failures (callback form
				// is user code), but a callback throw bubbles up as a
				// PublishError('parse') so the user catches the typo.
				const captured: Readonly<Record<string, string>> = inputs.captureSpec
					? yield* Effect.try({
							try: () => inputs.captureSpec!(receipt),
							catch: (cause): PublishError =>
								publishError('parse', {
									sourcePath: inputs.sourcePath,
									packageName: inputs.packageName,
									message: 'captureSpec callback threw',
									cause,
								}),
						})
					: {};

				const entry: CachedPackageEntry = {
					packageId: published.objectId,
					upgradeCapId: upgradeCap?.objectId,
					publisher: inputs.publisherAddress,
					mvrPlaceholder,
					captured,
					receipt,
				};
				return entry;
			}).pipe(
				Effect.mapError(
					(err): OnChainArtifactError => ({
						_tag: 'OnChainArtifactError',
						reason: 'produce-failed',
						detail: `package.publish ${err.phase}: ${err.message}`,
					}),
				),
			),
			// Register: on EVERY cycle. Distilled doc Invariant 6.
			// The publisher hands us either `Produced` (CachedPackageEntry)
			// or `Verified` (`{ objectId, type }` from the verifySchema).
			// On verify-hit we project to a synthesized entry; on produce
			// we already have the full shape. The cache-hit path needs
			// to thread through the cached mvrPlaceholder + captured
			// fields — but those aren't in the verify schema. We reuse the
			// prior in-process registry entry as a hint (mirrors the
			// verify-hint plumbing above).
			register: (artifact) =>
				Effect.gen(function* () {
					const entry: CachedPackageEntry =
						'packageId' in artifact
							? artifact
							: {
									// Verify-hit path: project from the bare
									// `{ objectId, type }` probe shape using the
									// previously-resolved registry entry to recover
									// `mvrPlaceholder` + `captured`. If no prior
									// entry exists (first cold-boot verify hit —
									// unusual; implies a different process wrote
									// the cache), we fall back to safe defaults.
									packageId: artifact.objectId,
									publisher: inputs.publisherAddress,
									mvrPlaceholder:
										priorEntry && priorEntry.kind === 'local'
											? priorEntry.mvrPlaceholder
											: mvrPlaceholder,
									captured: priorEntry && priorEntry.kind === 'local' ? priorEntry.captured : {},
									upgradeCapId:
										priorEntry && priorEntry.kind === 'local' ? priorEntry.upgradeCapId : undefined,
								};
					const r: ResolvedLocalPackage = {
						kind: 'local',
						name: inputs.packageName,
						packageId: entry.packageId,
						upgradeCapId: entry.upgradeCapId,
						sourcePath: inputs.sourcePath,
						mvrPlaceholder: entry.mvrPlaceholder,
						captured: entry.captured,
					};
					yield* registry.set(r.name, r);
				}),
		});

		// Project the cached/verified entry back to the resolved shape.
		// The publisher's `Produced | Verified` union — Produced is
		// CachedPackageEntry (full); Verified is `{ objectId, type }`
		// from the verify schema. Both collapse onto the registry's
		// projected `ResolvedLocalPackage` — and `register` already
		// performed that projection. Re-read the registry to recover
		// the unified shape regardless of which arm fired.
		const final = yield* registry.find(inputs.packageName);
		if (!final || final.kind !== 'local') {
			// Defensive — register fires unconditionally; missing entry
			// here would mean substrate skipped register, violating
			// Invariant 6. Surface as a parse-phase failure since it's
			// indistinguishable from a missing 'published' change from
			// the consumer's perspective.
			return yield* Effect.fail(
				publishError('parse', {
					sourcePath: inputs.sourcePath,
					packageName: inputs.packageName,
					message: 'register did not surface entry — OCA register invariant violation',
				}),
			);
		}

		// Silence the unused-binding lint for the OCA `resolved` — the
		// substrate's `Produced | Verified` return is informational
		// here (we project through the registry instead).
		void resolved;

		const cachedReceipt =
			'packageId' in resolved && 'receipt' in resolved ? (resolved.receipt ?? null) : null;

		return {
			resolved: final,
			receipt: producedReceipt ?? cachedReceipt,
		};
	});
