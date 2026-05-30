// Core data hook. Subscribes to live `state` frames over SSE; if the stream
// fails or ends it falls back to polling `fetchState`. Either source feeds the
// same `ingest` reducer, which exposes the current `Projection`, a connection
// status, and a client-derived `activity` feed built by DIFFING successive
// projections (the backend has no dedicated event stream yet).

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchState, subscribeState } from './api.ts';
import type { Projection, Row, RowSection } from './types.ts';
import { labelForRow } from './derive.ts';

export type Connection = 'connecting' | 'live' | 'error';

export interface ActivityItem {
	readonly id: number;
	readonly at: number;
	readonly kind: 'status' | 'endpoint' | 'error' | 'phase' | 'cycle';
	readonly section: RowSection | 'other';
	readonly pluginKey: string | null;
	readonly text: string;
}

export interface UseProjection {
	readonly projection: Projection | null;
	readonly connection: Connection;
	readonly error: string | null;
	readonly updatedAt: number | null;
	readonly activity: ReadonlyArray<ActivityItem>;
	readonly refresh: () => Promise<void>;
}

const DEFAULT_POLL_MS = 1500;
const ACTIVITY_CAP = 200;

let nextActivityId = 1;

const errorKey = (e: { at: number; tag: string }): string => `${e.at}:${e.tag}`;

/**
 * Diff two projections into newest-first activity items. `now` is the poll time,
 * used as a fallback when a projection lacks its own timestamp.
 */
const diffProjections = (prev: Projection, next: Projection, now: number): ActivityItem[] => {
	const items: ActivityItem[] = [];
	const push = (
		kind: ActivityItem['kind'],
		text: string,
		section: ActivityItem['section'],
		pluginKey: string | null,
		at: number,
	) => {
		items.push({ id: nextActivityId++, at, kind, section, pluginKey, text });
	};

	// Status transitions, keyed by row key.
	const prevRows = new Map<string, Row>(prev.rows.map((r) => [r.key, r]));
	for (const row of next.rows) {
		const before = prevRows.get(row.key);
		if (before && before.status !== row.status) {
			push(
				'status',
				`${labelForRow(row.key)} ${before.status} → ${row.status}`,
				row.section,
				row.key,
				row.lastError?.at ?? now,
			);
		}
	}

	// Newly registered endpoints (present now, absent before).
	const prevEndpoints = new Set(prev.endpoints.map((e) => e.endpointKey));
	for (const ep of next.endpoints) {
		if (!prevEndpoints.has(ep.endpointKey)) {
			push(
				'endpoint',
				`${ep.name} ${ep.displayUrl ?? ep.url}`,
				'other',
				ep.pluginKey,
				ep.registeredAt || now,
			);
		}
	}

	// New errors (compare by at+tag).
	const prevErrors = new Set(prev.errors.map(errorKey));
	for (const err of next.errors) {
		if (!prevErrors.has(errorKey(err))) {
			push('error', err.summary, 'other', err.pluginKey, err.at || now);
		}
	}

	// Cycle id / phase transitions.
	if (next.cycle.id !== prev.cycle.id) {
		push(
			'cycle',
			`cycle ${next.cycle.id} ${next.cycle.phase}`,
			'other',
			null,
			next.cycle.startedAt || now,
		);
	} else if (next.cycle.phase !== prev.cycle.phase) {
		push('phase', `phase ${next.cycle.phase}`, 'other', null, now);
	}

	return items;
};

export const useProjection = (endpoint: string, opts?: { pollMs?: number }): UseProjection => {
	const pollMs = opts?.pollMs ?? DEFAULT_POLL_MS;

	const [projection, setProjection] = useState<Projection | null>(null);
	const [connection, setConnection] = useState<Connection>('connecting');
	const [error, setError] = useState<string | null>(null);
	const [updatedAt, setUpdatedAt] = useState<number | null>(null);
	const [activity, setActivity] = useState<ReadonlyArray<ActivityItem>>([]);

	// Diff baseline lives in a ref so polling doesn't re-create the effect.
	const baseline = useRef<Projection | null>(null);
	// Guard against setState after unmount / endpoint change.
	const alive = useRef(true);

	const ingest = useCallback((next: Projection, at: number) => {
		const prev = baseline.current;
		if (prev) {
			const newItems = diffProjections(prev, next, at);
			if (newItems.length > 0) {
				setActivity((cur) => [...newItems.reverse(), ...cur].slice(0, ACTIVITY_CAP));
			}
		}
		baseline.current = next;
		setProjection(next);
		setUpdatedAt(at);
		setConnection('live');
		setError(null);
	}, []);

	const load = useCallback(async () => {
		try {
			const next = await fetchState(endpoint);
			if (!alive.current) return;
			ingest(next, Date.now());
		} catch (err) {
			if (!alive.current) return;
			// Keep the last projection so the UI can dim-stale rather than blank out.
			setConnection('error');
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [endpoint, ingest]);

	useEffect(() => {
		alive.current = true;
		// Reset diff baseline + activity when the endpoint changes.
		baseline.current = null;
		setProjection(null);
		setActivity([]);
		setConnection('connecting');
		setError(null);
		setUpdatedAt(null);

		let pollTimer: ReturnType<typeof setInterval> | null = null;
		const startPolling = () => {
			if (pollTimer !== null) return;
			void load();
			pollTimer = setInterval(() => void load(), pollMs);
		};

		// Prefer the live subscription; fall back to polling if it errors or ends.
		const unsubscribe = subscribeState(endpoint, {
			onState: (next) => {
				if (alive.current) ingest(next, Date.now());
			},
			onError: () => {
				if (alive.current) startPolling();
			},
		});
		// Immediate fetch so first paint isn't blocked on the first SSE frame.
		void load();

		return () => {
			alive.current = false;
			unsubscribe();
			if (pollTimer !== null) clearInterval(pollTimer);
		};
	}, [endpoint, load, pollMs, ingest]);

	return { projection, connection, error, updatedAt, activity, refresh: load };
};
