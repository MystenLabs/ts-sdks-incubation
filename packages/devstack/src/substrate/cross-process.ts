// Cross-process safety protocol.
//
// Architecture § Cross-process safety protocol. Core artifacts per
// stack on disk under `<runtime-root>/stacks/<stack>/`:
//
//   - `stack.lock` — OS-advisory exclusive lock; short critical
//     sections only.
//   - `roster.json` — authoritative cross-process record of holders;
//     mutated only under the lock.
//   - `commands.ndjson` / `events.ndjson` — filesystem command
//     channel between peer CLI commands and the live supervisor.
//   - `snapshot.reservation` — present-or-absent file (O_EXCL create
//     = acquire; unlink = release).

import { Schema } from 'effect';

import { versionedDocSchema } from './versioned-doc-schema.ts';

/** Holder intent — `normal` for ordinary peers; `snapshot` while
 *  the holder is mid-capture (peers' commands defer). */
export type HolderIntent = 'normal' | 'snapshot';

/** One holder entry in `roster.json`. PID + startTime liveness check
 *  is the industry-standard pattern referenced in the synthesis. */
export interface RosterHolder {
	readonly pid: number;
	/** Process start-time, used for PID-reuse-safe liveness. */
	readonly startTime: number;
	readonly hostname: string;
	readonly claimedAt: number;
	readonly heartbeatAt: number;
	readonly intent: HolderIntent;
}

/** Roster document schema — versioned for forward compatibility. */
export interface RosterDocument {
	readonly version: 1;
	readonly holders: ReadonlyArray<RosterHolder>;
}

export const RosterHolderSchema = Schema.Struct({
	pid: Schema.Number,
	startTime: Schema.Number,
	hostname: Schema.String,
	claimedAt: Schema.Number,
	heartbeatAt: Schema.Number,
	intent: Schema.Literals(['normal', 'snapshot']),
});

export const RosterDocumentSchema = versionedDocSchema(1, {
	holders: Schema.Array(RosterHolderSchema),
});

/** Sweep policy — peers older than `staleAfterMillis` AND failing
 *  the PID liveness check are evicted on the next claim under the
 *  exclusive lock. Foreign-host entries are treated as alive
 *  (NFS-safe conservative default). */
export interface RosterSweepPolicy {
	readonly heartbeatIntervalMillis: number;
	readonly staleAfterMillis: number;
	readonly trustForeignHosts: boolean;
}

export const DEFAULT_SWEEP_POLICY: RosterSweepPolicy = {
	heartbeatIntervalMillis: 10_000,
	staleAfterMillis: 30_000,
	trustForeignHosts: true,
};

/** Snapshot reservation file — presence-or-absence semaphore. The
 *  reservation's creator pid is encoded in the JSON body for the
 *  orphan sweep. */
export interface SnapshotReservation {
	readonly creatorPid: number;
	readonly creatorStartTime: number;
	readonly createdAt: number;
}

export const SnapshotReservationSchema = Schema.Struct({
	creatorPid: Schema.Number,
	creatorStartTime: Schema.Number,
	createdAt: Schema.Number,
});
