// Thin Effect wrapper that mounts the ink-based TUI.
//
// Ink owns all the cursor/clear/diff plumbing — we no longer hand-roll
// any ANSI. Three iterations of hand-rolled live-region drivers shipped
// real bugs (missing ESC byte, screen never clearing, full re-renders,
// terminal state corruption); ink eliminates that whole class of issue
// by treating the rendered tree as a React Virtual DOM.
//
// The mount is wired to the OUTER Effect scope (the one that wraps every
// restart cycle, not the per-cycle scope): `instance.unmount()` ONLY
// fires on full teardown (Ctrl-C → NodeRuntime.runMain). Per-cycle
// teardown leaves the same ink instance alive — the proxy engine below
// re-points it at the next cycle's engine so the user sees an in-place
// transition instead of a fresh panel rendered below the now-frozen
// previous cycle's panel in scrollback.

import { Deferred, Effect, Layer, Logger, Ref } from 'effect';
import type { Scope } from 'effect/Scope';
import { render } from 'ink';
import React from 'react';
import type { EngineHandleShape } from '../engine/engine.js';
import { App } from './components.js';

/**
 * Proxy engine that reads `tuiState` from a stable Ref-of-Ref and
 * forwards `requestRestart` to whichever cycle engine is currently
 * installed. The ink `<App>` component holds a reference to THIS shape
 * for the entire `runMain` lifetime; we swap the inner engine each
 * cycle without re-mounting ink.
 *
 * Only the methods `<App>` actually invokes need real forwarding
 * (`tuiState` reads, `requestRestart` on `r`). Everything else is a
 * no-op safe-default — the proxy is never used by the production-stack
 * fibers, which run against the real per-cycle engine.
 */
export interface TuiMount {
	readonly proxy: EngineHandleShape;
	readonly install: (engine: EngineHandleShape) => Effect.Effect<void>;
	/** One-shot synchronous render coordinator. Called by the supervisor in
	 *  `onInterrupt` to land the final 'shutting-down' state on screen
	 *  BEFORE docker-rm finalizers stall the event loop. Re-syncs
	 *  `stableState` from the currently-installed engine then waits a
	 *  short fixed budget (~20ms) for React to commit. */
	readonly flush: Effect.Effect<void>;
}

const makeNoopProxy = (
	currentRef: Ref.Ref<EngineHandleShape | undefined>,
	stableState: Ref.Ref<import('./render.js').TuiState>,
	placeholderRestartSignal: Ref.Ref<Deferred.Deferred<void>>,
	placeholderChangedTags: Ref.Ref<ReadonlyArray<string>>,
): EngineHandleShape => {
	const noop = Effect.void;
	// `<App>` invokes `requestRestart` directly on key `r`/`R`; we forward
	// to whichever cycle engine is currently installed so the active cycle's
	// restartSignal Deferred resolves and `runOnce` unblocks.
	const requestRestart = Effect.gen(function* () {
		const current = yield* Ref.get(currentRef);
		if (current !== undefined) yield* current.requestRestart;
	});
	// Shutdown-feedback path: the q-keypress handler in `<App>` calls
	// `setBuildStatus('shutting-down')` + `appendLog(...)` on the proxy
	// BEFORE re-emitting SIGINT, so we forward those two methods to the
	// active cycle engine. Without forwarding the cycle engine's tuiState
	// never sees the update and the header stays `[running]` through the
	// teardown freeze, reading as a hang.
	const setBuildStatus: EngineHandleShape['setBuildStatus'] = (status) =>
		Effect.gen(function* () {
			const current = yield* Ref.get(currentRef);
			if (current !== undefined) yield* current.setBuildStatus(status);
		});
	const appendLog: EngineHandleShape['appendLog'] = (entry) =>
		Effect.gen(function* () {
			const current = yield* Ref.get(currentRef);
			if (current !== undefined) yield* current.appendLog(entry);
		});
	return {
		tuiState: stableState,
		markAcquiring: () => noop,
		markReady: () => noop,
		setPhase: () => noop,
		markFailed: () => noop,
		markAllReady: noop,
		seedTags: () => noop,
		appendLog,
		appendTagLog: () => noop,
		setEntryTitle: () => noop,
		setHeader: () => noop,
		setBuildStatus,
		// Real type, never resolved — `<App>` doesn't read this; only the
		// per-cycle launch loop does, and it reads the live cycle engine's
		// own restartSignal, not the proxy's.
		restartSignal: placeholderRestartSignal,
		requestRestart,
		armRestartSignal: noop,
		clearChangedTags: noop,
		// Proxy doesn't track watch-event attribution — the per-cycle
		// engine does. `<App>` doesn't read these either; only the
		// launch loop's cycle-start log reads `changedTags`, and that
		// reads the live cycle engine's own Ref. Provided as no-ops to
		// satisfy the EngineHandleShape contract.
		changedTags: placeholderChangedTags,
		notifyChangedTags: () => noop,
	};
};

/**
 * Mount the ink TUI exactly once for the entire devstack lifetime.
 *
 * Returns a `TuiMount` whose `proxy` is the engine handle passed to
 * `<App>`. Each restart cycle calls `install(cycleEngine)` to redirect
 * the proxy's reads/restart-requests at the fresh engine. A 100ms sync
 * fiber forked here mirrors the cycle engine's `tuiState` into the
 * proxy's stable Ref — that's what makes the rendered panel update
 * in-place across cycles instead of being committed to scrollback and
 * re-drawn below.
 *
 * Pre-seeding (engine.seedTags) before `install` is called means users
 * never see a flash of empty state between cycles: the new cycle's
 * pending rows replace the old cycle's terminal statuses in a single
 * render tick.
 *
 * `patchConsole: true` redirects any stray `console.*` calls into ink's
 * own buffer so they don't tear the layout. `exitOnCtrlC: false` keeps
 * SIGINT flowing to `NodeRuntime.runMain` — ink eating the signal would
 * skip the engine's scope-finalizer shutdown path and leak docker
 * containers.
 */
