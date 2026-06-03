// Stale restore-pending marker tolerance.
//
// The crash-recovery marker subsystem (the recovery scanner + its marker
// schema/IO module) was deleted in Stage D2. Restore now leaves each
// promoted image at its captured TARGET name, so the next boot's
// image-match adoption (`decideRunAction` in `runtime/docker/container.ts`)
// re-runs the deploy from the local image with no scanner and no on-disk
// marker.
//
// A pre-D2 binary that crashed mid image-promotion may have left a v2
// `snapshot.restore-pending.json` on disk. The new boot path TOLERATES
// it: we unlink it best-effort before any plugin acquire, WITHOUT parsing
// it. Removing the file is safe because adoption-by-name no longer depends
// on it; leaving it would only be inert clutter.

import { Effect, type FileSystem } from 'effect';

/** Filename of the legacy restore-pending marker, relative to the stack
 *  root. Inlined here (the dedicated marker schema/IO module is gone). */
export const RESTORE_PENDING_FILE_NAME = 'snapshot.restore-pending.json';

/** Best-effort unlink of a stale pre-D2 restore-pending marker at
 *  `<stackRoot>/snapshot.restore-pending.json`. Never fails: a missing
 *  file or an unlink error is swallowed (the marker is no longer
 *  load-bearing). Logs a one-line note when a marker was actually
 *  removed so the operator can see the pre-D2 → D2 transition. */
export const clearStaleRestoreMarker = (
	fs: FileSystem.FileSystem,
	stackRoot: string,
): Effect.Effect<void> =>
	Effect.gen(function* () {
		const path = `${stackRoot}/${RESTORE_PENDING_FILE_NAME}`;
		const exists = yield* fs.exists(path).pipe(Effect.catch(() => Effect.succeed(false)));
		if (!exists) return;
		yield* fs.remove(path).pipe(
			Effect.matchEffect({
				onSuccess: () => Effect.logInfo('cleared stale restore marker'),
				onFailure: () => Effect.void,
			}),
		);
	}).pipe(Effect.withSpan('cli.wirings.clear-stale-restore-marker'));
