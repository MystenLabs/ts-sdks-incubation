// `snapshot.reservation` — presence-or-absence semaphore.
//
// Architecture § Cross-process safety protocol § Concurrent snapshot:
//   "Snapshot requires exclusive control of the stack's container set
//   (pause-around-commit means peer processes' ready-probes would fail
//   if uncoordinated). The snapshotting process acquires
//   `snapshot.reservation` via O_EXCL create. If creation fails (peer
//   holds it), the snapshot refuses with a structured 'snapshot in
//   progress by peer pid X' error."
//
// Discipline:
//   - Acquire is atomic O_EXCL create with a JSON body carrying
//     `{ version: 1, creatorPid, creatorStartTime, createdAt, hostname }`.
//   - Release is `unlink`.
//   - Orphan sweep: on the next claim, the body's `hostname` is checked
//     first. Foreign-host reservations short-circuit as alive (NFS-safe
//     conservative default — `kill(pid, 0)` is meaningless on a remote
//     kernel). Same-host reservations fall through to the PID +
//     start-time check, which mirrors the roster's stale-PID reclaim.
//   - Acquire DOES NOT retry — snapshot is a one-shot intent; the
//     caller surfaces the structured error to the user immediately.

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { hostname as nodeHostname } from 'node:os';

import { Data, Effect, Scope } from 'effect';

import {
	type RosterHolder,
	type SnapshotReservation,
	SnapshotReservationSchema,
} from '../../cross-process.ts';
import { parseVersionedDocumentBodyOrNull } from '../../versioned-doc-sync.ts';
import { SpanAttr } from '../observability/spans.ts';
import { checkHolderLiveness } from './liveness.ts';
import { reclaimUnparseableStaleFile } from './reclaim-stale-file.ts';
import { selfPid } from './self-pid.ts';
import { acquireExclusive } from './stack-lock.ts';

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

export class SnapshotReservationHeldError extends Data.TaggedError('SnapshotReservationHeldError')<{
	readonly path: string;
	readonly holder: SnapshotReservation | null;
}> {}

export class SnapshotReservationIoError extends Data.TaggedError('SnapshotReservationIoError')<{
	readonly path: string;
	readonly cause: unknown;
}> {}

export type SnapshotReservationError = SnapshotReservationHeldError | SnapshotReservationIoError;

// -----------------------------------------------------------------------------
// Codec
// -----------------------------------------------------------------------------

const parseReservation = (raw: string): SnapshotReservation | null =>
	parseVersionedDocumentBodyOrNull(raw, SnapshotReservationSchema, 'snapshot.reservation');

// -----------------------------------------------------------------------------
// Acquire / release
// -----------------------------------------------------------------------------

const ownReservation = (startTime: number | null): SnapshotReservation => ({
	version: 1,
	creatorPid: selfPid(),
	creatorStartTime: startTime,
	createdAt: Date.now(),
	hostname: nodeHostname(),
});

/** Synthesize a roster-shaped holder from a reservation body so the
 *  shared liveness predicate (`checkHolderLiveness`) applies. The
 *  holder carries the reservation's `hostname`, so the predicate's
 *  foreign-host short-circuit (a remote-host holder is treated as
 *  alive) fires for cross-host reservations exactly as before. */
const reservationToHolder = (reservation: SnapshotReservation): RosterHolder => ({
	pid: reservation.creatorPid,
	startTime: reservation.creatorStartTime,
	hostname: reservation.hostname,
	claimedAt: reservation.createdAt,
	heartbeatAt: reservation.createdAt,
	intent: 'snapshot',
});

/**
 * Sweep an orphaned reservation. If the file exists AND its creator is
 * dead, unlink it. Returns whether a sweep happened so callers can
 * observe / report.
 *
 * Architecture § Concurrent snapshot last paragraph:
 *   "If the snapshotting process crashes mid-snapshot, the reservation
 *    file persists. The next process's claim-protocol sweep detects an
 *    orphan reservation (the holder whose pid matches the
 *    reservation's creator entry is dead) and unlinks it."
 */
