// Thin wrappers around `docker` CLI calls used by the sui and walrus
// plugins' Build and Service actions. Spawns docker as a subprocess,
// captures both stdout and stderr, and returns a typed result. Streams
// build/run logs to the parent stderr so the developer sees long-running
// progress.
//
// Containers are kept alive across `up` invocations — Service actions'
// `getStatus()` reports `ok: true` when the container is running and
// healthy, so the reconciler skips the restart.

import { spawn } from 'node:child_process';

/** Map `process.arch` to the docker `--platform` value used for builds. */
export function hostDockerPlatform(): string {
	const arch = process.arch;
	if (arch === 'arm64') return 'linux/arm64';
	if (arch === 'x64') return 'linux/amd64';
	throw new Error(`devstack: unsupported host architecture ${arch}`);
}

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

function runDocker(
	argv: string[],
	opts: { cwd?: string; stream?: boolean; appendLog?: (line: string) => void },
): Promise<DockerResult> {
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

/** Pre-flight: verify the Docker daemon is running and responding.
 * Throws with an actionable message if `docker info` fails (engine
 * stopped, socket permission denied, Docker Desktop not started yet).
 * Cheap enough to call once at the top of an action's run() — turns
 * a confusing chain of downstream `docker run` failures into a single
 * clear error before any state mutation. */
export async function requireDockerDaemon(): Promise<void> {
	const result = await dockerRun({
		command: ['info', '--format', '{{.ServerVersion}}'],
	});
	if (result.code !== 0) {
		const stderr = result.stderr.trim();
		const hint = /permission denied/i.test(stderr)
			? '\n  → Docker socket permissions: add your user to the `docker` group, or run with sudo.'
			: /cannot connect to the docker daemon/i.test(stderr)
				? '\n  → Daemon not running: start Docker Desktop (or `colima start` / `systemctl start docker`).'
				: '';
		throw new Error(
			`docker daemon not reachable (\`docker info\` exited ${result.code}).${hint}\n` +
				(stderr.length > 0 ? `  stderr: ${stderr}` : ''),
		);
	}
}

/** Returns true when the image tag is present in the local docker daemon.
 * Lets `runDocker`'s ENOENT-aware error surface to callers when docker
 * itself is missing — masking that as "image absent" would silently
 * trigger a build action that's also doomed. */
export async function imageExists(tag: string): Promise<boolean> {
	const result = await dockerRun({
		command: ['image', 'inspect', tag, '--format', '{{.Id}}'],
	});
	return result.code === 0;
}

/** Repository:tag pair returned by `docker image ls --filter`. Used by
 * the cache-GC helpers to enumerate candidates before targeted removal. */
export interface ImageRef {
	/** `<repository>:<tag>`. Pass to `removeImage`. */
	ref: string;
	repository: string;
	tag: string;
	id: string;
}

/** List images carrying every label in `labels` (Docker AND-joins
 * multiple `--filter label=...` flags). An empty-string value matches
 * the label key regardless of its value (docker syntax: `label=key`
 * vs. `label=key=value`). Skips dangling rows where `Repository` or
 * `Tag` is `<none>` — those are intermediate layers that shouldn't be
 * tag-removed individually. Also skips `devstack-snapshot/*` rows:
 * snapshot commits inherit their parent image's labels (`docker commit`
 * carries `devstack.cache=...` forward), but they're a separate user
 * concern managed by `devstack snapshot rm` rather than part of the
 * build cache. Returns empty on docker error so callers can treat the
 * result as "no work to do" without raising. */
export async function listImagesByLabel(labels: Record<string, string>): Promise<ImageRef[]> {
	const command = ['image', 'ls', '--format', '{{.Repository}}\t{{.Tag}}\t{{.ID}}'];
	for (const [k, v] of Object.entries(labels)) {
		command.push('--filter', v === '' ? `label=${k}` : `label=${k}=${v}`);
	}
	const result = await dockerRun({ command });
	if (result.code !== 0) return [];
	const out: ImageRef[] = [];
	for (const line of result.stdout.split('\n')) {
		const [repository, tag, id] = line.split('\t');
		if (
			repository === undefined ||
			tag === undefined ||
			id === undefined ||
			repository === '<none>' ||
			tag === '<none>' ||
			repository.length === 0 ||
			repository.startsWith('devstack-snapshot/')
		) {
			continue;
		}
		out.push({ ref: `${repository}:${tag}`, repository, tag, id });
	}
	return out;
}

/** Best-effort `docker image rm <tag>`. Swallows failures (image in use
 * by a running container, dependent child image like a snapshot tag,
 * race with a parallel pull) so callers can prune a list without one
 * stuck tag aborting the rest. Returns `true` on success. */
export async function removeImage(tag: string): Promise<boolean> {
	const result = await dockerRun({ command: ['image', 'rm', tag] });
	return result.code === 0;
}

/** Drop every image matching the `labels` filter set whose
 * `repository:tag` is NOT in `keep`. Used post-build to GC superseded
 * revs that share the cache label (e.g. drop `sui-localnet:devnet-v1.71.0-r6`
 * after `r7` builds successfully). No `--force`: in-use tags survive,
 * so the operator can clean up later via the explicit
 * `devstack reset --images` path. Each removal logs `pruned <ref>` /
 * `kept <ref> (in use)` via `appendLog` for visibility. */
export async function pruneImagesByLabel(opts: {
	labels: Record<string, string>;
	keep: string[];
	appendLog?: (line: string) => void;
}): Promise<void> {
	const candidates = await listImagesByLabel(opts.labels);
	const keepSet = new Set(opts.keep);
	for (const img of candidates) {
		if (keepSet.has(img.ref)) continue;
		const ok = await removeImage(img.ref);
		if (ok) {
			opts.appendLog?.(`devstack: pruned cached image ${img.ref}`);
		} else {
			opts.appendLog?.(`devstack: kept ${img.ref} (in use or has dependents)`);
		}
	}
}

/** Run `docker image prune -f --filter label=devstack.cache` to drop
 * untagged image layers (manifests whose only tag was removed) that
 * were devstack-built. Without this, `removeImage` calls leave dangling
 * layer entries in `docker image ls` — the disk space stays allocated
 * until the next `docker image prune`. Returns the docker output (which
 * ends with `Total reclaimed space: <N>`) and an ok flag. Best-effort:
 * `ok: false` on docker error rather than throwing. */
export async function pruneDanglingDevstackImages(): Promise<{ output: string; ok: boolean }> {
	const result = await dockerRun({
		command: ['image', 'prune', '-f', '--filter', 'label=devstack.cache'],
	});
	return { output: result.stdout.trim(), ok: result.code === 0 };
}

/** Run `docker builder prune -f` to evict BuildKit cache layers that
 * are no longer referenced by any image tag. Without this, `removeImage`
 * frees the tag but the cargo-build cache that backed it stays in
 * BuildKit's separate cache forever — a fresh rebuild then short-circuits
 * through cache instead of re-running the actual build steps the
 * operator is trying to retest. NOT scoped by label: `docker builder
 * prune` doesn't accept image-label filters, so this is a host-wide
 * sweep of unused cache. Safe in the sense that "in use" cache (anything
 * referenced by a current image manifest) survives. Returns docker output
 * + ok flag. Best-effort. */
export async function pruneBuildCache(): Promise<{ output: string; ok: boolean }> {
	const result = await dockerRun({ command: ['builder', 'prune', '-f'] });
	return { output: result.stdout.trim(), ok: result.code === 0 };
}

/** Total reclaimable BuildKit cache size as a human-readable string
 * (e.g. `'26.85GB'`). Used by `--images --dry-run` to report how much
 * space the eventual `pruneBuildCache` call would free, without
 * actually freeing it. Returns `undefined` on docker error (graceful
 * degradation — dry-run is best-effort information). */
export async function buildCacheSize(): Promise<string | undefined> {
	const result = await dockerRun({ command: ['buildx', 'du'] });
	if (result.code !== 0) return undefined;
	const match = result.stdout.match(/Reclaimable:\s*(\S+)/);
	return match?.[1];
}

/** Returns the standard label set for a devstack-managed container.
 * Combines our internal `devstack.*` filters with `com.docker.compose.*`
 * labels so Docker Desktop groups all containers for a given app+stack
 * under a single project pane (instead of showing a flat list). The
 * "project" maps to `<appName>-<stack>`; the "service" identifies the
 * individual container within that project. */
interface DevstackContainerLabelOpts {
	appName: string;
	stack: string;
	service: string;
	/** Snapshot capture metadata serialized into `devstack.snapshot.*`
	 * labels. Read by the snapshot orchestrator (`runtime/snapshot.ts`)
	 * to decide per-container whether to `docker commit` and how to
	 * quiesce. Absent → orchestrator falls back to defaults
	 * (commit:true, quiesce:'stop' for Service-typed actions). */
	snapshot?: {
		commit?: boolean;
		quiesce?: 'pause' | 'stop' | 'none';
	};
}

export function devstackContainerLabels(opts: DevstackContainerLabelOpts): Record<string, string> {
	const project = `${opts.appName}-${opts.stack}`;
	const labels: Record<string, string> = {
		'devstack.app': opts.appName,
		'devstack.stack': opts.stack,
		'devstack.kind': opts.service,
		'com.docker.compose.project': project,
		'com.docker.compose.service': opts.service,
		// Required for Docker Desktop to recognize the container as part
		// of a compose project (otherwise it treats the project label as
		// arbitrary metadata and still shows the container ungrouped).
		'com.docker.compose.oneoff': 'False',
		'com.docker.compose.version': '2.0.0',
	};
	if (opts.snapshot?.commit !== undefined) {
		labels['devstack.snapshot.commit'] = String(opts.snapshot.commit);
	}
	if (opts.snapshot?.quiesce !== undefined) {
		labels['devstack.snapshot.quiesce'] = opts.snapshot.quiesce;
	}
	return labels;
}

interface BuildImageOptions {
	tag: string;
	contextDir: string;
	dockerfile?: string;
	buildArgs?: Record<string, string>;
	/** Docker labels to attach to the built image. Used to filter caches
	 * via `docker image ls --filter label=devstack.cache=<kind>`. */
	labels?: Record<string, string>;
	/** Build platform (e.g. `'linux/arm64'`). Forwarded as `--platform`. */
	platform?: string;
	/** BuildKit named contexts as `--build-context name=value` flags
	 * (e.g. `{ 'walrus-src': 'https://github.com/.../walrus.git#v1' }`).
	 * Lets the Dockerfile reference `--from=name` for `COPY` operations
	 * without baking the source into the on-disk build context. */
	buildContexts?: Record<string, string>;
	/** Route docker's combined stdout/stderr through the supervisor's
	 * status renderer. When unset, build output falls back to raw
	 * `process.stderr` (see `DockerRunOptions.appendLog`). */
	appendLog?: (line: string) => void;
}

export async function buildImage(opts: BuildImageOptions): Promise<void> {
	const args = ['build', '--tag', opts.tag];
	for (const [k, v] of Object.entries(opts.buildArgs ?? {})) {
		args.push('--build-arg', `${k}=${v}`);
	}
	for (const [k, v] of Object.entries(opts.labels ?? {})) {
		args.push('--label', `${k}=${v}`);
	}
	for (const [k, v] of Object.entries(opts.buildContexts ?? {})) {
		args.push('--build-context', `${k}=${v}`);
	}
	if (opts.platform !== undefined) {
		args.push('--platform', opts.platform);
	}
	if (opts.dockerfile !== undefined) {
		args.push('--file', opts.dockerfile);
	}
	args.push(opts.contextDir);
	const result = await dockerRun({ command: args, stream: true, appendLog: opts.appendLog });
	if (result.code !== 0) {
		throw new Error(`docker build failed (exit ${result.code}): ${result.stderr.slice(-400)}`);
	}
}

type ContainerState =
	| 'created'
	| 'running'
	| 'paused'
	| 'restarting'
	| 'removing'
	| 'exited'
	| 'dead';

export interface ContainerInfo {
	id: string;
	state: ContainerState;
	/** Process exit code. Only meaningful when `state === 'exited'`. */
	exitCode: number;
	/** Convenience: `state === 'running'`. */
	running: boolean;
	healthy: boolean | undefined;
	/** Image reference the container was created from
	 * (e.g. `dev-examples/sui-localnet:devnet-v1.71.0-r4`). Used to
	 * detect stale containers when the plugin's image-tag bumps. */
	image: string;
	/** Labels set at `docker run` time. `containerService` stamps the
	 * reconciler's `inputHash` here as `devstack.input-hash` and reads
	 * it back on the next cycle to decide resume-vs-recreate. */
	labels: Record<string, string>;
}

export async function inspectContainer(name: string): Promise<ContainerInfo | null> {
	// Emit raw JSON for `.State` and parse it. A `--format` template that
	// references `.State.Health.Status` errors on containers without a
	// healthcheck (the field is absent from the map, not nil), and that
	// false-negative used to land Service actions in a "container exists,
	// but inspectContainer returned null" hole that re-ran `docker run` and
	// collided on the container name.
	const result = await dockerRun({
		command: ['container', 'inspect', name, '--format', '{{json .State}}'],
	});
	if (result.code !== 0) return null;
	const idResult = await dockerRun({
		command: ['container', 'inspect', name, '--format', '{{.Id}} {{.Config.Image}}'],
	});
	if (idResult.code !== 0) return null;
	const idImage = idResult.stdout.trim().split(/\s+/);
	const id = idImage[0] ?? '';
	const image = idImage[1] ?? '';
	// Pull labels separately as JSON to avoid template-quoting headaches
	// on values containing spaces / special chars.
	const labelsResult = await dockerRun({
		command: ['container', 'inspect', name, '--format', '{{json .Config.Labels}}'],
	});
	let labels: Record<string, string> = {};
	if (labelsResult.code === 0) {
		try {
			const parsed = JSON.parse(labelsResult.stdout.trim()) as Record<string, string> | null;
			if (parsed !== null) labels = parsed;
		} catch {
			// Fall through with empty labels — non-fatal; the only
			// callsite (containerService) treats missing label as
			// "stale", which forces a recreate (safe default).
		}
	}
	type DockerStateJson = {
		Status?: string;
		ExitCode?: number;
		Health?: { Status?: string };
	};
	let state: DockerStateJson;
	try {
		state = JSON.parse(result.stdout.trim()) as DockerStateJson;
	} catch {
		return null;
	}
	const status = state.Status;
	if (status === undefined) return null;
	const healthStatus = state.Health?.Status;
	return {
		id,
		state: status as ContainerState,
		exitCode: state.ExitCode ?? 0,
		running: status === 'running',
		healthy: healthStatus === 'healthy' ? true : healthStatus === undefined ? undefined : false,
		image,
		labels,
	};
}

interface EnsureNetworkOptions {
	name: string;
	/** CIDR, e.g. `'10.0.0.0/24'`. Required on first create when fixed-IP
	 * containers need to land on predictable addresses (walrus's testbed
	 * uses 10.0.0.10–13). Ignored on subsequent calls when the network
	 * already exists. */
	subnet?: string;
}

export async function ensureNetwork(opts: EnsureNetworkOptions): Promise<void> {
	const inspect = await dockerRun({ command: ['network', 'inspect', opts.name] });
	if (inspect.code === 0) return;
	const args = ['network', 'create'];
	if (opts.subnet !== undefined) args.push('--subnet', opts.subnet);
	args.push(opts.name);
	const result = await dockerRun({ command: args });
	if (result.code !== 0) {
		throw new Error(`docker network create ${opts.name} failed: ${result.stderr.trim()}`);
	}
}

type DockerNetworkProbe =
	| { kind: 'missing' }
	| { kind: 'no-subnet' }
	| { kind: 'subnet'; cidr: string };

/** Probes the named docker network and reports its first IPAM subnet
 * if any. `missing` = network doesn't exist; `no-subnet` = network
 * exists but has no IPAM-pinned subnet (so docker picked one
 * dynamically); `subnet` = network exists with an explicit pin.
 *
 * Used as a `getStatus` probe for actions that pin a subnet — they
 * compare `cidr` to their expected value before declaring `ok: true`. */
export async function dockerNetworkSubnet(name: string): Promise<DockerNetworkProbe> {
	const result = await dockerRun({
		command: ['network', 'inspect', '--format', '{{json .IPAM.Config}}', name],
	});
	if (result.code !== 0) return { kind: 'missing' };
	try {
		const config = JSON.parse(result.stdout.trim()) as Array<{ Subnet?: string }> | null;
		const subnet = config?.[0]?.Subnet;
		return subnet === undefined ? { kind: 'no-subnet' } : { kind: 'subnet', cidr: subnet };
	} catch {
		return { kind: 'no-subnet' };
	}
}

export async function removeNetwork(name: string): Promise<void> {
	const result = await dockerRun({ command: ['network', 'rm', name] });
	if (result.code !== 0 && !/(network not found|No such network)/i.test(result.stderr)) {
		throw new Error(`docker network rm ${name} failed: ${result.stderr.trim()}`);
	}
}

/** Block until the named container exits; returns its exit code.
 * Wraps `docker wait`, which is the right primitive for one-shot
 * containers (walrus-deploy) — no client-side polling. */
export async function waitForContainerExit(name: string): Promise<number> {
	const result = await dockerRun({ command: ['wait', name] });
	if (result.code !== 0) {
		throw new Error(`docker wait ${name} failed: ${result.stderr.trim()}`);
	}
	return Number.parseInt(result.stdout.trim(), 10);
}

/** Poll `inspectContainer` until the container reports `healthy === true`,
 * or throw on timeout. Used by the walrus plugin to gate node-N's `run`
 * resolution on the docker-level healthcheck. */
export async function waitForHealthy(
	name: string,
	opts: { timeoutMs: number; intervalMs?: number } = { timeoutMs: 300_000 },
): Promise<void> {
	const interval = opts.intervalMs ?? 1500;
	const deadline = Date.now() + opts.timeoutMs;
	while (Date.now() < deadline) {
		const info = await inspectContainer(name);
		if (info === null) {
			throw new Error(`waitForHealthy: container '${name}' not found`);
		}
		if (info.healthy === true) return;
		if (info.state === 'exited' || info.state === 'dead') {
			throw new Error(`waitForHealthy: '${name}' is ${info.state} (exit ${info.exitCode})`);
		}
		await new Promise((r) => setTimeout(r, interval));
	}
	throw new Error(`waitForHealthy: '${name}' did not become healthy within ${opts.timeoutMs}ms`);
}

export interface RunContainerOptions {
	name: string;
	image: string;
	ports?: Array<{ host: number; container: number }>;
	/** Where published ports are reachable from. Defaults to `'localhost'`
	 * — every `--publish` is prefixed `127.0.0.1:` so localnet services
	 * (RPC, faucet, GraphQL, seal key-server, walrus storage nodes) only
	 * accept connections from the developer's own machine. Pass `'lan'`
	 * to bind every port to `0.0.0.0` instead — useful for shared dev
	 * rigs (a teammate hitting your faucet, a phone connecting to your
	 * wallet-server). The wallet-server has its own `host:` knob for the
	 * same purpose; this controls everything else. */
	expose?: 'localhost' | 'lan';
	volumes?: string[];
	env?: Record<string, string>;
	command?: string[];
	restart?: 'no' | 'always' | 'unless-stopped' | 'on-failure';
	/** Attach the container to this docker network. The network must already
	 * exist (`ensureNetwork`). */
	network?: string;
	/** DNS alias the container answers to on `network`. Other containers on
	 * the same network resolve `<alias>` to this container's address. */
	networkAlias?: string;
	/** Fixed IPv4 address within `network`'s subnet. Required by walrus's
	 * testbed (nodes wired to 10.0.0.10–13). */
	ip?: string;
	/** Container platform (e.g. `'linux/arm64'`). For images built for a
	 * non-host arch — defaults to whatever Docker auto-selects. */
	platform?: string;
	/** Internal hostname. Walrus reads `$(hostname)` to discover its node
	 * config name (`dryrun-node-N`). */
	hostname?: string;
	healthcheck?: {
		test: string[];
		intervalSeconds?: number;
		timeoutSeconds?: number;
		retries?: number;
		startPeriodSeconds?: number;
	};
	/** Docker labels to attach to the container. Used by the devstack to
	 * filter resources via `--filter label=devstack.app=<app>` etc., so
	 * `stack list` / `stack drop` don't depend on name-prefix conventions. */
	labels?: Record<string, string>;
}

/** Pure: builds the argv for `docker run` from `RunContainerOptions`.
 * Extracted from `runContainer` so the port-bind, env, label, healthcheck
 * shape is testable without spawning docker. */
export function buildRunContainerArgs(opts: RunContainerOptions): string[] {
	const args = ['run', '--detach', '--name', opts.name];
	const bindPrefix = opts.expose === 'lan' ? '' : '127.0.0.1:';
	for (const { host, container } of opts.ports ?? []) {
		args.push('--publish', `${bindPrefix}${host}:${container}`);
	}
	for (const v of opts.volumes ?? []) args.push('--volume', v);
	for (const [k, v] of Object.entries(opts.env ?? {})) args.push('--env', `${k}=${v}`);
	for (const [k, v] of Object.entries(opts.labels ?? {})) args.push('--label', `${k}=${v}`);
	args.push('--restart', opts.restart ?? 'unless-stopped');
	if (opts.network !== undefined) args.push('--network', opts.network);
	if (opts.networkAlias !== undefined) args.push('--network-alias', opts.networkAlias);
	if (opts.ip !== undefined) args.push('--ip', opts.ip);
	if (opts.platform !== undefined) args.push('--platform', opts.platform);
	if (opts.hostname !== undefined) args.push('--hostname', opts.hostname);
	if (opts.healthcheck !== undefined) {
		const hc = opts.healthcheck;
		// Docker CLI takes a single shell-form healthcheck via --health-cmd
		// (CMD-SHELL semantics). Drop the leading 'CMD-SHELL'/'CMD' prefix
		// the compose file uses.
		const test = hc.test[0] === 'CMD-SHELL' || hc.test[0] === 'CMD' ? hc.test.slice(1) : hc.test;
		args.push('--health-cmd', test.join(' '));
		if (hc.intervalSeconds !== undefined) args.push('--health-interval', `${hc.intervalSeconds}s`);
		if (hc.timeoutSeconds !== undefined) args.push('--health-timeout', `${hc.timeoutSeconds}s`);
		if (hc.retries !== undefined) args.push('--health-retries', String(hc.retries));
		if (hc.startPeriodSeconds !== undefined) {
			args.push('--health-start-period', `${hc.startPeriodSeconds}s`);
		}
	}
	args.push(opts.image);
	if (opts.command !== undefined) args.push(...opts.command);
	return args;
}

export async function runContainer(opts: RunContainerOptions): Promise<string> {
	// Pre-create any named volumes with the same `devstack.app` /
	// `devstack.stack` labels as the container, so `stack drop` can filter
	// them by label rather than by name prefix (cross-app collisions).
	for (const v of opts.volumes ?? []) {
		await ensureLabeledVolume(v, opts.labels);
	}
	const args = buildRunContainerArgs(opts);
	const result = await dockerRun({ command: args });
	if (result.code !== 0) {
		throw new Error(`docker run failed (exit ${result.code}): ${result.stderr.trim()}`);
	}
	return result.stdout.trim();
}

/** Pre-create a named volume with the container's `devstack.*` labels so
 * `docker volume ls --filter label=devstack.app=<app> --filter
 * label=devstack.stack=<stack>` produces an unambiguous listing for
 * `stack drop` (vs name-prefix matching, which collides on apps with
 * overlapping prefixes). No-op if the volume is anonymous (no `:`),
 * absolute-path bind-mount, or already exists. */
async function ensureLabeledVolume(
	volumeArg: string,
	containerLabels: Record<string, string> | undefined,
): Promise<void> {
	// Volume args can be `name:/path`, `/host/path:/container/path`, or
	// `/host/path:/container/path:ro`. Bind mounts (host path with `/`)
	// don't need labels.
	const colonIdx = volumeArg.indexOf(':');
	if (colonIdx <= 0) return;
	const source = volumeArg.slice(0, colonIdx);
	if (source.startsWith('/') || source.startsWith('.')) return;
	if (containerLabels === undefined) return;
	const app = containerLabels['devstack.app'];
	const stack = containerLabels['devstack.stack'];
	if (app === undefined || stack === undefined) return;
	const inspect = await dockerRun({ command: ['volume', 'inspect', source] });
	if (inspect.code === 0) return;
	await dockerRun({
		command: [
			'volume',
			'create',
			'--label',
			`devstack.app=${app}`,
			'--label',
			`devstack.stack=${stack}`,
			source,
		],
	}).catch(() => undefined);
}

/** Read a file out of a (possibly running) container by piping through
 * `docker cp <container>:<path> -`. Works for one-shot containers in
 * `exited` state too (unlike `docker exec`). */
export async function readContainerFile(container: string, path: string): Promise<string> {
	// `docker cp` to '-' produces a tar stream on stdout. We pull a single
	// file out by spawning a sub-shell that pipes to `tar -xO`.
	return new Promise((resolve, reject) => {
		const child = spawn('sh', [
			'-c',
			`docker cp ${shQuote(container)}:${shQuote(path)} - | tar -xO`,
		]);
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (b: Buffer) => {
			stdout += b.toString();
		});
		child.stderr.on('data', (b: Buffer) => {
			stderr += b.toString();
		});
		child.on('error', reject);
		child.on('close', (code) => {
			if (code !== 0) {
				reject(new Error(`docker cp ${container}:${path} failed: ${stderr.trim()}`));
				return;
			}
			resolve(stdout);
		});
	});
}

function shQuote(s: string): string {
	return `'${s.replaceAll("'", `'\\''`)}'`;
}

export async function startContainer(name: string): Promise<void> {
	const result = await dockerRun({ command: ['start', name] });
	if (result.code !== 0) {
		throw new Error(`docker start ${name} failed: ${result.stderr.trim()}`);
	}
}

export async function stopContainer(name: string, timeoutSeconds = 10): Promise<void> {
	const result = await dockerRun({
		command: ['stop', '--timeout', String(timeoutSeconds), name],
	});
	if (result.code !== 0 && !/No such container/.test(result.stderr)) {
		throw new Error(`docker stop ${name} failed: ${result.stderr.trim()}`);
	}
}

export async function removeContainer(name: string): Promise<void> {
	const result = await dockerRun({ command: ['rm', '--force', name] });
	if (result.code !== 0 && !/No such container/.test(result.stderr)) {
		throw new Error(`docker rm ${name} failed: ${result.stderr.trim()}`);
	}
}
