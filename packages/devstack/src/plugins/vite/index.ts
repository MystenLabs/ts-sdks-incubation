// Vite dev-server plugin. Adds vite to the devstack supervisor so
// `pnpm dev` (configured to run `devstack up`) brings up the localnet
// stack AND the dev server in one combined process with one log
// stream — no `concurrently`, no separate `localnet:watch` script.
//
// One Service action:
//
//   vite.dev-server — Spawns `vite --port <port>` as a host child
//                     process (NOT a container). `getStatus` HEAD-probes
//                     the dev URL; `run` spawns the child, pipes its
//                     stdout/stderr through `ctx.appendLog` so the
//                     status renderer can interleave vite output with
//                     the action panel cleanly. Registers a shutdown
//                     hook that SIGINTs the child on supervisor stop.
//
// `needs: ['codegen.generate']` so vite starts after the manifest +
// generated bindings are written. The dev server CAN start earlier
// (the vite plugin's `virtual:devstack-manifest` returns a typed
// empty fallback), but waiting avoids a "stack is empty" first paint
// followed by an HMR reload.

import { type ChildProcess, spawn } from 'node:child_process';
import { service } from '../../actions/service.js';
import { requireLocalnetCtx } from '../../core/types.js';
import { definePlugin } from '../../plugin.js';

export interface VitePluginOptions {
	/** Vite dev-server port. Default 5173 (vite's default). The plugin
	 * passes this as `--port` so the URL matches the manifest's
	 * `services.<n>.url` lookup. */
	port?: number;
	/** Override the dev-server command. Default `['pnpm', 'exec', 'vite']`.
	 * The plugin appends `['--port', String(port)]` to whatever you pass. */
	command?: string[];
	/** Override the cwd. Defaults to `ctx.appDir`. */
	cwd?: string;
	/** Names of actions vite should wait for before starting. Default
	 * `['codegen.generate']` — wait for typed bindings + manifest. Pass
	 * `[]` to start immediately (vite's manifest fallback handles the
	 * pre-deploy empty case). */
	needs?: string[];
}

export const vite = (opts: VitePluginOptions = {}) => {
	const port = opts.port ?? 5173;
	const baseUrl = `http://localhost:${port}`;
	const baseCommand = opts.command ?? ['pnpm', 'exec', 'vite'];
	const command = [...baseCommand, '--port', String(port)];
	const needs = opts.needs ?? ['codegen.generate'];

	let child: ChildProcess | undefined;

	return definePlugin({
		name: 'vite',
		actions: () => [
			service({
				name: 'dev-server',
				needs,
				inputs: { port, command: command.join(' ') },
				getStatus: async () => {
					const reachable = await probeUrl(baseUrl);
					if (!reachable) return { ok: false, detail: `${baseUrl} not reachable` };
					return { ok: true, detail: baseUrl };
				},
				run: async (ctx) => {
					// vite is a host process, not a container — no `ctx.stack`
					// in the spawn args. The Service action's localnet-only
					// constraint applies to the supervisor that runs us, not
					// to vite itself.
					requireLocalnetCtx(ctx);
					const log = ctx.appendLog ?? ((line: string) => process.stdout.write(`${line}\n`));
					const cwd = opts.cwd ?? ctx.appDir;
					if (child !== undefined && child.exitCode === null) {
						// Idempotent — supervisor cycles call run again on warm
						// paths if getStatus says not-reachable. Don't spawn a
						// duplicate child; let the existing one race the probe.
						return;
					}
					log(`spawn ${command.join(' ')} (cwd=${cwd})`);
					child = spawn(command[0] as string, command.slice(1), {
						cwd,
						stdio: ['ignore', 'pipe', 'pipe'],
						env: { ...process.env, FORCE_COLOR: '0' },
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
	throw new Error(`vite.dev-server: ${url} did not become reachable within ${timeoutMs}ms`);
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

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
	// Vite emits ANSI color codes + cursor moves. The renderer's
	// panel-redraw assumes plain text in `appendLog`, so we strip.
	return s.replace(ANSI_RE, '');
}
