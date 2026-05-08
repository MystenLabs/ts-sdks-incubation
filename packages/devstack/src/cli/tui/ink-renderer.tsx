// Ink-based TUI renderer for `devstack up`. Mounts a single React tree
// containing the chrome (Header, StatusTable / RegistryView /
// ShutdownPanel, Footer) and surfaces user actions back to the supervisor
// via `onAction`. The supervisor still owns shutdown sequencing and
// retry — this layer is purely presentational.
//
// Rendering: stays on the primary screen with `alternateScreen: false`
// + `incrementalRendering: true`. Log lines stream to terminal
// scrollback via ink's `<Static>`; only the anchored bottom panel
// (status / registry / shutdown) redraws. After `unmount()`, a single
// post-shutdown summary line is written to stdout so the user sees a
// clean "shutdown complete" message once `devstack up` exits.

import { Box, type Instance, render, useApp, useInput } from 'ink';
import { useEffect, useRef, useSyncExternalStore } from 'react';

import type { ActionStatus } from '../../core/types.js';
import type { SerializedRegistry } from '../../runtime/manifest-types.js';
import type {
	Renderer,
	RendererStartOptions,
	ShutdownSummary,
	SupervisorAction,
} from '../../runtime/renderer.js';
import { formatMs } from '../../runtime/renderers/plain.js';
import {
	Footer,
	Header,
	LogStream,
	RegistryView,
	ShutdownPanel,
	StatusTable,
} from './components.js';
import { type Store, appendLog, createStore, setMainView } from './store.js';

interface InkRendererOptions {
	stdout?: NodeJS.WriteStream;
	stdin?: NodeJS.ReadStream;
}

export class InkRenderer implements Renderer {
	private readonly opts: InkRendererOptions;
	private store: Store | undefined;
	private instance: Instance | undefined;
	private actionHandler: ((a: SupervisorAction) => void) | undefined;
	/** Plain-text summary printed after unmount restores the primary
	 * screen. Captured in `finishShutdown` so it survives ink's alt-
	 * screen teardown (which discards everything that was on the alt
	 * buffer, including the rendered ShutdownPanel). */
	private postExitSummary = '';

	constructor(opts: InkRendererOptions = {}) {
		this.opts = opts;
	}

	start(opts: RendererStartOptions): void {
		const initialStatuses = new Map<string, ActionStatus>();
		for (const a of opts.actions) initialStatuses.set(a.name, 'idle');
		// Pre-seed the plugin encounter order from the action graph so
		// the status table's per-plugin coloring is stable from frame
		// one (additional plugins joining via `appendLog` get appended).
		const pluginOrder: string[] = [];
		const seen = new Set<string>();
		for (const a of opts.actions) {
			const p = a.plugin;
			if (p === undefined || seen.has(p)) continue;
			seen.add(p);
			pluginOrder.push(p);
		}
		this.store = createStore({
			appName: opts.appName,
			stack: opts.stack,
			network: opts.network,
			rpcUrl: opts.rpcUrl,
			startedAtMs: Date.now(),
			actions: opts.actions,
			statuses: initialStatuses,
			failures: new Map(),
			startTimes: new Map(),
			settleTimes: new Map(),
			registry: null,
			logs: [],
			mainView: 'status',
			shutdown: null,
			pluginOrder,
			pluginDescriptions: opts.pluginDescriptions ?? new Map(),
		});
		this.instance = render(
			<App
				store={this.store}
				fireAction={(a) => this.actionHandler?.(a)}
				forceExit={() => this.forceExit()}
			/>,
			{
				stdout: this.opts.stdout ?? process.stdout,
				stdin: this.opts.stdin ?? process.stdin,
				// Supervisor handles SIGINT itself (incl. labeled shutdown
				// drain). If ink also exits on Ctrl-C we'd race the supervisor
				// to unmount, breaking the ShutdownPanel render.
				exitOnCtrlC: false,
				// Stay on the primary screen and use `<Static>` to commit
				// log lines to scrollback as they arrive. Only the status
				// panel (anchored at the bottom) redraws — everything
				// above it is committed text the user can scroll through
				// natively. No alt-screen take-over, no scrollback
				// trampling.
				alternateScreen: false,
				incrementalRendering: true,
				// Don't redirect plugins' direct console.* writes through
				// ink — they'd bypass `<Static>` and confuse the panel-
				// redraw, AND get stuck behind ink's frame queue. Plugins
				// that want their output in the supervisor stream go
				// through `ctx.appendLog`.
				patchConsole: false,
			},
		);
	}

