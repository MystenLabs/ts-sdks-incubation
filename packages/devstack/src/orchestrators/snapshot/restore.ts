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
	deployCacheSubtreeRelPaths,
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
import {
	makeTarReaderState,
	processTarChunk,
	finishTarReader,
	skipEntry,
	stopScan,
	type TarEntry,
} from '../../substrate/runtime/tar/reader.ts';
import { makePhaseFailer } from './phase-error.ts';
import {
	mergeContributions,
	requireIdentity,
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
import { verifyArtifactIntegrity } from './integrity.ts';
import { clearRestoreSentinel, writeRestoreSentinel } from './interrupted-restore.ts';
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
			'cache-missing',
			'pre-restore-hook',
			'untar-host-tree',
			'load-image',
			'retag-image',
			'post-restore-hook',
			'pre-cleanup',
			'resume',
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
	});

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
	});

// -----------------------------------------------------------------------------
// Post-publish Docker image finalization.
// -----------------------------------------------------------------------------
//
// After the atomic swap, each staged image is re-tagged to its
// captured target name (`promoteStagedImages`) and the original
// captured containers are removed. The IMAGE resumption contract needs
// no scanner: the staged image is left at its TARGET name, so on the
// next boot the supervisor's image-match adoption (`decideRunAction` in
// `runtime/docker/container.ts`) finds the image locally by name and
// `docker run`s it without scanning or re-tagging — the resumption
// contract is carried by the image name itself.
//
// The one gap the image-name contract does NOT cover is a hard kill
// (SIGKILL / power-loss) landing BETWEEN the atomic swap and the end of
// this promotion+removal handoff: the swap published a new tree but the
// images are only PARTIALLY promoted, and `Effect.uninterruptible` does
// not survive a SIGKILL so the cleanup finalizer never runs. The
// interrupted-restore sentinel (`interrupted-restore.ts`) closes exactly
// that gap — it rides the swap into the live root and is cleared the
// instant this handoff completes, so the next boot's
// `recoverInterruptedRestore` resumes a still-pending one and a clean
// restore leaves nothing behind.

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
	});

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
	});

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
	});

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
	});

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
	});

const LIVE_RESTORE_PRESERVED_PATHS: ReadonlyArray<StageAndSwapPreservedPath> = [
	{ relativePath: SNAPSHOTS_DIR_NAME },
	{ relativePath: COMMAND_CHANNEL_COMMANDS_FILE_NAME },
	{ relativePath: COMMAND_CHANNEL_EVENTS_FILE_NAME },
	{ relativePath: 'roster.json' },
	{ relativePath: 'container-claims.json' },
	// Deploy/mint caches (DEPLOY_CACHE_NAMESPACES) are DELIBERATELY ABSENT from
	// this preserve list. The snapshot's host-tree tar now CARRIES `cache/<ns>`
	// (see `deployCacheSubtreeRelPaths` in descriptor.ts + capture's gather), so
	// the restore untars the snapshot's cache into the swapped tree — that copy
	// is the SOLE source on restore (no preserve-from-live, so no double-store
	// drift). On a same-machine rollback the snapshot's (older) ids are the
	// correct rollback target; on a CROSS-MACHINE restore (a fresh runner with an
	// empty live cache) the snapshot populates the cache from nothing. Either way
	// the post-restore boot REUSES the deploy rather than re-running it with fresh
	// ids (which would orphan every pre-snapshot object). The generic per-call
	// `cache/entry` is not a deploy namespace and is not captured, so it stays
	// dropped on restore (restore.test.ts pins that rollback); a hard reset that
	// wipes the live cache after restore re-deploys with fresh ids, surfaced LOUD
	// by the matrix probe's fail-loud assertion.
];

// -----------------------------------------------------------------------------
// Cache-existence preflight — fail-closed BEFORE any mutation.
// -----------------------------------------------------------------------------

