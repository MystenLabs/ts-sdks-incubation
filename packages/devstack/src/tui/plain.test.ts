// Coverage for the plain renderer's heartbeat pass — the universal
// "still acquiring [Ns]" line that fires every 15s while a tag is stuck
// in `acquiring`. The motivating failure was a `docker pull
// mysten/sui-tools:...` that ran 5 minutes silent because the wrapping
// primitive emitted no `setPhase` updates; the heartbeat is the
// per-primitive-blind floor that says "I'm alive" regardless.
//
// Design constraints (matching `notes/long-acquire-progress.md` §3.1):
//
//   - First sighting in `acquiring` anchors the clock; NO line at t=0.
//   - First heartbeat fires at t = startedAt + HEARTBEAT_INTERVAL_MS.
//   - Schedule bumps by exactly +HEARTBEAT_INTERVAL_MS per emit so a
//     late tick catches up by exactly one line, not many.
//   - Transitioning OUT of `acquiring` clears bookkeeping (re-acquires
//     start a fresh clock).
//   - If the diff pass already emitted a line for this key this tick
//     (status or phase transition), suppress the heartbeat to avoid
//     double-emission.
//
// These tests target `computeHeartbeats` directly — a pure-modulo-Map
// helper — instead of standing up the full renderer fiber. Same
// determinism, ~zero setup cost.

import { describe, expect, it } from 'vitest';
import {
	HEARTBEAT_INTERVAL_MS,
	computeHeartbeats,
	type HeartbeatState,
} from './plain.js';
import type { TagStatus, TuiEntry, TuiState } from '../engine/tui-state.js';

// Fixed base time so every assertion can read its expected `[hh:mm:ss]`
// directly. 2026-01-01 00:00:00 UTC chosen to land on a clean wall-clock
// boundary regardless of the runner's timezone — the renderer uses
// `Date#getHours()` etc. (local time), so we compute the expected
// timestamp from the same fixed `Date` instance the production code
// would.
const BASE = new Date('2026-01-01T00:00:00').getTime();

const fmtTime = (ts: number): string => {
	const d = new Date(ts);
	const hh = String(d.getHours()).padStart(2, '0');
	const mm = String(d.getMinutes()).padStart(2, '0');
	const ss = String(d.getSeconds()).padStart(2, '0');
	return `${hh}:${mm}:${ss}`;
};

const pad28 = (s: string): string => (s.length >= 28 ? s : s + ' '.repeat(28 - s.length));

const expectedLine = (key: string, now: number, seconds: number, phase?: string): string =>
	`[${fmtTime(now)}] ${pad28(key)} [${seconds}s] still acquiring${phase !== undefined ? ` (phase=${phase})` : ''}`;

const entry = (key: string, status: TagStatus, phase?: string): TuiEntry => ({
	key,
	kind: 'service',
	status,
	...(phase !== undefined ? { phase } : {}),
});

// Minimal TuiState wrapper around an entry list. The heartbeat pass only
// reads `entries`; everything else is required-by-type but ignored.
const stateOf = (entries: ReadonlyArray<TuiEntry>): TuiState => ({
	entries,
	endpoints: [],
	logs: [],
	header: { app: 'test', stack: 'main', network: 'localnet', buildStatus: 'running', cycle: 1 },
});

const NO_SUPPRESS: ReadonlySet<string> = new Set();

