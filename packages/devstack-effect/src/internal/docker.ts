// Effect-flavored thin wrapper around the `docker` CLI.
//
// Ported from `packages/devstack/src/runners/docker-container.ts` (and
// docker-image.ts / docker-network.ts) but adapted to Effect v4 idioms:
//
//   - Subprocess work goes through `effect/unstable/process`'s
//     `ChildProcessSpawner` (Node binding provided upstream by the
//     `NodeChildProcessSpawner` layer).
//   - Long-running resources (`run`, `networkCreate`) register a
//     `Scope.addFinalizer` so the engine's reverse-topo shutdown order
//     keeps containers cleaned up before networks.
//   - All failures funnel through a single tagged `DockerError`.

import { isAbsolute, resolve } from 'node:path';
import { Context, Effect, Ref, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { addFinalizer, type Scope } from 'effect/Scope';
import { DockerError } from '../primitives/errors.js';
import { Identity } from './identity.js';
import { LongLivedScope } from './long-lived-scope.js';

// Set of container IDs this process has adopted-or-created. Populated by
// `Docker.run` (both the reuse-if-healthy path and the fresh-create path)
// and read by `dockerOrphanSweep` after `Layer.build` to identify which
// compose-project-labelled containers belong to primitives that were
// REMOVED from the config since the last run. Default `undefined` so
// standalone callers (tests, ad-hoc `Docker.run` outside a devstack)
// stay unaffected by this tracking.
export const ClaimedContainers = Context.Reference<Ref.Ref<Set<string>> | undefined>(
	'@devstack/ClaimedContainers',
	{ defaultValue: () => undefined },
);

export { DockerError };

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

// Cap captured stdout/stderr to keep oversized progress dumps (e.g. docker
// pull layer streams) from drowning the rest of the error message. 1KB is
// enough to surface a daemon error like "Cannot connect to the Docker daemon
// at unix:///var/run/docker.sock" or "Error response from daemon: ... port
// is already allocated" without becoming the whole message body.
const STREAM_TRUNC_BYTES = 1024;

const truncate = (s: string): string =>
	s.length > STREAM_TRUNC_BYTES ? `${s.slice(0, STREAM_TRUNC_BYTES)}…[truncated]` : s;

// Compose the short summary line that lands in `DockerError.message`. We
// fold exitCode/stderr into the summary so consumers that only print
// `error.message` (the default in most logs) see WHY docker failed without
// needing to inspect the structured fields.
const summarize = (
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

const dockerError =
	(op: string) =>
	(cause: unknown): DockerError =>
		new DockerError({
			op,
			message: op,
			cause,
		});

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
}

export interface DockerRunResult {
	readonly containerId: string;
	readonly name: string;
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
		const name = composeContainerName(identity.app, identity.stack, primitiveName);
		// Compose project label so Docker Desktop groups all containers
		// from this `<app, stack>` together in the UI even though we
		// don't actually use docker-compose. Mirrors `docker compose`'s
		// default project naming (the directory) — just the app for the
		// `main` stack, app-stack for everything else.
		const composeProject = composeProjectName(identity.app, identity.stack);
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
		const labels: ReadonlyArray<string> = [
			`devstack.app=${identity.app}`,
			`devstack.stack=${identity.stack}`,
			`devstack.action=${primitiveName}`,
			`com.docker.compose.project=${composeProject}`,
			`com.docker.compose.service=${primitiveName}`,
			`com.docker.compose.container-number=1`,
			`com.docker.compose.version=2.0.0`,
			`com.docker.compose.oneoff=False`,
		];

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
		const addHosts = opts.addHosts ?? ['host.docker.internal:host-gateway'];
		const bindAddress = opts.bindAddress ?? '127.0.0.1';

		const args: Array<string> = ['run'];
		if (detach) args.push('-d');
		args.push('--name', name);
		for (const label of labels) {
			args.push('--label', label);
		}
		if (opts.hostname !== undefined) args.push('--hostname', opts.hostname);
		if (opts.network !== undefined) args.push('--network', opts.network);
		if (opts.ip !== undefined) args.push(`--ip=${opts.ip}`);
		if (opts.networkAlias !== undefined) args.push('--network-alias', opts.networkAlias);
		for (const entry of addHosts) {
			args.push(`--add-host=${entry}`);
		}
		for (const [hostPort, containerPort] of Object.entries(opts.ports ?? {})) {
			args.push('-p', `${bindAddress}:${hostPort}:${containerPort}`);
		}
		for (const envFile of opts.envFiles ?? []) {
			args.push('--env-file', envFile);
		}
		for (const [k, v] of Object.entries(opts.env ?? {})) {
			args.push('-e', `${k}=${v}`);
		}
		for (const { host, container } of opts.mounts ?? []) {
			args.push('-v', `${host}:${container}`);
		}
		args.push(opts.image);
		for (const a of opts.args ?? []) args.push(a);

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
			claimedRef === undefined
				? Effect.void
				: Ref.update(claimedRef, (s) => new Set(s).add(id));

		const inspected = yield* inspectContainer(spawner, name);
		if (inspected !== null) {
			if (inspected.running && inspected.image === opts.image) {
				yield* Effect.logInfo(`devstack: reusing existing container '${name}'`);
				yield* Effect.annotateCurrentSpan({
					'docker.op': 'run',
					'docker.name': name,
					'docker.reused': true,
				});
				yield* claim(inspected.containerId);
				yield* addFinalizer(
					reuseScope,
					Effect.uninterruptible(
						spawner
							.exitCode(ChildProcess.make('docker', ['rm', '-f', inspected.containerId]))
							.pipe(Effect.ignore),
					),
				);
				return { containerId: inspected.containerId, name };
			}
			// Stale (not running) or wrong image — fall through to the
			// orphan-sweep + recreate path below.
		}

		// Per-primitive orphan sweep. A prior process killed mid-cycle
		// (SIGKILL, panic) can leave a same-named container lying around;
		// docker rejects `run --name` collisions, so without this step
		// every restart after a hard crash fails immediately. Force-remove
		// is safer than reuse here — the inspect probe above already
		// claimed the reuse path when health + image matched, so anything
		// reaching this point is known-incompatible. Best-effort: a
		// failure here just falls through and lets `docker run` surface
		// the real reason.
		yield* removeContainerIfExists(spawner, name).pipe(Effect.ignore);

		const cmd = ChildProcess.make('docker', args);
		yield* Effect.annotateCurrentSpan({ 'docker.op': 'run', 'docker.name': name });

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

		// Best-effort `docker rm -f` on scope close. Tolerate failure here
		// because the container may have already exited / been removed by
		// `--rm` or by a competing teardown — wedging the scope close on a
		// stale container would block the rest of the engine shutdown.
		// `Effect.uninterruptible` is essential: scope teardown fires under
		// fiber interruption (SIGINT path), and without it the rm subprocess
		// gets killed mid-flight, leaving the container running.
		//
		// Registered on the `LongLivedScope` (when provided by
		// `defineDevstack`) so per-cycle teardown on `r` doesn't kill
		// reusable containers — see the reuse-if-healthy comment above.
		yield* claim(containerId);
		yield* addFinalizer(
			reuseScope,
			Effect.uninterruptible(
				spawner.exitCode(ChildProcess.make('docker', ['rm', '-f', containerId])).pipe(Effect.ignore),
			),
		);

		return { containerId, name };
	}).pipe(Effect.withSpan('Docker.run'));