/** The deploy-cache subtree relPaths (`cache/<ns>`) the snapshot RECORDS as
 *  captured in its metadata. Capture tars a namespace only if it existed on disk
 *  (`missingTolerance: 'fine'`) and writes `meta.subtrees` AFTER a successful
 *  tar, so a relPath here means "this snapshot intended to carry this cache
 *  namespace". A disabled-plugin namespace (e.g. `cache/deepbook` in a
 *  deepbook-less stack) is simply absent from the list, so the preflight never
 *  over-requires it. */
const recordedDeployCacheRelPaths = (meta: SnapshotMetadata): ReadonlyArray<string> => {
	const expected = new Set(deployCacheSubtreeRelPaths(CACHE_DIR_NAME));
	const recorded: string[] = [];
	for (const subtree of meta.subtrees) {
		if (expected.has(subtree.relPath)) recorded.push(subtree.relPath);
	}
	return recorded;
};

/** Stream the host-tree tar and collect which of `expectedRelPaths` physically
 *  appear as an entry prefix. An entry path `cache/<ns>/<chain>/<hash>.json`
 *  (or the bare `cache/<ns>/` directory) marks `cache/<ns>` present. Read-only:
 *  bodies are skipped, never buffered. */
const scanHostTreeCacheRelPaths = (
	artifactDir: string,
	expectedRelPaths: ReadonlyArray<string>,
): Effect.Effect<ReadonlySet<string>, RestorePhaseError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const tarPath = `${artifactDir}/${SnapshotLayout.hostTreeTar}`;
		const present = new Set<string>();
		const state = makeTarReaderState();
		const matchEntry = (entryPath: string): void => {
			for (const rel of expectedRelPaths) {
				if (present.has(rel)) continue;
				if (entryPath === rel || entryPath.startsWith(`${rel}/`)) present.add(rel);
			}
		};
		const hooks = {
			onEntry: (entry: TarEntry) => {
				matchEntry(entry.path);
				// Stop as soon as every expected namespace is found — the host-tree
				// tar can be large (walrus blobs, the seal vault), and capture tars
				// the deploy cache FIRST, so the answer settles in the leading
				// entries. `stopScan` flips `state.stopped`; the `takeWhile` below
				// then halts the stream so the trailing blob bytes are never read.
				return present.size === expectedRelPaths.length ? stopScan() : skipEntry();
			},
			onExtendedError: (detail: string): RestorePhaseError =>
				new RestorePhaseError({ phase: 'cache-missing', detail }),
		} as const;
		const tarStream = fs.stream(tarPath).pipe(
			Stream.mapError(
				(cause): RestorePhaseError =>
					new RestorePhaseError({
						phase: 'cache-missing',
						detail: `read host-tree tar failed at ${tarPath}`,
						cause,
					}),
			),
			// Stop pulling chunks once the reader signalled `stop` (all namespaces
			// found) — genuinely terminates the disk read, not just the parse.
			Stream.takeWhile(() => !state.stopped),
		);
		yield* Stream.runForEach(tarStream, (chunk) => {
			const error = processTarChunk(state, chunk, hooks);
			return error === null ? Effect.void : Effect.fail(error);
		});
		const finalError = finishTarReader(
			state,
			(detail): RestorePhaseError => new RestorePhaseError({ phase: 'cache-missing', detail }),
		);
		if (finalError !== null) return yield* Effect.fail(finalError);
		return present;
	});

/**
 * The SNAPSHOT's host-tree `cache/<DEPLOY_CACHE_NAMESPACES>` is the SOLE source
 * of the on-chain deploy/mint ids on restore (capture tars `cache/<ns>` into the
 * artifact; restore untars it and does NOT preserve-from-live — see
 * LIVE_RESTORE_PRESERVED_PATHS). So the cache check is against the SNAPSHOT, not
 * the live stack — which is exactly what makes a CROSS-MACHINE restore work: a
 * fresh runner has an empty live cache, and the snapshot supplies the ids.
 *
 * Refuse (fail-closed, BEFORE any mutation, matching the identity-guard posture)
 * if the snapshot's cache is NOT self-contained: every deploy-cache namespace
 * the metadata RECORDS as captured must be physically present in the host-tree
 * tar. A partial loss (metadata claims `cache/<ns>` but the tar lacks it — a
 * corrupted/tampered artifact) would let the post-restore boot re-deploy that
 * namespace with FRESH ids and orphan its pre-snapshot objects. Requiring ALL
 * recorded namespaces (not just ANY one) is the FIX over the prior "any one dir
 * present" check, which passed a partial cache and re-minted the rest.
 *
 * A snapshot that records NO deploy-cache subtrees (a genuine pre-deploy /
 * empty-stack capture) has nothing to verify and passes — there are no minted
 * ids to lose. The matrix's hard-reset phase asserts the loud re-deploy on a
 * post-restore live-cache wipe.
 */
