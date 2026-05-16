// `Docker.run` + the spawner/error helpers shared across every command
// in this directory. Other slices (image, exec, network, logs, sweep)
// import the helpers from here so the error envelope + stream draining
// stay uniform.

import { Effect, Ref } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { addFinalizer, type Scope } from 'effect/Scope';
import { DockerError } from '../../engine/errors.js';
import { Identity } from '../identity.js';
import { LongLivedScope } from '../long-lived-scope.js';
import { ClaimedContainers } from './sweep.js';
import {
	ROUTER_NETWORK,
	removeFileProvider,
	writeFileProvider,
	type RouterLabel,
} from './router.js';
import { Stream } from 'effect';

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

// Cap captured stdout/stderr to keep oversized progress dumps (e.g. docker
// pull layer streams) from drowning the rest of the error message. 1KB is
// enough to surface a daemon error like "Cannot connect to the Docker daemon
// at unix:///var/run/docker.sock" or "Error response from daemon: ... port
// is already allocated" without becoming the whole message body.
const STREAM_TRUNC_BYTES = 1024;

export const truncate = (s: string): string =>
	s.length > STREAM_TRUNC_BYTES ? `${s.slice(0, STREAM_TRUNC_BYTES)}…[truncated]` : s;

// Compose the short summary line that lands in `DockerError.message`. We
// fold exitCode/stderr into the summary so consumers that only print
// `error.message` (the default in most logs) see WHY docker failed without
// needing to inspect the structured fields.
export const summarize = (
	op: string,
	exitCode: number | undefined,
	stdout: string,
	stderr: string,
	extra?: string,
): string => {
	const parts: Array<string> = [op];
	if (exitCode !== undefined) parts.push(`exit ${exitCode}`);
	const trimmedErr = stderr.trim();
	const trimmedOut = stdout.trim();
	if (trimmedErr.length > 0) parts.push(`stderr: ${truncate(trimmedErr)}`);
	else if (trimmedOut.length > 0 && (exitCode ?? 0) !== 0) {
		// Some docker subcommands emit errors on stdout (e.g. `docker load`
		// with a malformed tar). Surface that when stderr is empty.
		parts.push(`stdout: ${truncate(trimmedOut)}`);
	}
	if (extra !== undefined) parts.push(extra);
	return parts.join(' — ');
};

export const dockerError =
	(op: string) =>
	(cause: unknown): DockerError =>
		new DockerError({
			op,
			message: op,
			cause,
		});

// Match docker / containerd error messages that indicate the host port a
// container wants to bind is unavailable. We're deliberately permissive
// here: docker emits several variants depending on which daemon component
// surfaces the failure (`Bind for 0.0.0.0:9001 failed: port is already
// allocated`, `Error response from daemon: driver failed programming
// external connectivity ... address already in use`, `listen tcp
// 127.0.0.1:9001: bind: address already in use`), and missing a real port
// conflict is worse than over-matching — the worst outcome of a false
// positive is auto-allocating an ephemeral port on the recreate path,
// which is what the previous behavior did unconditionally anyway.
//
// Anything we DON'T match (OCI runtime errors, image-pull glitches,
// daemon transient hiccups) keeps the caller's original `opts.ports` on
// the recreate path so endpoints published at primitive-init time
// (`http://localhost:2024`) remain valid after the resume-fallback.
const PORT_CONFLICT_PATTERNS = [
	'port is already allocated',
	'address already in use',
	'bind: address already in use',
] as const;

export const isPortConflictStderr = (stderr: string): boolean => {
	if (stderr.length === 0) return false;
	const lower = stderr.toLowerCase();
	for (const pat of PORT_CONFLICT_PATTERNS) {
		if (lower.includes(pat)) return true;
	}
	return false;
};

// -----------------------------------------------------------------------------
// Run — long-running container with Scope-managed cleanup
// -----------------------------------------------------------------------------

export interface DockerRunOptions {
	readonly name?: string;
	readonly image: string;
	readonly args?: ReadonlyArray<string>;
	readonly env?: Record<string, string>;
	/**
	 * Paths to env-files (`--env-file`). Each file contains `KEY=value` lines and
	 * is read by docker without exposing the values via process env / `inspect`
	 * the way `-e KEY=value` does. Useful for high-sensitivity values (e.g. a
	 * master signing key) that must not surface in container metadata. Files
	 * are passed to docker in the given order; later entries override earlier
	 * ones, and inline `env` entries override env-files.
	 */
	readonly envFiles?: ReadonlyArray<string>;
	readonly ports?: Record<number, number>;
	/**
	 * Host interface to bind published ports to. Defaults to `'127.0.0.1'`.
	 * Set to `'0.0.0.0'` for devcontainers / WSL where loopback isn't
	 * reachable from the host browser.
	 */
	readonly bindAddress?: string;
	readonly mounts?: ReadonlyArray<{ readonly host: string; readonly container: string }>;
	readonly network?: string;
	readonly detach?: boolean;
	/**
	 * Custom `--add-host` entries, each of the form `host:ip` (e.g.
	 * `host.docker.internal:host-gateway`). If undefined, defaults to
	 * `['host.docker.internal:host-gateway']` so containers on Linux can
	 * reach the host loopback the same way Docker Desktop wires it on
	 * Mac/Windows. Pass `[]` to opt out entirely.
	 */
	readonly addHosts?: ReadonlyArray<string>;
	/**
	 * Static IP within `network`. Requires `network` to be set —
	 * `--ip` is meaningless without `--network`, so we validate the
	 * combination up front.
	 */
	readonly ip?: string;
	/**
	 * Container hostname (`--hostname`). Sets the value reported by
	 * `hostname` inside the container; useful when the workload reads
	 * its own hostname to register itself with a peer (e.g. walrus
	 * storage nodes match this against the chain-registered name).
	 */
	readonly hostname?: string;
	/**
	 * Additional DNS alias for the container on `network`
	 * (`--network-alias`). Requires `network` to be set — docker
	 * rejects `--network-alias` without an attached network, so we
	 * validate the combination up front.
	 */
	readonly networkAlias?: string;
	/**
	 * Callback invoked when the resume path detects a port-conflict
	 * stderr (`isPortConflictStderr` matched) AND the dispatcher is
	 * about to recreate the container. The current `opts.ports`
	 * (host → container) is passed in; the resolved record REPLACES
	 * `opts.ports` for the recreate's `-p <bind>:<host>:<container>`
	 * mappings.
	 *
	 * `Docker.run` itself is allocator-agnostic. Primitives that
	 * allocate via `PortAllocator` wire this callback through
	 * `reallocatePortsOnConflict` (see `./port-conflict.ts`) so a
	 * resume-after-pause that finds the preferred host port held by
	 * another stack SHIFTS to the next free preferred-style slot
	 * (9000 → 9001 → 9002) instead of landing on a random ephemeral
	 * port. When omitted, `Docker.run` falls back to today's behavior:
	 * pass `-p <bind>::<container>` so docker auto-allocates the host
	 * port and read it back via `inspectHostPorts`.
	 */
	readonly onPortConflict?: (
		conflictingPorts: Readonly<Record<number, number>>,
	) => Effect.Effect<Readonly<Record<number, number>>, DockerError, never>;
	/**
	 * Traefik router exposure. When set, `Docker.run` ALSO attaches the
	 * container to the shared `devstack-router` docker network (in
	 * addition to the per-stack `network`) and stamps the traefik
	 * docker-provider labels for each entry. Multi-port primitives
	 * (e.g. sui-localnet exposing rpc/faucet/graphql) pass one
	 * `RouterLabel` per service; the router id is keyed off
	 * `<app>-<stack>-<service>` so labels can't collide.
	 *
	 * The caller is responsible for ensuring the router container is
	 * up before spawning these containers — `defineDevstack` invokes
	 * `ensureRouter` at boot for the supervisor path. Standalone
	 * `Docker.run` callers (tests, ad-hoc) that don't need router
	 * routing simply leave this unset.
	 *
	 * Direct host-port publishing (`-p <host>:<container>`) is still
	 * honored alongside traefik exposure when `ports` is also set —
	 * useful for `curl`-against-127.0.0.1 debug surfaces while the
	 * traefik path serves the user-facing URLs. The default is no
	 * host port publishing when `traefik` is set (the router IS the
	 * external surface), unless the env var `DEVSTACK_DIRECT_PORTS=1`
	 * forces both.
	 */
	readonly traefik?: ReadonlyArray<RouterLabel>;
	/**
	 * Per-line output sink. When set, after the container is up
	 * `Docker.run` spawns a `docker logs --follow <id>` child whose
	 * stdout/stderr lines flow through `cb`. Lifecycle is bound to the
	 * `reuseScope` finalizer (the LongLivedScope when present, else the
	 * caller's per-cycle scope) — closing the scope kills the
	 * docker-logs child, so the supervisor stops streaming when the
	 * container is stopped/removed at teardown.
	 *
	 * stdout lines arrive as `'info'`, stderr lines as `'warn'`.
	 * Lines are pushed unconditionally; the callback is responsible
	 * for any sampling / filtering it wants. Errors from the callback
	 * are swallowed.
	 */
	readonly onOutputLine?: OutputLineCallback;
}

