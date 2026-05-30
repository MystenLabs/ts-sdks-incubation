// Snapshot orchestrator service.
//
// Architecture § L3 § Snapshot orchestrator:
//   "Collects all `Snapshotable` decls, applies one capture-wide
//   pause window for managed containers, tars host subtrees with mode
//   round-trip, commits container writable layers, threads a typed metadata record
//   (identity guard + per-participant slice), atomic stage-and-swap
//   for restore, identity-guard fires before any destructive mutation."
//
// This file is the orchestrator's typed entry point — `capture`,
// `restore`, `list`, `delete`, `wipe`, `prune` — wired to the
// cross-process safety primitives (`snapshot.reservation`,
// `stack.lock`) and the substrate path resolver.
//
// The service surface is name-blind. The two participant lists
// (capture and restore) are populated by the substrate at boot from
// the `Snapshotable` decls of registered plugins; service-specific
// behavior never reaches this file. Registration is scope-bound: the
// supervisor calls `registerParticipant(pluginKey, decl)` from inside
// each plugin's scope so the registry entry is reaped on plugin
// teardown.

import { mintRandomSuffix } from '../../substrate/runtime/random-suffix.ts';

import { Context, Effect, FileSystem, Layer, Ref, Schema, Scope } from 'effect';

import type { SnapshotableDecl } from '../../contracts/snapshotable.ts';
import type { ContainerRuntime } from '../../contracts/container-runtime.ts';
import { ContainerRuntimeService } from '../../runtime/docker/index.ts';
import { decodeJsonText } from '../../substrate/runtime/runtime-decode.ts';
import { ownHolder } from '../../substrate/runtime/cross-process/liveness.ts';
import {
	acquireReservation,
	type SnapshotReservationError,
} from '../../substrate/runtime/cross-process/snapshot-reservation.ts';
import {
	acquireStackLock,
	type StackLockError,
} from '../../substrate/runtime/cross-process/stack-lock.ts';
import { IdentityContext, StackPathsService } from '../../substrate/runtime/paths.ts';
import {
	runCapture,
	type CapturePhaseError,
	type SnapshotParticipant,
	type SnapshotProgressReporter,
} from './capture.ts';
import {
	SnapshotDescriptorError,
	SnapshotLayout,
	SnapshotMetadataSchema,
	SNAPSHOT_ID_RULE,
	parseSnapshotId,
	type SnapshotId,
	type SnapshotCatalogEntry,
	type SnapshotMetadata,
} from './descriptor.ts';
import {
	type IdentityContributionConflictError,
	type IdentityGuardError,
} from './identity-guard.ts';
import { runPrune, type PruneResult, type PrunePhaseError } from './prune.ts';
import {
	recoverPendingRestore,
	type RestorePendingRecoveryError,
	type RestorePendingRecoverySummary,
} from './recover-pending.ts';
import { runRestore, type RestoreParticipant, type RestorePhaseError } from './restore.ts';
import {
	stageAndSwap,
	type StageAndSwapError,
} from '../../substrate/runtime/stage-and-swap/index.ts';
import { planWipe, runWipe, type WipePhaseError, type WipeTargets } from './wipe.ts';

// -----------------------------------------------------------------------------
// The service shape
// -----------------------------------------------------------------------------

/** Tagged union of every error the orchestrator surface can surface.
 *  Callers `catchTags` on the precise tags they care about. */
export type SnapshotOrchestratorError =
	| CapturePhaseError
	| RestorePhaseError
	| RestorePendingRecoveryError
	| WipePhaseError
	| PrunePhaseError
	| IdentityGuardError
	| IdentityContributionConflictError
	| StageAndSwapError
	| SnapshotReservationError
	| StackLockError
	| SnapshotIdError
	| SnapshotDescriptorError;

export class SnapshotIdError extends Schema.TaggedErrorClass<SnapshotIdError>()('SnapshotIdError', {
	operation: Schema.Literals(['capture', 'restore', 'delete']),
	field: Schema.Literals(['id', 'name']),
	value: Schema.String,
	detail: Schema.String,
}) {}

