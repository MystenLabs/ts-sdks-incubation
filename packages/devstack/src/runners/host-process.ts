import { spawn } from 'node:child_process';
import type { Env, Provides, ResolvedDeps } from '../engine/types.js';
import { dep } from '../factories/dep.js';
import { define } from '../factories/define.js';

export interface HostProcessHandle {
	pid: number;
}

export interface HostProcessState {
	pid: number;
	startedAt: number;
	command: string;
	args: string[];
}

// Args available to the dynamic-resolution callbacks (command, args,
// cwd, env). Resolution happens once at start() time, after upstream
// deps are resolved.
export interface HostProcessResolveArgs<TDeps> {
	env: Env;
	deps: ResolvedDeps<TDeps>;
}

export type HostProcessValue<T, TDeps> = T | ((args: HostProcessResolveArgs<TDeps>) => T);

export interface HostProcessConfig<TDeps> {
	name: string;
	deps?: TDeps;

	command: HostProcessValue<string, TDeps>;
	args?: HostProcessValue<string[], TDeps>;
	cwd?: HostProcessValue<string, TDeps>;
	processEnv?: HostProcessValue<Record<string, string>, TDeps>;

	// Polled until it returns true or timeout fires. Default timeout is 30s.
	readyProbe?: (handle: HostProcessHandle) => Promise<boolean> | boolean;
	readyTimeoutMs?: number;
	readyPollIntervalMs?: number;

	// Optional input-hash material for the engine. Helps avoid spurious
	// restarts when nothing about the spawn changed.
	inputs?: (args: HostProcessResolveArgs<TDeps>) => unknown | Promise<unknown>;
}

// Provides exposed by every `hostProcess`-built node so parent
// producers can depend on it (gates, wrappers like viteDevServer).
// `state` / `full` mirror dockerContainer's surface; `pid` is a scalar
// projection for callers that only want the process id.
const processProvides = {
	state: dep((s: HostProcessState) => s),
	full: dep((s: HostProcessState) => s),
	pid: dep((s: HostProcessState) => s.pid),
} satisfies Provides<HostProcessState>;

// `hostProcess` wraps node:child_process.spawn into a Process producer.
// The producer's state is { pid, startedAt, command, args }, which round-
// trips through SnapshotRecord — letting warm restarts re-attach to a
// running process by checking liveness via signal 0.
//
// Exposes provides.state / provides.full / provides.pid so other
// producers can gate on a hostProcess (e.g. viteDevServer wraps a
// hostProcess and consumers depend on its state to wait for the
// process to be alive). Logs from stdout/stderr are forwarded to the
// engine's `log()` channel.
export function hostProcess<TDeps = undefined>(cfg: HostProcessConfig<TDeps>) {
	if (!cfg.name) throw new Error('hostProcess: `name` is required');
	if (!cfg.command) throw new Error(`hostProcess("${cfg.name}"): \`command\` is required`);

	const readyTimeoutMs = cfg.readyTimeoutMs ?? 30_000;
	const readyPollIntervalMs = cfg.readyPollIntervalMs ?? 200;

	return define<HostProcessState, typeof processProvides, TDeps>({
		name: cfg.name,
		provides: processProvides,
		...(cfg.deps !== undefined ? { deps: cfg.deps } : {}),
		...(cfg.inputs ? { inputs: cfg.inputs } : {}),

		start: async ({ env, deps, prior, log, onShutdown }) => {
			const resolve = { env, deps };
			const command = resolveValue(cfg.command, resolve);
			if (!command) {
				throw new Error(`hostProcess("${cfg.name}"): command resolved to empty/undefined`);
			}
			const args = resolveValue(cfg.args, resolve) ?? [];
			const cwd = resolveValue(cfg.cwd, resolve) ?? env.appDir;
			const userEnv = resolveValue(cfg.processEnv, resolve) ?? {};

			if (prior && isAlive(prior.pid) && spawnsMatch(prior, command, args)) {
				log(`reusing existing process pid=${prior.pid}`);
				onShutdown(async () => {
					if (isAlive(prior.pid)) await killByPid(prior.pid, log);
				});
				return prior;
			}

			log(`spawning: ${command} ${args.join(' ')}`);
			const child = spawn(command, args, {
				cwd,
				env: { ...process.env, ...userEnv },
				stdio: ['ignore', 'pipe', 'pipe'] as const,
			});

			if (child.pid === undefined) {
				throw new Error(`hostProcess("${cfg.name}"): failed to spawn (no pid)`);
			}
			const pid = child.pid;

			child.stdout?.on('data', (buf: Buffer) => emitLines(buf, log));
			child.stderr?.on('data', (buf: Buffer) => emitLines(buf, log));
			child.on('error', (err: Error) => log(`process error: ${err.message}`));

			onShutdown(async () => {
				if (isAlive(pid)) await killByPid(pid, log);
			});

			if (cfg.readyProbe) {
				const ready = await waitForReady(
					() => Promise.resolve(cfg.readyProbe!({ pid })),
					readyTimeoutMs,
					readyPollIntervalMs,
				);
				if (!ready) {
					await killByPid(pid, log);
					throw new Error(
						`hostProcess("${cfg.name}"): readyProbe did not return true within ${readyTimeoutMs}ms`,
					);
				}
			}

			return {
				pid,
				startedAt: Date.now(),
				command,
				args,
			};
		},

		stop: async ({ state, log }) => {
			if (state && isAlive(state.pid)) {
				log(`stopping pid=${state.pid}`);
				await killByPid(state.pid, log);
			}
		},
	});
}

function resolveValue<T, TDeps>(
	v: HostProcessValue<T, TDeps> | undefined,
	args: HostProcessResolveArgs<TDeps>,
): T | undefined {
	if (typeof v === 'function') return (v as (a: HostProcessResolveArgs<TDeps>) => T)(args);
	return v;
}

function spawnsMatch(prior: HostProcessState, command: string, args: string[]): boolean {
	if (prior.command !== command) return false;
	if (prior.args.length !== args.length) return false;
	for (let i = 0; i < args.length; i++) if (prior.args[i] !== args[i]) return false;
	return true;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function killByPid(pid: number, log: (line: string) => void): Promise<void> {
	try {
		process.kill(pid, 'SIGTERM');
	} catch (err) {
		log(`kill SIGTERM failed for pid=${pid}: ${(err as Error).message}`);
		return;
	}

	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (!isAlive(pid)) return;
		await sleep(50);
	}

	try {
		process.kill(pid, 'SIGKILL');
	} catch {
		// already gone
	}
}

async function waitForReady(
	probe: () => Promise<boolean>,
	timeoutMs: number,
	intervalMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			if (await probe()) return true;
		} catch {
			// keep polling — ready probes commonly throw before the service is up
		}
		await sleep(intervalMs);
	}
	return false;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function emitLines(buf: Buffer, log: (line: string) => void): void {
	const text = buf.toString();
	for (const line of text.split('\n')) {
		if (line.length > 0) log(line);
	}
}
