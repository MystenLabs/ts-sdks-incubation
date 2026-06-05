// Snapshot orchestrator service.
//
// Snapshotting is a parameterization of the lifecycle bounce, not a
// separate subsystem:
//
//   gracefully stop everything → snapshot (docker commit each container +
//   capture local files) / swap-in (restore) → resume if needed.
//
// The two mutate verbs (`capture`, `restore`) share that bounce; `list`,
// `delete`, `wipe`, `prune` are the catalog/teardown surface around it.
//
// Lock discipline: the bounce holds `stack.lock` for the (bounded,
// whole-stack-stopped) snapshot window. There is no separate snapshot
// reservation — the stop+commit window is bounded and the lock subsumes
// the concurrency guard while keeping the roster heartbeat from starving.
//
// The service surface is name-blind. The participant list is populated by
// the substrate at boot from the `Snapshotable` decls of registered
// plugins; service-specific behavior never reaches this file. Registration
// is scope-bound: the supervisor calls `registerParticipant(pluginKey,
// decl)` from inside each plugin's scope so the entry is reaped on teardown.

import { mintRandomSuffix } from '../../substrate/runtime/random-suffix.ts';

import { Context, Effect, FileSystem, Layer, Ref, Schema, Scope } from 'effect';

import type { SnapshotableDecl } from '../../contracts/snapshotable.ts';
import type { ContainerRuntime } from '../../contracts/container-runtime.ts';
import { ContainerRuntimeService } from '../../runtime/docker/index.ts';
import { decodeJsonText } from '../../substrate/runtime/runtime-decode.ts';
import {
	acquireStackLock,
	type StackLockError,
} from '../../substrate/runtime/cross-process/stack-lock.ts';
import { IdentityContext, StackPathsService } from '../../substrate/runtime/paths.ts';
import {
	runCapture,
	resumeAfterCapture,
	type CapturePhaseError,
	type SnapshotParticipant,
} from './capture.ts';
import {
	SnapshotDescriptorError,
	SnapshotLayout,
	SnapshotMetadataSchema,
	SNAPSHOT_ID_RULE,
	parseSnapshotId,
	type SnapshotId,
	type SnapshotCatalogEntry,
	type SnapshotGraphInputIdentity,
	type SnapshotMetadata,
} from './descriptor.ts';
import {
	type IdentityContributionConflictError,
	type IdentityGuardError,
} from './identity-guard.ts';
import { runPrune, type PruneResult, type PrunePhaseError } from './prune.ts';
import { runRestore, RestorePhaseError, type RestoreParticipant } from './restore.ts';
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
	| WipePhaseError
	| PrunePhaseError
	| IdentityGuardError
	| IdentityContributionConflictError
	| StageAndSwapError
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

	/** Capture a new snapshot — the lifecycle bounce: gather → graceful-stop
	 *  (flush) → commit + tar + meta → retag committed images onto original
	 *  names + hard-rm → resume (recreate + wait-write-ready). The id MAY be
	 *  caller-supplied; if omitted, the substrate mints a random suffix to
	 *  sidestep the concurrent-saves-against-same-id silent overwrite.
	 *
	 *  `resume` re-converges the stack to write-ready after the publish (the
	 *  supervisor wires it to a stack restart; omit on an offline one-shot
	 *  capture where the next boot is the resume).
	 *
	 *  `participants` overrides the registered set — primarily for tests.
	 *  Production callers omit it; the orchestrator reads the registered list. */
	readonly capture: (args: {
		readonly id?: string;
		readonly label?: string;
		readonly graphInput: SnapshotGraphInputIdentity;
		readonly participants?: ReadonlyArray<SnapshotParticipant>;
		readonly resume?: Effect.Effect<void>;
	}) => Effect.Effect<SnapshotMetadata, SnapshotOrchestratorError, FileSystem.FileSystem>;

	/** Restore from a captured artifact id — the destructive,
	 *  ordered half of the bounce: identity-guard fail-closed + cache-missing
	 *  preflight BEFORE any mutation → swap host-tree in + load images → hard-
	 *  rm → resume = recreate (the next boot / the injected converge). */
	readonly restore: (args: {
		readonly id: string;
		readonly currentGraphInput?: SnapshotGraphInputIdentity;
		readonly graphInputMismatchPolicy?: 'warn' | 'block';
		readonly participants?: ReadonlyArray<RestoreParticipant>;
		readonly resume?: Effect.Effect<void>;
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

	/** Wipe the live (`app`, `stack`) footprint; preserves the snapshot
	 *  catalog AND the deploy cache together by default (`keepSnapshots`,
	 *  default true). A hard reset (`keepSnapshots: false`) drops both so
	 *  on-chain artifacts re-prove against the next chain — there is no
	 *  asymmetric keep-snapshots-drop-cache degree of freedom. */
	readonly wipe: (args: {
		readonly keepSnapshots?: boolean;
	}) => Effect.Effect<void, SnapshotOrchestratorError, FileSystem.FileSystem>;

	/** Enumerate the concrete teardown targets a `wipe` of the same
	 *  `(app, stack)` would remove WITHOUT removing anything — the
	 *  read-only preview behind `devstack wipe --dry-run`. */
	readonly wipePlan: (args: {
		readonly keepSnapshots?: boolean;
	}) => Effect.Effect<WipeTargets, SnapshotOrchestratorError, FileSystem.FileSystem>;

	/** Prune the snapshot catalog (reaps partial artifacts) and sweeps
	 *  byproduct images via the runtime adapter's label-scoped cleanup. */
	readonly prune: () => Effect.Effect<
		PruneResult,
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

/** Per-plugin participant registration entry kept on the orchestrator's
 *  inner ref. Sequence number lets parallel registrations under the
 *  same key be reaped independently when their owning scopes close. */
interface RegisteredParticipantEntry {
	readonly pluginKey: string;
	readonly capture: SnapshotParticipant;
	readonly restore: RestoreParticipant;
	readonly seq: number;
}

/**
 * Wire the orchestrator from the substrate's path resolver + the runtime
 * container adapter.
 *
 * Discipline: capture/restore acquire `stack.lock` for the (bounded,
 * whole-stack-stopped) snapshot window; the `stageAndSwap` rename publishes
 * atomically inside it. List/delete/wipe/prune acquire `stack.lock` briefly
 * (they don't bounce containers).
 */
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

		// Scope-local participant registry. The supervisor adds entries from
		// each plugin's acquire scope; finalizers remove them on scope close.
		// Sequence number protects against the parallel-registration-same-key
		// race when two stack instances register concurrently.
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
			}) as Effect.Effect<void, never, Scope.Scope>;

		const capture: SnapshotOrchestrator['capture'] = ({
			id,
			label,
			graphInput,
			participants,
			resume,
		}) =>
			Effect.gen(function* () {
				const snapshotId =
					id === undefined ? yield* mintSnapshotId() : yield* validateSnapshotId('capture', id);
				const snapshotName = yield* normalizeSnapshotName('capture', label);
				const effectiveParticipants =
					participants ?? (yield* Ref.get(participantsRef)).map((e) => e.capture);
				const artifactDir = `${paths.snapshotDir}/${snapshotId}`;
				// Snapshot stages at the SNAPSHOT-DIR level (siblings of other
				// artifact dirs) so the `list` walker's `.staging.` / `.bak.`
				// prefix skip keeps transient dirs invisible.
				const stagingDir = `${paths.snapshotDir}/.staging.${snapshotId}`;
				const backupDir = `${paths.snapshotDir}/.bak.${snapshotId}`;

				// Hold `stack.lock` ONLY across the build+publish half of the
				// bounce (gather → graceful-stop → commit + tar + meta →
				// stage-and-swap). The lock subsumes the concurrency guard for
				// that bounded window while keeping the roster heartbeat from
				// starving.
				//
				// CRITICAL: the lock is RELEASED before the resume. The post-
				// publish resume re-converges the stack, and each plugin's
				// re-acquire takes `stack.lock` for its container-claim protocol
				// (runtime/docker/container.ts) — `stack.lock` is a non-reentrant
				// O_EXCL file lock, so holding it across the resume self-deadlocks:
				// the re-acquire's claim EEXISTs against THIS process's own still-
				// held lock, can't reclaim it (the holder PID is alive — us), and
				// times out after 5s → every plugin's `start` fails → the resume
				// comes back `failed` (sui RPC dead → `fetch failed`; codegen
				// contributions never re-register → empty `config.ts`). Scoping the
				// lock to the publish and running `resumeAfterCapture` AFTER it
				// releases lets the re-acquire claim containers normally.
				const meta = yield* Effect.scoped(
					Effect.gen(function* () {
						yield* acquireStackLock(paths.stackLockFile);
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
						// O(N) catalog scan for label uniqueness — N is small and
						// capture is human-paced. `list` is declared LATER in this
						// gen; no TDZ fires because `capture` is invoked only after
						// the outer gen has resolved all `const` bindings.
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

						// Build + publish the artifact (gather → stop → commit +
						// tar + meta), atomically via stage-and-swap so watchers /
						// `list` never observe a half-written tree.
						return yield* stageAndSwap({
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
								graphInput,
								runtimeStackRoot: paths.stackRoot,
								participants: effectiveParticipants,
								runtime,
							}),
						});
					}),
				);
				// Post-publish bounce tail — runs with `stack.lock` RELEASED (see
				// the CRITICAL note above) so the resume's per-plugin container
				// claims can take the lock. Retag committed images onto original
				// names + hard-rm + resume (recreate + wait-write-ready). Runs AFTER
				// the swap so a publish failure leaves the live stack only stopped
				// (recoverable by the next boot).
				yield* resumeAfterCapture(meta, {
					runtime,
					app: identity.app,
					stack: identity.stack,
					...(resume === undefined ? {} : { resume }),
				});
				return meta;
			});

		const restore: SnapshotOrchestrator['restore'] = ({
			id,
			currentGraphInput,
			graphInputMismatchPolicy,
			participants,
			resume,
		}) =>
			Effect.gen(function* () {
				const snapshotId = yield* validateSnapshotId('restore', id);
				const artifactDir = `${paths.snapshotDir}/${snapshotId}`;
					// The effective participant set is the live registered set (or an
					// explicit override). During startup restore, interrupted-restore
					// recovery, and offline CLI restore, no plugin has registered yet,
					// so this is EMPTY. `runRestore` reads an empty
				// participant set as "no live stack to compare against" and skips
				// ONLY the cross-plugin contribution guard (the runtime app/stack/
				// network guard + the snapshot-side emptiness refusal still fire).
				// A LIVE-supervisor restore (operator-triggered while the stack is up)
				// has a populated registered set, so the real contribution guard runs.
				const effectiveParticipants =
					participants ?? (yield* Ref.get(participantsRef)).map((e) => e.restore);
				// Hold `stack.lock` ONLY across the destructive swap+load+hard-rm
				// half of the bounce — the resume is run AFTER the lock releases.
				// The resume re-converges the stack and each plugin's re-acquire
				// takes `stack.lock` for its container-claim protocol; `stack.lock`
				// is a non-reentrant O_EXCL file lock, so holding it across the
				// resume self-deadlocks (the claim EEXISTs against this process's
				// own live lock and times out → every plugin fails). The offline
				// restore omits `resume` (the next boot is the resume), so this only
				// matters for a live-supervisor restore — but keep both bounce verbs
				// consistent: lock the publish, resume unlocked. So `runRestore` runs
				// WITHOUT `resume`, and we run the injected resume below, unlocked.
				const meta = yield* Effect.scoped(
					Effect.gen(function* () {
						yield* acquireStackLock(paths.stackLockFile);
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
							...(currentGraphInput === undefined ? {} : { currentGraphInput }),
							...(graphInputMismatchPolicy === undefined ? {} : { graphInputMismatchPolicy }),
						});
					}),
				);
				// Resume with `stack.lock` RELEASED so the re-converge's per-plugin
				// container claims can take the lock (see the note above). Omitted
				// on the offline restore (the next boot is the resume).
				if (resume !== undefined) {
					yield* resume.pipe(
						Effect.mapError(
							(cause) =>
								new RestorePhaseError({
									phase: 'resume',
									detail: 'stack resume after restore failed',
									cause,
								}),
						),
					);
				}
				return meta;
			});

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
				// Skip transient staging/backup directories — invisible to the
				// catalog by construction (the `.staging.<id>` / `.bak.<id>` naming).
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
		});

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
			});

		const wipe: SnapshotOrchestrator['wipe'] = (args) =>
			Effect.gen(function* () {
				yield* Effect.scoped(
					Effect.gen(function* () {
						yield* acquireStackLock(paths.stackLockFile);
						yield* runWipe({
							labelMatch: { app: identity.app, stack: identity.stack },
							stackRoot: paths.stackRoot,
							runtime,
							keepSnapshots: args.keepSnapshots,
						});
					}),
				);
			});

		const wipePlan: SnapshotOrchestrator['wipePlan'] = (args) =>
			// Read-only: no stack-lock. `planWipe` only lists matching
			// containers and reads the stack-root directory, so it is safe to
			// run without serializing against peers (a concurrent mutation just
			// makes the preview slightly stale — acceptable for a dry-run).
			planWipe({
				labelMatch: { app: identity.app, stack: identity.stack },
				stackRoot: paths.stackRoot,
				runtime,
				keepSnapshots: args.keepSnapshots,
			});

		const prune: SnapshotOrchestrator['prune'] = () =>
			Effect.scoped(
				Effect.gen(function* () {
					yield* acquireStackLock(paths.stackLockFile);
					return yield* runPrune({
						stackRoot: paths.stackRoot,
						imageLabelFilter: { app: identity.app, stack: identity.stack },
						runtime,
					});
				}),
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
		});
	}),
);
