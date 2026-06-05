// Interrupted-restore sentinel + boot-time auto-recovery.
//
// THE GAP this closes:
//
//   `runRestore` (restore.ts) does the staged→target image promotion
//   (`promoteStagedImages`) + captured-container removal inside an
//   `Effect.uninterruptible` block AFTER the atomic stage-and-swap has
//   already published the new runtime root. `Effect.uninterruptible`
//   guards against an Effect-level interrupt — it does NOT survive a
//   SIGKILL / power-loss. A hard kill mid-promotion therefore leaves the
//   swap published (new host-tree + control files live) but the images
//   only PARTIALLY promoted (a prefix re-tagged to their target names,
//   the rest still at staging tags or gone), and the scope finalizer
//   never runs to clean up. On the next boot there was previously NO
//   breadcrumb, so the half-promotion was unrecoverable without manual
//   `docker tag` surgery.
//
// THE FIX (this module):
//
//   A typed sentinel is written into the STAGED tree IMMEDIATELY BEFORE
//   the atomic swap, so publishing the swap atomically publishes the
//   sentinel too (it rides the same `rename(staging → runtimeStackRoot)`;
//   see `fs-plan.ts` `runSwapTree` → `stageAndSwap` step 3). On the
//   success path restore CLEARS the sentinel the instant the
//   promotion+removal handoff completes. So:
//
//     - a CLEAN restore leaves NO sentinel (boot never loops);
//     - a hard kill BEFORE the swap landed leaves no published sentinel
//       (the staging tree was discarded), and the live root is untouched
//       — nothing to recover;
//     - a hard kill AFTER the swap but mid-promotion leaves the sentinel
//       LIVE, so the next boot's `recoverInterruptedRestore` re-runs the
//       restore for that snapshot id.
//
//   Recovery is idempotent because the on-disk snapshot artifact is
//   preserved across restores (it lives under `<stackRoot>/snapshots/`,
//   which is on the restore preserve list) and survives a `docker system
//   prune` (re-staging re-loads the image bundle from the artifact tar).
//   Re-running `runRestore` re-stages, re-promotes, and re-removes from
//   scratch; a still-failing artifact simply leaves the sentinel in place
//   for the next boot to retry (documented loop-safety below).

import { Effect, FileSystem, Schema } from 'effect';

import { decodeUnknown, parseJsonText } from '../../substrate/runtime/runtime-decode.ts';
import { versionedDocSchema } from '../../substrate/versioned-doc-schema.ts';
import { parseSnapshotId, type SnapshotId } from './descriptor.ts';

// -----------------------------------------------------------------------------
// Sentinel layout + schema
// -----------------------------------------------------------------------------

/** Fixed hidden filename for the interrupted-restore sentinel. Written at
 *  the ROOT of the staged tree (and therefore at the root of the live
 *  runtime stack root after the swap lands). Hidden + dotted so it never
 *  collides with a plugin's runtime subtree and is visually distinct from
 *  the operator's content. */
export const RESTORE_SENTINEL_FILE_NAME = '.devstack-restore-in-progress.json';

export const SNAPSHOT_RESTORE_SENTINEL_VERSION = 1 as const;

/** The interrupted-restore sentinel record. Carries exactly what
 *  re-running the restore needs: the snapshot id (the orchestrator
 *  derives the artifact dir from it) plus the resolved artifact dir as a
 *  cross-check / diagnostic (the snapshots subtree rides the same atomic
 *  swap, so the artifact at this path is preserved across the restore). */
export const RestoreSentinelSchema = versionedDocSchema(SNAPSHOT_RESTORE_SENTINEL_VERSION, {
	snapshotId: Schema.String,
	artifactDir: Schema.String,
});
export type RestoreSentinel = Schema.Schema.Type<typeof RestoreSentinelSchema>;

const sentinelPath = (root: string): string => `${root}/${RESTORE_SENTINEL_FILE_NAME}`;

