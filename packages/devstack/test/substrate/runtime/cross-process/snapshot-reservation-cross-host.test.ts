// Regression — Phase 22a Critical finding 1:
//
// Before this fix, `sweepOrphan` synthesized a holder with hostname=''
// and passed ownHost='' to `checkHolderLiveness`. Because both
// arguments matched, the foreign-host fast-path was bypassed and the
// reservation's pid/start-time was probed against the LOCAL kernel
// even when the reservation had been written by a peer on a
// DIFFERENT host (NFS / shared-filesystem dev cluster). A live remote
// process could therefore be declared "dead" and its reservation
// unlinked under it.
//
// The fix added a `hostname` field to `SnapshotReservationSchema`
// (versioned via `versionedDocSchema`) and a foreign-host short-circuit
// in `sweepOrphan`: a reservation whose hostname does not match
// `os.hostname()` is treated as alive (NFS-safe conservative default).
//
// This test seeds a reservation file claiming hostname='other-host'
// and a clearly-dead pid (pid=1, startTime=0) — a same-host sweep
// would unlink it; the fixed cross-host sweep MUST leave it intact.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname as nodeHostname } from 'node:os';
import { join } from 'node:path';

import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import { sweepOrphan } from '../../../../src/substrate/runtime/cross-process/snapshot-reservation.ts';
import { withTempRoot } from '../../../helpers/with-temp-root.ts';

const reservationPath = (root: string): string => join(root, 'snapshot.reservation');

describe('snapshot reservation cross-host sweep safety', () => {
	it.effect(
		'leaves a foreign-host reservation in place even when its pid would be probed dead locally',
		() =>
			withTempRoot('snapshot-reservation-cross-host', (root) =>
				Effect.gen(function* () {
					const path = reservationPath(root);
					// Pid 1 (init) and startTime 0 would, on the local host,
					// probe as a clear "dead" mismatch — pre-fix, the sweep
					// would happily unlink. With the hostname field present
					// and not equal to os.hostname(), the cross-host fast-path
					// must short-circuit and leave the file alone.
					writeFileSync(
						path,
						JSON.stringify({
							version: 1,
							creatorPid: 999999,
							creatorStartTime: 0,
							createdAt: Date.now(),
							hostname: 'other-host-this-machine-cannot-probe',
						}),
					);

					const result = yield* sweepOrphan(path);

					expect(result.swept).toBe(false);
					expect(existsSync(path)).toBe(true);
					// Sanity: the body we wrote is still byte-identical (the
					// sweep didn't rewrite the file).
					const onDisk = JSON.parse(readFileSync(path, 'utf8'));
					expect(onDisk.hostname).toBe('other-host-this-machine-cannot-probe');
					expect(onDisk.creatorPid).toBe(999999);
				}),
			),
	);

	it.effect(
		'still sweeps a SAME-host reservation whose pid is clearly dead (regression guard)',
		() =>
			withTempRoot('snapshot-reservation-cross-host', (root) =>
				Effect.gen(function* () {
					const path = reservationPath(root);
					writeFileSync(
						path,
						JSON.stringify({
							version: 1,
							creatorPid: 999999,
							creatorStartTime: 0,
							createdAt: Date.now(),
							hostname: nodeHostname(),
						}),
					);

					const result = yield* sweepOrphan(path);

					expect(result.swept).toBe(true);
					expect(existsSync(path)).toBe(false);
				}),
			),
	);
});
