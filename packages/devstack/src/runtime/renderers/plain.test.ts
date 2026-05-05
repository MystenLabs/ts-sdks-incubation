import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import type { Action, ActionStatus } from '../../core/types.js';
import { PlainRenderer, formatMs } from './plain.js';

class StringStream extends Writable {
	chunks: string[] = [];
	isTTY = false;
	override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
		this.chunks.push(chunk.toString());
		cb();
	}
	get text(): string {
		return this.chunks.join('');
	}
}

function makeAction(name: string, plugin = 'sui'): Action {
	return { name, type: 'Service', plugin } as Action;
}

function makeRenderer(actions: Action[]): { r: PlainRenderer; out: StringStream } {
	const out = new StringStream() as unknown as StringStream & NodeJS.WriteStream;
	const r = new PlainRenderer({ stream: out as unknown as NodeJS.WriteStream, color: false });
	r.start({ appName: 'demo', stack: 'main', network: 'localnet', actions });
	return { r, out: out as unknown as StringStream };
}

describe('PlainRenderer', () => {
	it('prints a header on start', () => {
		const { out } = makeRenderer([makeAction('sui.localnet')]);
		expect(out.text).toContain('devstack up');
		expect(out.text).toContain('demo · main · localnet');
		expect(out.text).toContain('1 action');
	});

	it('emits one row per status transition only', () => {
		const { r, out } = makeRenderer([makeAction('sui.localnet')]);
		const baseline = out.text;
		const upd = (s: ActionStatus): Map<string, ActionStatus> => new Map([['sui.localnet', s]]);

		r.update(upd('running'), new Map());
		r.update(upd('running'), new Map()); // no-op, no second line
		r.update(upd('healthy'), new Map());

		const after = out.text.slice(baseline.length);
		const rows = after.split('\n').filter((l) => /sui\.localnet/.test(l));
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatch(/⟳.*running.*\+\d+ms/);
		expect(rows[1]).toMatch(/✓.*healthy.*\d+ms/);
	});

	it('suppresses backward transitions (healthy → queued/running)', () => {
		const { r, out } = makeRenderer([makeAction('sui.localnet')]);
		const upd = (s: ActionStatus): Map<string, ActionStatus> => new Map([['sui.localnet', s]]);
		r.update(upd('running'), new Map());
		r.update(upd('healthy'), new Map());
		const baseline = out.text;
		// Cycle 2 re-entry: reconciler walks the topo with a fresh status
		// map (queued → running → healthy). PlainRenderer should swallow
		// the queued/running flips because we already settled.
		r.update(upd('queued'), new Map());
		r.update(upd('running'), new Map());
		r.update(upd('healthy'), new Map());
		const after = out.text.slice(baseline.length);
		expect(after).not.toMatch(/queued/);
		expect(after).not.toMatch(/running/);
		// But the second `healthy` (a transition from prev=running, since
		// our internal state did follow through) is suppressed by the
		// dedup guard at the top — no row at all.
		expect(after).toBe('');
	});

	it('still emits a settle even after a re-cycle (failed retry)', () => {
		const { r, out } = makeRenderer([makeAction('sui.localnet')]);
		const upd = (s: ActionStatus): Map<string, ActionStatus> => new Map([['sui.localnet', s]]);
		r.update(upd('running'), new Map());
		r.update(upd('failed'), new Map([['sui.localnet', new Error('boom')]]));
		const baseline = out.text;
		// User retries → reconciler re-runs from cold, settles healthy.
		// We want the healthy line, not the queued/running noise.
		r.update(upd('queued'), new Map());
		r.update(upd('running'), new Map());
		r.update(upd('healthy'), new Map());
		const after = out.text.slice(baseline.length);
		expect(after).toMatch(/healthy/);
		expect(after).not.toMatch(/queued/);
		expect(after).not.toMatch(/running/);
	});

	it('marks stale via markStale and skips when already stale', () => {
		const { r, out } = makeRenderer([makeAction('sui.localnet')]);
		const baseline = out.text;
		r.update(new Map([['sui.localnet', 'healthy']]), new Map());
		r.markStale(['sui.localnet']);
		r.markStale(['sui.localnet']); // dedup — no second `stale` line
		const after = out.text.slice(baseline.length);
		expect(after.match(/stale/g)?.length ?? 0).toBe(1);
	});

	it('renders the full shutdown lifecycle', () => {
		const { r, out } = makeRenderer([makeAction('sui.localnet')]);
		const baseline = out.text;
		r.beginShutdown([{ label: 'sui.localnet' }, { label: 'walrus.aggregator' }]);
		r.progressShutdown('sui.localnet', 'running');
		r.progressShutdown('sui.localnet', 'done');
		r.progressShutdown('walrus.aggregator', 'running');
		r.progressShutdown('walrus.aggregator', 'failed', 'sigkilled');
		r.finishShutdown({ completed: 1, failed: 1, durationMs: 1500 });
		const after = out.text.slice(baseline.length);
		expect(after).toContain('shutdown');
		expect(after).toContain('(2 hooks)');
		expect(after).toMatch(/→ sui\.localnet.*stopping/);
		expect(after).toMatch(/✓ sui\.localnet/);
		expect(after).toMatch(/✗ walrus\.aggregator.*sigkilled/);
		expect(after).toContain('shutdown complete (with errors)');
		expect(after).toContain('1/2 ok');
		expect(after).toContain('1 failed');
	});

	it('prefixes log lines with timestamp + action name', () => {
		const { r, out } = makeRenderer([makeAction('sui.localnet')]);
		const baseline = out.text;
		r.appendLog('sui.localnet', 'rpc ready on :9000');
		const line = out.text.slice(baseline.length);
		expect(line).toMatch(/^\[\d\d:\d\d:\d\d\] sui\.localnet rpc ready on :9000\n$/);
	});

	it('honors `color: false` (no ANSI escapes)', () => {
		const { r, out } = makeRenderer([makeAction('sui.localnet')]);
		r.update(new Map([['sui.localnet', 'failed']]), new Map([['sui.localnet', new Error('boom')]]));
		expect(out.text).not.toMatch(/\x1b\[/);
		expect(out.text).toContain('— boom');
	});
});

describe('formatMs', () => {
	it('formats sub-second as ms', () => {
		expect(formatMs(0)).toBe('0ms');
		expect(formatMs(999)).toBe('999ms');
	});
	it('formats sub-minute as decimal seconds', () => {
		expect(formatMs(1_200)).toBe('1.2s');
		expect(formatMs(59_900)).toBe('59.9s');
	});
	it('formats over-minute as Mm0Ss', () => {
		expect(formatMs(60_000)).toBe('1m00s');
		expect(formatMs(125_000)).toBe('2m05s');
	});
});
