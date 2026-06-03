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
	makePendingMarkerDocument,
	pendingMarkerPath,
	RestorePendingMarkerIoError,
	removePendingMarker as removePendingMarkerIo,
	rewritePendingMarkerContainers,
	writePendingMarker as writePendingMarkerIo,
	RESTORE_PENDING_FILE_NAME,
	RestorePendingDocumentSchema,
	SNAPSHOT_RESTORE_PENDING_VERSION,
	type RestorePendingContainer,
	type RestorePendingDocument,
} from './pending-marker.ts';
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
import { verifyArtifactIntegrity } from './integrity.ts';
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
	stageAndSwap,
	type StageAndSwapError,
	type StageAndSwapPreservedPath,
} from '../../substrate/runtime/stage-and-swap/index.ts';
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
			'read-integrity',
			'verify-integrity',
			'preflight',
			'pre-restore-hook',
			'untar-host-tree',
			'load-image',
			'retag-image',
			'post-restore-hook',
			'pre-cleanup',
			'write-restore-pending',
			'read-restore-pending',
			'clear-restore-pending',
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

const verifyIntegrity = (
	artifactDir: string,
): Effect.Effect<void, RestorePhaseError, FileSystem.FileSystem> =>
	verifyArtifactIntegrity(artifactDir).pipe(
		Effect.catchTag('SnapshotIntegrityError', (err) =>
			Effect.fail(
				new RestorePhaseError({
					phase: err.kind === 'missing' ? 'read-integrity' : 'verify-integrity',
					detail: err.detail,
					cause: err.cause,
				}),
			),
		),
	);

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
// Post-publish Docker finalization recovery marker.
// -----------------------------------------------------------------------------
//
// Recovery contract: see `pending-marker.ts` and `recover-pending.ts`.
// Restore writes the marker BEFORE the atomic swap, rewrites it after
// each successful promote in `promoteStagedImages` so a mid-loop
// crash leaves the marker reflecting exactly which images still need
// retagging, and clears it once every entry has been promoted. The
// supervise startup hook re-runs the recovery scanner before any
// plugin acquire.

// Re-export the marker shapes restored from the dedicated module so
// downstream tests + the recovery scanner continue to import from
// the snapshot orchestrator barrel.
export {
	RESTORE_PENDING_FILE_NAME,
	RestorePendingDocumentSchema,
	SNAPSHOT_RESTORE_PENDING_VERSION,
	type RestorePendingDocument,
};

interface StagedContainerImage {
	readonly captured: CapturedContainer;
	readonly stagedRef: ImageRef;
	readonly stagedImageTag: string;
}

const stagedImageToPendingEntry = (image: StagedContainerImage): RestorePendingContainer => ({
	plugin: image.captured.plugin,
	role: image.captured.role,
	targetImageName: image.captured.imageName,
	stagedImageTag: image.stagedImageTag,
	// The digest is the loaded image's content-addressed identity
	// (carried through `stageLoadedImage` from `loadImageBundle`'s
	// docker-load output). Persisting it in the marker lets the
	// recovery scanner re-tag from the digest as a fallback when both
	// `targetImageName` and `stagedImageTag` have been pruned out of
	// the daemon between crash and restart.
	digest: image.stagedRef.digest,
});

const loadedBundleTags = (bundle: { readonly refs: ReadonlyArray<ImageRef> }): Set<string> => {
	const tags = new Set<string>();
	for (const ref of bundle.refs) {
		if (ref.tag !== undefined) tags.add(ref.tag);
	}
	return tags;
};

const mintRestoreStagingTag = (): string => `devstack-snapshot:restore-${mintRandomSuffix(24)}`;

const mapMarkerIoError =
	(phase: RestorePhaseError['phase']) =>
	(err: RestorePendingMarkerIoError): Effect.Effect<never, RestorePhaseError> =>
		Effect.fail(new RestorePhaseError({ phase, detail: err.detail, cause: err.cause }));

const writeRestorePendingMarker = (args: {
	readonly runtimeRoot: string;
	readonly meta: SnapshotMetadata;
	readonly artifactDir: string;
	readonly stagedImages: ReadonlyArray<StagedContainerImage>;
}): Effect.Effect<void, RestorePhaseError, FileSystem.FileSystem> => {
	if (args.stagedImages.length === 0) return Effect.void;
	const doc = makePendingMarkerDocument({
		meta: args.meta,
		artifactDir: args.artifactDir,
		containers: args.stagedImages.map(stagedImageToPendingEntry),
	});
	return writePendingMarkerIo(args.runtimeRoot, doc).pipe(
		Effect.catchTag(
			'SnapshotRestorePendingMarkerIoError',
			mapMarkerIoError('write-restore-pending'),
		),
	);
};

const rewriteRestorePendingMarker = (
	runtimeRoot: string,
	doc: RestorePendingDocument,
	stillPending: ReadonlyArray<RestorePendingContainer>,
): Effect.Effect<void, RestorePhaseError, FileSystem.FileSystem> =>
	writePendingMarkerIo(runtimeRoot, rewritePendingMarkerContainers(doc, stillPending)).pipe(
		Effect.catchTag(
			'SnapshotRestorePendingMarkerIoError',
			mapMarkerIoError('write-restore-pending'),
		),
	);

