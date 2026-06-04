// Capture — the unified lifecycle bounce (capture half).
//
// Capture is a parameterization of the lifecycle bounce, NOT a separate
// subsystem:
//
//   gather (BEFORE stop, plugins live)
//     → graceful-stop all managed containers (FLUSHES RocksDB/WAL → the
//       committed image is faithful — the walrus capture-survival fix; a
//       `docker pause` does NOT flush, which is the original regression)
//     → docker commit each STOPPED container + saveImages + tar host-tree
//       + write contributions + meta.json LAST → publish via stageAndSwap
//     → retag each committed image to the container's ORIGINAL image name +
//       HARD-rm the stopped containers
//     → resume = recreate-from-image + wait-write-ready
//
// The resume is recreate-from-image (NEVER `docker start` — walrus storage
// nodes EXIT on `docker start` after a graceful stop) and waits for
// write-readiness (a recreated node re-syncs its committee/epoch and is not
// write-ready immediately). Both of those live in the LIFECYCLE: the
// orchestrator cannot recreate a container (it has no plugin spec — env,
// mounts, networks), so resume is an INJECTED effect that re-runs the
// plugin acquire (the supervisor's restart / the converge), which goes
// through `startStorageNodes`' strengthened write-ready ready-gate. So
// capture inherits write-readiness exactly like up / restart / restore.
//
// Because capture commits the live state and resumes the same state, it is
// NON-DESTRUCTIVE: the retag aliases each container's original image name
// onto its just-committed writable layer (the flushed RocksDB), so the
// resume's recreate-from-fresh boots the node on its own committed data —
// the same mechanism restore uses with its loaded image bundle.
//
// The orchestrator is name-blind: it walks `Snapshotable` contributions
// without referencing any service. Containers are enumerated via the label
// tuple the participant declared; subtrees via the relative paths declared.
// Identity / contributions are gathered BEFORE the stop because the plugin's
// resolved state is read by live Effects that are gone once scopes close.

import { Duration, Effect, Exit, FileSystem, Schema, Stream } from 'effect';

import type {
	ContainerRuntime,
	ContainerHandle,
	TaggedImageRef,
} from '../../contracts/container-runtime.ts';
import type { ContainerLabelTuple, SnapshotableDecl } from '../../contracts/snapshotable.ts';
import { tarHostTree as streamHostTreeTar } from '../../substrate/runtime/host-tree-tar/index.ts';
import {
	containerImagesBundlePath,
	contributionPath,
	deployCacheSubtreeRelPaths,
	SnapshotLayout,
	type CapturedContainer,
	type CapturedSubtree,
	type ContributionDoc,
	type IdentitySlice,
	type SnapshotMetadata,
	type SnapshotId,
	SNAPSHOT_META_VERSION,
	isRestorableContainerImageName,
	isSafeSnapshotPathSegment,
	SNAPSHOT_CONTRIBUTION_VERSION,
} from './descriptor.ts';
import { CACHE_DIR_NAME } from './wipe.ts';
import {
	ImageBundleTagScanError,
	readImageBundleTags,
	verifyImageBundleTags,
} from './image-bundle-tags.ts';
import { makePhaseFailer } from './phase-error.ts';
import {
	mergeContributions,
	requireIdentity,
	type IdentityContribution,
	type IdentityContributionConflictError,
	type IdentityGuardError,
} from './identity-guard.ts';

/** Synthetic "plugin" key for the orchestrator-owned deploy-cache subtrees.
 *  The cache is per-stack runtime state (not plugin-declared), so the capture
 *  orchestrator injects `cache/<ns>` subtrees under this key rather than
 *  attributing them to any one plugin. Distinct from any real plugin name (the
 *  `__…__` sentinel shape), so it cannot collide with a participant. */
const DEPLOY_CACHE_SUBTREE_PLUGIN = '__deploy-cache__';

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/** Tagged failure during one capture step. `phase` discriminates so
 *  the user-facing message names the failing step. */
