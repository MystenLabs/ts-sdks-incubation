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

import { mkdirSync, unlinkSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

import { Data, Effect, Schema, Scope } from 'effect';

import { checkHolderLiveness, ownHolder } from './liveness.ts';
import type { RosterHolder } from '../../cross-process.ts';

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
 *  means roster sweep + stack-lock reclaim see the same fields. */
const StackLockBodySchema = Schema.Struct({
	pid: Schema.Number,
	startTime: Schema.Number,
	hostname: Schema.String,
	claimedAt: Schema.Number,
	heartbeatAt: Schema.Number,
	intent: Schema.Literals(['normal', 'snapshot']),
});

const parseLockBody = (raw: string): RosterHolder | null => {
	try {
		const parsed = JSON.parse(raw) as unknown;
		const decoded = Schema.decodeUnknownSync(StackLockBodySchema)(parsed);
		return decoded;
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
const MAX_BACKOFF_MILLIS = 500;

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
	// fresh runtime root — devstack's `<runtimeRoot>/<app>/<stack>/` is
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
			// Reclaim if the holder is dead.
			if (lastHolder !== null) {
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
					// Loop again immediately; don't sleep for a reclaim.
					continue;
				}
			}
			yield* Effect.sleep(`${backoff} millis`);
			backoff = Math.min(backoff * 2, MAX_BACKOFF_MILLIS);
		}
	}).pipe(Effect.withSpan('cross-process.stack-lock.acquire'));
