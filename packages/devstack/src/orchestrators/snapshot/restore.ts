// Restore pipeline.
//
// Architecture § Snapshot lifecycle (restore half):
//
//   Identity guard (chain identity + plugin contributions)
//       │   (refuse and stop if mismatch — nothing touched)
//       ▼
//   Stage atomic restore in tempdir
//       │
//       ▼
//   Per plugin: expand tar to staging, load committed images
//       │
//       ▼
//   Atomic swap into runtime dir, preserving live control files
//       │
//       ▼
//   snapshot.restored event → next stack acquire picks it up
//
// Bracketed-atomic — Tension 9 decision: one outer atomic swap, not
// per-phase idempotency.

import { mintRandomSuffix } from '../../substrate/runtime/random-suffix.ts';

import { Effect, Exit, FileSystem, Schema, Stream } from 'effect';

import type { ContainerRuntime, ImageRef } from '../../contracts/container-runtime.ts';
import {
	HostTreeTarError,
	untarHostTree,
	validateHostTreeTarEntries,
} from '../../substrate/runtime/host-tree-tar/index.ts';
import { decodeUnknown, parseJsonText } from '../../substrate/runtime/runtime-decode.ts';
import {
	ContributionDocSchema,
	containerImagesBundlePath,
	contributionPath,
	DEPLOY_CACHE_NAMESPACES,
	SnapshotLayout,
	SnapshotMetadataSchema,
	type SnapshotId,
	type CapturedContainer,
	type IdentitySlice,
	type SnapshotMetadata,
	isRestorableContainerImageName,
	isSafeSnapshotPathSegment,
	isSafeSnapshotRelativePath,
	parseSnapshotId,
} from './descriptor.ts';
import { makePhaseFailer } from './phase-error.ts';
import {
	mergeContributions,
	runIdentityGuard,
	runRuntimeIdentityGuard,
	type IdentityContribution,
	type IdentityContributionConflictError,
	type IdentityGuardError,
	type SnapshotRuntimeIdentity,
} from './identity-guard.ts';
import {
	type StageAndSwapError,
	type StageAndSwapPreservedPath,
} from '../../substrate/runtime/stage-and-swap/index.ts';
import {
	executeFsPlan,
	type ReconcileFsOp,
} from '../../substrate/runtime/reconcile/index.ts';
import {
	COMMAND_CHANNEL_COMMANDS_FILE_NAME,
	COMMAND_CHANNEL_EVENTS_FILE_NAME,
	runtimeControlLockPathForStackRoot,
} from '../../substrate/runtime/cross-process/command-channel/index.ts';
import {
	ImageBundleTagScanError,
	readImageBundleTags,
	verifyImageBundleTags,
} from './image-bundle-tags.ts';
import { CACHE_DIR_NAME, SNAPSHOTS_DIR_NAME } from './wipe.ts';

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/** Tagged failure during a restore step. Phase discriminates the
 *  failing step so the user-facing message can point at it. */
export class RestorePhaseError extends Schema.TaggedErrorClass<RestorePhaseError>()(
	'SnapshotRestorePhaseError',
	{
		phase: Schema.Literals([
			'read-meta',
			'meta-corrupt',
			'meta-absent',
			'read-contribution',
			'preflight',
			'pre-restore-hook',
			'untar-host-tree',
			'load-image',
			'retag-image',
			'post-restore-hook',
			'pre-cleanup',
			'missing-subtree-fatal',
		]),
		plugin: Schema.optional(Schema.String),
		detail: Schema.String,
		cause: Schema.optional(Schema.Defect),
	},
) {}

const failPhase = makePhaseFailer(RestorePhaseError);

const failRestore = (
	phase: RestorePhaseError['phase'],
	detail: string,
	plugin?: string,
): Effect.Effect<never, RestorePhaseError> =>
	Effect.fail(new RestorePhaseError({ phase, plugin, detail }));

const failImageBundleTagScan =
	(phase: RestorePhaseError['phase'], plugin?: string) =>
	(cause: ImageBundleTagScanError): Effect.Effect<never, RestorePhaseError> =>
		Effect.fail(new RestorePhaseError({ phase, plugin, detail: cause.detail, cause }));

// -----------------------------------------------------------------------------
// Participants — what restore needs from each plugin
// -----------------------------------------------------------------------------

