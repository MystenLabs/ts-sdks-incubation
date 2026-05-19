// Unit tests for `engine/sui-fork/control.ts`.
//
// Coverage:
//   - `resolveAutoTickIntervalMs` — Phase 5 P5.5.1: public knob shape
//     (`boolean | { intervalMs }`) folds to a number-or-undefined.
//   - `runAutoTickClock` — P5.5.2: the scope-bound fiber tickets the
//     advance-clock RPC at the configured cadence and dies on scope
//     close. A failing tick keeps the fiber alive (failure policy from
//     R9).
//   - `subscribeCheckpoints` / `pollCheckpoints` /
//     `subscribeCheckpointsWithFallback` — P5.10.T1/T2: stream emits on
//     checkpoint advance, falls back to polling when the subscription
//     stream errors, and dedupes the polling-side cursor.
//
// All tests run in-process against a stub `SuiGrpcClient` — no docker,
// no real fork container. The docker-gated counterpart
// (`subscribeCheckpoints` against a live fork) lands in
// `engine/sui-fork.container.docker.test.ts` (P5.10.T3) once the
// container side is verified end-to-end.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, expect, it } from '@effect/vitest';
import { Effect, Fiber, Stream } from 'effect';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import {
	DEFAULT_AUTO_TICK_INTERVAL_MS,
	pollCheckpoints,
	resolveAutoTickIntervalMs,
	resolveResumeAutoTickIntervalMs,
	runAutoTickClock,
	subscribeCheckpoints,
	subscribeCheckpointsWithFallback,
} from './control.js';

// -----------------------------------------------------------------------------
// Stub client builder
//
// We only touch the `forkingService.advanceClock` /
// `forkingService.getStatus` / `subscriptionService.subscribeCheckpoints`
// surface, so a minimal partial cast is sufficient. The cast through
// `unknown` keeps the test honest about which SDK fields we depend on.
// -----------------------------------------------------------------------------

interface StubControls {
	advanceClockCalls: Array<bigint | undefined>;
	getStatusResponses: Array<{ checkpointSequenceNumber: bigint }>;
	subscriptionResponses: Array<{ cursor?: bigint }>;
	subscriptionShouldError: boolean;
	advanceClockBehavior: 'ok' | 'throw';
}

const makeStubClient = (
	controls: StubControls,
): { client: SuiGrpcClient; controls: StubControls } => {
	let statusIdx = 0;
	const client = {
		forkingService: {
			advanceClock: (req: { durationMs?: bigint }) => {
				controls.advanceClockCalls.push(req.durationMs);
				if (controls.advanceClockBehavior === 'throw') {
					return {
						response: Promise.reject(new Error('stub advanceClock failure')),
					};
				}
				return {
					response: Promise.resolve({ timestampMs: 1n, txDigest: 'stub-digest' }),
				};
			},
			getStatus: (_req: unknown) => {
				const resp =
					controls.getStatusResponses[statusIdx % controls.getStatusResponses.length] ??
					({ checkpointSequenceNumber: 0n } as const);
				statusIdx += 1;
				return { response: Promise.resolve(resp) };
			},
		},
		subscriptionService: {
			subscribeCheckpoints: () => {
				const { subscriptionResponses, subscriptionShouldError } = controls;
				const iter = (async function* () {
					if (subscriptionShouldError) {
						throw new Error('stub subscription disconnect');
					}
					for (const r of subscriptionResponses) {
						yield r;
					}
				})();
				return {
					responses: {
						[Symbol.asyncIterator]: () => iter,
					},
				};
			},
		},
	};
	return { client: client as unknown as SuiGrpcClient, controls };
};

