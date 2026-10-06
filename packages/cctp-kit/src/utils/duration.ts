// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Format a wait-time range for people: "~8 seconds", "15 to 19 minutes", "6 to 32 hours".
 * Both bounds are rendered in the unit that fits the larger one.
 */
export function formatDuration(minSeconds: number, maxSeconds: number): string {
	const [unit, divisor] =
		maxSeconds >= 2 * 3600 ? ['hour', 3600] : maxSeconds >= 60 ? ['minute', 60] : ['second', 1];
	const lo = Math.max(1, Math.round(minSeconds / divisor));
	const hi = Math.max(lo, Math.round(maxSeconds / divisor));
	const plural = (n: number) => `${unit}${n === 1 ? '' : 's'}`;
	if (lo === hi) return `~${lo} ${plural(lo)}`;
	// Collapse tight ranges to a single approximate value.
	if (hi - lo <= Math.max(2, lo * 0.25)) return `~${Math.round((lo + hi) / 2)} ${plural(hi)}`;
	return `${lo} to ${hi} ${plural(hi)}`;
}

/** "4:12" or "1:02:08" for an elapsed number of seconds. */
export function formatElapsed(seconds: number): string {
	const s = Math.max(0, Math.floor(seconds));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	const mm = h ? String(m).padStart(2, '0') : String(m);
	return `${h ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
}

export interface WaitProgress {
	elapsedSeconds: number;
	/** 0..1 against the upper bound of the estimate. */
	fraction: number;
	/** Remaining range text, or null once the upper bound has passed. */
	remaining: string | null;
	overdue: boolean;
}

/** Progress of a wait against an estimated [min, max] range. */
export function waitProgress(
	startedAt: number,
	minSeconds: number,
	maxSeconds: number,
	now = Date.now(),
): WaitProgress {
	const elapsedSeconds = Math.max(0, (now - startedAt) / 1000);
	const fraction = Math.min(1, elapsedSeconds / Math.max(1, maxSeconds));
	const overdue = elapsedSeconds > maxSeconds;
	const lo = Math.max(0, minSeconds - elapsedSeconds);
	const hi = Math.max(0, maxSeconds - elapsedSeconds);
	const remaining = overdue
		? null
		: lo > 0
			? formatDuration(lo, hi)
			: `up to ${formatDuration(hi, hi).replace(/^~/, '')}`;
	return { elapsedSeconds, fraction, remaining, overdue };
}
