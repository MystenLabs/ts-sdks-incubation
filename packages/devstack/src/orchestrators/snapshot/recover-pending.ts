// Restore-pending recovery scanner.
//
// Recovery contract (mirrors the writer in `pending-marker.ts`):
//
//   1. The supervise startup hook calls `recoverPendingRestore` before
//      any plugin acquire fires, so a half-promoted set of images is
//      reconciled before any L2 lookup observes the runtime root.
//   2. The scanner reads `${stackRoot}/snapshot.restore-pending.json`.
//      Absent marker → no recovery needed, return immediately.
//   3. For each outstanding entry it asks the runtime to tag the
//      source onto the target name (`removeSourceAfterTag: true`).
//      The source is resolved by trying, in order: (a) the staging
//      tag, (b) the digest. The digest fallback covers the case
//      where Docker has dropped the staging tag too (e.g. operator
//      `docker system prune` between crash and restart) — the digest
//      is the image's content-addressed identity and survives prune.
//      Successful tag → entry recovered; rewrite the marker with the
//      entry removed.
//   4. When the outstanding list reaches zero, remove the marker.
//   5. On per-entry failure: keep the entry in the marker so the
//      next supervise retries. The scanner returns a typed summary
//      so the supervisor can surface the partial-recovery state
//      without crashing the boot path.
//
// Idempotency: a marker with `containers: []` is treated as
// already-recovered and removed in one call. Re-running the scanner
// against a marker for an image that has already been tagged by an
// out-of-band operator is also safe — `tagImage` is idempotent on the
// happy path and the failure on a missing staged source is treated
// as "entry already recovered" if the target image is now visible.
//
// The scanner sits next to `restore.ts` and shares the marker
// schema/IO with it via `pending-marker.ts`. The supervisor calls in
// via `SnapshotOrchestratorService.recoverPendingRestore`, so the L1
// docker layer requirement is satisfied through the existing service
// composition — no new substrate plumbing.

import { Effect, FileSystem, Schema } from 'effect';

import type { ContainerRuntime } from '../../contracts/container-runtime.ts';
import { decodeUnknown, parseJsonText } from '../../substrate/runtime/runtime-decode.ts';
import {
	pendingMarkerPath,
	removePendingMarker,
	RestorePendingMarkerIoError,
	RestorePendingDocumentSchema,
	rewritePendingMarkerContainers,
	SNAPSHOT_RESTORE_PENDING_VERSION,
	writePendingMarker,
	type RestorePendingContainer,
	type RestorePendingDocument,
} from './pending-marker.ts';

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/** Tagged failure surfaced by the recovery scanner. The `kind`
 *  discriminator lets the supervisor decide how to react: a corrupt
 *  marker is investigable but not fatal (the operator can repair the
 *  Docker side manually); a Docker daemon outage is transient. */
export class RestorePendingRecoveryError extends Schema.TaggedErrorClass<RestorePendingRecoveryError>()(
	'SnapshotRestorePendingRecoveryError',
	{
		kind: Schema.Literals(['marker-io', 'marker-decode', 'retag', 'rewrite']),
		detail: Schema.String,
		path: Schema.optional(Schema.String),
		entry: Schema.optional(
			Schema.Struct({
				plugin: Schema.String,
				role: Schema.String,
				targetImageName: Schema.String,
				stagedImageTag: Schema.String,
				digest: Schema.String,
			}),
		),
		cause: Schema.optional(Schema.Defect),
	},
) {}

// -----------------------------------------------------------------------------
// Summary surface
// -----------------------------------------------------------------------------

export interface RestorePendingRecoverySummary {
	/** True when no marker was present at the runtime root. */
	readonly noMarker: boolean;
	/** Snapshot id whose restore was interrupted; null when noMarker. */
	readonly snapshotId: string | null;
	/** Number of pending entries the scanner observed. */
	readonly inspected: number;
	/** Number of entries successfully retagged. */
	readonly recovered: number;
	/** Entries still pending after the scanner finished. Empty in the
	 *  happy path; populated when one or more retags failed. */
	readonly stillPending: ReadonlyArray<RestorePendingContainer>;
	/** True when the marker was removed (every entry recovered or
	 *  marker started empty). */
	readonly markerCleared: boolean;
}

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

/** Result of peeking at a marker on disk. We split version-detection
 *  from schema decode so a stale pre-upgrade marker (no `digest` per
 *  entry) can be surfaced as "skip with warning" rather than as a
 *  decode failure — the scanner has no safe way to recover a v1
 *  marker (the digest is the only identity that survives
 *  `docker system prune`, and v1 didn't persist it). */
