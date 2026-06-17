// Local mode — build from source + publish.
//
// This is the canonical implementation of the
// `ArtifactPublisher` substrate primitive (distilled doc
// §Generic artifact-publisher-publish pattern). The five-phase shape:
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
// The publish output is exposed on the resolved value and emitted as a
// package-owned extension contribution for sibling folds.

import { Duration, Effect, Schema, type Scope } from 'effect';

import { contentHash as brandContentHash } from '../../substrate/brand.ts';
import type { LocalPackagePublishOutput } from './publish-output.ts';
import {
	artifactPublishError,
	type ArtifactPublishError,
	type ArtifactPublisher,
} from '../../primitives/artifact-publisher.ts';
import type { ChainProbe } from '../../contracts/chain-probe.ts';
import type { SuiProbeKey } from '../sui/index.ts';
import { hashMoveSources, scrubLocksHost, withMoveBuildLock, type BuildOutput } from './build.ts';
import { mvrNamedForm } from './dep-resolution.ts';
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
	readonly output?: LocalPackagePublishOutput;
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
	readonly scrubsInsideContainer: boolean;

	/** Build the Move source tree into `{ modules, dependencies }`.
	 *  Dispatches between (a) per-app build container, (b) fresh
	 *  `docker run --rm`, (c) host `sui` CLI. The produce body just
	 *  calls and propagates `PublishError`. */
	readonly build: (inputs: {
		readonly sourcePath: string;
		readonly packageName: string;
		readonly chainId: string;
	}) => Effect.Effect<BuildOutput, PublishError, Scope.Scope>;

	/** Construct + sign + execute a `Transaction.publish({modules,
	 *  dependencies})` against the publisher account. Returns the
	 *  output projection that downstream consumers (Coin, manifest,
	 *  capture spec) need. Distilled doc §Move-specific concerns —
	 *  the output is the source of `published` change + the
	 *  `UpgradeCap` `created` change. */
	readonly publishTx: (inputs: {
		readonly modules: ReadonlyArray<Uint8Array>;
		readonly dependencies: ReadonlyArray<string>;
		readonly sourcePath: string;
		readonly packageName: string;
	}) => Effect.Effect<LocalPackagePublishOutput, PublishError, Scope.Scope>;

	/** Post-publish fullnode/indexer ready HINT. Distilled doc
	 *  Invariant 5: publish-tx commit precedes index visibility. This
	 *  is BEST-EFFORT — the concrete executor swallows transient
	 *  `getObject` misses (cold index races) because the publisher
	 *  account's `signAndExecute` already calls `waitForTransaction`
	 *  before returning, AND the downstream `parse` phase only
	 *  inspects the publish output. A typed `PublishError('parse')`
	 *  surfaces only when the `getObject` infrastructure itself
	 *  faults (network down / SDK throws non-recoverably), NOT when
	 *  the object is merely not-yet-indexed.
	 *
	 *  The "Hint" suffix encodes the contract: callers MUST NOT treat
	 *  a successful return as "package definitely queryable now". */
	readonly postPublishReadyHint: (
		packageId: string,
	) => Effect.Effect<void, PublishError, Scope.Scope>;
}

export interface LocalModeInputs {
	readonly packageName: string;
	readonly sourcePath: string;
	readonly chainId: string;
	readonly publisherAddress: string;
	readonly mvrOverride?: string;
	readonly capture?: (output: LocalPackagePublishOutput) => Readonly<Record<string, string>>;
	/** Publish executor — constructed per-acquire by the barrel from
	 *  the resolved SuiClient + publisher account + ContainerRuntime
	 *  (see `publish-executor.ts`). */
	readonly executor: PublishExecutor;
}

