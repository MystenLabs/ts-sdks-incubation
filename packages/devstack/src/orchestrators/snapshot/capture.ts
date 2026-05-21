// Capture pipeline.
//
// Architecture § Snapshot lifecycle (capture half):
//
//   Walk Snapshotable registry; group by plugin.
//   For each plugin in dep-graph order:
//     pause managed containers (unless stopped)
//     tar host-tree subtrees with mode round-trip
//     docker commit + tag committed images
//     collect metadata slice
//     unpause (always — success AND failure)
//   Stage everything in tempdir.
//   Atomic rename → snapshot catalog entry.
//
// The orchestrator is name-blind: it walks `Snapshotable` contributions
// without referencing any service. Containers are enumerated via the
// label tuple the participant declared; subtrees via the relative
// paths the participant declared.

import { Effect, Exit, FileSystem, Schema, Stream } from 'effect';

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
import { writeArtifactIntegrity } from './integrity.ts';
import { readSnapshotStateDocument, writeSnapshotStateDocument } from './state-document.ts';

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
			'quiesce',
			'commit',
			'save-images',
			'tar-subtree',
			'tar-host-tree',
			'read-state',
			'write-state',
			'write-contribution',
			'write-meta',
			'write-integrity',
			'unpause',
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
	/** Identity slice this participant contributes to the guard. The
	 *  orchestrator merges contributions across participants — see
	 *  `identity-guard.ts`. Returned by the participant's preRestore
	 *  hook on RESTORE; on CAPTURE the substrate reads the live value
	 *  via this `captureIdentity` helper (separately wired). */
	readonly captureIdentity: Effect.Effect<IdentitySlice>;
	/** Opaque JSON metadata the plugin wants snapshotted. The
	 *  contribution document validates only an envelope around this
	 *  payload; the orchestrator never relies on the payload shape. */
	readonly captureContribution: Effect.Effect<unknown>;
}

// -----------------------------------------------------------------------------
// Staging — populate a directory; the caller wraps in stage-and-swap.
// -----------------------------------------------------------------------------

const failPhase =
	(
		phase: CapturePhaseError['phase'],
		detail: string,
		plugin?: string,
	): ((cause: unknown) => Effect.Effect<never, CapturePhaseError>) =>
	(cause) =>
		Effect.fail(new CapturePhaseError({ phase, plugin, detail, cause }));

interface QuiescedContainer {
	readonly handle: ContainerHandle;
	readonly labels: ContainerLabelTuple;
	readonly unpauseAfterCapture: boolean;
}

interface PlannedContainerCapture extends QuiescedContainer {
	readonly participant: SnapshotParticipant;
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
	participant: SnapshotParticipant,
): Effect.Effect<void, CapturePhaseError> =>
	Effect.gen(function* () {
		yield* validateSnapshotPathSegment('plugin', labels.plugin, 'commit', participant.plugin);
		yield* validateSnapshotPathSegment('role', labels.role, 'commit', participant.plugin);
		if (!isRestorableContainerImageName(handle.imageName)) {
			return yield* Effect.fail(
				new CapturePhaseError({
					phase: 'commit',
					plugin: participant.plugin,
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
						plugin: candidate.participant.plugin,
						detail: `duplicate managed container snapshot identity ${key} for ${previous.handle.name} and ${candidate.handle.name}`,
					}),
				);
			}
			seen.set(key, candidate);
		}
	});

/**
 * Enumerate a participant's live managed containers, then run its
 * optional app-level quiesce hook. Already-paused, exited, and
 * created containers are committed as-is and are not unpaused by
 * capture finalization.
 *
 * Architecture § Invariants: "A running container must be paused
 * around the writable-layer commit; the unpause must fire on both
 * success and failure paths (no orphaned paused containers). A
 * stopped container is already quiescent and must not be paused."
 *
 * The default quiescence is `pauseAndCommit`; participants that need
 * an application-level flush (postgres, RocksDB) declare a longer-grace
 * `quiesce` effect on their decl — the orchestrator runs it BEFORE
 * `pauseAndCommit`.
 */