export class CapturePhaseError extends Schema.TaggedErrorClass<CapturePhaseError>()(
	'SnapshotCapturePhaseError',
	{
		phase: Schema.Literals([
			'enumerate-containers',
			'stop',
			'commit',
			'save-images',
			'tar-subtree',
			'tar-host-tree',
			'write-contribution',
			'write-meta',
			'retag-image',
			'remove-container',
			'resume',
		]),
		plugin: Schema.optional(Schema.String),
		detail: Schema.String,
		cause: Schema.optional(Schema.Defect),
	},
) {}

// -----------------------------------------------------------------------------
// Participant — what the orchestrator receives from each plugin
// -----------------------------------------------------------------------------

/** Capture-time projection of one `SnapshotableDecl` plus the
 *  contributing plugin's identity. The orchestrator does not see
 *  `SnapshotableDecl` directly — it consumes this normalized shape so
 *  the contribution is closed over the plugin's key (the contract
 *  doesn't carry it; the substrate stamps it at registration time). */
export interface SnapshotParticipant {
	readonly plugin: string;
	readonly decl: SnapshotableDecl;
	/** Identity slice this participant contributes to the guard. Read by a
	 *  LIVE Effect (the plugin's resolved state), so it MUST run during the
	 *  pre-stop gather — it is gone once the bounce stops/recreates. */
	readonly captureIdentity: Effect.Effect<IdentitySlice>;
	/** Opaque JSON metadata the plugin wants snapshotted. The
	 *  contribution document validates only an envelope around this
	 *  payload; the orchestrator never relies on the payload shape. */
	readonly captureContribution: Effect.Effect<unknown>;
}

// -----------------------------------------------------------------------------
// Staging — populate a directory; the caller wraps in stage-and-swap.
// -----------------------------------------------------------------------------

const failPhase = makePhaseFailer(CapturePhaseError);

const failImageBundleTagScan = (
	cause: ImageBundleTagScanError,
): Effect.Effect<never, CapturePhaseError> =>
	Effect.fail(new CapturePhaseError({ phase: 'save-images', detail: cause.detail, cause }));

interface EnumeratedContainer {
	readonly handle: ContainerHandle;
	readonly labels: ContainerLabelTuple;
}

interface PlannedContainerCapture extends EnumeratedContainer {
	readonly plugin: string;
}

interface CommittedContainerCapture {
	readonly captured: CapturedContainer;
	readonly imageRef: TaggedImageRef;
}

const validateSnapshotPathSegment = (
	kind: string,
	value: string,
	phase: CapturePhaseError['phase'],
	plugin?: string,
): Effect.Effect<void, CapturePhaseError> =>
	isSafeSnapshotPathSegment(value)
		? Effect.void
		: Effect.fail(
				new CapturePhaseError({
					phase,
					plugin,
					detail: `unsafe snapshot ${kind} path segment: ${value}`,
				}),
			);

const validateCapturedContainer = (
	handle: ContainerHandle,
	labels: ContainerLabelTuple,
	plugin: string,
): Effect.Effect<void, CapturePhaseError> =>
	Effect.gen(function* () {
		yield* validateSnapshotPathSegment('plugin', labels.plugin, 'commit', plugin);
		yield* validateSnapshotPathSegment('role', labels.role, 'commit', plugin);
		if (!isRestorableContainerImageName(handle.imageName)) {
			return yield* Effect.fail(
				new CapturePhaseError({
					phase: 'commit',
					plugin,
					detail: `container ${handle.name} imageName is not a restorable Docker tag destination: ${handle.imageName}`,
				}),
			);
		}
	});

const detectContainerArtifactCollisions = (
	planned: ReadonlyArray<PlannedContainerCapture>,
): Effect.Effect<void, CapturePhaseError> =>
	Effect.gen(function* () {
		const seen = new Map<string, PlannedContainerCapture>();
		for (const candidate of planned) {
			const key = `${candidate.labels.plugin}/${candidate.labels.role}`;
			const previous = seen.get(key);
			if (previous !== undefined) {
				return yield* Effect.fail(
					new CapturePhaseError({
						phase: 'commit',
						plugin: candidate.plugin,
						detail: `duplicate managed container snapshot identity ${key} for ${previous.handle.name} and ${candidate.handle.name}`,
					}),
				);
			}
			seen.set(key, candidate);
		}
	});

