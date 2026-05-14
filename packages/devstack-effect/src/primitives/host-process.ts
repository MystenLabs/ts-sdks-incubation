import { Effect, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { inheritedHostEnv } from '../internal/safe-env.js';
import { stringifyCause } from '../internal/stringify-cause.js';
import { makeTag, setPhase, type PluginTag } from '../tag.js';
import {
	awaitReady,
	type HttpReadyProbe,
	type InternalReadyProbe,
	type LogReadyProbe,
	type ReadyProbe,
	type TcpReadyProbe,
} from '../internal/ready-probe.js';
import { EndpointRegistry } from '../internal/registries.js';
import { HostProcessError } from './errors.js';

// Re-export the canonical probe types from `internal/ready-probe.ts` so users
// can keep importing them from this module (the public primitives entry point).
// The `log` variant's runtime `logs` stream lives on the internal variant only —
// users never construct it themselves; the engine binds it before calling
// `awaitReady`.
export type { HttpReadyProbe, LogReadyProbe, ReadyProbe, TcpReadyProbe };

export interface HostProcessHandle {
	readonly pid: number;
	readonly url: string | undefined;
}

export interface HostProcessOptions<Name extends string, E, R> {
	readonly name: Name;
	readonly command: string;
	readonly args?: ReadonlyArray<string>;
	// Env can be a literal record OR an Effect that yields tags to compute
	// env from resolved deps. R/E of the Effect flow into the tag.
	readonly env?: Record<string, string> | Effect.Effect<Record<string, string>, E, R>;
	readonly cwd?: string;
	readonly readyProbe?: ReadyProbe;
	readonly dependsOn?: ReadonlyArray<PluginTag<any, any, any, any>>;
	readonly endpoint?: { readonly name: string; readonly kind?: string };
}

export const hostProcess = <const Name extends string, E = never, R = never>(
	options: HostProcessOptions<Name, E, R>,
) =>
	makeTag(
		options.name,
		Effect.gen(function* () {
			yield* Effect.annotateCurrentSpan({
				'hostProcess.name': options.name,
				'hostProcess.command': options.command,
			});

			// 1. Resolve env: literal record, Effect, or undefined.
			const envOpt = options.env;
			const resolvedEnv: Record<string, string> =
				envOpt === undefined ? {} : isEffect(envOpt) ? yield* envOpt : envOpt;

			// 2. Resolve dependsOn — yield* each tag for ordering. Values
			//    are unused here; the engine just needs the R-channel edges.
			for (const tag of options.dependsOn ?? []) {
				yield* tag;
			}

			yield* setPhase('spawning');
			// 3. Spawn the child process via ChildProcessSpawner. The
			//    spawner's `spawn` attaches a Scope finalizer that kills the
			//    process when the enclosing scope closes.
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const cmd = ChildProcess.make(options.command, options.args ?? [], {
				env: { ...inheritedHostEnv(), ...resolvedEnv },
				cwd: options.cwd,
			});
			const handle = yield* spawner.spawn(cmd).pipe(
				Effect.mapError(
					(cause) =>
						new HostProcessError({
							command: options.command,
							message: `hostProcess: failed to spawn '${options.command}': ${stringifyCause(cause)}`,
							cause,
						}),
				),
			);
			yield* Effect.annotateCurrentSpan({ 'hostProcess.pid': handle.pid });

			// 4. Wait for ready probe if provided.
			if (options.readyProbe !== undefined) {
				yield* setPhase('awaiting ready');
				const probe: InternalReadyProbe =
					options.readyProbe.kind === 'log'
						? {
								...options.readyProbe,
								// Drop the stdout stream's PlatformError into a defect — if
								// the child process's stdout pipe blows up we'd never reach
								// a ready state anyway, so a defect is the right surface.
								logs: Stream.splitLines(Stream.decodeText(Stream.orDie(handle.stdout))),
							}
						: options.readyProbe;
				yield* awaitReady(probe).pipe(
					Effect.mapError(
						(cause) =>
							new HostProcessError({
								command: options.command,
								message: `hostProcess: ready probe failed for '${options.name}'`,
								cause,
							}),
					),
				);
			}

			// 5. Register endpoint if requested. URL only meaningful for
			//    HTTP probes — TCP/log don't yield a URL on their own.
			const url = options.readyProbe?.kind === 'http' ? options.readyProbe.url : undefined;
			if (options.endpoint !== undefined && url !== undefined) {
				yield* EndpointRegistry.publish({
					name: options.endpoint.name,
					url,
					kind: options.endpoint.kind,
				});
			}

			return { pid: handle.pid as unknown as number, url } satisfies HostProcessHandle;
		}).pipe(Effect.withSpan(`hostProcess(${options.name})`)),
		{
			kind: 'service',
			displayTitle: options.name,
			display: (s) => ({
				title: options.name,
				primary: s.url ?? `pid ${s.pid}`,
			}),
		},
	);

const isEffect = <A, E, R>(
	value: Record<string, string> | Effect.Effect<A, E, R>,
): value is Effect.Effect<A, E, R> => {
	return Effect.isEffect(value);
};
