import type { Engine } from '../engine/class.js';
import type { EngineEvent } from '../engine/types.js';

// Plain line-oriented renderer for `up` / `apply`. Subscribes to engine
// events and prints a brief one-line status per event to stderr (so JSON
// summaries on stdout stay clean for piping). The TUI implementation in
// src/tui/ subscribes to the same event stream — both are pure
// subscribers, the engine has no opinion on which is attached.

export interface PlainRendererOptions {
	out: NodeJS.WriteStream;
	/** When true, suppresses per-node log lines (still prints lifecycle
	 * events). Useful under `--json` where log spam shouldn't intermix
	 * with structured output, but we still want to see errors. */
	quietLogs?: boolean;
}

export function attachPlainRenderer(
	engine: Engine,
	opts: PlainRendererOptions,
): () => void {
	return engine.subscribe((event) => {
		const line = formatEvent(event, opts.quietLogs ?? false);
		if (line !== undefined) opts.out.write(`${line}\n`);
	});
}

export function formatEvent(event: EngineEvent, quietLogs: boolean): string | undefined {
	switch (event.type) {
		case 'cycle:start':
			return `[cycle ${event.cycleId}] start`;
		case 'cycle:end':
			return `[cycle ${event.cycleId}] end (${event.durationMs}ms)`;
		case 'node:status':
			return `  ${event.name.padEnd(28)} ${event.before} → ${event.after}`;
		case 'node:log':
			if (quietLogs) return undefined;
			return `  [${event.name}] ${event.line}`;
		case 'node:state-changed':
			return undefined;
		case 'engine:error': {
			const where = event.name !== undefined ? ` in ${event.name}` : '';
			return `  ! engine error${where}: ${event.error.message}`;
		}
		case 'shutdown':
			return '[shutdown]';
	}
}