/** Enumerate a participant's live managed containers by its declared
 *  label tuples. `inspectByLabels` matches running AND stopped/created
 *  containers (`docker ps -a`). */
const enumerateParticipantContainers = (
	plugin: string,
	labelTuples: ReadonlyArray<ContainerLabelTuple>,
	runtime: ContainerRuntime,
): Effect.Effect<ReadonlyArray<EnumeratedContainer>, CapturePhaseError> =>
	Effect.gen(function* () {
		const containers: EnumeratedContainer[] = [];
		for (const tuple of labelTuples) {
			const matched = yield* runtime
				.inspectByLabels(tuple)
				.pipe(
					Effect.catch(
						failPhase(
							'enumerate-containers',
							`inspect by labels failed for ${tuple.plugin}/${tuple.role}`,
							plugin,
						),
					),
				);
			for (const handle of matched) {
				containers.push({ handle, labels: tuple });
			}
		}
		return containers;
	}).pipe(Effect.withSpan('orchestrator.snapshot.capture.enumerate'));

/** Commit one STOPPED container's writable layer to a temporary snapshot
 *  image tag. The container has already been gracefully stopped (RocksDB
 *  flushed), so this commits the faithful flushed layer. */
const commitStoppedContainer = (
	handle: ContainerHandle,
	labels: ContainerLabelTuple,
	runtime: ContainerRuntime,
	plugin: string,
	registerCommittedRef: (ref: TaggedImageRef) => Effect.Effect<void>,
): Effect.Effect<CommittedContainerCapture, CapturePhaseError> =>
	Effect.gen(function* () {
		// The container is stopped (`exited`), so `pauseAndCommit` skips its
		// pause branch and commits the already-quiescent, already-flushed
		// writable layer as-is.
		const stoppedHandle: ContainerHandle = { ...handle, status: 'exited' };
		const imageRef = yield* runtime
			.pauseAndCommit(stoppedHandle)
			.pipe(
				Effect.catch(failPhase('commit', `commit failed for ${handle.name}`, plugin)),
			);
		const snapshotTag = imageRef.tag;
		yield* registerCommittedRef(imageRef);
		if (!isRestorableContainerImageName(snapshotTag)) {
			return yield* Effect.fail(
				new CapturePhaseError({
					phase: 'commit',
					plugin,
					detail: `committed image for ${handle.name} did not receive a restorable snapshot tag`,
				}),
			);
		}
		return {
			captured: {
				plugin: labels.plugin,
				role: labels.role,
				imageName: handle.imageName,
				snapshotTag,
				tarPath: containerImagesBundlePath(),
			},
			imageRef,
		};
	}).pipe(Effect.withSpan('orchestrator.snapshot.capture.commit'));

const saveCommittedImages = (
	committed: ReadonlyArray<CommittedContainerCapture>,
	stagingDir: string,
	runtime: ContainerRuntime,
): Effect.Effect<void, CapturePhaseError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		if (committed.length === 0) return;
		const fs = yield* FileSystem.FileSystem;
		const tarPath = containerImagesBundlePath();
		const tarDest = `${stagingDir}/${tarPath}`;
		yield* fs
			.makeDirectory(`${stagingDir}/${SnapshotLayout.containersDir}`, { recursive: true })
			.pipe(Effect.catch(failPhase('save-images', `mkdir containers dir failed`)));
		// `removeAfterSave: false` — the committed temp tags are retained so
		// the post-publish step can retag each onto its original image name
		// (the capture-resume alias). A capture-failure finalizer cleans them.
		yield* Stream.run(
			runtime.saveImages(
				committed.map((entry) => entry.imageRef),
				{ removeAfterSave: false },
			),
			fs.sink(tarDest),
		).pipe(
			Effect.catch(
				failPhase(
					'save-images',
					`save ${committed.length} committed container images to ${tarDest} failed`,
				),
			),
		);
		const savedTags = yield* readImageBundleTags(tarDest, tarPath).pipe(
			Effect.catch(failImageBundleTagScan),
		);
		yield* verifyImageBundleTags(
			tarPath,
			savedTags,
			committed.map((entry) => entry.captured.snapshotTag),
		).pipe(Effect.catch(failImageBundleTagScan));
	}).pipe(Effect.withSpan('orchestrator.snapshot.capture.save-images'));