export interface DockerRunResult {
	readonly containerId: string;
	readonly name: string;
	/**
	 * `true` when `Docker.run` adopted an already-healthy container with
	 * the matching image rather than spawning a fresh one. Lets callers
	 * skip expensive ready-probes on warm restarts — e.g. `suiLocalnet`
	 * sends a real funding tx as its faucet probe (so we don't race
	 * warm-up on cold boots), but that's wasteful when the container
	 * has been up for hours and is verifiably healthy already.
	 */
	readonly reused: boolean;
	/**
	 * The container's actual host-port → container-port bindings. On a
	 * fresh spawn this matches `opts.ports`. On resume/reuse this is
	 * read back from `docker inspect` because the container was
	 * created with its original port mappings — the caller's new
	 * `opts.ports` is ignored by `docker start`. Callers that publish
	 * URLs to the manifest (sui-localnet, etc.) MUST use these to
	 * avoid a "manifest says port X, container is on port Y" mismatch
	 * that surfaces as a ready-probe timeout.
	 */
	readonly hostPorts: Record<number, number>;
}

export const run = (
	opts: DockerRunOptions,
): Effect.Effect<
	DockerRunResult,
	DockerError,
	ChildProcessSpawner.ChildProcessSpawner | Identity | Scope
> =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const identity = yield* Identity;
		const scope = yield* Effect.scope;

		// Per-call primitive name (e.g. `sui.localnet`) — what callers
		// pass in. Random fallback when omitted only matters for the
		// hand-rolled-primitive escape hatch and one-shot helpers below.
		const primitiveName = opts.name ?? generateContainerName();
		// `{app}-{stack}-{primitiveName}` (or `{app}-{primitiveName}` for
		// the default `'main'` stack) keeps every container we spawn in a
		// single global namespace partitioned by the `<app, stack>` pair
		// so two repos / two stacks / two playwright workers don't trample
		// each other. Hyphens render better than dots in `docker ps` and
		// match the shape docker-compose emits. Periods inside the caller's
		// primitive name (e.g. `sui.localnet`) become hyphens for the same
		// reason — the dotted form looks like a domain name in container
		// listings and trips terminal-link heuristics.
		const name = composeContainerName(
			identity.app,
			identity.stack,
			identity.network,
			primitiveName,
		);
		// Compose project label so Docker Desktop groups all containers
		// from this `<app, stack>` together in the UI even though we
		// don't actually use docker-compose. Mirrors `docker compose`'s
		// default project naming (the directory) — just the app for the
		// `main` stack, app-stack for everything else.
		const composeProject = composeProjectName(identity.app, identity.stack, identity.network);
		const detach = opts.detach ?? true;
		// `devstack.app` / `devstack.stack` / `devstack.action` mirror v3
		// `packages/devstack/src/runners/docker-container.ts:540-549` so
		// `wipe` / `stack down` can enumerate our containers via
		// `docker ps --filter label=devstack.stack=<stack>` instead of the
		// weaker `name=^devstack-` prefix heuristic. The compose labels
		// alongside trigger Docker Desktop's project grouping in the UI:
		// the `project` label alone isn't enough — modern Docker Desktop
		// keys grouping on the full quartet (`project`, `service`,
		// `version`, `container-number`). Values mirror what `docker
		// compose up` emits (verified via `docker inspect` against a real
		// compose-managed container).
		const baseLabels: Array<string> = [
			`devstack.app=${identity.app}`,
			`devstack.stack=${identity.stack}`,
			`devstack.action=${primitiveName}`,
			`com.docker.compose.project=${composeProject}`,
			`com.docker.compose.service=${primitiveName}`,
			`com.docker.compose.container-number=1`,
			`com.docker.compose.version=2.0.0`,
			`com.docker.compose.oneoff=False`,
		];
		// Traefik exposure is now file-provider-driven (see `router.ts`
		// architecture comment + the `materializeRouterEntries` call
		// below). We deliberately DO NOT stamp `traefik.*` labels on the
		// container — the docker provider would race with the two-step
		// network attach (per-stack network at `docker run` time,
		// `devstack-router` via `docker network connect` after) and
		// capture the wrong upstream IP.
		const labels: ReadonlyArray<string> = baseLabels;

		// `--ip` is only valid alongside `--network`; surface the misuse as
		// a typed DockerError instead of letting docker emit a confusing
		// "user specified IP address is supported only when connecting to
		// networks with user configured subnets" at run-time.
		if (opts.ip !== undefined && opts.network === undefined) {
			return yield* Effect.fail(
				new DockerError({
					op: 'docker run',
					message: `'ip' requires 'network' to be set (name=${name})`,
				}),
			);
		}

		// `--network-alias` is similarly meaningless without an attached
		// `--network`; reject the combination up front so the caller gets
		// a typed error instead of a runtime docker complaint.
		if (opts.networkAlias !== undefined && opts.network === undefined) {
			return yield* Effect.fail(
				new DockerError({
					op: 'docker run',
					message: `'networkAlias' requires 'network' to be set (name=${name})`,
				}),
			);
		}

		// Default to wiring `host.docker.internal:host-gateway` so containers
		// on Linux can dial the host loopback. Docker Desktop already
		// provides this entry on Mac/Windows, where re-declaring it is
		// harmless. Caller can opt out by passing an explicit empty array.
		const addHosts: ReadonlyArray<string> = opts.addHosts ?? [
			'host.docker.internal:host-gateway',
		];
		const bindAddress = opts.bindAddress ?? '127.0.0.1';

		// Reuse-if-healthy: when an existing container with this name is
		// already running the SAME image, skip recreation and adopt it.
		// Sui localnet etc. are expensive to bring up (fresh genesis →
		// NEW chain id → publishMove cache miss → NEW packageId), so on
		// `r` we want the previous cycle's container to live across the
		// supervisor-scope teardown. The finalizer goes on the
		// `LongLivedScope` (the outer launch-loop scope provided by
		// `defineDevstack`) instead of the current per-cycle scope: `r`
		// only tears the per-cycle scope down, so a long-lived finalizer
		// survives. Ctrl-C tears down the outer scope too → finalizer
		// fires → container reaped. Standalone callers that haven't
		// provided `LongLivedScope` fall back to `Effect.scope`, matching
		// the previous behavior.
		const longLivedScope = yield* LongLivedScope;
		const reuseScope = longLivedScope ?? scope;
		const claimedRef = yield* ClaimedContainers;
		const claim = (id: string): Effect.Effect<void> =>
			claimedRef === undefined ? Effect.void : Ref.update(claimedRef, (s) => new Set(s).add(id));

		// Build the fresh `docker run` argv WITHOUT `-p` flags so we can
		// reuse it on the recreate-after-resume-failure path with a
		// fresh port allocation. The two paths that need port flags
		// (`fresh` from a clean slate, and `recreate` when an image
		// mismatch evicts a working container) splice them in below.
		const portArgsFor = (ports: Record<number, number>): Array<string> => {
			const out: Array<string> = [];
			for (const [hostPort, containerPort] of Object.entries(ports)) {
				out.push('-p', `${bindAddress}:${hostPort}:${containerPort}`);
			}
			return out;
		};
		// Auto-allocate variant: pass only the container port so docker
		// picks an ephemeral host port. The actual binding is read back
		// via `inspectHostPorts` after `docker run` returns. Used by the
		// resume-fallback when stderr matched a port-conflict pattern AND
		// no `onPortConflict` callback was supplied — back-compat for
		// callers that haven't wired allocator-driven preferred-port
		// recovery yet.
		const portArgsAuto = (): Array<string> => {
			const out: Array<string> = [];
			for (const containerPort of Object.values(opts.ports ?? {})) {
				out.push('-p', `${bindAddress}::${containerPort}`);
			}
			return out;
		};

		// Decide what to do based on the inspect probe — pure function,
		// see `decideRunAction` below. The dispatcher executes the
		// action; the resume branch can promote itself to `recreate`
		// when `docker start` fails (e.g. the original host port is now
		// held by something else), at which point the fallback MUST NOT
		// reuse the caller's stale port preferences.
		const inspected = yield* inspectContainer(spawner, name);
		let action = decideRunAction(inspected, opts.image);

		if (action.kind === 'adopt') {
			yield* Effect.logInfo(`devstack: reusing running container '${name}'`);
			yield* Effect.annotateCurrentSpan({
				'docker.op': 'run',
				'docker.name': name,
				'docker.reused': true,
				'docker.resumed': false,
			});
			yield* claim(action.containerId);
			// Reattach to the router network + materialize file-provider
			// YAMLs. Reattach is idempotent on already-attached, and the
			// YAML overwrite picks up the current IP if the daemon
			// assigned a different one across a docker restart.
			yield* materializeRouterEntries(spawner, action.containerId, opts.traefik, reuseScope);
			// Finalizer: stop (don't remove) so the container's on-disk
			// state survives until the next pnpm dev resumes it. `devstack
			// wipe` is the only way to remove containers + volumes.
			yield* addFinalizer(
				reuseScope,
				Effect.uninterruptible(
					spawner
						.exitCode(ChildProcess.make('docker', ['stop', action.containerId]))
						.pipe(Effect.ignore),
				),
			);
			// Stream this container's combined output into the
			// supervisor's log channel for as long as the reuseScope is
			// alive. No-op when the caller didn't supply a sink.
			yield* attachLogFollower(spawner, action.containerId, name, opts.onOutputLine, reuseScope);
			// Read the container's actual host-port bindings — `docker
			// start` honors the original `docker run -p` mappings, not
			// the caller's freshly-allocated `opts.ports`. Callers that
			// publish URLs to the manifest (sui-localnet) MUST use the
			// returned `hostPorts`, not their pre-resume allocator
			// guesses, or the ready-probe hits a port the container
			// isn't actually bound to and times out.
			const hostPorts = yield* inspectHostPorts(spawner, action.containerId);
			return { containerId: action.containerId, name, reused: true, hostPorts };
		}

		// Set when the resume path promotes itself to `recreate`
		// SPECIFICALLY because the host port we asked for is held by
		// something else. ONLY in that case do we want to drop the
		// caller's `opts.ports` and let docker auto-allocate. For every
		// other resume failure (OCI runtime errors, image-pull glitches,
		// transient daemon hiccups) the original ports are still the
		// right ones, and re-allocating breaks any caller that already
		// published URLs at primitive-init time (e.g. seal-key-server
		// captures `http://localhost:2024` into its endpoint and never
		// re-reads — recreating on an ephemeral port leaves the
		// supervisor probing a port the container isn't bound to).
		let resumePortConflict = false;

		if (action.kind === 'resume') {
			yield* Effect.logInfo(`devstack: resuming stopped container '${name}'`);
			// Capture exit code + stderr — `docker start` can fail for
			// real reasons (port already in use on the host, the image's
			// tag was pruned out from under it, runtime config drift).
			// The earlier code looked at the exitCode and ignored
			// non-zero values, so a silent start-failure put the
			// supervisor into "container exists but isn't actually
			// running" territory and every downstream ready-probe timed
			// out blind.
			const startResult = yield* runCapturing(
				spawner,
				ChildProcess.make('docker', ['start', action.containerId]),
				'docker start',
			).pipe(Effect.catchTag('DockerError', () => Effect.succeed(null)));
			if (startResult === null || startResult.exitCode !== 0) {
				const stderr = startResult?.stderr ?? '';
				resumePortConflict = isPortConflictStderr(stderr);
				yield* Effect.logWarning(
					`devstack: docker start '${name}' failed (` +
						`exit=${startResult?.exitCode ?? 'spawn-error'}, ` +
						`stderr=${stderr.trim().slice(0, 200)})` +
						(resumePortConflict
							? ' — port conflict detected, falling back to remove + fresh run with re-allocated ports'
							: ' — falling back to remove + fresh run with the original ports'),
				);
				// Promote to `recreate`: the existing container is the
				// one we just failed to start, so we know its id; the
				// dispatcher's recreate branch will rm it and re-run.
				// Whether the fresh run reuses the caller's host ports
				// or asks docker to auto-allocate is decided below via
				// `resumePortConflict` — most resume failures (OCI
				// runtime errors, transient daemon issues) are NOT port
				// problems and recreating on the same port works.
				action = { kind: 'recreate', existingId: action.containerId };
			} else {
				yield* Effect.annotateCurrentSpan({
					'docker.op': 'run',
					'docker.name': name,
					'docker.reused': true,
					'docker.resumed': true,
				});
				yield* claim(action.containerId);
				yield* materializeRouterEntries(spawner, action.containerId, opts.traefik, reuseScope);
				yield* addFinalizer(
					reuseScope,
					Effect.uninterruptible(
						spawner
							.exitCode(ChildProcess.make('docker', ['stop', action.containerId]))
							.pipe(Effect.ignore),
					),
				);
				yield* attachLogFollower(
					spawner,
					action.containerId,
					name,
					opts.onOutputLine,
					reuseScope,
				);
				const hostPorts = yield* inspectHostPorts(spawner, action.containerId);
				return { containerId: action.containerId, name, reused: true, hostPorts };
			}
		}

		// `recreate` and `fresh` both end up here. Port-arg selection:
		//
		//   - `fresh` (no prior container): honor the caller's
		//     `opts.ports` exactly.
		//   - `recreate` from an image-mismatch eviction (decision-time):
		//     same — the caller's ports are still authoritative; the old
		//     container is gone so there's nothing to conflict with.
		//   - `recreate` from a resume-fallback promotion: depends on
		//     WHY `docker start` failed. If stderr indicated a port
		//     conflict (something else holds the host port now), the
		//     caller's preferred host port is stale. Two sub-cases:
		//
		//       a. `onPortConflict` callback supplied — ask the primitive
		//          (which owns the `PortAllocator`) for a fresh
		//          host→container map. The recreate path uses those as
		//          full `<bind>:<host>:<container>` mappings so the new
		//          binding is the next free preferred port (9000 → 9001
		//          → …) instead of a random ephemeral. `result.hostPorts`
		//          reflects the callback's mapping directly.
		//       b. No callback — drop `opts.ports` and pass
		//          `-p <bind>::<container>` so docker auto-allocates an
		//          ephemeral host port. Read it back via
		//          `inspectHostPorts`. This is the pre-existing
		//          back-compat path for callers that haven't wired
		//          allocator-driven recovery.
		//
		//     For every other failure class (OCI runtime error, missing
		//     image layer, daemon hiccup) the caller's ports are still
		//     correct and re-allocating would silently move the endpoint
		//     out from under callers that already published URLs at
		//     primitive-init time.
		let recreatePorts: Record<number, number> | null = null;
		if (resumePortConflict && opts.onPortConflict !== undefined && opts.ports !== undefined) {
			const fresh = yield* opts.onPortConflict(opts.ports);
			recreatePorts = { ...fresh };
			yield* Effect.logInfo(
				`devstack: '${name}' recreate using re-allocated ports ` +
					`${JSON.stringify(recreatePorts)} (was ${JSON.stringify(opts.ports)})`,
			);
		}
		const useCallbackPorts = recreatePorts !== null;
		const useAutoAllocate = resumePortConflict && recreatePorts === null;
		const portArgs = useCallbackPorts
			? portArgsFor(recreatePorts as Record<number, number>)
			: useAutoAllocate
				? portArgsAuto()
				: portArgsFor({ ...opts.ports });
		const args = buildRunArgs({
			detach,
			name,
			labels,
			hostname: opts.hostname,
			network: opts.network,
			ip: opts.ip,
			networkAlias: opts.networkAlias,
			addHosts,
			portArgs,
			envFiles: opts.envFiles,
			env: opts.env,
			mounts: opts.mounts,
			image: opts.image,
			imageArgs: opts.args,
		});

		// Per-primitive orphan sweep. A prior process killed mid-cycle
		// (SIGKILL, panic) can leave a same-named container lying
		// around; docker rejects `run --name` collisions, so without
		// this step every restart after a hard crash fails immediately.
		// Force-remove is safer than reuse here — the inspect probe
		// above already claimed the reuse path when health + image
		// matched, so anything reaching this point is
		// known-incompatible. Best-effort: a failure here just falls
		// through and lets `docker run` surface the real reason.
		yield* removeContainerIfExists(spawner, name).pipe(Effect.ignore);

		// Pre-create named volumes with devstack labels so `devstack
		// wipe` can enumerate + remove them via
		// `docker volume ls --filter label=devstack.stack=<stack>`.
		// Without this, named-volume mounts ride in via `-v <name>:<path>`
		// and docker creates them lazily WITHOUT any labels — meaning
		// they accumulate forever (no label-filter can find them) and
		// every run leaks ~100MB of RocksDB / postgres / walrus state.
		// Bind mounts (host string contains '/') are user-owned host
		// paths and must NOT be pre-created; skip them.
		for (const { host } of opts.mounts ?? []) {
			if (host.includes('/')) continue;
			yield* ensureLabeledVolume(spawner, host, identity.app, identity.stack).pipe(Effect.ignore);
		}

		const cmd = ChildProcess.make('docker', args);
		yield* Effect.annotateCurrentSpan({
			'docker.op': 'run',
			'docker.name': name,
			'docker.recreate': resumePortConflict,
			'docker.recreate.portStrategy': useCallbackPorts
				? 'callback'
				: useAutoAllocate
					? 'auto'
					: 'caller',
		});

		const captured = yield* runCapturing(spawner, cmd, 'docker run');
		const containerId = captured.stdout.trim();
		if (captured.exitCode !== 0 || containerId.length === 0) {
			return yield* Effect.fail(
				new DockerError({
					op: 'docker run',
					message: summarize(
						'docker run',
						captured.exitCode,
						captured.stdout,
						captured.stderr,
						`name=${name}`,
					),
					stdout: truncate(captured.stdout),
					stderr: truncate(captured.stderr),
					exitCode: captured.exitCode,
				}),
			);
		}

		// Multi-network attach for traefik exposure + file-provider
		// YAML materialization. Backends keep their per-stack network
		// as primary (for in-network DNS aliases / IP pins) and join
		// the shared `devstack-router` network so traefik can reach
		// them. After the network attach, the supervisor resolves the
		// container's router-network IP and writes one
		// `~/.devstack/traefik/dynamic/<id>.yml` per RouterLabel. We
		// can't use traefik's docker provider here: it watches
		// container events and would capture the per-stack IP on the
		// first event, BEFORE `docker network connect` adds the
		// router-network IP — every request would then 404 against a
		// network traefik can't reach.
		yield* materializeRouterEntries(spawner, containerId, opts.traefik, reuseScope);

		// Best-effort `docker stop` on scope close. We deliberately
		// stop instead of remove so the container's on-disk state
		// (named volumes, RocksDB stores, deploy outputs, …) survives
		// to the next `pnpm dev`, where the reuse path above resumes
		// it with `docker start` in ~1s. Full teardown is the job of
		// `devstack wipe` (which removes via the label-based sweep).
		//
		// Tolerate failure here because the container may have already
		// exited / been removed by `--rm` or a competing teardown.
		// `Effect.uninterruptible` is essential: scope teardown fires
		// under fiber interruption (SIGINT path), and without it the
		// stop subprocess gets killed mid-flight, leaving the
		// container in an indeterminate state.
		//
		// Registered on the `LongLivedScope` (when provided by
		// `defineDevstack`) so per-cycle teardown on `r` doesn't stop
		// reusable containers — see the reuse-if-healthy comment above.
		yield* claim(containerId);
		yield* addFinalizer(
			reuseScope,
			Effect.uninterruptible(
				spawner.exitCode(ChildProcess.make('docker', ['stop', containerId])).pipe(Effect.ignore),
			),
		);
		// Stream this fresh container's combined output through the
		// supervisor's sink (when supplied) until the reuseScope closes.
		yield* attachLogFollower(spawner, containerId, name, opts.onOutputLine, reuseScope);

		// Host-port report:
		//   - callback-driven recreate: the callback authored the binding,
		//     we passed it verbatim as `-p <bind>:<host>:<container>` to
		//     docker; report it back. Skips an `inspect` round-trip on the
		//     happy path.
		//   - auto-allocate recreate: docker chose an ephemeral host port,
		//     read the actual binding back via `inspect`.
		//   - normal `fresh`/`recreate`: caller's `opts.ports` were
		//     honored exactly.
		const hostPorts: Record<number, number> = useCallbackPorts
			? { ...(recreatePorts as Record<number, number>) }
			: useAutoAllocate
				? yield* inspectHostPorts(spawner, containerId)
				: { ...(opts.ports ?? {}) };
		return { containerId, name, reused: false, hostPorts };
	}).pipe(Effect.withSpan('Docker.run'));

