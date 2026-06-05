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
//
// The snapshot bounce holds `stack.lock` for the (bounded, whole-stack-
// stopped) snapshot window — there is no separate snapshot-reservation file
// (the lock subsumes the concurrency guard).

import { Schema } from 'effect';

import { versionedDocSchema } from './versioned-doc-schema.ts';

/** Holder intent — `normal` for ordinary peers; `snapshot` while
 *  the holder is mid-capture (peers' commands defer). */
export type HolderIntent = 'normal' | 'snapshot';

/** One holder entry in `roster.json`. PID + startTime distinguish live
 *  processes from PID reuse.
 *
 *  `startTime` is `number | null` — `null` means "the platform could
 *  not probe a start-time stamp for this process at write time" (an
 *  exotic platform, or `ps`/`tasklist` failed). Readers MUST treat
 *  `null` as the conservative branch (see `isOwnEntry` in `roster.ts`
 *  and `checkHolderLiveness` in `liveness.ts`): on a null recorded
 *  stamp the start-time comparison is skipped and the (pid, hostname)
 *  pair carries the identity. */
export interface RosterHolder {
	readonly pid: number;
	/** Process start-time, used for PID-reuse-safe liveness. `null`
	 *  means "unprobable" — see the interface doc above. */
	readonly startTime: number | null;
	readonly hostname: string;
	readonly claimedAt: number;
	readonly heartbeatAt: number;
	readonly intent: HolderIntent;
}

/** Roster document schema — versioned for schema validation. */
export interface RosterDocument {
	readonly version: 1;
	readonly holders: ReadonlyArray<RosterHolder>;
}

export const RosterHolderSchema = Schema.Struct({
	pid: Schema.Number,
	startTime: Schema.NullOr(Schema.Number),
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
 *  exclusive lock. */
export interface RosterSweepPolicy {
	readonly heartbeatIntervalMillis: number;
	readonly staleAfterMillis: number;
}

export const DEFAULT_SWEEP_POLICY: RosterSweepPolicy = {
	heartbeatIntervalMillis: 10_000,
	staleAfterMillis: 30_000,
};