// -----------------------------------------------------------------------------
// Pull — ensure image present, return digest
// -----------------------------------------------------------------------------

export interface DockerPullResult {
	readonly digest: string;
}

export const pull = (
	image: string,
): Effect.Effect<DockerPullResult, DockerError, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		yield* Effect.annotateCurrentSpan({ 'docker.image': image });

		yield* runCapturingOrFail(
			spawner,
			ChildProcess.make('docker', ['pull', image]),
			'docker pull',
		);

		const stdout = yield* runCapturingOrFail(
			spawner,
			ChildProcess.make('docker', ['image', 'inspect', '-f', '{{.Id}}', image]),
			'docker image inspect',
		);

		const digest = stdout.trim();
		if (digest.length === 0) {
			return yield* Effect.fail(
				new DockerError({
					op: 'docker pull',
					message: `docker image inspect returned empty digest for ${image}`,
				}),
			);
		}
		return { digest };
	}).pipe(Effect.withSpan('Docker.pull'));

// -----------------------------------------------------------------------------
// Build — build an image from a local context, return tag + digest
// -----------------------------------------------------------------------------

export interface DockerBuildOptions {
	readonly context: string;
	readonly dockerfile?: string;
	readonly buildArgs?: Record<string, string>;
	readonly platform?: string;
	readonly tag: string;
}