export interface SnapshotOrchestrator {
	/** Register a `SnapshotableDecl` from a plugin. Scope-bound — when
	 *  the caller's scope (the plugin's acquire scope) closes, the
	 *  registration is reaped. The supervisor calls this once per
	 *  `SnapshotableDecl` on each plugin's `capabilities` tuple.
	 *
	 *  `captureIdentity` / `captureContribution` are separately wired
	 *  hooks (not on `SnapshotableDecl` itself) — they plumb through
	 *  the plugin's resolved value. Identity is validated by the
	 *  orchestrator; contribution payloads are persisted as opaque JSON
	 *  that plugins must validate at their own boundary if they read it. */
	readonly registerParticipant: (
		pluginKey: string,
		decl: SnapshotableDecl,
		hooks?: {
			readonly captureIdentity?: Effect.Effect<Readonly<Record<string, string>>>;
			readonly captureContribution?: Effect.Effect<unknown>;
			readonly liveIdentity?: Effect.Effect<Readonly<Record<string, string>>>;
		},
	) => Effect.Effect<void, never, Scope.Scope>;

	/** Capture a new snapshot. The id MAY be caller-supplied; if
	 *  omitted, the substrate mints a random suffix to sidestep the
	 *  concurrent-saves-against-same-id silent overwrite.
	 *
	 *  `participants` overrides the registered set — primarily for
	 *  tests. Production callers omit it; the orchestrator reads the
	 *  registered list. */
	readonly capture: (args: {
		readonly id?: string;
		readonly label?: string;
		readonly participants?: ReadonlyArray<SnapshotParticipant>;
		readonly onProgress?: SnapshotProgressReporter;
	}) => Effect.Effect<SnapshotMetadata, SnapshotOrchestratorError, FileSystem.FileSystem>;

	/** Restore from a previously-captured artifact id. Refuses on
	 *  identity mismatch BEFORE any destructive mutation. */
	readonly restore: (args: {
		readonly id: string;
		readonly participants?: ReadonlyArray<RestoreParticipant>;
	}) => Effect.Effect<SnapshotMetadata, SnapshotOrchestratorError, FileSystem.FileSystem>;

	/** Catalog list — tolerates partial / corrupt entries (they appear
	 *  with `metadata: null`). */
	readonly list: Effect.Effect<
		ReadonlyArray<SnapshotCatalogEntry>,
		SnapshotOrchestratorError,
		FileSystem.FileSystem
	>;

	/** Delete one artifact by id. Idempotent — missing id is a no-op. */
	readonly delete: (
		id: string,
	) => Effect.Effect<void, SnapshotOrchestratorError, FileSystem.FileSystem>;

	/** Wipe the live (`app`, `stack`) footprint; preserves the
	 *  snapshot catalog by default. Stack-local artifact cache is
	 *  removed unless `keepCache` is explicitly true. */
	readonly wipe: (args: {
		readonly keepSnapshots?: boolean;
		readonly keepCache?: boolean;
	}) => Effect.Effect<void, SnapshotOrchestratorError, FileSystem.FileSystem>;

	/** Enumerate the concrete teardown targets a `wipe` of the same
	 *  `(app, stack)` would remove WITHOUT removing anything — the
	 *  read-only preview behind `devstack wipe --dry-run`. Same args as
	 *  `wipe` so the preview honors the same `keepSnapshots`/`keepCache`
	 *  preservation policy the real wipe applies. */
	readonly wipePlan: (args: {
		readonly keepSnapshots?: boolean;
		readonly keepCache?: boolean;
	}) => Effect.Effect<WipeTargets, SnapshotOrchestratorError, FileSystem.FileSystem>;

	/** Prune the snapshot catalog (reaps partial artifacts) and sweeps
	 *  byproduct images via the runtime adapter's label-scoped cleanup. */
	readonly prune: () => Effect.Effect<
		PruneResult,
		SnapshotOrchestratorError,
		FileSystem.FileSystem
	>;

	/** Recover from a snapshot-restore that crashed mid-way through the
	 *  post-publish Docker handoff. Reads the on-disk pending marker,
	 *  retries each outstanding image promote, and clears the marker.
	 *  Idempotent — safe to call on every supervise startup; a no-op
	 *  when no marker is present. */
	readonly recoverPendingRestore: Effect.Effect<
		RestorePendingRecoverySummary,
		SnapshotOrchestratorError,
		FileSystem.FileSystem
	>;
}

