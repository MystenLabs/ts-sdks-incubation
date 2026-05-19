import { Effect, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { inheritedHostEnv } from '../../engine/safe-env.js';
import { HostProcessError } from '../../engine/errors.js';
import { tag, type LayeredTag } from '../tag.js';

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
	readonly dependsOn?: ReadonlyArray<LayeredTag<any, any, any, any>>;
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

/**
 * Spawn a host process to completion. Captures stdout (string) + exit
 * code; honors a `timeoutMs` budget with SIGTERM-then-SIGKILL escalation
 * via the spawner's `killSignal` / `forceKillAfter` shape.
 *
 * **Public escape hatch for plugin authors.** Zero in-tree callers as
 * of Wave 6.8 — `Dev()` covers the long-running dev-server case via
 * the internal `hostProcess` primitive; this `hostScript` is the
 * "I need to run a short host-side script as part of stack acquisition"
 * hatch (build steps, codegen invocations, side-effect actions that
 * don't fit a container).
 *
 * **Sunset 2026-11-19.** Six months from Wave 6.8 (`packages/devstack/notes/review-followups.md`
 * §8.8 + §10.4). If no in-tree or out-of-tree caller appears by the
 * sunset date, this primitive will be re-evaluated for removal.
 * Out-of-tree plugin authors using `hostScript` should track this note
 * and file an issue against the devstack repo with their use case so
 * the sunset can be cancelled.
 */
export const hostScript = <const Name extends string, E = never, R = never>(
	options: HostScriptOptions<Name, E, R>,
) =>
	tag(
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
					phase: options.command,
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
								phase: options.command,
								message: `hostScript '${options.name}' timed out after ${timeoutMs}ms`,
							}),
						),
				}),
			);

			return { exitCode, stdout } satisfies HostScriptResult;
		}).pipe(Effect.withSpan(`HostScript(${options.name})`)),
		{
			kind: 'action',
			displayTitle: options.name,
			display: (s) => ({ title: options.name, primary: `exit ${s.exitCode}` }),
			// Forward `dependsOn:` into the dep graph as `__upstreamKeys`.
			upstreamKeys: options.dependsOn ?? [],
		},
	);