export interface DockerBuildResult {
	readonly tag: string;
	readonly digest: string;
}

export const build = (
	opts: DockerBuildOptions,
): Effect.Effect<DockerBuildResult, DockerError, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		yield* Effect.annotateCurrentSpan({ 'docker.op': 'build', 'docker.tag': opts.tag });

		const args: Array<string> = ['build', '--tag', opts.tag];
		if (opts.platform !== undefined) args.push('--platform', opts.platform);
		for (const [k, v] of Object.entries(opts.buildArgs ?? {})) {
			args.push('--build-arg', `${k}=${v}`);
		}
		// Resolve `dockerfile` to an absolute path. BuildKit (the default
		// builder on modern Docker Desktop) looks `-f <path>` up relative
		// to the CLI's CWD, not the build context — passing the bare name
		// `'Dockerfile'` from a CWD that doesn't contain one fails with
		// `failed to read dockerfile: open Dockerfile: no such file or
		// directory` even though the file lives inside `context`. v3's
		// runner did the same resolve; we mirror it here.
		if (opts.dockerfile !== undefined) {
			const dfAbs = isAbsolute(opts.dockerfile)
				? opts.dockerfile
				: resolve(opts.context, opts.dockerfile);
			args.push('-f', dfAbs);
		}
		args.push(opts.context);

		yield* runCapturingOrFail(spawner, ChildProcess.make('docker', args), 'docker build');

		const stdout = yield* runCapturingOrFail(
			spawner,
			ChildProcess.make('docker', ['image', 'inspect', '-f', '{{.Id}}', opts.tag]),
			'docker image inspect',
		);

		const digest = stdout.trim();
		if (digest.length === 0) {
			return yield* Effect.fail(
				new DockerError({
					op: 'docker build',
					message: `docker image inspect returned empty digest for ${opts.tag}`,
				}),
			);
		}
		return { tag: opts.tag, digest };
	}).pipe(Effect.withSpan('Docker.build'));

// -----------------------------------------------------------------------------
// followLogs — stream `docker logs -f <id>` as decoded lines
// -----------------------------------------------------------------------------

// Follow a running container's combined stdout/stderr as a line stream. Used
// by primitives that wire a `log` readyProbe against a detached container —
// `docker run -d` doesn't give us a stdout stream directly, so we shell out
// to `docker logs -f` and decode the bytes. Errors from the underlying
// spawner are dropped into defects: a probe whose log feed has died can't
// recover, so surfacing it as a typed error wouldn't help the caller.
export const followLogs = (
	containerId: string,
): Stream.Stream<string, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Stream.unwrap(
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const cmd = ChildProcess.make('docker', ['logs', '-f', containerId]);
			// Spawn failure / stdout pipe failure go to defects — a probe
			// whose log feed died can't recover, so a typed error wouldn't
			// help the caller.
			const handle = yield* Effect.orDie(spawner.spawn(cmd));
			return Stream.splitLines(Stream.decodeText(Stream.orDie(handle.stdout)));
		}),
	);

