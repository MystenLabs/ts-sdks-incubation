// App shell: keyboard handling, plain-mode preview, tweaks panel.

const { useEffect, useMemo, useRef, useState } = React;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
	"theme": "modern",
	"density": "balanced",
	"borders": "single",
	"font": "JetBrains Mono",
	"mode": "tui",
	"showWindowChrome": true,
	"groupBy": "scope",
	"showEndpoints": true
}/*EDITMODE-END*/;

function WindowChrome({ children, title, theme }) {
	return (
		<div style={{
			height: '100vh',
			background: '#05070a',
			padding: 18,
			boxSizing: 'border-box',
			display: 'flex',
			flexDirection: 'column',
		}}>
			<div style={{
				display: 'flex',
				alignItems: 'center',
				gap: 10,
				padding: '8px 14px',
				background: 'var(--bg-elev)',
				borderTopLeftRadius: 8,
				borderTopRightRadius: 8,
				borderBottom: '1px solid var(--border-soft)',
			}}>
				<span style={{ width: 12, height: 12, borderRadius: '50%', background: '#ff5f57', display: 'inline-block' }} />
				<span style={{ width: 12, height: 12, borderRadius: '50%', background: '#febc2e', display: 'inline-block' }} />
				<span style={{ width: 12, height: 12, borderRadius: '50%', background: '#28c840', display: 'inline-block' }} />
				<span className="dim" style={{ marginLeft: 12, fontSize: 13 }}>{title}</span>
				<span className="dim" style={{ marginLeft: 'auto', fontSize: 12 }}>● ttys003 · 142×40</span>
			</div>
			<div style={{
				flex: 1,
				minHeight: 0,
				borderBottomLeftRadius: 8,
				borderBottomRightRadius: 8,
				overflow: 'hidden',
				border: '1px solid var(--border-soft)',
				borderTop: 'none',
			}}>
				{children}
			</div>
		</div>
	);
}

function PlainPreview({ store }) {
	const state = useStore(store);
	useTick(500);
	const lines = useMemo(() => {
		const out = [];
		const sep = '─'.repeat(60);
		out.push({ cls: 'mute', txt: sep });
		out.push({ cls: '', txt: <><span className="b">devstack up</span> <span className="dim">{state.appName} · {state.stack} · {state.network}</span></> });
		if (state.rpcUrl) out.push({ cls: '', txt: <><span className="dim">rpc</span> {state.rpcUrl}</> });
		out.push({ cls: 'dim', txt: `${state.actions.length} actions` });
		out.push({ cls: 'mute', txt: sep });
		// Replay state-transition log
		const seen = new Map();
		const events = [];
		for (const a of state.actions) {
			const s = state.statuses.get(a.name);
			if (s !== 'idle') {
				events.push({ name: a.name, status: s, t: state.startTimes.get(a.name) || state.startedAtMs });
				const settle = state.settleTimes.get(a.name);
				if (settle && (s === 'healthy' || s === 'failed' || s === 'skipped')) {
					events.push({ name: a.name, status: s, t: settle });
				}
			}
		}
		// Just render current statuses as one line each in stable order
		for (const a of state.actions) {
			const s = state.statuses.get(a.name);
			if (s === 'idle') continue;
			const start = state.startTimes.get(a.name);
			const settle = state.settleTimes.get(a.name);
			const dt = start ? `+${fmtMs((settle || Date.now()) - state.startedAtMs)}` : '';
			const err = state.failures.get(a.name);
			const cls = {
				running: 'acc', healthy: 'ok', failed: 'err',
				queued: 'mute', skipped: 'mute', stale: 'warn', dirty: 'warn',
			}[s] || 'dim';
			out.push({
				cls: '',
				txt: <>
					<span className={cls}>{STATUS_GLYPH[s]}</span>{' '}
					<span>{a.name.padEnd(28)}</span>{' '}
					<span className={cls}>{STATUS_LABEL[s]}</span>
					{err && <span className="err"> — {err}</span>}
					{' '}<span className="dim">{dt}</span>
				</>,
			});
		}
		if (state.shutdown.active) {
			out.push({ cls: 'mute', txt: sep });
			out.push({ cls: '', txt: <><span className="b">shutdown</span> <span className="dim">({state.shutdown.hooks.size} hooks)</span></> });
			for (const h of state.shutdown.hooks.values()) {
				if (h.status === 'pending') continue;
				if (h.status === 'running') {
					out.push({ cls: '', txt: <>{'  '}<span className="acc">→</span> {h.label} <span className="dim">stopping…</span></> });
				} else if (h.status === 'done') {
					const dur = (h.settledAtMs || Date.now()) - h.startedAtMs;
					out.push({ cls: '', txt: <>{'  '}<span className="ok">✓</span> {h.label} <span className="dim">({fmtMs(dur)})</span></> });
				} else {
					const dur = (h.settledAtMs || Date.now()) - h.startedAtMs;
					out.push({ cls: '', txt: <>{'  '}<span className="err">✗</span> {h.label} <span className="dim">({fmtMs(dur)})</span> <span className="err">— {h.detail}</span></> });
				}
			}
			if (state.shutdown.summary) {
				const sm = state.shutdown.summary;
				out.push({
					cls: '', txt: sm.failed === 0
						? <span className="ok">shutdown complete <span className="dim">— {sm.completed}/{sm.completed} ok in {fmtMs(sm.durationMs)}</span></span>
						: <span className="warn">shutdown complete (with errors) <span className="dim">— {sm.completed}/{sm.completed + sm.failed} ok in {fmtMs(sm.durationMs)}, {sm.failed} failed</span></span>,
				});
			}
		}
		return out;
	}, [state]);

	return (
		<div className="plain" style={{ height: '100%' }}>
			<pre style={{ fontFamily: 'inherit' }}>
				{lines.map((l, i) => <div key={i} className={l.cls}>{l.txt}</div>)}
				<div className="dim"><span className="mute cursor">▌</span></div>
			</pre>
		</div>
	);
}

