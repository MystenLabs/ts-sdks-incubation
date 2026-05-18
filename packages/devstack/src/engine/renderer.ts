// Renderer factory contract — what the supervisor needs from a status
// renderer (TUI, plain, silent) without depending upward on `tui/`.
//
// The supervisor calls `mount(deps)` once per `launchEffect`. The
// returned `RendererMount` exposes:
//   - `install(engine)` — called per-cycle to point the renderer at
//     the fresh per-cycle engine. TUI uses this to swap its internal
//     engine proxy without re-mounting ink. Plain / silent renderers
//     no-op.
//   - `flush` — called by the supervisor in `onInterrupt` to drive ONE
//     final render of `shutting-down` state BEFORE docker-rm
//     finalizers freeze the event loop.
//   - `loggerLayer(engine)` — Logger layer routed at this renderer's
//     log sink. TUI returns a layer that appends to the engine's
//     bounded log buffer (so logs land in the dashboard); plain /
//     silent return `Layer.empty` (the default Effect logger writes
//     stderr inline with the diff lines).
//
// Concrete factories live in `tui/factory.ts`. Entry points (`cli/up`,
// `compose/devstack`) pick a factory by `RendererKind` and pass it
// down via `RunOverrides.rendererFactory`.

import { Effect, Layer, type Ref } from 'effect';
import type { EngineHandleShape } from './engine.js';
import type { TuiState } from './tui-state.js';

export type RendererKind = 'tui' | 'plain' | 'silent';

export interface RendererMount {
	/** Point the renderer at a fresh per-cycle engine. Called once per
	 *  supervisor cycle. Non-TUI renderers may treat this as a no-op. */
	readonly install: (engine: EngineHandleShape) => Effect.Effect<void>;
	/** One-shot synchronous render coordinator. Called by the
	 *  supervisor in `onInterrupt` to land the final `shutting-down`
	 *  state on screen / stderr BEFORE docker-rm finalizers stall the
	 *  event loop. */
	readonly flush: Effect.Effect<void>;
}

export interface RendererMountDeps {
	/** Read-only handle for the engine's `tuiState` ref. Used by
	 *  source-based renderers (plain) to poll for status changes. */
	readonly tuiStateRef: Ref.Ref<TuiState>;
}

/** Factory that knows how to start a renderer of a particular kind.
 *  The supervisor receives one of these via `DevstackConfig` /
 *  `RunOverrides` and calls `mount(...)` exactly once per launch.
 *
 *  The Effect's `R` channel is `unknown` because concrete factories may
 *  consume platform services (e.g. `Stdio.Stdio` for the plain
 *  renderer's stderr sink). The supervisor provides the bootstrap
 *  context at the mount call site so any required platform service is
 *  in scope. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface RendererFactory {
	readonly kind: RendererKind;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	readonly mount: (deps: RendererMountDeps) => Effect.Effect<RendererMount, never, any>;
	/** Per-cycle logger layer. TUI returns a custom sink writing to the
	 *  engine's log buffer; plain / silent return `Layer.empty`. */
	readonly loggerLayer: (engine: EngineHandleShape) => Layer.Layer<never, never, never>;
}

/** No-op renderer — accepts the engine but emits nothing. Used as the
 *  fallback when a caller forgets to wire a resolver and asks for a
 *  kind the supervisor can't satisfy on its own. */
export const silentRendererFactory: RendererFactory = {
	kind: 'silent',
	mount: () =>
		Effect.succeed({
			install: () => Effect.void,
			flush: Effect.void,
		}),
	loggerLayer: () => Layer.empty,
};

/** Resolves a `RendererKind` to a concrete `RendererFactory`. Wired by
 *  `compose/devstack.ts` (which knows about tui / plain) and passed to
 *  the supervisor so `engine/supervisor.ts` itself never imports the
 *  tui module. */
export type RendererResolver = (kind: RendererKind) => RendererFactory;
