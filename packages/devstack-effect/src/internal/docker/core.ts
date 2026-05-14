// `Docker.run` + the spawner/error helpers shared across every command
// in this directory. Other slices (image, exec, network, logs, sweep)
// import the helpers from here so the error envelope + stream draining
// stay uniform.

import { Effect, Ref } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { addFinalizer, type Scope } from 'effect/Scope';
import { DockerError } from '../../primitives/errors.js';
import { Identity } from '../identity.js';
import { LongLivedScope } from '../long-lived-scope.js';
import { ClaimedContainers } from './sweep.js';
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
	/**
	 * `true` when `Docker.run` adopted an already-healthy container with
	 * the matching image rather than spawning a fresh one. Lets callers
	 * skip expensive ready-probes on warm restarts — e.g. `suiLocalnet`
	 * sends a real funding tx as its faucet probe (so we don't race
	 * warm-up on cold boots), but that's wasteful when the container
	 * has been up for hours and is verifiably healthy already.
	 */
	readonly reused: boolean;
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
		if (inspected !== null && inspected.image === opts.image) {
			// Two warm-restart paths, both faster than re-`run`:
			//
			//   1. running + matching image → adopt as-is. Sui chain ID,
			//      walrus storage state, seal master key, etc. are all
			//      preserved because the process never stopped.
			//   2. stopped + matching image → `docker start <name>` to
			//      resume from disk. Process restarts but its on-disk
			//      state (genesis, RocksDB, walrus deploy outputs) is
			//      untouched, so re-acquire is ~1s instead of a fresh
			//      run with cold genesis. Containers land in this state
			//      because the supervisor's exit-time finalizer runs
			//      `docker stop` (not `docker rm -f`) — see the
			//      finalizer registration below.
			if (!inspected.running) {
				yield* Effect.logInfo(`devstack: resuming stopped container '${name}'`);
				yield* spawner
					.exitCode(ChildProcess.make('docker', ['start', inspected.containerId]))
					.pipe(Effect.mapError(dockerError('docker start')));
			} else {
				yield* Effect.logInfo(`devstack: reusing running container '${name}'`);
			}
			yield* Effect.annotateCurrentSpan({
				'docker.op': 'run',
				'docker.name': name,
				'docker.reused': true,
				'docker.resumed': !inspected.running,
			});
			yield* claim(inspected.containerId);
			// Finalizer: stop (don't remove) so the container's on-disk
			// state survives until the next pnpm dev resumes it. `devstack
			// wipe` is the only way to remove containers + volumes.
			yield* addFinalizer(
				reuseScope,
				Effect.uninterruptible(
					spawner
						.exitCode(ChildProcess.make('docker', ['stop', inspected.containerId]))
						.pipe(Effect.ignore),
				),
			);
			return { containerId: inspected.containerId, name, reused: true };
		}
		if (inspected !== null) {
			// Container exists but the image changed (e.g. user bumped
			// the sui version): remove it so the fresh `docker run`
			// below succeeds. Resume isn't safe here — the on-disk
			// state may not be compatible with the new image.
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
				spawner
					.exitCode(ChildProcess.make('docker', ['stop', containerId]))
					.pipe(Effect.ignore),
			),
		);

		return { containerId, name, reused: false };
	}).pipe(Effect.withSpan('Docker.run'));

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

// Docker rejects names that don't start with `[a-zA-Z0-9]`; prefix keeps the
// names easy to spot in `docker ps`.
export const generateContainerName = (): string =>
	`devstack-${Math.random().toString(36).slice(2, 10)}`;

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