/** One plugin's restore-side contributions: a live identity probe
 *  (read fresh from the live stack), an opaque pre-restore validation
 *  hook, and a post-restore hook. Mirrors `SnapshotableDecl`'s
 *  pre/post hook surface but closed over the plugin's key. */
export interface RestoreParticipant {
	readonly plugin: string;
	readonly liveIdentity: Effect.Effect<IdentitySlice>;
	/** Pre-restore application-level validation (version compat,
	 *  side-state). Identity-guard runs FIRST and unilaterally; this
	 *  is the plugin's extra hook. */
	readonly preRestore?: Effect.Effect<void>;
	/** Post-restore hook: re-validate, warm caches, etc. */
	readonly postRestore?: Effect.Effect<void>;
}

// -----------------------------------------------------------------------------
// Metadata read — authoritative; absent / unparseable refuses restore.
// -----------------------------------------------------------------------------

const readMeta = (
	artifactDir: string,
	expectedId: SnapshotId,
): Effect.Effect<SnapshotMetadata, RestorePhaseError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = `${artifactDir}/${SnapshotLayout.metaFile}`;
		const exists = yield* fs.exists(path).pipe(Effect.catch(() => Effect.succeed(false)));
		if (!exists) {
			return yield* Effect.fail(
				new RestorePhaseError({
					phase: 'meta-absent',
					detail: `snapshot meta.json not found at ${path}`,
				}),
			);
		}
		const text = yield* fs
			.readFileString(path)
			.pipe(Effect.catch(failPhase('read-meta', `read meta.json failed at ${path}`)));
		const raw = yield* parseJsonText(text, {
			source: path,
			mkError: (issue) =>
				new RestorePhaseError({
					phase: 'meta-corrupt',
					detail: `meta.json is not valid JSON at ${path}`,
					cause: issue.cause,
				}),
		});
		const meta = yield* decodeUnknown(SnapshotMetadataSchema, raw, {
			source: path,
			mkError: (issue) =>
				new RestorePhaseError({
					phase: 'meta-corrupt',
					detail: `meta.json failed schema decode at ${path}`,
					cause: issue.cause,
				}),
		});
		const parsedId = parseSnapshotId(meta.id);
		if (parsedId === null) {
			return yield* failRestore(
				'meta-corrupt',
				`meta.json contains an unsafe snapshot id: ${meta.id}`,
			);
		}
		if (parsedId !== expectedId) {
			return yield* failRestore(
				'meta-corrupt',
				`meta.json id ${meta.id} does not match requested snapshot id ${expectedId}`,
			);
		}
		return meta;
	}).pipe(Effect.withSpan('orchestrator.snapshot.restore.read-meta'));

// -----------------------------------------------------------------------------
// Managed-container removal by label.
// -----------------------------------------------------------------------------

/** Restore must discard the current writable layer even when the live
 *  supervisor still holds a claim for the container. This is
 *  intentionally separate from orphan sweep, which skips claimed
 *  containers by design. */
const removeCapturedContainers = (
	meta: SnapshotMetadata,
	runtime: ContainerRuntime,
	runtimeIdentity: SnapshotRuntimeIdentity,
): Effect.Effect<void, RestorePhaseError> =>
	Effect.gen(function* () {
		for (const captured of meta.containers) {
			yield* runtime
				.removeManagedContainers({
					app: runtimeIdentity.app,
					stack: runtimeIdentity.stack,
					plugin: captured.plugin,
					role: captured.role,
				})
				.pipe(
					Effect.catch(
						failPhase(
							'pre-cleanup',
							`remove managed containers for ${captured.plugin}/${captured.role} failed`,
							captured.plugin,
						),
					),
				);
		}
	}).pipe(Effect.withSpan('orchestrator.snapshot.restore.remove-containers'));

// -----------------------------------------------------------------------------
// Post-publish Docker image finalization.
// -----------------------------------------------------------------------------
//
// After the atomic swap, each staged image is re-tagged to its
// captured target name (`promoteStagedImages`) and the original
// captured containers are removed. There is NO crash-recovery marker:
// the staged image is left at its TARGET name, so on the next boot the
// supervisor's image-match adoption (`decideRunAction` in
// `runtime/docker/container.ts`) finds the image locally by name and
// `docker run`s it without scanning or re-tagging — the resumption
// contract is carried by the image name itself, not an on-disk marker.