const requireSnapshotDeployCache = (
	meta: SnapshotMetadata,
	artifactDir: string,
): Effect.Effect<void, RestorePhaseError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const recorded = recordedDeployCacheRelPaths(meta);
		if (recorded.length === 0) return;
		if (!meta.hostTreeIncluded) {
			return yield* failRestore(
				'cache-missing',
				`snapshot metadata records deploy-cache subtrees (${recorded.join(', ')}) but the ` +
					`artifact carries no host-tree tar. The snapshot's cache is the SOLE source of the ` +
					`on-chain deploy/mint ids restore reuses; restoring without it would let the next boot ` +
					`re-deploy with FRESH ids and orphan every pre-snapshot object. Refusing.`,
			);
		}
		const present = yield* scanHostTreeCacheRelPaths(artifactDir, recorded);
		const missing = recorded.filter((rel) => !present.has(rel));
		if (missing.length > 0) {
			return yield* failRestore(
				'cache-missing',
				`snapshot host-tree is missing deploy-cache namespaces it recorded as captured ` +
					`(${missing.join(', ')}). The snapshot's cache is the SOLE source of the on-chain ` +
					`deploy/mint ids restore reuses; a partial cache would let the next boot re-deploy the ` +
					`missing namespaces with FRESH ids and orphan their pre-snapshot objects. Refusing.`,
			);
		}
	});

// -----------------------------------------------------------------------------
// Top-level restore — bracketed-atomic via stage-and-swap.
// -----------------------------------------------------------------------------

export interface RestoreInputs {
	readonly snapshotId: SnapshotId;
	readonly artifactDir: string;
	readonly runtimeStackRoot: string;
	readonly runtimeStagingPath: string;
	readonly runtimeBackupPath: string;
	/** Live-stack participants whose `liveIdentity` probes feed the
	 *  cross-plugin CONTRIBUTION guard (`runIdentityGuard`). An EMPTY list
	 *  means "no live stack to compare against" — the boot-time / offline
	 *  restore case (warm boot, interrupted-restore recovery, the offline
	 *  CLI verb, the live supervisor's own first acquire). In that case the
	 *  contribution guard is satisfied tautologically (there is nothing live
	 *  to disagree with the snapshot's recorded identity) and is SKIPPED;
	 *  the snapshot-side emptiness refusal (`requireIdentity`) and the
	 *  runtime guard (`runRuntimeIdentityGuard`, app/stack/network) STILL
	 *  fire. See the step0 body for the rationale. */
	readonly participants: ReadonlyArray<RestoreParticipant>;
	readonly runtime: ContainerRuntime;
	readonly runtimeIdentity: SnapshotRuntimeIdentity;
	// RESUME is intentionally NOT a field here. `runRestore` performs the
	// destructive swap+load+hard-rm UNDER `stack.lock` (held by the caller).
	// The resume re-converges the stack, and each plugin's re-acquire takes
	// `stack.lock` for its container claim — a non-reentrant O_EXCL lock — so
	// running the resume inside this function (under the lock) self-deadlocks.
	// The orchestrator (`service.ts`) therefore runs the injected resume AFTER
	// the lock scope closes; `runRestore` owns only the locked half of the
	// bounce. NEVER `docker start` — the resume is recreate-from-restored-image.
}

