import { Effect, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { addFinalizer as addScopeFinalizer } from 'effect/Scope';
import { Identity } from '../internal/identity.js';
import {
	routerEntrypoint,
	removeFileProvider,
	writeFileProvider,
} from '../internal/docker/router.js';
import { drainLinesWithCallback, type OutputLineCallback } from '../internal/docker/core.js';
import { routerHostname, routerId } from '../internal/router-hostname.js';
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

export interface HostProcessTraefikConfig {
	/**
	 * Logical service name folded into the stack-scoped hostname
	 * (e.g. `'dev'` → `dev.<app>.localhost` on main, or
	 * `<stack>.dev.<app>.localhost` on non-main). Also used to derive
	 * the unique router id `<app>-<stack>-<service>`.
	 */
	readonly service: string;
	/**
	 * Router entrypoint name (one of `ROUTER_ENTRYPOINTS`'s `name`
	 * values, e.g. `'vite'`, `'wallet'`). Drives the well-known host
	 * port traefik binds for the public URL.
	 */
	readonly entrypoint: string;
	/**
	 * Local 127.0.0.1 port the spawned process binds. Traefik
	 * forwards to `http://host.docker.internal:<localPort>` and the
	 * SDK-facing URL surfaces as `http://<hostname>:<entrypointPort>`.
	 */
	readonly localPort: number;
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
	/**
	 * Optional Traefik router exposure. When set, the primitive
	 * writes a file-provider YAML under `~/.devstack/traefik/dynamic/`
	 * pointing traefik at the spawned process's local port, and
	 * surfaces the router-fronted URL as the registered endpoint.
	 * Cleaned up on scope teardown.
	 */
	readonly traefik?: HostProcessTraefikConfig;
	/**
	 * Per-line output sink for the spawned process's stdout (`info`)
	 * and stderr (`warn`). Wired by callers that want vite / generic
	 * dev-server output to surface in the supervisor TUI without
	 * having to author a regex `log` readyProbe. Lines arriving while
	 * a `log` readyProbe also reads stdout are duplicated to both
	 * consumers — `Stream.broadcast` isn't needed because both halves
	 * read independently bound copies of the spawner's stdout stream.
	 *
	 * Errors from the callback are swallowed so a flaky sink can't
	 * kill the host process.
	 */
	readonly onOutputLine?: OutputLineCallback;
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

			// Per-line output sink: when the caller wires `onOutputLine`
			// AND a `log` readyProbe isn't consuming stdout for us, fork
			// background drainers so stdout (`info`) and stderr (`warn`)
			// flow into the supervisor's log channel. We skip stdout when
			// the readyProbe is `log`-shaped to avoid splitting bytes
			// between two consumers of the same underlying OS pipe — the
			// log probe already has the bytes; the supervisor sees the
			// matched line through its own narration path.
			const onOutputLine = options.onOutputLine;
			if (onOutputLine !== undefined) {
				const scope = yield* Effect.scope;
				// IMPORTANT ordering subtlety: the spawner's `spawn`
				// already registered a kill-child finalizer on this
				// scope. Finalizers run LIFO, so anything we add AFTER
				// runs first. We register a `handle.kill` finalizer
				// here so the child dies BEFORE the spawner's own kill
				// finalizer runs — closing stdout/stderr pipes early
				// and letting the forked drainer fibers' Stream
				// consumers settle naturally on EOF. Without this, the
				// drainer fibers parked on a still-open pipe receive
				// an interrupt but can't observe it (no yield point
				// while waiting for next chunk), and scope teardown
				// hangs.
				yield* addScopeFinalizer(
					scope,
					Effect.uninterruptible(handle.kill().pipe(Effect.ignore)),
				);
				if (options.readyProbe?.kind !== 'log') {
					yield* drainLinesWithCallback(
						Stream.orDie(handle.stdout),
						'info',
						onOutputLine,
					).pipe(Effect.ignore, Effect.forkIn(scope));
				}
				yield* drainLinesWithCallback(
					Stream.orDie(handle.stderr),
					'warn',
					onOutputLine,
				).pipe(Effect.ignore, Effect.forkIn(scope));
			}

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

			// 5. Router exposure (optional). When `options.traefik` is
			//    set, drop a file-provider YAML under
			//    `~/.devstack/traefik/dynamic/` pointing traefik at the
			//    spawned process's local port. The resulting public URL
			//    is `http://<hostname>:<entrypointPort>`; we use it as
			//    the registered endpoint URL so the manifest carries the
			//    SDK-facing surface instead of the (private) local port.
			let routerUrl: string | undefined;
			if (options.traefik !== undefined) {
				const identity = yield* Identity;
				const hostname = routerHostname(identity, options.traefik.service);
				const entrypoint = routerEntrypoint(options.traefik.entrypoint);
				if (entrypoint === undefined) {
					return yield* Effect.fail(
						new HostProcessError({
							command: options.command,
							message: `hostProcess(${options.name}): router entrypoint '${options.traefik.entrypoint}' not registered`,
						}),
					);
				}
				const id = routerId(identity, options.traefik.service);
				yield* writeFileProvider({
					id,
					hostname,
					entrypoint: options.traefik.entrypoint,
					upstreamUrl: `http://host.docker.internal:${options.traefik.localPort}`,
				}).pipe(
					Effect.catchTag('DockerError', (cause) =>
						Effect.logWarning(
							`hostProcess(${options.name}): file-provider YAML write failed (continuing on direct port): ${cause.message}`,
						),
					),
				);
				yield* Effect.addFinalizer(() => removeFileProvider(id));
				routerUrl = `http://${hostname}:${entrypoint.port}`;
			}

			// 6. Register endpoint if requested. URL only meaningful for
			//    HTTP probes — TCP/log don't yield a URL on their own.
			//    Prefer the router-fronted URL when one was derived above.
			const probeUrl =
				options.readyProbe?.kind === 'http' ? options.readyProbe.url : undefined;
			const url = routerUrl ?? probeUrl;
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
