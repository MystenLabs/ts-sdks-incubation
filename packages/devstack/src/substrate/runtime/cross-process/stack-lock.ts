// `stack.lock` — O_EXCL exclusive lock for short critical sections.
//
// Architecture § Cross-process safety protocol § "What is locked":
//   - `stack.lock` — OS-advisory exclusive lock file. Used only for
//     short critical sections (roster mutations, the snapshot bounce).
//     Acquired via `flock(LOCK_EX)` on Unix and `LockFileEx` on Windows;
//     never held across a long operation.
//
// The implementation here uses a portable O_EXCL-create dance because
// `flock` isn't available cross-platform out of `node:fs`. The
// architecture's wording ("OS-advisory exclusive lock file") covers
// both `flock` and `O_EXCL`-with-pid-body; the latter is what every
// portable POSIX tool reaches for when `flock` isn't on the table.
//
// Discipline:
//   - The lock is held BRIEFLY — within a single Effect.scoped block
//     that mutates the roster or spans the snapshot bounce.
//   - Stale locks (owner crashed under the lock) are reclaimed via the
//     PID + start-time liveness check before the acquire reattempts.
//   - Acquire retries with exponential backoff up to 5 seconds total
//     (architecture § Claim protocol step 1).

import { mkdirSync, unlinkSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

import { Data, Effect, Schema, Scope } from 'effect';

import { type RosterHolder } from '../../cross-process.ts';
import { parseVersionedDocumentBodyOrNull } from '../../versioned-doc-sync.ts';
import { underLiveClock } from './live-clock.ts';
import { checkHolderLiveness, ownHolder } from './liveness.ts';
import { reclaimUnparseableStaleFile } from './reclaim-stale-file.ts';

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/** Tagged failure: acquire window elapsed and the lock is still held.
 *  Carries the in-disk body (if parseable) so the caller can name the
 *  blocking peer in user-facing error reporting. */
export class StackLockTimeoutError extends Data.TaggedError('StackLockTimeoutError')<{
	readonly path: string;
	readonly waitedMillis: number;
	readonly holder: RosterHolder | null;
}> {}

/** Tagged failure: I/O error other than EEXIST during acquire. */
export class StackLockIoError extends Data.TaggedError('StackLockIoError')<{
	readonly path: string;
	readonly cause: unknown;
}> {}

export type StackLockError = StackLockTimeoutError | StackLockIoError;

// -----------------------------------------------------------------------------
// Codec
// -----------------------------------------------------------------------------

/** The on-disk body is the same `RosterHolder` shape — re-using the schema
 *  means roster sweep + stack-lock reclaim see the same fields.
 *
 *  `startTime` mirrors `RosterHolderSchema`: `number | null` so an
 *  unprobable platform's lock body round-trips cleanly through the
 *  decoder. The shared liveness predicate honors null conservatively. */
const StackLockBodySchema = Schema.Struct({
	pid: Schema.Number,
	startTime: Schema.NullOr(Schema.Number),
	hostname: Schema.String,
	claimedAt: Schema.Number,
	heartbeatAt: Schema.Number,
	intent: Schema.Literals(['normal', 'snapshot']),
});

const parseLockBody = (raw: string): RosterHolder | null =>
	parseVersionedDocumentBodyOrNull(raw, StackLockBodySchema, 'stack.lock');

// -----------------------------------------------------------------------------
// Acquire / release
// -----------------------------------------------------------------------------

/** Default acquire timeout — architecture § Claim protocol step 1
 *  ("Block up to 5 seconds; if unavailable, retry with backoff"). */
export const DEFAULT_ACQUIRE_TIMEOUT_MILLIS = 5_000;

/** Per-attempt initial wait. Doubles each retry up to the cap. The
 *  backoff also resets whenever the holder identity changes — see the
 *  reclaim loop comment for the contention story (review fix phase
 *  22f). The cap is intentionally tight (200ms) so peers react quickly
 *  to a release; combined with the O_EXCL-arbitrated retry on reclaim,
 *  no staggering jitter is needed. */
const INITIAL_BACKOFF_MILLIS = 25;
const MAX_BACKOFF_MILLIS = 200;

/**
 * Sync attempt at O_EXCL-create with the lock's JSON body. Returns
 * whether we own the file now; on EEXIST it probes the existing body
 * through `parseLockBody`.
 *
 * Effect-platform's FileSystem doesn't expose a sync `open` shape, but
 * the critical-section discipline says we need a non-blocking attempt
 * inside a retry loop. Falling through to Node sync APIs here is the
 * cleanest path; the rest of the substrate stays Effect-native.
 */
const tryAcquireSync = (
	path: string,
	body: RosterHolder,
): { readonly ok: true } | { readonly ok: false; readonly holder: RosterHolder | null } => {
	// The lock's parent directory may not exist on first-claim of a
	// fresh runtime root — devstack's `<runtimeRoot>/stacks/<stack>/` is
	// the substrate's responsibility to bring into being, but no other
	// L0 subsystem touches the disk until the first claim. `mkdir -p`
	// here is idempotent and harmless on the warm path; it transforms
	// the otherwise-fatal ENOENT-during-write into a clean acquire.
	// Architecture § Cross-process safety protocol: stack root is
	// created by whichever subsystem first reaches for a path under it.
	mkdirSync(dirname(path), { recursive: true });
	try {
		writeFileSync(path, JSON.stringify(body), { flag: 'wx' });
		return { ok: true };
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== 'EEXIST') {
			throw err;
		}
		// Peer holds it (or stale). Probe the existing body.
		if (!existsSync(path)) {
			// Race: holder unlinked between our EEXIST and the existsSync.
			// Retry on the next loop iteration.
			return { ok: false, holder: null };
		}
		try {
			const raw = readFileSync(path, 'utf8');
			return { ok: false, holder: parseLockBody(raw) };
		} catch {
			return { ok: false, holder: null };
		}
	}
};

