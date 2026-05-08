// Line-buffered child-process stream → callback helper. Shared by the
// frontend dev-server plugin and the Move-build helper so long-running
// child processes can flow progress through `ctx.appendLog` line-by-line
// instead of looking frozen for 10–60s, then emitting a wall of text.
//
// OS chunks arrive at buffer boundaries (typically 4–16KB), not line
// boundaries, so naive `data → log(chunk.toString())` would fragment
// progress lines mid-character (CJK output) or split a single line
// across two `appendLog` calls (renderer would render it as two rows).
// Buffer until `\n`, strip ANSI escape sequences, then forward.
//
// Caller can wire either or both of stdout/stderr; an `end` flush emits
// any trailing partial line that didn't terminate in `\n` (build
// progress lines often miss the final newline before the process exits).

import type { ChildProcess } from 'node:child_process';

/** Pipe both stdout and stderr of a child process through `log`,
 * line-buffered with ANSI stripped. Each non-empty line is forwarded
 * as one call. Trailing partial lines are flushed on `end`. */
export function streamLines(child: ChildProcess, log: (line: string) => void): void {
	wireStream(child.stdout, log);
	wireStream(child.stderr, log);
}

/** Pipe a single readable stream through `log`. Exposed for callers
 * that want to route stdout and stderr separately (e.g. parse stdout
 * as JSON while still streaming stderr progress). */
export function wireStream(
	stream: NodeJS.ReadableStream | null,
	log: (line: string) => void,
): void {
	if (stream === null) return;
	let buffer = '';
	stream.on('data', (chunk: Buffer | string) => {
		buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
		let nl = buffer.indexOf('\n');
		while (nl !== -1) {
			const line = stripAnsi(buffer.slice(0, nl)).trimEnd();
			if (line.length > 0) log(line);
			buffer = buffer.slice(nl + 1);
			nl = buffer.indexOf('\n');
		}
	});
	stream.on('end', () => {
		const line = stripAnsi(buffer).trimEnd();
		if (line.length > 0) log(line);
		buffer = '';
	});
}

const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;

/** Remove SGR (color) and CSI (cursor-move) ANSI escape sequences.
 * Vite, cargo, and most dev tools emit color codes; the supervisor's
 * panel-redraw renderer assumes plain text in `appendLog`, so we
 * strip before forwarding. */
export function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, '');
}