// -----------------------------------------------------------------------------
// Exec — run a command inside a running container
// -----------------------------------------------------------------------------

export interface DockerExecResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

export const exec = (
	containerId: string,
	command: string,
	args: ReadonlyArray<string> = [],
): Effect.Effect<DockerExecResult, DockerError, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		yield* Effect.annotateCurrentSpan({ 'docker.container': containerId, 'docker.cmd': command });

		const cmd = ChildProcess.make('docker', ['exec', containerId, command, ...args]);
		return yield* captureStreams(spawner, cmd, 'docker exec');
	}).pipe(Effect.withSpan('Docker.exec'));

// Internal helper type alias for the resolved spawner shape. Exposed only
// locally so internal helpers don't need to spell out the index-into-class.
type Spawner = ReturnType<typeof ChildProcessSpawner.make>;

// -----------------------------------------------------------------------------
// Network create — Scope-managed
// -----------------------------------------------------------------------------

export const networkCreate = (
	name: string,
	options?: {
		readonly subnet?: string;
		readonly gateway?: string;
		/** Compose-project label so Docker Desktop groups the network with its containers. */
		readonly composeProject?: string;
	},
): Effect.Effect<string, DockerError, ChildProcessSpawner.ChildProcessSpawner | Identity | Scope> =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const identity = yield* Identity;
		const scope = yield* Effect.scope;
		yield* Effect.annotateCurrentSpan({ 'docker.network': name });

		// Idempotent: if a network with this name already exists (left over
		// from a prior run that didn't clean up), reuse it instead of
		// failing. Same finalizer wires up either way.
		const existing = yield* runCapturing(
			spawner,
			ChildProcess.make('docker', ['network', 'ls', '-q', '--filter', `name=^${name}$`]),
			'docker network ls',
		);
		if (existing.stdout.trim().length > 0) {
			yield* addFinalizer(
				scope,
				Effect.uninterruptible(
					spawner.exitCode(ChildProcess.make('docker', ['network', 'rm', name])).pipe(Effect.ignore),
				),
			);
			return name;
		}

		// Build the create argv. With a `subnet` we hand docker an explicit
		// IPAM pin (and optional `--gateway`) so sibling containers in the
		// stack can claim fixed IPs via `Docker.run({ ip })`. Without one we
		// fall back to docker's default bridge IPAM.
		//
		// Compose labels mirror what `docker compose up` stamps on a
		// project network — verified via `docker inspect` against a real
		// compose-managed network. Docker Desktop's UI groups the network
		// under the same project entry as the containers when the full
		// label set is present (project + network + version).
		const createArgs: Array<string> = ['network', 'create'];
		const composeProject =
			options?.composeProject ?? composeProjectName(identity.app, identity.stack);
		createArgs.push('--label', `com.docker.compose.project=${composeProject}`);
		createArgs.push('--label', `com.docker.compose.network=${name}`);
		createArgs.push('--label', `com.docker.compose.version=2.0.0`);
		createArgs.push('--label', `devstack.app=${identity.app}`);
		createArgs.push('--label', `devstack.stack=${identity.stack}`);
		if (options?.subnet !== undefined) {
			createArgs.push('--subnet', options.subnet);
			if (options.gateway !== undefined) {
				createArgs.push('--gateway', options.gateway);
			}
		}
		createArgs.push(name);

		yield* runCapturingOrFail(
			spawner,
			ChildProcess.make('docker', createArgs),
			'docker network create',
		);

		yield* addFinalizer(
			scope,
			Effect.uninterruptible(
				spawner.exitCode(ChildProcess.make('docker', ['network', 'rm', name])).pipe(
					// `network rm` fails with "active endpoints" if any container
					// is still attached. Reverse-topo shutdown order normally
					// drains them first, but a process killed mid-cycle can race.
					// Leave the network for `docker network prune` to GC rather
					// than wedge teardown.
					Effect.ignore,
				),
			),
		);

		return name;
	}).pipe(Effect.withSpan('Docker.networkCreate'));