describe('computeHeartbeats', () => {
	it('does NOT emit on first sighting in acquiring (t=0)', () => {
		const state: HeartbeatState = new Map();
		const next = stateOf([entry('svc.a', 'acquiring')]);

		const { lines } = computeHeartbeats(state, next, BASE, NO_SUPPRESS);

		expect(lines).toEqual([]);
		// Bookkeeping must record startedAt = BASE and schedule the first
		// emit one interval later.
		const hb = state.get('svc.a');
		expect(hb).toBeDefined();
		expect(hb?.startedAt).toBe(BASE);
		expect(hb?.nextEmitAt).toBe(BASE + HEARTBEAT_INTERVAL_MS);
	});

	it('emits exactly one heartbeat at t = startedAt + 15s', () => {
		const state: HeartbeatState = new Map();
		const next = stateOf([entry('svc.a', 'acquiring')]);

		// Anchor.
		computeHeartbeats(state, next, BASE, NO_SUPPRESS);

		// One interval later — the first heartbeat fires.
		const now = BASE + HEARTBEAT_INTERVAL_MS;
		const { lines } = computeHeartbeats(state, next, now, NO_SUPPRESS);

		expect(lines).toHaveLength(1);
		expect(lines[0]).toBe(expectedLine('svc.a', now, 15));
		// Schedule should have bumped by exactly one interval.
		expect(state.get('svc.a')?.nextEmitAt).toBe(BASE + 2 * HEARTBEAT_INTERVAL_MS);
	});

	it('emits two heartbeats total across 30s — one per interval', () => {
		const state: HeartbeatState = new Map();
		const next = stateOf([entry('svc.a', 'acquiring')]);

		computeHeartbeats(state, next, BASE, NO_SUPPRESS); // anchor
		const r1 = computeHeartbeats(state, next, BASE + HEARTBEAT_INTERVAL_MS, NO_SUPPRESS);
		const r2 = computeHeartbeats(state, next, BASE + 2 * HEARTBEAT_INTERVAL_MS, NO_SUPPRESS);

		expect(r1.lines).toHaveLength(1);
		expect(r2.lines).toHaveLength(1);
		expect(r2.lines[0]).toBe(expectedLine('svc.a', BASE + 2 * HEARTBEAT_INTERVAL_MS, 30));
	});

	it('does NOT emit on intermediate ticks before the next interval', () => {
		const state: HeartbeatState = new Map();
		const next = stateOf([entry('svc.a', 'acquiring')]);

		computeHeartbeats(state, next, BASE, NO_SUPPRESS);
		// 500ms tick — far short of the 15s interval.
		const { lines } = computeHeartbeats(state, next, BASE + 500, NO_SUPPRESS);

		expect(lines).toEqual([]);
	});

	it('a phase change at t=10s does NOT reset the 15s clock', () => {
		const state: HeartbeatState = new Map();

		// t=0: anchor without phase.
		computeHeartbeats(state, stateOf([entry('svc.a', 'acquiring')]), BASE, NO_SUPPRESS);

		// t=10s: phase changes. The diff pass would emit a transition line
		// AND list 'svc.a' in `suppressed`, but the heartbeat pass still
		// uses the original startedAt — only the displayed phase updates.
		// The suppression flag means no heartbeat fires this tick
		// regardless.
		computeHeartbeats(
			state,
			stateOf([entry('svc.a', 'acquiring', 'pulling layer 1/3')]),
			BASE + 10_000,
			new Set(['svc.a']),
		);

		// t=15s: heartbeat should fire (clock NOT reset by phase change).
		const now = BASE + 15_000;
		const { lines } = computeHeartbeats(
			state,
			stateOf([entry('svc.a', 'acquiring', 'pulling layer 1/3')]),
			now,
			NO_SUPPRESS,
		);

		expect(lines).toHaveLength(1);
		// Seconds is computed from startedAt (BASE), confirming clock not
		// reset.
		expect(lines[0]).toBe(expectedLine('svc.a', now, 15, 'pulling layer 1/3'));
	});

	it('transition out of acquiring clears state — no further heartbeats', () => {
		const state: HeartbeatState = new Map();

		// Anchor.
		computeHeartbeats(state, stateOf([entry('svc.a', 'acquiring')]), BASE, NO_SUPPRESS);
		expect(state.has('svc.a')).toBe(true);

		// Transition to ready — even with the heartbeat pass running.
		// `liveKeys` no longer includes 'svc.a' so its bookkeeping is
		// dropped.
		const { lines: readyTick } = computeHeartbeats(
			state,
			stateOf([entry('svc.a', 'ready')]),
			BASE + HEARTBEAT_INTERVAL_MS,
			new Set(['svc.a']), // diff emitted the acquiring → ready line
		);

		expect(readyTick).toEqual([]);
		expect(state.has('svc.a')).toBe(false);

		// Far later tick with the tag still ready — no heartbeat ever.
		const { lines } = computeHeartbeats(
			state,
			stateOf([entry('svc.a', 'ready')]),
			BASE + 10 * HEARTBEAT_INTERVAL_MS,
			NO_SUPPRESS,
		);
		expect(lines).toEqual([]);
	});

	it('heartbeat without phase reads "still acquiring [Ns]"', () => {
		const state: HeartbeatState = new Map();
		const next = stateOf([entry('svc.a', 'acquiring')]);

		computeHeartbeats(state, next, BASE, NO_SUPPRESS);
		const { lines } = computeHeartbeats(
			state,
			next,
			BASE + HEARTBEAT_INTERVAL_MS,
			NO_SUPPRESS,
		);

		expect(lines[0]).toMatch(/ still acquiring$/);
		expect(lines[0]).not.toContain('phase=');
	});

	it('heartbeat with phase reads "still acquiring (phase=<phase>)"', () => {
		const state: HeartbeatState = new Map();

		computeHeartbeats(
			state,
			stateOf([entry('svc.a', 'acquiring', 'pulling mysten/sui-tools:1.45')]),
			BASE,
			NO_SUPPRESS,
		);
		const now = BASE + HEARTBEAT_INTERVAL_MS;
		const { lines } = computeHeartbeats(
			state,
			stateOf([entry('svc.a', 'acquiring', 'pulling mysten/sui-tools:1.45')]),
			now,
			NO_SUPPRESS,
		);

		expect(lines[0]).toBe(expectedLine('svc.a', now, 15, 'pulling mysten/sui-tools:1.45'));
	});

	it('next heartbeat reflects the LATEST phase even if it changed mid-window', () => {
		const state: HeartbeatState = new Map();

		// t=0: anchor with phase A.
		computeHeartbeats(
			state,
			stateOf([entry('svc.a', 'acquiring', 'phase-a')]),
			BASE,
			NO_SUPPRESS,
		);
		// t=5s: phase changes to B (diff pass emits a line + suppresses).
		computeHeartbeats(
			state,
			stateOf([entry('svc.a', 'acquiring', 'phase-b')]),
			BASE + 5_000,
			new Set(['svc.a']),
		);
		// t=15s: heartbeat fires with phase B, not phase A.
		const now = BASE + HEARTBEAT_INTERVAL_MS;
		const { lines } = computeHeartbeats(
			state,
			stateOf([entry('svc.a', 'acquiring', 'phase-b')]),
			now,
			NO_SUPPRESS,
		);

		expect(lines[0]).toBe(expectedLine('svc.a', now, 15, 'phase-b'));
	});

	it('multiple concurrent acquires get independent schedules', () => {
		const state: HeartbeatState = new Map();

		// t=0: svc.a starts acquiring.
		computeHeartbeats(state, stateOf([entry('svc.a', 'acquiring')]), BASE, NO_SUPPRESS);
		// t=5s: svc.b joins (also acquiring).
		computeHeartbeats(
			state,
			stateOf([entry('svc.a', 'acquiring'), entry('svc.b', 'acquiring')]),
			BASE + 5_000,
			new Set(['svc.b']), // diff: init → acquiring for svc.b
		);

		// t=15s: only svc.a fires (it anchored at t=0).
		const t15 = BASE + 15_000;
		const r15 = computeHeartbeats(
			state,
			stateOf([entry('svc.a', 'acquiring'), entry('svc.b', 'acquiring')]),
			t15,
			NO_SUPPRESS,
		);
		expect(r15.lines).toHaveLength(1);
		expect(r15.lines[0]).toBe(expectedLine('svc.a', t15, 15));

		// t=20s: only svc.b fires (anchored at t=5s, +15s = t=20s).
		const t20 = BASE + 20_000;
		const r20 = computeHeartbeats(
			state,
			stateOf([entry('svc.a', 'acquiring'), entry('svc.b', 'acquiring')]),
			t20,
			NO_SUPPRESS,
		);
		expect(r20.lines).toHaveLength(1);
		expect(r20.lines[0]).toBe(expectedLine('svc.b', t20, 15));
	});

	it('suppression: heartbeat skipped on the same tick as a transition', () => {
		const state: HeartbeatState = new Map();
		const next = stateOf([entry('svc.a', 'acquiring')]);

		computeHeartbeats(state, next, BASE, NO_SUPPRESS); // anchor

		// At the heartbeat instant the diff pass ALSO emits (say, a phase
		// change). Suppression keeps the heartbeat quiet so the operator
		// sees one line, not two, for the same tick.
		const { lines } = computeHeartbeats(
			state,
			stateOf([entry('svc.a', 'acquiring', 'phase-b')]),
			BASE + HEARTBEAT_INTERVAL_MS,
			new Set(['svc.a']),
		);

		expect(lines).toEqual([]);
		// And the schedule should NOT have bumped — suppressed ticks
		// don't count as "emitted", so the next heartbeat still fires at
		// the original scheduled time.
		expect(state.get('svc.a')?.nextEmitAt).toBe(BASE + HEARTBEAT_INTERVAL_MS);
	});

	it('a 90s-late tick emits exactly ONE catch-up heartbeat, not many', () => {
		const state: HeartbeatState = new Map();
		const next = stateOf([entry('svc.a', 'acquiring')]);

		computeHeartbeats(state, next, BASE, NO_SUPPRESS);

		// 90s passes with no ticks (event loop blocked, GC pause, etc.).
		// On the next tick we'd "owe" 6 heartbeats by raw schedule math;
		// the design says emit exactly one and bump the schedule by
		// exactly one interval so the operator doesn't get a wall of
		// stale lines all at once.
		const now = BASE + 90_000;
		const { lines } = computeHeartbeats(state, next, now, NO_SUPPRESS);

		expect(lines).toHaveLength(1);
		expect(lines[0]).toBe(expectedLine('svc.a', now, 90));
		// Schedule bumped by exactly one interval, not 6.
		expect(state.get('svc.a')?.nextEmitAt).toBe(BASE + 2 * HEARTBEAT_INTERVAL_MS);
	});

	it('drops bookkeeping when an entry disappears from the snapshot entirely', () => {
		const state: HeartbeatState = new Map();
		computeHeartbeats(state, stateOf([entry('svc.a', 'acquiring')]), BASE, NO_SUPPRESS);
		expect(state.has('svc.a')).toBe(true);

		// Next snapshot omits svc.a (e.g. the stack was reconfigured).
		computeHeartbeats(state, stateOf([]), BASE + 1_000, NO_SUPPRESS);
		expect(state.has('svc.a')).toBe(false);
	});

	it('transitioning failed clears state just like ready does', () => {
		const state: HeartbeatState = new Map();
		computeHeartbeats(state, stateOf([entry('svc.a', 'acquiring')]), BASE, NO_SUPPRESS);

		computeHeartbeats(
			state,
			stateOf([entry('svc.a', 'failed')]),
			BASE + 1_000,
			new Set(['svc.a']),
		);
		expect(state.has('svc.a')).toBe(false);
	});
});
