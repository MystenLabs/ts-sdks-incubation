// PID + start-time liveness check.
//
// Architecture § Cross-process safety protocol § Claim protocol step 3:
// "process exists AND its start-time (as read from `/proc/<pid>/stat` on
// Linux, `ps -o lstart` on macOS, or equivalent) matches the recorded
// `startTime`."
//
// Foreign-host entries are treated as alive (NFS-safe conservative
// default). On the same host, two checks combine: `kill(pid, 0)`
// determines pid-in-use; `ps -o lstart` confirms it's the SAME process
// (defending against pid reuse on long-uptime machines).
//
// This module is the ONLY place in the substrate that calls into
// `process.kill` and shells out for start times. Roster/snapshot
// reservation/stack-lock all consult it through the typed predicates.

import { execFileSync } from 'node:child_process';
import { hostname as nodeHostname } from 'node:os';

import { Data, Effect } from 'effect';

import type { RosterHolder } from '../../cross-process.ts';

/** Tagged failure when the start-time probe itself errored unexpectedly
 *  (timeout, missing utility, etc.). Distinguished from "pid absent",
 *  which is signaled by `processStartTime` returning `null`. */
export class StartTimeProbeError extends Data.TaggedError('StartTimeProbeError')<{
	readonly pid: number;
	readonly cause: unknown;
}> {}

/** Cheap "send signal 0" pid liveness. ESRCH → dead; EPERM → alive
 *  (foreign-user pid on shared dev hosts). Any other errno is
 *  conservatively treated as dead so we don't refuse cleanup on exotic
 *  platforms. */
export const isPidAlive = (pid: number): boolean => {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		return code === 'EPERM';
	}
};

/** Best-effort start-time stamp for `pid`. Returns `null` when the
 *  process is gone OR the platform can't produce a time. The stamp
 *  itself is opaque text — its only contract is bytewise equality with
 *  a previously-recorded sibling stamp.
 *
 *  Architecture § Cross-process safety protocol §3 — `ps -o lstart` on
 *  macOS/Linux, `tasklist` confirmation on Windows. */
export const processStartTime = (pid: number): number | null => {
	if (!Number.isFinite(pid) || pid <= 0) return null;
	if (process.platform === 'win32') {
		try {
			const out = execFileSync('tasklist', ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'], {
				encoding: 'utf8',
				timeout: 2000,
				stdio: ['ignore', 'pipe', 'ignore'],
			});
			// Windows path: just hash the line. Windows PID reuse on uptime
			// is a known v1 trade-off; the architecture says the protocol
			// stays POSIX-first.
			return out.trim().startsWith('"') ? hashStartTimeStamp(out.trim()) : null;
		} catch {
			return null;
		}
	}
	try {
		const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
			encoding: 'utf8',
			timeout: 2000,
			stdio: ['ignore', 'pipe', 'ignore'],
		});
		const trimmed = out.trim();
		return trimmed.length > 0 ? hashStartTimeStamp(trimmed) : null;
	} catch {
		return null;
	}
};

/** Stable hash of a start-time string. Reduces the textual `ps -o
 *  lstart=` output to a single number so the roster carries a fixed-
 *  width integer (the architecture's `startTime` field is `number`).
 *
 *  FNV-1a 32-bit; collisions are negligible at the (pid, host, second)
 *  granularity we ever compare. */
const hashStartTimeStamp = (stamp: string): number => {
	let h = 2166136261;
	for (let i = 0; i < stamp.length; i++) {
		h ^= stamp.charCodeAt(i);
		h = (h * 16777619) >>> 0;
	}
	// Stay inside Number.MAX_SAFE_INTEGER's positive 32-bit range so the
	// number round-trips through JSON without precision loss.
	return h >>> 0;
};

/** Liveness probe for a roster holder. Used by the claim-protocol
 *  sweep AND the snapshot-reservation orphan check.
 *
 *  Discipline:
 *   - Foreign-host (`hostname` differs from our own) → ALWAYS alive
 *     (NFS-safe default; cross-host pid comparisons are meaningless).
 *   - Same-host: pid must be live AND start-time must match.
 *
 *  Returns `'alive' | 'dead'`. Never throws. Effect-wrapped so callers
 *  compose under spans. */
export const checkHolderLiveness = Effect.fn('cross-process.liveness.checkHolderLiveness')(
	function* (holder: RosterHolder, ownHost: string = nodeHostname()) {
		// Foreign-host: NFS-safe — we can't verify, assume alive.
		if (holder.hostname !== ownHost) {
			return 'alive' as const;
		}
		yield* Effect.annotateCurrentSpan({
			'devstack.holder.pid': holder.pid,
			'devstack.holder.host': holder.hostname,
		});
		if (!isPidAlive(holder.pid)) return 'dead' as const;
		const probedStart = processStartTime(holder.pid);
		// pid alive but no stamp probable → conservative: ALIVE
		// (we have nothing to dispute the recorded startTime with).
		if (probedStart === null) return 'alive' as const;
		return probedStart === holder.startTime ? ('alive' as const) : ('dead' as const);
	},
);

/** Build a holder snapshot for THIS process. The intent defaults to
 *  `'normal'`; the snapshot-reservation flow flips it to `'snapshot'`
 *  under the stack lock and back when the reservation releases. */
export const ownHolder = (intent: 'normal' | 'snapshot' = 'normal'): RosterHolder => {
	const pid = process.pid;
	const startTime = processStartTime(pid) ?? 0;
	return {
		pid,
		startTime,
		hostname: nodeHostname(),
		claimedAt: Date.now(),
		heartbeatAt: Date.now(),
		intent,
	};
};
