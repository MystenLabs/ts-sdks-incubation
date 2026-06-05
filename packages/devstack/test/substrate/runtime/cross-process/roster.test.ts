// Roster claim / release — atomic-write integration smoke.
//
// After the atomic-write consolidation, every roster mutation routes
// through the canonical `atomicWriteFileSync` (no inline tempfile +
// rename dances). These tests pin the contract from the consumer's
// POV: claim writes a parseable roster, no tempfile leaks on success.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import { claim, release } from '../../../../src/substrate/runtime/cross-process/roster.ts';
import { processStartTime } from '../../../../src/substrate/runtime/cross-process/liveness.ts';
import { withTempRoot } from '../../../helpers/with-temp-root.ts';

const ROSTER_TEST_TIMEOUT_MS = 15_000;

const pathsFor = (
	root: string,
): {
	readonly stackLockFile: string;
	readonly rosterFile: string;
} => {
	const stackRoot = join(root, 'app', 'main');
	return {
		stackLockFile: join(stackRoot, 'stack.lock'),
		rosterFile: join(stackRoot, 'roster.json'),
	};
};

describe('roster.claim / release', () => {
	it.effect(
		'claim writes a parseable roster.json via the canonical primitive',
		() =>
			withTempRoot('roster-test', (root) =>
				Effect.gen(function* () {
					const paths = pathsFor(root);
					const result = yield* claim(paths);
					expect(result.roster.holders).toHaveLength(1);
					expect(existsSync(paths.rosterFile)).toBe(true);
					const onDisk = JSON.parse(readFileSync(paths.rosterFile, 'utf8'));
					expect(onDisk.version).toBe(1);
					expect(onDisk.holders).toHaveLength(1);
					expect(existsSync(paths.stackLockFile)).toBe(false);
				}),
			),
		ROSTER_TEST_TIMEOUT_MS,
	);

	it.effect(
		'release drops THIS process and reports last-leaver',
		() =>
			withTempRoot('roster-test', (root) =>
				Effect.gen(function* () {
					const paths = pathsFor(root);
					yield* claim(paths);
					const result = yield* release(paths);
					expect(result.lastLeaver).toBe(true);
					expect(result.roster.holders).toHaveLength(0);
				}),
			),
		ROSTER_TEST_TIMEOUT_MS,
	);

	it.effect(
		'claim leaves no tempfile siblings on success',
		() =>
			withTempRoot('roster-test', (root) =>
				Effect.gen(function* () {
					const paths = pathsFor(root);
					yield* claim(paths);
					yield* release(paths);
					const siblings = readdirSync(join(root, 'app', 'main'));
					expect(siblings.filter((s) => s.includes('.tmp.'))).toEqual([]);
					expect(siblings).toContain('roster.json');
				}),
			),
		ROSTER_TEST_TIMEOUT_MS,
	);
});

// Regression for Phase B1: `isOwnEntry` now matches on
// `(pid, hostname, startTime)`. With the previous PID-only check, a
// recycled-PID peer on a long-uptime host could be silently overwritten
// by `heartbeat`/`release`/`setIntent`. The triple match prevents that.
//
// We seed a roster entry with the SAME `pid` + `hostname` as the current
// process but a DIFFERENT `startTime`, then run `release`. The peer
// entry MUST survive because the startTime triple match identifies it as
// a different process.
describe('roster.isOwnEntry — (pid, hostname, startTime) triple match', () => {
	it.effect(
		'release leaves a same-(pid, hostname) peer with a different startTime in place',
		() =>
			withTempRoot('roster-test', (root) =>
				Effect.gen(function* () {
					const paths = pathsFor(root);
					// Skip if the platform can't probe startTime — on null,
					// `isOwnEntry` falls back to (pid, hostname) only, which is
					// the documented conservative policy (`liveness.ts`).
					const ownStartTime = processStartTime(process.pid);
					if (ownStartTime === null) return;
					// Seed: claim with the real process identity, then patch the
					// roster on disk to introduce a peer with the same pid +
					// hostname but a different startTime.
					yield* claim(paths);
					const initialRoster = JSON.parse(readFileSync(paths.rosterFile, 'utf8')) as {
						readonly version: 1;
						readonly holders: ReadonlyArray<{
							readonly pid: number;
							readonly hostname: string;
							readonly startTime: number;
							readonly heartbeatAt: number;
							readonly intent: string;
						}>;
					};
					expect(initialRoster.holders).toHaveLength(1);
					const ours = initialRoster.holders[0]!;

					// Construct a synthetic peer with the same (pid, hostname) but
					// a clearly different startTime — simulating a recycled PID
					// on the same host. The triple match must treat this as a
					// DIFFERENT process.
					const peerStartTime = ours.startTime + 999_999;
					const recycledPeer = {
						...ours,
						startTime: peerStartTime,
						heartbeatAt: Date.now(),
					};
					writeFileSync(
						paths.rosterFile,
						JSON.stringify({
							version: 1,
							holders: [ours, recycledPeer],
						}),
					);

					const result = yield* release(paths);

					// We dropped our entry, but the recycled-PID peer survives
					// because its startTime differs from ours.
					expect(result.lastLeaver).toBe(false);
					expect(result.roster.holders).toHaveLength(1);
					expect(result.roster.holders[0]?.startTime).toBe(peerStartTime);
				}),
			),
		ROSTER_TEST_TIMEOUT_MS,
	);
});
