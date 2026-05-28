// One-shot `docker exec` and `docker run --rm`.
//
// Architecture:
//   - `dockerExec` invokes inside an already-running long-lived
//     container; captures stdout/stderr/exitCode.
//   - `dockerRunOneShot` is for `docker run --rm` style invocation —
//     a transient container that runs to completion.
//   - Wall-clock timeout with SIGTERM-then-SIGKILL escalation is
//     scoped at the L0 capture level via `Effect.timeout`; the
//     belt-and-suspenders `rm -f` is registered as a finalizer so a
//     timed-out container that outlived its foreground subprocess is
//     still reaped.

import { randomUUID } from 'node:crypto';

import { Effect, Scope } from 'effect';

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
		const res = yield* dockerRunOk('exec', args, captureOpts).pipe(
			Effect.mapError(wrapGeneric('docker.exec')),
		);
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
	}).pipe(Effect.withSpan('runtime.docker.exec'));

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
		const name =
			opts.name ?? `devstack-oneshot-${Date.now()}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
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
	}).pipe(Effect.withSpan('runtime.docker.oneShot'));
