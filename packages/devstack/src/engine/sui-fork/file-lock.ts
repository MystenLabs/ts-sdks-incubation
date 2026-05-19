// Per-stack file lock for `sui-fork` data directories.
//
// `sui-fork` has no cross-process lock on its `--data-dir` (see R5 in
// `notes/sui-fork-integration.md`): two `sui-fork start` processes
// pointed at the same data dir silently trample each other's RocksDB
// state. Devstack enforces single-writer-per-data-dir at acquire time
// by writing a `data.lock` next to the data dir and refusing to start
// if another live supervisor holds it. The wx-mode acquire / stale-PID
// reclaim / instanceId-based release dance lives in
// `engine/file-lock.ts` (shared with the port-allocator); this module
// adapts that into the SuiError typed-error envelope the rest of
// sui-fork uses.
//
// Scope-bound: callers register the lock acquire as an
// `Effect.acquireRelease`, so a finalizer on the calling
// primitive's own layer scope handles release on Ctrl-C / crash /
// targeted invalidation / `r` restart.

import { Effect, Scope } from 'effect';
import { SuiError } from '../errors.js';
import {
	type LockBody,
	releaseLockSync,
	tryClaimLockSync,
} from '../file-lock.js';

/** Acquire a `sui-fork` data-dir file lock, scoped to the current
 *  Effect scope. Fails fast with a `SuiError({phase: 'fork-lock'})`
 *  when another live supervisor holds the lock. The error message
 *  names the PID + host + instanceId of the holder so the user can
 *  identify the offender. */
export const acquireForkDataLock = (lockPath: string): Effect.Effect<void, SuiError, Scope.Scope> =>
	Effect.acquireRelease(
		Effect.try({
			try: () => {
				const result = tryClaimLockSync(lockPath, { withInstanceId: true });
				if (!result.ok) {
					const h = result.holder ?? {
						pid: 0,
						startedAt: '',
						host: '',
						instanceId: 'unknown',
					};
					throw new SuiError({
						phase: 'fork-lock',
						message:
							`sui-fork data-dir lock at ${lockPath} is held by pid=${h.pid}` +
							` on host=${h.host} (startedAt=${h.startedAt}, instanceId=${h.instanceId ?? 'unknown'}). ` +
							`Refusing to start — concurrent sui-fork processes against the same data ` +
							`dir corrupt each other silently. Stop the holder and retry.`,
					});
				}
				return result.body;
			},
			catch: (cause): SuiError =>
				cause instanceof SuiError
					? cause
					: new SuiError({
							phase: 'fork-lock',
							message: `failed to acquire sui-fork data-dir lock at ${lockPath}: ${String(cause)}`,
							cause,
						}),
		}),
		(body: LockBody) =>
			Effect.sync(() => {
				releaseLockSync(lockPath, body);
			}),
	).pipe(Effect.asVoid);