const cleanupCommittedRefs = (
	runtime: ContainerRuntime,
	refs: ReadonlyArray<TaggedImageRef>,
): Effect.Effect<void> =>
	Effect.forEach(
		refs,
		(ref) =>
			runtime
				.removeImage(ref)
				.pipe(
					Effect.catch((cause) =>
						Effect.logWarning(
							`remove committed snapshot image ${ref.tag} failed during capture cleanup: ${String(
								cause,
							)}`,
						),
					),
				),
		{ concurrency: 'unbounded' },
	).pipe(Effect.asVoid);

const isSafeSubtreePath = (relPath: string): boolean =>
	relPath !== '' &&
	relPath !== '.' &&
	!relPath.startsWith('/') &&
	!relPath.split(/[\\/]+/).includes('..');

/** Resolve declared subtrees against the live stack root. Missing
 *  `fine` subtrees are skipped; missing `fatal` subtrees fail before
 *  tar starts so the error names the responsible plugin. */
const resolveCapturedSubtrees = (
	subtrees: ReadonlyArray<CapturedSubtree>,
	stackRoot: string,
): Effect.Effect<ReadonlyArray<CapturedSubtree>, CapturePhaseError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const captured: CapturedSubtree[] = [];
		for (const subtree of subtrees) {
			if (!isSafeSubtreePath(subtree.relPath)) {
				return yield* Effect.fail(
					new CapturePhaseError({
						phase: 'tar-subtree',
						plugin: subtree.plugin,
						detail: `unsafe snapshot subtree path: ${subtree.relPath}`,
					}),
				);
			}
			const exists = yield* fs
				.exists(`${stackRoot}/${subtree.relPath}`)
				.pipe(Effect.catch(() => Effect.succeed(false)));
			if (!exists) {
				if (subtree.missingTolerance === 'fatal') {
					return yield* Effect.fail(
						new CapturePhaseError({
							phase: 'tar-subtree',
							plugin: subtree.plugin,
							detail: `required snapshot subtree missing: ${subtree.relPath}`,
						}),
					);
				}
				continue;
			}
			captured.push(subtree);
		}
		return captured;
	});

/** Tar the union of declared live subtrees into one `host-tree.tar`. */
const writeHostTreeTar = (
	stackRoot: string,
	subtrees: ReadonlyArray<CapturedSubtree>,
	tarDest: string,
): Effect.Effect<void, CapturePhaseError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const archive = streamHostTreeTar({
			parentDir: stackRoot,
			relPaths: subtrees.map((s) => s.relPath),
		});
		yield* Stream.run(archive, fs.sink(tarDest)).pipe(
			Effect.catch(
				failPhase(
					'tar-host-tree',
					`tar host-tree (${subtrees.length} subtrees) to ${tarDest} failed`,
				),
			),
		);
	}).pipe(Effect.withSpan('orchestrator.snapshot.capture.tar-host-tree'));

// -----------------------------------------------------------------------------
// Pre-stop gather — runs while plugins are LIVE (the gather-before-drain
// lesson: identity/contribution Effects read resolved plugin state that is
// gone once the bounce stops/recreates).
// -----------------------------------------------------------------------------

/** One participant projected to CONCRETE pre-stop values. No unresolved
 *  Effect, no live handle — every field is a plain value read while the
 *  plugin was still acquired, so it survives the stop + recreate. */
