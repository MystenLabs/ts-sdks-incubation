// Fake supervisor — emits state transitions, log lines, and shutdown events
// to drive the TUI. Mimics devstack's reconciler shape: actions with deps,
// statuses, failures, per-action log streams, and a shutdown lifecycle.

// scope = which plugin / surface owns this action. Mirrors the layout of
// packages/devstack/src/plugins/* in the brief.
const ACTION_DEFS = [
	{ name: 'sui-localnet',        scope: 'sui',       type: 'Service',     needs: [],                              durMs: 4200,
		endpoints: [
			{ label: 'JSON-RPC', url: 'http://127.0.0.1:9000', kind: 'rpc' },
			{ label: 'WebSocket', url: 'ws://127.0.0.1:9000', kind: 'ws' },
			{ label: 'Faucet', url: 'http://127.0.0.1:9123/gas', kind: 'http' },
		], logs: [
		'starting sui-localnet (faucet=true, gas-budget=10000000000)',
		'binding rpc on 127.0.0.1:9000',
		'binding faucet on 127.0.0.1:9123',
		'genesis: 4 validators, epoch 0',
		'rpc ready · ws ready · faucet ready',
	]},
	{ name: 'walrus-aggregator',   scope: 'walrus',    type: 'Service',     needs: ['sui-localnet'],                durMs: 2600,
		endpoints: [{ label: 'Aggregator', url: 'http://127.0.0.1:31415', kind: 'http' }], logs: [
		'starting walrus aggregator on :31415',
		'connected to sui rpc',
		'aggregator healthy',
	]},
	{ name: 'walrus-publisher',    scope: 'walrus',    type: 'Service',     needs: ['sui-localnet'],                durMs: 2400,
		endpoints: [{ label: 'Publisher', url: 'http://127.0.0.1:31416', kind: 'http' }], logs: [
		'starting walrus publisher on :31416',
		'publisher healthy',
	]},
	{ name: 'seal-key-server',     scope: 'seal',      type: 'Service',     needs: ['sui-localnet'],                durMs: 1800,
		endpoints: [{ label: 'Key server', url: 'http://127.0.0.1:2024', kind: 'http' }], logs: [
		'starting seal key-server on :2024',
		'loaded 1 key set · ready',
	]},
	{ name: 'build:contracts',     scope: 'contracts', type: 'Build',       needs: [],                              durMs: 5400, logs: [
		'sui move build --path ./packages/contracts',
		'  Compiling contracts v0.1.0',
		'  Compiling sui-framework dep',
		'  Compiling move-stdlib dep',
		'build complete · 1 package · 0 warnings',
	]},
	{ name: 'publish:contracts',   scope: 'contracts', type: 'Publish',     needs: ['sui-localnet', 'build:contracts'], durMs: 3200, logs: [
		'publishing 1 module to localnet',
		'  → tx digest 9xK2…d4Ff',
		'  → package 0xa3…c81e',
		'wrote address to manifest',
	]},
	{ name: 'register:walrus',     scope: 'walrus',    type: 'Register',    needs: ['walrus-aggregator', 'walrus-publisher'], durMs: 900, logs: [
		'registered walrus endpoints in manifest',
	]},
	{ name: 'seed:accounts',       scope: 'contracts', type: 'Seed',        needs: ['publish:contracts'],           durMs: 1700, logs: [
		'creating 4 accounts · funding from faucet',
		'  alice  0xc1…7a3f  10 SUI',
		'  bob    0x4d…ee01  10 SUI',
		'  carol  0x91…3b22  10 SUI',
		'  dave   0xfa…5510  10 SUI',
	]},
	{ name: 'codegen:typescript',  scope: 'frontend',  type: 'Emit',        needs: ['publish:contracts'],           durMs: 1400, logs: [
		'generating typed bindings → packages/sdk/src/gen',
		'wrote 12 modules · 47 types',
	]},
	{ name: 'wallet-server',       scope: 'wallet',    type: 'HostProcess', needs: ['seed:accounts'],               durMs: 2100,
		endpoints: [{ label: 'Wallet API', url: 'http://127.0.0.1:5170', kind: 'http' }], logs: [
		'spawning wallet-server (node ./scripts/wallet-server.mjs)',
		'listening on http://127.0.0.1:5170',
	]},
	{ name: 'frontend',            scope: 'frontend',  type: 'HostProcess', needs: ['codegen:typescript', 'wallet-server'], durMs: 2800,
		endpoints: [{ label: 'Vite dev', url: 'http://localhost:5173', kind: 'web' }], logs: [
		'spawning vite dev server',
		'  vite v5.4.0 ready in 642 ms',
		'  ➜  Local:   http://localhost:5173/',
		'  ➜  Network: use --host to expose',
	]},
	{ name: 'verify:health',       scope: 'devstack',  type: 'Verify',      needs: ['frontend', 'wallet-server', 'walrus-publisher', 'seal-key-server'], durMs: 1200, logs: [
		'probing 4 endpoints',
		'  ✓ http://localhost:5173 (200)',
		'  ✓ http://127.0.0.1:5170/health (200)',
		'  ✓ http://127.0.0.1:31416/health (200)',
		'  ✓ http://127.0.0.1:2024/health (200)',
		'all endpoints healthy',
	]},
];