export interface LocalModeOutputs {
	readonly resolved: ResolvedLocalPackage;
	readonly output: LocalPackagePublishOutput | null;
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
const LOCAL_PACKAGE_CACHE_SCHEMA_VERSION = 'v3';
// Short verify budget covering RPC index-visibility lag only. The big
// post-restore catch-up window — `sui start` re-executes its committed
// checkpoint store from seq=0, and `getObject(packageId)` reads not-found
// until the replay reaches the publish checkpoint — is now absorbed by the
// sui plugin's caught-up-to-head ready-gate (`waitForCheckpointCatchUp` in
// plugins/sui/mode/local.ts): the validator does not report ready until its
// head stabilizes to live cadence, so by the time this verify runs the
// committed package object is already served. This budget only needs to ride
// out the small fullnode/index lag between publish-tx commit and `getObject`
// visibility — NOT the whole replay. If it gives up too soon it returns null →
// the substrate re-PRODUCES (re-publishes) the package, minting a FRESH
// packageId (codegen `config.ts` loses the stable id; downstream
// `deepbookOf(...).packageId` churns). A truly-wiped chain genuinely has no
// package and re-publishes once the budget lapses. Mirrors
// WALRUS_DEPLOY_VERIFY_READINESS_* in plugins/walrus/deploy.ts — the on-chain
// artifact-publisher consumers share the same short RPC-lag tolerance.
const PACKAGE_CACHE_VERIFY_MAX_ATTEMPTS = 20;
const PACKAGE_CACHE_VERIFY_DELAY_MS = 250;

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
 * The cached id is hinted in via parameter. The artifact publisher substrate is
 * expected to thread the cached payload through to this closure on
 * cache hit; today we get the id from the registry's previous-cycle
 * entry (in-process, per-supervisor lookup — see `acquireLocal`
 * below). When no hint exists (first cycle / cold boot), we
 * short-circuit to null so the substrate runs `produce`.
 *
 * Mirrors `coin/mint.ts::buildVerifyProbe` exactly so the two artifact publisher
 * consumers stay shape-aligned.
 */
export const buildVerifyProbe = (
	probe: ChainProbe<SuiProbeKey>,
	cachedPackageIdHint: string | null,
	opts?: { readonly maxAttempts?: number; readonly delayMs?: number },
): Effect.Effect<typeof PackageVerifyShape.Type | null, never> =>
	Effect.gen(function* () {
		if (cachedPackageIdHint === null) return null;
		const maxAttempts = opts?.maxAttempts ?? PACKAGE_CACHE_VERIFY_MAX_ATTEMPTS;
		const delayMs = opts?.delayMs ?? PACKAGE_CACHE_VERIFY_DELAY_MS;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			// Lenient mode in the underlying probe already coerces
			// not-found AND transient → null. We retry nulls briefly to
			// ride out the small fullnode/index lag between publish-tx
			// commit and `getObject` visibility; the validator's larger
			// post-restore replay is already gated upstream by the sui
			// plugin's caught-up-to-head ready-gate, so a false cache miss
			// does not turn a warm restart into an unnecessary publish.
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
			if (result !== null) return result;
			if (attempt < maxAttempts && delayMs > 0) {
				yield* Effect.sleep(Duration.millis(delayMs));
			}
		}
		return null;
	});

/**
 * Compose the ArtifactSpec for a local publish.
 *
 * The substrate-side `ArtifactPublisher.publish` consumes
 * this spec and handles:
 *
 *   - cache lookup under `<namespace>/<chainId>/<contentHash>`;
 *   - verify (lenient) when there's a hit;
 *   - re-running `produce` on miss OR verify-fail;
 *   - calling `register` on EVERY cycle.
 */