// -----------------------------------------------------------------------------
// commitContainer — snapshot a running container into a new image
// -----------------------------------------------------------------------------

export interface DockerCommitResult {
	readonly digest: string;
}

// `docker commit <containerId> <imageName>` freezes the container's RW layer
// into a new image. We then `docker image inspect` to surface the resulting
// digest (same pattern as `pull` / `build`) so callers can record what they
// captured.
export const commitContainer = (
	containerId: string,
	imageName: string,
): Effect.Effect<DockerCommitResult, DockerError, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		yield* Effect.annotateCurrentSpan({
			'docker.op': 'commit',
			'docker.container': containerId,
			'docker.image': imageName,
		});

		yield* runCapturingOrFail(
			spawner,
			ChildProcess.make('docker', ['commit', containerId, imageName]),
			'docker commit',
		);

		const stdout = yield* runCapturingOrFail(
			spawner,
			ChildProcess.make('docker', ['image', 'inspect', '-f', '{{.Id}}', imageName]),
			'docker image inspect',
		);

		const digest = stdout.trim();
		if (digest.length === 0) {
			return yield* Effect.fail(
				new DockerError({
					op: 'docker commit',
					message: `docker image inspect returned empty digest for ${imageName}`,
				}),
			);
		}
		return { digest };
	}).pipe(Effect.withSpan('Docker.commitContainer'));

// -----------------------------------------------------------------------------
// saveImage — serialize an image to a tar on disk
// -----------------------------------------------------------------------------

// `docker save <image> -o <tar>` writes the image (including all layers) to a
// portable tar archive. Used by snapshot to persist committed container state.
export const saveImage = (
	imageName: string,
	tarPath: string,
): Effect.Effect<void, DockerError, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		yield* Effect.annotateCurrentSpan({
			'docker.op': 'save',
			'docker.image': imageName,
			'docker.tarPath': tarPath,
		});

		yield* runCapturingOrFail(
			spawner,
			ChildProcess.make('docker', ['save', imageName, '-o', tarPath]),
			'docker save',
		);
	}).pipe(Effect.withSpan('Docker.saveImage'));

// -----------------------------------------------------------------------------
// loadImage — reverse of saveImage; restore image from tar
// -----------------------------------------------------------------------------

export interface DockerLoadResult {
	readonly tag: string;
}

// `docker load -i <tar>` writes the image back into the local daemon and
// prints e.g. `Loaded image: devstack-snap:abc-foo`. We parse the tag out of
// that line so the caller can re-run a container off it. If the daemon emits
// a digest-only message (no tag) the load still succeeds but we surface a
// typed error — callers always want a tag they can pass to `docker run`.
export const loadImage = (
	tarPath: string,
): Effect.Effect<DockerLoadResult, DockerError, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		yield* Effect.annotateCurrentSpan({ 'docker.op': 'load', 'docker.tarPath': tarPath });

		const stdout = yield* runCapturingOrFail(
			spawner,
			ChildProcess.make('docker', ['load', '-i', tarPath]),
			'docker load',
		);

		// Output looks like `Loaded image: devstack-snap:abc-foo` (possibly
		// across multiple lines if the tar carries several images — take the
		// first matching tag line).
		const match = stdout
			.split('\n')
			.map((line) => line.trim())
			.map((line) => /^Loaded image(?: ID)?:\s*(.+)$/.exec(line))
			.find((m): m is RegExpExecArray => m !== null);

		if (!match) {
			return yield* Effect.fail(
				new DockerError({
					op: 'docker load',
					message: `docker load produced no "Loaded image:" line for ${tarPath} (stdout=${stdout})`,
				}),
			);
		}
		return { tag: match[1] };
	}).pipe(Effect.withSpan('Docker.loadImage'));

// -----------------------------------------------------------------------------
// runOneShot — run to completion, capture stdout
// -----------------------------------------------------------------------------

