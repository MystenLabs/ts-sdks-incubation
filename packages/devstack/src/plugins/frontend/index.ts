// Frontend dev-server plugin. Wires Vite into the devstack supervisor so
// `pnpm dev` (configured to run `devstack up`) brings up the localnet
// stack AND the dev server in one combined process with one log stream —
// no `concurrently`, no separate `localnet:watch` script.
//
// Committed to Vite. The plugin runs `pnpm exec vite --port <port>`
// from the app dir; alternative dev servers (Next.js, SvelteKit) would
// need their own plugin (the previous `command:` opt was never used by
// any example).
//
// One Service action:
//
//   frontend.dev-server — Spawns Vite as a host child process (NOT a
//                         container). `getStatus` GET-probes the dev URL;
//                         `run` spawns the child, pipes its stdout/stderr
//                         through `ctx.appendLog`, and registers a
//                         shutdown hook that SIGINTs the child on
//                         supervisor stop.
//
// `needs: ['codegen.generate']` so the dev server starts after the
// manifest + generated bindings are written. Without this gate the dev
// server would import a stale or pre-emit `src/generated/manifest.ts`,
// surfacing as a "stack is empty" first paint followed by an HMR reload
// once codegen catches up.

import { type ChildProcess, spawn } from 'node:child_process';
import { hostProcess } from '../../actions/host-process.js';
import type { ActionRunContext, Plugin } from '../../core/types.js';
import { probeUrl, waitForReachable } from '../../helpers/probe.js';
import { definePlugin } from '../../plugin.js';

interface FrontendPluginOptions {
	/** Dev-server port. Default 5173 (vite's default). Passed as
	 * `--port` so the URL matches the manifest's `services.<n>.url`
	 * lookup. */
	port?: number;
	/** Override the cwd. Defaults to `ctx.appDir`. */
	cwd?: string;
	/** Names of actions the dev server should wait for before starting.
	 * Default `['codegen.generate']` — wait for typed bindings + manifest.
	 * Pass `[]` to start immediately. */
	needs?: string[];
}

const VITE_COMMAND: ReadonlyArray<string> = ['pnpm', 'exec', 'vite'];

export const frontend = (opts: FrontendPluginOptions = {}): Plugin<'frontend.dev-server'> => {
	const preferredPort = opts.port ?? 5173;
	const needs = opts.needs ?? ['codegen.generate'];

	// Per-instance state. Two `frontend()` factories in the same process
	// don't interleave (each gets its own closure).
	let child: ChildProcess | undefined;
	let lastExitCode: number | null = null;
	let resolvedPort: number | undefined;
	let resolvedBaseUrl: string | undefined;

	const resolveEndpoint = async (
		ctx: ActionRunContext,
	): Promise<{ port: number; baseUrl: string; command: string[] }> => {
		if (ctx.network !== 'localnet') {
			throw new Error('frontend: localnet-only');
		}
		const [portValue] = await ctx.ports.allocate({
			slot: 'frontend.dev-server',
			preferred: preferredPort,
		});
		if (portValue === undefined) throw new Error('frontend: port allocator returned no ports');
		resolvedPort = portValue;
		resolvedBaseUrl = `http://localhost:${portValue}`;
		const command = [...VITE_COMMAND, '--port', String(portValue)];
		return { port: portValue, baseUrl: resolvedBaseUrl, command };
	};

	const populateRegistry = (ctx: ActionRunContext): void => {
		if (resolvedBaseUrl === undefined || resolvedPort === undefined) return;
		ctx.registry.services.register({
			name: 'dev-server',
			kind: 'dev-server',
			url: resolvedBaseUrl,
			port: resolvedPort,
		});
	};

	return definePlugin({
		name: 'frontend',
		actions: () => [
			hostProcess({
				name: 'dev-server',
				needs,
				inputs: { preferredPort, command: VITE_COMMAND.join(' ') },
				provides: { registry: populateRegistry },
				getStatus: async (ctx) => {
					const { baseUrl } = await resolveEndpoint(ctx);
					const reachable = await probeUrl(baseUrl, { accept: (r) => r.status > 0 });
					if (!reachable) return { ok: false, detail: `${baseUrl} not reachable` };
					return { ok: true, detail: baseUrl };
				},
				run: async (ctx) => {
					// dev server is a host process, not a container — no `ctx.stack`
					// in the spawn args. The Service action's localnet-only
					// constraint applies to the supervisor that runs us, not to
					// the dev server itself.
					const { baseUrl, command } = await resolveEndpoint(ctx);
					const log = ctx.appendLog;
					const cwd = opts.cwd ?? ctx.appDir;
					if (child !== undefined && child.exitCode === null) {
						// Idempotent — supervisor cycles call run again on warm
						// paths if getStatus says not-reachable. Don't spawn a
						// duplicate child; let the existing one race the probe.
						return;
					}
					// Reset the prior child's recorded exit code before
					// spawning a new one. Without this, a transient crash on
					// an earlier cycle would poison every subsequent cycle:
					// the throw at the bottom of `run` reads closure state
					// that no longer reflects the live child.
					lastExitCode = null;
					log(`spawn ${command.join(' ')} (cwd=${cwd})`);
					const head = command[0] as string;
					const tail = command.slice(1);
					child = spawn(head, tail, {
						cwd,
						stdio: ['ignore', 'pipe', 'pipe'],
						env: { ...process.env, FORCE_COLOR: '0' },
					});
					child.on('exit', (code) => {
						lastExitCode = code;
						if (code !== null && code !== 0) {
							log(`dev-server exited with code ${code}`);
						}
					});
					streamLines(child, log);
					ctx.onShutdown?.(async () => {
						if (child === undefined || child.exitCode !== null) return;
						child.kill('SIGINT');
						await new Promise<void>((resolve) => {
							const handle = setTimeout(() => {
								child?.kill('SIGKILL');
								resolve();
							}, 5_000);
							child?.once('exit', () => {
								clearTimeout(handle);
								resolve();
							});
						});
					});
					await waitForReachable(baseUrl, 30_000, { accept: (r) => r.status > 0, log });
					// Surface lastExitCode for testability — the helper above
					// captures unexpected early exits the renderer should see.
					if (lastExitCode !== null && lastExitCode !== 0) {
						throw new Error(`dev-server exited early with code ${lastExitCode}`);
					}
				},
			}),
		],
	});
};


function streamLines(child: ChildProcess, log: (line: string) => void): void {
	const wire = (stream: NodeJS.ReadableStream | null): void => {
		if (stream === null) return;
		let buffer = '';
		stream.on('data', (chunk: Buffer) => {
			buffer += chunk.toString('utf8');
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
		});
	};
	wire(child.stdout);
	wire(child.stderr);
}

const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;
function stripAnsi(s: string): string {
	// Vite (and most dev servers) emit ANSI color codes + cursor moves.
	// The renderer's panel-redraw assumes plain text in `appendLog`, so
	// we strip.
	return s.replace(ANSI_RE, '');
}
