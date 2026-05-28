// `stack.lock` — O_EXCL exclusive lock for short critical sections.
//
// Architecture § Cross-process safety protocol § "What is locked":
//   - `stack.lock` — OS-advisory exclusive lock file. Used only for
//     short critical sections (roster mutations, snapshot reservation).
//     Acquired via `flock(LOCK_EX)` on Unix and `LockFileEx` on Windows;
//     never held across a long operation.
//
// The implementation here uses a portable O_EXCL-create dance — the
// same approach the legacy `engine/file-lock.ts` proved out — because
// `flock` isn't available cross-platform out of `node:fs`. The
// architecture's wording ("OS-advisory exclusive lock file") covers
// both `flock` and `O_EXCL`-with-pid-body; the latter is what every
// portable POSIX tool reaches for when `flock` isn't on the table.
//
// Discipline:
//   - The lock is held BRIEFLY — within a single Effect.scoped block
//     that mutates the roster or the snapshot reservation.
//   - Stale locks (owner crashed under the lock) are reclaimed via the
//     PID + start-time liveness check before the acquire reattempts.
//   - Acquire retries with exponential backoff up to 5 seconds total
//     (architecture § Claim protocol step 1).

import { mkdirSync, statSync, unlinkSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

import { Clock, Data, Duration, Effect, Schema, Scope } from 'effect';

import { DEFAULT_SWEEP_POLICY, type RosterHolder } from '../../cross-process.ts';
import { decodeJsonTextSync } from '../runtime-decode.ts';
import { checkHolderLiveness, ownHolder } from './liveness.ts';

/** Live system Clock instance — mirrors the discipline in
 *  `cross-process-lock.ts`. The acquire/reclaim sleep loops are
 *  fundamentally wall-time properties: cross-process safety can't
 *  share a virtual test clock, and the PID/start-time liveness probes
 *  measure real time. Pinning sleeps to live clock keeps the lock
 *  primitive's semantics coherent under `TestClock`-driven callers. */
const LIVE_CLOCK: Clock.Clock = {
	currentTimeMillis: Effect.sync(() => Date.now()),
	currentTimeMillisUnsafe: () => Date.now(),
	currentTimeNanos: Effect.sync(() => BigInt(Date.now()) * 1_000_000n),
	currentTimeNanosUnsafe: () => BigInt(Date.now()) * 1_000_000n,
	sleep: (duration: Duration.Duration) =>
		Effect.callback<void>((resume) => {
			const ms = Duration.toMillis(duration);
			if (ms <= 0) {
				resume(Effect.void);
				return;
			}
			const handle = setTimeout(() => resume(Effect.void), ms);
			return Effect.sync(() => clearTimeout(handle));
		}),
};

const underLiveClock = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
	Effect.provideService(effect, Clock.Clock, LIVE_CLOCK);

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

const parseLockBody = (raw: string): RosterHolder | null => {
	try {
		return decodeJsonTextSync(StackLockBodySchema, raw, {
			source: 'stack.lock',
			mkError: (issue) => issue,
		});
	} catch {
		return null;
	}
};

// -----------------------------------------------------------------------------
// Acquire / release
// -----------------------------------------------------------------------------

/** Default acquire timeout — architecture § Claim protocol step 1
 *  ("Block up to 5 seconds; if unavailable, retry with backoff"). */
export const DEFAULT_ACQUIRE_TIMEOUT_MILLIS = 5_000;

/** Per-attempt initial wait. Doubles each retry up to the cap. */
const INITIAL_BACKOFF_MILLIS = 25;
const MAX_BACKOFF_MILLIS = 200;

/** Reclaim jitter window: under multi-peer contention, each peer races
 *  `unlink` + `O_EXCL`-create after detecting a dead holder. Without
 *  spacing, every loser instantly thrashes the next attempt. 50–150ms
 *  staggers retries enough to let one winner settle. */

/**
 * Sync attempt at O_EXCL-create. Returns whether we own the lock now.
 *
 * Effect-platform's FileSystem doesn't expose a sync `open` shape, but
 * the critical-section discipline says we need a non-blocking attempt
 * inside a retry loop. Falling through to Node sync APIs here is the
 * cleanest path; the rest of the substrate stays Effect-native.
 */
const tryAcquireSync = (
	path: string,
): { readonly ok: true } | { readonly ok: false; readonly holder: RosterHolder | null } => {
	const body = ownHolder();
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
 * Acquire `stack.lock` as a scoped resource. The lock is released
 * when the surrounding Scope closes.
 *
 * Retry loop: exponential backoff up to `timeoutMillis` (default 5s).
 * On every miss, probe the holder's liveness — if it's dead, reclaim
 * by unlinking and looping. The reclaim path is the architecture's
 * "stale lock" handling — same PID + start-time semantics as the
 * roster sweep, so a process that crashed under the lock never blocks
 * the next peer indefinitely.
 *
 * IMPORTANT: this primitive yields a `void` resource. The caller MUST
 * keep its Scope tight — the architecture forbids holding the lock
 * across long operations.
 */
export const acquireStackLock = (
	path: string,
	timeoutMillis: number = DEFAULT_ACQUIRE_TIMEOUT_MILLIS,
): Effect.Effect<void, StackLockError, Scope.Scope> =>
	Effect.gen(function* () {
		yield* Effect.annotateCurrentSpan({
			'devstack.stack-lock.path': path,
			'devstack.stack-lock.timeoutMillis': timeoutMillis,
		});
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
				try: () => tryAcquireSync(path),
				catch: (cause) => new StackLockIoError({ path, cause }),
			});
			if (attempt.ok) {
				// Register a finalizer that unlinks the lock on scope close.
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => {
						try {
							unlinkSync(path);
						} catch {
							// Already gone — ok. Crash-during-release is handled
							// by the next peer's stale-PID reclaim.
						}
					}),
				);
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
			const currentHolderPid = lastHolder?.pid ?? null;
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
			let shouldReclaim = false;
			if (lastHolder !== null) {
				const status = yield* checkHolderLiveness(lastHolder).pipe(
					Effect.catch(() => Effect.succeed('alive' as const)),
				);
				shouldReclaim = status === 'dead';
			} else if (isUnparseableBodyStale(path)) {
				shouldReclaim = true;
			}
			if (shouldReclaim) {
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
				// Reset the exponential backoff so the post-reclaim
				// O_EXCL contest starts fresh — the previous backoff
				// growth was driven by a now-evicted dead holder.
				// `O_EXCL` atomicity alone arbitrates the race; no
				// staggering jitter is needed (review fix phase 22f
				// reproducer demonstrated that a 50-150ms jitter
				// under 8-way contention exhausts the 5s budget).
				backoff = INITIAL_BACKOFF_MILLIS;
				continue;
			}
			// Peer holds an alive lock — back off exponentially.
			// Reset the backoff if the holder identity changed since
			// the last loop iteration so a freshly-acquired peer
			// doesn't inherit a stale waiter's long-saturated backoff
			// budget. Without this, late waiters under heavy
			// contention can saturate at MAX_BACKOFF_MILLIS while
			// each peer holds the lock only briefly.
			yield* underLiveClock(Effect.sleep(`${backoff} millis`));
			backoff = Math.min(backoff * 2, MAX_BACKOFF_MILLIS);
		}
	}).pipe(Effect.withSpan('cross-process.stack-lock.acquire'));

/** Stat the lock file and return true when the body is older than the
 *  roster sweep's `staleAfterMillis` window. Used as the fallback
 *  reclaim signal when the on-disk body fails to parse (peer crashed
 *  mid-write): the PID liveness check has nothing to consult, so we
 *  fall back to mtime + the same staleness budget the roster sweep
 *  uses. Returns false on any I/O error so a transient stat failure
 *  doesn't trigger a spurious unlink — the loop's exponential backoff
 *  then naturally retries on the next iteration.
 *
 *  The threshold is `DEFAULT_SWEEP_POLICY.staleAfterMillis` (30s),
 *  matching the roster's eviction window. Anything that crashed mid-
 *  write at least 30s ago is presumed abandoned. */
const isUnparseableBodyStale = (path: string): boolean => {
	try {
		const stats = statSync(path);
		return Date.now() - stats.mtimeMs > DEFAULT_SWEEP_POLICY.staleAfterMillis;
	} catch {
		return false;
	}
};
