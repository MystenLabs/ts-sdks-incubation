// Restore-pending marker — shared schema + IO between `restore.ts`
// (writer/clearer) and `recover-pending.ts` (reader/recoverer).
//
// Recovery contract:
//
//   The marker is written into the snapshot's staged tree BEFORE the
//   atomic stage-and-swap publish, then survives the swap into the
//   restored runtime root. After publish, `runRestore` runs the
//   Docker handoff (promote staged tags → recorded names, remove
//   captured managed containers) under `Effect.uninterruptible`. If
//   the process is hard-killed mid-handoff — or any step fails after
//   K of N images promoted — the marker stays on disk and lists which
//   `(targetImageName ← stagedImageTag, digest)` operations remain
//   pending. The digest is the loaded image's content-addressed
//   identity; the scanner falls back to it when the staging tag has
//   been pruned from the daemon between crash and restart.
//
//   On the next supervise startup, `recoverPendingRestore` reads the
//   marker, retries each pending entry's `tagImage`, removes the
//   marker only when every entry verifies, and is idempotent: a
//   marker present with zero outstanding entries is treated as
//   already-recovered and cleared in one call.
//
//   The marker is updated AFTER EACH successful image promote in the
//   happy path (see `restore.ts:promoteStagedImages`) so the
//   recovery scanner only has to address the entries still listed —
//   it never has to know which of the original N images was the one
//   that failed.

import { Effect, FileSystem, Schema } from 'effect';

import type { SnapshotMetadata } from './descriptor.ts';

export const SNAPSHOT_RESTORE_PENDING_VERSION = 2 as const;
export const RESTORE_PENDING_FILE_NAME = 'snapshot.restore-pending.json' as const;

export const RestorePendingContainerSchema = Schema.Struct({
	plugin: Schema.String,
	role: Schema.String,
	targetImageName: Schema.String,
	stagedImageTag: Schema.String,
	/** Content-addressed image identity (e.g. `sha256:...`). The
	 *  scanner uses this as the third-and-final recovery source when
	 *  both `targetImageName` and `stagedImageTag` have been removed
	 *  from the daemon (e.g. operator `docker system prune` between
	 *  crash and restart). Digests survive prune because they ARE the
	 *  image — Docker can re-tag from any digest still backed by a
	 *  pinned layer. */
	digest: Schema.String,
});
export type RestorePendingContainer = Schema.Schema.Type<typeof RestorePendingContainerSchema>;

export const RestorePendingDocumentSchema = Schema.Struct({
	version: Schema.Literal(SNAPSHOT_RESTORE_PENDING_VERSION),
	snapshotId: Schema.String,
	artifactDir: Schema.String,
	app: Schema.String,
	stack: Schema.String,
	network: Schema.String,
	containers: Schema.Array(RestorePendingContainerSchema),
});
export type RestorePendingDocument = Schema.Schema.Type<typeof RestorePendingDocumentSchema>;

/** Path the marker lives at, relative to a runtime stack root or
 *  staged-tree root. */
export const pendingMarkerPath = (root: string): string =>
	`${root}/${RESTORE_PENDING_FILE_NAME}`;

/** Failure shape for marker IO. The scanner / restore both map this
 *  onto their own typed channels. */
export class RestorePendingMarkerIoError extends Schema.TaggedErrorClass<RestorePendingMarkerIoError>()(
	'SnapshotRestorePendingMarkerIoError',
	{
		op: Schema.Literals(['read', 'write', 'remove', 'decode']),
		path: Schema.String,
		detail: Schema.String,
		cause: Schema.optional(Schema.Defect),
	},
) {}

/** Write or rewrite the marker. The serialized payload is one trailing
 *  newline larger than `JSON.stringify(doc, null, 2)`. */
export const writePendingMarker = (
	root: string,
	doc: RestorePendingDocument,
): Effect.Effect<void, RestorePendingMarkerIoError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = pendingMarkerPath(root);
		yield* fs.writeFileString(path, `${JSON.stringify(doc, null, 2)}\n`).pipe(
			Effect.catch(
				(cause): Effect.Effect<never, RestorePendingMarkerIoError> =>
					Effect.fail(
						new RestorePendingMarkerIoError({
							op: 'write',
							path,
							detail: `write ${RESTORE_PENDING_FILE_NAME} failed`,
							cause,
						}),
					),
			),
		);
	});

/** Build a marker document from the snapshot metadata + outstanding
 *  per-image entries. Caller decides what's outstanding. */
export const makePendingMarkerDocument = (args: {
	readonly meta: SnapshotMetadata;
	readonly artifactDir: string;
	readonly containers: ReadonlyArray<RestorePendingContainer>;
}): RestorePendingDocument => ({
	version: SNAPSHOT_RESTORE_PENDING_VERSION,
	snapshotId: args.meta.id,
	artifactDir: args.artifactDir,
	app: args.meta.app,
	stack: args.meta.stack,
	network: args.meta.network,
	containers: args.containers,
});

/** Rewrite an existing marker, replacing the `containers` list.
 *  The recovery scanner uses this to whittle the outstanding entry
 *  list down as it retags each image — the next supervise (or the
 *  next loop iteration after a transient daemon hiccup) sees an
 *  up-to-date marker without re-deriving identity from `meta.json`. */
export const rewritePendingMarkerContainers = (
	doc: RestorePendingDocument,
	containers: ReadonlyArray<RestorePendingContainer>,
): RestorePendingDocument => ({
	...doc,
	containers,
});

/** Remove the marker. Idempotent — `force: true` swallows "already
 *  gone". Other IO failures surface as `RestorePendingMarkerIoError`. */
export const removePendingMarker = (
	root: string,
): Effect.Effect<void, RestorePendingMarkerIoError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = pendingMarkerPath(root);
		yield* fs.remove(path, { force: true }).pipe(
			Effect.catch(
				(cause): Effect.Effect<never, RestorePendingMarkerIoError> =>
					Effect.fail(
						new RestorePendingMarkerIoError({
							op: 'remove',
							path,
							detail: `remove ${RESTORE_PENDING_FILE_NAME} failed`,
							cause,
						}),
					),
			),
		);
	});
