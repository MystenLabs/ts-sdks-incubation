import { render } from 'ink';
import type { Engine } from '../engine/class.js';
import type { Env } from '../engine/types.js';
import { writeSnapshot } from '../persistence/index.js';
import { App } from './components.js';
import { createStore } from './store.js';

export interface AttachInkRendererOptions {
	engine: Engine;
	env: Env;
	/** Resolved when the user presses 'q' so the host CLI can coordinate
	 * engine.stop() + flush. */
	onQuit: () => void;
	/** Optional override (defaults to the engine's persistence layer).
	 * Useful for tests that want to verify save without writing to disk. */
	saveSnapshot?: () => Promise<void>;
	stdout?: NodeJS.WriteStream;
	stdin?: NodeJS.ReadStream;
	/** Override Ink's interactive auto-detect. Defaults to Ink's own
	 * heuristic (true on a real TTY, false under CI / piped stdout).
	 * Tests pass `true` against a fake stdout so frames get written
	 * eagerly instead of held until unmount. */
	interactive?: boolean;
}

export interface AttachedTui {
	/** Ink unmount + store-detach. Calling this restores stdin to its
	 * original mode and tears down the React tree. Idempotent. */
	detach: () => Promise<void>;
	/** Resolves when the React tree finishes unmounting (either via
	 * `detach()` or because the user pressed 'q'). */
	waitUntilExit: () => Promise<void>;
	/** Resolves once Ink flushes any buffered output. Useful for tests
	 * that need to assert against the captured stdout. */
	waitUntilRenderFlush: () => Promise<void>;
}

// Mounts the Ink app. Pure subscriber — same shape as the plain
// renderer. The CLI in `up.ts` picks one or the other based on TTY +
// --no-tui state, so log/render channels never compete.
export function attachInkRenderer(opts: AttachInkRendererOptions): AttachedTui {
	const { store, detach: detachStore } = createStore(opts.engine);

	const saveDefault = async (): Promise<void> => {
		const record = await opts.engine.saveSnapshot();
		await writeSnapshot(opts.env, record);
	};
	const save = opts.saveSnapshot ?? saveDefault;

	const onSave = (): void => {
		void save().catch(() => {
			// Errors are best-effort surfaced via engine:error events; the
			// TUI shouldn't crash on a failed save.
		});
	};
	const onRetry = (name: string): void => opts.engine.retry(name);

	const inkRender = render(
		<App
			engine={opts.engine}
			env={opts.env}
			store={store}
			onQuit={opts.onQuit}
			onSave={onSave}
			onRetry={onRetry}
		/>,
		{
			...(opts.stdout !== undefined ? { stdout: opts.stdout } : {}),
			...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
			...(opts.interactive !== undefined ? { interactive: opts.interactive } : {}),
			// Stay on the primary screen so log lines that fell off the
			// pane survive in scrollback once we unmount.
			exitOnCtrlC: false,
		},
	);

	let detached = false;
	return {
		detach: async () => {
			if (detached) return;
			detached = true;
			detachStore();
			inkRender.unmount();
			await inkRender.waitUntilExit();
		},
		waitUntilExit: async () => {
			await inkRender.waitUntilExit();
		},
		waitUntilRenderFlush: async () => {
			await inkRender.waitUntilRenderFlush();
		},
	};
}