interface GatheredParticipant {
	readonly plugin: string;
	readonly labelTuples: ReadonlyArray<ContainerLabelTuple>;
	readonly identitySlice: IdentitySlice;
	readonly opaqueState: unknown;
}

/** Plain pre-stop capture data threaded across the bounce. */
export interface GatheredCapture {
	readonly participants: ReadonlyArray<GatheredParticipant>;
	/** Merged + fail-closed-checked identity. `requireIdentity` already
	 *  passed during gather, so this is non-empty by construction. */
	readonly identityMerged: IdentitySlice;
	readonly declaredSubtrees: ReadonlyArray<CapturedSubtree>;
	readonly participantKeys: ReadonlyArray<string>;
}

/**
 * PRE-STOP gather. Runs while every plugin is still acquired/live:
 *
 *   - Run each participant's `captureIdentity` / `captureContribution`
 *     Effects to concrete values (they read live resolved plugin state).
 *   - Snapshot each participant's `managedContainers` label tuples and
 *     declared `subtrees` as plain data.
 *   - Merge the identity slices with the SAME `mergeContributions`
 *     predicate the restore-side guard uses (so intra-capture conflicts
 *     fail HERE, at the capture site, before any stop).
 *   - `requireIdentity` (fail-closed) HERE so an empty/conflicting
 *     identity short-circuits BEFORE the bounce stops anything.
 *
 * The returned `GatheredCapture` holds no live registry handles; it
 * survives the stop + recreate.
 */
export const gatherCaptureParticipants = (
	participants: ReadonlyArray<SnapshotParticipant>,
): Effect.Effect<
	GatheredCapture,
	IdentityGuardError | IdentityContributionConflictError,
	never
> =>
	Effect.gen(function* () {
		const identityContributions: IdentityContribution[] = [];
		const gathered: GatheredParticipant[] = [];
		const participantKeys: string[] = [];
		for (const participant of participants) {
			const identitySlice = yield* participant.captureIdentity;
			const opaqueState = yield* participant.captureContribution;
			identityContributions.push({ plugin: participant.plugin, slice: identitySlice });
			gathered.push({
				plugin: participant.plugin,
				labelTuples: participant.decl.managedContainers ?? [],
				identitySlice,
				opaqueState,
			});
			participantKeys.push(participant.plugin);
		}
		const identityMerged = yield* mergeContributions(identityContributions);
		// Fail-closed BEFORE any stop: an empty contributed identity refuses
		// here (pre-stop) so the bounce never tears the stack down for a
		// capture that would have been rejected anyway. Preserves the
		// `SnapshotIdentityEmpty` fail-closed guard — only EARLIER.
		yield* requireIdentity(identityMerged, 'snapshot');

		// Declared host-tree subtrees, captured as concrete descriptors —
		// real host-tree data (walrus blobs, the seal vault, keystores).
		const pluginSubtrees: CapturedSubtree[] = participants.flatMap((p) =>
			p.decl.subtrees.map((relPath) => ({
				plugin: p.plugin,
				relPath,
				missingTolerance: p.decl.missingTolerance,
				secretMaterial: p.decl.secretMaterial ?? false,
			})),
		);

		// Deploy/mint artifact caches (`cache/<ns>`) ride the host-tree tar too,
		// so the snapshot is SELF-CONTAINED: a fresh runner with an empty live
		// cache recovers the deploy ids from the snapshot itself (cross-machine
		// restore). Restore untars them and the post-restore boot REUSES the
		// deploy rather than re-running it with fresh ids. `missingTolerance:
		// 'fine'` — a namespace whose plugin is disabled (e.g. `cache/deepbook`
		// in a deepbook-less stack) simply isn't on disk and is skipped; only the
		// namespaces that exist are tarred (and recorded in `meta.subtrees`). Not
		// secret material — these are public on-chain deploy/mint ids. See
		// LIVE_RESTORE_PRESERVED_PATHS in restore.ts.
		const deployCacheSubtrees: CapturedSubtree[] = deployCacheSubtreeRelPaths(CACHE_DIR_NAME).map(
			(relPath) => ({
				plugin: DEPLOY_CACHE_SUBTREE_PLUGIN,
				relPath,
				missingTolerance: 'fine' as const,
				secretMaterial: false,
			}),
		);

		// Deploy cache FIRST so it lands at the FRONT of the host-tree tar — the
		// restore preflight scans for the cache namespaces and short-circuits the
		// (potentially huge — walrus blobs) tar read once they're all found.
		const declaredSubtrees: CapturedSubtree[] = [...deployCacheSubtrees, ...pluginSubtrees];

		return {
			participants: gathered,
			identityMerged,
			declaredSubtrees,
			participantKeys,
		} satisfies GatheredCapture;
	}).pipe(Effect.withSpan('orchestrator.snapshot.capture.gather'));