type ReadMarkerResult =
	| { readonly kind: 'absent' }
	| { readonly kind: 'unsupported-version'; readonly version: unknown; readonly path: string }
	| { readonly kind: 'present'; readonly doc: RestorePendingDocument };

const readMarker = (
	stackRoot: string,
): Effect.Effect<ReadMarkerResult, RestorePendingRecoveryError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = pendingMarkerPath(stackRoot);
		const exists = yield* fs.exists(path).pipe(Effect.catch(() => Effect.succeed(false)));
		if (!exists) return { kind: 'absent' } as const;
		const text = yield* fs.readFileString(path).pipe(
			Effect.catch(
				(cause): Effect.Effect<never, RestorePendingRecoveryError> =>
					Effect.fail(
						new RestorePendingRecoveryError({
							kind: 'marker-io',
							path,
							detail: `read pending marker failed`,
							cause,
						}),
					),
			),
		);
		const raw = yield* parseJsonText(text, {
			source: path,
			mkError: (issue) =>
				new RestorePendingRecoveryError({
					kind: 'marker-decode',
					path,
					detail: `pending marker is not valid JSON`,
					cause: issue.cause,
				}),
		});
		// Version-peek BEFORE the full schema decode so a stale
		// pre-upgrade marker can be skipped cleanly. The schema
		// requires the current version literal, so without this peek
		// every v1 marker would surface as `marker-decode` and the
		// supervisor would have no way to distinguish "stale upgrade
		// artifact" from "corrupt on-disk JSON".
		const peekedVersion =
			typeof raw === 'object' && raw !== null && 'version' in raw
				? (raw as { readonly version: unknown }).version
				: undefined;
		if (peekedVersion !== SNAPSHOT_RESTORE_PENDING_VERSION) {
			return {
				kind: 'unsupported-version',
				version: peekedVersion,
				path,
			} as const;
		}
		const doc = yield* decodeUnknown(RestorePendingDocumentSchema, raw, {
			source: path,
			mkError: (issue) =>
				new RestorePendingRecoveryError({
					kind: 'marker-decode',
					path,
					detail: `pending marker failed schema decode`,
					cause: issue.cause,
				}),
		});
		return { kind: 'present', doc } as const;
	});

const rewriteMarker = (
	stackRoot: string,
	doc: RestorePendingDocument,
	stillPending: ReadonlyArray<RestorePendingContainer>,
): Effect.Effect<void, RestorePendingRecoveryError, FileSystem.FileSystem> =>
	writePendingMarker(stackRoot, rewritePendingMarkerContainers(doc, stillPending)).pipe(
		Effect.catchTag('SnapshotRestorePendingMarkerIoError', (err: RestorePendingMarkerIoError) =>
			Effect.fail(
				new RestorePendingRecoveryError({
					kind: 'rewrite',
					path: err.path,
					detail: err.detail,
					cause: err.cause,
				}),
			),
		),
	);

/** Attempt to re-tag the target image from each known identity in
 *  decreasing-likelihood-of-success order:
 *
 *    1. `stagedImageTag` — what the original promote loop was retagging
 *       from. Survives the simplest crash (no Docker mutation between
 *       crash and restart).
 *    2. `digest` — the loaded image's content-addressed identity.
 *       Survives `docker system prune` because the digest IS the image:
 *       any pinned layer keeps the image accessible by digest even
 *       after every tag pointing at it has been removed.
 *
 *  Recovery is best-effort per entry — a fully missing source (both
 *  tag and digest gone) almost always means a previous recovery
 *  already promoted this entry and a stale marker simply hasn't been
 *  rewritten. We swallow the error and leave the entry in
 *  `stillPending` for the next supervise to surface; the supervisor
 *  logs the partial-recovery state via the returned summary. */
const tryRecoverEntry = (
	entry: RestorePendingContainer,
	runtime: ContainerRuntime,
): Effect.Effect<boolean> =>
	Effect.gen(function* () {
		// The contract's docker impl resolves `tag ?? digest`, so when
		// we want to address by digest we MUST pass `tag: undefined`
		// (omitting the field) — otherwise the staged tag would still
		// win the resolution race and we'd be re-running attempt #1.
		const stagedFirst = yield* runtime
			.tagImage(
				{ digest: entry.digest, tag: entry.stagedImageTag },
				entry.targetImageName,
				{ removeSourceAfterTag: true },
			)
			.pipe(
				Effect.as(true as const),
				Effect.catch(() => Effect.succeed(false as const)),
			);
		if (stagedFirst) return true;
		const digestFallback = yield* runtime
			.tagImage(
				{ digest: entry.digest },
				entry.targetImageName,
				{ removeSourceAfterTag: true },
			)
			.pipe(
				Effect.as(true as const),
				Effect.catch(() => Effect.succeed(false as const)),
			);
		return digestFallback;
	});