/**
 * Acquire `stack.lock` as a scoped resource. The lock is released when
 * the surrounding Scope closes (the unlink finalizer is registered INSIDE
 * this scope, so every caller — roster claim/release/heartbeat, the
 * snapshot bounce, command-channel append — releases on scope close,
 * never bypassed). Yields a `void` resource — the caller MUST keep its
 * Scope tight; the architecture forbids holding the lock across long
 * operations.
 *
 * The O_EXCL retry loop: exponential backoff up to `timeoutMillis`
 * (default 5s). On every miss, probe the holder's liveness — dead holders
 * are reclaimed (unlink + loop); an unparseable body is reclaimed only
 * through the shared re-stat guard once it ages past
 * `DEFAULT_SWEEP_POLICY.staleAfterMillis`. Backoff resets on holder
 * change and on reclaim. The reclaim path is the architecture's "stale
 * lock" handling — same PID + start-time semantics as the roster sweep,
 * so a process that crashed under the lock never blocks the next peer
 * indefinitely.
 */
export const acquireStackLock = (
	path: string,
	timeoutMillis: number = DEFAULT_ACQUIRE_TIMEOUT_MILLIS,
): Effect.Effect<void, StackLockError, Scope.Scope> =>
	Effect.gen(function* () {
		const addUnlinkFinalizer = Effect.addFinalizer(() =>
			Effect.sync(() => {
				try {
					unlinkSync(path);
				} catch {
					// Already gone — ok. Crash-during-release is handled by
					// the next peer's stale-PID reclaim.
				}
			}),
		);
		const startedAt = Date.now();
		let backoff = INITIAL_BACKOFF_MILLIS;
		let lastHolder: RosterHolder | null = null;
		let prevHolderPid: number | null = null;
		while (true) {
			const elapsed = Date.now() - startedAt;
			if (elapsed > timeoutMillis) {
				return yield* Effect.fail(
					new StackLockTimeoutError({ path, waitedMillis: elapsed, holder: lastHolder }),
				);
			}
			const attempt = yield* Effect.try({
				try: () => tryAcquireSync(path, ownHolder()),
				catch: (cause) => new StackLockIoError({ path, cause }),
			});
			if (attempt.ok) {
				// Register a finalizer that unlinks the lock on scope close.
				yield* addUnlinkFinalizer;
				return;
			}
			lastHolder = attempt.holder;
			// Reset the backoff whenever the holder identity changes —
			// a new holder means the previous one released, and our
			// long-saturated backoff (driven by waiting on the prior
			// holder) is now stale. Without this, late waiters under
			// heavy contention saturate at MAX_BACKOFF_MILLIS while
			// each peer holds the lock only briefly, exhausting the
			// claim budget before they can win (review fix phase 22f
			// reclaim-stress reproducer caught the case).
			const currentHolderPid = lastHolder !== null ? lastHolder.pid : null;
			if (currentHolderPid !== prevHolderPid) {
				backoff = INITIAL_BACKOFF_MILLIS;
				prevHolderPid = currentHolderPid;
			}
			// Reclaim if the holder is dead OR the lock body is
			// unparseable AND old enough to be presumed-abandoned. The
			// unparseable case covers a peer that died mid-write: the
			// PID liveness check has nothing to consult, so the only
			// signal is the file's mtime falling outside the staleness
			// window (`DEFAULT_SWEEP_POLICY.staleAfterMillis`, shared
			// with the roster sweep). Without this branch, a mid-write
			// crash keeps every peer blocked for the full 5s claim
			// window — see review fix phase 22f (cross-process).
			let reclaimed = false;
			if (lastHolder !== null) {
				// Dead-PID reclaim: gated on a liveness probe, so the
				// holder cannot have written a fresh body — a plain
				// unlink is safe here (no TOCTOU). An alive holder falls
				// through to the backoff below. `checkHolderLiveness`
				// carries the foreign-host short-circuit (a holder on a
				// remote host is treated as alive), so a cross-host body
				// is never reclaimed here.
				const status = yield* checkHolderLiveness(lastHolder).pipe(
					Effect.catch(() => Effect.succeed('alive' as const)),
				);
				if (status === 'dead') {
					yield* Effect.try({
						try: () => {
							try {
								unlinkSync(path);
							} catch {
								// Race with another reclaimer — ok.
							}
							return null;
						},
						catch: (cause) => new StackLockIoError({ path, cause }),
					});
					reclaimed = true;
				}
			} else {
				// Unparseable body: reclaim ONLY through the re-stat
				// guard. A bare mtime read + unlink races a competitor
				// who legitimately reclaims the garbage and writes a
				// fresh valid O_EXCL body in the window — the unlink
				// would clobber that LIVE lock (two simultaneous
				// holders). `reclaimUnparseableStaleFile` re-confirms the
				// file is still the same stale, unparseable inode
				// immediately before unlinking; any other outcome leaves
				// the file untouched and we fall through to back off.
				const outcome = yield* Effect.try({
					try: () => reclaimUnparseableStaleFile(path, parseLockBody),
					catch: (cause) => new StackLockIoError({ path, cause }),
				});
				reclaimed = outcome === 'reclaimed';
			}
			if (reclaimed) {
				// O_EXCL atomicity alone arbitrates the post-reclaim
				// race; reset the backoff so the contest starts fresh
				// (the prior growth was driven by a now-evicted dead
				// holder).
				backoff = INITIAL_BACKOFF_MILLIS;
				continue;
			}
			// Peer holds an alive lock — back off exponentially.
			yield* underLiveClock(Effect.sleep(`${backoff} millis`));
			backoff = Math.min(backoff * 2, MAX_BACKOFF_MILLIS);
		}
	});
