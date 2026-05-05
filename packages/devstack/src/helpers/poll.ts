// Generic poll-until-ready helper. Wraps a probe function with
// automatic status-context logging so plugin authors don't have to
// hand-roll `appendLog` calls around long-running waits.
//
// Pattern:
//
//   await pollUntilReady(ctx, {
//     label: 'GraphQL',
//     probe: () => probeGraphql(url),
//     timeoutMs: 120_000,
//   });
//
// Emits, via `ctx.appendLog`:
//   - `waiting for GraphQL …` at start
//   - `still waiting for GraphQL (12.4s, last: connection refused)`
//     every `progressIntervalMs` while the probe stays not-ok
//   - `GraphQL ready (28.2s)` on success
//   - throws `<label> not ready after <duration>: <last detail>` on
//     timeout
//
// The supervisor's renderer streams `appendLog` lines into the action's
// log feed, so users watching the TUI see exactly what's blocking each
// long-running action. One-shot paths (`devstack apply`, smoke tests)
// pass an empty `ctx` and only see the throw.

import { formatMs } from '../runtime/renderers/plain.js';

export interface PollUntilReadyOptions {
	/** Human-readable name shown in log lines. */
	label: string;
	/** Returns `ok: true` once the resource is ready. `detail` (when
	 * present) is included in the periodic "still waiting" log line so
	 * users see WHY the probe is still not ok (e.g.
	 * `connection refused`, `HTTP 503`). */
	probe: () => Promise<{ ok: boolean; detail?: string }>;
	/** Hard ceiling. Default 60_000 (1 min). */
	timeoutMs?: number;
	/** Wait between probe attempts. Default 500. */
	intervalMs?: number;
	/** Emit a `still waiting…` log line every N ms while the probe
	 * stays not-ok. Default 5_000. Set to 0 to suppress periodic
	 * progress (only emit start + done). */
	progressIntervalMs?: number;
}

export async function pollUntilReady(
	ctx: { appendLog?: (line: string) => void },
	opts: PollUntilReadyOptions,
): Promise<void> {
	const timeoutMs = opts.timeoutMs ?? 60_000;
	const intervalMs = opts.intervalMs ?? 500;
	const progressIntervalMs = opts.progressIntervalMs ?? 5_000;
	const start = Date.now();
	const deadline = start + timeoutMs;
	let lastProgressAt = start;
	let lastDetail = '';
	ctx.appendLog?.(`waiting for ${opts.label}…`);
	while (Date.now() < deadline) {
		const result = await opts.probe();
		if (result.ok) {
			ctx.appendLog?.(`${opts.label} ready (${formatMs(Date.now() - start)})`);
			return;
		}
		lastDetail = result.detail ?? 'unknown';
		const now = Date.now();
		if (progressIntervalMs > 0 && now - lastProgressAt >= progressIntervalMs) {
			ctx.appendLog?.(
				`still waiting for ${opts.label} (${formatMs(now - start)}, last: ${lastDetail})`,
			);
			lastProgressAt = now;
		}
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	throw new Error(
		`${opts.label} not ready after ${formatMs(timeoutMs)}: ${lastDetail || 'no probe completed'}`,
	);
}
