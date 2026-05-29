// TUI components — Header, StatusTable, TabStrip, LogPane, Footer, ShutdownPanel.
// Drives off the simulation store via useSyncExternalStore.

const { useEffect, useMemo, useRef, useState, useSyncExternalStore } = React;

function useStore(store) {
	useSyncExternalStore(store.subscribe, () => store.get().__v || 0, () => 0);
	return store.get();
}

// Color palette per scope — used for log scope tags AND status-table section headers.
const SCOPE_COLORS = {
	sui:       '#6cb6ff',  // blue
	walrus:    '#b083f0',  // magenta
	seal:      '#daaa3f',  // amber
	contracts: '#57ab5a',  // green
	frontend:  '#e08aff',  // pink
	wallet:    '#5fb3a1',  // teal
	devstack:  '#daaa3f',  // amber
	supervisor: '#b083f0',
};

function fmtMs(ms) {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	const m = Math.floor(ms / 60000);
	const s = Math.round((ms % 60000) / 1000);
	return `${m}m${String(s).padStart(2, '0')}s`;
}

function useTick(intervalMs = 250) {
	const [, set] = useState(0);
	useEffect(() => {
		const id = setInterval(() => set((n) => n + 1), intervalMs);
		return () => clearInterval(id);
	}, [intervalMs]);
}

function Spinner({ frames }) {
	const F = frames || ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
	const [i, setI] = useState(0);
	useEffect(() => {
		const id = setInterval(() => setI((x) => (x + 1) % F.length), 80);
		return () => clearInterval(id);
	}, []);
	return <span className="acc">{F[i]}</span>;
}

function StatusGlyph({ status }) {
	const cls = {
		idle: 'mute', queued: 'mute', running: 'acc', healthy: 'ok',
		failed: 'err', skipped: 'mute', stale: 'warn', dirty: 'warn',
	}[status];
	if (status === 'running') return <Spinner />;
	return <span className={cls}>{STATUS_GLYPH[status]}</span>;
}

function Header({ state }) {
	useTick(1000);
	const uptime = Date.now() - state.startedAtMs;
	const counts = useMemo(() => {
		const c = { healthy: 0, running: 0, queued: 0, failed: 0, total: state.actions.length };
		for (const [, s] of state.statuses) {
			if (c[s] !== undefined) c[s]++;
		}
		return c;
	}, [state.statuses, state.actions]);
	return (
		<div className="header">
			<span className="hbadge"><span className="b">devstack up</span></span>
			<span className="dim">{state.appName} <span className="hsep">·</span> {state.stack} <span className="hsep">·</span> {state.network}</span>
			{state.rpcUrl && <span><span className="dim">rpc </span><span className="acc">{state.rpcUrl}</span></span>}
			<span style={{ marginLeft: 'auto' }} className="dim">
				<span className="ok">{counts.healthy}</span>
				<span className="hsep">/</span>
				<span>{counts.total}</span>
				<span className="dim"> healthy</span>
				{counts.running > 0 && <> <span className="hsep">·</span> <span className="acc">{counts.running}</span> running</>}
				{counts.failed > 0 && <> <span className="hsep">·</span> <span className="err">{counts.failed}</span> failed</>}
				<span className="hsep"> · </span>
				<span>uptime {fmtMs(uptime)}</span>
			</span>
		</div>
	);
}

