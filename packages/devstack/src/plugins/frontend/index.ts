// Frontend dev-server plugin. Adds a vite/next/sveltekit-style dev server
// to the devstack supervisor so `pnpm dev` (configured to run
// `devstack up`) brings up the localnet stack AND the dev server in one
// combined process with one log stream — no `concurrently`, no separate
// `localnet:watch` script.
//
// `frontend()` is the canonical factory. The default command is `pnpm
// exec vite`, but apps using other tooling (Next.js, SvelteKit, Astro)
// pass their own `command` array.
//
// One Service action:
//
//   frontend.dev-server — Spawns the configured command as a host child
//                         process (NOT a container). `getStatus`
//                         GET-probes the dev URL; `run` spawns the
//                         child, pipes its stdout/stderr through
//                         `ctx.appendLog`, and registers a shutdown hook
//                         that SIGINTs the child on supervisor stop.
//
// `needs: ['codegen.generate']` so the dev server starts after the
// manifest + generated bindings are written. The dev server CAN start
// earlier (the vite plugin's `virtual:devstack-manifest` returns a typed
// empty fallback), but waiting avoids a "stack is empty" first paint
// followed by an HMR reload.

import { type ChildProcess, spawn } from 'node:child_process';
import { hostProcess } from '../../actions/host-process.js';
import type { ActionRunContext } from '../../core/types.js';
import { requireLocalnetCtx } from '../../core/types.js';
import { definePlugin } from '../../plugin.js';

export interface FrontendPluginOptions {
	/** Dev-server port. Default 5173 (vite's default). The plugin
	 * passes this as `--port` so the URL matches the manifest's
	 * `services.<n>.url` lookup. Pass `appendPort: false` to skip the
	 * append (for tools like Next.js that take `-p` instead). */
	port?: number;
	/** Override the dev-server command. Default `['pnpm', 'exec', 'vite']`.
	 * The plugin appends `['--port', String(port)]` unless `appendPort`
	 * is `false`. */
	command?: string[];
	/** When `false`, don't append `--port <port>` to `command`. Useful
	 * for tooling with a different port flag (`next dev -p`,
	 * `astro dev --port`). Default `true`. */
	appendPort?: boolean;
	/** Override the cwd. Defaults to `ctx.appDir`. */
	cwd?: string;
	/** Names of actions the dev server should wait for before starting.
	 * Default `['codegen.generate']` — wait for typed bindings + manifest.
	 * Pass `[]` to start immediately. */
	needs?: string[];
}

export const frontend = (opts: FrontendPluginOptions = {}) => {
	const preferredPort = opts.port ?? 5173;
	const baseCommand = opts.command ?? ['pnpm', 'exec', 'vite'];
	const appendPort = opts.appendPort !== false;
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
		const [port] = await ctx.ports.allocate({
			slot: 'frontend.dev-server',
			preferred: preferredPort,
		});
		const portValue = port as number;
		resolvedPort = portValue;
		resolvedBaseUrl = `http://localhost:${portValue}`;
		const command = appendPort ? [...baseCommand, '--port', String(portValue)] : baseCommand;
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
				inputs: { preferredPort, command: baseCommand.join(' '), appendPort },
				provides: { registry: populateRegistry },
				getStatus: async (ctx) => {
					const { baseUrl } = await resolveEndpoint(ctx);
					const reachable = await probeUrl(baseUrl);
					if (!reachable) return { ok: false, detail: `${baseUrl} not reachable` };
					return { ok: true, detail: baseUrl };
				},
				run: async (ctx) => {
					// dev server is a host process, not a container — no `ctx.stack`
					// in the spawn args. The Service action's localnet-only
					// constraint applies to the supervisor that runs us, not to
					// the dev server itself.
					requireLocalnetCtx(ctx);
					const { baseUrl, command } = await resolveEndpoint(ctx);
					const log = ctx.appendLog ?? ((line: string) => process.stdout.write(`${line}\n`));
					const cwd = opts.cwd ?? ctx.appDir;
					if (child !== undefined && child.exitCode === null) {
						// Idempotent — supervisor cycles call run again on warm
						// paths if getStatus says not-reachable. Don't spawn a
						// duplicate child; let the existing one race the probe.
						return;
					}
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
					await waitForReachable(baseUrl, 30_000, log);
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

async function probeUrl(url: string): Promise<boolean> {
	try {
		const res = await fetch(url, { method: 'GET', redirect: 'manual' });
		// Vite's dev server returns 200 on `/` for the index. Any 2xx/3xx is
		// "the server is up"; 4xx/5xx still counts because the process is
		// listening (the failure is the request, not the server liveness).
		return res.status > 0;
	} catch {
		return false;
	}
}

async function waitForReachable(
	url: string,
	timeoutMs: number,
	log: (line: string) => void,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await probeUrl(url)) {
			log(`ready at ${url}`);
			return;
		}
		await sleep(250);
	}
	throw new Error(`dev-server: ${url} did not become reachable within ${timeoutMs}ms`);
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

export function streamLines(child: ChildProcess, log: (line: string) => void): void {
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
export function stripAnsi(s: string): string {
	// Vite (and most dev servers) emit ANSI color codes + cursor moves.
	// The renderer's panel-redraw assumes plain text in `appendLog`, so
	// we strip.
	return s.replace(ANSI_RE, '');
}
