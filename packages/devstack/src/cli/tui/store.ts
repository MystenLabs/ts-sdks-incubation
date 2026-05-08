// Mutable, pub/sub-backed UI state for the InkRenderer. Components
// subscribe via `useSyncExternalStore` against `getVersion()` — the
// store bumps `version` inside `notify()` so React always sees a
// fresh snapshot value. Returning the state object would silently
// short-circuit re-renders via `Object.is` (the maps are mutated in
// place, so reference equality holds).
//
// The store is intentionally renderer-internal: the public Renderer
// methods on `InkRenderer` are the only mutators, and they translate
// supervisor events into store updates + a single notify.

import type { Action, ActionStatus, Network } from '../../core/types.js';
import type { SerializedRegistry } from '../../runtime/manifest-types.js';
import type { ShutdownSummary } from '../../runtime/renderer.js';

export interface LogLine {
	/** Monotonically-increasing sequence number, set by `appendLog`.
	 * Used as the React key for `<Static>` items so ink's index-based
	 * tracking has a stable identity per line. */
	id: number;
	ts: number;
	src: string;
	msg: string;
}

export interface ShutdownHookState {
	label: string;
	status: 'pending' | 'running' | 'done' | 'failed';
	startedAtMs?: number;
	settledAtMs?: number;
	detail?: string;
}

export interface ShutdownState {
	startedAtMs: number;
	hooks: Map<string, ShutdownHookState>;
	summary?: ShutdownSummary;
}

/** Toggleable bottom panel. Logs always stream into terminal scrollback
 * via `<Static>`; the bottom panel either shows the live status table
 * or the registry inspector (`i` toggles). */
export type MainView = 'status' | 'registry';

export interface TuiState {
	appName: string;
	stack: string;
	network: Network;
	rpcUrl?: string;
	startedAtMs: number;
	actions: Action[];
	statuses: Map<string, ActionStatus>;
	failures: Map<string, string>;
	startTimes: Map<string, number>;
	settleTimes: Map<string, number>;
	/** Per-action endpoint outputs, populated post-cycle by the
	 * supervisor from each registered service's `providedBy`. */
	registry: SerializedRegistry | null;
	logs: LogLine[];
	mainView: MainView;
	shutdown: ShutdownState | null;
	/** Plugin encounter order. Stable across appendLog calls and used
	 * to assign deterministic colors via `buildPluginColorMap`. */
	pluginOrder: string[];
	/** plugin-name → description, surfaced as a sub-line under the
	 * plugin's section header. Empty map when no plugins declared
	 * descriptions. */
	pluginDescriptions: Map<string, string>;
	version: number;
}


export interface Store {
	get(): TuiState;
	getVersion(): number;
	subscribe(listener: () => void): () => void;
	mutate(fn: (state: TuiState) => void): void;
	/** Allocate the next log line id. Called by `appendLog` to set
	 * `LogLine.id`; exposed so the (very small) bookkeeping stays
	 * adjacent to the store internals. */
	nextLogId(): number;
}

export function createStore(initial: Omit<TuiState, 'version'>): Store {
	const state: TuiState = { ...initial, version: 0 };
	const listeners = new Set<() => void>();
	let logIdSeq = 0;
	return {
		get: () => state,
		getVersion: () => state.version,
		subscribe: (l) => {
			listeners.add(l);
			return () => listeners.delete(l);
		},
		mutate: (fn) => {
			fn(state);
			state.version++;
			for (const l of listeners) l();
		},
		nextLogId: () => ++logIdSeq,
	};
}

/** Max log lines retained in store. Older lines have already committed
 * to terminal scrollback via ink's `<Static>` and the user reaches them
 * by scrolling natively; the in-memory buffer only feeds new mounts of
 * `<Static>`. Cap prevents unbounded React state growth on long
 * supervisor runs (vite/sui logs can spike to many lines/sec). */
const MAX_LOG_LINES = 1000;

export function appendLog(
	state: TuiState,
	line: LogLine,
	pluginByAction: Map<string, string | undefined>,
): void {
	// MUST be a new array reference, not in-place push. ink's `<Static>`
	// memoizes its slice via `useMemo([items, index])`, so a same-ref
	// push leaves `itemsToRender` empty and the line never commits to
	// stdout. The cost is one shallow array copy per log line — fine
	// at our throughput (a few lines per second at peak).
	const next = state.logs.length >= MAX_LOG_LINES
		? [...state.logs.slice(state.logs.length - MAX_LOG_LINES + 1), line]
		: [...state.logs, line];
	state.logs = next;
	// Track plugin encounter order for stable color assignment. No
	// per-plugin filtering anymore — logs flow into terminal scrollback
	// via `<Static>`, the user uses native scrollback to navigate.
	const plugin = line.src === 'supervisor' ? 'supervisor' : pluginByAction.get(line.src);
	if (plugin !== undefined && plugin !== 'supervisor' && !state.pluginOrder.includes(plugin)) {
		state.pluginOrder.push(plugin);
	}
}

export function setMainView(state: TuiState, view: MainView): void {
	state.mainView = view;
}
