// Command-execution wrappers — `exec` (run a command inside a running
// container), `commitContainer` (snapshot a container into a new image),
// and `runOneShot` (run-to-completion with TERM-then-KILL escalation).

import { Effect } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { addFinalizer } from 'effect/Scope';
import { DockerError } from '../../primitives/errors.js';
import {
	captureStreams,
	decodeStream,
	dockerError,
	drainLinesWithCallback,
	generateContainerName,
	runCapturingOrFail,
	type DockerExecResult,
	type OutputLineCallback,
} from './core.js';
import { getTraefikRouterIp, listRegisteredHostnames } from './router.js';

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
	 * When `true`, stamps one `--add-host <hostname>:<traefik-ip>` per
	 * currently registered routed hostname (read fresh from the file-
	 * provider directory at spawn time). Mirrors the
	 * `Docker.run({ routerAddHosts })` opt — opt in on one-shots whose
	 * containerized scripts dial routed URLs (e.g. walrus deploy-walrus.sh
	 * reaches `http://sui.<app>.localhost:9000`). Default `false`.
	 */
	readonly routerAddHosts?: boolean;
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
): Effect.Effect<DockerOneShotResult, DockerError, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

		const name = opts.name ?? generateContainerName();
		// `--rm` auto-removes the container on exit — convenient for the
		// happy path but destroys post-mortem logs when something goes
		// wrong. Set DEVSTACK_KEEP_ONESHOT=1 to keep the container so
		// `docker logs <name>` works for debugging.
		const keepOneShot = process.env.DEVSTACK_KEEP_ONESHOT === '1';
		const args: Array<string> = keepOneShot
			? ['run', '--name', name]
			: ['run', '--rm', '--name', name];
		if (opts.entrypoint !== undefined) args.push('--entrypoint', opts.entrypoint);
		// `routerAddHosts: true` implies the container needs to dial
		// services through traefik on `devstack-router`. Add-host alone
		// isn't enough — the container must also be ATTACHED to the
		// router network so the resolved IP is reachable. A one-shot
		// (`docker run --rm`) takes a single `--network`, so if the
		// caller didn't specify one we use `devstack-router`. If the
		// caller asked for a per-stack network, we honor that but log a
		// warning that the router won't be reachable — the caller is
		// responsible for the multi-network attach in that case.
		if (opts.network !== undefined) {
			args.push('--network', opts.network);
		} else if (opts.routerAddHosts === true) {
			args.push('--network', 'devstack-router');
		}
		// Routed-hostname add-host stamps. Mirrors `Docker.run`'s
		// `routerAddHosts` opt — RFC 6761 `.localhost` resolution only
		// works on the host OS, so a one-shot that dials a routed URL
		// (e.g. walrus deploy-walrus.sh reaching `http://sui.<app>.
		// localhost:9000`) needs explicit `/etc/hosts` entries pointing
		// at traefik. Resolution failure (traefik unreachable, no
		// hostnames registered) logs + falls through with no add-hosts
		// rather than failing the one-shot.
		if (opts.routerAddHosts === true) {
			const hostnames = yield* listRegisteredHostnames();
			if (hostnames.length > 0) {
				const ip = yield* getTraefikRouterIp(spawner).pipe(
					Effect.catch((cause: DockerError) =>
						Effect.logWarning(
							`devstack: runOneShot routerAddHosts skipped for '${name}' — ${cause.message}`,
						).pipe(Effect.as(null)),
					),
				);
				if (ip !== null) {
					for (const h of hostnames) {
						args.push(`--add-host=${h}:${ip}`);
					}
				}
			}
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