const quiesceParticipant = (
	participant: SnapshotParticipant,
	runtime: ContainerRuntime,
): Effect.Effect<ReadonlyArray<QuiescedContainer>, CapturePhaseError> =>
	Effect.gen(function* () {
		const labelTuples = participant.decl.managedContainers ?? [];
		const containers: QuiescedContainer[] = [];
		for (const tuple of labelTuples) {
			const matched = yield* runtime
				.inspectByLabels(tuple)
				.pipe(
					Effect.catch(
						failPhase(
							'enumerate-containers',
							`inspect by labels failed for ${tuple.plugin}/${tuple.role}`,
							participant.plugin,
						),
					),
				);
			for (const handle of matched) {
				if (handle.status === 'running') {
					containers.push({ handle, labels: tuple, unpauseAfterCapture: true });
				} else if (
					handle.status === 'paused' ||
					handle.status === 'exited' ||
					handle.status === 'created'
				) {
					containers.push({ handle, labels: tuple, unpauseAfterCapture: false });
				}
			}
		}
		// Run the optional app-level flush hook first; default pause
		// follows. The hook itself only signals failure-or-success in
		// `Cause<never>` (per `SnapshotableDecl.quiesce`'s typed shape) —
		// the orchestrator does not surface flush errors as a separate
		// tag; defects propagate through the underlying Cause.
		if (participant.decl.quiesce) {
			yield* participant.decl.quiesce.pipe(Effect.scoped, Effect.ignore);
		}
		return containers;
	}).pipe(Effect.withSpan('orchestrator.snapshot.capture.quiesce'));

