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
	/** Pin the host port instead of letting the allocator pick one.
	 * Useful when an external consumer needs the host port to match
	 * the container's published-on-chain address — e.g. walrus
	 * storage nodes register themselves at `walrus-node-<i>.localhost:
	 * <port>` on chain; the proxy in front of them must bind that same
	 * port on `127.0.0.1` for browser fetches to resolve. Docker will
	 * fail loudly if the port is already in use; the allocator can't
	 * offer that guarantee since its ephemeral pick happens before the
	 * conflict surfaces. */
	hostPort?: number;
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
	/** When set, the container's writable layer was committed to this
	 * image tag during a prior `engine.saveSnapshot()` call. The next
	 * cold start (after engine.stop or a fresh engine session) uses
	 * this tag as the image instead of the configured `image:`,
	 * recovering chain state across `docker rm`. Carried forward from
	 * `prior` so subsequent in-memory cycles see the chain
	 * (run-from-tag → `prior.image === prior.committedTag`). */
	committedTag?: string;
	/** When the commit produced `committedTag`. Diagnostics only. */
	committedAt?: number;
}

export interface DockerContainerSnapshotConfig {
	/** Capture the container's writable layer via `docker commit` when
	 * `engine.saveSnapshot()` runs. Required for stateful containers
	 * (sui-localnet's RocksDB chain DB, sui-indexer-db's postgres,
	 * walrus storage nodes' RocksDB); irrelevant for stateless ones
	 * (seal key-server, walrus.deploy one-shot). Default `false`.
	 *
	 * On commit, the runner produces a tag
	 * `devstack-snapshot/<container-name>:c<UTC-timestamp>` labeled
	 * with `devstack.commit-of=<container-name>`,
	 * `devstack.app=<appName>`, `devstack.stack=<stack>` so the
	 * tag is GC-able later via `docker image prune --filter
	 * label=devstack.app=<x>`. */
	commit?: boolean;
	/** Quiesce policy applied before the commit so the captured
	 * filesystem is consistent.
	 *  - `'pause'` cgroup-freezes the processes (good for
	 *    RocksDB-style state where any running write is mid-flight).
	 *    The runner unpauses after the commit.
	 *  - `'stop'` SIGTERMs the container, waits for exit, commits, then
	 *    starts the same container back up. Slower but gives the
	 *    process a clean shutdown — necessary for write-ahead-log
	 *    designs that flush on SIGTERM.
	 *  - `'none'` runs `docker commit` against a live container. Fast,
	 *    only safe for stateless services.
	 * Default `'pause'` when `commit=true`. Ignored otherwise. */
	quiesce?: 'pause' | 'stop' | 'none';
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

	/** Container image. Either a literal tag (`'alpine:3.19'`) for
	 * pre-built images, or a `Dep<string>` chained off a
	 * `dockerImage(...)` so the image build is itself a graph node. With
	 * a Dep, bumping a build arg upstream flips the image's identity →
	 * this container's input hash flips → the container is replaced on
	 * the new tag. Cross-cutting rule: plugins compose `dockerImage` +
	 * `dockerContainer` rather than calling `docker build` from `start`. */
	image: string | Dep<string>;
	args?: DockerValue<string[], TDeps>;
	containerEnv?: DockerValue<Record<string, string>, TDeps>;
	volumes?: DockerValue<DockerVolumeMapping[], TDeps>;
	ports?: DockerPortMapping[];

	/** Optional `--network <name>`. Literal string or `Dep<string>`
	 * chained off the standard `dockerNetwork` node so the per-(app, stack)
	 * bridge identity flows in. When set, sibling containers in the same
	 * network resolve each other by `--network-alias` instead of host
	 * port-forwarding. */
	network?: string | Dep<string>;
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
	/** Optional `--hostname <name>` — sets the container's `HOSTNAME`
	 * env. Containers whose entrypoint scripts read `$HOSTNAME` to
	 * locate per-instance config files (walrus storage nodes look
	 * for `${HOSTNAME}.yaml` written by the deploy step) need this
	 * set explicitly — the auto-generated docker hostname (12-char
	 * container-id slice) won't match. */
	hostname?: DockerValue<string, TDeps>;

	// Optional ready check. Receives the running container's ID and the
	// host-port map (slot → host port). Polled until truthy or timeout.
	readyProbe?: (args: DockerReadyProbeArgs) => Promise<boolean> | boolean;
	readyTimeoutMs?: number;
	readyPollIntervalMs?: number;

