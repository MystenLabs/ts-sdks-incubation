// One-shot `docker exec` and `docker run --rm`.
//
// Architecture:
//   - `dockerExec` invokes inside an already-running long-lived
//     container; captures stdout/stderr/exitCode.
//   - `dockerRunOneShot` is for `docker run --rm` style invocation —
//     a transient container that runs to completion.
//   - Both verbs take an OPTIONAL wall-clock `timeoutMillis`. When set,
//     `Effect.timeout` bounds the foreground subprocess and collapses a
//     timeout into the verb's typed error envelope. The actual
//     SIGTERM-then-SIGKILL escalation of the docker CLI child on the
//     resulting interrupt lives at the spawn seam (`client.ts`'s
//     `forceKillAfter`), not here. For `dockerRunOneShot` a
//     belt-and-suspenders `rm -f` finalizer additionally reaps any
//     container that outlived its foreground subprocess on timeout.
//   - Callers that drive `dockerExec` through `waitForProbe` should
//     still pass `timeoutMillis` (or the probe's `attemptTimeoutMs`): a
//     never-returning exec — wedged container `sh`, half-open daemon
//     socket — is otherwise never timed out, because `waitForProbe`
//     only checks its deadline BETWEEN attempts.

import { Effect, Scope } from 'effect';

import { mintRandomSuffix } from '../../substrate/runtime/random-suffix.ts';

import type {
	CaptureOptions,
	CaptureResult,
} from '../../substrate/runtime/observability/subprocess-capture.ts';
import { DockerHost, DockerSpawner, dockerRunOk } from './client.ts';
import { DaemonUnreachable, type DockerRuntimeError, ExecFailed } from './errors.ts';
import { renderRunArgs } from './render-run-args.ts';
import { wrapGeneric } from './wrap.ts';

// -----------------------------------------------------------------------------
// Exec — into a running container
// -----------------------------------------------------------------------------

export interface DockerExecOptions {
	readonly user?: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly workdir?: string;
	readonly onStdoutLine?: (line: string) => Effect.Effect<void>;
	readonly onStderrLine?: (line: string) => Effect.Effect<void>;
	/** Promote non-zero exit to `ExecFailed`. Default false; the caller
	 *  gets the full result and decides. */
	readonly failOnNonZero?: boolean;
	/** Wall-clock timeout for the foreground `docker exec` subprocess.
	 *  Without it a wedged exec (hung container `sh`, half-open daemon
	 *  socket) hangs the fiber forever — and a caller's `waitForProbe`
	 *  wrapper without `attemptTimeoutMs` never times it out, because the
	 *  probe only checks its deadline between attempts. On timeout the
	 *  exec is interrupted (the spawn seam escalates SIGTERM→SIGKILL via
	 *  `forceKillAfter`) and collapses to a typed `DaemonUnreachable`. */
	readonly timeoutMillis?: number;
}

export interface DockerExecResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** `docker exec [-u user] [-w workdir] [-e k=v]... <name> <argv...>`. */
export const dockerExec = (
	containerNameOrId: string,
	argv: ReadonlyArray<string>,
	opts: DockerExecOptions = {},
): Effect.Effect<DockerExecResult, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const args: Array<string> = [];
		if (opts.user) args.push('--user', opts.user);
		if (opts.workdir) args.push('--workdir', opts.workdir);
		if (opts.env) {
			for (const [k, v] of Object.entries(opts.env)) {
				args.push('--env', `${k}=${v}`);
			}
		}
		args.push(containerNameOrId, ...argv);
		const captureOpts: Omit<CaptureOptions, 'op' | 'nonZeroIsFailure'> = {
			onStdoutLine: opts.onStdoutLine,
			onStderrLine: opts.onStderrLine,
		};
		const baseInvocation = dockerRunOk('exec', args, captureOpts).pipe(
			Effect.mapError(wrapGeneric('docker.exec')),
		);
		// Bound the foreground subprocess when asked. Mirrors
		// `dockerRunOneShot`: Effect.timeout fails with a TimeoutError
		// (Effect v4 renamed it from TimeoutException); collapse into the
		// daemon-unreachable envelope wrapGeneric already produces for
		// this surface, so the caller sees one shape. The interrupt
		// unwinds the capture's scope, whose spawn-seam finalizer
		// escalates SIGTERM→SIGKILL (client.ts `forceKillAfter`).
		const invocation =
			opts.timeoutMillis === undefined
				? baseInvocation
				: baseInvocation.pipe(
						Effect.timeout(`${opts.timeoutMillis} millis`),
						Effect.catchTag('TimeoutError', () =>
							Effect.fail(
								new DaemonUnreachable({
									op: 'docker.exec',
									detail: `exec into ${containerNameOrId} timed out after ${opts.timeoutMillis}ms`,
								}),
							),
						),
					);
		const res = yield* invocation;
		if (opts.failOnNonZero && res.exitCode !== 0) {
			return yield* Effect.fail(
				new ExecFailed({
					name: containerNameOrId,
					argv,
					exitCode: res.exitCode,
					stderr: res.stderr,
				}),
			);
		}
		return res;
	});