function App() {
	const store = useMemo(() => createSimStore(), []);
	const state = useStore(store);
	const [tweaks, setTweak] = useTweaks(TWEAK_DEFAULTS);

	useEffect(() => {
		store.actions.start();
	}, [store]);

	// Apply theme/density/border attrs on root
	useEffect(() => {
		document.documentElement.setAttribute('data-theme', tweaks.theme);
		document.documentElement.setAttribute('data-density', tweaks.density);
		document.documentElement.setAttribute('data-borders', tweaks.borders);
		document.body.style.fontFamily = `${JSON.stringify(tweaks.font)}, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`;
	}, [tweaks.theme, tweaks.density, tweaks.borders, tweaks.font]);

	// Keyboard
	useEffect(() => {
		const onKey = (e) => {
			if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
			if (e.key === 'Tab') {
				e.preventDefault();
				store.actions.cycleTab(e.shiftKey ? -1 : 1);
				return;
			}
			if (e.key >= '1' && e.key <= '9') {
				const tabs = computeTabs(store.get());
				const i = Number(e.key) - 1;
				if (tabs[i]) store.actions.selectTab(tabs[i]);
				return;
			}
			const k = e.key.toLowerCase();
			if (k === 'r') {
				if (store.get().shutdown.summary) store.actions.reset();
				else store.actions.retryFailed();
			}
			else if (k === 'l') store.actions.toggleVerbose();
			else if (k === 's') store.actions.markStale();
			else if (k === 'f') {
				const running = state.actions.find((a) => store.get().statuses.get(a.name) === 'running')
					|| state.actions.find((a) => store.get().statuses.get(a.name) === 'queued');
				if (running) store.actions.triggerFailure(running.name);
			}
			else if (k === 'e') setTweak('showEndpoints', !store.get().shutdown.active && !state.actions ? true : !tweaks.showEndpoints);
			else if (k === 'q' || (e.ctrlKey && k === 'c')) store.actions.beginShutdown();
			else if (k === 'p') store.actions.togglePause();
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [store, state.actions]);

	const inner = (
		<div className="term">
			<Header state={state} />
			{!state.shutdown.active
				? <StatusTable state={state} groupBy={tweaks.groupBy} />
				: <ShutdownPanel state={state} />}
			<TabStrip state={state} store={store} groupBy={tweaks.groupBy} />
			<LogPane state={state} groupBy={tweaks.groupBy} />
			<Footer state={state} />
		</div>
	);

	const body = tweaks.mode === 'plain'
		? <PlainPreview store={store} />
		: tweaks.showWindowChrome
			? <WindowChrome title={`devstack up — ${state.appName}`}>{inner}</WindowChrome>
			: inner;

	return (
		<>
			{body}
			<TweaksPanel title="Tweaks">
				<TweakSection label="Theme" />
				<TweakSelect
					label="Palette"
					value={tweaks.theme}
					options={[
						{ value: 'modern', label: 'Modern dark' },
						{ value: 'solarized', label: 'Solarized dark' },
						{ value: 'gruvbox', label: 'Gruvbox dark' },
						{ value: 'crt', label: 'CRT green' },
						{ value: 'mono', label: 'Monochrome' },
					]}
					onChange={(v) => setTweak('theme', v)}
				/>
				<TweakSelect
					label="Mono font"
					value={tweaks.font}
					options={[
						{ value: 'JetBrains Mono', label: 'JetBrains Mono' },
						{ value: 'IBM Plex Mono', label: 'IBM Plex Mono' },
						{ value: 'Menlo', label: 'Menlo / system' },
						{ value: 'ui-monospace', label: 'UI monospace' },
					]}
					onChange={(v) => setTweak('font', v)}
				/>
				<TweakSelect
					label="Group by"
					value={tweaks.groupBy}
					options={[
						{ value: 'flat', label: 'No grouping' },
						{ value: 'scope', label: 'Plugin / scope' },
						{ value: 'type', label: 'Action type' },
						{ value: 'status', label: 'Status' },
						{ value: 'name', label: 'Name prefix' },
					]}
					onChange={(v) => setTweak('groupBy', v)}
				/>
				<TweakSection label="Layout" />
				<TweakRadio
					label="Density"
					value={tweaks.density}
					options={['compact', 'balanced', 'spacious']}
					onChange={(v) => setTweak('density', v)}
				/>
				<TweakRadio
					label="Borders"
					value={tweaks.borders}
					options={['none', 'single', 'rounded', 'heavy']}
					onChange={(v) => setTweak('borders', v)}
				/>
				<TweakToggle
					label="Endpoints panel"
					value={tweaks.showEndpoints}
					onChange={(v) => setTweak('showEndpoints', v)}
				/>
				<TweakToggle
					label="Window chrome"
					value={tweaks.showWindowChrome}
					onChange={(v) => setTweak('showWindowChrome', v)}
				/>
				<TweakSection label="Renderer" />
				<TweakRadio
					label="Mode"
					value={tweaks.mode}
					options={['tui', 'plain']}
					onChange={(v) => setTweak('mode', v)}
				/>
				<TweakSection label="Simulation" />
					<TweakButton label="Trigger failure" onClick={() => {
						const cands = state.actions.filter((a) => {
							const s = store.get().statuses.get(a.name);
							return s === 'running' || s === 'queued' || s === 'idle';
						});
						const pick = cands[Math.floor(Math.random() * cands.length)];
						if (pick) store.actions.triggerFailure(pick.name);
					}} />
					<TweakButton label="Mark random stale" onClick={() => store.actions.markStale()} />
					<TweakButton label="Retry failed" onClick={() => store.actions.retryFailed()} />
					<TweakButton label="Begin shutdown" onClick={() => store.actions.beginShutdown()} />
					<TweakButton label="Restart cycle" onClick={() => store.actions.reset()} />
			</TweaksPanel>
		</>
	);
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