interface StagedContainerImage {
	readonly captured: CapturedContainer;
	readonly stagedRef: ImageRef;
	readonly stagedImageTag: string;
}

const loadedBundleTags = (bundle: { readonly refs: ReadonlyArray<ImageRef> }): Set<string> => {
	const tags = new Set<string>();
	for (const ref of bundle.refs) {
		if (ref.tag !== undefined) tags.add(ref.tag);
	}
	return tags;
};

const mintRestoreStagingTag = (): string => `devstack-snapshot:restore-${mintRandomSuffix(24)}`;

// -----------------------------------------------------------------------------
// Artifact preflight — no destructive cleanup until required files are present.
// -----------------------------------------------------------------------------

const requirePathSegment = (
	kind: string,
	value: string,
	plugin?: string,
): Effect.Effect<void, RestorePhaseError> =>
	isSafeSnapshotPathSegment(value)
		? Effect.void
		: failRestore('preflight', `unsafe snapshot ${kind} path segment: ${value}`, plugin);

const requireReadableNonEmptyFile = (
	path: string,
	phase: RestorePhaseError['phase'],
	detail: string,
	plugin?: string,
): Effect.Effect<void, RestorePhaseError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const stat = yield* fs
			.stat(path)
			.pipe(Effect.catch(failPhase(phase, `${detail}: stat failed at ${path}`, plugin)));
		if (stat.size === 0n) {
			return yield* failRestore(phase, `${detail}: empty file at ${path}`, plugin);
		}
		yield* Stream.runDrain(fs.stream(path).pipe(Stream.take(1))).pipe(
			Effect.catch(failPhase(phase, `${detail}: read failed at ${path}`, plugin)),
		);
	});

const preflightCapturedContainer = (
	captured: CapturedContainer,
	artifactDir: string,
): Effect.Effect<void, RestorePhaseError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		yield* requirePathSegment('plugin', captured.plugin, captured.plugin);
		yield* requirePathSegment('role', captured.role, captured.plugin);
		if (!isSafeSnapshotRelativePath(captured.tarPath)) {
			return yield* failRestore(
				'preflight',
				`unsafe container image tar path: ${captured.tarPath}`,
				captured.plugin,
			);
		}
		const expectedTarPath = containerImagesBundlePath();
		if (captured.tarPath !== expectedTarPath) {
			return yield* failRestore(
				'preflight',
				`container image tar path ${captured.tarPath} does not match canonical bundle ${expectedTarPath}`,
				captured.plugin,
			);
		}
		if (!isRestorableContainerImageName(captured.imageName)) {
			return yield* failRestore(
				'preflight',
				`container imageName is not a restorable Docker tag destination: ${captured.imageName}`,
				captured.plugin,
			);
		}
		if (!isRestorableContainerImageName(captured.snapshotTag)) {
			return yield* failRestore(
				'preflight',
				`container snapshotTag is not a restorable Docker tag source: ${captured.snapshotTag}`,
				captured.plugin,
			);
		}
		yield* requireReadableNonEmptyFile(
			`${artifactDir}/${captured.tarPath}`,
			'load-image',
			'container image tar is required',
			captured.plugin,
		);
	});

const preflightContributionDoc = (
	pluginKey: string,
	artifactDir: string,
): Effect.Effect<void, RestorePhaseError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const path = `${artifactDir}/${contributionPath(pluginKey)}`;
		const fs = yield* FileSystem.FileSystem;
		const text = yield* fs
			.readFileString(path)
			.pipe(
				Effect.catch(
					failPhase('read-contribution', `read contribution doc failed at ${path}`, pluginKey),
				),
			);
		const raw = yield* parseJsonText(text, {
			source: path,
			mkError: (issue) =>
				new RestorePhaseError({
					phase: 'read-contribution',
					plugin: pluginKey,
					detail: `contribution doc is not valid JSON at ${path}`,
					cause: issue.cause,
				}),
		});
		const decoded = yield* decodeUnknown(ContributionDocSchema, raw, {
			source: path,
			mkError: (issue) =>
				new RestorePhaseError({
					phase: 'read-contribution',
					plugin: pluginKey,
					detail: `contribution doc failed schema decode at ${path}`,
					cause: issue.cause,
				}),
		});
		if (decoded.plugin !== pluginKey) {
			return yield* failRestore(
				'read-contribution',
				`contribution doc plugin ${decoded.plugin} does not match ${pluginKey}`,
				pluginKey,
			);
		}
	});