export interface DockerOneShotOptions {
	readonly name?: string;
	readonly image: string;
	readonly args?: ReadonlyArray<string>;
	readonly env?: Record<string, string>;
	readonly mounts?: ReadonlyArray<{ readonly host: string; readonly container: string }>;
	readonly network?: string;
	/** Override the image's `ENTRYPOINT`. Maps to `docker run --entrypoint`.
	 * Use for images with a default `ENTRYPOINT` you want to bypass (e.g.
	 * an image whose default is the long-running daemon, but you want to
	 * run a CLI co-installed in the same image for a one-shot setup). */
	readonly entrypoint?: string;
	/**
	 * Wall-clock budget for the entire `docker run` invocation. On expiry the
	 * scope closes and the spawner's finalizer SIGTERMs the foreground
	 * `docker` CLI, then SIGKILLs after `gracePeriodMs` if it hasn't exited.
	 * We additionally fire a best-effort `docker rm -f <name>` so a workload
	 * left behind by a racing SIGKILL still gets torn down — `--rm` cleanup
	 * isn't guaranteed if the foreground CLI dies before it runs. Defaults
	 * to 10 minutes, matching the v3 runner.
	 */
	readonly timeoutMs?: number;
	/**
	 * Grace period between SIGTERM and the fallback SIGKILL when the scope
	 * closes (either because the timeout fired or because an outer scope was
	 * interrupted). Defaults to 5_000 ms, matching v3.
	 */
	readonly gracePeriodMs?: number;
}

export interface DockerOneShotResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

const DEFAULT_ONE_SHOT_TIMEOUT_MS = 600_000;
const DEFAULT_ONE_SHOT_GRACE_PERIOD_MS = 5_000;

export const runOneShot = (
	opts: DockerOneShotOptions,
): Effect.Effect<DockerOneShotResult, DockerError, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

		const name = opts.name ?? generateContainerName();
		const args: Array<string> = ['run', '--rm', '--name', name];
		if (opts.entrypoint !== undefined) args.push('--entrypoint', opts.entrypoint);
		if (opts.network !== undefined) args.push('--network', opts.network);
		for (const [k, v] of Object.entries(opts.env ?? {})) {
			args.push('-e', `${k}=${v}`);
		}
		for (const { host, container } of opts.mounts ?? []) {
			args.push('-v', `${host}:${container}`);
		}
		args.push(opts.image);
		for (const a of opts.args ?? []) args.push(a);

		const timeoutMs = opts.timeoutMs ?? DEFAULT_ONE_SHOT_TIMEOUT_MS;
		const gracePeriodMs = opts.gracePeriodMs ?? DEFAULT_ONE_SHOT_GRACE_PERIOD_MS;

		yield* Effect.annotateCurrentSpan({
			'docker.op': 'runOneShot',
			'docker.name': name,
			'docker.timeoutMs': timeoutMs,
			'docker.gracePeriodMs': gracePeriodMs,
		});

		// Wire TERM-then-KILL escalation onto the command itself: the
		// spawner's scope finalizer reads `killSignal` / `forceKillAfter` to
		// decide how to tear down the child when the inner `Effect.scoped`
		// closes (because we resolved normally, because the timeout below
		// interrupted us, or because an outer scope closed). We also stage
		// a `docker rm -f <name>` finalizer so a daemon-side container that
		// outlived a SIGKILL'd foreground CLI still gets reaped.
		const op = 'docker run (one-shot)';
		const cmd = ChildProcess.make('docker', args, {
			killSignal: 'SIGTERM',
			forceKillAfter: `${gracePeriodMs} millis`,
		});

		const work = Effect.scoped(
			Effect.gen(function* () {
				const scope = yield* Effect.scope;
				yield* addFinalizer(
					scope,
					spawner.exitCode(ChildProcess.make('docker', ['rm', '-f', name])).pipe(Effect.ignore),
				);
				const handle = yield* spawner.spawn(cmd).pipe(Effect.mapError(dockerError(op)));
				const [stdoutText, stderrText, code] = yield* Effect.all(
					[
						decodeStream(handle.stdout).pipe(Effect.mapError(dockerError(op))),
						decodeStream(handle.stderr).pipe(Effect.mapError(dockerError(op))),
						handle.exitCode.pipe(Effect.mapError(dockerError(op))),
					],
					{ concurrency: 'unbounded' },
				);
				return { exitCode: code as number, stdout: stdoutText, stderr: stderrText };
			}),
		);

		return yield* work.pipe(
			Effect.timeoutOrElse({
				duration: `${timeoutMs} millis`,
				orElse: () =>
					Effect.fail(
						new DockerError({
							op,
							message: `docker run (one-shot) '${name}' timed out after ${timeoutMs}ms`,
						}),
					),
			}),
		);
	}).pipe(Effect.withSpan('Docker.runOneShot'));