// -----------------------------------------------------------------------------
// One-shot — `docker run --rm`
// -----------------------------------------------------------------------------

export interface DockerOneShotOptions {
	readonly name?: string;
	readonly image: string;
	readonly argv?: ReadonlyArray<string>;
	readonly env?: Readonly<Record<string, string>>;
	readonly mounts?: ReadonlyArray<{
		readonly source: string;
		readonly target: string;
		readonly readonly?: boolean;
	}>;
	readonly network?: string;
	readonly entrypoint?: string;
	readonly user?: string;
	readonly labels?: ReadonlyArray<string>;
	/** `--add-host <host>:<ip>` entries. See contract docs. */
	readonly extraHosts?: Readonly<Record<string, string>>;
	readonly onStdoutLine?: (line: string) => Effect.Effect<void>;
	readonly onStderrLine?: (line: string) => Effect.Effect<void>;
	/** Wall-clock timeout. After this the subprocess is killed; the
	 *  outer `rm -f` belt-and-suspenders finalizer catches any
	 *  container that survived the kill. */
	readonly timeoutMillis?: number;
	/** Keep the container after exit (forensic retention escape hatch).
	 *  When true, drops `--rm` AND the finalizer rm. */
	readonly keep?: boolean;
}

/** `docker run --rm [-name <n>] [-e ...] [--mount ...] [--network n]
 *  [--entrypoint e] [--label ...] <image> <argv...>`.
 *
 *  Belt-and-suspenders: when `keep` is false, a Scope finalizer fires
 *  `docker rm -f <name>` to catch containers that outlived the
 *  foreground subprocess on the timeout path. */
export const dockerRunOneShot = (
	opts: DockerOneShotOptions,
): Effect.Effect<CaptureResult, DockerRuntimeError, DockerHost | DockerSpawner | Scope.Scope> =>
	Effect.gen(function* () {
		const name = opts.name ?? `devstack-oneshot-${Date.now()}-${mintRandomSuffix(8)}`;
		const args = renderRunArgs({
			keep: opts.keep,
			name,
			image: opts.image,
			argv: opts.argv,
			network: opts.network,
			entrypoint: opts.entrypoint,
			user: opts.user,
			env: opts.env,
			mounts: opts.mounts,
			labels: opts.labels,
			addHosts: opts.extraHosts,
		});

		// Register the belt-and-suspenders rm finalizer BEFORE we
		// invoke. Even if the spawner blows up mid-flight, the
		// finalizer fires on scope close.
		if (!opts.keep) {
			yield* Effect.addFinalizer(() =>
				dockerRunOk('rm', ['-f', name]).pipe(
					Effect.catch(() => Effect.void),
					Effect.asVoid,
				),
			);
		}

		const captureOpts: Omit<CaptureOptions, 'op' | 'nonZeroIsFailure'> = {
			onStdoutLine: opts.onStdoutLine,
			onStderrLine: opts.onStderrLine,
		};
		const baseInvocation = dockerRunOk('run', args, captureOpts).pipe(
			Effect.mapError(wrapGeneric('docker.run-oneshot')),
		);
		if (opts.timeoutMillis !== undefined) {
			// Effect.timeout fails with a TimeoutError (Effect v4
			// renamed it from TimeoutException); collapse into our
			// daemon-unreachable envelope so the caller sees the same
			// shape they handle for any docker subprocess.
			return yield* baseInvocation.pipe(
				Effect.timeout(`${opts.timeoutMillis} millis`),
				Effect.catchTag('TimeoutError', () =>
					Effect.fail(
						new DaemonUnreachable({
							op: 'docker.run-oneshot',
							detail: `one-shot timed out after ${opts.timeoutMillis}ms`,
						}),
					),
				),
			);
		}
		return yield* baseInvocation;
	});
