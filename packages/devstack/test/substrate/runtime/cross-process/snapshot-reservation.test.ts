import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
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

describe('snapshot reservation malformed-body sweep (shared re-stat guard)', () => {
	// `sweepOrphan`'s malformed-body branch now routes through
	// `reclaimUnparseableStaleFile`, the same guarded reclaim stack-lock
	// uses. These cases pin the guard's behavior at the public entry
	// point: an aged garbage body is reclaimed, but a fresh garbage body
	// (writer presumed mid-flush) is left alone — and a body that has
	// since become a VALID live reservation is never swept by this
	// branch.

	it.effect('sweeps an AGED malformed reservation body (mtime past the staleness window)', () =>
		withTempRoot('snapshot-reservation-malformed', (root) =>
			Effect.gen(function* () {
				const path = reservationPath(root);
				writeFileSync(path, '{partial-json', { flag: 'wx' });
				// Backdate 60s — well past the 30s staleness budget.
				const past = (Date.now() - 60_000) / 1_000;
				utimesSync(path, past, past);

				const result = yield* sweepOrphan(path);
				expect(result.swept).toBe(true);
				expect(existsSync(path)).toBe(false);
			}),
		),
	);

	it.effect('leaves a FRESH malformed reservation body alone (writer presumed mid-flush)', () =>
		withTempRoot('snapshot-reservation-malformed', (root) =>
			Effect.gen(function* () {
				const path = reservationPath(root);
				// Current mtime — inside the staleness window.
				writeFileSync(path, '{partial-json', { flag: 'wx' });

				const result = yield* sweepOrphan(path);
				expect(result.swept).toBe(false);
				// Untouched — the guard respects the staleness budget rather
				// than racing a peer that may still be flushing its body.
				expect(existsSync(path)).toBe(true);
				expect(readFileSync(path, 'utf8')).toBe('{partial-json');
			}),
		),
	);

	it.effect(
		'does NOT sweep a body that is now a VALID live reservation, even when its mtime is old',
		() =>
			withTempRoot('snapshot-reservation-malformed', (root) =>
				Effect.gen(function* () {
					const path = reservationPath(root);
					const startTime = processStartTime(process.pid) ?? 0;
					// A well-formed reservation owned by THIS (live) process,
					// but with an aged mtime — the scenario the TOCTOU guard
					// protects: a competitor reclaimed the garbage and wrote a
					// fresh valid body. The malformed branch must not unlink a
					// parseable body, and the live-holder branch keeps it too.
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
					const past = (Date.now() - 60_000) / 1_000;
					utimesSync(path, past, past);

					const result = yield* sweepOrphan(path);
					expect(result.swept).toBe(false);
					expect(existsSync(path)).toBe(true);
				}),
			),
	);
});
