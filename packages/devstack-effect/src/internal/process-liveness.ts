// PID liveness check, factored out of `state-store.ts` and
// `docker/inventory.ts` so the new `internal/registry.ts` can reuse the
// same "is the supervisor that recorded this PID still alive?" semantics
// without bouncing between two near-identical helpers.
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
// can inherit a recycled pid number from a dead supervisor. The full
// belt-and-braces fix (see `state-store.ts:isHolderLive`) is to
// cross-check `ps -o lstart=` against a stored `startedAt` stamp. The
// registry doesn't carry `startedAt` — we deliberately keep the entry
// shape small — so a bare `kill(0)` is what we ship. If the recycled
// pid happens to belong to a different process, we surface a false
// positive `active` classification, which is the safer failure mode
// (refuse to clean up vs accidentally killing the wrong stack's state).

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
