// Detect whether a supervisor is currently live for a given stack.
//
// The CLI uses this to decide whether a verb should publish via the
// cross-process command channel (live supervisor: publish + await ack)
// or use its direct/offline fallback.
//
// Detection reads the existing `roster.json` (architecture § Cross-
// process safety protocol § Roster) and walks holders. A same-host
// holder with a live PID + matching start-time → supervisor live.
// Foreign-host holders are conservatively treated as live (NFS-safe
// default; matches `liveness.ts` discipline).

import { Effect } from 'effect';

import {
	layerLivenessProbeScope,
	LivenessProbeScope,
	readRoster,
	type RosterError,
} from '../../../substrate/runtime/cross-process/index.ts';

export interface SupervisorPresence {
	readonly live: boolean;
	readonly pid: number | null;
	readonly hostname: string | null;
}

/**
 * Read `rosterFile` and report whether at least one live holder
 * remains. Returns `{ live: false, pid: null }` when the roster is
 * missing OR all holders are dead-by-liveness-check.
 *
 * Tolerates corrupt rosters: a malformed file is treated as "no
 * live supervisor" — the worst case is the CLI refusing a publish
 * the user could have buffered.
 */
export const probeSupervisorPresence = (
	rosterFile: string,
): Effect.Effect<SupervisorPresence, RosterError> =>
	// Yield a fresh `LivenessProbeScope` so a corrupted-roster edge case
	// with multiple holders sharing one pid forks `ps`/`tasklist` once.
	Effect.gen(function* () {
		const doc = yield* readRoster(rosterFile).pipe(
			Effect.catchTag('RosterCorruptError', () =>
				Effect.succeed({ version: 1 as const, holders: [] }),
			),
		);
		const probe = yield* LivenessProbeScope;
		for (const holder of doc.holders) {
			const liveness = yield* probe
				.probeHolderLiveness(holder)
				.pipe(Effect.catch(() => Effect.succeed('alive' as const)));
			if (liveness === 'alive') {
				return { live: true, pid: holder.pid, hostname: holder.hostname };
			}
		}
		return { live: false, pid: null, hostname: null };
	}).pipe(Effect.provide(layerLivenessProbeScope));
