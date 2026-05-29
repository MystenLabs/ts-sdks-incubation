// Shared reclaim guard for unparseable/orphaned coordination files.
//
// Both `stack.lock` (stack-lock.ts) and `snapshot.reservation`
// (snapshot-reservation.ts) reclaim a file whose on-disk body fails to
// parse (a peer that crashed mid-write) once it ages past the roster
// sweep's staleness window. The PID liveness check has nothing to
// consult when the body won't parse, so mtime + the shared staleness
// budget is the only abandonment signal.
//
// The naive shape — `statSync` for the mtime, then `unlinkSync` — has a
// TOCTOU window: between reading the mtime and unlinking, a competing
// process can legitimately reclaim the garbage lock and write a FRESH,
// VALID O_EXCL body. The unconditional `unlinkSync` would then clobber
// that live lock, producing two simultaneous holders (a mutual-
// exclusion break). This module closes the window by RE-STATTING the
// file immediately before the unlink and confirming it is STILL the
// same stale inode (same mtime + ino + dev) AND still unparseable. If
// anything changed, the reclaim bails and the caller falls back to its
// normal backoff/retry path so the competitor's fresh body survives.
//
// The dead-PID liveness reclaim path is NOT routed through here: that
// branch is gated on a holder-liveness probe (see liveness.ts) and is
// already safe — a dead holder cannot have written a fresh body. Only
// the unparseable/mtime-stale branch carries the TOCTOU, so only it
// needs this guard.
//
// Sync `node:fs` by design — the call sites are inside `Effect.try`
// critical sections that need a non-blocking attempt; the rest of the
// substrate stays Effect-native.

import { readFileSync, statSync, unlinkSync } from 'node:fs';

import { DEFAULT_SWEEP_POLICY } from '../../cross-process.ts';

/** Outcome of a reclaim attempt.
 *
 *  - `reclaimed` — the file was an aged, unparseable orphan and we
 *    unlinked it (or it vanished from under us mid-reclaim, which is the
 *    same observable end state: the slot is free for the next O_EXCL).
 *  - `parseable` — the body parsed, so it is NOT an orphan; a live peer
 *    holds it (possibly one that just reclaimed the garbage ahead of
 *    us). Do not touch it.
 *  - `fresh` — the body is unparseable but its mtime is inside the
 *    staleness window; a writer is presumed mid-flush. Respect the
 *    budget and leave it.
 *  - `changed` — the re-stat guard fired: the file's identity (mtime /
 *    ino / dev) or parse-state changed between the staleness check and
 *    the unlink, meaning a competitor reclaimed the slot and wrote a
 *    fresh body in the window. We bailed to avoid clobbering it.
 *  - `absent` — the file was already gone when we looked. */
export type ReclaimOutcome = 'reclaimed' | 'parseable' | 'fresh' | 'changed' | 'absent';

/** A minimal, comparable identity for a file on disk. Two reads of the
 *  same untouched inode produce equal triples; any rewrite (O_EXCL
 *  unlink+create, or an in-place touch) perturbs at least one field. */
interface FileIdentity {
	readonly mtimeMs: number;
	readonly ino: number;
	readonly dev: number;
}

const identityOf = (path: string): FileIdentity | null => {
	try {
		const s = statSync(path);
		return { mtimeMs: s.mtimeMs, ino: s.ino, dev: s.dev };
	} catch {
		// ENOENT (gone) or any transient stat failure — treat as absent.
		return null;
	}
};

const sameIdentity = (a: FileIdentity, b: FileIdentity): boolean =>
	a.mtimeMs === b.mtimeMs && a.ino === b.ino && a.dev === b.dev;

const readOrNull = (path: string): string | null => {
	try {
		return readFileSync(path, 'utf8');
	} catch {
		return null;
	}
};

/** Reclaim `path` IFF it is an aged, unparseable orphan — with a re-stat
 *  guard that closes the TOCTOU window between the staleness check and
 *  the unlink.
 *
 *  `parse` is the caller's body decoder; it returns a non-null value for
 *  a well-formed body and `null` for an unparseable one. We never look
 *  at the decoded value — only at whether it parsed — so the lock and
 *  the reservation can share one guard despite carrying different
 *  schemas.
 *
 *  The staleness threshold is `DEFAULT_SWEEP_POLICY.staleAfterMillis`
 *  (30s), matching the roster's eviction window: anything that crashed
 *  mid-write at least 30s ago is presumed abandoned.
 *
 *  Never throws. Any I/O failure resolves to a conservative non-
 *  reclaiming outcome so a transient stat/read hiccup never triggers a
 *  spurious unlink — the caller's backoff loop retries on the next pass. */
export const reclaimUnparseableStaleFile = (
	path: string,
	parse: (raw: string) => unknown,
	staleAfterMillis: number = DEFAULT_SWEEP_POLICY.staleAfterMillis,
): ReclaimOutcome => {
	// 1. Initial identity + staleness.
	const before = identityOf(path);
	if (before === null) return 'absent';

	const rawBefore = readOrNull(path);
	if (rawBefore === null) return 'absent';
	if (parse(rawBefore) !== null) return 'parseable';

	const isStale = Date.now() - before.mtimeMs > staleAfterMillis;
	if (!isStale) return 'fresh';

	// 2. Re-stat guard — the TOCTOU close. Between the read above and the
	//    unlink below, a competitor may have reclaimed the garbage and
	//    written a FRESH valid O_EXCL body. Re-confirm the file is STILL
	//    the same stale inode AND still unparseable before unlinking.
	const after = identityOf(path);
	if (after === null) {
		// Vanished from under us — a sibling reclaimer won the unlink. The
		// slot is free; report it as reclaimed (same observable result).
		return 'reclaimed';
	}
	if (!sameIdentity(before, after)) return 'changed';

	const rawAfter = readOrNull(path);
	if (rawAfter === null) return 'reclaimed';
	if (parse(rawAfter) !== null) return 'changed';

	// 3. Still the same stale, unparseable orphan — safe to unlink.
	try {
		unlinkSync(path);
	} catch {
		// Race with another reclaimer that unlinked first — harmless; the
		// slot is free either way.
	}
	return 'reclaimed';
};
