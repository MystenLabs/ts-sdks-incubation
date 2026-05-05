// Plain text renderer. Used when stdout isn't a TTY (CI, redirected
// output, log capture) or when the user opts out via `DEVSTACK_NO_TUI=1`
// / `--no-tui`.
//
// Design goals:
//   - Greppable, line-oriented output.
//   - One line per state transition (not the full table on every cycle).
//   - Self-contained: header at top, shutdown lines clearly marked,
//     final summary so a CI log reader can see "everything came up,
//     ran for X, came down cleanly" without scrolling.
//   - No ANSI when output isn't a color-capable TTY (NO_COLOR honored).

import type { Action, ActionEndpoint, ActionStatus, Network } from '../../core/types.js';
import { type Color, makeStyler, supportsColor } from '../ansi.js';
import type {
	Renderer,
	RendererStartOptions,
	ShutdownSummary,
} from '../renderer.js';
import { buildPluginColorMap } from './plugin-colors.js';

interface PlainRendererOptions {
	stream?: NodeJS.WriteStream;
	/** Force color on/off; defaults to NO_COLOR / isTTY heuristics. */
	color?: boolean;
}

const STATUS_COLOR: Record<ActionStatus, Color> = {
	idle: 'gray',
	queued: 'gray',
	running: 'cyan',
	healthy: 'green',
	failed: 'red',
	skipped: 'gray',
	stale: 'yellow',
	dirty: 'yellow',
};

const STATUS_GLYPH: Record<ActionStatus, string> = {
	idle: '·',
	queued: '·',
	running: '⟳',
	healthy: '✓',
	failed: '✗',
	skipped: '–',
	stale: '⟲',
	dirty: '◌',
};

export class PlainRenderer implements Renderer {
	private readonly stream: NodeJS.WriteStream;
	private readonly style: ReturnType<typeof makeStyler>;
	private readonly statuses = new Map<string, ActionStatus>();
	private readonly failures = new Map<string, string>();
	/** Wall-clock when each action transitioned to `running`. Used to
	 * compute the per-action duration shown when it settles. */
	private readonly startTimes = new Map<string, number>();
	/** Action → owning plugin lookup, for log-line coloring. */
	private readonly pluginByAction = new Map<string, string | undefined>();
	/** Plugin → ANSI color, computed once at start from action order. */
	private pluginColors = new Map<string, Color>();
	/** Last-emitted endpoints per action, JSON-keyed. Lets `setEndpoints`
	 * stay quiet when nothing in a row's URL set changed across cycles. */
	private readonly endpointsByAction = new Map<string, string>();
	private actions: Action[] = [];
	private startedAtMs = 0;
	private rpcUrl: string | undefined;
	private opts: RendererStartOptions | undefined;
	private shutdownInFlight = new Map<string, number>();

	constructor(opts: PlainRendererOptions = {}) {
		this.stream = opts.stream ?? process.stdout;
		this.style = makeStyler(opts.color ?? supportsColor({ stream: this.stream }));
	}

	start(opts: RendererStartOptions): void {
		this.opts = opts;
		this.actions = opts.actions;
		this.startedAtMs = Date.now();
		this.rpcUrl = opts.rpcUrl;
		const pluginOrder: string[] = [];
		const seen = new Set<string>();
		for (const a of opts.actions) {
			this.statuses.set(a.name, 'idle');
			this.pluginByAction.set(a.name, a.plugin);
			if (a.plugin !== undefined && !seen.has(a.plugin)) {
				seen.add(a.plugin);
				pluginOrder.push(a.plugin);
			}
		}
		this.pluginColors = buildPluginColorMap(pluginOrder).ansi;
		this.writeHeader();
	}

	update(statuses: Map<string, ActionStatus>, failures: Map<string, Error>): void {
		for (const [name, s] of statuses) {
			const prev = this.statuses.get(name);
			if (s === 'running') this.startTimes.set(name, Date.now());
			if (prev === s) continue;
			if (!shouldEmitTransition(prev, s)) continue;
			// Only commit the new status to the internal map when we
			// actually print it. That way `prev` for the next call still
			// reflects the last *meaningful* state we showed the user, so
			// a settled→queued→running→settled re-cycle stays quiet for
			// every step (each compares against the prior settled state).
			this.statuses.set(name, s);
			const detail = failures.get(name)?.message;
			this.writeRow(name, s, detail);
		}
		this.failures.clear();
		for (const [name, err] of failures) this.failures.set(name, err.message);
	}

	markStale(names: string[]): void {
		for (const n of names) {
			if (this.statuses.get(n) === 'stale') continue;
			this.statuses.set(n, 'stale');
			this.writeRow(n, 'stale');
		}
	}

	appendLog(actionName: string, line: string): void {
		const ts = new Date().toISOString().slice(11, 19);
		const tag = this.style.gray(`[${ts}]`);
		const plugin = actionName === 'supervisor' ? 'supervisor' : this.pluginByAction.get(actionName);
		const color = this.pluginColors.get(plugin ?? '') ?? 'gray';
		const name = this.style[color](actionName);
		this.stream.write(`${tag} ${name} ${line}\n`);
	}

	setRpcUrl(rpcUrl: string): void {
		if (this.rpcUrl === rpcUrl) return;
		this.rpcUrl = rpcUrl;
		this.stream.write(`${this.style.gray('rpc')} ${rpcUrl}\n`);
	}

	setEndpoints(map: Map<string, ActionEndpoint[]>): void {
		// Emit a one-time `→ <action> <urls>` line per CHANGED entry so a
		// CI log reader sees URLs as they come up, without re-emitting the
		// same set every cycle.
		for (const [name, eps] of map) {
			if (eps.length === 0) continue;
			const key = JSON.stringify(eps);
			if (this.endpointsByAction.get(name) === key) continue;
			this.endpointsByAction.set(name, key);
			const line = eps
				.map((e) => `${this.style.gray(e.label)} ${this.style.cyan(e.url)}`)
				.join(this.style.gray('  '));
			this.stream.write(`${this.style.gray('→')} ${name} ${line}\n`);
		}
	}

