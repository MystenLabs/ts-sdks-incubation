import { Effect, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { inheritedHostEnv } from '../../engine/safe-env.js';
import { HostProcessError } from '../../primitives/errors.js';
import { makeTag, type PluginTag } from '../tag.js';

export interface HostScriptResult {
	readonly exitCode: number;
	readonly stdout: string;
}

export interface HostScriptOptions<Name extends string, E, R> {
	readonly name: Name;
	readonly command: string;
	readonly args?: ReadonlyArray<string>;
	readonly env?: Record<string, string> | Effect.Effect<Record<string, string>, E, R>;
	readonly cwd?: string;
	readonly captureStdout?: boolean;
	readonly dependsOn?: ReadonlyArray<PluginTag<any, any, any, any>>;
	/**
	 * Wall-clock budget for the entire spawn. On expiry the spawner's
	 * finalizer SIGTERMs the child, then SIGKILLs after `gracePeriodMs` if
	 * it hasn't exited, and the plugin fails with a tagged `HostProcessError`.
	 * Defaults to 10 minutes.
	 */
	readonly timeoutMs?: number;
	/**
	 * Grace period between SIGTERM and the fallback SIGKILL when the timeout
	 * fires. Defaults to 5_000 ms.
	 */
	readonly gracePeriodMs?: number;
}

const DEFAULT_HOST_SCRIPT_TIMEOUT_MS = 600_000;
const DEFAULT_HOST_SCRIPT_GRACE_PERIOD_MS = 5_000;

export const hostScript = <const Name extends string, E = never, R = never>(
	options: HostScriptOptions<Name, E, R>,
) =>
	makeTag(
		options.name,
		Effect.gen(function* () {
			// 1. Resolve env: literal record, Effect, or undefined.
			const envOpt = options.env;
			const resolvedEnv: Record<string, string> =
				envOpt === undefined ? {} : Effect.isEffect(envOpt) ? yield* envOpt : envOpt;

			// 2. Resolve dependsOn — yield* each tag for ordering.
			for (const tag of options.dependsOn ?? []) {
				yield* tag;
			}

			// 3. Spawn the command, drain stdout, wait for exit. Inherit
			//    process.env so the script sees the parent's PATH etc. then
			//    layer the caller's env over it. `Effect.scoped` releases
			//    the spawn handle once we have the exit code; on
			//    interrupt/timeout the spawner finalizer uses the
			//    `killSignal` / `forceKillAfter` we set on the command to do
			//    a SIGTERM → SIGKILL escalation.
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const timeoutMs = options.timeoutMs ?? DEFAULT_HOST_SCRIPT_TIMEOUT_MS;
			const gracePeriodMs = options.gracePeriodMs ?? DEFAULT_HOST_SCRIPT_GRACE_PERIOD_MS;
			const cmd = ChildProcess.make(options.command, options.args ?? [], {
				env: { ...inheritedHostEnv(), ...resolvedEnv },
				cwd: options.cwd,
				killSignal: 'SIGTERM',
				forceKillAfter: `${gracePeriodMs} millis`,
			});

			yield* Effect.annotateCurrentSpan({
				'hostScript.timeoutMs': timeoutMs,
				'hostScript.gracePeriodMs': gracePeriodMs,
			});

			const mapError = (cause: unknown): HostProcessError =>
				new HostProcessError({
					command: options.command,
					message: `hostScript '${options.name}'`,
					cause,
				});

			const { exitCode, stdout } = yield* Effect.scoped(
				Effect.gen(function* () {
					const handle = yield* spawner.spawn(cmd).pipe(Effect.mapError(mapError));
					const [stdoutText, code] = yield* Effect.all(
						[
							Stream.mkString(Stream.decodeText(handle.stdout)).pipe(Effect.mapError(mapError)),
							handle.exitCode.pipe(Effect.mapError(mapError)),
						],
						{ concurrency: 'unbounded' },
					);
					return { exitCode: code as number, stdout: stdoutText };
				}),
			).pipe(
				Effect.timeoutOrElse({
					duration: `${timeoutMs} millis`,
					orElse: () =>
						Effect.fail(
							new HostProcessError({
								command: options.command,
								message: `hostScript '${options.name}' timed out after ${timeoutMs}ms`,
							}),
						),
				}),
			);

			return { exitCode, stdout } satisfies HostScriptResult;
		}).pipe(Effect.withSpan(`hostScript(${options.name})`)),
		{
			kind: 'action',
			displayTitle: options.name,
			display: (s) => ({ title: options.name, primary: `exit ${s.exitCode}` }),
		},
	);