const preflightArtifact = (
	meta: SnapshotMetadata,
	artifactDir: string,
): Effect.Effect<void, RestorePhaseError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const seenSnapshotTags = new Map<string, CapturedContainer>();
		for (const captured of meta.containers) {
			yield* preflightCapturedContainer(captured, artifactDir);
			const previous = seenSnapshotTags.get(captured.snapshotTag);
			if (previous !== undefined) {
				return yield* failRestore(
					'preflight',
					`duplicate container snapshotTag ${captured.snapshotTag} for ${previous.plugin}/${previous.role} and ${captured.plugin}/${captured.role}`,
					captured.plugin,
				);
			}
			seenSnapshotTags.set(captured.snapshotTag, captured);
		}
		for (const pluginKey of meta.participants) {
			yield* preflightContributionDoc(pluginKey, artifactDir);
		}
		if (meta.hostTreeIncluded) {
			const tarPath = `${artifactDir}/${SnapshotLayout.hostTreeTar}`;
			yield* requireReadableNonEmptyFile(tarPath, 'untar-host-tree', 'host-tree tar is required');
			const tarStream = fs.stream(tarPath).pipe(
				Stream.mapError(
					(cause) =>
						new HostTreeTarError({
							stage: 'entry-validation',
							operation: 'untar',
							detail: `read host-tree tar failed at ${tarPath}`,
							cause,
						}),
				),
			);
			yield* validateHostTreeTarEntries(tarStream).pipe(
				Effect.catch(failPhase('untar-host-tree', `host-tree tar entry validation failed`)),
			);
		}
	}).pipe(Effect.withSpan('orchestrator.snapshot.restore.preflight'));

// -----------------------------------------------------------------------------
// Image load + staged re-tag.
// -----------------------------------------------------------------------------

const loadImageBundle = (
	tarPath: string,
	artifactDir: string,
	runtime: ContainerRuntime,
	expectedSnapshotTags: ReadonlyArray<string>,
): Effect.Effect<ReadonlyMap<string, ImageRef>, RestorePhaseError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const fullTarPath = `${artifactDir}/${tarPath}`;
		const exists = yield* fs.exists(fullTarPath).pipe(Effect.catch(() => Effect.succeed(false)));
		if (!exists) {
			return yield* Effect.fail(
				new RestorePhaseError({
					phase: 'load-image',
					detail: `container image bundle absent at ${fullTarPath}`,
				}),
			);
		}
		const bundleTags = yield* readImageBundleTags(fullTarPath, tarPath).pipe(
			Effect.catch(failImageBundleTagScan('load-image')),
		);
		yield* verifyImageBundleTags(tarPath, bundleTags, expectedSnapshotTags).pipe(
			Effect.catch(failImageBundleTagScan('load-image')),
		);
		const loaded = yield* runtime
			.loadImage(fs.stream(fullTarPath))
			.pipe(
				Effect.catch(
					failPhase('load-image', `load container image bundle from ${fullTarPath} failed`),
				),
			);
		const loadedTags = loadedBundleTags(loaded);
		const missing = expectedSnapshotTags.filter((tag) => !loadedTags.has(tag));
		if (missing.length > 0) {
			return yield* failRestore(
				'load-image',
				`container image bundle ${tarPath} did not load expected snapshot tags: ${missing.join(', ')}`,
			);
		}
		const refsByTag = new Map<string, ImageRef>();
		for (const ref of loaded.refs) {
			if (ref.tag === undefined || !expectedSnapshotTags.includes(ref.tag)) continue;
			if (refsByTag.has(ref.tag)) {
				return yield* failRestore(
					'load-image',
					`container image bundle ${tarPath} loaded duplicate snapshot tag ${ref.tag}`,
				);
			}
			refsByTag.set(ref.tag, ref);
		}
		return refsByTag;
	}).pipe(Effect.withSpan('orchestrator.snapshot.restore.load-image-bundle'));

const expectedSnapshotTagsByBundle = (
	containers: ReadonlyArray<CapturedContainer>,
): ReadonlyMap<string, ReadonlyArray<string>> => {
	const byBundle = new Map<string, string[]>();
	for (const captured of containers) {
		const tags = byBundle.get(captured.tarPath);
		if (tags === undefined) {
			byBundle.set(captured.tarPath, [captured.snapshotTag]);
		} else {
			tags.push(captured.snapshotTag);
		}
	}
	return byBundle;
};