export const acquireLocal = (
	publisher: ArtifactPublisher,
	probe: ChainProbe<SuiProbeKey>,
	registry: PackageRegistry,
	inputs: LocalModeInputs,
): Effect.Effect<LocalModeOutputs, PublishError | ArtifactPublishError, Scope.Scope> =>
	Effect.gen(function* () {
		// Intra-stack name collision guard.
		//
		// The registry is keyed by symbolic `packageName`; two
		// `localPackage('foo', ...)` calls in the same stack would both
		// call `register({ name: 'foo', ... })` and the second `set`
		// would silently overwrite the first. Upstream's
		// `resolveGraph` (substrate/runtime/lifecycle/dep-graph.ts:127)
		// explicitly documents "we don't enforce uniqueness at runtime;
		// the duplicate just resolves to the latest declaration" —
		// compile-time `MissingProviders` only catches collisions on
		// the user-typed dependency path, NOT two members declared on
		// the same stack with the same id. We catch the collision here
		// so the user sees a typed parse-phase failure instead of a
		// confusing "wrong packageId" downstream.
		//
		// The check tolerates re-entry from the SAME `localPackage(...)`
		// call (warm restart / re-acquire on the same scope): a
		// pre-existing entry with the SAME `sourcePath` is the
		// previous cycle's register, not a collision.
		const existing = yield* registry.find(inputs.packageName);
		if (
			existing !== null &&
			existing.kind === 'local' &&
			existing.sourcePath !== inputs.sourcePath
		) {
			return yield* Effect.fail(
				publishError('parse', {
					sourcePath: inputs.sourcePath,
					packageName: inputs.packageName,
					message:
						`localPackage('${inputs.packageName}') is declared twice in the same stack ` +
						`with different sourcePaths (${existing.sourcePath} vs ${inputs.sourcePath}). ` +
						`The substrate is name-blind at runtime and the second declaration would ` +
						`silently overwrite the first registry entry. Pick distinct package names ` +
						`(the symbolic name is the registry key consumers look up).`,
				}),
			);
		}
		// Distilled doc §Move-specific: hash inputs are `(sourceHash,
		// signerAddress)`. The hashing helper strips Move.lock pinned
		// sections (Invariant 2) so warm restarts hit the cache.
		const sourceHash = yield* hashMoveSources(inputs.sourcePath);
		const inputsHash = combineInputsHash(sourceHash, inputs.publisherAddress);

		// The MVR placeholder is the NAMED form (`@local/<slug>`), not the
		// bare slug — it is emitted as BOTH the generated-binding package
		// default (`options.package ?? '@local/<slug>'`) and
		// `config.packages.<name>.mvr`, so apps can resolve bindings by
		// name alone via an MvrClient override keyed on that string. The
		// bare slug survives only as file stems / Move `[addresses]`
		// resolution, which `mvrNamedForm` derives internally.
		const mvrPlaceholder = mvrNamedForm(inputs.mvrOverride ?? inputs.packageName);

		// We capture the produce-side output out-of-band so the
		// returned `LocalModeOutputs.output` can expose it. The
		// substrate hands back the decoded `CachedPackageEntry` on
		// every path; `producedOutput` is the freshly-emitted output
		// from THIS cycle (cache miss only).
		let producedOutput: LocalPackagePublishOutput | null = null;

		const entry: CachedPackageEntry = yield* publisher.publish<
			CachedPackageEntry,
			typeof PackageVerifyShape.Type
		>({
			namespace: 'package',
			chain: inputs.chainId,
			contentHash: inputsHash,
			verify: (cached) =>
				cached.output === undefined
					? Effect.succeed(null)
					: buildVerifyProbe(probe, cached.packageId),
			// Produce: scrub → build → publish-tx → wait-for-index → parse.
			// PublishError is the plugin-internal phase taxonomy; we map
			// it to `ArtifactPublishError` at the substrate boundary.
			produce: Effect.gen(function* () {
				// Produce 1/5 + 2/5 — scrub locks, then build. Both touch the
				// shared `~/.move` git cache, so they run together under the
				// process-wide Move-build permit (`withMoveBuildLock`): otherwise a
				// concurrent build's host scrub (`gawk -i inplace`) races a sibling
				// container's live `git clone` into the same cache dir and corrupts
				// the in-flight fetch. Publish-tx (3/5 below) stays OUTSIDE the lock
				// so on-chain work of different packages still overlaps.
				const buildOutput: BuildOutput = yield* withMoveBuildLock(
					Effect.gen(function* () {
						// Produce 1/5 — scrub locks. Distilled doc §Move-specific
						// concerns + Invariant 14: strip pinned sections from every
						// `~/.move/git/**/Move.lock` (vendored dep caches) before
						// invoking the build. The package's own Move.lock is scrubbed
						// inside the container on a disposable copy, so the developer's
						// checked-in source is left untouched host-side. Uses the
						// unified `stripPinnedSections` (re-exported through `build.ts`
						// → from `../sui/move-lock-scrub.ts`) — NO duplicate.
						yield* scrubLocksHost(inputs.sourcePath, '~/.move');

						// Produce 2/5 — build. Executor dispatches between (a)
						// per-app build container, (b) `docker run --rm`, (c) host
						// `sui` CLI.
						return yield* inputs.executor
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
					}),
				);

				// Produce 3/5 — publish-tx. Construct `Transaction.publish`,
				// sign + execute via the publisher's account signer, decode
				// the output.
				const output: LocalPackagePublishOutput = yield* inputs.executor.publishTx({
					modules: buildOutput.modules,
					dependencies: buildOutput.dependencies,
					sourcePath: inputs.sourcePath,
					packageName: inputs.packageName,
				});
				producedOutput = output;

				// Produce 4/5 — wait-for-index. Distilled doc Invariant 5:
				// publish-tx commit precedes index visibility. This is a
				// hint-only probe (see `postPublishReadyHint` doc on
				// `PublishExecutor`): the publisher account's
				// `signAndExecute` already awaits `waitForTransaction`, so
				// the typical race is closed before we reach here.
				// Best-effort only: the executor's hint swallows transient
				// `getObject` misses and logs at debug, so its error channel
				// collapses to `never` (see `publish-executor.ts →
				// postPublishReadyHint`). No re-stamp is needed because no
				// failure surfaces here.
				yield* inputs.executor.postPublishReadyHint(output.packageId);

				// Capture spec — user-declared projection from output to
				// typed object id map. Distilled doc §Outputs: the callback
				// is user code, so a throw is a USER BUG (typo / missing
				// field) — surface as `PublishError('parse')` so the user
				// catches the mistake instead of silently shipping a stale
				// captured map. The cache-HIT path performs the symmetric
				// recompute post-`publisher.publish` (see comment block
				// below the `publisher.publish` call) — both paths bubble
				// the same `PublishError('parse')` shape.
				const captured: Readonly<Record<string, string>> = inputs.capture
					? yield* Effect.try({
							try: () => inputs.capture!(output),
							catch: (cause): PublishError =>
								publishError('parse', {
									sourcePath: inputs.sourcePath,
									packageName: inputs.packageName,
									message: 'capture callback threw',
									cause,
								}),
						})
					: {};

				const entry: CachedPackageEntry = {
					packageId: output.packageId,
					upgradeCapId: output.upgradeCapId,
					publisher: inputs.publisherAddress,
					mvrPlaceholder,
					captured,
					output,
				};
				return entry;
			}).pipe(
				Effect.mapError(
					(err): ArtifactPublishError =>
						artifactPublishError('produce-failed', `package.publish ${err.phase}: ${err.message}`),
				),
			),
			// Register: on EVERY cycle. Distilled doc Invariant 6. The
			// substrate hands the decoded `CachedPackageEntry` payload
			// here on both verify-hit and freshly-produced paths.
			//
			// Register writes the entry verbatim using `artifact.captured`
			// (produce-time on miss; cached on hit). The user's `capture`
			// callback is NOT re-run here — `register`'s contract is
			// `Effect.Effect<void, never>` (primitives/artifact-publisher.ts)
			// and a user-bug throw needs a typed failure channel. The
			// post-publish recompute below (cache-hit branch) re-runs
			// `capture` so renamed/typo keys surface IDENTICALLY to the
			// cache-miss path (mode-local.ts:346-357) — i.e., as
			// `PublishError('parse')`.
			register: (artifact) =>
				Effect.gen(function* () {
					const r: ResolvedLocalPackage = {
						kind: 'local',
						name: inputs.packageName,
						packageId: artifact.packageId,
						upgradeCapId: artifact.upgradeCapId,
						sourcePath: inputs.sourcePath,
						mvrPlaceholder: artifact.mvrPlaceholder,
						captured: artifact.captured,
					};
					yield* registry.set(r.name, r);
				}),
		});

		// Post-publish capture recompute — cache-hit ONLY.
		//
		// Symmetric with the produce-time capture (L346-357): the user's
		// `capture` callback is user code; a throw is a user bug (typo /
		// renamed key against a stale cached output) and MUST surface as
		// `PublishError('parse')` so the user sees the mistake instead of
		// silently carrying forward `artifact.captured` — swallowing the
		// throw with `catch { return artifact.captured }` would hide
		// renamed keys behind stale data.
		//
		// Cache miss: `producedOutput` was set inside `produce`, the
		// produce-time capture already ran (Effect.try → PublishError),
		// and the substrate cached the produced entry. Re-running here
		// would be redundant and would double-throw on user bugs.
		//
		// Cache hit: `producedOutput` is null, `entry.output` came from
		// the cached payload, and `entry.captured` is whatever the user's
		// `capture` returned at the time of the original publish. We
		// re-run `capture(entry.output)` so warm restarts with renamed
		// capture keys (a) reflect the new shape in the registry without
		// requiring a republish, and (b) FAIL LOUDLY on user-callback
		// throws — the symmetric counterpart to the produce-time guard.
		const cacheHit = producedOutput === null;
		if (cacheHit && inputs.capture !== undefined && entry.output !== undefined) {
			const recomputedCaptured: Readonly<Record<string, string>> = yield* Effect.try({
				try: () => inputs.capture!(entry.output!),
				catch: (cause): PublishError =>
					publishError('parse', {
						sourcePath: inputs.sourcePath,
						packageName: inputs.packageName,
						message: 'capture callback threw',
						cause,
					}),
			}).pipe(
				// Match the produce-body `mapError` projection (L373-379)
				// so callers see ONE consistent failure shape on
				// `capture` throws — `ArtifactPublishError('produce-failed')`
				// with `detail: "package.publish parse: capture callback
				// threw"` — regardless of whether the bug surfaces on a
				// cache miss (inside `produce`) or a cache hit (here).
				Effect.mapError(
					(err): ArtifactPublishError =>
						artifactPublishError('produce-failed', `package.publish ${err.phase}: ${err.message}`),
				),
			);
			yield* registry.set(inputs.packageName, {
				kind: 'local',
				name: inputs.packageName,
				packageId: entry.packageId,
				upgradeCapId: entry.upgradeCapId,
				sourcePath: inputs.sourcePath,
				mvrPlaceholder: entry.mvrPlaceholder,
				captured: recomputedCaptured,
			});
		}

		// Project the cached entry back to the resolved shape. The
		// publisher returned the decoded `CachedPackageEntry`; re-read
		// the registry to recover the canonical `ResolvedLocalPackage`
		// shape (`register` ran on every cycle and wrote it).
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
					message:
						'register did not surface entry — artifact publisher register invariant violation',
				}),
			);
		}

		return {
			resolved: final,
			output: producedOutput ?? entry.output ?? null,
		};
	});
