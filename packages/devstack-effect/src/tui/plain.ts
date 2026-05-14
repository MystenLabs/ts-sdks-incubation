// Plain line-oriented renderer for the devstack.
//
// One structured line per status transition + endpoint registration,
// written to stderr so stdout stays clean for piping JSON / log
// harvesters.
//
// Polls the same `TuiState` source as the TUI on a fixed cadence and
// diffs against the previous snapshot. Tag status changes, new endpoints,
// and new log entries each emit one line. We poll instead of subscribing
// to a `SubscriptionRef` because the engine's state is exposed as a plain
// `Ref` — polling on the same 500ms cadence as the TUI is plenty fast for
// a developer-loop renderer and keeps the engine surface tiny.
//
// stderr writes go through Effect's `Stdio` service so tests can swap in
// a fake sink via `Stdio.layerTest({ stderr: ... })`.

import { Effect, Schedule, Stdio, Stream } from 'effect';
import type { TagStatus, TuiEntry, TuiLog, TuiState } from './render.js';

const REFRESH = Schedule.spaced('500 millis');

const formatTime = (ts: number): string => {
	const d = new Date(ts);
	const hh = String(d.getHours()).padStart(2, '0');
	const mm = String(d.getMinutes()).padStart(2, '0');
	const ss = String(d.getSeconds()).padStart(2, '0');
	return `${hh}:${mm}:${ss}`;
};

const pad = (s: string, width: number): string => {
	if (s.length >= width) return s;
	return s + ' '.repeat(width - s.length);
};

// Render status as 'done' for completed actions, 'ready' for healthy
// services — same convention as the TUI dashboard so log scrapers and
// the live screen stay in sync.
const statusWord = (entry: TuiEntry, status: TagStatus): string => {
	if (status === 'ready' && entry.kind === 'action') return 'done';
	return status;
};

const formatEntryLine = (
	now: number,
	key: string,
	before: TagStatus | 'init',
	after: TagStatus,
	entry: TuiEntry,
): string => {
	const tail =
		after === 'acquiring' && entry.phase !== undefined
			? `${statusWord(entry, after)}(${entry.phase})`
			: statusWord(entry, after);
	// Prefer the multi-endpoint payload when present (e.g. `sui.localnet`'s
	// rpc/faucet/graphql triple) so the plain renderer surfaces every URL
	// instead of just `primary`. Falls through to `primary` for the simple
	// single-endpoint case.
	let detail = '';
	if (entry.endpoints !== undefined && entry.endpoints.length > 0) {
		const joined = entry.endpoints.map((ep) => `${ep.label}=${ep.url}`).join(' ');
		detail = ` (${joined})`;
	} else if (entry.primary !== undefined && entry.primary.length > 0) {
		detail = ` (${entry.primary})`;
	}
	const base = `[${formatTime(now)}] ${pad(key, 28)} ${before} → ${tail}${detail}`;
	if (after === 'failed' && entry.error !== undefined) return `${base}: ${entry.error}`;
	return base;
};

const formatLogLine = (entry: TuiLog): string => {
	return `[${formatTime(entry.ts)}] ${entry.level.toUpperCase()} ${entry.message}`;
};

interface DiffResult {
	readonly lines: ReadonlyArray<string>;
}

const indexByKey = (xs: ReadonlyArray<TuiEntry>): ReadonlyMap<string, TuiEntry> => {
	const out = new Map<string, TuiEntry>();
	for (const x of xs) out.set(x.key, x);
	return out;
};

const diffState = (prev: TuiState | undefined, next: TuiState, now: number): DiffResult => {
	const lines: Array<string> = [];

	const prevEntries = indexByKey(prev?.entries ?? []);
	for (const entry of next.entries) {
		const before = prevEntries.get(entry.key);
		if (before === undefined) {
			// First sighting — only emit if it's already past pending,
			// otherwise wait for the actual transition.
			if (entry.status !== 'pending') {
				lines.push(formatEntryLine(now, entry.key, 'init', entry.status, entry));
			}
			continue;
		}
		// Emit on status change OR (within 'acquiring') on phase change so
		// long-running primitives can surface sub-phase progress.
		if (before.status !== entry.status || before.phase !== entry.phase) {
			lines.push(formatEntryLine(now, entry.key, before.status, entry.status, entry));
		}
	}

	// Logs are append-only; emit any new entries past the previous length.
	const prevLogLen = prev?.logs.length ?? 0;
	if (next.logs.length > prevLogLen) {
		for (let i = prevLogLen; i < next.logs.length; i++) {
			const entry = next.logs[i];
			if (entry !== undefined) lines.push(formatLogLine(entry));
		}
	}

	return { lines };
};

/**
 * Start the plain-text render loop in the background.
 *
 * @param source - Effect that produces the latest `TuiState` snapshot.
 *   Must be infallible — render errors should not tear down the
 *   surrounding devstack.
 */
export const startPlainRenderer = Effect.fn('PlainRenderer.start')(function* (
	source: Effect.Effect<TuiState, never, never>,
) {
	const stdio = yield* Stdio.Stdio;

	// Track the previous snapshot across ticks. A plain mutable closure is
	// fine here — the tick effect runs on a single forked fiber, no
	// concurrent readers.
	let previous: TuiState | undefined;

	const tick = source.pipe(
		Effect.flatMap((state) => {
			const { lines } = diffState(previous, state, Date.now());
			previous = state;
			if (lines.length === 0) return Effect.void;
			// Concatenated single-frame write — one Sink invocation per tick
			// instead of one per line. Failures (e.g. EPIPE on a closed pipe)
			// are swallowed so a downstream consumer dropping us doesn't tear
			// down the whole devstack.
			const text = `${lines.join('\n')}\n`;
			return Stream.make(text).pipe(Stream.run(stdio.stderr()), Effect.ignore);
		}),
	);

	yield* Effect.forkScoped(tick.pipe(Effect.repeat(REFRESH)));
});
