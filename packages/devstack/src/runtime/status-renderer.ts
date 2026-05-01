// Persistent status block + scrolling labeled logs.
//
// Layout: a single block listing every action with a glyph + status word +
// optional failure detail. Logs flow above the block; the block is at the
// bottom, redrawn in place via cursor-up + erase-line on every state
// change or log append. Headless mode (`!stream.isTTY`) falls back to
// printing each state change inline with no in-place redraw.
//
// We do not enter alternate-screen-buffer or take over the full screen —
// the supervisor coexists with the user's normal terminal scrollback.

import type { Action, ActionStatus } from '../core/types.js';

export interface StatusRendererOptions {
	actions: Action[];
	stream?: NodeJS.WriteStream;
	/** Force TTY mode on/off; defaults to `stream.isTTY`. */
	tty?: boolean;
}

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

export class StatusRenderer {
	private readonly stream: NodeJS.WriteStream;
	private readonly tty: boolean;
	private readonly actions: Action[];
	private readonly statuses = new Map<string, ActionStatus>();
	private readonly failures = new Map<string, string>();
	private prevBlockHeight = 0;
	private verbose = false;

	constructor(opts: StatusRendererOptions) {
		this.stream = opts.stream ?? process.stdout;
		this.tty = opts.tty ?? Boolean(this.stream.isTTY);
		this.actions = opts.actions;
		for (const a of opts.actions) this.statuses.set(a.name, 'idle');
	}

	start(appName: string): void {
		const banner = `── devstack up (${appName}) ${'─'.repeat(Math.max(2, 60 - appName.length))}`;
		this.stream.write(`${banner}\n`);
		if (this.tty) this.renderBlock();
	}

	stop(): void {
		// Leave the final block in place; emit a newline so the next prompt
		// doesn't land on the last block line.
		this.stream.write('\n');
	}

	update(statuses: Map<string, ActionStatus>, failures: Map<string, Error>): void {
		for (const [name, s] of statuses) this.statuses.set(name, s);
		this.failures.clear();
		for (const [name, err] of failures) this.failures.set(name, err.message);

		if (this.tty) {
			this.eraseBlock();
			this.renderBlock();
		} else {
			for (const [name, s] of statuses) {
				const detail = this.failures.get(name);
				this.stream.write(`  ${name.padEnd(28)} ${s}${detail ? ` (${detail})` : ''}\n`);
			}
		}
	}

	/** Mark named actions as `stale` for immediate visual feedback (file
	 * watcher fired). Transient — the next authoritative `update()` from
	 * the reconciler will overwrite. */
	markStale(names: string[]): void {
		if (names.length === 0) return;
		for (const n of names) this.statuses.set(n, 'stale');
		if (this.tty) {
			this.eraseBlock();
			this.renderBlock();
		} else {
			for (const n of names) this.stream.write(`  ${n.padEnd(28)} stale\n`);
		}
	}

	appendLog(actionName: string, line: string): void {
		const ts = new Date().toISOString().slice(11, 19);
		const prefix = `[${ts} ${actionName}]`;
		if (this.tty) {
			this.eraseBlock();
			this.stream.write(`${prefix} ${line}\n`);
			this.renderBlock();
		} else {
			this.stream.write(`${prefix} ${line}\n`);
		}
	}

	toggleVerbose(): void {
		this.verbose = !this.verbose;
		if (this.tty) {
			this.eraseBlock();
			this.renderBlock();
		}
	}

	private renderBlock(): void {
		const lines: string[] = [];
		for (const a of this.actions) {
			const s = this.statuses.get(a.name) ?? 'idle';
			const glyph = STATUS_GLYPH[s];
			const detail = this.failures.get(a.name);
			const right = detail ? `${s} — ${detail}` : s;
			lines.push(`  ${glyph} ${a.name.padEnd(32)} ${right}`);
		}
		if (this.verbose) {
			lines.push('  (verbose log mode on — `l` to toggle)');
		}
		this.stream.write(`${lines.join('\n')}\n`);
		this.prevBlockHeight = lines.length;
	}

	private eraseBlock(): void {
		if (this.prevBlockHeight === 0) return;
		// Cursor sits one row below the block (renderBlock ends with \n).
		// Move up + erase, repeat for each block line.
		for (let i = 0; i < this.prevBlockHeight; i++) {
			this.stream.write('\x1b[1A\x1b[2K');
		}
		this.stream.write('\r');
		this.prevBlockHeight = 0;
	}
}
