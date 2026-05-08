// Low-level wrapper around the `docker` CLI. Spawns docker as a
// subprocess, captures both stdout and stderr, and returns a typed
// result. Streams build/run logs to the parent stderr or to a caller-
// supplied `appendLog` so the supervisor's status renderer can route
// progress lines around its panel-erase-then-redraw dance.
//
// `node:child_process` is imported lazily inside `runDocker` so that
// when an example app's Vite build pulls this module in via the typed-
// surface barrel, Rollup doesn't trip on a static named import from a
// browser-externalized Node module. Bundlers can drop the dynamic
// import wholesale when tree-shaking; even when they can't, the
// import only fires at call time on Node, never at module-eval time
// in a browser build.

interface DockerResult {
	stdout: string;
	stderr: string;
	code: number;
}

interface DockerRunOptions {
	command: string[];
	cwd?: string;
	stream?: boolean;
	/** When `stream: true`, each newline-delimited line of docker's
	 * combined stdout/stderr is forwarded here instead of being written
	 * raw to `process.stderr`. Used by long-running build/run actions
	 * inside the supervisor — `appendLog` routes through the supervisor's
	 * status renderer (panel-erase-then-redraw), so docker's progress
	 * lines interleave with the status block instead of smashing it.
	 *
	 * When unset (or `stream: false`), nothing happens — non-streaming
	 * call paths buffer stdout/stderr into the returned `DockerResult`
	 * exclusively. When `stream: true` AND `appendLog` is unset, the
	 * fallback is `process.stderr.write` (matches the pre-supervisor
	 * behavior for `devstack apply`, `devstack snapshot save --push`, and
	 * other one-shot CLI paths that don't run under the TUI). */
	appendLog?: (line: string) => void;
}

export function dockerRun(opts: DockerRunOptions): Promise<DockerResult> {
	return runDocker(['docker', ...opts.command], opts);
}

async function runDocker(
	argv: string[],
	opts: { cwd?: string; stream?: boolean; appendLog?: (line: string) => void },
): Promise<DockerResult> {
	const { spawn } = await import('node:child_process');
	return new Promise((resolve, reject) => {
		const child = spawn(argv[0] ?? 'docker', argv.slice(1), {
			cwd: opts.cwd,
			stdio: opts.stream ? ['ignore', 'pipe', 'pipe'] : 'pipe',
		});
		let stdout = '';
		let stderr = '';
		// Per-stream partial-line accumulators so docker's chunks
		// (which arrive at OS-buffer boundaries, not line boundaries)
		// don't fragment when forwarded through `appendLog`. We only
		// allocate these for the streaming-with-callback path; the
		// raw-stderr fallback writes whole chunks verbatim like before.
		let stdoutBuf = '';
		let stderrBuf = '';
		const flushTo =
			opts.stream === true && opts.appendLog !== undefined ? opts.appendLog : undefined;
		const drain = (buf: string, cb: (line: string) => void): string => {
			let rest = buf;
			let nl = rest.indexOf('\n');
			while (nl !== -1) {
				cb(rest.slice(0, nl));
				rest = rest.slice(nl + 1);
				nl = rest.indexOf('\n');
			}
			return rest;
		};
		child.stdout?.on('data', (chunk: Buffer) => {
			const s = chunk.toString();
			stdout += s;
			if (opts.stream === true) {
				if (flushTo !== undefined) {
					stdoutBuf = drain(stdoutBuf + s, flushTo);
				} else {
					process.stderr.write(s);
				}
			}
		});
		child.stderr?.on('data', (chunk: Buffer) => {
			const s = chunk.toString();
			stderr += s;
			if (opts.stream === true) {
				if (flushTo !== undefined) {
					stderrBuf = drain(stderrBuf + s, flushTo);
				} else {
					process.stderr.write(s);
				}
			}
		});
		child.on('error', (err) => {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
				reject(
					new Error(
						'docker CLI not found on PATH. Install Docker Desktop or Colima, ' +
							'start the engine, then re-run `devstack up`.',
					),
				);
				return;
			}
			reject(err);
		});
		child.on('close', (code) => {
			// Flush any trailing partial line that didn't end in `\n`.
			// Docker's final progress message often lacks a newline before
			// the process exits; without this, the last line silently
			// vanishes from the supervisor log.
			if (flushTo !== undefined) {
				if (stdoutBuf.length > 0) flushTo(stdoutBuf);
				if (stderrBuf.length > 0) flushTo(stderrBuf);
			}
			resolve({ stdout, stderr, code: code ?? 0 });
		});
	});
}