// -----------------------------------------------------------------------------
// Public entry point
// -----------------------------------------------------------------------------

/** Read the restore-pending marker for this stack root and retry any
 *  outstanding image promotions. Idempotent. The supervisor calls this
 *  BEFORE any plugin acquire, so a half-promoted snapshot restore is
 *  reconciled before L2 lookups observe the runtime tree.
 *
 *  Returns a typed summary instead of failing on partial recovery —
 *  the supervisor surfaces "marker remains, N entries outstanding"
 *  via the cascade-formatter so the operator can decide whether to
 *  re-restore or repair Docker out of band. Only marker IO/decode
 *  failures escape as `RestorePendingRecoveryError`. */
export const recoverPendingRestore = (
	stackRoot: string,
	runtime: ContainerRuntime,
): Effect.Effect<
	RestorePendingRecoverySummary,
	RestorePendingRecoveryError,
	FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const result = yield* readMarker(stackRoot);
		if (result.kind === 'absent') {
			return {
				noMarker: true,
				snapshotId: null,
				inspected: 0,
				recovered: 0,
				stillPending: [],
				markerCleared: false,
			} as const;
		}
		if (result.kind === 'unsupported-version') {
			// Pre-upgrade marker — the schema bumped to v2 to add the
			// `digest` field per entry, and a v1 marker without
			// digests can't be safely recovered (digest is the only
			// identity that survives `docker system prune`). Log a
			// warning and leave the marker alone so the operator can
			// inspect / manually clean up. We treat this as
			// "no recovery needed" from the supervisor's perspective.
			yield* Effect.logWarning(
				`snapshot restore-pending marker at ${result.path} has unsupported version ${String(
					result.version,
				)} (expected ${SNAPSHOT_RESTORE_PENDING_VERSION}); leaving on disk for operator review`,
			);
			return {
				noMarker: true,
				snapshotId: null,
				inspected: 0,
				recovered: 0,
				stillPending: [],
				markerCleared: false,
			} as const;
		}
		const doc = result.doc;

		yield* Effect.annotateCurrentSpan({
			'devstack.snapshot.recovery.snapshotId': doc.snapshotId,
			'devstack.snapshot.recovery.pending': doc.containers.length,
		});

		const stillPending: RestorePendingContainer[] = [];
		let recovered = 0;
		for (let i = 0; i < doc.containers.length; i += 1) {
			const entry = doc.containers[i]!;
			const ok = yield* tryRecoverEntry(entry, runtime);
			if (ok) {
				recovered += 1;
			} else {
				stillPending.push(entry);
			}
			// Rewrite-after-each so a crash mid-recovery doesn't lose
			// the work-so-far. The new marker carries the still-pending
			// entries plus everything we haven't tried yet. Cheap (one
			// write per image, rare path).
			const remaining: RestorePendingContainer[] = [
				...stillPending,
				...doc.containers.slice(i + 1),
			];
			if (remaining.length > 0 && remaining.length !== doc.containers.length) {
				yield* rewriteMarker(stackRoot, doc, remaining);
			}
		}

		let markerCleared = false;
		if (stillPending.length === 0) {
			yield* removePendingMarker(stackRoot).pipe(
				Effect.catchTag(
					'SnapshotRestorePendingMarkerIoError',
					(err: RestorePendingMarkerIoError) =>
						Effect.fail(
							new RestorePendingRecoveryError({
								kind: 'marker-io',
								path: err.path,
								detail: err.detail,
								cause: err.cause,
							}),
						),
				),
			);
			markerCleared = true;
		} else {
			// Final rewrite — the per-loop rewrite covers crash-during-
			// recovery, this one covers the steady-state "we finished
			// the loop and some entries are still pending".
			yield* rewriteMarker(stackRoot, doc, stillPending);
		}

		return {
			noMarker: false,
			snapshotId: doc.snapshotId,
			inspected: doc.containers.length,
			recovered,
			stillPending,
			markerCleared,
		} as const;
	}).pipe(Effect.withSpan('orchestrator.snapshot.recover-pending'));
