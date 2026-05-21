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

import { randomUUID } from 'node:crypto';

import { Effect, FileSystem, Schema, Stream } from 'effect';

import type { ContainerRuntime, ImageRef } from '../../contracts/container-runtime.ts';
import {
	HostTreeTarError,
	untarHostTree,
	validateHostTreeTarEntries,
} from '../../substrate/runtime/host-tree-tar/index.ts';
import {
	ContributionDocSchema,
	contributionPath,
	SnapshotLayout,
	SnapshotMetadataSchema,
	type SnapshotId,
	type CapturedContainer,
	type IdentitySlice,
	type SnapshotMetadata,
	containerImagePath,
	isRestorableContainerImageName,
	isSafeSnapshotPathSegment,
	isSafeSnapshotRelativePath,
	parseSnapshotId,
} from './descriptor.ts';
import { verifyArtifactIntegrity } from './integrity.ts';
import { readSnapshotStateDocument, writeSnapshotStateDocument } from './state-document.ts';
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
import { SNAPSHOTS_DIR_NAME } from './wipe.ts';

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
			'read-state',
			'read-contribution',
			'read-integrity',
			'verify-integrity',
			'preflight',
			'pre-restore-hook',
			'untar-host-tree',
			'load-image',
			'retag-image',
			'expand-state',
			'post-restore-hook',
			'pre-cleanup',
			'write-restore-pending',
			'clear-restore-pending',
			'missing-subtree-fatal',
		]),
		plugin: Schema.optional(Schema.String),
		detail: Schema.String,
		cause: Schema.optional(Schema.Defect),
	},
) {}

const failPhase =
	(
		phase: RestorePhaseError['phase'],
		detail: string,
		plugin?: string,
	): ((cause: unknown) => Effect.Effect<never, RestorePhaseError>) =>
	(cause) =>
		Effect.fail(new RestorePhaseError({ phase, plugin, detail, cause }));