	/** Optional snapshot policy. When `commit:true`, `engine.saveSnapshot()`
	 * runs `docker commit` against this container so the writable layer
	 * survives `docker rm`. The next start after a restore uses the
	 * committed tag instead of the configured `image:`, recovering chain
	 * state. Stateless containers should leave this unset. */
	snapshot?: DockerContainerSnapshotConfig;

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
// `provides.hostPort` (Dep<number>). Plugin authors that need to
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
	// returns a Dep<number>. Resolved deps will give us slot→hostPort.
	// Slots with a pinned `hostPort` skip the allocator entirely; the literal
	// port flows through `hostPorts` in `start()` below.
	const portMappings = cfg.ports ?? [];
	const portAutoDeps: Record<string, Dep<number>> = {};
	for (const { slot, hostPort } of portMappings) {
		if (hostPort === undefined) {
			portAutoDeps[slot] = ports.get('allocate', { slot });
		}
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
		_ports: Record<string, Dep<number>>;
		_image?: Dep<string>;
		_network?: Dep<string>;
	} = {
		user: cfg.deps as TDeps,
		_ports: portAutoDeps,
	};
	if (imageIsDep) {
		internalDeps._image = cfg.image as Dep<string>;
	}
	if (networkIsDep) {
		internalDeps._network = cfg.network as Dep<string>;
	}