// -----------------------------------------------------------------------------
// Write / read / clear
// -----------------------------------------------------------------------------

/** Write the sentinel JSON into the STAGED tree root at the fixed hidden
 *  path so it rides the atomic stage-and-swap into the live runtime root.
 *  Called from `runRestore` immediately before `executeFsPlan` publishes
 *  the swap. Encode validates the payload against the schema (the
 *  `version` discriminator is supplied here). */
export const writeRestoreSentinel = (
	stagedRoot: string,
	payload: { readonly snapshotId: SnapshotId; readonly artifactDir: string },
): Effect.Effect<void, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const doc: RestoreSentinel = {
			version: SNAPSHOT_RESTORE_SENTINEL_VERSION,
			snapshotId: payload.snapshotId,
			artifactDir: payload.artifactDir,
		};
		// Best-effort: the sentinel is an OPTIMIZATION for crash recovery, not
		// a correctness gate on the restore path. A write failure here must NOT
		// abort the restore (which would be a worse outcome than the gap the
		// sentinel closes); it just means a hard kill in the tiny window that
		// follows would be unrecoverable, exactly as before. Log loud and
		// proceed.
		yield* fs
			.writeFileString(sentinelPath(stagedRoot), JSON.stringify(doc))
			.pipe(
				Effect.catch((cause) =>
					Effect.logWarning(
						`restore sentinel write failed at ${sentinelPath(stagedRoot)} — a hard kill ` +
							`mid-promotion would be unrecoverable for snapshot ${payload.snapshotId}: ${String(cause)}`,
					),
				),
			);
	});

/** Read the sentinel from the LIVE runtime root. Returns `null` when the
 *  sentinel is absent (the common case — no interrupted restore) or
 *  present-but-unparseable (logged, then treated as absent so a corrupt
 *  breadcrumb cannot wedge boot; the operator can recover manually). */
export const readRestoreSentinel = (
	liveRoot: string,
): Effect.Effect<RestoreSentinel | null, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = sentinelPath(liveRoot);
		const exists = yield* fs.exists(path).pipe(Effect.catch(() => Effect.succeed(false)));
		if (!exists) return null;
		const readExit = yield* Effect.exit(fs.readFileString(path));
		if (readExit._tag === 'Failure') {
			yield* Effect.logWarning(
				`restore sentinel read failed at ${path}; treating as absent (no auto-recovery)`,
			);
			return null;
		}
		const decodeExit = yield* Effect.exit(
			parseJsonText(readExit.value, {
				source: path,
				mkError: (issue) => issue,
			}).pipe(
				Effect.flatMap((raw) =>
					decodeUnknown(RestoreSentinelSchema, raw, { source: path, mkError: (issue) => issue }),
				),
			),
		);
		if (decodeExit._tag === 'Failure') {
			yield* Effect.logWarning(
				`restore sentinel at ${path} is unparseable; treating as absent (no auto-recovery)`,
			);
			return null;
		}
		return decodeExit.value;
	});

/** Remove the sentinel from the LIVE runtime root. Idempotent
 *  (`force: true`) — a missing sentinel is a no-op. Called on the restore
 *  success path the instant the promotion+removal handoff completes, and
 *  again after a successful auto-recovery re-run. */
export const clearRestoreSentinel = (
	liveRoot: string,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		yield* fs.remove(sentinelPath(liveRoot), { force: true }).pipe(Effect.ignore);
	});

// -----------------------------------------------------------------------------
// Boot-time recovery
// -----------------------------------------------------------------------------

