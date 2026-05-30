// stack-lock — multi-peer dead-holder reclaim stress.
//
// Code-review speculation (review fix phase 22f):
//   "dead-holder reclaim `unlinkSync` races every peer: multiple peers
//   can each observe the same dead holder, each `unlink` succeeds (or
//   `ENOENT`s harmlessly), and the next `O_EXCL` create is the actual
//   arbiter. That's fine, but the surrounding `Effect.try` returns
//   `null` on success so the loop body always continues to the jitter
//   `sleep` — no rapid retry of the now-reclaimable slot. Combined with
//   the timeout check at top, an unlucky scheduling could see the
//   5_000ms budget exhausted before any peer wins."
//
// This test exercises the reclaim path under N concurrent fibers all
// fighting over a single stale-holder slot. Per the phase-22f decision
// for speculative items: the reproducer goes in FIRST; only if it
// demonstrates the bug do we patch the production code. Either way the
// test stays as a permanent regression guard so a future regression in
// the reclaim loop surfaces under CI rather than at user-stack-boot.

import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { Effect, Exit } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import {
	acquireStackLock,
	StackLockTimeoutError,
} from '../../../../src/substrate/runtime/cross-process/stack-lock.ts';
import { withTempRoot } from '../../../helpers/with-temp-root.ts';

/** Spawn a no-op child, wait for it to exit, and return its (now-dead)
 *  pid. The pid is guaranteed to fail `kill(pid, 0)` with ESRCH unless
 *  the OS rapidly recycles it — exceedingly unlikely within the test's
 *  multi-hundred-ms window. */
const deadPid = (): number => {
	const proc = spawnSync(process.execPath, ['-e', 'process.exit(0)'], {
		stdio: 'ignore',
		timeout: 5_000,
	});
	if (proc.pid === undefined) {
		throw new Error('failed to spawn helper for dead-pid probe');
	}
	return proc.pid;
};

const plantDeadHolder = (lockPath: string): void => {
	const body = {
		pid: deadPid(),
		// `startTime: null` is fine — `isPidAlive` returns false for the
		// reaped pid BEFORE the start-time branch fires, so liveness
		// returns 'dead' deterministically (liveness.ts:153).
		startTime: null,
		hostname: hostname(),
		claimedAt: Date.now() - 60_000,
		heartbeatAt: Date.now() - 60_000,
		intent: 'normal' as const,
	};
	writeFileSync(lockPath, JSON.stringify(body), { flag: 'wx' });
};

describe('acquireStackLock — dead-holder reclaim under multi-peer contention', () => {
	it.live(
		'N peers all eventually win the lock when a dead holder is sitting on it',
		() =>
			withTempRoot('stack-lock-reclaim-stress', (root) =>
				Effect.gen(function* () {
					const stackRoot = join(root, 'stacks', 'main');
					mkdirSync(stackRoot, { recursive: true });
					const lockPath = join(stackRoot, 'stack.lock');
					plantDeadHolder(lockPath);

					// 8 peers racing. The 5s default budget is the
					// architecture's claim-window. Each peer briefly holds
					// the lock (10ms) then releases.
					const N = 8;
					const winners: number[] = [];
					const peer = (id: number) =>
						Effect.scoped(
							Effect.gen(function* () {
								yield* acquireStackLock(lockPath);
								winners.push(id);
								yield* Effect.sleep('10 millis');
							}),
						).pipe(Effect.exit);

					const exits = yield* Effect.all(
						Array.from({ length: N }, (_, i) => peer(i)),
						{ concurrency: 'unbounded' },
					);

					// Every peer must succeed — either via reclaim of the
					// dead holder (first winner) or via natural release of
					// a previous peer (subsequent winners).
					for (const exit of exits) {
						if (Exit.isFailure(exit)) {
							const err = Exit.findErrorOption(exit);
							if (err._tag === 'Some') {
								expect.fail(
									`peer failed under reclaim stress: ${JSON.stringify(err.value)}`,
								);
							}
							expect.fail('peer failed under reclaim stress with no error value');
						}
					}
					expect(winners.length).toBe(N);
				}),
			),
		15_000,
	);

	it.live(
		'reclaim path respects the timeout budget (sanity: a STILL-LIVE holder times out)',
		() =>
			withTempRoot('stack-lock-reclaim-stress', (root) =>
				Effect.gen(function* () {
					const stackRoot = join(root, 'stacks', 'main');
					mkdirSync(stackRoot, { recursive: true });
					const lockPath = join(stackRoot, 'stack.lock');
					// Plant the CURRENT process as the holder. Liveness
					// returns 'alive', so reclaim never fires; the peer
					// must time out cleanly within the budget.
					writeFileSync(
						lockPath,
						JSON.stringify({
							pid: process.pid,
							startTime: null,
							hostname: hostname(),
							claimedAt: Date.now(),
							heartbeatAt: Date.now(),
							intent: 'normal' as const,
						}),
						{ flag: 'wx' },
					);
					const exit = yield* Effect.scoped(acquireStackLock(lockPath, 250)).pipe(
						Effect.exit,
					);
					if (Exit.isSuccess(exit)) {
						expect.fail('expected timeout against a live holder');
					}
					const err = Exit.findErrorOption(exit);
					expect(err._tag).toBe('Some');
					if (err._tag === 'Some') {
						expect((err.value as StackLockTimeoutError)._tag).toBe('StackLockTimeoutError');
					}
				}),
			),
		5_000,
	);
});