/**
 * Run the full restore. Routed through the unified reconcile as an
 * ORDERED 4-step body — restore is NOT a single converge target
 * but a destructive ordered pair around an fs swap:
 *
 *   step0  — PRECONDITION: identity-guard, FAIL-CLOSED BEFORE ANY MUTATION.
 *            The runtime-identity guard + merged plugin-contribution guard
 *            complete BEFORE the first mutation (the docker load/tag inside
 *            the swap-tree build). On mismatch the sweep / load / tag spies
 *            stay EMPTY — zero mutations (restore.test `:214/:263`). Keep
 *            the pure meta read → guard → only then mutate ordering.
 *   step1  — fsPlan `swap-tree(untar)`: a single-op `ReconcileFsPlan` run
 *            through `executeFsPlan`, which publishes the new tree via the
 *            UNCHANGED `stageAndSwap`. The build untars the host-tree +
 *            loads/stages the committed image bundle into staging; the
 *            atomic swap preserves the RESTORE preserve list
 *            (`LIVE_RESTORE_PRESERVED_PATHS` — per-namespace live cache +
 *            control files, a restore-direction constant, NOT wipe's
 *            wholesale predicate). Promote staged
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
 * observe a half-restored tree. The caller holds `stack.lock` for the
 * bounded snapshot window; restore supplies the runtime-control publish lock
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
		// Authoritative meta read (PURE — no mutation), then re-verify the
		// artifact's per-file SHA-256 integrity before any mutation. The
		// artifact is being RESTORED here, so `integrity.json` is re-hashed
		// and compared file-by-file: a missing record fails at
		// `read-integrity`, a hash/file-list disagreement at
		// `verify-integrity` — both fail-closed before the host-tree untar,
		// docker load, or container replacement.
		const meta = yield* readMeta(inputs.artifactDir, inputs.snapshotId);
		yield* verifyIntegrity(inputs.artifactDir);

		// step0 — PRECONDITION: identity guard, FAIL-CLOSED before the FIRST
		//    mutation. Compare the metadata's runtime identity and the merged
		//    plugin-contributed identity; on disagreement restore refuses
		//    HERE, before the swap-tree build's docker load/tag runs (guardrail
		//    §3.2; restore.test sweep/load/tag === [] on mismatch).
		//
		//    The RUNTIME guard (app/stack/network) ALWAYS fires — its `live`
		//    side is `inputs.runtimeIdentity`, sourced from the live process's
		//    `IdentityContext`, never from the snapshot — so a boot against a
		//    foreign app/stack/network still refuses.
		yield* runRuntimeIdentityGuard(
			{ app: meta.app, stack: meta.stack, network: meta.network },
			inputs.runtimeIdentity,
		);
		// The cross-plugin CONTRIBUTION guard is conditional on there being a
		// LIVE stack to compare against. A boot-time / offline restore (warm
		// boot, interrupted-restore recovery, the offline CLI verb, the live
		// supervisor's own initial acquire) runs with `participants === []`:
		// the supervisor has not yet registered any snapshot participant, so
		// there is no live identity to contribute. Running `runIdentityGuard`
		// against an empty live slice would ALWAYS fail `IdentityMissingLive`
		// (the snapshot recorded a key live did not contribute) — which is the
		// bug that silently degraded `--warm` to cold and wedged the
		// interrupted-restore recovery forever. With no live stack the
		// comparison is vacuously satisfied (synthesizing the live slice FROM
		// the snapshot's own recorded identity — what the offline CLI used to
		// do explicitly — compares meta.identity against itself), so SKIP it.
		// The snapshot-side emptiness refusal still fires: a snapshot that
		// recorded NO identity is untrusted regardless of a live stack.
		if (inputs.participants.length === 0) {
			yield* requireIdentity(meta.identity, 'snapshot');
		} else {
			const liveContributions: IdentityContribution[] = [];
			for (const participant of inputs.participants) {
				const slice = yield* participant.liveIdentity;
				liveContributions.push({ plugin: participant.plugin, slice });
			}
			const live = yield* mergeContributions(liveContributions);
			yield* runIdentityGuard(meta.identity, live);
		}

		// step0b — cache-existence preflight, ALSO fail-closed before any
		//    mutation. The SNAPSHOT's host-tree cache is the SOLE source of the
		//    on-chain ids restore reuses (capture tars it; restore untars it and
		//    does NOT preserve-from-live). Refuse (`cache-missing`) if the
		//    snapshot is not self-contained — any recorded deploy-cache namespace
		//    missing from the tar — rather than let the next boot re-deploy that
		//    namespace with fresh ids. Checked against the SNAPSHOT (not the live
		//    stack), so a cross-machine restore onto an empty live cache passes.
		yield* requireSnapshotDeployCache(meta, inputs.artifactDir);

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
		// Effect-level interrupt cannot arrive mid-handoff and tear the state.
		// `promoteStagedImages` leaves each image at its captured TARGET name,
		// so R2 (the next acquire's image-match recreate-from-fresh) re-runs the
		// deploy from the local image with no scanner. `Effect.uninterruptible`
		// does NOT survive a SIGKILL, though — the interrupted-restore sentinel
		// (written into the staged tree, riding the swap into the live root, and
		// cleared the instant this handoff completes) is the durable breadcrumb
		// that lets the next boot resume a hard-kill-mid-promotion.
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
					// Write the interrupted-restore sentinel into the STAGED tree
					// root so it RIDES the atomic stage-and-swap into the live
					// runtime root (the swap is a `rename(staging → stackRoot)`, so
					// the sentinel is published atomically WITH the new tree — there
					// is no pre-swap window where it could be observed early or lost).
					// The clear on the success path below removes it the instant the
					// promotion+removal handoff completes; a hard kill AFTER the swap
					// but mid-promotion leaves it live for the next boot's
					// `recoverInterruptedRestore` to resume. Best-effort: a write
					// failure is logged, not fatal (it only widens the already-
					// existing unrecoverable window).
					yield* writeRestoreSentinel(inputs.runtimeStagingPath, {
						snapshotId: inputs.snapshotId,
						artifactDir: inputs.artifactDir,
					});
					return stagedImages;
				});

				const swapTree: ReconcileFsOp<RestorePhaseError | StageAndSwapError> = {
					op: 'swap-tree',
					targetPath: inputs.runtimeStackRoot,
					stagingPath: inputs.runtimeStagingPath,
					backupPath: inputs.runtimeBackupPath,
					buildEffect: swapBuild,
					// RESTORE-DIRECTION preserve constant — per-namespace live
					// cache + control files, NOT wipe's wholesale predicate.
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
				//   — no scanner. R1 is STRICTLY before R2 (R2 runs in the
				//   caller's converge after `runRestore` returns), and is NEVER
				//   expressed as flip-image-and-let-decideRunAction-recreate.
				//   The interrupted-restore sentinel (written into the staged tree
				//   above, now live after the swap) is the durable breadcrumb a
				//   hard kill BETWEEN the swap and this handoff completing leaves
				//   behind; it is cleared the instant the handoff finishes below.
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

				// Success path: the promotion+removal handoff is complete, so the
				// interrupted-restore sentinel has served its purpose — clear it
				// from the LIVE runtime root (it rode the swap in) so the next boot
				// reads no sentinel and never loops. A hard kill that lands AFTER
				// `recoveryHandoffComplete = true` but BEFORE this clear is benign:
				// re-running the restore on the next boot is idempotent (re-stages
				// from the preserved artifact, re-promotes to the same TARGET
				// names, re-removes the already-absent containers), then clears the
				// sentinel. Idempotent (`force: true`), best-effort.
				yield* clearRestoreSentinel(inputs.runtimeStackRoot);
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

		// RESUME = recreate-from-restored-image + wait-write-ready. The R1
		// hard-rm above made the containers facts:null → the resume's converge
		// sees them missing and recreates fresh from the restored images (whose
		// names were re-tagged to the captured TARGET names), inheriting walrus's
		// write-ready ready-gate. The resume is NOT run here: it must execute with
		// `stack.lock` RELEASED (its per-plugin container claims re-take the lock),
		// so the orchestrator (`service.ts`) runs the injected resume AFTER this
		// function's lock scope closes. OMITTED entirely on the offline restore
		// (the next boot is the resume). NEVER `docker start`.

		return meta;
	});
