// hostProcess — spawn a long-lived child process on the host, scope
// its lifecycle to the engine, optionally publish it via Traefik (so
// it surfaces under a stack-scoped hostname), and surface its URL as
// an Endpoint. The escape hatch for dev-servers (vite, next), local
// daemons, and anything that doesn't fit a higher-level primitive.
// Pair with `port: { preferred }` for per-stack allocation; pair with
// `traefik` to expose the upstream port behind the router.

import { Effect, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { addFinalizer as addScopeFinalizer } from 'effect/Scope';
import { Identity } from '../../engine/identity.js';
import { PortAllocator } from '../../engine/port-allocator.js';
import {
	routerEntrypoint,
	removeFileProvider,
	writeFileProvider,
} from '../../engine/docker/router.js';
import { drainLinesWithCallback, type OutputLineCallback } from '../../engine/docker/core.js';
import { routerHostname, routerId } from '../../engine/router-hostname.js';
import { inheritedHostEnv } from '../../engine/safe-env.js';
import { stringifyCause } from '../../engine/stringify-cause.js';
import { tag, setPhase, type Ref } from '../../advanced/tag.js';
import {
	awaitReady,
	type HttpReadyProbe,
	type InternalReadyProbe,
	type LogReadyProbe,
	type ReadyProbe,
	type TcpReadyProbe,
} from '../../engine/ready-probe.js';
import { publishEndpoint } from '../../engine/registries.js';
import { HostProcessError } from '../../engine/errors.js';

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
	 *
	 * Optional when `HostProcessOptions.port` is set — in that case
	 * the allocated port overrides this value (so the caller doesn't
	 * have to thread the same number through twice).
	 */
	readonly localPort?: number;
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
	readonly dependsOn?: ReadonlyArray<Ref<any, any, any, any>>;
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
	 * Optional port allocation. When set, the supervisor yields a port
	 * from `PortAllocator` (scanning forward from `preferred` if it's
	 * already bound) and exposes it as `$PORT` to the spawned process.
	 * The allocated value also becomes `traefik.localPort` (so the
	 * caller doesn't have to thread the same number through twice) and
	 * the default HTTP `readyProbe` URL when one isn't supplied. Enables
	 * multiple stacks of the same example to boot concurrently without
	 * colliding on a hardcoded dev-server port. User-supplied `env.PORT`
	 * wins over the allocator's choice.
	 */
	readonly port?: { readonly preferred: number };
	/**
	 * Optional template hooks. When `port:` is set, the supervisor passes
	 * the allocator-resolved port through these renderers before spawning,
	 * so callers can write `{port}` placeholders in command/args/probe
	 * URLs without threading the actual port through manually. Skipped
	 * entirely when `port:` is unset.
	 */
	readonly portTemplate?: {
		readonly renderCommand?: (cmd: string, port: number) => string;
		readonly renderArg?: (arg: string, port: number) => string;
		readonly renderReady?: (probe: ReadyProbe, port: number) => ReadyProbe;
	};
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
	tag(
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

			// 1a. Optional port allocation. When `options.port` is set,
			//     yield a host port from PortAllocator (scanning forward
			//     from `preferred` when the preferred is bound by a
			//     sibling stack) and inject it as `$PORT` so scripts can
			//     bind to it. Multiple stacks of the same example boot
			//     side-by-side without hardcoded collisions.
			const allocatedPort: number | undefined = yield* options.port !== undefined
				? Effect.gen(function* () {
						const allocator = yield* PortAllocator;
						return yield* allocator.allocate(options.port!.preferred).pipe(
							Effect.mapError(
								(cause) =>
									new HostProcessError({
										command: options.command,
										message: `hostProcess(${options.name}): could not allocate port near ${options.port!.preferred}: ${cause.message}`,
										cause,
									}),
							),
						);
					})
				: Effect.succeed(undefined);
			const portEnv: Record<string, string> =
				allocatedPort === undefined ? {} : { PORT: String(allocatedPort) };

			// 1b. Template substitution: when `port:` is set, run the
			//     allocator-resolved port through the caller's `{port}`
			//     renderers so command/args/probe-URL stay in sync without
			//     the user duplicating the port literal across fields.
			const tpl = options.portTemplate;
			const resolvedCommand: string =
				allocatedPort !== undefined && tpl?.renderCommand !== undefined
					? tpl.renderCommand(options.command, allocatedPort)
					: options.command;
			const resolvedArgs: ReadonlyArray<string> =
				allocatedPort !== undefined && tpl?.renderArg !== undefined && options.args !== undefined
					? options.args.map((arg) => tpl.renderArg!(arg, allocatedPort))
					: (options.args ?? []);

			// When `port:` is set but no readyProbe was given, derive a
			// default HTTP probe against the allocated port. Saves the
			// caller from threading the port through twice — common case
			// for dev servers (vite, next, etc.) that bind `$PORT`. If the
			// caller supplied a probe with `{port}` placeholders, render it.
			const probeBeforeTemplate: ReadyProbe | undefined =
				options.readyProbe !== undefined
					? options.readyProbe
					: allocatedPort !== undefined
						? { kind: 'http', url: `http://localhost:${allocatedPort}`, timeoutMs: 60_000 }
						: undefined;
			const resolvedReadyProbe: ReadyProbe | undefined =
				probeBeforeTemplate !== undefined &&
				allocatedPort !== undefined &&
				tpl?.renderReady !== undefined
					? tpl.renderReady(probeBeforeTemplate, allocatedPort)
					: probeBeforeTemplate;

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
			const cmd = ChildProcess.make(resolvedCommand, resolvedArgs, {
				// User-supplied `env` wins last so callers can override
				// `PORT` if they explicitly need a different value, but the
				// allocator's choice is the default whenever `port:` is set.
				env: { ...inheritedHostEnv(), ...portEnv, ...resolvedEnv },
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
			//
			// Known limitation (no test): in scope-teardown the forked
			// drainer fibers can park on the still-open pipe between
			// `handle.kill()` and child exit, leaving the scope close
			// briefly uninterruptible. Real usage tears down via SIGINT
			// (closes pipes synchronously) or after the child exits,
			// so we haven't hit it outside synthetic short-lived tests.
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
				yield* addScopeFinalizer(scope, Effect.uninterruptible(handle.kill().pipe(Effect.ignore)));
				if (resolvedReadyProbe?.kind !== 'log') {
					yield* drainLinesWithCallback(Stream.orDie(handle.stdout), 'info', onOutputLine).pipe(
						Effect.ignore,
						Effect.forkIn(scope),
					);
				}
				yield* drainLinesWithCallback(Stream.orDie(handle.stderr), 'warn', onOutputLine).pipe(
					Effect.ignore,
					Effect.forkIn(scope),
				);
			}

			// 4. Wait for ready probe if provided.
			if (resolvedReadyProbe !== undefined) {
				yield* setPhase('awaiting ready');
				const probe: InternalReadyProbe =
					resolvedReadyProbe.kind === 'log'
						? {
								...resolvedReadyProbe,
								// Drop the stdout stream's PlatformError into a defect — if
								// the child process's stdout pipe blows up we'd never reach
								// a ready state anyway, so a defect is the right surface.
								logs: Stream.splitLines(Stream.decodeText(Stream.orDie(handle.stdout))),
							}
						: resolvedReadyProbe;
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
				// Prefer the allocated port (set when `options.port` is in
				// use) over the explicit `localPort`; fail loudly if neither
				// is set — silently routing traefik to port 0 would 502.
				const upstreamPort = allocatedPort ?? options.traefik.localPort;
				if (upstreamPort === undefined) {
					return yield* Effect.fail(
						new HostProcessError({
							command: options.command,
							message: `hostProcess(${options.name}): traefik requires either \`port: { preferred }\` or \`traefik.localPort\`.`,
						}),
					);
				}
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
					upstreamUrl: `http://host.docker.internal:${upstreamPort}`,
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
			const probeUrl = resolvedReadyProbe?.kind === 'http' ? resolvedReadyProbe.url : undefined;
			const url = routerUrl ?? probeUrl;
			if (options.endpoint !== undefined && url !== undefined) {
				yield* publishEndpoint({
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