const stageLoadedImage = (
	captured: CapturedContainer,
	loadedRef: ImageRef,
	runtime: ContainerRuntime,
	registerStagedImage: (image: StagedContainerImage) => Effect.Effect<void>,
): Effect.Effect<StagedContainerImage, RestorePhaseError> =>
	Effect.gen(function* () {
		const stagedImageTag = mintRestoreStagingTag();
		const stagedImage: StagedContainerImage = {
			captured,
			stagedRef: { digest: loadedRef.digest, tag: stagedImageTag },
			stagedImageTag,
		};
		yield* registerStagedImage(stagedImage);
		yield* runtime
			.tagImage(loadedRef, stagedImageTag, { removeSourceAfterTag: true })
			.pipe(
				Effect.catch(
					failPhase(
						'retag-image',
						`tag restored image ${captured.snapshotTag} as staging ref ${stagedImageTag} failed`,
						captured.plugin,
					),
				),
			);
		return stagedImage;
	}).pipe(Effect.withSpan('orchestrator.snapshot.restore.stage-image'));

const cleanupRestoreStagingImages = (
	runtime: ContainerRuntime,
	images: ReadonlyArray<StagedContainerImage>,
): Effect.Effect<void> =>
	Effect.forEach(
		images,
		(image) =>
			runtime
				.removeImage(image.stagedRef)
				.pipe(
					Effect.catch((cause) =>
						Effect.logWarning(
							`remove restore staging image ${image.stagedImageTag} failed during restore cleanup: ${String(
								cause,
							)}`,
						),
					),
				),
		{ concurrency: 'unbounded' },
	).pipe(Effect.asVoid);

/** Promote each staged image to its recorded TARGET name. The target
 *  name is the original image name the supervisor used for the
 *  container, so leaving the staged image at that name lets the next
 *  boot's image-match adoption (`decideRunAction`) find it locally and
 *  `docker run` it — no scanner, no on-disk marker. A mid-loop failure
 *  promotes a prefix of the images; the inner staging-cleanup scope
 *  prunes the un-promoted staging refs, and a re-run of restore re-stages
 *  and re-promotes from the snapshot artifact. */
const promoteStagedImages = (
	images: ReadonlyArray<StagedContainerImage>,
	runtime: ContainerRuntime,
): Effect.Effect<void, RestorePhaseError> =>
	Effect.gen(function* () {
		for (const image of images) {
			yield* runtime
				.tagImage(image.stagedRef, image.captured.imageName, {
					removeSourceAfterTag: true,
				})
				.pipe(
					Effect.catch(
						failPhase(
							'retag-image',
							`tag staged image ${image.stagedImageTag} as ${image.captured.imageName} failed`,
							image.captured.plugin,
						),
					),
				);
		}
	}).pipe(Effect.withSpan('orchestrator.snapshot.restore.promote-images'));

const restoreHostTree = (
	artifactDir: string,
	target: string,
): Effect.Effect<void, RestorePhaseError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const tarPath = `${artifactDir}/${SnapshotLayout.hostTreeTar}`;
		const exists = yield* fs.exists(tarPath).pipe(Effect.catch(() => Effect.succeed(false)));
		if (!exists) {
			return yield* Effect.fail(
				new RestorePhaseError({
					phase: 'untar-host-tree',
					detail: `host-tree tar absent at ${tarPath}`,
				}),
			);
		}
		const tarStream = fs.stream(tarPath).pipe(
			Stream.mapError(
				(cause) =>
					new HostTreeTarError({
						stage: 'stream-stdin',
						operation: 'untar',
						detail: `read host-tree tar failed at ${tarPath}`,
						cause,
					}),
			),
		);
		yield* Effect.scoped(untarHostTree(tarStream, { target })).pipe(
			Effect.catch(failPhase('untar-host-tree', `untar ${tarPath} to ${target} failed`)),
		);
	}).pipe(Effect.withSpan('orchestrator.snapshot.restore.host-tree'));