// -----------------------------------------------------------------------------
// Startup orphan sweep
// -----------------------------------------------------------------------------

// Post-`Layer.build` orphan sweep. Enumerates every container labelled with
// this stack's compose-project tag and `docker rm -f`s any that the current
// process did NOT adopt-or-create (i.e. its `containerId` is absent from
// the `claimed` set). Called once per `defineDevstack.run` cycle AFTER the
// layer build, so `Docker.run`'s reuse-if-healthy probe has had its chance
// to adopt prior-process containers whose primitives are still in the
// config. Anything left over belongs to a primitive that was REMOVED from
// the config since the last run, or was orphaned by a crashed prior
// process (SIGKILL → finalizers didn't fire) — both safe to reap.
//
// Best-effort throughout — a `docker` daemon that's unreachable returns
// an empty list and we proceed; the run path will surface a real error
// if docker is actually down.
//
// Pre-build sweeping is the WRONG layering: it nukes still-healthy
// containers (e.g. `sui.localnet` from a previous process) BEFORE
// `Docker.run` gets a chance to adopt them, which forces a fresh Sui
// genesis → new chain id → publishMove cache miss → NEW packageId on
// every process restart. Moving the sweep to post-build is the fix.
export const dockerOrphanSweep = (
	app: string,
	stack: string,
	claimed: ReadonlySet<string>,
): Effect.Effect<ReadonlyArray<string>, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const composeProject = composeProjectName(app, stack);
		const lsCmd = ChildProcess.make('docker', [
			'ps',
			'-aq',
			'--filter',
			`label=com.docker.compose.project=${composeProject}`,
		]);
		const idsText = yield* spawner.string(lsCmd).pipe(Effect.catch(() => Effect.succeed('')));
		const ids = idsText
			.split('\n')
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		const removed: Array<string> = [];
		for (const id of ids) {
			// `docker ps -q` emits short ids (12 chars); `Docker.run` records
			// FULL ids (64 hex). Match by short-form prefix so the claim set
			// can be checked against either form without needing a second
			// `inspect` per container.
			const isClaimed = (() => {
				for (const c of claimed) {
					if (c === id || c.startsWith(id) || id.startsWith(c)) return true;
				}
				return false;
			})();
			if (isClaimed) continue;
			const ok = yield* spawner
				.exitCode(ChildProcess.make('docker', ['rm', '-f', id]))
				.pipe(
					Effect.map(() => true),
					Effect.catch(() => Effect.succeed(false)),
				);
			if (ok) removed.push(id);
		}

		// Orphan networks left by a prior process killed mid-cycle — the
		// network's `rm` finalizer never ran, so a fresh `network create`
		// at the same `--subnet` fails with "Pool overlaps with other one
		// on this address space" even though no container is attached.
		// Filter on the same compose-project label `Docker.networkCreate`
		// stamps. Best-effort throughout.
		const lsNetCmd = ChildProcess.make('docker', [
			'network',
			'ls',
			'-q',
			'--filter',
			`label=com.docker.compose.project=${composeProject}`,
		]);
		const netIdsText = yield* spawner.string(lsNetCmd).pipe(Effect.catch(() => Effect.succeed('')));
		const netIds = netIdsText
			.split('\n')
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		for (const id of netIds) {
			const ok = yield* spawner
				.exitCode(ChildProcess.make('docker', ['network', 'rm', id]))
				.pipe(
					Effect.map(() => true),
					Effect.catch(() => Effect.succeed(false)),
				);
			if (ok) removed.push(id);
		}
		return removed as ReadonlyArray<string>;
	}).pipe(Effect.withSpan('Docker.orphanSweep'));

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

