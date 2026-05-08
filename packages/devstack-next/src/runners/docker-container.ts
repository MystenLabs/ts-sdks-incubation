import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Dep, Env, Provides, ResolvedDeps } from '../engine/types.js';
import { dep } from '../factories/dep.js';
import { define } from '../factories/define.js';
import { ports } from '../standard/ports.js';

const exec = promisify(execFile);

export interface DockerPortMapping {
	slot: string;
	containerPort: number;
}

export interface DockerVolumeMapping {
	host: string;
	container: string;
}

export interface DockerContainerState {
	containerId: string;
	startedAt: number;
	image: string;
	args: string[];
	hostPorts: Record<string, number>;
}

export interface DockerResolveArgs<TDeps> {
	env: Env;
	deps: ResolvedDeps<TDeps>;
}

export type DockerValue<T, TDeps> = T | ((args: DockerResolveArgs<TDeps>) => T);

export interface DockerReadyProbeArgs {
	containerId: string;
	hostPorts: Record<string, number>;
}

export interface DockerContainerConfig<TDeps> {
	name: string;
	deps?: TDeps;
	runsAs?: string;

	image: string;
	args?: DockerValue<string[], TDeps>;
	containerEnv?: DockerValue<Record<string, string>, TDeps>;
	volumes?: DockerValue<DockerVolumeMapping[], TDeps>;
	ports?: DockerPortMapping[];

	// Optional ready check. Receives the running container's ID and the
	// host-port map (slot → host port). Polled until truthy or timeout.
	readyProbe?: (args: DockerReadyProbeArgs) => Promise<boolean> | boolean;
	readyTimeoutMs?: number;
	readyPollIntervalMs?: number;

	// Forwarded to define for input-hash material.
	inputs?: (args: DockerResolveArgs<TDeps>) => unknown | Promise<unknown>;
}

// Provides exposed by every `dockerContainer`-built node so parent
// producers can read state without re-spawning. Plugins that wrap a
// container (e.g. sui-localnet) declare a private `dockerContainer({...})`
// and Dep on `hostPort` / `state` to build their own state shape — this is
// the path that keeps a uniform `dockerContainer` graph node visible to
// snapshot / shutdown / telemetry tooling instead of inlining `docker run`
// in plugin code.
const containerProvides = {
	state: dep((s: DockerContainerState) => s),
	hostPort: dep((s: DockerContainerState, req: { slot: string }) => {
		const port = s.hostPorts[req.slot];
		if (port === undefined) {
			throw new Error(
				`dockerContainer hostPort: slot '${req.slot}' is not declared in this container's \`ports\` config`,
			);
		}
		return port;
	}),
} satisfies Provides<DockerContainerState>;

