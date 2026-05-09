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
	/** Set when the container joined a docker network via `--network`.
	 * Used to detect drift across cycles — a network rename forces a
	 * container recreate. */
	network?: string;
	/** Resolved `--ip <addr>` if the container pinned a fixed IP. Same
	 * drift-detection role as `network`: a different IP forces recreate
	 * even when the network name is stable. */
	ip?: string;
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

	/** Container image. Either a literal tag (`'alpine:3.19'`) for
	 * pre-built images, or a `Dep<void, string>` chained off a
	 * `dockerImage(...)` so the image build is itself a graph node. With
	 * a Dep, bumping a build arg upstream flips the image's identity →
	 * this container's input hash flips → the container is replaced on
	 * the new tag. Cross-cutting rule: plugins compose `dockerImage` +
	 * `dockerContainer` rather than calling `docker build` from `start`. */
	image: string | Dep<void, string>;
	args?: DockerValue<string[], TDeps>;
	containerEnv?: DockerValue<Record<string, string>, TDeps>;
	volumes?: DockerValue<DockerVolumeMapping[], TDeps>;
	ports?: DockerPortMapping[];

	/** Optional `--network <name>`. Literal string or `Dep<void, string>`
	 * chained off the standard `dockerNetwork` node so the per-(app, stack)
	 * bridge identity flows in. When set, sibling containers in the same
	 * network resolve each other by `--network-alias` instead of host
	 * port-forwarding. */
	network?: string | Dep<void, string>;
	/** Optional `--network-alias <alias>` — DNS name siblings on the
	 * same network use to reach this container. Ignored unless
	 * `network` is set. */
	networkAlias?: string;
	/** Optional `--ip <addr>` — fixed IP within the network's subnet.
	 * Ignored unless `network` is set. Literal string for static
	 * pinning, or a callback `({ env, deps }) => string` for IPs
	 * derived from upstream state (e.g. the walrus storage-node
	 * committee computes `10.<octet>.0.<10+idx>` from the
	 * `dockerNetwork` octet at start time). */
	ip?: DockerValue<string, TDeps>;

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
	if (cfg.image === undefined || cfg.image === null) {
		throw new Error(`dockerContainer("${cfg.name}"): \`image\` is required`);
	}
	if (typeof cfg.image === 'string' && cfg.image.length === 0) {
		throw new Error(`dockerContainer("${cfg.name}"): \`image\` is required`);
	}

	const readyTimeoutMs = cfg.readyTimeoutMs ?? 60_000;
	const readyPollIntervalMs = cfg.readyPollIntervalMs ?? 250;

	// Build the auto-injected port deps. Each `ports.get('allocate', { slot })`
	// returns a Dep<{slot}, number>. Resolved deps will give us slot→hostPort.
	const portMappings = cfg.ports ?? [];
	const portAutoDeps: Record<string, Dep<{ slot: string }, number>> = {};
	for (const { slot } of portMappings) {
		portAutoDeps[slot] = ports.get('allocate', { slot });
	}

	// `image: Dep<…>` (vs literal string) — hoist into internal deps so
	// the engine resolves it to a tag string before start runs. The Dep
	// pulls the upstream `dockerImage` node into the graph; an upstream
	// rebuild flips this container's input hash via the cascade. Same
	// trick for `network: Dep<…>` so the singleton `dockerNetwork` node
	// is pulled in transitively whenever a container joins a network.
	const imageIsDep = isDep(cfg.image);
	const networkIsDep = cfg.network !== undefined && isDep(cfg.network);
	const internalDeps: {
		user: TDeps;
		_ports: Record<string, Dep<{ slot: string }, number>>;
		_image?: Dep<void, string>;
		_network?: Dep<void, string>;
	} = {
		user: cfg.deps as TDeps,
		_ports: portAutoDeps,
	};
	if (imageIsDep) {
		internalDeps._image = cfg.image as Dep<void, string>;
	}
	if (networkIsDep) {
		internalDeps._network = cfg.network as Dep<void, string>;
	}

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
				_image?: string;
				_network?: string;
			};
			const hostPorts = resolved._ports ?? {};
			const resolveCtx = { env, deps: resolved.user };

			const containerArgs = resolveValue(cfg.args, resolveCtx) ?? [];
			const containerEnv = resolveValue(cfg.containerEnv, resolveCtx) ?? {};
			const volumes = resolveValue(cfg.volumes, resolveCtx) ?? [];
			const image = imageIsDep ? (resolved._image as string) : (cfg.image as string);
			if (typeof image !== 'string' || image.length === 0) {
				throw new Error(
					`dockerContainer("${cfg.name}"): image dep resolved to empty/non-string value`,
				);
			}
			const network = networkIsDep
				? (resolved._network as string)
				: (cfg.network as string | undefined);
			if (network !== undefined && (typeof network !== 'string' || network.length === 0)) {
				throw new Error(
					`dockerContainer("${cfg.name}"): network dep resolved to empty/non-string value`,
				);
			}
			const ip = resolveValue(cfg.ip, resolveCtx);
			if (ip !== undefined && (typeof ip !== 'string' || ip.length === 0)) {
				throw new Error(
					`dockerContainer("${cfg.name}"): ip resolved to empty/non-string value`,
				);
			}

			// Reuse only if the prior container is still running AND its
			// recorded image / network / ip match the current resolved
			// values. An upstream `dockerImage` rebuild that produces a
			// new tag — or a `dockerNetwork` recreation under a different
			// name, or an octet-derived IP that flipped — forces
			// replacement here even though the container itself hasn't
			// crashed; otherwise the graph would silently drift to
			// running on stale infrastructure while the rest of the
			// system thinks it's on the new one.
			const networkMatches = (prior?.network ?? undefined) === (network ?? undefined);
			const ipMatches = (prior?.ip ?? undefined) === (ip ?? undefined);
			if (
				prior &&
				prior.image === image &&
				networkMatches &&
				ipMatches &&
				(await containerIsRunning(prior.containerId))
			) {
				log(`reusing running container ${prior.containerId.slice(0, 12)}`);
				onShutdown(async () => {
					if (await containerIsRunning(prior.containerId)) {
						await dockerRm(prior.containerId, log);
					}
				});
				return prior;
			}
			if (prior && (await containerIsRunning(prior.containerId))) {
				const reason = !networkMatches
					? `network changed (${prior.network ?? '<none>'} → ${network ?? '<none>'})`
					: !ipMatches
						? `ip changed (${prior.ip ?? '<none>'} → ${ip ?? '<none>'})`
						: `image changed (${prior.image} → ${image})`;
				log(`${reason}; replacing container ${prior.containerId.slice(0, 12)}`);
				await dockerRm(prior.containerId, log);
			}

			const runArgs = buildDockerRunArgs({
				name: cfg.name,
				image,
				args: containerArgs,
				containerEnv,
				volumes,
				portMappings,
				hostPorts,
				...(network !== undefined ? { network } : {}),
				...(cfg.networkAlias !== undefined ? { networkAlias: cfg.networkAlias } : {}),
				...(ip !== undefined ? { ip } : {}),
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
				image,
				args: containerArgs,
				hostPorts,
				...(network !== undefined ? { network } : {}),
				...(ip !== undefined ? { ip } : {}),
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

function isDep(value: unknown): value is Dep<void, string> {
	if (typeof value !== 'object' || value === null) return false;
	return '__producer' in value || '__pluginId' in value;
}

function buildDockerRunArgs(opts: {
	name: string;
	image: string;
	args: string[];
	containerEnv: Record<string, string>;
	volumes: DockerVolumeMapping[];
	portMappings: DockerPortMapping[];
	hostPorts: Record<string, number>;
	network?: string;
	networkAlias?: string;
	ip?: string;
}): string[] {
	const args = ['run', '-d', '--rm'];
	if (opts.network !== undefined) {
		args.push('--network', opts.network);
		if (opts.networkAlias !== undefined) args.push('--network-alias', opts.networkAlias);
		if (opts.ip !== undefined) args.push('--ip', opts.ip);
	}
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