const LIVE_RESTORE_PRESERVED_PATHS: ReadonlyArray<StageAndSwapPreservedPath> = [
	{ relativePath: SNAPSHOTS_DIR_NAME, kind: 'directory' },
	{ relativePath: COMMAND_CHANNEL_COMMANDS_FILE_NAME, kind: 'file' },
	{ relativePath: COMMAND_CHANNEL_EVENTS_FILE_NAME, kind: 'file' },
	{ relativePath: 'roster.json', kind: 'file' },
	{ relativePath: 'container-claims.json', kind: 'file' },
	{ relativePath: 'snapshot.reservation', kind: 'file' },
	// Deploy/mint caches (DEPLOY_CACHE_NAMESPACES in descriptor.ts). Post-D1 the
	// capture NO LONGER tars these, so there is no captured copy in staging — the
	// LIVE cache is now the SOLE source. A wipe preserves it (D0 coupling), so it
	// is present at restore time; this entry preserves it across the stage-and-swap
	// (preserve-ALWAYS — overwrite defaults true) so the post-restore boot REUSES
	// the deploy instead of re-running it with fresh ids (which would orphan every
	// pre-snapshot object). Chain rollback reconciles any drift between the rolled-
	// back chain state and the live deploy ids. The generic per-call `cache/entry`
	// is NOT a deploy namespace and stays dropped (restore.test.ts pins that
	// rollback); a lost live cache (e.g. a hard reset) is surfaced LOUD by the
	// matrix probe's fail-loud assertion rather than silently re-deployed.
	...DEPLOY_CACHE_NAMESPACES.map(
		(namespace): StageAndSwapPreservedPath => ({
			relativePath: `${CACHE_DIR_NAME}/${namespace}`,
			kind: 'directory',
		}),
	),
];

// -----------------------------------------------------------------------------
// Top-level restore — bracketed-atomic via stage-and-swap.
// -----------------------------------------------------------------------------

export interface RestoreInputs {
	readonly snapshotId: SnapshotId;
	readonly artifactDir: string;
	readonly runtimeStackRoot: string;
	readonly runtimeStagingPath: string;
	readonly runtimeBackupPath: string;
	readonly participants: ReadonlyArray<RestoreParticipant>;
	readonly runtime: ContainerRuntime;
	readonly runtimeIdentity: SnapshotRuntimeIdentity;
}

/**
 * Run the full restore. Routed through the unified reconcile (redesign §2,
 * P4) as an ORDERED 4-step body — restore is NOT a single converge target
 * but a destructive ordered pair around an fs swap:
 *
 *   step0  — PRECONDITION: identity-guard, FAIL-CLOSED BEFORE ANY MUTATION.
 *            The runtime-identity guard + merged plugin-contribution guard
 *            complete BEFORE the first mutation (the docker load/tag inside
 *            the swap-tree build). On mismatch the sweep / load / tag spies
 *            stay EMPTY — zero mutations (guardrail §3.2; restore.test
 *            `:214/:263`). Keep the pure meta read → guard → only then
 *            mutate ordering.
 *   step1  — fsPlan `swap-tree(untar)`: a single-op `ReconcileFsPlan` run
 *            through `executeFsPlan`, which publishes the new tree via the
 *            UNCHANGED `stageAndSwap`. The build untars the host-tree +
 *            loads/stages the committed image bundle into staging; the
 *            atomic swap preserves the RESTORE preserve list
 *            (`LIVE_RESTORE_PRESERVED_PATHS` — per-namespace live cache +
 *            control files, a restore-direction constant, NOT wipe's
 *            wholesale predicate — guardrail §3.1/§3.3). Promote staged
 *            images to their captured TARGET names is the swap step's
 *            docker tail.
 *   step2 R1 — HARD container removal (target = absent, label scope,
 *            policy-independent, unconditional, claim-bypassing) via
 *            `removeManagedContainers`. STRICTLY before R2. Never expressed
 *            as flip-image-and-let-decideRunAction-recreate (guardrail
 *            §3.6).
 *   step2 R2 — CONVERGE (recreate-from-fresh): NOT in `runRestore`. R1
 *            removed the containers, so the NEXT acquire (the live
 *            supervisor's `doSelectiveRestart`, itself routed through
 *            `reconcileGraph`, or the offline CLI's next-boot acquire) sees
 *            facts:null → fresh → creates from the RESTORED images. Verb is
 *            recreate-from-fresh, NOT adopt.
 *
 * Bracketed-atomic at the runtime-root level — external watchers never
 * observe a half-restored tree. The caller is responsible for
 * `acquireReservation`; restore supplies the runtime-control publish lock
 * to the swap-tree op.
 */