const clearRestorePendingMarker = (
	runtimeRoot: string,
): Effect.Effect<void, RestorePhaseError, FileSystem.FileSystem> =>
	removePendingMarkerIo(runtimeRoot).pipe(
		Effect.catchTag(
			'SnapshotRestorePendingMarkerIoError',
			mapMarkerIoError('clear-restore-pending'),
		),
	);

const readRestorePendingMarker = (
	runtimeRoot: string,
): Effect.Effect<RestorePendingDocument | null, RestorePhaseError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = pendingMarkerPath(runtimeRoot);
		const exists = yield* fs.exists(path).pipe(Effect.catch(() => Effect.succeed(false)));
		if (!exists) return null;
		const text = yield* fs
			.readFileString(path)
			.pipe(Effect.catch(failPhase('read-restore-pending', `read ${RESTORE_PENDING_FILE_NAME}`)));
		const raw = yield* parseJsonText(text, {
			source: path,
			mkError: (issue) =>
				new RestorePhaseError({
					phase: 'read-restore-pending',
					detail: `${RESTORE_PENDING_FILE_NAME} is not valid JSON`,
					cause: issue.cause,
				}),
		});
		return yield* decodeUnknown(RestorePendingDocumentSchema, raw, {
			source: path,
			mkError: (issue) =>
				new RestorePhaseError({
					phase: 'read-restore-pending',
					detail: `${RESTORE_PENDING_FILE_NAME} failed schema decode`,
					cause: issue.cause,
				}),
		});
	});

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

/** Promote each staged image to its recorded name, rewriting the
 *  on-disk pending marker after each successful tag. If the loop
 *  fails mid-way the marker reflects exactly which images are still
 *  pending (the failed entry + every entry not yet attempted), so
 *  the supervise-startup `recoverPendingRestore` only has to retry
 *  the remaining set — no scanning Docker for "which targets exist
 *  already?" required. */