	return define<DockerContainerState, typeof containerProvides>({
		name: cfg.name,
		deps: internalDeps,
		provides: containerProvides,
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
			const hostPorts: Record<string, number> = { ...(resolved._ports ?? {}) };
			// Layer the pinned-port slots over the allocator picks.
			// Slots that pinned a `hostPort` skipped the allocator
			// upstream — fill them in here.
			for (const { slot, hostPort } of portMappings) {
				if (hostPort !== undefined) hostPorts[slot] = hostPort;
			}
			const resolveCtx = { env, deps: resolved.user };

			const containerArgs = resolveValue(cfg.args, resolveCtx) ?? [];
			const containerEnv = resolveValue(cfg.containerEnv, resolveCtx) ?? {};
			const volumes = resolveValue(cfg.volumes, resolveCtx) ?? [];
			const resolvedImage = imageIsDep
				? (resolved._image as string)
				: (cfg.image as string);
			if (typeof resolvedImage !== 'string' || resolvedImage.length === 0) {
				throw new Error(
					`dockerContainer("${cfg.name}"): image dep resolved to empty/non-string value`,
				);
			}
			// `prior.committedTag` takes precedence over the resolved
			// image when the container is configured for snapshot commit
			// — we're explicitly trying to recover chain state captured
			// in that tag. The user-side trade-off: bumping `cfg.image`
			// (or the upstream `dockerImage` build) is silently ignored
			// while a committed snapshot exists; `devstack reset`
			// discards the snapshot and lets the new image take effect.
			const image =
				cfg.snapshot?.commit && prior?.committedTag !== undefined
					? prior.committedTag
					: resolvedImage;
			if (image !== resolvedImage) {
				log(
					`using committed-snapshot tag ${image} (configured image: ${resolvedImage}); ` +
						'`devstack reset` to discard',
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
			const hostname = resolveValue(cfg.hostname, resolveCtx);
			if (hostname !== undefined && (typeof hostname !== 'string' || hostname.length === 0)) {
				throw new Error(
					`dockerContainer("${cfg.name}"): hostname resolved to empty/non-string value`,
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
				name: composeContainerName(env, cfg.name),
				image,
				args: containerArgs,
				containerEnv,
				volumes,
				portMappings,
				hostPorts,
				labels: composeLabels(env, cfg.name),
				// Stateful containers (commit:true) drop `--rm` so the
				// snapshot lifecycle's `docker stop` + `docker commit`
				// + `docker start` quiesce-policy works without the
				// container disappearing mid-stop. onShutdown still
				// `docker rm -f`s on engine teardown.
				autoRemove: cfg.snapshot?.commit !== true,
				...(network !== undefined ? { network } : {}),
				...(cfg.networkAlias !== undefined ? { networkAlias: cfg.networkAlias } : {}),
				...(ip !== undefined ? { ip } : {}),
				...(hostname !== undefined ? { hostname } : {}),
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
				// Carry forward the committedTag from prior so a fresh
				// commit lifecycle update overwrites it cleanly. Without
				// this, an in-memory cycle that re-runs start would
				// drop the field and the next saveSnapshot would
				// produce a snapshot without the commit pointer until
				// snapshot-lifecycle re-fired.
				...(prior?.committedTag !== undefined ? { committedTag: prior.committedTag } : {}),
				...(prior?.committedAt !== undefined ? { committedAt: prior.committedAt } : {}),
			};
		},

		stop: async ({ state, log }) => {
			if (state?.containerId && (await containerIsRunning(state.containerId))) {
				log(`stopping container ${state.containerId.slice(0, 12)}`);
				await dockerRm(state.containerId, log);
			}
		},

		...(cfg.snapshot?.commit
			? {
					// `engine.saveSnapshot()` calls this. Quiesce → docker
					// commit → resume. The returned state has
					// `committedTag` / `committedAt` pointing at the new
					// image so the persisted SnapshotRecord carries the
					// pointer; the in-memory engine state is untouched
					// (createSnapshot reads our return value, not
					// nodeStates), so subsequent in-session cycles keep
					// reusing the live container.
					snapshot: async ({ env, state }) => {
						const quiesce = cfg.snapshot?.quiesce ?? 'pause';
						if (!(await containerIsRunning(state.containerId))) {
							// Container is dead — nothing to commit.
							// Return state unchanged so the snapshot
							// preserves any earlier committedTag.
							return state;
						}
						const tag = computeCommitTag(env, cfg.name);
						const labels: Record<string, string> = {
							'devstack.commit-of': cfg.name,
							'devstack.app': env.appName,
						};
						if (env.stack !== undefined) labels['devstack.stack'] = env.stack;
						try {
							if (quiesce === 'pause') await dockerPause(state.containerId);
							else if (quiesce === 'stop') await dockerStop(state.containerId);
							await dockerCommit(state.containerId, tag, labels);
						} finally {
							// Always resume — even if commit threw, leaving
							// the container paused/stopped would wedge the
							// next cycle.
							if (quiesce === 'pause') {
								await tryDockerUnpause(state.containerId);
							} else if (quiesce === 'stop') {
								await tryDockerStartContainer(state.containerId);
							}
						}
						return {
							...state,
							committedTag: tag,
							committedAt: Date.now(),
						};
					},
				}
			: {}),
	});
}

function isDep(value: unknown): value is Dep<string> {
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
	labels: Record<string, string>;
	autoRemove: boolean;
	network?: string;
	networkAlias?: string;
	ip?: string;
	hostname?: string;
}): string[] {
	const args = ['run', '-d', '--name', opts.name];
	// `--rm` ensures cleanup if the engine crashes mid-cycle without
	// firing onShutdown. Stateful (commit:true) containers skip it
	// because the snapshot lifecycle's `docker stop` + `docker commit`
	// + `docker start` quiesce-policy needs the container to persist
	// across stop. Long-running containers without commit fall back
	// on the runner's onShutdown handler for cleanup.
	if (opts.autoRemove) args.push('--rm');
	if (opts.hostname !== undefined) args.push('--hostname', opts.hostname);
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
	for (const [k, v] of Object.entries(opts.labels)) {
		args.push('--label', `${k}=${v}`);
	}
	args.push(opts.image, ...opts.args);
	return args;
}

/** Compose `<app>-<stack>-<action>` for the docker `--name`. Mirrors
 * the old devstack's convention so `docker ps` groups containers by
 * app at a glance and two apps running concurrently never collide on
 * the same docker name. Docker rejects names that don't start with
 * `[a-zA-Z0-9]` (`_template` and similar lead-underscore apps fail
 * the validator), so we strip any leading invalid chars. */
function composeContainerName(env: Env, action: string): string {
	const stack = env.stack ?? 'main';
	const raw = `${env.appName}-${stack}-${action}`;
	return raw.replace(/^[^a-zA-Z0-9]+/, '');
}

/** Per-container labels — `devstack.app` / `devstack.stack` / `devstack.action`
 * give `docker ps --filter label=devstack.app=<app>` for free, which the
 * old devstack's `stack list` / `stack drop` relied on. */
function composeLabels(env: Env, action: string): Record<string, string> {
	const labels: Record<string, string> = {
		'devstack.app': env.appName,
		'devstack.action': action,
	};
	if (env.stack !== undefined) labels['devstack.stack'] = env.stack;
	return labels;
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

async function dockerPause(containerId: string): Promise<void> {
	await exec('docker', ['pause', containerId]);
}

async function tryDockerUnpause(containerId: string): Promise<void> {
	try {
		await exec('docker', ['unpause', containerId]);
	} catch {
		// Already unpaused or removed — best effort, the engine cycle
		// shouldn't fail just because an unpause was redundant.
	}
}

async function dockerStop(containerId: string): Promise<void> {
	// Default `--time=10` SIGTERM grace + SIGKILL — matches Docker's
	// default. Stateful processes (RocksDB) flush on SIGTERM within
	// the grace window, giving us a clean filesystem to commit.
	await exec('docker', ['stop', containerId]);
}

async function tryDockerStartContainer(containerId: string): Promise<void> {
	try {
		await exec('docker', ['start', containerId]);
	} catch {
		// Container might be `--rm`-removed or failed to restart.
		// Treat as best-effort; the next engine cycle's start will
		// notice `containerIsRunning=false` and recreate from the
		// committedTag.
	}
}

async function dockerCommit(
	containerId: string,
	tag: string,
	labels: Record<string, string>,
): Promise<void> {
	const args = ['commit'];
	for (const [k, v] of Object.entries(labels)) {
		// `--change "LABEL k=v"` writes the label into the new image's
		// metadata. `docker commit -c LABEL` only takes one value at a
		// time, so loop.
		args.push('--change', `LABEL ${k}=${v}`);
	}
	args.push(containerId, tag);
	await exec('docker', args);
}

// `devstack-snapshot/<container-name>:c<utc-timestamp>` — content of
// the timestamp suffix is opaque to the rest of the system; stable
// enough to sort lexicographically (newest last) which simplifies
// any future per-stack pruning logic. Repo segment carries the
// container name so multi-container apps don't collide.
function computeCommitTag(env: Env, containerName: string): string {
	const slug = (s: string): string => s.replace(/[^a-z0-9._-]/gi, '-').toLowerCase();
	const repo = `devstack-snapshot/${slug(containerName)}`;
	const d = new Date();
	const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
	const tag =
		`c${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
		`T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
	void env; // env is reserved for future per-(app, stack) namespacing
	return `${repo}:${tag}`;
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