describe('engine/sui-fork/control', () => {
	// ---------------------------------------------------------------------------
	// P5.5.1 — resolveAutoTickIntervalMs (public knob shape)
	// ---------------------------------------------------------------------------

	describe('resolveAutoTickIntervalMs (P5.5.1)', () => {
		it('returns undefined for off-shapes (undefined / false)', () => {
			expect(resolveAutoTickIntervalMs(undefined)).toBeUndefined();
			expect(resolveAutoTickIntervalMs(false)).toBeUndefined();
		});

		it('uses the default cadence for `autoTick: true`', () => {
			expect(resolveAutoTickIntervalMs(true)).toBe(DEFAULT_AUTO_TICK_INTERVAL_MS);
		});

		it('honors a custom intervalMs', () => {
			expect(resolveAutoTickIntervalMs({ intervalMs: 250 })).toBe(250);
			expect(resolveAutoTickIntervalMs({ intervalMs: 60_000 })).toBe(60_000);
		});

		it('rejects zero / negative / non-finite intervals', () => {
			expect(() => resolveAutoTickIntervalMs({ intervalMs: 0 })).toThrow(/positive finite/);
			expect(() => resolveAutoTickIntervalMs({ intervalMs: -1 })).toThrow(/positive finite/);
			expect(() => resolveAutoTickIntervalMs({ intervalMs: Number.POSITIVE_INFINITY })).toThrow(
				/positive finite/,
			);
			expect(() => resolveAutoTickIntervalMs({ intervalMs: Number.NaN })).toThrow(
				/positive finite/,
			);
		});
	});

	// ---------------------------------------------------------------------------
	// P5.5.4 — resolveResumeAutoTickIntervalMs (resume fallback precedence)
	// ---------------------------------------------------------------------------

	describe('resolveResumeAutoTickIntervalMs (P5.5.4)', () => {
		it('returns saved value when fresh option is absent', () => {
			expect(resolveResumeAutoTickIntervalMs({ savedAutoTickMs: 1500 })).toBe(1500);
		});

		it('fresh option wins over saved value (true)', () => {
			expect(resolveResumeAutoTickIntervalMs({ option: true, savedAutoTickMs: 5000 })).toBe(
				DEFAULT_AUTO_TICK_INTERVAL_MS,
			);
		});

		it('fresh option wins over saved value (explicit intervalMs)', () => {
			expect(
				resolveResumeAutoTickIntervalMs({ option: { intervalMs: 250 }, savedAutoTickMs: 5000 }),
			).toBe(250);
		});

		it('explicit `false` cancels saved value (operator turns auto-tick off)', () => {
			expect(
				resolveResumeAutoTickIntervalMs({ option: false, savedAutoTickMs: 1000 }),
			).toBeUndefined();
		});

		it('returns undefined when neither option nor saved value', () => {
			expect(resolveResumeAutoTickIntervalMs({})).toBeUndefined();
		});

		it('ignores corrupt saved values (non-finite / non-positive)', () => {
			expect(resolveResumeAutoTickIntervalMs({ savedAutoTickMs: 0 })).toBeUndefined();
			expect(resolveResumeAutoTickIntervalMs({ savedAutoTickMs: -100 })).toBeUndefined();
			expect(resolveResumeAutoTickIntervalMs({ savedAutoTickMs: Number.NaN })).toBeUndefined();
			expect(
				resolveResumeAutoTickIntervalMs({ savedAutoTickMs: Number.POSITIVE_INFINITY }),
			).toBeUndefined();
		});
	});

	// ---------------------------------------------------------------------------
	// P5.5.2 — runAutoTickClock (fiber lifecycle + failure policy)
	// ---------------------------------------------------------------------------

	describe('runAutoTickClock (P5.5.2)', () => {
		it.live('fires advanceClock on the configured cadence and dies on scope teardown', () =>
			Effect.gen(function* () {
				const { client, controls } = makeStubClient({
					advanceClockCalls: [],
					getStatusResponses: [],
					subscriptionResponses: [],
					subscriptionShouldError: false,
					advanceClockBehavior: 'ok',
				});
				// A tight 5ms interval keeps the test fast. We assert that
				// at least one tick fires inside ~60ms of wall-clock —
				// any working `Effect.repeat(Schedule.spaced(5))` should
				// fire several times.
				const fiber = yield* runAutoTickClock({ client, intervalMs: 5 });
				yield* Effect.sleep('60 millis');
				yield* Fiber.interrupt(fiber);
				expect(controls.advanceClockCalls.length).toBeGreaterThan(0);
				// Every call should carry the configured interval.
				for (const ms of controls.advanceClockCalls) {
					expect(ms).toBe(5n);
				}
			}),
		);

		it.live('logs + keeps ticking on advance-clock failure (failure policy)', () =>
			Effect.gen(function* () {
				const { client, controls } = makeStubClient({
					advanceClockCalls: [],
					getStatusResponses: [],
					subscriptionResponses: [],
					subscriptionShouldError: false,
					advanceClockBehavior: 'throw',
				});
				const fiber = yield* runAutoTickClock({ client, intervalMs: 5 });
				yield* Effect.sleep('60 millis');
				// Fiber is still running despite repeated failures —
				// `pollUnsafe` returns undefined while the fiber is
				// alive, an Exit once it has terminated.
				expect(fiber.pollUnsafe()).toBeUndefined();
				yield* Fiber.interrupt(fiber);
				// Multiple failing ticks fired — failure didn't tear the
				// fiber down.
				expect(controls.advanceClockCalls.length).toBeGreaterThan(1);
			}),
		);
	});

	// ---------------------------------------------------------------------------
	// P5.10.T1 — subscribeCheckpoints emits on checkpoint advance
	// ---------------------------------------------------------------------------

	describe('subscribeCheckpoints (P5.10.T1)', () => {
		it.effect('emits one event per upstream SubscribeCheckpointsResponse', () =>
			Effect.gen(function* () {
				const { client } = makeStubClient({
					advanceClockCalls: [],
					getStatusResponses: [],
					subscriptionResponses: [{ cursor: 100n }, { cursor: 101n }, { cursor: 102n }],
					subscriptionShouldError: false,
					advanceClockBehavior: 'ok',
				});
				const events = yield* Stream.runCollect(subscribeCheckpoints(client));
				expect(events.length).toBe(3);
				expect(events[0]).toMatchObject({ cursor: 100, source: 'subscription' });
				expect(events[1]).toMatchObject({ cursor: 101, source: 'subscription' });
				expect(events[2]).toMatchObject({ cursor: 102, source: 'subscription' });
				for (const e of events) {
					expect(e.receivedAtMs).toBeGreaterThan(0);
				}
			}),
		);
	});

	// ---------------------------------------------------------------------------
	// P5.10.T2 — disconnect → polling fallback
	// ---------------------------------------------------------------------------

	describe('subscribeCheckpointsWithFallback (P5.10.T2)', () => {
		it.live('falls back to polling when the subscription stream errors', () =>
			Effect.gen(function* () {
				const { client, controls } = makeStubClient({
					advanceClockCalls: [],
					// Polling fallback should advance through these
					// checkpoint cursors as the local sequence number
					// monotonically increases.
					getStatusResponses: [
						{ checkpointSequenceNumber: 0n },
						{ checkpointSequenceNumber: 0n }, // dedupe absorbs this
						{ checkpointSequenceNumber: 1n },
						{ checkpointSequenceNumber: 2n },
					],
					subscriptionResponses: [],
					subscriptionShouldError: true,
					advanceClockBehavior: 'ok',
				});
				// 5ms poll cadence keeps the test fast; collect the
				// first 3 events (0, 1, 2) and then drop the stream.
				const collected = yield* subscribeCheckpointsWithFallback(client, 5).pipe(
					Stream.take(3),
					Stream.runCollect,
				);
				expect(collected.length).toBe(3);
				// Every emitted event should carry source='poll' —
				// subscription errored before yielding anything.
				for (const e of collected) {
					expect(e.source).toBe('poll');
				}
				// Cursors strictly monotonic increasing.
				expect(collected[0]!.cursor).toBe(0);
				expect(collected[1]!.cursor).toBe(1);
				expect(collected[2]!.cursor).toBe(2);
				// Sanity: the polling loop hit `getStatus` more than 3
				// times (dedupe absorbed the 0→0 repeat).
				expect(controls.getStatusResponses.length).toBe(4);
			}),
		);
	});

	// ---------------------------------------------------------------------------
	// pollCheckpoints — standalone dedupe coverage
	// ---------------------------------------------------------------------------

	describe('pollCheckpoints', () => {
		it.live('dedupes repeated cursors (only emits when sequence advances)', () =>
			Effect.gen(function* () {
				const { client } = makeStubClient({
					advanceClockCalls: [],
					getStatusResponses: [
						{ checkpointSequenceNumber: 5n },
						{ checkpointSequenceNumber: 5n },
						{ checkpointSequenceNumber: 5n },
						{ checkpointSequenceNumber: 6n },
						{ checkpointSequenceNumber: 6n },
						{ checkpointSequenceNumber: 7n },
					],
					subscriptionResponses: [],
					subscriptionShouldError: false,
					advanceClockBehavior: 'ok',
				});
				const collected = yield* pollCheckpoints(client, 1).pipe(Stream.take(3), Stream.runCollect);
				expect(collected.map((e) => e.cursor)).toEqual([5, 6, 7]);
				for (const e of collected) {
					expect(e.source).toBe('poll');
				}
			}),
		);
	});
});