// Spawn `docker logs --follow --since <epoch-secs> <id>` and pump every
// line through `cb`. No-op when `cb` is undefined. The follower is
// scope-managed: spawn happens inside `Effect.forkIn(scope)` so the
// fiber's interruption fires when `scope` closes; the spawner's own
// finalizer (registered via `addFinalizer` inside the forked Effect)
// then sends `docker logs` a SIGTERM. We also register a typed
// `docker.kill`-shaped finalizer as belt-and-suspenders so the
// foreground `docker logs` process tree gets cleaned up even when
// SIGTERM races a parent interrupt.
//
// We deliberately start with `--since <now>` so we don't re-emit the
// entire historical log buffer every time a container is adopted or
// resumed — only newly emitted lines flow through. On the fresh-run
// path that misses the first millisecond of output, but that's the
// same as what `docker logs -f` would emit on a tight race and is
// acceptable for the supervisor's narration role.
const attachLogFollower = (
	spawner: Spawner,
	containerId: string,
	displayName: string,
	cb: OutputLineCallback | undefined,
	scope: Scope,
): Effect.Effect<void, never> =>
	Effect.gen(function* () {
		if (cb === undefined) return;
		const sinceSecs = Math.floor(Date.now() / 1000).toString();
		const op = `docker logs -f ${displayName}`;
		// `Effect.forkIn(scope)` registers the cancellation on the
		// scope: the forked fiber gets interrupted (non-blocking) when
		// `scope` closes, the inner `Effect.scoped` then runs the
		// spawner's finalizer to SIGTERM the docker subprocess. We do
		// NOT add a manual `Fiber.interrupt` finalizer — that would
		// join on the drainer's natural exit (only when `docker logs
		// -f` itself closes), defeating the purpose of forking.
		yield* Effect.gen(function* () {
			const followCmd = ChildProcess.make(
				'docker',
				['logs', '-f', '--since', sinceSecs, containerId],
				{ killSignal: 'SIGTERM' },
			);
			const handle = yield* spawner.spawn(followCmd).pipe(Effect.mapError(dockerError(op)));
			yield* Effect.all(
				[
					drainLinesWithCallback(handle.stdout, 'info', cb).pipe(Effect.ignore),
					drainLinesWithCallback(handle.stderr, 'warn', cb).pipe(Effect.ignore),
					handle.exitCode.pipe(Effect.ignore),
				],
				{ concurrency: 'unbounded' },
			);
		}).pipe(
			Effect.scoped,
			Effect.catchCause(() => Effect.void),
			Effect.forkIn(scope),
		);
	}).pipe(Effect.catchCause(() => Effect.void));