// Inspect a container by exact name and return its running-state +
// image + id, or `null` if no container by that name exists. Used by
// `Docker.run`'s reuse-if-healthy path to decide whether to adopt an
// existing container (running AND same image) or fall through to the
// remove-and-recreate path. The format string asks for all three
// fields in one shot so we avoid a second round-trip when only one
// matters; `docker inspect` returns exit code 1 with a `No such
// object` error on stderr when the container doesn't exist — we treat
// that uniformly as `null` so callers can branch on existence with one
// check.
interface InspectedContainer {
	readonly running: boolean;
	readonly image: string;
	readonly containerId: string;
}

const inspectContainer = (
	spawner: Spawner,
	name: string,
): Effect.Effect<InspectedContainer | null, never> =>
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
		const lsCmd = ChildProcess.make('docker', [
			'ps',
			'-a',
			'-q',
			'--filter',
			`name=^/${name}$`,
		]);
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
			yield* spawner
				.exitCode(ChildProcess.make('docker', ['rm', '-f', id]))
				.pipe(Effect.ignore);
		}
		return true;
	});

// Spawn a command and concurrently collect stdout / stderr / exit code into a
// uniform shape. Used by `exec` and `runOneShot` so the parent agent can read
// command output and decide what to do on a non-zero exit code without losing
// stderr to a Stream that was never drained.
const captureStreams = runCapturing;

// Underlying impl shared by every docker wrapper. Spawns `cmd`, concurrently
// drains stdout + stderr, and resolves with all three pieces. Any error from
// the spawner itself (e.g. ENOENT for docker) becomes a `DockerError` with
// `cause` set — the caller decides whether `exitCode !== 0` is also fatal
// (it is for `run`/`pull`/`build`/`commit`/`save`; `exec` surfaces it
// verbatim so retry-on-nonzero callers like `awaitIndexerDbReady` can see
// pg_isready's exit codes).
function runCapturing(
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
const runCapturingOrFail = (
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
const decodeStream = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
	Stream.mkString(Stream.decodeText(stream));

// Docker rejects names that don't start with `[a-zA-Z0-9]`; prefix keeps the
// names easy to spot in `docker ps`.
const generateContainerName = (): string => `devstack-${Math.random().toString(36).slice(2, 10)}`;

// `{app}-{stack}-{primitiveName}` (or `{app}-{primitiveName}` when `stack`
// is the default `'main'`). Periods inside the user-supplied primitive name
// are folded to hyphens so a name like `sui.localnet` reads as
// `template-sui-localnet` in `docker ps`. Empty `app` (engine never
// reached) collapses to the bare primitiveName so the failure mode is
// still legible.
export const composeContainerName = (
	app: string,
	stack: string,
	primitiveName: string,
): string => {
	const flat = primitiveName.replaceAll('.', '-');
	const project = composeProjectName(app, stack);
	if (project.length === 0) return flat;
	return `${project}-${flat}`;
};

// `{app}` for the default `'main'` stack, `{app}-{stack}` for everything
// else. Matches the project-naming convention docker-compose uses when no
// explicit `--project-name` is passed (the directory). Empty `app` falls
// back to the empty string so callers can detect the engine-not-reached
// case and use a bare primitive name.
export const composeProjectName = (app: string, stack: string): string => {
	if (app.length === 0) return '';
	return stack === 'main' ? app : `${app}-${stack}`;
};
