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
//     `{ creatorPid, creatorStartTime, createdAt }`.
//   - Release is `unlink`.
//   - Orphan sweep: on the next claim, if the body's creator pid is
//     dead (PID + start-time check), the reservation is unlinked. This
//     mirrors the roster's stale-PID reclaim.
//   - Acquire DOES NOT retry — snapshot is a one-shot intent; the
//     caller surfaces the structured error to the user immediately.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

import { Data, Effect, Scope } from 'effect';

import { type SnapshotReservation, SnapshotReservationSchema } from '../../cross-process.ts';
import { decodeJsonTextSync } from '../runtime-decode.ts';
import { checkHolderLiveness } from './liveness.ts';

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

const parseReservation = (raw: string): SnapshotReservation | null => {
	try {
		return decodeJsonTextSync(SnapshotReservationSchema, raw, {
			source: 'snapshot.reservation',
			mkError: (issue) => issue,
		});
	} catch {
		return null;
	}
};

// -----------------------------------------------------------------------------
// Acquire / release
// -----------------------------------------------------------------------------

const ownReservation = (startTime: number): SnapshotReservation => ({
	creatorPid: process.pid,
	creatorStartTime: startTime,
	createdAt: Date.now(),
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
		yield* Effect.annotateCurrentSpan({ 'devstack.snapshot-reservation.path': path });
		if (!existsSync(path)) return { swept: false };
		const raw = yield* Effect.try({
			try: () => readFileSync(path, 'utf8'),
			catch: (cause) => new SnapshotReservationIoError({ path, cause }),
		});
		const reservation = parseReservation(raw);
		if (reservation === null) {
			// Malformed body — the creator wrote a half-written file then
			// died. Treat as orphan: unlink it so future acquires don't
			// fail forever.
			yield* Effect.try({
				try: () => unlinkSync(path),
				catch: (cause) => new SnapshotReservationIoError({ path, cause }),
			});
			return { swept: true };
		}
		// PID-liveness check: synthesize a roster-shaped holder so the
		// shared liveness predicate applies.
		const liveness = yield* checkHolderLiveness(
			{
				pid: reservation.creatorPid,
				startTime: reservation.creatorStartTime,
				hostname: '',
				claimedAt: reservation.createdAt,
				heartbeatAt: reservation.createdAt,
				intent: 'snapshot',
			},
			'',
		).pipe(Effect.catch(() => Effect.succeed('alive' as const)));
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
	startTime: number,
): Effect.Effect<SnapshotReservation, SnapshotReservationError, Scope.Scope> =>
	Effect.gen(function* () {
		yield* Effect.annotateCurrentSpan({ 'devstack.snapshot-reservation.path': path });
		// One-shot orphan sweep before our O_EXCL attempt. The sweep is
		// idempotent: if a peer just wrote the reservation while we ran
		// the sweep, the O_EXCL create fails below and we surface the
		// structured "held" error.
		yield* sweepOrphan(path);
		const body = ownReservation(startTime);
		yield* Effect.try({
			try: () => writeFileSync(path, JSON.stringify(body), { flag: 'wx' }),
			catch: (cause) => {
				const code = (cause as NodeJS.ErrnoException).code;
				if (code === 'EEXIST') {
					let holder: SnapshotReservation | null = null;
					try {
						holder = parseReservation(readFileSync(path, 'utf8'));
					} catch {
						// Body unreadable; leave holder as null.
					}
					return new SnapshotReservationHeldError({ path, holder });
				}
				return new SnapshotReservationIoError({ path, cause });
			},
		});
		// Finalizer: best-effort unlink on scope close. Architecture §
		// Concurrent snapshot step 5: "It unlinks `snapshot.reservation`."
		yield* Effect.addFinalizer(() =>
			Effect.sync(() => {
				try {
					unlinkSync(path);
				} catch {
					// Already gone — ok. A peer's sweep may have unlinked our
					// stale reservation if we somehow lost the process between
					// acquire and the finalizer fire.
				}
			}),
		);
		return body;
	}).pipe(Effect.withSpan('cross-process.snapshot-reservation.acquire'));

/** Inspect (without acquiring) the current reservation. Returns the
 *  parsed body or `null` if absent / malformed. Used by the supervisor
 *  to decide whether to apply the "snapshot-in-progress" tolerance
 *  window to ready probes. Architecture § Concurrent snapshot step 3. */
export const peekReservation = (
	path: string,
): Effect.Effect<SnapshotReservation | null, SnapshotReservationError> =>
	Effect.gen(function* () {
		if (!existsSync(path)) return null;
		const raw = yield* Effect.try({
			try: () => readFileSync(path, 'utf8'),
			catch: (cause) => new SnapshotReservationIoError({ path, cause }),
		});
		return parseReservation(raw);
	}).pipe(Effect.withSpan('cross-process.snapshot-reservation.peek'));