// -----------------------------------------------------------------------------
// State machine — pure decision for `Docker.run`
// -----------------------------------------------------------------------------

/**
 * Shape passed into `decideRunAction`: what `docker inspect` told us
 * about a container with the requested name. Exported so tests can
 * construct one without indirecting through `inspectContainer`.
 */
export interface InspectResult {
	readonly running: boolean;
	readonly image: string;
	readonly containerId: string;
}

/**
 * What `Docker.run` should do given the result of an `inspect` probe
 * and the caller's requested image. Five logical states across the
 * inspect × image-match × running-state matrix collapse into four
 * action kinds; the fifth ("resume tried, `docker start` failed") is
 * a runtime PROMOTION done by the dispatcher: it constructs
 * `{ kind: 'recreate', existingId }` after the failed start and
 * continues. That keeps this function pure and easy to unit-test.
 */
export type RunAction =
	| { readonly kind: 'adopt'; readonly containerId: string }
	| { readonly kind: 'resume'; readonly containerId: string }
	| { readonly kind: 'recreate'; readonly existingId?: string }
	| { readonly kind: 'fresh' };

/**
 * Pure decision: which of the four `RunAction` kinds describes what
 * `Docker.run` should do for this `(inspected, requestedImage)` pair?
 *
 *   - `inspected === null`                 → `fresh`
 *   - same image, running                  → `adopt`
 *   - same image, stopped                  → `resume`
 *   - different image (running or stopped) → `recreate`
 */
