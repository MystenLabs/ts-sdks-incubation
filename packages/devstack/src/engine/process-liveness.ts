// PID liveness checks. Two granularities:
//   - `isPidAlive(pid)` — bare `kill(0)` check. Cheap, sufficient for
//     callers who only care "does any process hold this pid right now",
//     and used by registry / docker-inventory walks where we don't
//     stash a `startedAt` stamp.
//   - `isHolderLive(holder)` — start-time-aware variant. Use when the
//     holder body carries a recorded `pid + startedAt + host` (the
//     state-store lock body, doctor's stale-lock cleanup). Falls back
//     to `isPidAlive` semantics when start-time is unavailable but
//     refuses to claim a lock as dead on a foreign host (cross-host
//     comparisons of `pid` are meaningless).
//
// `process.kill(pid, 0)` is the canonical "send signal 0" trick — it
// performs the permission + existence check the kernel does before
// dispatching any other signal, then bails out without delivering
// anything. Three relevant errnos:
//   - ESRCH: PID is unused → dead.
//   - EPERM: PID is owned by another user (cross-user processes on
//            shared dev machines) → ALIVE, treat as such.
//   - EINVAL / anything else: defensive — treat as dead so we don't
//     refuse to clean up because of an exotic platform error.
//
// PID reuse is a real concern on long-uptime machines: a fresh process
// can inherit a recycled pid number from a dead supervisor. The
// `isHolderLive` variant cross-checks `ps -o lstart=` against the
// stored `startedAt` stamp to defend against this.

import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';

export const isPidAlive = (pid: number): boolean => {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		// EPERM proves the PID is in use even though we can't signal it.
		return code === 'EPERM';
	}
};

/** Best-effort start-time read for `pid`. POSIX uses `ps -o lstart=`;
 *  Windows uses `tasklist` (which only confirms existence — PID reuse
 *  on Windows is a known v1 trade-off). Returns undefined if the
 *  process is gone or the platform can't supply a start time. */
export const processStartTime = (pid: number): string | undefined => {
	if (process.platform === 'win32') {
		try {
			const out = execFileSync('tasklist', ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'], {
				encoding: 'utf8',
				timeout: 2000,
				stdio: ['ignore', 'pipe', 'ignore'],
			});
			return out.trim().startsWith('"') ? '' : undefined;
		} catch {
			return undefined;
		}
	}
	try {
		const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
			encoding: 'utf8',
			timeout: 2000,
			stdio: ['ignore', 'pipe', 'ignore'],
		});
		const trimmed = out.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	} catch {
		return undefined;
	}
};

export interface LockHolder {
	readonly pid: number;
	readonly startedAt: string;
	readonly host: string;
}

/** Start-time-aware liveness check. Use when you have a holder body
 *  recorded by an earlier supervisor — the start-time match defends
 *  against PID-reuse misclassification. Treats foreign-host holders
 *  as alive (PIDs aren't comparable across hosts). */
export const isHolderLive = (holder: LockHolder): boolean => {
	if (!Number.isFinite(holder.pid) || holder.pid <= 0) return false;
	if (holder.host.length > 0 && holder.host !== hostname()) {
		return true;
	}
	if (!isPidAlive(holder.pid)) return false;
	const live = processStartTime(holder.pid);
	if (live === undefined) return false;
	if (live === '' || holder.startedAt === '') return true;
	return live === holder.startedAt;
};