export const startTuiOnce = (): Effect.Effect<TuiMount, never, Scope> =>
	Effect.gen(function* () {
		const stableState = yield* Ref.make<import('./render.js').TuiState>({
			entries: [],
			endpoints: [],
			logs: [],
			header: { app: '', stack: 'main', network: 'localnet', buildStatus: 'idle', cycle: 0 },
		});
		const currentRef = yield* Ref.make<EngineHandleShape | undefined>(undefined);
		const placeholderRestartSignal = yield* Ref.make(yield* Deferred.make<void>());
		const placeholderChangedTags = yield* Ref.make<ReadonlyArray<string>>([]);
		const proxy = makeNoopProxy(
			currentRef,
			stableState,
			placeholderRestartSignal,
			placeholderChangedTags,
		);

		const onQuit = (): void => {
			process.kill(process.pid, 'SIGINT');
		};
		const instance = render(React.createElement(App, { engine: proxy, onQuit }), {
			exitOnCtrlC: false,
			patchConsole: true,
		});
		yield* Effect.addFinalizer(() =>
			Effect.sync(() => {
				instance.unmount();
			}),
		);

		// Sync fiber: copies the currently-installed engine's tuiState into
		// the proxy's stable Ref on a 50ms tick. Polling (vs subscribe) keeps
		// the engine's Ref API simple — no SubscriptionRef churn — and 50ms
		// is well under the 100ms tick the `<App>` component itself uses, so
		// in practice the proxy's snapshot is always at-most-one-tick stale
		// relative to the live engine.
		yield* Effect.forkScoped(
			Effect.forever(
				Effect.gen(function* () {
					yield* Effect.sleep('50 millis');
					const current = yield* Ref.get(currentRef);
					if (current === undefined) return;
					const snapshot = yield* Ref.get(current.tuiState);
					yield* Ref.set(stableState, snapshot);
				}),
			),
		);

		const install = (engine: EngineHandleShape) =>
			Effect.gen(function* () {
				// Eager first copy of the engine's tuiState BEFORE flipping
				// `currentRef`. The poll fiber (above) ignores ticks when
				// `currentRef` is undefined, so by the time it sees the new
				// engine the snapshot already reflects that engine's
				// pending rows. Reverse order would expose a one-tick
				// window where `currentRef === engine` but `stableState`
				// still carried the previous cycle's entries — the user
				// would see a frame of "wrong" rows before the next sync.
				const snapshot = yield* Ref.get(engine.tuiState);
				yield* Ref.set(stableState, snapshot);
				yield* Ref.set(currentRef, engine);
			});

		// One-shot synchronous render coordinator. The supervisor calls
		// this in `onInterrupt` so the final 'shutting-down' state lands
		// on screen BEFORE the docker-rm-finalizers stall the event loop.
		// Without coordination the 50ms poll tick had to win a race
		// against the finalizers; on slow terminals or under load it
		// could lose.
		const flush = Effect.gen(function* () {
			const current = yield* Ref.get(currentRef);
			if (current === undefined) return;
			// Skip the next-poll-tick wait: snapshot the engine's tuiState
			// and write it to stableState directly. Ink schedules its
			// render synchronously on the Ref change; the short sleep
			// after gives the React tree a couple of event-loop turns to
			// commit + flush stdout writes before the caller's finalizers
			// fire. 20ms is well under one polling interval and ink's own
			// frame budget, so it's effectively free.
			const snapshot = yield* Ref.get(current.tuiState);
			yield* Ref.set(stableState, snapshot);
			yield* Effect.sleep('20 millis');
		});

		return { proxy, install, flush };
	}).pipe(Effect.withSpan('Tui.startOnce'));

/**
 * Logger layer that redirects `Effect.log*` calls into `engine.appendLog`.
 *
 * Without this, Effect's default logger writes to stderr in parallel
 * with ink's render output. The two streams interleave around ink's
 * frame writes and the layout tears. Routing everything through the
 * engine's bounded buffer keeps log delivery serialized through the
 * single source-of-truth Ref the ink components subscribe to.
 */
export const TuiLoggerLayer = (engine: EngineHandleShape): Layer.Layer<never, never, never> => {
	const tuiLogger = Logger.make(({ logLevel, message, date }) => {
		const text = Array.isArray(message)
			? message.map((m) => (typeof m === 'string' ? m : JSON.stringify(m))).join(' ')
			: typeof message === 'string'
				? message
				: JSON.stringify(message);
		// `Effect.runSync` of a Ref-update normally can't fail — but if
		// the engine's tuiState Ref is bound to a torn-down scope (the
		// supervisor is mid-shutdown and a late Logger emit races the
		// scope finalizer) the runSync surfaces a `Scope closed`
		// defect that bubbles out as an uncaught exception and crashes
		// the supervisor process. Wrap with `catchCause` returning
		// `void` so defects (the typed errors in our Logger pipeline
		// is `never`) are swallowed — the log is the side-effect;
		// losing it during shutdown is fine.
		Effect.runSync(
			engine
				.appendLog({
					ts: date.getTime(),
					level: logLevel,
					message: text,
				})
				.pipe(Effect.catchCause(() => Effect.void)),
		);
	});
	return Logger.layer([tuiLogger]);
};

export { SHUTDOWN_LOG_MESSAGE } from './components.js';

export type {
	TuiDimensions,
	TuiEndpoint,
	TuiEntry,
	TuiEntryKind,
	TuiLog,
	TuiState,
	TagStatus,
} from './render.js';
