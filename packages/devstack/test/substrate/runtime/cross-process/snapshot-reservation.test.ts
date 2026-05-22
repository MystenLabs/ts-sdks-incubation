import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect, Exit } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import { processStartTime } from '../../../../src/substrate/runtime/cross-process/liveness.ts';
import {
	acquireReservation,
	SnapshotReservationHeldError,
	sweepOrphan,
} from '../../../../src/substrate/runtime/cross-process/snapshot-reservation.ts';

const freshRoot = (): string => mkdtempSync(join(tmpdir(), 'snapshot-reservation-test-'));

const reservationPath = (root: string): string => join(root, 'snapshot.reservation');

describe('snapshot reservation PID/start-time safety', () => {
	it.effect('writes pid/start-time reservation body and unlinks it on scope close', () =>
		Effect.gen(function* () {
			const root = freshRoot();
			const path = reservationPath(root);
			try {
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
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('refuses a live same-process reservation instead of sweeping it', () =>
		Effect.gen(function* () {
			const root = freshRoot();
			const path = reservationPath(root);
			try {
				const startTime = processStartTime(process.pid) ?? 0;
				writeFileSync(
					path,
					JSON.stringify({
						creatorPid: process.pid,
						creatorStartTime: startTime,
						createdAt: Date.now(),
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
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('sweeps a reservation whose pid is live but start-time does not match', () =>
		Effect.gen(function* () {
			const root = freshRoot();
			const path = reservationPath(root);
			try {
				const realStartTime = processStartTime(process.pid);
				if (realStartTime === null) return;
				writeFileSync(
					path,
					JSON.stringify({
						creatorPid: process.pid,
						creatorStartTime: realStartTime + 1,
						createdAt: Date.now(),
					}),
				);

				const result = yield* sweepOrphan(path);
				expect(result.swept).toBe(true);
				expect(existsSync(path)).toBe(false);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);
});