	/** Force-exit path triggered by a second `q` / `Ctrl+C`. Unmount ink
	 * synchronously so the terminal is restored (cursor visible, raw
	 * mode off, primary screen) before we exit; otherwise the user
	 * lands in a half-broken terminal. */
	private forceExit(): void {
		const inst = this.instance;
		this.instance = undefined;
		try {
			inst?.unmount();
		} catch {
			/* already unmounted */
		}
		const out = this.opts.stdout ?? process.stdout;
		out.write('devstack up: force exit\n');
		process.exit(130);
	}

	update(statuses: Map<string, ActionStatus>, failures: Map<string, Error>): void {
		this.store?.mutate((s) => {
			for (const [name, status] of statuses) {
				const prev = s.statuses.get(name);
				if (prev === status) continue;
				s.statuses.set(name, status);
				if (status === 'running') s.startTimes.set(name, Date.now());
				if (status === 'ok' || status === 'failed' || status === 'skipped') {
					s.settleTimes.set(name, Date.now());
				}
			}
			s.failures.clear();
			for (const [name, err] of failures) s.failures.set(name, err.message);
		});
	}

	markStale(names: string[]): void {
		this.store?.mutate((s) => {
			for (const n of names) {
				if (s.statuses.get(n) === 'stale') continue;
				s.statuses.set(n, 'stale');
			}
		});
	}

	appendLog(actionName: string, line: string): void {
		const store = this.store;
		if (store === undefined) return;
		store.mutate((s) => {
			const pluginByAction = new Map<string, string | undefined>();
			for (const a of s.actions) pluginByAction.set(a.name, a.plugin);
			appendLog(
				s,
				{ id: store.nextLogId(), ts: Date.now(), src: actionName, msg: line },
				pluginByAction,
			);
		});
	}

	setRpcUrl(rpcUrl: string): void {
		this.store?.mutate((s) => {
			s.rpcUrl = rpcUrl;
		});
	}

	setRegistry(snapshot: SerializedRegistry): void {
		this.store?.mutate((s) => {
			s.registry = snapshot;
		});
	}

	beginShutdown(hooks: Array<{ label: string }>): void {
		this.store?.mutate((s) => {
			if (s.shutdown === null) {
				s.shutdown = {
					startedAtMs: Date.now(),
					hooks: new Map(),
				};
			}
			for (const h of hooks) {
				if (!s.shutdown.hooks.has(h.label)) {
					s.shutdown.hooks.set(h.label, { label: h.label, status: 'pending' });
				}
			}
		});
	}

	progressShutdown(
		label: string,
		status: 'running' | 'done' | 'failed',
		detail?: string,
	): void {
		this.store?.mutate((s) => {
			if (s.shutdown === null) return;
			const h = s.shutdown.hooks.get(label) ?? {
				label,
				status: 'pending' as const,
			};
			if (status === 'running') {
				h.status = 'running';
				h.startedAtMs = Date.now();
			} else {
				h.status = status;
				h.settledAtMs = Date.now();
				if (detail !== undefined) h.detail = detail;
			}
			s.shutdown.hooks.set(label, h);
		});
	}

	finishShutdown(summary: ShutdownSummary): void {
		this.store?.mutate((s) => {
			if (s.shutdown === null) return;
			s.shutdown.summary = summary;
		});
		// Cache the plain-text version for the post-unmount stdout
		// write. Mirrors the PlainRenderer's `finishShutdown` line so
		// the after-exit message looks identical regardless of which
		// renderer was active during the run.
		const total = summary.completed + summary.failed;
		const dur = formatMs(summary.durationMs);
		const head = summary.failed === 0 ? 'shutdown complete' : 'shutdown complete (with errors)';
		const detail =
			`${summary.completed}/${total} ok in ${dur}` +
			(summary.failed > 0 ? `, ${summary.failed} failed` : '');
		this.postExitSummary = `devstack up: ${head} — ${detail}`;
	}