export const decideRunAction = (
	inspected: InspectResult | null,
	requestedImage: string,
): RunAction => {
	if (inspected === null) return { kind: 'fresh' };
	if (inspected.image !== requestedImage) {
		return { kind: 'recreate', existingId: inspected.containerId };
	}
	if (inspected.running) return { kind: 'adopt', containerId: inspected.containerId };
	return { kind: 'resume', containerId: inspected.containerId };
};

interface BuildRunArgsInput {
	readonly detach: boolean;
	readonly name: string;
	readonly labels: ReadonlyArray<string>;
	readonly hostname?: string;
	readonly network?: string;
	readonly ip?: string;
	readonly networkAlias?: string;
	readonly addHosts: ReadonlyArray<string>;
	readonly portArgs: ReadonlyArray<string>;
	readonly envFiles?: ReadonlyArray<string>;
	readonly env?: Record<string, string>;
	readonly mounts?: ReadonlyArray<{ readonly host: string; readonly container: string }>;
	readonly image: string;
	readonly imageArgs?: ReadonlyArray<string>;
}

// Compose the `docker run` argv. Port flags are passed in pre-built so
// the `recreate` path can swap host-bound bindings for auto-allocated
// ones without duplicating the rest of the option assembly.
const buildRunArgs = (input: BuildRunArgsInput): Array<string> => {
	const out: Array<string> = ['run'];
	if (input.detach) out.push('-d');
	out.push('--name', input.name);
	for (const label of input.labels) {
		out.push('--label', label);
	}
	if (input.hostname !== undefined) out.push('--hostname', input.hostname);
	if (input.network !== undefined) out.push('--network', input.network);
	if (input.ip !== undefined) out.push(`--ip=${input.ip}`);
	if (input.networkAlias !== undefined) out.push('--network-alias', input.networkAlias);
	for (const entry of input.addHosts) {
		out.push(`--add-host=${entry}`);
	}
	for (const a of input.portArgs) {
		out.push(a);
	}
	for (const envFile of input.envFiles ?? []) {
		out.push('--env-file', envFile);
	}
	for (const [k, v] of Object.entries(input.env ?? {})) {
		out.push('-e', `${k}=${v}`);
	}
	for (const { host, container } of input.mounts ?? []) {
		out.push('-v', `${host}:${container}`);
	}
	out.push(input.image);
	for (const a of input.imageArgs ?? []) out.push(a);
	return out;
};