export const runRestore = (
	inputs: RestoreInputs,
): Effect.Effect<
	SnapshotMetadata,
	RestorePhaseError | IdentityGuardError | IdentityContributionConflictError | StageAndSwapError,
	FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		yield* Effect.annotateCurrentSpan({
			'devstack.snapshot.phase': 'restore',
			'devstack.snapshot.artifact': inputs.artifactDir,
		});

		// Authoritative meta read (PURE — no mutation). There is no separate
		// integrity re-hash: the artifact is atomically published (never a
		// half-observed tree) and never transmitted; the host-tree tar is
		// path-validated on extraction and the image bundle manifest is
		// verified before docker load.
		const meta = yield* readMeta(inputs.artifactDir, inputs.snapshotId);

		// step0 — PRECONDITION: identity guard, FAIL-CLOSED before the FIRST
		//    mutation. Compare the metadata's runtime identity and the merged
		//    plugin-contributed identity; on disagreement restore refuses
		//    HERE, before the swap-tree build's docker load/tag runs (guardrail
		//    §3.2; restore.test sweep/load/tag === [] on mismatch).
		yield* runRuntimeIdentityGuard(
			{ app: meta.app, stack: meta.stack, network: meta.network },
			inputs.runtimeIdentity,
		);
		const liveContributions: IdentityContribution[] = [];
		for (const participant of inputs.participants) {
			const slice = yield* participant.liveIdentity;
			liveContributions.push({ plugin: participant.plugin, slice });
		}
		const live = yield* mergeContributions(liveContributions);
		yield* runIdentityGuard(meta.identity, live);

		// Plugin-level preRestore hooks (run AFTER identity-guard so a
		// mismatch refuses without ever calling them). Pre-restore validation
		// is read-only / soft; the FIRST mutation is still the docker load/tag
		// inside the swap-tree build below.
		for (const participant of inputs.participants) {
			if (participant.preRestore) {
				yield* participant.preRestore.pipe(
					Effect.catch(failPhase('pre-restore-hook', `preRestore failed`, participant.plugin)),
				);
			}
		}

		yield* preflightArtifact(meta, inputs.artifactDir);

		// steps 1 + 2 (R1) — staged file content + docker handoff, inside one
		// `Effect.scoped` that keeps `cleanupRestoreStagingImages` armed across
		// BOTH the swap-tree build phase AND the post-swap docker handoff
		// (promote → remove captured containers). The handoff flag flips only
		// after `removeCapturedContainers` returns, so a mid-handoff failure
		// has the inner scope clean the still-tagged staging refs so Docker is
		// not littered with orphan `devstack-snapshot:restore-*` tags. The
		// post-publish sequence runs under `Effect.uninterruptible` so an outer
		// interrupt cannot arrive mid-handoff and tear the state. No on-disk
		// recovery marker is written: `promoteStagedImages` leaves each image
		// at its captured TARGET name, so R2 (the next acquire's image-match
		// recreate-from-fresh) re-runs the deploy from the local image with no
		// scanner.
		yield* Effect.scoped(
			Effect.gen(function* () {
				const stagedImages: StagedContainerImage[] = [];
				let recoveryHandoffComplete = false;
				yield* Effect.addFinalizer((exit) =>
					Exit.isFailure(exit) && !recoveryHandoffComplete
						? cleanupRestoreStagingImages(inputs.runtime, stagedImages)
						: Effect.void,
				);

				// step1 — fsPlan `swap-tree(untar)`: the build untars the
				//   host-tree + loads/stages the committed image bundle into
				//   staging; the unchanged `stageAndSwap` (assembled by the
				//   executor from the op) publishes it atomically, preserving the
				//   RESTORE preserve list. The build's success value (the staged
				//   refs) is captured via the `stagedImages` closure above, so
				//   the fs-plan result is the empty default — the build value
				//   never threads back through the op vocabulary.
				const swapBuild = Effect.gen(function* () {
					// Untar host-tree into staging.
					if (meta.hostTreeIncluded) {
						yield* restoreHostTree(inputs.artifactDir, inputs.runtimeStagingPath);
					}
					const fs = yield* FileSystem.FileSystem;
					// Confirm each contribution doc is present — the
					// participants' post-restore hooks read fresh state after
					// the swap lands.
					for (const pluginKey of meta.participants) {
						const path = `${inputs.artifactDir}/${contributionPath(pluginKey)}`;
						const exists = yield* fs.exists(path).pipe(Effect.catch(() => Effect.succeed(false)));
						if (!exists) {
							return yield* Effect.fail(
								new RestorePhaseError({
									phase: 'read-contribution',
									plugin: pluginKey,
									detail: `contribution doc absent at ${path}`,
								}),
							);
						}
					}
					// Load + tag committed images under restore-staging refs
					// only after all artifact expansion/copy work has
					// succeeded. The Docker save manifest must match snapshot
					// metadata exactly before docker load mutates the daemon;
					// loaded refs then supply the real digest used for staging
					// tags.
					const expectedTagsByBundle = expectedSnapshotTagsByBundle(meta.containers);
					const loadedRefsBySnapshotTag = new Map<string, ImageRef>();
					for (const [tarPath, expectedTags] of expectedTagsByBundle) {
						const loadedRefs = yield* loadImageBundle(
							tarPath,
							inputs.artifactDir,
							inputs.runtime,
							expectedTags,
						);
						for (const [tag, ref] of loadedRefs) {
							loadedRefsBySnapshotTag.set(tag, ref);
						}
					}
					for (const captured of meta.containers) {
						const loadedRef = loadedRefsBySnapshotTag.get(captured.snapshotTag);
						if (loadedRef === undefined) {
							return yield* failRestore(
								'load-image',
								`container image bundle did not return loaded ref for ${captured.snapshotTag}`,
								captured.plugin,
							);
						}
						yield* stageLoadedImage(captured, loadedRef, inputs.runtime, (image) =>
							Effect.sync(() => {
								stagedImages.push(image);
							}),
						);
					}
					return stagedImages;
				});

				const swapTree: ReconcileFsOp<RestorePhaseError | StageAndSwapError> = {
					op: 'swap-tree',
					build: 'untar-artifact',
					targetPath: inputs.runtimeStackRoot,
					stagingPath: inputs.runtimeStagingPath,
					backupPath: inputs.runtimeBackupPath,
					buildEffect: swapBuild,
					// RESTORE-DIRECTION preserve constant — per-namespace live
					// cache + control files, NOT wipe's wholesale predicate
					// (guardrail §3.1/§3.3).
					preserveFromTarget: LIVE_RESTORE_PRESERVED_PATHS,
					publishLockPath: runtimeControlLockPathForStackRoot(inputs.runtimeStackRoot),
					// Identity pass-through — restore keeps `StageAndSwapError`
					// in its own public signature (behavior-preserving), so the
					// executor never invents an error tag for it.
					onSwapError: (cause) => Effect.fail(cause),
				};

				yield* executeFsPlan<RestorePhaseError | StageAndSwapError>({ ops: [swapTree] });

				// step2 R1 — HARD container removal (target = absent, label
				//   scope, policy-INDEPENDENT, unconditional, claim-bypassing)
				//   via `removeManagedContainers`, plus the swap step's docker
				//   tail (promote staged images to their captured TARGET names).
				//   Inside the staging-cleanup scope, uninterruptible so an
				//   outer interrupt cannot tear the handoff between promote and
				//   container removal. Each promoted image is left at its
				//   captured TARGET name, so R2 (the next acquire's image-match
				//   recreate-from-fresh) re-runs the deploy from the local image
				//   — no recovery marker, no scanner. R1 is STRICTLY before R2
				//   (R2 runs in the caller's converge after `runRestore`
				//   returns), and is NEVER expressed as
				//   flip-image-and-let-decideRunAction-recreate (guardrail §3.6).
				if (stagedImages.length > 0) {
					yield* Effect.uninterruptible(
						Effect.gen(function* () {
							yield* promoteStagedImages(stagedImages, inputs.runtime);
							yield* removeCapturedContainers(meta, inputs.runtime, inputs.runtimeIdentity);
							recoveryHandoffComplete = true;
						}),
					);
				} else {
					recoveryHandoffComplete = true;
				}
			}),
		);

		// Post-restore hooks (after the swap lands so plugins read
		//    fresh state from the runtime root).
		for (const participant of inputs.participants) {
			if (participant.postRestore) {
				yield* participant.postRestore.pipe(
					Effect.catch(failPhase('post-restore-hook', `postRestore failed`, participant.plugin)),
				);
			}
		}

		return meta;
	}).pipe(Effect.withSpan('orchestrator.snapshot.restore'));
