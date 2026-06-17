// TUI surface entry point.
//
// Selects the renderer mode (ink / plain / silent), returns a
// `Renderer`-contract-satisfying value the supervisor can mount once
// per process. The supervisor wires the SubscriptionRef and event
// stream in; this surface does the rest.
//
// Architecture §11 + distilled/21-tui:
//   - One mount per process (the engine cycle re-runs many times;
//     mount survives).
//   - No engine handle is captured here — only the SubscriptionRef +
//     event Stream + command publisher.
//   - Mode selection follows `mode-detect.ts`: explicit > TTY-detect.
//
// This file deliberately does NOT import `ink` at the top level so
// non-TTY users (CI, scripts) don't pay the ink import cost. The ink
// renderer is lazy-imported behind the `ink` mode branch via the
// adjacent `mount-ink.tsx` helper (which owns the JSX).

import { Effect, Stream, SubscriptionRef } from 'effect';

import type { Renderer } from '../../contracts/renderer.ts';
import type { EngineCommand, EngineEvent } from '../../substrate/events.ts';
import type { SubscribableState } from '../../substrate/projection.ts';
import { mountFailed } from './errors.ts';
import { type RendererMode, detectMode } from './mode-detect.ts';
import { makePlainRenderer } from './plain-renderer.ts';

export interface TuiSurfaceOptions {
	/** Explicit mode override. `undefined` → auto-detect via stdout. */
	readonly mode?: RendererMode;
	/** Command publisher — every keypress turns into a typed
	 *  `EngineCommand` invoked here. Required for `ink` mode; ignored
	 *  for `plain` / `silent` (those modes are pure consumers). */
	readonly publishCommand?: (command: EngineCommand) => void;
	/** Plain-mode quiet filter — emit only readiness/endpoint/codegen
	 *  milestones + warnings/errors instead of every event. Ignored for
	 *  `ink` / `silent`. See {@link makePlainRenderer}. */
	readonly quiet?: boolean;
}

/**
 * Build the TUI renderer. The returned `Renderer` is the contract the
 * supervisor mounts (once per process); the supervisor passes the
 * SubscriptionRef + event Stream into `renderer.mount`.
 *
 * Mode selection:
 *   - `options.mode === 'silent'` → no-op renderer (no output).
 *   - `options.mode === 'plain'`  → structured stderr lines.
 *   - `options.mode === 'ink'`    → live Ink dashboard.
 *   - `undefined`                 → `detectMode()` (TTY → ink else plain).
 */
export const makeTuiSurface = (options: TuiSurfaceOptions = {}): Renderer => {
	const mode = detectMode(options.mode);
	switch (mode) {
		case 'silent':
			return makeSilentRenderer();
		case 'plain':
			return makePlainRenderer({ quiet: options.quiet });
		case 'ink':
			return makeInkRenderer({
				publishCommand:
					options.publishCommand ??
					(() => {
						/* no publisher wired → keypresses are silently dropped.
						 * The CLI/supervisor wiring is expected to provide one;
						 * we don't fail-fast on missing publisher so headless
						 * test mounts work. */
					}),
			});
		default: {
			const _exhaustive: never = mode;
			void _exhaustive;
			return makeSilentRenderer();
		}
	}
};

// -----------------------------------------------------------------------------
// Silent renderer
// -----------------------------------------------------------------------------

const makeSilentRenderer = (): Renderer => ({
	mount: (stateRef, events) =>
		// Drain the event stream so back-pressure doesn't accumulate;
		// emit nothing. Keep the SubscriptionRef alive (no-op read).
		Effect.gen(function* () {
			yield* SubscriptionRef.get(stateRef);
			yield* Stream.runDrain(events);
		}).pipe(
			Effect.catch((cause: unknown) =>
				Effect.fail(mountFailed(cause instanceof Error ? cause.message : String(cause))),
			),
		),
	flush: Effect.void,
});

// -----------------------------------------------------------------------------
// Ink renderer (lazy-loaded; depends on `ink` + `react`)
// -----------------------------------------------------------------------------

interface InkRendererOptions {
	readonly publishCommand: (command: EngineCommand) => void;
}

const makeInkRenderer = (options: InkRendererOptions): Renderer => ({
	mount: (stateRef, events) =>
		Effect.gen(function* () {
			// Lazy-import the JSX mount helper. The dynamic import
			// keeps the static graph thin for non-TTY callers.
			const { mountInkApp } = yield* Effect.tryPromise({
				try: () => import('./mount-ink.tsx'),
				catch: (cause) =>
					mountFailed(
						`ink lazy import failed: ${cause instanceof Error ? cause.message : String(cause)}`,
					),
			});

			yield* mountInkApp({
				stateRef,
				events,
				publishCommand: options.publishCommand,
			});
		}),
	flush: Effect.void,
});

// -----------------------------------------------------------------------------
// Public exports
// -----------------------------------------------------------------------------

export type { Renderer } from '../../contracts/renderer.ts';
export type { RendererMode } from './mode-detect.ts';
export { detectMode, resolveMode } from './mode-detect.ts';
export { deriveDisplayCells } from './display-derivation.ts';
export { formatEventLine, formatHeartbeat } from './plain-renderer.ts';
export type { EngineCommand, EngineEvent, SubscribableState };