// `dockerContainer` wraps a docker container into a Process producer.
// Auto-declares Dep edges on the standard `ports` graph node for each
// port mapping, so consumers don't need to wire them by hand.
//
// Exposes `provides.state` (full DockerContainerState) and
// `provides.hostPort` (Dep<{slot}, number>). Plugin authors that need to
// shape their own producer around a container (sui-localnet, walrus, …)
// declare a private `dockerContainer({...})`, Dep on these provides, and
// keep their own producer as a pure transformer — that way the container
// node remains a first-class graph member that any snapshot / lifecycle
// pass can walk.
//
// The container's state ({ containerId, hostPorts, ... }) is stored in
// SnapshotRecord; warm restarts re-attach to a still-running container
// by checking liveness via `docker inspect`.
export function dockerContainer<TDeps = undefined>(cfg: DockerContainerConfig<TDeps>) {
	if (!cfg.name) throw new Error('dockerContainer: `name` is required');
	if (!cfg.image) throw new Error(`dockerContainer("${cfg.name}"): \`image\` is required`);

	const readyTimeoutMs = cfg.readyTimeoutMs ?? 60_000;
	const readyPollIntervalMs = cfg.readyPollIntervalMs ?? 250;

	// Build the auto-injected port deps. Each `ports.get('allocate', { slot })`
	// returns a Dep<{slot}, number>. Resolved deps will give us slot→hostPort.
	const portMappings = cfg.ports ?? [];
	const portAutoDeps: Record<string, Dep<{ slot: string }, number>> = {};
	for (const { slot } of portMappings) {
		portAutoDeps[slot] = ports.get('allocate', { slot });
	}

	const internalDeps = {
		user: cfg.deps as TDeps,
		_ports: portAutoDeps,
	};

	return define<DockerContainerState, typeof containerProvides>({
		name: cfg.name,
		deps: internalDeps,
		provides: containerProvides,
		...(cfg.runsAs !== undefined ? { runsAs: cfg.runsAs } : {}),
		...(cfg.inputs
			? {
					inputs: (args) => {
						const resolved = args.deps as unknown as {
							user: ResolvedDeps<TDeps>;
							_ports: Record<string, number>;
						};
						return cfg.inputs!({ env: args.env, deps: resolved.user });
					},
				}
			: {}),

		start: async ({ env, prior, deps, log, onShutdown }) => {
			const resolved = deps as unknown as {
				user: ResolvedDeps<TDeps>;
				_ports: Record<string, number>;
			};
			const hostPorts = resolved._ports ?? {};
			const resolveCtx = { env, deps: resolved.user };

			const containerArgs = resolveValue(cfg.args, resolveCtx) ?? [];
			const containerEnv = resolveValue(cfg.containerEnv, resolveCtx) ?? {};
			const volumes = resolveValue(cfg.volumes, resolveCtx) ?? [];

			if (prior && (await containerIsRunning(prior.containerId))) {
				log(`reusing running container ${prior.containerId.slice(0, 12)}`);
				onShutdown(async () => {
					if (await containerIsRunning(prior.containerId)) {
						await dockerRm(prior.containerId, log);
					}
				});
				return prior;
			}

			const runArgs = buildDockerRunArgs({
				name: cfg.name,
				image: cfg.image,
				args: containerArgs,
				containerEnv,
				volumes,
				portMappings,
				hostPorts,
			});

			log(`docker run ${runArgs.join(' ')}`);
			const { stdout } = await exec('docker', runArgs);
			const containerId = stdout.trim();

			onShutdown(async () => {
				if (await containerIsRunning(containerId)) {
					await dockerRm(containerId, log);
				}
			});

			if (cfg.readyProbe) {
				const ready = await waitForReady(
					() => Promise.resolve(cfg.readyProbe!({ containerId, hostPorts })),
					readyTimeoutMs,
					readyPollIntervalMs,
				);
				if (!ready) {
					await dockerRm(containerId, log);
					throw new Error(
						`dockerContainer("${cfg.name}"): readyProbe did not return true within ${readyTimeoutMs}ms`,
					);
				}
			}

			return {
				containerId,
				startedAt: Date.now(),
				image: cfg.image,
				args: containerArgs,
				hostPorts,
			};
		},

		stop: async ({ state, log }) => {
			if (state?.containerId && (await containerIsRunning(state.containerId))) {
				log(`stopping container ${state.containerId.slice(0, 12)}`);
				await dockerRm(state.containerId, log);
			}
		},
	});
}

function buildDockerRunArgs(opts: {
	name: string;
	image: string;
	args: string[];
	containerEnv: Record<string, string>;
	volumes: DockerVolumeMapping[];
	portMappings: DockerPortMapping[];
	hostPorts: Record<string, number>;
}): string[] {
	const args = ['run', '-d', '--rm'];
	for (const { slot, containerPort } of opts.portMappings) {
		const hostPort = opts.hostPorts[slot];
		if (!hostPort) continue;
		args.push('-p', `${hostPort}:${containerPort}`);
	}
	for (const [k, v] of Object.entries(opts.containerEnv)) {
		args.push('-e', `${k}=${v}`);
	}
	for (const { host, container } of opts.volumes) {
		args.push('-v', `${host}:${container}`);
	}
	args.push(opts.image, ...opts.args);
	return args;
}

async function containerIsRunning(containerId: string): Promise<boolean> {
	try {
		const { stdout } = await exec('docker', ['inspect', '-f', '{{.State.Running}}', containerId]);
		return stdout.trim() === 'true';
	} catch {
		return false;
	}
}

async function dockerRm(containerId: string, log: (line: string) => void): Promise<void> {
	try {
		await exec('docker', ['rm', '-f', containerId]);
	} catch (err) {
		log(`docker rm -f ${containerId.slice(0, 12)} failed: ${(err as Error).message}`);
	}
}

function resolveValue<T, TDeps>(
	v: DockerValue<T, TDeps> | undefined,
	args: DockerResolveArgs<TDeps>,
): T | undefined {
	if (typeof v === 'function') return (v as (a: DockerResolveArgs<TDeps>) => T)(args);
	return v;
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
			// keep polling
		}
		await sleep(intervalMs);
	}
	return false;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
