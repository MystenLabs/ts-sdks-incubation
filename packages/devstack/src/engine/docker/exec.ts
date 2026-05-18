// Command-execution wrappers — `exec` (run a command inside a running
// container), `commitContainer` (snapshot a container into a new image),
// and `runOneShot` (run-to-completion with TERM-then-KILL escalation).

import { Effect } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { addFinalizer } from 'effect/Scope';
import { DockerError } from '../../engine/errors.js';
import { Identity } from '../identity.js';
import {
	captureStreams,
	composeContainerName,
	decodeStream,
	dockerError,
	drainLinesWithCallback,
	generateContainerName,
	runCapturingOrFail,
	type DockerExecResult,
	type OutputLineCallback,
} from './core.js';

// Re-export so primitives can spell the callback shape without dipping
// into the core module directly.
export type { OutputLineCallback, OutputLineLevel } from './core.js';

// Re-export the result shape so consumers can `Docker.DockerExecResult`
// if they ever annotate the type explicitly.
export type { DockerExecResult };

// -----------------------------------------------------------------------------
// Exec — run a command inside a running container
// -----------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------
// pauseContainer / unpauseContainer — freeze a running container's
// processes so a `docker commit` captures a quiescent writable layer.
//
// `docker commit` is NOT quiescent on its own: it tars the container's
// RW layer while the workload's processes keep mutating it. For a chain-
// state daemon (sui's RocksDB, postgres's WAL) that's mid-fsync, the
// resulting image can include a torn WAL or a corrupt SST and need
// recovery on next boot — or fail to open entirely. Pausing first sends
// `SIGSTOP` to every process inside the container via the freezer
// cgroup, which guarantees no I/O is in flight when the commit runs.
//
// `docker pause` errors on a stopped container; callers should gate on
// container state via `inspectContainerRunning` and skip the pause when
// the container is already stopped (committing a stopped container is
// already quiescent).
// -----------------------------------------------------------------------------

export const pauseContainer = (
	containerId: string,
): Effect.Effect<void, DockerError, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		yield* Effect.annotateCurrentSpan({ 'docker.op': 'pause', 'docker.container': containerId });
		yield* runCapturingOrFail(
			spawner,
			ChildProcess.make('docker', ['pause', containerId]),
			'docker pause',
		);
	}).pipe(Effect.withSpan('Docker.pauseContainer'));

export const unpauseContainer = (
	containerId: string,
): Effect.Effect<void, DockerError, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		yield* Effect.annotateCurrentSpan({ 'docker.op': 'unpause', 'docker.container': containerId });
		yield* runCapturingOrFail(
			spawner,
			ChildProcess.make('docker', ['unpause', containerId]),
			'docker unpause',
		);
	}).pipe(Effect.withSpan('Docker.unpauseContainer'));

// `docker inspect --format '{{.State.Running}}' <id>` — read whether a
// container is currently running. Returns `undefined` when the container
// doesn't exist (inspect exits non-zero). Used by `snapshot.save` to
// skip the pause/unpause around `docker commit` for already-stopped
// containers (pause errors on those).
export const inspectContainerRunning = (
	containerId: string,
): Effect.Effect<boolean | undefined, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const cmd = ChildProcess.make('docker', [
			'inspect',
			'--format',
			'{{.State.Running}}',
			containerId,
		]);
		const out = yield* spawner.string(cmd).pipe(Effect.orElseSucceed(() => ''));
		const trimmed = out.trim();
		if (trimmed.length === 0) return undefined;
		return trimmed === 'true';
	}).pipe(Effect.withSpan('Docker.inspectContainerRunning'));

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
					phase: 'docker commit',
					message: `docker image inspect returned empty digest for ${imageName}`,
				}),
			);
		}
		return { digest };
	}).pipe(Effect.withSpan('Docker.commitContainer'));

// -----------------------------------------------------------------------------
// restartContainer — `docker restart <name>` (stop + start, same name + config)
// -----------------------------------------------------------------------------

// Used by primitives that need to bounce a long-running daemon to pick
// up an updated bind-mount config or env-file (e.g. seal key rotation
// rewriting `key-server-config.yaml` + `master-key.env`). Keeps the
// container's identity stable so the outer `Docker.run` scope's
// `docker rm -f` finalizer still targets the right container at
// shutdown.
export const restartContainer = (
	name: string,
): Effect.Effect<void, DockerError, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		yield* Effect.annotateCurrentSpan({ 'docker.op': 'restart', 'docker.name': name });
		yield* runCapturingOrFail(
			spawner,
			ChildProcess.make('docker', ['restart', name]),
			'docker restart',
		);
	}).pipe(Effect.withSpan('Docker.restartContainer'));

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
	/**
	 * Per-line output sink. Invoked once per line of stdout (`level:
	 * 'info'`) and stderr (`level: 'warn'`) as the line arrives — the
	 * accumulated `stdout`/`stderr` strings on the result are unchanged,
	 * so callers that want to inspect them after exit still can.
	 *
	 * Wired by primitives (walrus deploy, seal keygen, …) to surface
	 * script output into the supervisor's TUI log tail in real time —
	 * before the one-shot's exit code lands. Lines are pushed
	 * unconditionally; the callback is responsible for any sampling /
	 * filtering it wants.
	 *
	 * Errors from the callback are swallowed so a flaky sink never
	 * breaks a one-shot that would otherwise succeed.
	 */
	readonly onOutputLine?: OutputLineCallback;
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
): Effect.Effect<
	DockerOneShotResult,
	DockerError,
	ChildProcessSpawner.ChildProcessSpawner | Identity