// -----------------------------------------------------------------------------
// Helpers — shared across the rest of the docker/ slice
// -----------------------------------------------------------------------------

// Resolved spawner shape. Exposed only locally so internal helpers don't
// need to spell out the index-into-class.
export type Spawner = ReturnType<typeof ChildProcessSpawner.make>;

// Shape returned by `runCapturing` (and re-exported as the `exec` result
// type since the docker `exec` wrapper surfaces all three pieces too).
export interface DockerExecResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

// Inspect a container by exact name and return its running-state +
// image + id, or `null` if no container by that name exists. Used by
// `Docker.run`'s reuse-if-healthy path to decide whether to adopt an
// existing container (running AND same image) or fall through to the
// remove-and-recreate path. The format string asks for all three
// fields in one shot so we avoid a second round-trip when only one
// matters; `docker inspect` returns exit code 1 with a `No such
// object` error on stderr when the container doesn't exist — we treat
// that uniformly as `null` so callers can branch on existence with one
// check. Result type is `InspectResult` so `decideRunAction` can match
// against it directly.
const inspectContainer = (
	spawner: Spawner,
	name: string,
): Effect.Effect<InspectResult | null, never> =>
	Effect.gen(function* () {
		const cmd = ChildProcess.make('docker', [
			'inspect',
			'--format',
			'{{.State.Running}}|{{.Config.Image}}|{{.Id}}',
			name,
		]);
		const captured = yield* runCapturing(spawner, cmd, 'docker inspect').pipe(
			Effect.catchTag('DockerError', () => Effect.succeed(null)),
		);
		if (captured === null || captured.exitCode !== 0) return null;
		const line = captured.stdout.trim();
		const parts = line.split('|');
		if (parts.length !== 3) return null;
		const [runningStr, image, containerId] = parts as [string, string, string];
		if (image.length === 0 || containerId.length === 0) return null;
		return { running: runningStr === 'true', image, containerId };
	});

// Read the host-port bindings of an existing container as
// `{ [hostPort]: containerPort }`. Used on resume to figure out which
// ports the container is ACTUALLY bound to (the caller's `opts.ports`
// arg is ignored by `docker start` — only `docker run` honors it).
// Returns an empty record on any inspect failure so callers can fall
// back to their caller-supplied ports.
type PortBindings = Record<string, ReadonlyArray<{ HostPort?: string }> | null>;

const parsePortBindings = (raw: string): Record<number, number> => {
	let parsed: PortBindings;
	try {
		parsed = JSON.parse(raw) as PortBindings;
	} catch {
		return {};
	}
	const out: Record<number, number> = {};
	for (const [key, bindings] of Object.entries(parsed)) {
		const containerPort = Number.parseInt(key.split('/')[0] ?? '', 10);
		if (!Number.isFinite(containerPort)) continue;
		if (bindings === null || bindings.length === 0) continue;
		const hostPortStr = bindings[0]?.HostPort;
		if (hostPortStr === undefined) continue;
		const hostPort = Number.parseInt(hostPortStr, 10);
		if (!Number.isFinite(hostPort)) continue;
		out[hostPort] = containerPort;
	}
	return out;
};

const inspectHostPorts = (
	spawner: Spawner,
	containerId: string,
): Effect.Effect<Record<number, number>, never> =>
	Effect.gen(function* () {
		// Two views, two inspect targets:
		//   1. `.NetworkSettings.Ports` — the runtime view, populated when
		//      the container is RUNNING. Shape:
		//        { "9000/tcp": [ { HostIp: "127.0.0.1", HostPort: "9001" } ] }
		//   2. `.HostConfig.PortBindings` — the config view, populated for
		//      both running and stopped containers but reflects what the
		//      caller ASKED FOR (not what docker actually granted; if
		//      docker assigned a different port via `-p 0:9000`, this
		//      view still shows the original request).
		//
		// Try (1) FIRST on the assumption that the container is running
		// (the common path for `inspectHostPorts` callers — adopt-on-warm-
		// start probes a healthy container). Fall back to (2) when the
		// runtime view is empty (stopped container). Reading (1) first
		// also catches the auto-allocate case (`-p 0:9000`) honestly —
		// (2) would return `0` whereas (1) returns the granted port.
		const runtimeCmd = ChildProcess.make('docker', [
			'inspect',
			'--format',
			'{{json .NetworkSettings.Ports}}',
			containerId,
		]);
		const runtimeCap = yield* runCapturing(spawner, runtimeCmd, 'docker inspect ports (runtime)').pipe(
			Effect.catchTag('DockerError', () => Effect.succeed(null)),
		);
		if (runtimeCap !== null && runtimeCap.exitCode === 0) {
			const raw = runtimeCap.stdout.trim();
			if (raw.length > 0 && raw !== 'null' && raw !== '{}') {
				const parsed = parsePortBindings(raw);
				if (Object.keys(parsed).length > 0) return parsed;
			}
		}
		// Fallback: config view (stopped container).
		const configCmd = ChildProcess.make('docker', [
			'inspect',
			'--format',
			'{{json .HostConfig.PortBindings}}',
			containerId,
		]);
		const configCap = yield* runCapturing(spawner, configCmd, 'docker inspect ports (config)').pipe(
			Effect.catchTag('DockerError', () => Effect.succeed(null)),
		);
		if (configCap === null || configCap.exitCode !== 0) return {};
		const raw = configCap.stdout.trim();
		if (raw.length === 0 || raw === 'null' || raw === '{}') return {};
		return parsePortBindings(raw);
	});