	beginShutdown(hooks: Array<{ label: string }>): void {
		this.shutdownInFlight.clear();
		const sep = this.style.gray('─'.repeat(60));
		this.stream.write(`${sep}\n`);
		const head = this.style.bold('shutdown');
		this.stream.write(`${head} ${this.style.gray(`(${hooks.length} hook${hooks.length === 1 ? '' : 's'})`)}\n`);
	}

	progressShutdown(
		label: string,
		status: 'running' | 'done' | 'failed',
		detail?: string,
	): void {
		if (status === 'running') {
			this.shutdownInFlight.set(label, Date.now());
			this.stream.write(`  ${this.style.cyan('→')} ${label} ${this.style.gray('stopping…')}\n`);
			return;
		}
		const startedAt = this.shutdownInFlight.get(label);
		this.shutdownInFlight.delete(label);
		const elapsed = startedAt !== undefined ? Date.now() - startedAt : 0;
		const dur = this.style.gray(`(${formatMs(elapsed)})`);
		if (status === 'done') {
			this.stream.write(`  ${this.style.green('✓')} ${label} ${dur}\n`);
		} else {
			const tail = detail ? ` — ${detail}` : '';
			this.stream.write(`  ${this.style.red('✗')} ${label} ${dur}${this.style.red(tail)}\n`);
		}
	}

	finishShutdown(summary: ShutdownSummary): void {
		const total = summary.completed + summary.failed;
		const dur = formatMs(summary.durationMs);
		const ok = summary.failed === 0;
		const head = ok
			? this.style.green('shutdown complete')
			: this.style.yellow('shutdown complete (with errors)');
		const detail = `${summary.completed}/${total} ok in ${dur}${summary.failed > 0 ? `, ${summary.failed} failed` : ''}`;
		this.stream.write(`${head} ${this.style.gray(`— ${detail}`)}\n`);
	}

	stop(): void {
		// No persistent block to clean up; writeHeader / shutdown lines
		// already left the cursor at column 0. Emit one trailing newline
		// so the next shell prompt has breathing room.
		this.stream.write('\n');
	}

	private writeHeader(): void {
		if (this.opts === undefined) return;
		const sep = this.style.gray('─'.repeat(60));
		this.stream.write(`${sep}\n`);
		const head = this.style.bold(`devstack up`);
		const meta = `${this.opts.appName} · ${this.opts.stack} · ${this.opts.network}`;
		this.stream.write(`${head} ${this.style.gray(meta)}\n`);
		if (this.rpcUrl) {
			this.stream.write(`${this.style.gray('rpc')} ${this.rpcUrl}\n`);
		}
		this.stream.write(`${this.style.gray(`${this.actions.length} action${this.actions.length === 1 ? '' : 's'}`)}\n`);
		this.stream.write(`${sep}\n`);
	}

	private writeRow(name: string, status: ActionStatus, detail?: string): void {
		const glyph = this.style[STATUS_COLOR[status]](STATUS_GLYPH[status]);
		const tag = this.style[STATUS_COLOR[status]](status);
		const tail = detail ? this.style.red(` — ${detail}`) : '';
		const t = this.style.gray(this.formatRowDuration(name, status));
		this.stream.write(`${glyph} ${name.padEnd(28)} ${tag}${tail} ${t}\n`);
	}

	/** Per-row duration string. Mirrors the design's two-form output:
	 *   - `running` → `+<uptime>` (since renderer start), so a CI log
	 *     reader can see how long into the run the transition fired.
	 *   - `healthy` / `failed` / `skipped` → `<duration>` (since the
	 *     row's own `running` transition), so the wall time the action
	 *     took is obvious without subtraction.
	 *   - other transitional states (`stale`, `dirty`) → blank. */
	private formatRowDuration(name: string, status: ActionStatus): string {
		if (status === 'running') return `+${formatMs(Date.now() - this.startedAtMs)}`;
		if (status === 'healthy' || status === 'failed' || status === 'skipped') {
			const start = this.startTimes.get(name);
			if (start === undefined) return '';
			return formatMs(Date.now() - start);
		}
		return '';
	}
}

/** Filter status transitions worth printing in line-oriented mode.
 * Suppress the noise from cycle re-entry (services-grew, file-stale
 * cascades): once an action is settled (`healthy`/`failed`/`skipped`),
 * the next cycle's pre-walk `queued`/`running` flips don't add
 * information — they always converge back to the same settled state
 * within milliseconds. We do still emit:
 *   - any non-running/non-queued status (settled, stale, dirty)
 *   - the first queued/running for a previously-unseen action
 * so cold-cycle topo progress stays visible. */
function shouldEmitTransition(prev: ActionStatus | undefined, next: ActionStatus): boolean {
	if (next === 'queued' || next === 'running') {
		// Only print queued/running if we hadn't already settled. After
		// a healthy/failed/skipped, a re-cycle's transient queued is noise.
		if (prev === 'healthy' || prev === 'failed' || prev === 'skipped') return false;
	}
	return true;
}

// External so renderers and tests share one formatter — no `1.000s` vs
// `1s` drift across surfaces.
export function formatMs(ms: number): string {
	if (ms < 1_000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
	const m = Math.floor(ms / 60_000);
	const s = Math.round((ms % 60_000) / 1_000);
	return `${m}m${s.toString().padStart(2, '0')}s`;
}

// Re-export the action network type so test files can construct
// `Action` objects without re-importing the deep core path.
export type { Network };
