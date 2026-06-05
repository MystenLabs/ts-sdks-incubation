// Sui local-mode caught-up-to-head cadence evaluator.
//
// The catch-up gate (`waitForCheckpointCatchUp`) polls
// the gRPC service-info checkpoint height and declares the validator
// caught up once the per-poll delta drops from fast-replay cadence
// (hundreds/poll) to live cadence (a handful/poll) and HOLDS there.
// This exercises the pure cadence evaluator that decision rests on, on
// both cold-boot and warm/restore shapes, without a live validator.

import { describe, expect, it } from '@effect/vitest';

import { makeCatchUpEvaluator } from '../../../src/plugins/sui/mode/local.ts';

describe('makeCatchUpEvaluator', () => {
	it('never declares caught-up on the first sample (baseline only)', () => {
		const e = makeCatchUpEvaluator();
		// First numeric sample establishes the baseline; delta is +Inf, so
		// it can never count toward the live-cadence streak.
		expect(e.step(0).caughtUp).toBe(false);
	});

	it('cold/genesis boot catches up almost immediately (tiny stable head)', () => {
		const e = makeCatchUpEvaluator();
		// Genesis: head barely moves. Baseline, then one more live-cadence
		// sample, then the second consecutive one trips the gate.
		expect(e.step(2).caughtUp).toBe(false); // baseline
		expect(e.step(4).caughtUp).toBe(false); // delta 2 → stable=1
		expect(e.step(6).caughtUp).toBe(true); // delta 2 → stable=2 → caught up
	});

	it('warm/restore boot waits out fast replay then catches up at live cadence', () => {
		const e = makeCatchUpEvaluator();
		// Fast replay: hundreds of checkpoints per poll. Never caught up
		// while the delta stays large.
		expect(e.step(0).caughtUp).toBe(false); // baseline
		expect(e.step(400).caughtUp).toBe(false); // delta 400 (replay)
		expect(e.step(850).caughtUp).toBe(false); // delta 450 (replay)
		expect(e.step(1300).caughtUp).toBe(false); // delta 450 (replay)
		// Replay reaches head; cadence collapses to live rate.
		expect(e.step(1303).caughtUp).toBe(false); // delta 3 → stable=1
		expect(e.step(1306).caughtUp).toBe(true); // delta 3 → stable=2 → caught up
	});

	it('a single live-cadence dip mid-replay does NOT declare caught-up', () => {
		const e = makeCatchUpEvaluator();
		expect(e.step(0).caughtUp).toBe(false); // baseline
		expect(e.step(500).caughtUp).toBe(false); // delta 500 (replay)
		// A brief replay stall (e.g. GC pause) shows ONE small delta...
		expect(e.step(505).caughtUp).toBe(false); // delta 5 → stable=1
		// ...then replay resumes with a large delta, resetting the streak.
		expect(e.step(900).caughtUp).toBe(false); // delta 395 → stable reset to 0
		// So it cannot string two live-cadence polls together until replay
		// genuinely reaches head.
		expect(e.step(903).caughtUp).toBe(false); // delta 3 → stable=1
		expect(e.step(906).caughtUp).toBe(true); // delta 3 → stable=2 → caught up
	});

	it('a negative delta (checkpoint regression) does NOT count as live cadence', () => {
		const e = makeCatchUpEvaluator();
		expect(e.step(100).caughtUp).toBe(false); // baseline
		expect(e.step(102).caughtUp).toBe(false); // delta 2 → stable=1
		// Head regresses (mid-re-sync / reset): delta is negative. Even though
		// -2 <= liveCadenceDelta, a regression must NOT advance the streak — it
		// resets it, so the gate keeps waiting for forward progress.
		const regressed = e.step(100);
		expect(regressed.caughtUp).toBe(false);
		expect((regressed as { detail: { regressed?: boolean } }).detail.regressed).toBe(true);
		// After the reset it takes two fresh forward live-cadence polls again.
		expect(e.step(102).caughtUp).toBe(false); // delta 2 → stable=1
		expect(e.step(104).caughtUp).toBe(true); // delta 2 → stable=2 → caught up
	});

	it('a regression on the verge of caught-up withholds the verdict', () => {
		// Without the guard, a -1 delta arriving when stable=stablePollsRequired-1
		// would tip the gate to caught-up off a backwards head. The guard resets.
		const e = makeCatchUpEvaluator({ liveCadenceDelta: 5, stablePollsRequired: 2 });
		expect(e.step(50).caughtUp).toBe(false); // baseline
		expect(e.step(52).caughtUp).toBe(false); // delta 2 → stable=1
		expect(e.step(51).caughtUp).toBe(false); // delta -1 → REGRESSED → stable=0
	});

	it('an unparseable sample resets the stability streak', () => {
		const e = makeCatchUpEvaluator();
		expect(e.step(10).caughtUp).toBe(false); // baseline
		expect(e.step(12).caughtUp).toBe(false); // delta 2 → stable=1
		// Listener answered but the result was unparseable — streak resets.
		expect(e.step(undefined).caughtUp).toBe(false); // stable reset to 0
		// The next numeric sample re-establishes a delta against the last
		// numeric reading (12), so a live delta only gets us to stable=1.
		expect(e.step(14).caughtUp).toBe(false); // delta 2 → stable=1
		expect(e.step(16).caughtUp).toBe(true); // delta 2 → stable=2 → caught up
	});

	it('honours custom thresholds', () => {
		// One stable live-cadence poll is enough; live cadence is <= 1.
		const e = makeCatchUpEvaluator({ liveCadenceDelta: 1, stablePollsRequired: 1 });
		expect(e.step(0).caughtUp).toBe(false); // baseline (delta +Inf)
		expect(e.step(5).caughtUp).toBe(false); // delta 5 > 1 → not live
		expect(e.step(6).caughtUp).toBe(true); // delta 1 <= 1 → stable=1 → caught up
	});

	it('tracks the last numeric sample for diagnostics', () => {
		const e = makeCatchUpEvaluator();
		expect(e.last()).toBeUndefined();
		e.step(7);
		expect(e.last()).toBe(7);
		e.step(undefined);
		// undefined does not advance the baseline.
		expect(e.last()).toBe(7);
		e.step(9);
		expect(e.last()).toBe(9);
	});
});