// -----------------------------------------------------------------------------
// Top-level capture — the bounce.
// -----------------------------------------------------------------------------

export interface CaptureInputs {
	readonly stagingDir: string;
	readonly snapshotId: SnapshotId;
	readonly label: string | null;
	readonly app: string;
	readonly stack: string;
	readonly network: string;
	readonly runtimeStackRoot: string;
	readonly participants: ReadonlyArray<SnapshotParticipant>;
	readonly runtime: ContainerRuntime;
	/** Per-container graceful-stop grace. Storage nodes need >10s to flush
	 *  + checkpoint RocksDB on `docker stop`. Defaults to 20s. */
	readonly stopGraceSeconds?: number;
	/** RESUME — re-converge the stack to write-ready AFTER the host-tree +
	 *  images are published and the original containers are removed. The
	 *  orchestrator cannot recreate a container itself (no plugin spec), so
	 *  resume is injected: the supervisor wires it to a stack restart (drain
	 *  ∘ converge), which re-runs each plugin's acquire — including walrus's
	 *  strengthened write-ready ready-gate. Omitted in unit tests / the
	 *  offline first-boot capture (where the next boot is the resume). */
	readonly resume?: Effect.Effect<void>;
}

/** Default graceful-stop grace — mirrors the walrus storage-node grace so
 *  RocksDB flushes before the commit captures the writable layer. */
const DEFAULT_CAPTURE_STOP_GRACE_SECONDS = 20;

/**
 * Populate `stagingDir` with a complete snapshot artifact via the bounce:
 * gather (live) → graceful-stop (flush) → commit + tar + meta → retag
 * committed images onto original names + hard-rm stopped containers →
 * resume (recreate + wait-write-ready).
 *
 * Discipline:
 *   - Iterate participants — no service names appear.
 *   - Identity gathered + fail-closed BEFORE any stop.
 *   - Graceful stop (NOT pause) so RocksDB/WAL flush — the committed image
 *     is faithful.
 *   - meta.json is written LAST so a crashed save leaves the artifact
 *     invisible to the catalog.
 *   - Resume is recreate-from-image (injected), NEVER `docker start`.
 *
 * Caller wraps the staging build in `stageAndSwap` (the publish) — but the
 * retag/hard-rm/resume tail runs AFTER the swap so a publish failure leaves
 * the live stack untouched (only stopped, recoverable by the next boot).
 */
