import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname as nodeHostname } from 'node:os';
import { join } from 'node:path';

import { Effect, Exit } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import { processStartTime } from '../../../../src/substrate/runtime/cross-process/liveness.ts';
import {
	acquireReservation,
	SnapshotReservationHeldError,
	sweepOrphan,
} from '../../../../src/substrate/runtime/cross-process/snapshot-reservation.ts';
import { withTempRoot } from '../../../helpers/with-temp-root.ts';

const reservationPath = (root: string): string => join(root, 'snapshot.reservation');

describe('snapshot reservation PID/start-time safety', () => {
	it.effect('writes pid/start-time reservation body and unlinks it on scope close', () =>
		withTempRoot('snapshot-reservation-test', (root) =>
			Effect.gen(function* () {
				const path = reservationPath(root);
				const startTime = processStartTime(process.pid) ?? 0;
				yield* Effect.scoped(
					Effect.gen(function* () {
						const reservation = yield* acquireReservation(path, startTime);
						expect(reservation.creatorPid).toBe(process.pid);
						expect(reservation.creatorStartTime).toBe(startTime);

						const onDisk = JSON.parse(readFileSync(path, 'utf8')) as {
							readonly creatorPid: number;
							readonly creatorStartTime: number;
						};
						expect(onDisk.creatorPid).toBe(process.pid);
						expect(onDisk.creatorStartTime).toBe(startTime);
					}),
				);

				expect(existsSync(path)).toBe(false);
			}),
		),
	);

	it.effect('refuses a live same-process reservation instead of sweeping it', () =>
		withTempRoot('snapshot-reservation-test', (root) =>
			Effect.gen(function* () {
				const path = reservationPath(root);
				const startTime = processStartTime(process.pid) ?? 0;
				writeFileSync(
					path,
					JSON.stringify({
						version: 1,
						creatorPid: process.pid,
						creatorStartTime: startTime,
						createdAt: Date.now(),
						hostname: nodeHostname(),
					}),
				);

				const exit = yield* Effect.scoped(acquireReservation(path, startTime)).pipe(Effect.exit);
				expect(exit._tag).toBe('Failure');
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some') {
					expect(error.value).toBeInstanceOf(SnapshotReservationHeldError);
				}
				expect(existsSync(path)).toBe(true);
			}),
		),
	);

	it.effect('sweeps a reservation whose pid is live but start-time does not match', () =>
		withTempRoot('snapshot-reservation-test', (root) =>
			Effect.gen(function* () {
				const path = reservationPath(root);
				const realStartTime = processStartTime(process.pid);
				if (realStartTime === null) return;
				writeFileSync(
					path,
					JSON.stringify({
						version: 1,
						creatorPid: process.pid,
						creatorStartTime: realStartTime + 1,
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
