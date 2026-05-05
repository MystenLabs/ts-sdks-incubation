// Renderer SPI. Two implementations:
//
//   PlainRenderer (./renderers/plain.ts)
//     Text-only, no ANSI, no in-place redraw. CI-safe. Emits one line
//     per state transition + a final summary.
//
//   InkRenderer (../cli/tui/ink-renderer.tsx)
//     Full TUI: header, status table, tab-switchable per-action log
//     panes, footer hints, dedicated shutdown panel. TTY-only.
//
// `cli/up.ts` selects which based on `stdout.isTTY` + `CI` / `NO_COLOR` /
// `DEVSTACK_NO_TUI` env. The supervisor only knows about this interface.
//
// Lifecycle: `start()` once, then any number of `update()` /
// `appendLog()` / `markStale()`. On shutdown: `beginShutdown(hooks)`,
// then `progressShutdown(label, …)` per hook, then
// `finishShutdown(stats)`, then `stop()` once. `stop()` MUST be safe to
// call without `beginShutdown` having fired (e.g. cycle errored before
// any hook registered).

import type { Action, ActionEndpoint, ActionStatus, Network } from '../core/types.js';
import type { SerializedRegistry } from './manifest-types.js';

export interface RendererStartOptions {
	appName: string;
	stack: string;
	network: Network;
	/** Every action the supervisor knows about, in topo-friendly order
	 * (renderers display in this order). */
	actions: Action[];
	/** Pre-resolved RPC URL if the config declared one; renderers may
	 * also pick this up from the registry's `sui-rpc` service later via
	 * `setRpcUrl`. */
	rpcUrl?: string;
}

export interface ShutdownProgress {
	label: string;
	status: 'pending' | 'running' | 'done' | 'failed';
	/** Failure detail when status === 'failed'. */
	detail?: string;
	/** Wall-clock ms since beginShutdown when this hook started. */
	startedAtMs?: number;
	/** Wall-clock ms since beginShutdown when this hook settled. */
	settledAtMs?: number;
}

export interface ShutdownSummary {
	completed: number;
	failed: number;
	durationMs: number;
}

/** User-driven supervisor commands the renderer can surface from its
 * own keypress handler (Ink owns stdin in TTY mode). PlainRenderer
 * doesn't bind keys; the supervisor's built-in raw-mode handler
 * stays in charge in plain mode. */
export type SupervisorAction = 'shutdown' | 'retry';

export interface Renderer {
	/** Print initial header / mount the TUI. Idempotent across re-entry. */
	start(opts: RendererStartOptions): void;

	/** Authoritative status snapshot from the reconciler. Renderers diff
	 * against the previous snapshot to drive transition output. */
	update(statuses: Map<string, ActionStatus>, failures: Map<string, Error>): void;

	/** Transient `stale` hint from the file watcher; the next `update()`
	 * overwrites. */
	markStale(names: string[]): void;

	/** Action log line. `actionName === 'supervisor'` is reserved for
	 * harness-level messages (manifest write failures, hook progress
	 * before labels are known, etc). */
	appendLog(actionName: string, line: string): void;

	/** RPC URL becomes known late (sui plugin registers `sui-rpc` mid-
	 * cycle). Plain renderer ignores; Ink shows it in the header. */
	setRpcUrl?(rpcUrl: string): void;

	/** Per-cycle batched update of every healthy action's resolved
	 * endpoints. Only sent when the set changes — quiet steady state. */
	setEndpoints?(map: Map<string, ActionEndpoint[]>): void;

	/** Per-cycle snapshot of the live registry (packages, accounts,
	 * services, namespaced kinds). Powers the TUI's `registry` tab so
	 * users can inspect live deploy state without leaving the
	 * supervisor. PlainRenderer ignores. */
	setRegistry?(snapshot: SerializedRegistry): void;

	/** Begin shutdown sequence with the labels of pending hooks (in the
	 * order the supervisor will fire them). Required before
	 * `progressShutdown`. */
	beginShutdown(hooks: Array<{ label: string }>): void;

	/** A hook started, finished, or failed. Renderers maintain the per-
	 * hook timing internally. */
	progressShutdown(
		label: string,
		status: 'running' | 'done' | 'failed',
		detail?: string,
	): void;

	/** Final shutdown summary line; called after every hook has settled. */
	finishShutdown(summary: ShutdownSummary): void;

	/** Tear down anything stateful (raw-mode TTY, ink instance, …) and
	 * leave the cursor in a clean state. */
	stop(): void;

	/** Renderers that own stdin (InkRenderer in TTY mode) install their
	 * own keypress handler and surface user commands through here. The
	 * supervisor calls this in `start()`; if it returns a function the
	 * supervisor skips its built-in raw-mode handler and calls the
	 * returned function on shutdown to release the binding. PlainRenderer
	 * leaves this undefined so the supervisor's existing TTY keybinds
	 * keep working. */
	onAction?(handler: (action: SupervisorAction) => void): () => void;
}
