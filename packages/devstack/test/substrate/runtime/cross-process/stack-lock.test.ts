// stack-lock — claim path must auto-mkdir parent directory.
//
// Regression: on a fresh boot under a fresh `mkdtempSync` runtime root,
// the `<runtimeRoot>/stacks/<stack>/` directory does not exist yet. No
// L0 subsystem touches the disk until the first cross-process claim,
// at which point `stack-lock.ts::tryAcquireSync` calls
// `writeFileSync(stackLockFile, ..., { flag: 'wx' })`. Without the
// substrate ensuring the parent directory exists, the write fails with
// ENOENT, which `Effect.try` lifts to `StackLockIoError`. That error
// then propagates up to `roster.claim` and surfaces in
// `runtime/docker/container.ts::ensureContainer` as a
// `DaemonUnreachable` with detail
// `cross-process claim mutation failed: StackLockIoError`.
//
// This test pins the fix: `acquireStackLock` MUST be idempotent against
// "parent directory doesn't exist yet" — the substrate's contract is
// "claim the lock", not "claim the lock, but first someone else must
// have made sure the directory exists."

import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Effect, Scope } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import {
	acquireStackLock,
	StackLockIoError,
} from '../../../../src/substrate/runtime/cross-process/stack-lock.ts';
import { claim } from '../../../../src/substrate/runtime/cross-process/roster.ts';
import { withTempRoot } from '../../../helpers/with-temp-root.ts';

describe('acquireStackLock', () => {
	it.effect('creates the parent directory when missing (fresh runtime root)', () =>
		withTempRoot('stack-lock-test', (root) =>
			Effect.gen(function* () {
				// Path two levels deep — `<root>/stacks/stack/stack.lock`.
				// `<root>/stacks/stack/` does NOT exist yet; the claim
				// path must mkdir -p before the O_EXCL write.
				const stackRoot = join(root, 'stacks', 'main');
				const lockPath = join(stackRoot, 'stack.lock');
				expect(existsSync(stackRoot)).toBe(false);

				yield* Effect.scoped(
					Effect.gen(function* () {
						yield* acquireStackLock(lockPath);
						// We own the lock: file exists, parent dir
						// exists, no error surfaced.
						expect(existsSync(lockPath)).toBe(true);
						expect(existsSync(stackRoot)).toBe(true);
					}),
				);

				// After scope close, the lock file is unlinked.
				expect(existsSync(lockPath)).toBe(false);
				// Parent directory remains (mkdir is idempotent
				// across acquires; we don't reap it).
				expect(existsSync(stackRoot)).toBe(true);
			}),
		),
	);

	it.effect('roster.claim succeeds on a fresh runtime root (regression: StackLockIoError)', () =>
		withTempRoot('stack-lock-test', (root) =>
			Effect.gen(function* () {
				const stackRoot = join(root, 'stacks', 'main');
				const paths = {
					stackLockFile: join(stackRoot, 'stack.lock'),
					rosterFile: join(stackRoot, 'roster.json'),
				};
				// Pre-fix: `roster.claim` failed with
				// `StackLockIoError({ cause: ENOENT })` because
				// `tryAcquireSync` invoked `writeFileSync` on a path
				// whose parent didn't exist.
				const result = yield* claim(paths).pipe(Effect.exit);
				if (result._tag === 'Failure') {
					// If we still see the IO error, fail loudly so the
					// regression name appears in the test output.
					expect.fail(`claim failed with: ${JSON.stringify(result.cause)}`);
				}
				expect(result._tag).toBe('Success');
				if (result._tag === 'Success') {
					expect(result.value.roster.holders.length).toBe(1);
					expect(existsSync(paths.rosterFile)).toBe(true);
				}
			}),
		),
	);

	it.effect('re-acquire after release works (lock file is unlinked at scope close)', () =>
		withTempRoot('stack-lock-test', (root) =>
			Effect.gen(function* () {
				const stackRoot = join(root, 'stacks', 'main');
				const lockPath = join(stackRoot, 'stack.lock');

				yield* Effect.scoped(
					Effect.gen(function* () {
						yield* acquireStackLock(lockPath);
					}),
				);
				// Second acquire on a now-existing parent — exercises
				// the mkdir-p idempotence + the warm path.
				yield* Effect.scoped(
					Effect.gen(function* () {
						yield* acquireStackLock(lockPath);
						expect(existsSync(lockPath)).toBe(true);
					}),
				);
			}),
		),
	);
});

describe('acquireStackLock — unparseable body + mtime staleness', () => {
	// Regression for review fix phase 22f Bug 3: a peer that died mid-
	// write leaves the lock body unparseable. The PID liveness check
	// has nothing to consult (parse returned null), and pre-fix the
	// loop fell through to the exponential backoff and burned the full
	// 5s timeout. Fix: if the body is unparseable AND the file's mtime
	// is older than `DEFAULT_SWEEP_POLICY.staleAfterMillis` (30s), the
	// next peer reclaims via unlink + retry.
	it.live('reclaims an unparseable lock body once mtime exceeds the staleness window', () =>
		withTempRoot('stack-lock-mtime', (root) =>
			Effect.gen(function* () {
				const stackRoot = join(root, 'stacks', 'main');
				mkdirSync(stackRoot, { recursive: true });
				const lockPath = join(stackRoot, 'stack.lock');
				// Plant unparseable garbage (mid-write crash simulation).
				writeFileSync(lockPath, '{partial-json', { flag: 'wx' });
				// Backdate mtime by 60s (well past the 30s sweep window).
				const past = (Date.now() - 60_000) / 1_000;
				utimesSync(lockPath, past, past);

				// Tight 1s budget — without the mtime-stale reclaim, the
				// loop falls through to exponential backoff and burns the
				// budget. With the fix, the first iteration's parse-null
				// + mtime check triggers reclaim and the next O_EXCL wins.
				yield* Effect.scoped(
					Effect.gen(function* () {
						yield* acquireStackLock(lockPath, 1_000);
						expect(existsSync(lockPath)).toBe(true);
					}),
				);
				// Scope close unlinked our acquire.
				expect(existsSync(lockPath)).toBe(false);
			}),
		),
	);

	it.live('does NOT reclaim an unparseable lock body whose mtime is fresh', () =>
		withTempRoot('stack-lock-mtime', (root) =>
			Effect.gen(function* () {
				const stackRoot = join(root, 'stacks', 'main');
				mkdirSync(stackRoot, { recursive: true });
				const lockPath = join(stackRoot, 'stack.lock');
				// Plant unparseable garbage with current mtime — peer is
				// presumed actively writing; respect the staleness budget
				// rather than racing them. A short timeout proves we DON'T
				// reclaim within the staleness window.
				writeFileSync(lockPath, '{partial-json', { flag: 'wx' });

				const exit = yield* Effect.scoped(acquireStackLock(lockPath, 300)).pipe(Effect.exit);
				expect(exit._tag).toBe('Failure');
				// The file is still on disk — we never reclaimed it.
				expect(existsSync(lockPath)).toBe(true);
			}),
		),
	);
});

// Sanity: the typed error union still exists. If the IO-error path
// regresses in the future (e.g. a permission-denied on parent mkdir),
// the failure must still surface as `StackLockIoError` so callers
// keep their catchTag working.
describe('StackLockIoError', () => {
	it('is a tagged failure', () => {
		const err = new StackLockIoError({ path: '/x', cause: new Error('boom') });
		expect(err._tag).toBe('StackLockIoError');
	});
});

void Scope; // keep the import live; Scope reference avoids unused-import lint