function StatusTable({ state, groupBy = 'flat' }) {
	useTick(250);
	const now = Date.now();

	const groups = useMemo(() => {
		if (groupBy === 'flat') return [{ key: '', label: '', actions: state.actions }];
		const keyOf = (a) => {
			if (groupBy === 'scope') return a.scope || 'misc';
			if (groupBy === 'type') return a.type;
			if (groupBy === 'status') return state.statuses.get(a.name) || 'idle';
			if (groupBy === 'name') {
				const seg = a.name.split(/[:\-]/)[0];
				return seg || a.name;
			}
			return '';
		};
		const order = [];
		const map = new Map();
		for (const a of state.actions) {
			const k = keyOf(a);
			if (!map.has(k)) { map.set(k, []); order.push(k); }
			map.get(k).push(a);
		}
		// For status grouping, prefer a stable order by severity
		if (groupBy === 'status') {
			const rank = { running: 0, queued: 1, healthy: 2, stale: 3, dirty: 4, failed: 5, skipped: 6, idle: 7 };
			order.sort((a, b) => (rank[a] ?? 99) - (rank[b] ?? 99));
		}
		return order.map((k) => ({ key: k, label: k, actions: map.get(k) }));
	}, [state.actions, state.statuses, groupBy]);

	const renderRow = (a) => {
		const status = state.statuses.get(a.name) || 'idle';
		const start = state.startTimes.get(a.name);
		const settle = state.settleTimes.get(a.name);
		let dt = '';
		if (status === 'running' && start) dt = '+' + fmtMs(now - start);
		else if (settle && start) dt = fmtMs(settle - start);
		else if (status === 'queued') dt = 'queued';
		const err = state.failures.get(a.name);
		const detail = err
			? <span className="err">— {err}</span>
			: status === 'idle'
				? <span className="dim">waiting on {a.needs.join(', ') || '—'}</span>
				: status === 'queued'
					? <span className="dim">deps satisfied · scheduling</span>
					: status === 'skipped'
						? <span className="dim">— skipped (upstream failed)</span>
						: status === 'stale'
							? <span className="warn">— inputs changed</span>
							: status === 'healthy' && a.endpoints && a.endpoints.length > 0
								? <span className="row-endpoints">
									{a.endpoints.map((ep, i) => (
										<React.Fragment key={i}>
											{i > 0 && <span className="mute"> · </span>}
											<span className="dim">{ep.label}</span>{' '}
											<a className="row-url" href={ep.url} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>{ep.url}</a>
										</React.Fragment>
									))}
								</span>
								: <span className="dim">{a.type.toLowerCase()} <span className="mute">·</span> needs: {a.needs.join(', ') || '—'}</span>;
		return (
			<div key={a.name} className={`status-row row-${status}`}>
				<span className="glyph"><StatusGlyph status={status} /></span>
				<span className={`nm ${status === 'idle' ? 'dep-pending' : ''}`}>
					<span className="dim" style={{ marginRight: 6 }}>{TYPE_GLYPH[a.type] || '·'}</span>
					{a.name}
				</span>
				<span className={
					status === 'healthy' ? 'ok' :
					status === 'failed' ? 'err' :
					status === 'running' ? 'acc' :
					status === 'stale' || status === 'dirty' ? 'warn' : 'dim'
				}>{STATUS_LABEL[status]}</span>
				<span className="dim" style={{ fontVariantNumeric: 'tabular-nums' }}>{dt}</span>
				<span className="detail">{detail}</span>
			</div>
		);
	};

	return (
		<>
			<div className="section-title dim">
				actions
				{groupBy !== 'flat' && <span className="mute" style={{ marginLeft: 8 }}>· grouped by {groupBy}</span>}
			</div>
			<div className="status-table">
				{groups.map((g) => {
					const counts = { healthy: 0, running: 0, failed: 0, total: g.actions.length };
					for (const a of g.actions) {
						const s = state.statuses.get(a.name);
						if (counts[s] !== undefined) counts[s]++;
					}
					return (
						<div key={g.key || 'flat'} className="status-group">
							{groupBy !== 'flat' && (
								<div className="group-header">
									<span className="group-label" style={{ color: SCOPE_COLORS[g.label] || 'var(--magenta)' }}>{g.label}</span>
									<span className="group-rule" style={{ borderColor: (SCOPE_COLORS[g.label] || 'var(--border-soft)') + '33' }} />
									<span className="group-counts dim">
										<span className="ok">{counts.healthy}</span>
										<span className="mute">/</span>
										<span>{counts.total}</span>
										{counts.running > 0 && <> <span className="mute">·</span> <span className="acc">{counts.running} running</span></>}
										{counts.failed > 0 && <> <span className="mute">·</span> <span className="err">{counts.failed} failed</span></>}
									</span>
								</div>
							)}
							{g.actions.map(renderRow)}
						</div>
					);
				})}
			</div>
		</>
	);
}

function TabStrip({ state, store }) {
	const tabs = ['all', 'supervisor'];
	return (
		<div className="tabstrip">
			{tabs.map((t, idx) => {
				const unread = state.unread.get(t) || 0;
				const isSel = state.selectedTab === t;
				return (
					<div key={t}
						className={`tab ${isSel ? 'active' : ''}`}
						onClick={() => store.actions.selectTab(t)}>
						<span className="dim" style={{ marginRight: 6 }}>{idx + 1}</span>
						<span>{t}</span>
						{!isSel && unread > 0 && <span className="unread">●</span>}
					</div>
				);
			})}
		</div>
	);
}

function membersOfGroup(state, groupBy, key) {
	if (groupBy === 'flat') return [];
	const keyOf = (a) => {
		if (groupBy === 'scope') return a.scope || 'misc';
		if (groupBy === 'type') return a.type;
		if (groupBy === 'status') return state.statuses.get(a.name) || 'idle';
		if (groupBy === 'name') return a.name.split(/[:\-]/)[0] || a.name;
		return '';
	};
	return state.actions.filter((a) => keyOf(a) === key).map((a) => a.name);
}

function scopeFor(state, src) {
	if (src === 'supervisor') return 'supervisor';
	const a = state.actions.find((x) => x.name === src);
	return a?.scope || 'misc';
}