export const runCapture = (
	inputs: CaptureInputs,
): Effect.Effect<
	SnapshotMetadata,
	CapturePhaseError | IdentityGuardError | IdentityContributionConflictError,
	FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		yield* Effect.annotateCurrentSpan({
			'devstack.snapshot.phase': 'capture',
			'devstack.snapshot.id': inputs.snapshotId,
		});
		const grace = Duration.seconds(
			inputs.stopGraceSeconds ?? DEFAULT_CAPTURE_STOP_GRACE_SECONDS,
		);

		// 0. GATHER (plugins live) — identity fail-closed BEFORE any stop.
		const gathered = yield* gatherCaptureParticipants(inputs.participants);

		return yield* Effect.scoped(
			Effect.gen(function* () {
				const capturedContainers: CapturedContainer[] = [];
				const committedRefs: TaggedImageRef[] = [];
				// On capture failure, drop any committed temp tags so a failed
				// capture leaves no orphaned snapshot images (prune also reaps
				// these via the SNAPSHOT_IMAGE_ROLE label).
				yield* Effect.addFinalizer((exit) =>
					Exit.isFailure(exit) ? cleanupCommittedRefs(inputs.runtime, committedRefs) : Effect.void,
				);

				// 1. ENUMERATE + validate the full capture set.
				const plannedContainers: PlannedContainerCapture[] = [];
				for (const g of gathered.participants) {
					const containers = yield* enumerateParticipantContainers(
						g.plugin,
						g.labelTuples,
						inputs.runtime,
					);
					for (const { handle, labels } of containers) {
						yield* validateCapturedContainer(handle, labels, g.plugin);
						plannedContainers.push({ handle, labels, plugin: g.plugin });
					}
				}
				yield* detectContainerArtifactCollisions(plannedContainers);

				// 2. GRACEFUL-STOP every managed container — FLUSHES RocksDB/WAL
				//    so the committed writable layer is faithful (the walrus
				//    capture-survival fix). Stopped (not removed) so a publish
				//    failure leaves them recoverable by the next boot.
				yield* Effect.forEach(
					plannedContainers,
					(entry) =>
						inputs.runtime
							.stop(entry.handle, grace)
							.pipe(
								Effect.catch(failPhase('stop', `graceful stop failed for ${entry.handle.name}`, entry.plugin)),
							),
					{ concurrency: 'unbounded', discard: true },
				);

				// 3. COMMIT each stopped container's flushed layer.
				const committedContainers: CommittedContainerCapture[] = [];
				for (const { handle, labels, plugin } of plannedContainers) {
					const committed = yield* commitStoppedContainer(
						handle,
						labels,
						inputs.runtime,
						plugin,
						(ref) =>
							Effect.sync(() => {
								committedRefs.push(ref);
							}),
					);
					committedContainers.push(committed);
					capturedContainers.push(committed.captured);
				}
				yield* saveCommittedImages(committedContainers, inputs.stagingDir, inputs.runtime);

				// 4. TAR the host-tree subtrees declared by participants.
				const subtrees = yield* resolveCapturedSubtrees(
					gathered.declaredSubtrees,
					inputs.runtimeStackRoot,
				);
				const hostTreeIncluded = subtrees.length > 0;
				if (hostTreeIncluded) {
					yield* writeHostTreeTar(
						inputs.runtimeStackRoot,
						subtrees,
						`${inputs.stagingDir}/${SnapshotLayout.hostTreeTar}`,
					);
				}

				// 5. WRITE per-participant contribution docs from gathered state.
				yield* fs
					.makeDirectory(`${inputs.stagingDir}/${SnapshotLayout.contributionsDir}`, {
						recursive: true,
					})
					.pipe(Effect.catch(failPhase('write-contribution', `mkdir contributions dir failed`)));
				for (const g of gathered.participants) {
					const doc: ContributionDoc = {
						version: SNAPSHOT_CONTRIBUTION_VERSION,
						plugin: g.plugin,
						identity: g.identitySlice,
						...(g.opaqueState === undefined
							? {}
							: { opaqueState: { encoding: 'json' as const, value: g.opaqueState } }),
					};
					yield* fs
						.writeFileString(
							`${inputs.stagingDir}/${contributionPath(g.plugin)}`,
							JSON.stringify(doc, null, 2),
						)
						.pipe(
							Effect.catch(
								failPhase('write-contribution', `write contribution doc failed`, g.plugin),
							),
						);
				}

				// 6. WRITE meta.json LAST. The caller publishes via stage-and-swap
				//    (atomic rename), so catalog readers never observe a
				//    half-written artifact.
				const meta: SnapshotMetadata = {
					version: SNAPSHOT_META_VERSION,
					id: inputs.snapshotId,
					label: inputs.label,
					createdAt: Date.now(),
					app: inputs.app,
					stack: inputs.stack,
					network: inputs.network,
					hostTreeIncluded,
					subtrees,
					containers: capturedContainers,
					identity: gathered.identityMerged,
					participants: [...gathered.participantKeys],
				};
				yield* fs
					.writeFileString(
						`${inputs.stagingDir}/${SnapshotLayout.metaFile}`,
						JSON.stringify(meta, null, 2),
					)
					.pipe(Effect.catch(failPhase('write-meta', `write meta.json failed`)));

				return meta;
			}),
		);
	}).pipe(Effect.withSpan('orchestrator.snapshot.capture'));