const TYPE_GLYPH = {
	Service: '◆', Build: '⌬', Publish: '↗', Register: '⊞',
	Seed: '✱', Emit: '→', Verify: '✓', HostProcess: '⚙',
};

const STATUS_GLYPH = {
	idle: '·', queued: '·', running: '⟳', healthy: '✓',
	failed: '✗', skipped: '–', stale: '⟲', dirty: '◌',
};

const STATUS_LABEL = {
	idle: 'idle', queued: 'queued', running: 'running', healthy: 'healthy',
	failed: 'failed', skipped: 'skipped', stale: 'stale', dirty: 'dirty',
};

// Pub/sub store mirroring the InkRenderer design from the brief
function createSimStore() {
	const listeners = new Set();
	const state = {
		appName: 'wallet-demo',
		stack: 'sui+walrus+seal',
		network: 'localnet',
		rpcUrl: undefined,
		startedAtMs: Date.now(),
		actions: ACTION_DEFS.map((a) => ({ name: a.name, scope: a.scope, type: a.type, needs: a.needs, endpoints: a.endpoints || [] })),
		statuses: new Map(ACTION_DEFS.map((a) => [a.name, 'idle'])),
		startTimes: new Map(),
		settleTimes: new Map(),
		failures: new Map(),
		logs: new Map(),       // name -> [{ ts, src, msg, level }]
		allLogs: [],           // merged
		unread: new Map(),     // tab -> count
		selectedTab: 'all',
		verbose: false,
		shutdown: { active: false, startedAtMs: 0, hooks: new Map(), summary: null, finishedAtMs: 0 },
		paused: false,
		autoFail: null,        // name to fail
	};
	for (const a of ACTION_DEFS) {
		state.logs.set(a.name, []);
		state.unread.set(a.name, 0);
	}
	state.logs.set('supervisor', []);
	state.unread.set('supervisor', 0);
	state.unread.set('all', 0);

	const notify = () => { state.__v = (state.__v || 0) + 1; listeners.forEach((l) => l()); };
	const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
	const get = () => state;

	const ts = () => {
		const d = new Date();
		const pad = (n, l = 2) => String(n).padStart(l, '0');
		return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
	};

	const appendLog = (src, msg, level = 'info') => {
		const line = { ts: ts(), src, msg, level, idx: state.allLogs.length };
		const arr = state.logs.get(src) || [];
		arr.push(line);
		if (arr.length > 500) arr.shift();
		state.logs.set(src, arr);
		state.allLogs.push(line);
		if (state.allLogs.length > 500) state.allLogs.shift();
		if (state.selectedTab !== 'all') state.unread.set('all', (state.unread.get('all') || 0) + 1);
		if (state.selectedTab !== src) state.unread.set(src, (state.unread.get(src) || 0) + 1);
		notify();
	};

	const setStatus = (name, status, error) => {
		if (state.statuses.get(name) === status) return;
		state.statuses.set(name, status);
		if (status === 'running') state.startTimes.set(name, Date.now());
		if (status === 'healthy' || status === 'failed' || status === 'skipped') {
			state.settleTimes.set(name, Date.now());
		}
		if (error) state.failures.set(name, error);
		notify();
	};

	const selectTab = (t) => {
		state.selectedTab = t;
		state.unread.set(t, 0);
		notify();
	};

	const cycleTab = (dir) => {
		const tabs = computeTabs(state);
		const i = tabs.indexOf(state.selectedTab);
		const next = tabs[(i + dir + tabs.length) % tabs.length];
		selectTab(next);
	};

	// --- runtime -----------------------------------------------------------
	let running = true;
	const timers = new Set();
	const setTimer = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; };
	const clearTimers = () => { timers.forEach((id) => clearTimeout(id)); timers.clear(); };

	const allDepsHealthy = (a) => a.needs.every((d) => state.statuses.get(d) === 'healthy');
	const anyDepFailed = (a) => a.needs.some((d) => state.statuses.get(d) === 'failed' || state.statuses.get(d) === 'skipped');

	const tick = () => {
		if (!running || state.paused || state.shutdown.active) return;
		// Mark queued for any idle action whose deps are all healthy
		for (const a of ACTION_DEFS) {
			const s = state.statuses.get(a.name);
			if (s === 'idle' && a.needs.length > 0 && a.needs.every((d) => ['healthy','running','queued'].includes(state.statuses.get(d)))) {
				if (allDepsHealthy(a)) setStatus(a.name, 'queued');
			}
			if (s === 'idle' && anyDepFailed(a)) setStatus(a.name, 'skipped');
		}
		// Promote queued -> running (parallel where deps satisfied)
		for (const a of ACTION_DEFS) {
			if (state.statuses.get(a.name) === 'queued' && allDepsHealthy(a)) {
				kickoff(a);
			}
		}
		setTimer(tick, 250);
	};

	const kickoff = (a) => {
		setStatus(a.name, 'running');
		appendLog(a.name, `${TYPE_GLYPH[a.type] || '·'} starting ${a.type.toLowerCase()}`, 'info');
		// Stream logs spaced through the duration
		const lines = a.logs;
		const spacing = a.durMs / (lines.length + 1);
		lines.forEach((line, i) => {
			setTimer(() => {
				if (state.shutdown.active) return;
				const lvl = /error|fail/i.test(line) ? 'err' : (/warn/i.test(line) ? 'warn' : 'info');
				appendLog(a.name, line, lvl);
			}, spacing * (i + 1));
		});
		setTimer(() => {
			if (state.shutdown.active) return;
			if (state.autoFail === a.name) {
				const err = new Error('connection refused — port already in use');
				appendLog(a.name, `error: ${err.message}`, 'err');
				setStatus(a.name, 'failed', err.message);
				state.autoFail = null;
				// cascade: dependents become skipped
				return;
			}
			appendLog(a.name, `ready in ${(a.durMs/1000).toFixed(1)}s`, 'ok');
			setStatus(a.name, 'healthy');
			// Side-effects on specific actions
			if (a.name === 'sui-localnet') {
				state.rpcUrl = 'http://127.0.0.1:9000';
				appendLog('supervisor', `rpc → http://127.0.0.1:9000`, 'info');
				notify();
			}
		}, a.durMs);
	};

	const start = () => {
		state.startedAtMs = Date.now();
		appendLog('supervisor', 'devstack up — starting reconciler', 'info');
		appendLog('supervisor', `${ACTION_DEFS.length} actions resolved · 4 levels of dependency`, 'dim');
		// Seed roots as queued
		for (const a of ACTION_DEFS) {
			if (a.needs.length === 0) setStatus(a.name, 'queued');
		}
		setTimer(tick, 100);
	};

	const retryFailed = () => {
		let n = 0;
		for (const [name, status] of state.statuses) {
			if (status === 'failed' || status === 'skipped') {
				state.failures.delete(name);
				const def = ACTION_DEFS.find((a) => a.name === name);
				if (!def) continue;
				if (def.needs.every((d) => state.statuses.get(d) === 'healthy')) {
					setStatus(name, 'queued');
					n++;
				} else {
					setStatus(name, 'idle');
					n++;
				}
			}
		}
		if (n > 0) appendLog('supervisor', `retrying ${n} action${n === 1 ? '' : 's'}`, 'warn');
	};

	const triggerFailure = (name) => {
		const status = state.statuses.get(name);
		if (status === 'idle' || status === 'queued') {
			state.autoFail = name;
			appendLog('supervisor', `next run of ${name} will fail (simulated)`, 'warn');
		} else if (status === 'running') {
			state.autoFail = name;
			appendLog('supervisor', `${name} will fail at next checkpoint`, 'warn');
		} else if (status === 'healthy') {
			setStatus(name, 'failed', 'simulated failure');
			appendLog(name, 'error: simulated failure injected', 'err');
		}
	};

	const markStale = () => {
		const healthy = ACTION_DEFS.filter((a) => state.statuses.get(a.name) === 'healthy');
		const pick = healthy[Math.floor(Math.random() * healthy.length)];
		if (pick) {
			setStatus(pick.name, 'stale');
			appendLog(pick.name, 'inputs changed — marked stale', 'warn');
		}
	};

	const beginShutdown = () => {
		if (state.shutdown.active) return;
		// Build hooks from healthy services / host processes
		const hookActions = ACTION_DEFS.filter((a) =>
			(a.type === 'Service' || a.type === 'HostProcess') && state.statuses.get(a.name) === 'healthy',
		);
		const hooks = new Map();
		hookActions.forEach((a) => {
			hooks.set(a.name, { label: a.name, status: 'pending', startedAtMs: 0, settledAtMs: 0 });
		});
		state.shutdown = { active: true, startedAtMs: Date.now(), hooks, summary: null, finishedAtMs: 0 };
		appendLog('supervisor', `shutdown — ${hooks.size} hook${hooks.size === 1 ? '' : 's'}`, 'warn');
		notify();
		// Run hooks in parallel with staggered durations
		const entries = [...hooks.entries()];
		let completed = 0, failed = 0;
		entries.forEach(([label, _], i) => {
			setTimer(() => {
				const h = state.shutdown.hooks.get(label);
				if (!h) return;
				h.status = 'running';
				h.startedAtMs = Date.now();
				appendLog('supervisor', `→ ${label} stopping…`, 'dim');
				notify();
				const dur = 400 + Math.random() * 1400;
				setTimer(() => {
					const willFail = label === 'wallet-server' && Math.random() < 0.3;
					h.status = willFail ? 'failed' : 'done';
					h.settledAtMs = Date.now();
					if (willFail) { failed++; h.detail = 'process did not exit within 1s — sigkilled'; }
					else { completed++; }
					notify();
					if (completed + failed === entries.length) {
						setTimer(() => {
							state.shutdown.summary = {
								completed, failed,
								durationMs: Date.now() - state.shutdown.startedAtMs,
							};
							state.shutdown.finishedAtMs = Date.now();
							appendLog('supervisor', `shutdown complete — ${completed}/${entries.length} ok${failed ? `, ${failed} failed` : ''}`, failed ? 'warn' : 'ok');
							notify();
						}, 250);
					}
				}, dur);
			}, i * 180);
		});
	};

	const reset = () => {
		clearTimers();
		state.startedAtMs = Date.now();
		state.rpcUrl = undefined;
		state.statuses = new Map(ACTION_DEFS.map((a) => [a.name, 'idle']));
		state.startTimes.clear();
		state.settleTimes.clear();
		state.failures.clear();
		for (const a of ACTION_DEFS) state.logs.set(a.name, []);
		state.logs.set('supervisor', []);
		state.allLogs = [];
		state.unread = new Map();
		state.shutdown = { active: false, startedAtMs: 0, hooks: new Map(), summary: null, finishedAtMs: 0 };
		state.autoFail = null;
		notify();
		start();
	};

	return {
		subscribe, get, notify,
		actions: { start, retryFailed, triggerFailure, markStale, beginShutdown, reset, selectTab, cycleTab,
			togglePause: () => { state.paused = !state.paused; notify(); if (!state.paused) tick(); },
			toggleVerbose: () => { state.verbose = !state.verbose; notify(); },
		},
	};
}

function computeTabs(state) {
	const tabs = ['all', 'supervisor'];
	for (const a of state.actions) tabs.push(a.name);
	return tabs;
}

window.createSimStore = createSimStore;
window.ACTION_DEFS = ACTION_DEFS;
window.TYPE_GLYPH = TYPE_GLYPH;
window.STATUS_GLYPH = STATUS_GLYPH;
window.STATUS_LABEL = STATUS_LABEL;
window.computeTabs = computeTabs;