const failRestore = (
	phase: RestorePhaseError['phase'],
	detail: string,
	plugin?: string,
): Effect.Effect<never, RestorePhaseError> =>
	Effect.fail(new RestorePhaseError({ phase, plugin, detail }));

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
		const raw = yield* Effect.try({
			try: () => JSON.parse(text) as unknown,
			catch: (cause) =>
				new RestorePhaseError({
					phase: 'meta-corrupt',
					detail: `meta.json is not valid JSON at ${path}`,
					cause,
				}),
		});
		const meta = yield* Schema.decodeUnknownEffect(SnapshotMetadataSchema)(raw).pipe(
			Effect.catch((cause) =>
				Effect.fail(
					new RestorePhaseError({
						phase: 'meta-corrupt',
						detail: `meta.json failed schema decode at ${path}`,
						cause,
					}),
				),
			),
		);
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
		Effect.catch((cause) =>
			Effect.fail(
				new RestorePhaseError({
					phase:
						cause instanceof Error && cause.message.includes(SnapshotLayout.integrityFile)
							? 'read-integrity'
							: 'verify-integrity',
					detail: cause instanceof Error ? cause.message : `snapshot integrity failed`,
					cause,
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

export const SNAPSHOT_RESTORE_PENDING_VERSION = 1 as const;
export const RESTORE_PENDING_FILE_NAME = 'snapshot.restore-pending.json' as const;

export const RestorePendingDocumentSchema = Schema.Struct({
	version: Schema.Literal(SNAPSHOT_RESTORE_PENDING_VERSION),
	snapshotId: Schema.String,
	artifactDir: Schema.String,
	app: Schema.String,
	stack: Schema.String,
	network: Schema.String,
	containers: Schema.Array(
		Schema.Struct({
			plugin: Schema.String,
			role: Schema.String,
			targetImageName: Schema.String,
			stagedImageTag: Schema.String,
		}),
	),
});
export type RestorePendingDocument = Schema.Schema.Type<typeof RestorePendingDocumentSchema>;

interface StagedContainerImage {
	readonly captured: CapturedContainer;
	readonly stagedRef: ImageRef;
	readonly stagedImageTag: string;
}

const mintRestoreStagingTag = (): string =>
	`devstack-snapshot:restore-${randomUUID().replaceAll('-', '').slice(0, 24)}`;

const writeRestorePendingMarker = (args: {
	readonly runtimeRoot: string;
	readonly meta: SnapshotMetadata;
	readonly artifactDir: string;
	readonly stagedImages: ReadonlyArray<StagedContainerImage>;
}): Effect.Effect<void, RestorePhaseError, FileSystem.FileSystem> => {
	if (args.stagedImages.length === 0) return Effect.void;
	const doc: RestorePendingDocument = {
		version: SNAPSHOT_RESTORE_PENDING_VERSION,
		snapshotId: args.meta.id,
		artifactDir: args.artifactDir,
		app: args.meta.app,
		stack: args.meta.stack,
		network: args.meta.network,
		containers: args.stagedImages.map((image) => ({
			plugin: image.captured.plugin,
			role: image.captured.role,
			targetImageName: image.captured.imageName,
			stagedImageTag: image.stagedImageTag,
		})),
	};
	return Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		yield* fs
			.writeFileString(
				`${args.runtimeRoot}/${RESTORE_PENDING_FILE_NAME}`,
				`${JSON.stringify(doc, null, 2)}\n`,
			)
			.pipe(
				Effect.catch(
					failPhase('write-restore-pending', `write ${RESTORE_PENDING_FILE_NAME} failed`),
				),
			);
	});
};

const clearRestorePendingMarker = (
	runtimeRoot: string,
): Effect.Effect<void, RestorePhaseError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		yield* fs
			.remove(`${runtimeRoot}/${RESTORE_PENDING_FILE_NAME}`, { force: true })
			.pipe(
				Effect.catch(
					failPhase('clear-restore-pending', `remove ${RESTORE_PENDING_FILE_NAME} failed`),
				),
			);
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
		const expectedTarPath = containerImagePath(captured.plugin, captured.role);
		if (captured.tarPath !== expectedTarPath) {
			return yield* failRestore(
				'preflight',
				`container image tar path ${captured.tarPath} does not match canonical ${expectedTarPath}`,
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
		const raw = yield* Effect.try({
			try: () => JSON.parse(text) as unknown,
			catch: (cause) =>
				new RestorePhaseError({
					phase: 'read-contribution',
					plugin: pluginKey,
					detail: `contribution doc is not valid JSON at ${path}`,
					cause,
				}),
		});
		const decoded = yield* Schema.decodeUnknownEffect(ContributionDocSchema)(raw).pipe(
			Effect.catch((cause) =>
				Effect.fail(
					new RestorePhaseError({
						phase: 'read-contribution',
						plugin: pluginKey,
						detail: `contribution doc failed schema decode at ${path}`,
						cause,
					}),
				),
			),
		);
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
		for (const captured of meta.containers) {
			yield* preflightCapturedContainer(captured, artifactDir);
		}
		for (const pluginKey of meta.participants) {
			yield* preflightContributionDoc(pluginKey, artifactDir);
		}
		const statePath = `${artifactDir}/${SnapshotLayout.stateFile}`;
		const stateExists = yield* fs.exists(statePath).pipe(Effect.catch(() => Effect.succeed(false)));
		if (stateExists) {
			yield* readSnapshotStateDocument(statePath).pipe(
				Effect.catch(failPhase('read-state', `state.json failed schema validation`)),
			);
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

const loadAndStageImage = (
	captured: CapturedContainer,
	artifactDir: string,
	runtime: ContainerRuntime,
): Effect.Effect<StagedContainerImage, RestorePhaseError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const tarPath = `${artifactDir}/${captured.tarPath}`;
		const exists = yield* fs.exists(tarPath).pipe(Effect.catch(() => Effect.succeed(false)));
		if (!exists) {
			return yield* Effect.fail(
				new RestorePhaseError({
					phase: 'load-image',
					plugin: captured.plugin,
					detail: `container image tar absent at ${tarPath}`,
				}),
			);
		}
		const loaded = yield* runtime
			.loadImage(fs.stream(tarPath))
			.pipe(
				Effect.catch(
					failPhase('load-image', `load container image from ${tarPath} failed`, captured.plugin),
				),
			);
		const stagedImageTag = mintRestoreStagingTag();
		yield* runtime
			.tagImage(loaded, stagedImageTag, { removeSourceAfterTag: true })
			.pipe(
				Effect.catch(
					failPhase(
						'retag-image',
						`tag restored image ${loaded.tag ?? loaded.digest} as staging ref ${stagedImageTag} failed`,
						captured.plugin,
					),
				),
			);
		return {
			captured,
			stagedRef: { digest: loaded.digest, tag: stagedImageTag },
			stagedImageTag,
		};
	}).pipe(Effect.withSpan('orchestrator.snapshot.restore.stage-image'));

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
 *      - Copy state.json into staging.
 *      - Re-read contribution docs.
 *      - Load committed images under restore-staging Docker refs.
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
		//    refs; atomic swap on success.
		const stagedImages = yield* stageAndSwap({
			targetPath: inputs.runtimeStackRoot,
			stagingPath: inputs.runtimeStagingPath,
			backupPath: inputs.runtimeBackupPath,
			preserveFromTarget: LIVE_RESTORE_PRESERVED_PATHS,
			publishLockPath: runtimeControlLockPathForStackRoot(inputs.runtimeStackRoot),
			build: Effect.gen(function* () {
				const stagedImages: StagedContainerImage[] = [];
				// 4a. Untar host-tree into staging.
				if (meta.hostTreeIncluded) {
					yield* restoreHostTree(inputs.artifactDir, inputs.runtimeStagingPath);
				}
				// 4b. Copy state.json into staging.
				const fs = yield* FileSystem.FileSystem;
				const srcState = `${inputs.artifactDir}/${SnapshotLayout.stateFile}`;
				const stateExists = yield* fs
					.exists(srcState)
					.pipe(Effect.catch(() => Effect.succeed(false)));
				if (stateExists) {
					const stateDoc = yield* readSnapshotStateDocument(srcState).pipe(
						Effect.catch(failPhase('read-state', `state.json failed schema validation`)),
					);
					yield* writeSnapshotStateDocument(
						`${inputs.runtimeStagingPath}/${SnapshotLayout.stateFile}`,
						stateDoc,
					).pipe(Effect.catch(failPhase('expand-state', `write state.json failed`)));
				}
				// 4c. Read each contribution doc — the participants'
				//      post-restore hooks may want this; we surface it
				//      via the participant's own state-store reads after
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
				// 4d. Load + tag committed images under restore-staging
				//     refs only after all artifact expansion/copy work
				//     has succeeded. The live container image refs are
				//     not touched until after filesystem publish.
				for (const captured of meta.containers) {
					stagedImages.push(yield* loadAndStageImage(captured, inputs.artifactDir, inputs.runtime));
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

		// 5. Docker finalization happens after filesystem publish. If
		//    promotion or removal fails, the restored root still carries
		//    snapshot.restore-pending.json with the staged image refs.
		if (stagedImages.length > 0) {
			yield* promoteStagedImages(stagedImages, inputs.runtime);
			yield* removeCapturedContainers(meta, inputs.runtime, inputs.runtimeIdentity);
			yield* clearRestorePendingMarker(inputs.runtimeStackRoot);
		}

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