	stop(): void {
		const inst = this.instance;
		if (inst === undefined) return;
		this.instance = undefined;
		try {
			inst.unmount();
		} catch {
			/* already unmounted */
		}
		// Ink restored the primary screen; this line lands on the user's
		// normal terminal (not the alt buffer). Empty when shutdown
		// never fired (e.g. cycle errored before any hook ran) — that's
		// fine, just a blank line.
		const out = this.opts.stdout ?? process.stdout;
		out.write(`${this.postExitSummary}\n`);
	}

	onAction(handler: (a: SupervisorAction) => void): () => void {
		this.actionHandler = handler;
		return () => {
			this.actionHandler = undefined;
		};
	}
}

interface AppProps {
	store: Store;
	fireAction: (a: SupervisorAction) => void;
	forceExit: () => void;
}

const QUIT_RESET_MS = 3_000;

function App({ store, fireAction, forceExit }: AppProps): React.ReactElement {
	const { exit } = useApp();
	// Track quit-key presses so a stuck shutdown doesn't trap the user
	// in the TUI. First press → graceful (`fireAction('shutdown')`),
	// second within `QUIT_RESET_MS` → forceExit (unmounts ink, exits
	// 130). Mirrors the signal-handler force-exit on the supervisor side
	// so the same escape works whether the user mashes Ctrl+C or `q`.
	const quitCount = useRef(0);
	const quitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useInput((input, key) => {
		if (input === 'i') {
			// Toggle the bottom panel between the live status table and
			// the registry inspector. Uses the same area — no separate
			// pane, no scrollback trampling.
			store.mutate((s) => setMainView(s, s.mainView === 'status' ? 'registry' : 'status'));
			return;
		}
		if (input === 'r') {
			fireAction('retry');
			return;
		}
		if (input === 'q' || (key.ctrl && input === 'c')) {
			quitCount.current += 1;
			if (quitCount.current >= 2) {
				if (quitTimer.current !== undefined) clearTimeout(quitTimer.current);
				forceExit();
				return;
			}
			fireAction('shutdown');
			if (quitTimer.current !== undefined) clearTimeout(quitTimer.current);
			quitTimer.current = setTimeout(() => {
				quitCount.current = 0;
				quitTimer.current = undefined;
			}, QUIT_RESET_MS);
			return;
		}
	});

	useEffect(() => {
		// `useApp().exit` is exposed so we can clean up cleanly when
		// `instance.unmount()` is called from outside the React tree
		// (the supervisor's `stop()`). Without it, ink would still
		// process renders queued after unmount and warn about state
		// updates on an unmounted component.
		return () => exit();
	}, [exit]);

	return (
		<>
			{/* Logs commit to scrollback as they arrive. ink's <Static>
			    must be a direct child of the root — wrapping it in a Box
			    breaks the static-vs-dynamic split and the lines never
			    flush to stdout. */}
			<LogStream store={store} />
			{/* The dynamic block: header + status/registry/shutdown +
			    footer. `marginTop={1}` adds a blank row between the
			    streamed logs above and the anchored panel below so the
			    two regions don't visually butt together. Only this block
			    ever redraws. */}
			<Box flexDirection="column" marginTop={1}>
				<Header store={store} />
				<MainPanel store={store} />
				<Footer store={store} />
			</Box>
		</>
	);
}

function MainPanel({ store }: { store: Store }): React.ReactElement {
	// Must subscribe through useSyncExternalStore — reading
	// `store.get()` directly leaves the panel stuck on whichever branch
	// it picked at first mount (no re-render when `shutdown` flips
	// non-null or when the user toggles to the registry view).
	useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
	const s = store.get();
	if (s.shutdown !== null) return <ShutdownPanel store={store} />;
	if (s.mainView === 'registry') return <RegistryView store={store} />;
	return <StatusTable store={store} />;
}