/**
 * The post-publish bounce tail: retag each committed image onto its
 * container's ORIGINAL image name (so the resume's recreate-from-image
 * boots the node on its just-committed, flushed layer), hard-rm the stopped
 * containers, then run the injected resume (recreate + wait-write-ready).
 *
 * Runs AFTER `stageAndSwap` publishes the artifact, so a publish failure
 * never reaches here — the live stack is only stopped (recoverable). The
 * retag aliases the original image name onto the committed layer; restore
 * uses the SAME retag-to-original-name mechanism with its loaded bundle, so
 * capture and restore resume identically (recreate-from-fresh off an image
 * whose name now resolves to the snapshot layer).
 *
 * This is NEVER expressed as `docker start` — walrus storage nodes EXIT on
 * `docker start` after a graceful stop; the resume's recreate is a fresh
 * `docker run` that re-syncs and the write-ready ready-gate blocks on.
 */
export const resumeAfterCapture = (
	meta: SnapshotMetadata,
	inputs: Pick<CaptureInputs, 'runtime' | 'app' | 'stack' | 'resume'>,
): Effect.Effect<void, CapturePhaseError> =>
	Effect.gen(function* () {
		// Retag each committed image onto its original name. Re-find the
		// committed ref by its snapshot tag; tagImage aliases the original
		// imageName onto it (removeSourceAfterTag drops the temp snapshot
		// tag — its label-owned image is now reachable by the original name).
		for (const captured of meta.containers) {
			// The contract's `tagImage` resolves the source by `tag ?? digest`
			// (runtime/docker/service.ts), so the snapshot tag is the operative
			// source; `digest` mirrors it to satisfy the `ImageRef` shape.
			yield* inputs.runtime
				.tagImage({ digest: captured.snapshotTag, tag: captured.snapshotTag }, captured.imageName, {
					removeSourceAfterTag: true,
				})
				.pipe(
					Effect.catch(
						failPhase(
							'retag-image',
							`tag committed image ${captured.snapshotTag} as ${captured.imageName} failed`,
							captured.plugin,
						),
					),
				);
		}
		// HARD-rm the stopped containers (claim-bypassing) so the resume's
		// recreate sees facts:null → fresh → `docker run` the original name,
		// which now resolves to the committed layer.
		for (const captured of meta.containers) {
			yield* inputs.runtime
				.removeManagedContainers({
					app: inputs.app,
					stack: inputs.stack,
					plugin: captured.plugin,
					role: captured.role,
				})
				.pipe(
					Effect.catch(
						failPhase(
							'remove-container',
							`remove managed containers for ${captured.plugin}/${captured.role} failed`,
							captured.plugin,
						),
					),
				);
		}
		// RESUME = recreate-from-image + wait-write-ready. Injected (the
		// orchestrator can't recreate without the plugin spec); the supervisor
		// wires it to a stack restart whose converge re-runs each plugin's
		// acquire — including walrus's write-ready ready-gate.
		if (inputs.resume !== undefined) {
			yield* inputs.resume.pipe(
				Effect.catch(failPhase('resume', `stack resume after capture failed`)),
			);
		}
	}).pipe(Effect.withSpan('orchestrator.snapshot.capture.resume'));