// Resolve a container's IP address on a specific docker network. Used
// by the router file-provider materialization: traefik dials backends
// by IP on the `devstack-router` network, and `docker network connect`
// is async — the new endpoint is registered with the daemon BEFORE
// the per-network IP is settled, so a naive single inspect can race.
//
// Retry the inspect with bounded backoff (defaults: 30 attempts × 100ms
// ≈ 3s) until the IPAddress field is non-empty. Returns the IP on
// success; fails with `DockerError` after exhausting attempts. Empty
// IP means docker hasn't assigned one yet on that network — wait and
// retry rather than papering over with a bogus URL.
const ROUTER_IP_RETRY_ATTEMPTS = 30;
const ROUTER_IP_RETRY_DELAY_MS = 100;

export const inspectContainerIp = (
	spawner: Spawner,
	containerId: string,
	networkName: string,
): Effect.Effect<string, DockerError> =>
	Effect.gen(function* () {
		const fmt = `{{(index .NetworkSettings.Networks "${networkName}").IPAddress}}`;
		const cmd = ChildProcess.make('docker', ['inspect', '--format', fmt, containerId]);
		for (let attempt = 0; attempt < ROUTER_IP_RETRY_ATTEMPTS; attempt++) {
			const captured = yield* runCapturing(spawner, cmd, 'docker inspect ip').pipe(
				Effect.catchTag('DockerError', () => Effect.succeed(null)),
			);
			if (captured !== null && captured.exitCode === 0) {
				const ip = captured.stdout.trim();
				// `docker inspect --format` substitutes the literal
				// `<no value>` when the named network isn't attached
				// (yet). Treat that identically to an empty IP and
				// retry; the network-connect side of the race is
				// usually a single-digit-ms window.
				if (ip.length > 0 && ip !== '<no value>') return ip;
			}
			if (attempt < ROUTER_IP_RETRY_ATTEMPTS - 1) {
				yield* Effect.sleep(`${ROUTER_IP_RETRY_DELAY_MS} millis`);
			}
		}
		return yield* Effect.fail(
			new DockerError({
				op: 'docker inspect ip',
				message:
					`failed to resolve IP for container ${containerId} on network ` +
					`'${networkName}' after ${ROUTER_IP_RETRY_ATTEMPTS} attempts (` +
					`${ROUTER_IP_RETRY_ATTEMPTS * ROUTER_IP_RETRY_DELAY_MS}ms total) — ` +
					`network attach did not settle`,
			}),
		);
	});

// Materialize the per-RouterLabel file-provider YAMLs for a container.
// Attaches the container to `devstack-router` (idempotent), resolves
// its IP on that network via `inspectContainerIp`, then writes one
// `<dynDir>/<id>.yml` per label and registers a finalizer on
// `reuseScope` to remove the YAML on scope teardown.
//
// No-op when `traefik` is undefined or empty so callers that don't
// want router exposure pay nothing.
//
// Best-effort across the entire flow: a `docker network connect`
// failure (e.g. already attached → exit 1, which is fine), an
// inspect-IP failure (network not settled within retry budget), or a
// YAML write failure (rare — `~/.devstack` perms) is logged but does
// NOT fail `Docker.run`. The container is up; direct-port debugging
// still works. The router just won't dispatch to it until next boot.
const materializeRouterEntries = (
	spawner: Spawner,
	containerId: string,
	traefik: ReadonlyArray<RouterLabel> | undefined,
	reuseScope: Scope,
): Effect.Effect<void, never> =>
	Effect.gen(function* () {
		const entries = traefik ?? [];
		if (entries.length === 0) return;
		yield* spawner
			.exitCode(ChildProcess.make('docker', ['network', 'connect', ROUTER_NETWORK, containerId]))
			.pipe(Effect.ignore);
		const ip: string | null = yield* inspectContainerIp(spawner, containerId, ROUTER_NETWORK).pipe(
			Effect.catch((cause: DockerError) =>
				Effect.logWarning(
					`devstack: router file-provider skipped for ${containerId} — ${cause.message}`,
				).pipe(Effect.as(null)),
			),
		);
		if (ip === null) return;
		for (const entry of entries) {
			const wrote: boolean = yield* writeFileProvider({
				id: entry.id,
				hostname: entry.hostname,
				entrypoint: entry.entrypoint,
				upstreamUrl: `http://${ip}:${entry.servicePort}`,
				cors: entry.cors,
			}).pipe(
				Effect.as(true),
				Effect.catch((cause: DockerError) =>
					Effect.logWarning(
						`devstack: router file-provider write failed for ${entry.id} — ${cause.message}`,
					).pipe(Effect.as(false)),
				),
			);
			if (!wrote) continue;
			yield* addFinalizer(reuseScope, removeFileProvider(entry.id));
		}
	});

// Idempotently create a named volume stamped with
// `devstack.app=<app>` / `devstack.stack=<stack>` so the wipe
// label-filter (`docker volume ls --filter label=devstack.stack=…`)
// can find + remove it later. `docker volume create` is itself
// idempotent for names that match WITH the same configuration, but
// the labels are only set on first create — so we probe with
// `docker volume inspect <name>` first and skip the create when the
// volume already exists (its labels were either set previously, or
// it's a pre-devstack legacy volume we can't safely re-label without
// destroying its contents). Best-effort: any docker failure here
// falls through to docker's lazy create at `docker run -v` time, so
// the worst case is one unlabeled volume — exactly the status quo
// this function is trying to avoid, never a hard failure.
const ensureLabeledVolume = (
	spawner: Spawner,
	name: string,
	app: string,
	stack: string,
): Effect.Effect<void, never> =>
	Effect.gen(function* () {
		const inspected = yield* runCapturing(
			spawner,
			ChildProcess.make('docker', ['volume', 'inspect', name]),
			'docker volume inspect',
		).pipe(Effect.catchTag('DockerError', () => Effect.succeed(null)));
		if (inspected !== null && inspected.exitCode === 0) {
			// Already exists; leave it alone. Re-stamping labels would
			// require `docker volume create --label … <name>` which is
			// a no-op when the volume exists, OR a recreate which would
			// destroy data — both wrong.
			return;
		}
		yield* runCapturing(
			spawner,
			ChildProcess.make('docker', [
				'volume',
				'create',
				'--label',
				`devstack.app=${app}`,
				'--label',
				`devstack.stack=${stack}`,
				name,
			]),
			'docker volume create',
		).pipe(Effect.ignore);
	});

// Force-remove a container by exact name if one exists. Returns `true` if
// docker reported a match, `false` otherwise. Used by `Docker.run` so a
// stale container from a crashed prior run doesn't make every restart
// fail with `Conflict. The container name "..." is already in use`.
const removeContainerIfExists = (
	spawner: Spawner,
	name: string,
): Effect.Effect<boolean, DockerError> =>
	Effect.gen(function* () {
		// `^/<name>$` anchors the docker filter regex so a substring match
		// against an unrelated container can't trigger an rm.
		const lsCmd = ChildProcess.make('docker', ['ps', '-a', '-q', '--filter', `name=^/${name}$`]);
		const ls = yield* runCapturing(spawner, lsCmd, 'docker ps');
		const ids = ls.stdout
			.split('\n')
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		if (ids.length === 0) return false;
		yield* Effect.logWarning(
			`devstack: removing stale container '${name}' from a prior run (id=${ids.join(',')})`,
		);
		for (const id of ids) {
			yield* spawner.exitCode(ChildProcess.make('docker', ['rm', '-f', id])).pipe(Effect.ignore);
		}
		return true;
	});

