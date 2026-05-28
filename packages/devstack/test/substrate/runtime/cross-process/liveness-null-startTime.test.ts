// Regression — Phase 22a Critical finding 2:
//
// Before this fix, `ownHolder()` coerced an unprobable start-time to
// the literal `0` (`processStartTime(pid) ?? 0`). `isOwnEntry` in
// `roster.ts` was already null-conservative (skip the start-time
// check when `ownStartTime` is null), but `ownHolder` wrote `0` to
// disk, so subsequent `release` / `heartbeat` invocations on a host
// that NOW had a working probe would compare a real probed stamp
// against the recorded `0` and refuse to match. The process could no
// longer remove its own roster entry — and peers harvested it as
// "dead" because `0 !== probed`.
//
// The fix:
//   * `RosterHolderSchema.startTime` is now `number | null` (and the
//     `StackLockBodySchema` mirror likewise).
//   * `ownHolder()` writes `null` verbatim when the probe yields null.
//   * `checkHolderLiveness` treats a recorded `null` as alive (same
//     conservative branch as a `null` probedStart — there is no real
//     value to dispute the recorded null against).
//   * `isOwnEntry` short-circuits on EITHER side being null, falling
//     back to the (pid, hostname) match.
//
// This test pins the round-trip: a roster entry written with
// `startTime: null` must be recognized as our own by `release`, even
// when the current `processStartTime` probe yields a real number.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname as nodeHostname } from 'node:os';
import { join } from 'node:path';

import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import {
	claim,
	heartbeat,
	release,
} from '../../../../src/substrate/runtime/cross-process/roster.ts';
import { withTempRoot } from '../../../helpers/with-temp-root.ts';

const NULL_STARTTIME_TEST_TIMEOUT_MS = 15_000;

const pathsFor = (
	root: string,
): { readonly stackLockFile: string; readonly rosterFile: string } => {
	const stackRoot = join(root, 'app', 'main');
	return {
		stackLockFile: join(stackRoot, 'stack.lock'),
		rosterFile: join(stackRoot, 'roster.json'),
	};
};

const seedRoster = (
	rosterFile: string,
	holders: ReadonlyArray<{
		readonly pid: number;
		readonly startTime: number | null;
		readonly hostname: string;
		readonly claimedAt: number;
		readonly heartbeatAt: number;
		readonly intent: 'normal' | 'snapshot';
	}>,
): void => {
	mkdirSync(join(rosterFile, '..'), { recursive: true });
	writeFileSync(rosterFile, JSON.stringify({ version: 1, holders }));
};

describe('roster startTime=null round-trip — own-entry identity is preserved', () => {
	it.effect(
		'release(): a null-startTime entry written for THIS process is removable',
		() =>
			withTempRoot('roster-null-startTime', (root) =>
				Effect.gen(function* () {
					const paths = pathsFor(root);
					// Hand-write the roster bypassing `claim()` so we deliberately
					// stamp `startTime: null`. This simulates the exotic-platform
					// path (`ps`/`tasklist` failed) and pins the bug: a later
					// probe yielding a real number must NOT prevent the process
					// from recognizing its own entry.
					seedRoster(paths.rosterFile, [
						{
							pid: process.pid,
							startTime: null,
							hostname: nodeHostname(),
							claimedAt: Date.now(),
							heartbeatAt: Date.now(),
							intent: 'normal',
						},
					]);

					// Release removes OUR entry. With the bug, `isOwnEntry`
					// would have compared `null !== probedStart` and left the
					// entry in place (lastLeaver=false). With the fix, both
					// sides null-conservatively short-circuit to (pid, host)
					// and we ARE the last leaver.
					const result = yield* release(paths);
					expect(result.lastLeaver).toBe(true);
					expect(result.roster.holders).toHaveLength(0);
				}),
			),
		NULL_STARTTIME_TEST_TIMEOUT_MS,
	);

	it.effect(
		'heartbeat(): refreshes a null-startTime entry written for THIS process',
		() =>
			withTempRoot('roster-null-startTime', (root) =>
				Effect.gen(function* () {
					const paths = pathsFor(root);
					const STAMP = 100;
					seedRoster(paths.rosterFile, [
						{
							pid: process.pid,
							startTime: null,
							hostname: nodeHostname(),
							claimedAt: STAMP,
							heartbeatAt: STAMP,
							intent: 'normal',
						},
					]);

					yield* heartbeat(paths);

					const onDisk = JSON.parse(readFileSync(paths.rosterFile, 'utf8')) as {
						readonly holders: ReadonlyArray<{
							readonly heartbeatAt: number;
							readonly startTime: number | null;
						}>;
					};
					expect(onDisk.holders).toHaveLength(1);
					// heartbeatAt got bumped — proving heartbeat recognized our
					// null-startTime entry as own.
					expect(onDisk.holders[0]!.heartbeatAt).toBeGreaterThan(STAMP);
					// startTime stayed null — heartbeat doesn't rewrite it.
					expect(onDisk.holders[0]!.startTime).toBeNull();
				}),
			),
		NULL_STARTTIME_TEST_TIMEOUT_MS,
	);

	it.effect(
		'claim(): does NOT evict a peer with null startTime even when its heartbeat is stale',
		() =>
			withTempRoot('roster-null-startTime', (root) =>
				Effect.gen(function* () {
					const paths = pathsFor(root);
					// Seed a peer with pid=1 (init — alive on every POSIX host),
					// hostname matching, heartbeat WAY in the past, startTime
					// null. The pre-fix policy compared probedStart (1 → some
					// real stamp) against recorded null → mismatch → dead.
					// The fix's null-conservative branch in
					// `checkHolderLiveness` treats this as ALIVE, so the peer
					// survives even though its heartbeat is stale.
					seedRoster(paths.rosterFile, [
						{
							pid: 1,
							startTime: null,
							hostname: nodeHostname(),
							claimedAt: 0,
							heartbeatAt: 0,
							intent: 'normal',
						},
					]);

					const result = yield* claim(paths);
					// Our own entry was appended; the pid=1 peer should still
					// be present because the null-startTime conservative branch
					// declined to evict it.
					const pids = result.roster.holders.map((h) => h.pid);
					expect(pids).toContain(1);
					expect(pids).toContain(process.pid);
				}),
			),
		NULL_STARTTIME_TEST_TIMEOUT_MS,
	);
});
