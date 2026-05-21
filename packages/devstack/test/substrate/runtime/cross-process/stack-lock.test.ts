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

import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect, Scope } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import {
	acquireStackLock,
	StackLockIoError,
} from '../../../../src/substrate/runtime/cross-process/stack-lock.ts';
import { claim } from '../../../../src/substrate/runtime/cross-process/roster.ts';

const freshRoot = (): string => mkdtempSync(join(tmpdir(), 'stack-lock-test-'));

describe('acquireStackLock', () => {
	it.effect('creates the parent directory when missing (fresh runtime root)', () =>
		Effect.gen(function* () {
			const root = freshRoot();
			try {
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
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('roster.claim succeeds on a fresh runtime root (regression: StackLockIoError)', () =>
		Effect.gen(function* () {
			const root = freshRoot();
			try {
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
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('re-acquire after release works (lock file is unlinked at scope close)', () =>
		Effect.gen(function* () {
			const root = freshRoot();
			try {
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
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
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