const promoteStagedImages = (
	images: ReadonlyArray<StagedContainerImage>,
	runtime: ContainerRuntime,
	runtimeStackRoot: string,
	pendingDoc: RestorePendingDocument | null,
): Effect.Effect<void, RestorePhaseError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		for (let i = 0; i < images.length; i += 1) {
			const image = images[i]!;
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
			// Rewrite the marker with only the still-pending entries
			// (everything we haven't promoted yet). The final entry's
			// rewrite leaves an empty `containers: []` marker on disk;
			// `clearRestorePendingMarker` removes the file shortly
			// after this function returns.
			if (pendingDoc !== null) {
				const stillPending = images.slice(i + 1).map(stagedImageToPendingEntry);
				yield* rewriteRestorePendingMarker(runtimeStackRoot, pendingDoc, stillPending);
			}
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
	// Deploy/mint caches. The snapshot CAPTURES these (DEPLOY_CACHE_NAMESPACES in
	// descriptor.ts, tarred in capture.ts), and that captured copy — untarred into
	// staging, consistent with the restored chain — WINS (`overwrite: false`).
	// This live-side entry is only a FALLBACK: it carries the deploy ids forward
	// when staging doesn't already have them (e.g. a `snapshot → wipe → restore`
	// where the captured copy IS present, or a pre-capture snapshot where it is
	// not). Either way the post-restore boot REUSES the deploy instead of
	// re-running it with fresh ids (which would orphan every pre-snapshot object).
	// The generic per-call `cache/entry` is NOT a deploy namespace and stays
	// dropped (restore.test.ts pins that rollback).
	...DEPLOY_CACHE_NAMESPACES.map(
		(namespace): StageAndSwapPreservedPath => ({
			relativePath: `${CACHE_DIR_NAME}/${namespace}`,
			kind: 'directory',
			// The snapshot-CAPTURED copy (untarred into staging) wins; only fall
			// back to the live copy when staging doesn't carry it (e.g. a snapshot
			// taken before deploy-cache capture existed). Avoids clobbering the
			// snapshot-consistent id with a possibly-drifted live one.
			overwrite: false,
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
 * Run the full restore. Bracketed-atomic via `stageAndSwap` at the
 * runtime-root level — external watchers never observe a half-restored
 * tree.
 *
 * Order:
 *   1. Read meta.json (refuse if absent / corrupt — no mutation).
 *   2. Run identity-guard against runtime metadata and merged plugin
 *      contributions (refuse on any disagreement — no mutation).
 *   3. Pre-restore hooks (per-plugin validation; soft errors).
 *   4. Stage:
 *      - Untar host-tree into staging.
 *      - Re-read contribution docs.
 *      - Load image bundles and stage verified snapshot tags.
 *      - Write a restore-pending marker into the staged root.
 *   5. Atomic swap staging → runtime root, preserving live command /
 *      event channel files and other explicit runtime-control files.
 *   6. Promote staged images to recorded refs, then remove captured
 *      managed containers by label. If this fails, the pending marker
 *      remains in the restored root for diagnosis/recovery.
 *   7. Post-restore hooks.
 *
 * The caller is responsible for `acquireReservation`; restore supplies
 * the runtime-control publish lock to `stageAndSwap`.
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

		// 1. Authoritative meta read.
		const meta = yield* readMeta(inputs.artifactDir, inputs.snapshotId);
		yield* verifyIntegrity(inputs.artifactDir);

		// 2. Identity guard — compare the metadata's runtime identity
		//    and plugin-contributed identity. FAIL-CLOSED before any mutation.
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

		// 3. Plugin-level preRestore hooks (run AFTER identity-guard so
		//    a mismatch refuses without ever calling them).
		for (const participant of inputs.participants) {
			if (participant.preRestore) {
				yield* participant.preRestore.pipe(
					Effect.catch(failPhase('pre-restore-hook', `preRestore failed`, participant.plugin)),
				);
			}
		}

		yield* preflightArtifact(meta, inputs.artifactDir);

		// 4. Stage filesystem content and non-destructive Docker image
		//    refs; atomic swap on success, then promote staged images and
		//    clear the recovery marker. The inner `Effect.scoped` keeps
		//    `cleanupRestoreStagingImages` armed across BOTH the
		//    stage-and-swap build phase AND the post-swap Docker handoff
		//    (promote → remove containers → clear marker). The handoff
		//    flag flips only after `clearRestorePendingMarker` returns,
		//    so a mid-handoff failure (e.g. promotion of image N of M
		//    refuses) leaves the swapped tree carrying the pending
		//    marker (re-supervise can detect the broken handoff) AND
		//    has the inner scope clean the still-tagged staging refs so
		//    Docker is not littered with orphan `devstack-snapshot:restore-*`
		//    tags. The post-publish three-step sequence runs under
		//    `Effect.uninterruptible` so an outer interrupt cannot
		//    arrive between promote and the marker clear and tear the
		//    handoff state.
		yield* Effect.scoped(
			Effect.gen(function* () {
				const stagedImages: StagedContainerImage[] = [];
				let recoveryHandoffComplete = false;
				yield* Effect.addFinalizer((exit) =>
					Exit.isFailure(exit) && !recoveryHandoffComplete
						? cleanupRestoreStagingImages(inputs.runtime, stagedImages)
						: Effect.void,
				);
				yield* stageAndSwap({
					targetPath: inputs.runtimeStackRoot,
					stagingPath: inputs.runtimeStagingPath,
					backupPath: inputs.runtimeBackupPath,
					preserveFromTarget: LIVE_RESTORE_PRESERVED_PATHS,
					publishLockPath: runtimeControlLockPathForStackRoot(inputs.runtimeStackRoot),
					build: Effect.gen(function* () {
						// 4a. Untar host-tree into staging.
						if (meta.hostTreeIncluded) {
							yield* restoreHostTree(inputs.artifactDir, inputs.runtimeStagingPath);
						}
						const fs = yield* FileSystem.FileSystem;
						// 4b. Read each contribution doc — the participants'
						//      post-restore hooks may want this; we surface it
						//      via the participant's own reads after the
						//      the swap lands.
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
						// 4c. Load + tag committed images under restore-staging
						//     refs only after all artifact expansion/copy work
						//     has succeeded. The Docker save manifest must match
						//     snapshot metadata exactly before docker load mutates
						//     the daemon; loaded refs then supply the real digest
						//     used for staging tags.
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
						yield* writeRestorePendingMarker({
							runtimeRoot: inputs.runtimeStagingPath,
							meta,
							artifactDir: inputs.artifactDir,
							stagedImages,
						});
						return stagedImages;
					}),
				});

				// 5. Docker finalization happens after filesystem publish.
				//    Promote → remove captured containers → clear marker, all
				//    inside the staging-cleanup scope. The pending marker
				//    landed in the swapped runtime root as part of the
				//    stage-and-swap; `promoteStagedImages` rewrites it after
				//    each successful tag so a mid-loop crash leaves the
				//    marker reflecting exactly which images still need
				//    retagging — `recoverPendingRestore` on the next
				//    supervise picks up the breadcrumb. Uninterruptible so
				//    an outer interrupt cannot tear the handoff between
				//    promote and `clearRestorePendingMarker`.
				if (stagedImages.length > 0) {
					const pendingDocAfterSwap = yield* readRestorePendingMarker(inputs.runtimeStackRoot);
					yield* Effect.uninterruptible(
						Effect.gen(function* () {
							yield* promoteStagedImages(
								stagedImages,
								inputs.runtime,
								inputs.runtimeStackRoot,
								pendingDocAfterSwap,
							);
							yield* removeCapturedContainers(meta, inputs.runtime, inputs.runtimeIdentity);
							yield* clearRestorePendingMarker(inputs.runtimeStackRoot);
							recoveryHandoffComplete = true;
						}),
					);
				} else {
					recoveryHandoffComplete = true;
				}
			}),
		);

		// 6. Post-restore hooks (after the swap lands so plugins read
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