/** Commit one container's writable layer to a temporary snapshot image tag. */
const commitContainerToImage = (
	handle: ContainerHandle,
	labels: ContainerLabelTuple,
	runtime: ContainerRuntime,
	participant: SnapshotParticipant,
	registerCommittedRef: (ref: TaggedImageRef) => Effect.Effect<void>,
): Effect.Effect<CommittedContainerCapture, CapturePhaseError> =>
	Effect.gen(function* () {
		// pause+commit produces the image; the orchestrator does NOT
		// unpause here — `runCapture` owns the unpause-on-all-paths
		// finalizer.
		const imageRef = yield* runtime
			.pauseAndCommit(handle)
			.pipe(
				Effect.catch(
					failPhase('commit', `pauseAndCommit failed for ${handle.name}`, participant.plugin),
				),
			);
		const snapshotTag = imageRef.tag;
		yield* registerCommittedRef(imageRef);
		if (!isRestorableContainerImageName(snapshotTag)) {
			return yield* Effect.fail(
				new CapturePhaseError({
					phase: 'commit',
					plugin: participant.plugin,
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
		yield* Stream.run(
			runtime.saveImages(
				committed.map((entry) => entry.imageRef),
				{ removeAfterSave: true },
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
// Top-level capture — populate a staging directory; caller wraps in swap.
// -----------------------------------------------------------------------------

export interface CaptureInputs {
	readonly stagingDir: string;
	readonly snapshotId: SnapshotId;
	readonly label: string | null;
	readonly app: string;
	readonly stack: string;
	readonly network: string;
	readonly runtimeStackRoot: string;
	readonly stateFilePath: string;
	readonly participants: ReadonlyArray<SnapshotParticipant>;
	readonly runtime: ContainerRuntime;
}

/**
 * Populate `stagingDir` with a complete snapshot artifact.
 *
 * Discipline:
 *   - Iterate participants — no service names appear.
 *   - Pause-around-commit with always-unpause via `addFinalizer`.
 *   - Mode bits preserved by the host-tree tar primitive.
 *   - meta.json is written LAST so a crashed save leaves the artifact
 *     invisible to the catalog (architecture § "Partial saves are inert").
 *
 * Caller wraps this in `stageAndSwap` + `acquireReservation` + the
 * stack lock.
 */
export const runCapture = (
	inputs: CaptureInputs,
): Effect.Effect<SnapshotMetadata, CapturePhaseError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		yield* Effect.annotateCurrentSpan({
			'devstack.snapshot.phase': 'capture',
			'devstack.snapshot.id': inputs.snapshotId,
		});

		// 1. Quiesce + commit each participant's containers under a
		//    scoped finalizer so unpause runs on success AND failure.
		//    Architecture § Invariants: "no orphaned paused containers".
		const capturedContainers: CapturedContainer[] = [];

		yield* Effect.scoped(
			Effect.gen(function* () {
				const paused: ContainerHandle[] = [];
				yield* Effect.addFinalizer(() =>
					Effect.forEach(
						paused,
						(handle) =>
							inputs.runtime
								.unpause(handle)
								.pipe(
									Effect.catch((cause) =>
										Effect.logWarning(
											`unpause(${handle.name}) failed during snapshot capture: ${String(cause)}`,
										),
									),
								),
						{ concurrency: 'unbounded' },
					).pipe(Effect.asVoid),
				);
				const plannedContainers: PlannedContainerCapture[] = [];
				const committedRefs: TaggedImageRef[] = [];
				yield* Effect.addFinalizer((exit) =>
					Exit.isFailure(exit) ? cleanupCommittedRefs(inputs.runtime, committedRefs) : Effect.void,
				);
				for (const participant of inputs.participants) {
					const containers = yield* quiesceParticipant(participant, inputs.runtime);
					for (const { handle, labels, unpauseAfterCapture } of containers) {
						yield* validateCapturedContainer(handle, labels, participant);
						plannedContainers.push({
							handle,
							labels,
							unpauseAfterCapture,
							participant,
						});
					}
				}
				yield* detectContainerArtifactCollisions(plannedContainers);
				const committedContainers: CommittedContainerCapture[] = [];
				for (const { handle, labels, unpauseAfterCapture, participant } of plannedContainers) {
					if (unpauseAfterCapture) {
						paused.push(handle);
					}
					const committed = yield* commitContainerToImage(
						handle,
						labels,
						inputs.runtime,
						participant,
						(ref) =>
							Effect.sync(() => {
								committedRefs.push(ref);
							}),
					);
					committedContainers.push(committed);
					capturedContainers.push(committed.captured);
				}
				yield* saveCommittedImages(committedContainers, inputs.stagingDir, inputs.runtime);
			}),
		);

		// 2. Tar the host-tree subtrees declared by participants.
		const declaredSubtrees: CapturedSubtree[] = inputs.participants.flatMap((p) =>
			p.decl.subtrees.map((relPath) => ({
				plugin: p.plugin,
				relPath,
				missingTolerance: p.decl.missingTolerance,
				secretMaterial: p.decl.secretMaterial ?? false,
			})),
		);
		const subtrees = yield* resolveCapturedSubtrees(declaredSubtrees, inputs.runtimeStackRoot);
		const hostTreeIncluded = subtrees.length > 0;
		if (hostTreeIncluded) {
			yield* writeHostTreeTar(
				inputs.runtimeStackRoot,
				subtrees,
				`${inputs.stagingDir}/${SnapshotLayout.hostTreeTar}`,
			);
		}

		// 3. Copy the scalar state file (best-effort missing-OK — empty
		//    stack on first-boot has no state.json yet).
		const stateExists = yield* fs
			.exists(inputs.stateFilePath)
			.pipe(Effect.catch(() => Effect.succeed(false)));
		if (stateExists) {
			const stateDoc = yield* readSnapshotStateDocument(inputs.stateFilePath).pipe(
				Effect.catch(failPhase('read-state', `state.json failed schema validation`)),
			);
			yield* writeSnapshotStateDocument(
				`${inputs.stagingDir}/${SnapshotLayout.stateFile}`,
				stateDoc,
			).pipe(Effect.catch(failPhase('write-state', `write state.json failed`)));
		}

		// 4. Write per-participant contribution docs + collect identity.
		yield* fs
			.makeDirectory(`${inputs.stagingDir}/${SnapshotLayout.contributionsDir}`, {
				recursive: true,
			})
			.pipe(Effect.catch(failPhase('write-contribution', `mkdir contributions dir failed`)));
		const identityMerged: Record<string, string> = {};
		const participantKeys: string[] = [];
		for (const participant of inputs.participants) {
			const identity = yield* participant.captureIdentity;
			for (const [k, v] of Object.entries(identity)) {
				// Conflict-on-same-key handled by identity-guard's
				// `mergeContributions` on the restore side; on capture we
				// last-write-wins (typical: only one plugin contributes
				// each key on capture).
				identityMerged[k] = v;
			}
			const state = yield* participant.captureContribution;
			const doc: ContributionDoc = {
				version: SNAPSHOT_CONTRIBUTION_VERSION,
				plugin: participant.plugin,
				identity,
				...(state === undefined
					? {}
					: {
							opaqueState: {
								encoding: 'json' as const,
								value: state,
							},
						}),
			};
			yield* fs
				.writeFileString(
					`${inputs.stagingDir}/${contributionPath(participant.plugin)}`,
					JSON.stringify(doc, null, 2),
				)
				.pipe(
					Effect.catch(
						failPhase('write-contribution', `write contribution doc failed`, participant.plugin),
					),
				);
			participantKeys.push(participant.plugin);
		}

		// 5. Write meta.json, then integrity over the full artifact.
		//    The caller publishes via stage-and-swap, so catalog
		//    readers still never observe a half-written artifact.
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
			identity: identityMerged,
			participants: participantKeys,
		};
		yield* fs
			.writeFileString(
				`${inputs.stagingDir}/${SnapshotLayout.metaFile}`,
				JSON.stringify(meta, null, 2),
			)
			.pipe(Effect.catch(failPhase('write-meta', `write meta.json failed`)));
		yield* writeArtifactIntegrity(inputs.stagingDir).pipe(
			Effect.catch(failPhase('write-integrity', `write integrity.json failed`)),
		);

		return meta;
	}).pipe(Effect.withSpan('orchestrator.snapshot.capture'));