export const sweepOrphan = (
	path: string,
): Effect.Effect<{ readonly swept: boolean }, SnapshotReservationError> =>
	Effect.gen(function* () {
		yield* Effect.annotateCurrentSpan({ [SpanAttr.snapshotReservationPath]: path });
		if (!existsSync(path)) return { swept: false };
		const raw = yield* Effect.try({
			try: () => readFileSync(path, 'utf8'),
			catch: (cause) => new SnapshotReservationIoError({ path, cause }),
		});
		const reservation = parseReservation(raw);
		if (reservation === null) {
			// Malformed body — the creator may have written a half-written
			// file. Reclaim ONLY through the shared re-stat guard: gating a
			// bare mtime read + unlink races a competitor who legitimately
			// reclaims the garbage and writes a fresh valid O_EXCL body in
			// the window — the unlink would clobber that LIVE reservation.
			// `reclaimUnparseableStaleFile` honors the SAME mtime staleness
			// window stack-lock uses (a body younger than the window is
			// presumed mid-write and left alone) AND re-confirms the file
			// is still the same stale, unparseable inode immediately before
			// unlinking.
			const outcome = yield* Effect.try({
				try: () => reclaimUnparseableStaleFile(path, parseReservation),
				catch: (cause) => new SnapshotReservationIoError({ path, cause }),
			});
			return { swept: outcome === 'reclaimed' };
		}
		// Foreign-host reservation: NFS-safe — we cannot probe a remote
		// kernel for pid liveness, so treat the peer as alive (matches
		// the roster's `trustForeignHosts` policy). Before adding the
		// `hostname` field we synthesized a holder with hostname='' and
		// passed ownHost='', which bypassed the foreign-host fast-path
		// in `checkHolderLiveness` and probed PID/startTime locally — a
		// live remote process could be declared dead and its reservation
		// unlinked. The fix is to short-circuit here.
		const ownHost = nodeHostname();
		if (reservation.hostname !== ownHost) return { swept: false };
		// PID-liveness check: synthesize a roster-shaped holder so the
		// shared liveness predicate applies.
		const liveness = yield* checkHolderLiveness(reservationToHolder(reservation), ownHost).pipe(
			Effect.catch(() => Effect.succeed('alive' as const)),
		);
		if (liveness === 'alive') return { swept: false };
		yield* Effect.try({
			try: () => unlinkSync(path),
			catch: (cause) => new SnapshotReservationIoError({ path, cause }),
		});
		return { swept: true };
	}).pipe(Effect.withSpan('cross-process.snapshot-reservation.sweepOrphan'));

/**
 * Acquire the snapshot reservation as a scoped resource. The
 * reservation is unlinked when the surrounding Scope closes.
 *
 * Architecture § Concurrent snapshot step 1: O_EXCL create, no retry.
 * Callers that fail with `SnapshotReservationHeldError` propagate the
 * structured "snapshot in progress" error to the user — the typical
 * `Effect.catchTag` shape.
 *
 * `startTime` is the same value the roster carries for THIS process so
 * the orphan sweep's pid-startTime check resolves identically.
 */
export const acquireReservation = (
	path: string,
	startTime: number | null,
): Effect.Effect<SnapshotReservation, SnapshotReservationError, Scope.Scope> =>
	Effect.gen(function* () {
		yield* Effect.annotateCurrentSpan({ [SpanAttr.snapshotReservationPath]: path });
		// Thin wrapper over the merged O_EXCL core in the one-shot shape
		// (`timeoutMillis: 0`): a single foreign-host-aware `sweepOrphan`
		// then a single O_EXCL attempt. The core maps EEXIST to
		// `SnapshotReservationHeldError` IMMEDIATELY (no loop-to-timeout)
		// — snapshot is a one-shot intent, so the caller surfaces the
		// structured "snapshot in progress" error at once. The unlink
		// finalizer is registered INSIDE the core's scope (Architecture §
		// Concurrent snapshot step 5: "It unlinks `snapshot.reservation`").
		return yield* acquireExclusive<SnapshotReservation, SnapshotReservationError>({
			path,
			timeoutMillis: 0,
			parse: parseReservation,
			ownBody: () => ownReservation(startTime),
			toHolder: reservationToHolder,
			mapHeld: (holder) => new SnapshotReservationHeldError({ path, holder }),
			mapIo: (cause) => new SnapshotReservationIoError({ path, cause }),
			oneShotSweep: (p) => sweepOrphan(p),
		});
	}).pipe(Effect.withSpan('cross-process.snapshot-reservation.acquire'));
