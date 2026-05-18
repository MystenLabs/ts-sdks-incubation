// Concrete renderer factories — bridge between `engine/renderer.ts`'s
// abstract `RendererFactory` contract and the concrete TUI / plain
// renderers in `tui/`. Lives here (not in `engine/`) so the supervisor
// itself stays out of the upward import chain into `tui/`.
//
// `compose/devstack.ts` instantiates the default resolver and threads
// it through `defineDevstack` so user configs and the CLI both end up
// with a renderer of the right kind without anyone reaching into
// `tui/` directly.

import { Effect, Layer, Ref } from 'effect';
import type { EngineHandleShape } from '../engine/engine.js';
import type {
	RendererFactory,
	RendererKind,
	RendererMount,
	RendererMountDeps,
	RendererResolver,
} from '../engine/renderer.js';
import { silentRendererFactory } from '../engine/renderer.js';
import { startPlainRenderer } from '../tui/plain.js';
import { startTuiOnce, TuiLoggerLayer } from '../tui/index.js';

/** TUI factory — mounts ink ONCE for the supervisor lifetime via
 *  `startTuiOnce()`, then redirects the cycle engine into the (stable)
 *  proxy on every `install()`. Logger layer routes `Effect.log*` into
 *  the engine's bounded log buffer so log output stays serialised with
 *  the dashboard frames. */
export const tuiRendererFactory: RendererFactory = {
	kind: 'tui',
	mount: (_deps: RendererMountDeps) =>
		Effect.gen(function* () {
			const mount = yield* startTuiOnce();
			return {
				install: mount.install,
				flush: mount.flush,
			} satisfies RendererMount;
		}),
	loggerLayer: (engine: EngineHandleShape) => TuiLoggerLayer(engine),
};

/** Plain renderer factory — starts the line-per-event diff loop ONCE
 *  on the supervisor's outer scope; the cycle engine is read directly
 *  from `tuiStateRef` so `install()` is a no-op. The default Effect
 *  logger continues to write through Logger's default sink (plain text
 *  on stderr) — no engine-buffer redirection. */
export const plainRendererFactory: RendererFactory = {
	kind: 'plain',
	mount: (deps: RendererMountDeps) =>
		Effect.gen(function* () {
			const handle = yield* startPlainRenderer(Ref.get(deps.tuiStateRef));
			return {
				install: () => Effect.void,
				flush: handle.flush as Effect.Effect<void>,
			} satisfies RendererMount;
		}),
	loggerLayer: () => Layer.empty,
};

/** Default resolver — maps each `RendererKind` to the matching
 *  concrete factory. Wired into `defineDevstack` by
 *  `compose/devstack.ts` so the supervisor doesn't need to import
 *  anything from `tui/`. */
export const defaultRendererResolver: RendererResolver = (kind: RendererKind): RendererFactory => {
	if (kind === 'tui') return tuiRendererFactory;
	if (kind === 'plain') return plainRendererFactory;
	return silentRendererFactory;
};