function LogPane({ state, height }) {
	const ref = useRef(null);
	const t = state.selectedTab;
	const lines = t === 'supervisor'
		? (state.logs.get('supervisor') || [])
		: state.allLogs;
	useEffect(() => {
		if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
	}, [lines.length, state.selectedTab]);

	return (
		<div className="log-pane grow" style={{ height }} ref={ref}>
			{lines.length === 0 && (
				<div className="dim" style={{ padding: '8px 0' }}>
					<span className="mute">no output yet</span><span className="cursor mute"> ▌</span>
				</div>
			)}
			{lines.map((l) => {
				const scope = scopeFor(state, l.src);
				const color = SCOPE_COLORS[scope] || 'var(--accent)';
				return (
					<div key={l.idx} className={`log-line ${l.level || ''}`}>
						<span className="ts">[{l.ts}]</span>
						<span className="scope-tag" style={{ color, borderColor: color + '55' }}>{scope}</span>
						<span className="src" style={{ color }}>{l.src}</span>
						<span className="msg">{l.msg}</span>
					</div>
				);
			})}
		</div>
	);
}

function Footer({ state }) {
	const k = (key, lbl) => (
		<span className="kbd"><span className="key">{key}</span><span className="dim">{lbl}</span></span>
	);
	return (
		<div className="footer">
			{k('Tab', 'streams')}
			{k('1-9', 'jump')}
			{k('r', 'retry')}
			{k('l', 'logs')}
			{k('s', 'stale')}
			{k('f', 'fail')}
			{k('q', 'quit')}
			<span style={{ marginLeft: 'auto' }} className="dim">
				{state.verbose ? <span className="acc">verbose</span> : 'logs: normal'}
				<span className="hsep"> · </span>
				{state.paused ? <span className="warn">paused</span> : 'live'}
			</span>
		</div>
	);
}

function ShutdownPanel({ state }) {
	useTick(150);
	const now = Date.now();
	const hooks = [...state.shutdown.hooks.values()];
	const total = hooks.length;
	const done = hooks.filter((h) => h.status === 'done').length;
	const failed = hooks.filter((h) => h.status === 'failed').length;
	const elapsed = now - state.shutdown.startedAtMs;
	return (
		<>
			<div className="section-title warn">shutdown</div>
			<div className="shutdown-panel">
				<div className="shutdown-title">
					<span>{state.shutdown.summary
						? (state.shutdown.summary.failed === 0
							? <span className="ok">✓ shutdown complete</span>
							: <span className="warn">⚠ shutdown complete (with errors)</span>)
						: <><Spinner /> shutting down — {total} hook{total === 1 ? '' : 's'}</>}</span>
					<span className="dim">{done}/{total} ok{failed ? `, ${failed} failed` : ''} <span className="mute">·</span> {fmtMs(state.shutdown.summary?.durationMs ?? elapsed)}</span>
				</div>
				{hooks.map((h) => {
					const dur = h.startedAtMs ? (h.settledAtMs || now) - h.startedAtMs : 0;
					return (
						<div key={h.label} className="shutdown-row">
							<span className="glyph">
								{h.status === 'pending' && <span className="mute">·</span>}
								{h.status === 'running' && <Spinner />}
								{h.status === 'done' && <span className="ok">✓</span>}
								{h.status === 'failed' && <span className="err">✗</span>}
							</span>
							<span className={h.status === 'failed' ? 'err' : ''}>{h.label}</span>
							<span className="dim" style={{ fontVariantNumeric: 'tabular-nums' }}>
								{h.status === 'pending' ? 'pending' : fmtMs(dur)}
							</span>
							<span className="detail">
								{h.status === 'running' && <span className="dim">stopping…</span>}
								{h.status === 'failed' && h.detail && <span className="err">— {h.detail}</span>}
								{h.status === 'done' && <span className="dim">— exited cleanly</span>}
								{h.status === 'pending' && <span className="mute">— queued</span>}
							</span>
						</div>
					);
				})}
				{state.shutdown.summary && (
					<div className="shutdown-summary dim">
						{state.shutdown.summary.failed === 0
							? <span className="ok">all hooks settled in {fmtMs(state.shutdown.summary.durationMs)}</span>
							: <span className="warn">{state.shutdown.summary.completed}/{total} ok in {fmtMs(state.shutdown.summary.durationMs)}, {state.shutdown.summary.failed} failed</span>}
						<span className="hsep"> · </span>
						<span>press <span className="kbd"><span className="key">r</span></span> to restart</span>
					</div>
				)}
			</div>
		</>
	);
}

window.useStore = useStore;
window.useTick = useTick;
window.Header = Header;
window.StatusTable = StatusTable;
window.TabStrip = TabStrip;
window.LogPane = LogPane;
window.membersOfGroup = membersOfGroup;
window.Footer = Footer;
window.ShutdownPanel = ShutdownPanel;
window.Spinner = Spinner;
window.fmtMs = fmtMs;