export class SnapshotOrchestratorService extends Context.Service<
	SnapshotOrchestratorService,
	SnapshotOrchestrator
>()('@devstack/orchestrators/Snapshot') {}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Mint a snapshot id when the caller didn't pass one. Carries an
 *  8-hex random suffix from `crypto.randomUUID()` (STYLE_GUIDE §17) so
 *  concurrent saves don't silently overwrite. */
const mintId = (prefix = 'snap'): string => `${prefix}-${Date.now()}-${mintRandomSuffix(8)}`;

const mintSnapshotId = (): Effect.Effect<SnapshotId, SnapshotDescriptorError> => {
	const raw = mintId();
	const id = parseSnapshotId(raw);
	return id === null
		? Effect.fail(
				new SnapshotDescriptorError({
					kind: 'invalid-id',
					detail: 'internal snapshot id minting produced an invalid id',
					value: raw,
				}),
			)
		: Effect.succeed(id);
};

const mintSnapshotName = (): string => {
	const stamp = new Date().toISOString().replaceAll('-', '').replaceAll(':', '').slice(0, 15);
	return `manual-${stamp}-${mintRandomSuffix(8)}`;
};

const validateSnapshotId = (
	operation: SnapshotIdError['operation'],
	value: string,
): Effect.Effect<SnapshotId, SnapshotIdError> => {
	const id = parseSnapshotId(value);
	return id === null
		? Effect.fail(
				new SnapshotIdError({
					operation,
					field: 'id',
					value,
					detail: SNAPSHOT_ID_RULE,
				}),
			)
		: Effect.succeed(id);
};

const normalizeSnapshotName = (
	operation: SnapshotIdError['operation'],
	name: string | undefined,
): Effect.Effect<string, SnapshotIdError> => {
	if (name === undefined) return Effect.succeed(mintSnapshotName());
	const normalized = name.trim();
	if (normalized.length === 0 || normalized.includes('\0') || normalized.length > 128) {
		return Effect.fail(
			new SnapshotIdError({
				operation,
				field: 'name',
				value: name,
				detail:
					'snapshot names must be 1-128 characters after trimming and cannot contain NUL bytes',
			}),
		);
	}
	return Effect.succeed(normalized);
};

/** Read this process's canonical startTime stamp for the snapshot
 *  reservation liveness check. Returns `null` when the kernel-probe
 *  couldn't determine startTime — matches `RosterHolderSchema.startTime`
 *  semantics and is honored by the sweep's `checkHolderLiveness`
 *  null-conservative short-circuit. */
const ownStartTime = (): number | null => ownHolder('snapshot').startTime;

const normalizeIdentityValue = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(normalizeIdentityValue);
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, nested]) => [key, normalizeIdentityValue(nested)]),
		);
	}
	return value;
};

const stableIdentityString = (value: unknown): string => {
	const encoded = JSON.stringify(normalizeIdentityValue(value));
	return encoded ?? String(value);
};

const identityHookFromDecl = (
	pluginKey: string,
	decl: SnapshotableDecl,
): Effect.Effect<Readonly<Record<string, string>>> =>
	decl.preRestore === undefined
		? Effect.succeed({})
		: decl.preRestore.pipe(Effect.map((value) => ({ [pluginKey]: stableIdentityString(value) })));

// -----------------------------------------------------------------------------
// Layer
// -----------------------------------------------------------------------------

/**
 * Wire the orchestrator from the substrate's path resolver + the
 * runtime container adapter.
 *
 * Discipline:
 *   - Capture/restore acquire `snapshot.reservation` (O_EXCL,
 *     no retry) — concurrent capture is structurally refused.
 *   - List/delete/wipe acquire `stack.lock` briefly (no reservation
 *     needed; they don't pause containers).
 *   - Prune acquires both — it walks the catalog AND sweeps images.
 */
/** Per-plugin participant registration entry kept on the orchestrator's
 *  inner ref. Sequence number lets parallel registrations under the
 *  same key be reaped independently when their owning scopes close. */