> =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const identity = yield* Identity;

		// Stack-scope the container name with the same `{app}-{stack}-{name}`
		// shape `run()` uses for long-lived containers, so two parallel
		// stacks (or two repos sharing a primitive name) don't collide on
		// docker's container-name global namespace. Without this, walrus
		// deploy / seal keygen / etc. silently shared a name across stacks
		// and the second stack 125'd with "container name already in use".
		const primitiveName = opts.name ?? generateContainerName();
		const name = composeContainerName(
			identity.app,
			identity.stack,
			identity.network,
			primitiveName,
		);
		// `--rm` auto-removes the container on exit — convenient for the
		// happy path but destroys post-mortem logs when something goes
		// wrong. Set DEVSTACK_KEEP_ONESHOT=1 to keep the container so
		// `docker logs <name>` works for debugging.
		const keepOneShot = process.env.DEVSTACK_KEEP_ONESHOT === '1';
		const args: Array<string> = keepOneShot
			? ['run', '--name', name]
			: ['run', '--rm', '--name', name];
		if (opts.entrypoint !== undefined) args.push('--entrypoint', opts.entrypoint);
		// `--network` is opt-in only. A one-shot that needs to reach
		// per-stack docker-DNS aliases (e.g. `sui-localnet`) must pass
		// the network name explicitly. There is no longer a default
		// fallback to `devstack-router`: containers reach sui via the
		// sui-localnet per-stack network's DNS alias, not via routed
		// hostnames (glibc bypasses `/etc/hosts` for `.localhost`).
		if (opts.network !== undefined) {
			args.push('--network', opts.network);
		}
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

		const onOutputLine = opts.onOutputLine;
		const work = Effect.scoped(
			Effect.gen(function* () {
				const scope = yield* Effect.scope;
				// Skip the rm-f finalizer when DEVSTACK_KEEP_ONESHOT=1
				// so post-mortem `docker logs <name>` works on a failed
				// one-shot. Container survives until next devstack wipe
				// or manual `docker rm`.
				if (!keepOneShot) {
					yield* addFinalizer(
						scope,
						spawner.exitCode(ChildProcess.make('docker', ['rm', '-f', name])).pipe(Effect.ignore),
					);
				}
				const handle = yield* spawner.spawn(cmd).pipe(Effect.mapError(dockerError(op)));
				// When a per-line sink is supplied, drain stdout/stderr
				// through it so the supervisor's log tail sees script
				// output as it arrives (instead of waiting on exit).
				// We still accumulate the full text so `WalrusError`-style
				// errors can include the captured stdout/stderr verbatim.
				const stdoutEff =
					onOutputLine === undefined
						? decodeStream(handle.stdout).pipe(Effect.mapError(dockerError(op)))
						: drainLinesWithCallback(handle.stdout, 'info', onOutputLine).pipe(
								Effect.mapError(dockerError(op)),
							);
				const stderrEff =
					onOutputLine === undefined
						? decodeStream(handle.stderr).pipe(Effect.mapError(dockerError(op)))
						: drainLinesWithCallback(handle.stderr, 'warn', onOutputLine).pipe(
								Effect.mapError(dockerError(op)),
							);
				const [stdoutText, stderrText, code] = yield* Effect.all(
					[stdoutEff, stderrEff, handle.exitCode.pipe(Effect.mapError(dockerError(op)))],
					{ concurrency: 'unbounded' },
				);
				return { exitCode: code as number, stdout: stdoutText, stderr: stderrText };
			}),
		);

		// Belt-and-suspenders cleanup. The inner `Effect.scoped` registers a
		// `docker rm -f <name>` finalizer that is the PRIMARY teardown
		// path — it fires on normal completion, on interruption, and on
		// the timeout below interrupting `work`. But `Effect.timeoutOrElse`
		// is permitted to surface the `orElse` failure before the inner
		// scope's finalizer has been observed to complete, so on the
		// timeout path a container could (in principle) outlive this
		// function. The `Effect.ensuring` below re-issues `docker rm -f`
		// AFTER `timeoutOrElse` resolves either way. On the happy path
		// the container is already gone — `docker rm -f` on a missing
		// name exits non-zero, which we ignore. Honors the same
		// `DEVSTACK_KEEP_ONESHOT` opt-out as the primary finalizer.
		return yield* work.pipe(
			Effect.timeoutOrElse({
				duration: `${timeoutMs} millis`,
				orElse: () =>
					Effect.fail(
						new DockerError({
							phase: op,
							message: `docker run (one-shot) '${name}' timed out after ${timeoutMs}ms`,
						}),
					),
			}),
			Effect.ensuring(
				keepOneShot
					? Effect.void
					: spawner.exitCode(ChildProcess.make('docker', ['rm', '-f', name])).pipe(Effect.ignore),
			),
		);
	}).pipe(Effect.withSpan('Docker.runOneShot'));
