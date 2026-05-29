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
//      entry removed. When BOTH source attempts fail the scanner
//      probes whether `targetImageName` is already visible (a prior
//      recovery may have promoted it); if so the entry is treated as
//      recovered, otherwise it stays pending.
//   4. When the outstanding list reaches zero, remove the marker.
//   5. On a genuine per-entry failure (both sources gone AND the
//      target not yet visible — e.g. a transient daemon error): keep
//      the entry in the marker so the next supervise retries. The
//      scanner returns a typed summary so the supervisor can surface
//      the partial-recovery state without crashing the boot path.
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

/** Result of reading a marker on disk. `unsupported-version` covers
 *  stale pre-v2 markers whose schema can't safely be recovered (the
 *  v1 shape had no `digest` per entry, and digest is the only identity
 *  that survives `docker system prune`); the Union decode fails them
 *  cleanly and the scanner surfaces them as "leave on disk for
 *  operator review" rather than as a fatal decode error. */
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
		// The schema is a `Schema.Union` of every supported marker
		// version (currently just v2). We peek the discriminant before
		// the full Union decode so a stale pre-v2 (or future-v3)
		// marker is reported as `unsupported-version` rather than as a
		// schema-decode failure — the supervisor surfaces them
		// differently (operator-review vs corrupt-JSON). A blob whose
		// `version` matches a known arm but whose inner shape is
		// malformed still surfaces as `marker-decode`. Future v3
		// migration appends an arm to the Union in `pending-marker.ts`,
		// adds the literal to `SUPPORTED_MARKER_VERSIONS`, and adds a
		// matching `case` in the switch below.
		const peekedVersion =
			typeof raw === 'object' && raw !== null && 'version' in raw
				? (raw as { readonly version: unknown }).version
				: undefined;
		if (!SUPPORTED_MARKER_VERSIONS.has(peekedVersion as number)) {
			return {
				kind: 'unsupported-version',
				version: peekedVersion,
				path,
			} as const;
		}
		const decoded: RestorePendingDocument = yield* decodeUnknown(
			RestorePendingDocumentSchema,
			raw,
			{
				source: path,
				mkError: (issue) =>
					new RestorePendingRecoveryError({
						kind: 'marker-decode',
						path,
						detail: `pending marker failed schema decode`,
						cause: issue.cause,
					}),
			},
		);
		// Today the Union has one arm (v2). A future v3 migration adds a
		// `case 3:` arm here AND extends `SUPPORTED_MARKER_VERSIONS`; the
		// unsupported-version branch becomes reachable once the Union
		// grows. With a single-arm Union, TypeScript narrows `decoded`
		// to `never` after `case 2`, so this single return is exhaustive.
		switch (decoded.version) {
			case 2:
				return { kind: 'present', doc: decoded } as const;
		}
	});

/** Set of versions the Union decoder above accepts. Keep in sync with
 *  the arms of `RestorePendingDocumentSchema` in `pending-marker.ts` —
 *  the peek uses this to distinguish "stale/future marker version" from
 *  "blob shape mismatch within a known version". */
const SUPPORTED_MARKER_VERSIONS = new Set<number>([SNAPSHOT_RESTORE_PENDING_VERSION]);

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

/** Probe whether `targetImageName` already resolves on the host by
 *  asking the runtime to self-tag it (`docker tag <target> <target>`).
 *  The contract's docker impl drives this through `docker image
 *  inspect`-equivalent resolution: a present image self-tags as an
 *  idempotent no-op (the `removeSourceAfterTag` cleanup is skipped
 *  because `src === dst`), an absent one fails with the not-found
 *  error. We reuse `tagImage` rather than reaching past the contract
 *  for `imageExists` — this is the only existence probe the runtime
 *  surface exposes, and it is side-effect-free for a name that already
 *  points at the target image.
 *
 *  `true` → target visible; `false` → target absent OR the probe itself
 *  hit a transient daemon error. The caller treats `false` as
 *  still-pending, so a transient probe failure errs on the safe side
 *  (keep the marker, retry next supervise) rather than dropping it. */
const targetImageResolves = (
	entry: RestorePendingContainer,
	runtime: ContainerRuntime,
): Effect.Effect<boolean> =>
	runtime
		// `{ digest }` carrying the target NAME (not the content digest)
		// is intentional: the contract resolves `tag ?? digest`, so this
		// addresses the source as `targetImageName`, making `src === dst`
		// — a self-tag the docker impl short-circuits without removing
		// anything. `removeSourceAfterTag` is deliberately omitted.
		.tagImage({ digest: entry.targetImageName }, entry.targetImageName)
		.pipe(
			Effect.as(true as const),
			Effect.catch(() => Effect.succeed(false as const)),
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
 *  When BOTH source attempts fail we must NOT blindly report the entry
 *  as still-pending: a fully missing source (both staged tag and digest
 *  gone) most often means a *previous* recovery already promoted this
 *  entry to `targetImageName` and a stale marker simply hasn't been
 *  rewritten. Collapsing that case into "still pending" retags forever
 *  and never makes progress. So after both attempts fail we PROBE
 *  whether `targetImageName` is already visible:
 *
 *    - target resolves → treat as recovered (drop the marker entry);
 *    - target absent    → the source genuinely vanished without a
 *      completed promote (e.g. a transient daemon error on both tag
 *      attempts, or operator prune of source AND target), so keep the
 *      entry pending for the next supervise.
 *
 *  This stops conflating "absent source because already recovered" with
 *  "transient daemon error" — only the former drops the marker. */
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
		if (digestFallback) return true;
		// Both source identities failed. Distinguish "already promoted by
		// a prior recovery" (target now visible → recovered) from a
		// genuine transient/missing-both failure (target absent → keep
		// pending). See the doc comment above.
		return yield* targetImageResolves(entry, runtime);
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
			// write per image, rare path). Unconditional — the rewrite
			// is idempotent and the final-rewrite below (or
			// `removePendingMarker` when nothing remains) covers steady
			// state.
			const remaining: RestorePendingContainer[] = [
				...stillPending,
				...doc.containers.slice(i + 1),
			];
			yield* rewriteMarker(stackRoot, doc, remaining);
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