interface RegisteredParticipantEntry {
	readonly pluginKey: string;
	readonly capture: SnapshotParticipant;
	readonly restore: RestoreParticipant;
	readonly seq: number;
}

export const layerSnapshotOrchestrator: Layer.Layer<
	SnapshotOrchestratorService,
	never,
	StackPathsService | IdentityContext | ContainerRuntimeService
> = Layer.effect(
	SnapshotOrchestratorService,
	Effect.gen(function* () {
		const paths = yield* StackPathsService;
		const identity = yield* IdentityContext;
		const runtime: ContainerRuntime = yield* ContainerRuntimeService;

		// Scope-local participant registry. The supervisor adds entries
		// from each plugin's acquire scope; finalizers remove them on
		// scope close. Sequence number protects against the parallel-
		// registration-same-key race when two stack instances register
		// concurrently.
		const participantsRef = yield* Ref.make<ReadonlyArray<RegisteredParticipantEntry>>([]);
		const seqRef = yield* Ref.make(0);

		const registerParticipant: SnapshotOrchestrator['registerParticipant'] = (
			pluginKey,
			decl,
			hooks,
		) =>
			Effect.gen(function* () {
				const seq = yield* Ref.updateAndGet(seqRef, (n) => n + 1);
				const declIdentity = identityHookFromDecl(pluginKey, decl);
				const capture: SnapshotParticipant = {
					plugin: pluginKey,
					decl,
					captureIdentity: hooks?.captureIdentity ?? declIdentity,
					captureContribution: hooks?.captureContribution ?? Effect.succeed<unknown>(undefined),
				};
				const restore: RestoreParticipant = {
					plugin: pluginKey,
					liveIdentity: hooks?.liveIdentity ?? declIdentity,
					postRestore: decl.postRestore as Effect.Effect<void> | undefined,
				};
				const entry: RegisteredParticipantEntry = { pluginKey, capture, restore, seq };
				yield* Ref.update(participantsRef, (xs) => [...xs, entry]);
				yield* Effect.addFinalizer(() =>
					Ref.update(participantsRef, (xs) => xs.filter((e) => e.seq !== seq)),
				);
				yield* Effect.annotateCurrentSpan({
					'snapshot.participant.plugin': pluginKey,
					'snapshot.participant.subtrees': decl.subtrees.length,
				});
			}).pipe(Effect.withSpan('orchestrator.snapshot.registerParticipant')) as Effect.Effect<
				void,
				never,
				Scope.Scope
			>;

		const capture: SnapshotOrchestrator['capture'] = ({ id, label, participants, onProgress }) =>
			Effect.gen(function* () {
				const snapshotId =
					id === undefined ? yield* mintSnapshotId() : yield* validateSnapshotId('capture', id);
				const snapshotName = yield* normalizeSnapshotName('capture', label);
				const effectiveParticipants =
					participants ?? (yield* Ref.get(participantsRef)).map((e) => e.capture);
				const artifactDir = `${paths.snapshotDir}/${snapshotId}`;
				// Snapshot stages at the SNAPSHOT-DIR level (siblings of
				// other artifact dirs, NOT siblings of `artifactDir`) so
				// the `list` walker's `.staging.` / `.bak.` prefix skip
				// at line 517 keeps transient dirs invisible without
				// having to descend a level. This layout is structurally
				// distinct from `${target}.staging.<id>` so we pass
				// explicit `stagingPath`/`backupPath` instead of
				// `idSuffix` (the substrate primitive supports both
				// shapes — see `stageAndSwap`'s union arg).
				const stagingDir = `${paths.snapshotDir}/.staging.${snapshotId}`;
				const backupDir = `${paths.snapshotDir}/.bak.${snapshotId}`;

				// Acquire `snapshot.reservation` (O_EXCL, no retry) for the
				// duration of the capture. The stack.lock is acquired
				// briefly inside `stageAndSwap` for the rename publish.
				return yield* Effect.scoped(
					Effect.gen(function* () {
						yield* acquireReservation(paths.snapshotReservationFile, ownStartTime());
						const fs = yield* FileSystem.FileSystem;
						const targetExists = yield* fs
							.exists(artifactDir)
							.pipe(Effect.catch(() => Effect.succeed(false)));
						if (targetExists) {
							return yield* Effect.fail(
								new SnapshotIdError({
									operation: 'capture',
									field: 'id',
									value: snapshotId,
									detail: 'snapshot id already exists',
								}),
							);
						}
						// O(N) catalog scan for label uniqueness — acceptable
						// because N (snapshot count per stack) is small in
						// practice and capture is a rare, human-paced verb. A
						// future optimization could maintain a sibling name-
						// index (e.g. `${snapshotDir}/.names/${label}` empty
						// marker files) that lets uniqueness collapse to a
						// single `fs.exists`, but that would need a paired
						// cleanup-on-delete pathway + a corruption-tolerance
						// story for the sidecar, which is outside this scope.
						//
						// Forward-reference safety: `list` is declared LATER
						// in this outer `Effect.gen` body. No TDZ fires
						// because `capture` is an arrow function returned
						// from the gen — by the time any caller invokes it,
						// the outer gen has fully resolved and all `const`
						// bindings (including `list`) are bound. The
						// regression guard at
						// test/orchestrators/snapshot/capture-collision-tdz.test.ts
						// pins this; if a future refactor wraps `list` in
						// an `Effect.fn` decorator or extracts it through a
						// hoisting-sensitive path, the guard will fail.
						const existing = yield* list;
						if (existing.some((entry) => entry.metadata?.label === snapshotName)) {
							return yield* Effect.fail(
								new SnapshotIdError({
									operation: 'capture',
									field: 'name',
									value: snapshotName,
									detail: 'snapshot name already exists',
								}),
							);
						}

						// Stage-and-swap publishes the artifact directory
						// atomically — external watchers (and `list`)
						// never observe a half-written tree.
						const meta = yield* stageAndSwap({
							targetPath: artifactDir,
							stagingPath: stagingDir,
							backupPath: backupDir,
							build: runCapture({
								stagingDir,
								snapshotId,
								label: snapshotName,
								app: identity.app,
								stack: identity.stack,
								network: identity.chain,
								runtimeStackRoot: paths.stackRoot,
								stateFilePath: paths.stateFile,
								participants: effectiveParticipants,
								runtime,
								onProgress,
							}),
						});
						return meta;
					}),
				);
			}).pipe(Effect.withSpan('orchestrator.snapshot.capture.entry'));

		const restore: SnapshotOrchestrator['restore'] = ({ id, participants }) =>
			Effect.gen(function* () {
				const snapshotId = yield* validateSnapshotId('restore', id);
				const artifactDir = `${paths.snapshotDir}/${snapshotId}`;
				const effectiveParticipants =
					participants ?? (yield* Ref.get(participantsRef)).map((e) => e.restore);
				return yield* Effect.scoped(
					Effect.gen(function* () {
						yield* acquireReservation(paths.snapshotReservationFile, ownStartTime());
						return yield* runRestore({
							snapshotId,
							artifactDir,
							runtimeStackRoot: paths.stackRoot,
							runtimeStagingPath: `${paths.stackRoot}.staging.${snapshotId}`,
							runtimeBackupPath: `${paths.stackRoot}.bak.${snapshotId}`,
							participants: effectiveParticipants,
							runtime,
							runtimeIdentity: {
								app: identity.app,
								stack: identity.stack,
								network: identity.chain,
							},
						});
					}),
				);
			}).pipe(Effect.withSpan('orchestrator.snapshot.restore.entry'));

		const list: SnapshotOrchestrator['list'] = Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const exists = yield* fs
				.exists(paths.snapshotDir)
				.pipe(Effect.catch(() => Effect.succeed(false)));
			if (!exists) return [];
			const ids = yield* fs
				.readDirectory(paths.snapshotDir)
				.pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)));
			const entries: SnapshotCatalogEntry[] = [];
			for (const id of ids) {
				// Skip transient staging/backup directories — they're
				// invisible to the catalog by construction (the
				// `.staging.<id>` / `.bak.<id>` naming).
				if (id.startsWith('.staging.') || id.startsWith('.bak.')) continue;
				const parsedId = parseSnapshotId(id);
				if (parsedId === null) {
					yield* Effect.logWarning(`ignoring unsafe snapshot catalog entry: ${id}`);
					continue;
				}
				const dir = `${paths.snapshotDir}/${id}`;
				const metaPath = `${dir}/${SnapshotLayout.metaFile}`;
				const metaExists = yield* fs
					.exists(metaPath)
					.pipe(Effect.catch(() => Effect.succeed(false)));
				if (!metaExists) {
					entries.push({ id, directory: dir, metadata: null });
					continue;
				}
				const text = yield* fs
					.readFileString(metaPath)
					.pipe(Effect.catch(() => Effect.succeed('')));
				if (text === '') {
					entries.push({ id, directory: dir, metadata: null });
					continue;
				}
				const decoded = yield* decodeJsonText(SnapshotMetadataSchema, text, {
					source: metaPath,
					mkError: () => null,
				}).pipe(Effect.catch(() => Effect.succeed(null)));
				if (decoded !== null && parseSnapshotId(decoded.id) === null) {
					yield* Effect.logWarning(`ignoring snapshot metadata with unsafe id: ${decoded.id}`);
					entries.push({ id, directory: dir, metadata: null });
					continue;
				}
				entries.push({ id: parsedId, directory: dir, metadata: decoded });
			}
			return entries;
		}).pipe(Effect.withSpan('orchestrator.snapshot.list'));

		const del: SnapshotOrchestrator['delete'] = (id) =>
			Effect.gen(function* () {
				const snapshotId = yield* validateSnapshotId('delete', id);
				const fs = yield* FileSystem.FileSystem;
				const dir = `${paths.snapshotDir}/${snapshotId}`;
				yield* Effect.scoped(
					Effect.gen(function* () {
						yield* acquireStackLock(paths.stackLockFile);
						yield* fs.remove(dir, { recursive: true, force: true }).pipe(Effect.ignore);
					}),
				);
			}).pipe(Effect.withSpan('orchestrator.snapshot.delete'));

		const wipe: SnapshotOrchestrator['wipe'] = (args) =>
			Effect.gen(function* () {
				yield* Effect.scoped(
					Effect.gen(function* () {
						yield* acquireStackLock(paths.stackLockFile);
						yield* runWipe({
							labelMatch: { app: identity.app, stack: identity.stack },
							stackRoot: paths.stackRoot,
							stateFilePath: paths.stateFile,
							runtime,
							keepSnapshots: args.keepSnapshots,
							keepCache: args.keepCache,
						});
					}),
				);
			}).pipe(Effect.withSpan('orchestrator.snapshot.wipe.entry'));

		const wipePlan: SnapshotOrchestrator['wipePlan'] = (args) =>
			// Read-only: no stack-lock / reservation. `planWipe` only lists
			// matching containers and reads the stack-root directory, so it
			// is safe to run without serializing against peers (a concurrent
			// mutation just makes the preview slightly stale — acceptable for
			// a dry-run estimate).
			planWipe({
				labelMatch: { app: identity.app, stack: identity.stack },
				stackRoot: paths.stackRoot,
				stateFilePath: paths.stateFile,
				runtime,
				keepSnapshots: args.keepSnapshots,
				keepCache: args.keepCache,
			}).pipe(Effect.withSpan('orchestrator.snapshot.wipe.plan.entry'));

		const prune: SnapshotOrchestrator['prune'] = () =>
			Effect.scoped(
				Effect.gen(function* () {
					yield* acquireReservation(paths.snapshotReservationFile, ownStartTime());
					return yield* runPrune({
						stackRoot: paths.stackRoot,
						imageLabelFilter: { app: identity.app, stack: identity.stack },
						runtime,
					});
				}),
			).pipe(Effect.withSpan('orchestrator.snapshot.prune.entry'));

		const recoverPendingRestoreImpl: SnapshotOrchestrator['recoverPendingRestore'] =
			recoverPendingRestore(paths.stackRoot, runtime).pipe(
				Effect.withSpan('orchestrator.snapshot.recover-pending.entry'),
			);

		return SnapshotOrchestratorService.of({
			registerParticipant,
			capture,
			restore,
			list,
			delete: del,
			wipe,
			wipePlan,
			prune,
			recoverPendingRestore: recoverPendingRestoreImpl,
		});
	}),
);
