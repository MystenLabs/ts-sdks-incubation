// Phase 1 P1.T7 — file-lock cross-process protection for sui-fork
// data dirs. Runs the actual lock-acquire path against tmpfs paths;
// does NOT require Docker for the lock primitive itself (the test
// asserts the lock refuses a second acquire). Despite the
// `.docker.test.ts` filename suffix (which gates inclusion in the
// fork-e2e CI job), the test body doesn't shell out to docker.
//
// The file-lock module under test (`engine/sui-fork/file-lock.ts`)
// uses `fs.writeFileSync(...{flag: 'wx'})` for atomic exclusive
// create + `isHolderLive` for stale reclaim. We exercise both paths:
//   - happy: acquire succeeds in an empty dir
//   - contention: a second acquire against the same path with a LIVE
//                 holder (self) fails fast with `SuiError({phase:
//                 'fork-lock'})`
//   - stale: acquire succeeds when the on-disk holder PID is dead.
//
// Tests use plain vitest (not @effect/vitest) because the file-lock
// API is synchronous-with-promises (each acquire is an Effect that
// can be `Effect.runPromise`-d in a unit test) and we want explicit
// control of the parallelism.

import { describe, expect, it } from 'vitest';
import { Cause, Effect } from 'effect';
import * as fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireForkDataLock } from './sui-fork/file-lock.js';
import { SuiError } from './errors.js';

describe('sui-fork: P1.T7 data-dir file lock', () => {
	it('happy path: acquire succeeds in an empty directory', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'devstack-fork-lock-'));
		const lockPath = join(dir, 'data.lock');
		try {
			await Effect.runPromise(
				Effect.scoped(
					acquireForkDataLock(lockPath).pipe(
						Effect.tap(() =>
							Effect.sync(() => {
								// Lock file exists while we hold it.
								expect(fs.existsSync(lockPath)).toBe(true);
							}),
						),
					),
				),
			);
			// After scope close, the lock file is released.
			expect(fs.existsSync(lockPath)).toBe(false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('contention: second acquire fails with SuiError({phase: fork-lock})', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'devstack-fork-lock-'));
		const lockPath = join(dir, 'data.lock');
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						// First acquire succeeds.
						yield* acquireForkDataLock(lockPath);
						// Second acquire — same process, same lock — fails fast
						// because our self-acquired lock is "live" by definition.
						const exit = yield* acquireForkDataLock(lockPath).pipe(Effect.exit);
						expect(exit._tag).toBe('Failure');
						if (exit._tag === 'Failure') {
							// v4 Cause: walk `cause.reasons` for the Fail reason.
							let err: SuiError | undefined;
							for (const reason of exit.cause.reasons) {
								if (Cause.isFailReason(reason)) {
									err = reason.error as SuiError;
									break;
								}
							}
							expect(err).toBeInstanceOf(SuiError);
							expect(err?.phase).toBe('fork-lock');
							expect(err?.message).toMatch(/sui-fork data-dir lock.*is held/);
						}
					}),
				),
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('stale reclaim: acquire succeeds when on-disk holder PID is dead', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'devstack-fork-lock-'));
		const lockPath = join(dir, 'data.lock');
		// Write a synthetic lock body claiming a non-existent PID (way
		// above any real PID) — the acquire path should treat it as
		// stale and reclaim.
		fs.writeFileSync(
			lockPath,
			JSON.stringify({
				pid: 999_999_998,
				startedAt: '',
				host: 'definitely-not-this-host-abc123',
				instanceId: 'stale',
			}),
		);
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						// Reclaim should succeed because the recorded holder
						// is cross-host (which our liveness check treats
						// conservatively as live)... so on the same host but
						// with a dead PID, the reclaim succeeds. Use a same-
						// host dead-pid body for the actual reclaim path.
					}),
				),
			);
			// Replace with a same-host dead-PID body so the liveness check
			// (which is conservative about cross-host) doesn't treat it
			// as live.
			fs.writeFileSync(
				lockPath,
				JSON.stringify({
					pid: 999_999_998,
					startedAt: '',
					host: require('node:os').hostname(),
					instanceId: 'stale',
				}),
			);
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						yield* acquireForkDataLock(lockPath);
						// Lock body is now ours.
						const raw = fs.readFileSync(lockPath, 'utf8');
						const body = JSON.parse(raw);
						expect(body.pid).toBe(process.pid);
					}),
				),
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