export interface RecoverInterruptedRestoreDeps {
	/** The LIVE runtime stack root (`StackPathsService.stackRoot`) the
	 *  sentinel rode into after the interrupted restore's swap. */
	readonly liveRoot: string;
	/** Re-run the restore for a snapshot id. Wired by the caller to the
	 *  orchestrator's `restore({ id })`, which owns the `stack.lock`
	 *  discipline and the participant/runtime deps — re-running it is
	 *  idempotent (re-stages from the preserved on-disk artifact). The
	 *  return value is ignored; the recovery only cares whether it
	 *  succeeded. The `FileSystem` requirement unifies with this module's
	 *  own (boot provides it once), so the caller can pass the
	 *  orchestrator's `restore` verb directly. */
	readonly restoreSnapshot: (
		snapshotId: SnapshotId,
	) => Effect.Effect<unknown, unknown, FileSystem.FileSystem>;
}

/**
 * Boot-time auto-recovery for a restore interrupted by a hard kill /
 * power-loss between the atomic swap and the end of the image-promotion
 * handoff. Reads the sentinel from the live runtime root; when present,
 * logs a clear "resuming interrupted restore <id>" and re-invokes the
 * restore for that snapshot. No-op when the sentinel is absent.
 *
 * Wired at boot BEFORE the first plugin acquire (the `beforeInitialAcquire`
 * hook), so a half-promoted image set is reconciled before any L2 lookup
 * observes the runtime root.
 *
 * ## Loop-safety
 *
 *   - A CLEAN restore cleared the sentinel on its success path, so a clean
 *     boot reads `null` and returns immediately — boot never loops.
 *   - A SUCCESSFUL recovery clears the sentinel after the re-run returns,
 *     so the next boot is clean.
 *   - A STILL-FAILING artifact (re-run fails) DELIBERATELY leaves the
 *     sentinel in place so the next boot retries. The failure is logged
 *     and SWALLOWED — boot continues rather than wedging — but the
 *     sentinel persists as the durable retry breadcrumb. This is the
 *     intended trade: a genuinely corrupt artifact will re-fail every boot
 *     (surfaced by the warning + the restore's own typed phase error in
 *     the logs) rather than silently dropping the recovery intent. An
 *     operator resolves it by repairing/removing the artifact or clearing
 *     the sentinel by hand.
 */
export const recoverInterruptedRestore = (
	deps: RecoverInterruptedRestoreDeps,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const sentinel = yield* readRestoreSentinel(deps.liveRoot);
		if (sentinel === null) return;

		const snapshotId = parseSnapshotId(sentinel.snapshotId);
		if (snapshotId === null) {
			// A sentinel whose id is unsafe can't drive a restore (the
			// orchestrator would reject it anyway). Clear it so it doesn't
			// re-trigger this branch every boot, and log loud.
			yield* Effect.logWarning(
				`interrupted-restore sentinel carries an unsafe snapshot id (${sentinel.snapshotId}); ` +
					`clearing it — no auto-recovery possible`,
			);
			yield* clearRestoreSentinel(deps.liveRoot);
			return;
		}

		yield* Effect.logInfo(
			`resuming interrupted restore ${snapshotId} (sentinel at ${deps.liveRoot}/${RESTORE_SENTINEL_FILE_NAME})`,
		).pipe(Effect.annotateLogs({ 'devstack.snapshot.id': snapshotId }));

		const exit = yield* Effect.exit(deps.restoreSnapshot(snapshotId));
		if (exit._tag === 'Failure') {
			// Leave the sentinel for the next boot's retry (loop-safety doc
			// above). Swallow so boot continues — a failing recovery must not
			// wedge the stack.
			yield* Effect.logWarning(
				`interrupted-restore recovery for ${snapshotId} did not complete; leaving sentinel for ` +
					`the next boot to retry. Investigate the snapshot artifact if this recurs.`,
			);
			return;
		}

		// Recovery succeeded — `runRestore` cleared the sentinel on its own
		// success path, but clear again defensively (idempotent) so a code
		// path that ever skipped the in-restore clear cannot re-loop.
		yield* clearRestoreSentinel(deps.liveRoot);
		yield* Effect.logInfo(`interrupted restore ${snapshotId} recovered`).pipe(
			Effect.annotateLogs({ 'devstack.snapshot.id': snapshotId }),
		);
	});