// Spawn a command and concurrently collect stdout / stderr / exit code into a
// uniform shape. Used by `exec` and `runOneShot` so the parent agent can read
// command output and decide what to do on a non-zero exit code without losing
// stderr to a Stream that was never drained.
export const captureStreams = runCapturing;

// Underlying impl shared by every docker wrapper. Spawns `cmd`, concurrently
// drains stdout + stderr, and resolves with all three pieces. Any error from
// the spawner itself (e.g. ENOENT for docker) becomes a `DockerError` with
// `cause` set — the caller decides whether `exitCode !== 0` is also fatal
// (it is for `run`/`pull`/`build`/`commit`/`save`; `exec` surfaces it
// verbatim so retry-on-nonzero callers like `awaitIndexerDbReady` can see
// pg_isready's exit codes).
export function runCapturing(
	spawner: Spawner,
	cmd: ChildProcess.Command,
	op: string,
): Effect.Effect<DockerExecResult, DockerError> {
	return Effect.scoped(
		Effect.gen(function* () {
			const handle = yield* spawner.spawn(cmd).pipe(Effect.mapError(dockerError(op)));
			const [stdoutText, stderrText, code] = yield* Effect.all(
				[
					decodeStream(handle.stdout).pipe(Effect.mapError(dockerError(op))),
					decodeStream(handle.stderr).pipe(Effect.mapError(dockerError(op))),
					handle.exitCode.pipe(Effect.mapError(dockerError(op))),
				],
				{ concurrency: 'unbounded' },
			);
			return {
				exitCode: code as number,
				stdout: stdoutText,
				stderr: stderrText,
			};
		}),
	);
}

// `runCapturing` variant that auto-fails when `exitCode !== 0`. Used by
// the wrappers that don't want to inspect a non-zero exit themselves and
// instead want a typed `DockerError` carrying stderr / stdout / exitCode.
// Returns the captured stdout on success.
export const runCapturingOrFail = (
	spawner: Spawner,
	cmd: ChildProcess.Command,
	op: string,
): Effect.Effect<string, DockerError> =>
	Effect.gen(function* () {
		const captured = yield* runCapturing(spawner, cmd, op);
		if (captured.exitCode !== 0) {
			return yield* Effect.fail(
				new DockerError({
					op,
					message: summarize(op, captured.exitCode, captured.stdout, captured.stderr),
					stdout: truncate(captured.stdout),
					stderr: truncate(captured.stderr),
					exitCode: captured.exitCode,
				}),
			);
		}
		return captured.stdout;
	});

// Drain a byte stream to a UTF-8 string. The spawner's `string` helper only
// covers stdout; we need both stdout and stderr for the `exec` shape, so
// drain each via Stream → mkString.
export const decodeStream = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
	Stream.mkString(Stream.decodeText(stream));

// -----------------------------------------------------------------------------
// Per-line output sink
// -----------------------------------------------------------------------------
//
// The supervisor needs to see step output (one-shot stdout/stderr,
// detached container `docker logs --follow`, host-process stdout/stderr)
// as it arrives, not only after the step exits. Each wrapper that
// touches a subprocess accepts an optional `OutputLineCallback`. The
// primitive owning the call (walrus.deploy, seal.*, host-process)
// captures the supervisor's `EngineHandle.appendLog` in a closure and
// passes it through — keeping the docker / host-process modules free of
// engine-layer dependencies.

/** stdout lines arrive as `'info'`, stderr lines as `'warn'`. */
export type OutputLineLevel = 'info' | 'warn';

/**
 * Per-line sink invoked from a streaming drain. The implementation
 * runs in the same fiber as the drain, so a callback that throws
 * synchronously OR fails its Effect will propagate. The wrappers below
 * defensively ignore the callback's errors so a flaky sink never
 * breaks a step that would otherwise succeed.
 */
export type OutputLineCallback = (
	level: OutputLineLevel,
	line: string,
) => Effect.Effect<void, never, never>;

// Drain a byte stream line-by-line, calling `cb` on each line AND
// concatenating the lines back into the final string so the existing
// `WalrusError({stderr, stdout})` shape still gets the whole output.
//
// `Stream.splitLines` handles the buffering across chunk boundaries
// so a `\n` split across two byte chunks doesn't get duplicated as
// two callback invocations.
export const drainLinesWithCallback = <E>(
	stream: Stream.Stream<Uint8Array, E>,
	level: OutputLineLevel,
	cb: OutputLineCallback,
): Effect.Effect<string, E> => {
	const lines = stream.pipe(
		Stream.decodeText(),
		Stream.splitLines,
		Stream.tap((line) => cb(level, line).pipe(Effect.ignore)),
	);
	return Stream.runFold(
		lines,
		() => '',
		(acc, line) => (acc.length === 0 ? line : `${acc}\n${line}`),
	);
};

// Docker rejects names that don't start with `[a-zA-Z0-9]`; prefix keeps the
// names easy to spot in `docker ps`.
export const generateContainerName = (): string =>
	`devstack-${Math.random().toString(36).slice(2, 10)}`;

// `{app}-{stack}-{primitiveName}` (or `{app}-{primitiveName}` when `stack`
// is the default `'main'`). With `network !== 'localnet'`, a `-${network}`
// suffix is appended to the project portion so the same `<app, stack>`
// against testnet doesn't collide on container names with the same pair
// against localnet. Periods inside the user-supplied primitive name
// are folded to hyphens so a name like `sui.localnet` reads as
// `template-sui-localnet` in `docker ps`. Empty `app` (engine never
// reached) collapses to the bare primitiveName so the failure mode is
// still legible.
export const composeContainerName = (
	app: string,
	stack: string,
	network: string,
	primitiveName: string,
): string => {
	const flat = primitiveName.replaceAll('.', '-');
	const project = composeProjectName(app, stack, network);
	if (project.length === 0) return flat;
	return `${project}-${flat}`;
};

// `{app}` for the default `<stack='main', network='localnet'>`,
// `{app}-{stack}` when only `stack` deviates, `{app}-{network}` when only
// `network` deviates, and `{app}-{stack}-{network}` when both do. Matches
// the project-naming convention docker-compose uses when no explicit
// `--project-name` is passed (the directory), extended with a `network`
// suffix so we can run the same stack against testnet AND localnet
// concurrently without container/volume name collisions. The
// `network='localnet'` default is byte-identical to the pre-network shape
// so warm-restart resumes still adopt existing containers. Empty `app`
// falls back to the empty string so callers can detect the engine-not-
// reached case and use a bare primitive name.
export const composeProjectName = (app: string, stack: string, network: string): string => {
	if (app.length === 0) return '';
	const base = stack === 'main' ? app : `${app}-${stack}`;
	return network === 'localnet' ? base : `${base}-${network}`;
};
