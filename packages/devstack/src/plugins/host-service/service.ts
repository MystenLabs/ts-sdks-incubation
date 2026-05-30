import { resolve } from 'node:path';

import { Effect, Exit, Ref } from 'effect';
import type { Scope } from 'effect';

import type { PluginKey } from '../../substrate/brand.ts';
import type { AnyResourceRef } from '../../api/define-plugin.ts';
import {
	expectNonEmptyString,
	expectOptionalPositiveInteger,
} from '../../substrate/runtime/config-validation.ts';
import {
	observeProcessLines,
	readableToByteStream,
	SpanAttr,
	type LoggerShape,
} from '../../substrate/runtime/observability/index.ts';
import { waitForHttpEndpoint } from '../../substrate/runtime/http-probe.ts';
import type { PortBrokerError } from '../../substrate/runtime/port-broker/index.ts';
import {
	awaitManagedProcessReady,
	describeProcessExitStatus,
	nodeProcessSpawner,
	onceProcessError,
	onceProcessExit,
	terminateManagedProcess,
	type ManagedProcessChild,
	type ManagedProcessSpawner,
	type ManagedProcessSpawnOptions,
} from '../../substrate/runtime/process-supervisor.ts';

import { HOST_SERVICE_DEFAULT_ENDPOINT_NAME } from './routable.ts';
import { hostServiceConfigError, HostServiceAcquireError } from './errors.ts';

export const HOST_SERVICE_PORT_TOKEN = '{port}' as const;

export type HostServiceReadyProbe =
	| {
			readonly kind: 'http';
			readonly url?: string;
			readonly timeoutMs?: number;
			readonly intervalMs?: number;
	  }
	| {
			readonly kind: 'log';
			/** Pattern matched against each stdout/stderr line. `string` is a
			 *  fast substring match. `RegExp` is evaluated via `.test(line)`
			 *  per line and runs synchronously on the observer fiber —
			 *  AVOID catastrophic-backtracking shapes like `(a+)+b` or
			 *  `(a|a)*c` which can wedge the fiber on adversarial output.
			 *  Prefer anchored, non-nested-quantifier patterns. The
			 *  plugin emits a one-time warning at registration if it
			 *  detects nested-quantifier shapes. */
			readonly pattern: string | RegExp;
			readonly stream?: 'stdout' | 'stderr' | 'both';
			readonly timeoutMs?: number;
	  };

interface HostServiceBaseOptions<After extends ReadonlyArray<AnyResourceRef>> {
	readonly name?: string;
	readonly endpointName?: string;
	readonly after?: After;
	readonly cwd?: string;
	readonly port?: number;
	readonly env?: Readonly<Record<string, string>>;
	readonly ready?: HostServiceReadyProbe;
	readonly shutdownGraceMs?: number;
}

interface HostServiceCommandOptions<
	After extends ReadonlyArray<AnyResourceRef>,
> extends HostServiceBaseOptions<After> {
	readonly command: string;
	readonly args?: ReadonlyArray<string>;
	readonly script?: never;
}

interface HostServiceScriptOptions<
	After extends ReadonlyArray<AnyResourceRef>,
> extends HostServiceBaseOptions<After> {
	readonly script: string;
	readonly command?: never;
	readonly args?: never;
}

export type HostServiceOptions<
	After extends ReadonlyArray<AnyResourceRef> = ReadonlyArray<AnyResourceRef>,
> = HostServiceCommandOptions<After> | HostServiceScriptOptions<After>;

export interface HostServiceResolvedOptions {
	readonly serviceName: string;
	readonly endpointName: string;
	readonly command: string;
	readonly args: ReadonlyArray<string>;
	readonly cwd: string;
	readonly preferredPort?: number;
	readonly env: Readonly<Record<string, string>>;
	readonly ready?: HostServiceReadyProbe;
	readonly shutdownGraceMs: number;
}

export interface HostServiceValue {
	readonly name: string;
	readonly endpointName: string;
	readonly command: string;
	readonly args: ReadonlyArray<string>;
	readonly cwd: string;
	/** The real loopback port the child (Vite) binds. Always the bound
	 *  port, regardless of how `url` is shaped — readiness probes and
	 *  direct host tooling read this. */
	readonly port: number;
	/** Canonical URL for this service: the router-fronted routed origin
	 *  (`http://<endpoint>.<stack?>.<app>.localhost:5175`) when the
	 *  supervisor derived one, the raw `http://127.0.0.1:<port>` loopback
	 *  bind otherwise. The routed form is what the dev-wallet CORS
	 *  allowlist accepts, so any consumer that hands this URL to a browser
	 *  — `devstack up` output, an app or build integration holding the
	 *  resolved `HostServiceValue` — gets a working wallet pairing.
	 *  Consumers that need the bind target read `port`. Mirrors
	 *  `WalletValue.url` ("router-fronted when available, loopback
	 *  otherwise"). */
	readonly url: string;
}

export interface PreparedHostService {
	readonly value: HostServiceValue;
	readonly start: Effect.Effect<void, HostServiceAcquireError, Scope.Scope>;
}

export type HostProcessChild = ManagedProcessChild;
export type HostProcessSpawnOptions = ManagedProcessSpawnOptions;
export type HostProcessSpawner = ManagedProcessSpawner;

export interface HostServiceAcquireContext {
	readonly allocatePort: (
		preferredPort: number | undefined,
	) => Effect.Effect<number, PortBrokerError, Scope.Scope>;
	readonly logger: LoggerShape;
	readonly pluginKey: PluginKey;
	readonly spawner?: HostProcessSpawner;
	readonly processEnv?: NodeJS.ProcessEnv;
	/**
	 * Stack identity to publish into the spawned child's environment so
	 * that in-process build integrations running INSIDE that child (the
	 * `devstack` Vite plugin in particular) can re-discover the active
	 * stack's manifest. `--stack` is a CLI flag, not an env var, and the
	 * supervisor process does not mutate its own `process.env`, so without
	 * this the child would inherit no `DEVSTACK_STACK` /
	 * `DEVSTACK_RUNTIME_ROOT` and the Vite plugin's
	 * `resolveDiscoveryEnv(process.env)` would fall back to the `main`
	 * stack — aliasing `@generated` at the wrong stack's codegen output.
	 *
	 * `stack` is the effective stack name (`Identity.stack`); `runtimeRoot`
	 * is the absolute on-disk runtime root (`RuntimeRoot.root`). The two
	 * map directly onto the `<runtimeRoot>/stacks/<stack>/manifest.json`
	 * path the supervisor writes and `discoverManifestPath` reads. Optional
	 * so non-supervised callers (and tests) can omit them.
	 */
	readonly discoveryIdentity?: {
		readonly stack: string;
		readonly runtimeRoot: string;
	};
	/**
	 * Canonical router-fronted URL for this host-service's endpoint, e.g.
	 * `http://dev.<stack>.<app>.localhost:5175`. When supplied it becomes
	 * the published `HostServiceValue.url` so every consumer that reads
	 * "the host-service's URL" (`devstack up` output, an app / build
	 * integration holding the resolved value) is pointed at the URL that
	 * actually works end-to-end — in particular the one whose Origin the
	 * dev-wallet CORS allowlist accepts. The raw `http://127.0.0.1:<port>` loopback
	 * bind is kept INTERNAL (Vite's listen + the readiness probe, which
	 * derives its own loopback literal) and remains the fallback here when
	 * no routed URL is available (router disabled, or a hostname-validation
	 * failure in the caller's best-effort derivation). Optional + nullable
	 * so non-supervised callers and tests fall back to loopback exactly as
	 * before.
	 *
	 * Mirrors the wallet's own `WalletValue.url` rule ("router-fronted URL
	 * when available, loopback otherwise") and the ARCHITECTURE.md
	 * "Host-service = endpoint-defaults bus" intent that the ROUTED origin
	 * is canonical.
	 */
	readonly routedUrl?: string | null;
}

const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;
const DEFAULT_HTTP_READY_TIMEOUT_MS = 60_000;
const DEFAULT_HTTP_READY_INTERVAL_MS = 250;
const DEFAULT_LOG_READY_TIMEOUT_MS = 60_000;
const READY_STREAM_VALUES = ['stdout', 'stderr', 'both'] as const;

const shellInvocationFor = (script: string): { command: string; args: ReadonlyArray<string> } => {
	if (process.platform === 'win32') {
		return {
			command: process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe',
			args: ['/d', '/s', '/c', script],
		};
	}
	return {
		command: '/bin/sh',
		args: ['-c', script],
	};
};

const configErrorFor =
	(serviceName: string) => (issue: Parameters<typeof hostServiceConfigError>[1]) =>
		hostServiceConfigError(serviceName, issue);

const normalizeReadyProbe = (
	serviceName: string,
	ready: HostServiceReadyProbe | undefined,
): HostServiceReadyProbe | undefined => {
	if (ready === undefined) return undefined;
	const mkError = configErrorFor(serviceName);
	if (ready.kind === 'http') {
		if (ready.url !== undefined) {
			expectNonEmptyString(ready.url, { field: 'ready.url', mkError });
		}
		expectOptionalPositiveInteger(ready.timeoutMs, { field: 'ready.timeoutMs', mkError });
		expectOptionalPositiveInteger(ready.intervalMs, { field: 'ready.intervalMs', mkError });
		return ready;
	}
	if (ready.kind === 'log') {
		if (typeof ready.pattern !== 'string' && !(ready.pattern instanceof RegExp)) {
			throw mkError({ field: 'ready.pattern', message: 'must be a string or RegExp' });
		}
		if (ready.stream !== undefined && !READY_STREAM_VALUES.includes(ready.stream)) {
			throw mkError({
				field: 'ready.stream',
				message: "must be one of 'stdout', 'stderr', 'both'",
			});
		}
		expectOptionalPositiveInteger(ready.timeoutMs, { field: 'ready.timeoutMs', mkError });
		return ready;
	}
	throw mkError({ field: 'ready.kind', message: "must be 'http' or 'log'" });
};

export const normalizeHostServiceOptions = (
	options: HostServiceOptions,
): HostServiceResolvedOptions => {
	const endpointName = options.endpointName ?? HOST_SERVICE_DEFAULT_ENDPOINT_NAME;
	const serviceName = options.name ?? endpointName;
	const mkError = configErrorFor(serviceName);
	expectNonEmptyString(serviceName, { field: 'name', mkError });
	expectNonEmptyString(endpointName, { field: 'endpointName', mkError });

	const rawCommand = (options as { readonly command?: unknown }).command;
	const rawArgs = (options as { readonly args?: unknown }).args;
	const rawScript = (options as { readonly script?: unknown }).script;
	if (rawCommand !== undefined && rawScript !== undefined) {
		throw mkError({ field: 'command', message: 'use either command or script, not both' });
	}
	if (rawCommand === undefined && rawScript === undefined) {
		throw mkError({ field: 'command', message: 'is required unless script is provided' });
	}
	if (rawScript !== undefined && rawArgs !== undefined) {
		throw mkError({ field: 'args', message: 'args are only supported with command' });
	}

	if (
		options.port !== undefined &&
		!(
			typeof options.port === 'number' &&
			Number.isInteger(options.port) &&
			options.port > 0 &&
			options.port <= 65_535
		)
	) {
		throw mkError({ field: 'port', message: 'must be an integer between 1 and 65535' });
	}
	const preferredPort = options.port;
	const cwd = resolve(options.cwd ?? process.cwd());
	const rawEnv = options.env;
	if (rawEnv !== undefined) {
		if (typeof rawEnv !== 'object' || rawEnv === null || Array.isArray(rawEnv)) {
			throw mkError({ field: 'env', message: 'must be an object of string values' });
		}
		for (const [key, entry] of Object.entries(rawEnv)) {
			if (key.length === 0) {
				throw mkError({ field: 'env', message: 'environment variable names must be non-empty' });
			}
			if (typeof entry !== 'string') {
				throw mkError({ field: `env.${key}`, message: 'must be a string' });
			}
		}
	}
	const env: Readonly<Record<string, string>> = rawEnv ?? {};
	const shutdownGraceMs =
		expectOptionalPositiveInteger(options.shutdownGraceMs, {
			field: 'shutdownGraceMs',
			mkError,
		}) ?? DEFAULT_SHUTDOWN_GRACE_MS;
	const ready = normalizeReadyProbe(serviceName, options.ready);
	const invocation =
		rawScript !== undefined
			? shellInvocationFor(expectNonEmptyString(rawScript, { field: 'script', mkError }))
			: {
					command: expectNonEmptyString(rawCommand, { field: 'command', mkError }),
					args: options.args ?? [],
				};

	return {
		serviceName,
		endpointName,
		command: invocation.command,
		args: invocation.args,
		cwd,
		...(preferredPort === undefined ? {} : { preferredPort }),
		env,
		...(ready === undefined ? {} : { ready }),
		shutdownGraceMs,
	};
};

const renderPortToken = (value: string, port: number): string =>
	value.replaceAll(HOST_SERVICE_PORT_TOKEN, String(port));

/** Heuristic: catastrophic-backtracking patterns typically nest a
 *  quantifier inside another quantifier (e.g. `(a+)+`, `(a*)*`,
 *  `(a|a)*`). This is intentionally conservative — it flags clearly
 *  risky shapes without trying to be a real ReDoS analyzer. The
 *  guard runs once at host-service start and only emits a warning,
 *  not a fail-stop. */
const looksRedosProne = (pattern: RegExp): boolean => {
	const source = pattern.source;
	// `(...)<quant><quant>` — quantifier directly after a group's quantifier.
	if (/\)[*+?](?:\{[^}]*\})?[*+?]/.test(source)) return true;
	// `(...<quant>...)<quant>` — quantifier inside a group that itself is quantified.
	if (/\([^()]*[*+?][^()]*\)[*+?]/.test(source)) return true;
	// `(a|a)*` style — alternation with overlapping branches under a quantifier.
	if (/\([^()]*\|[^()]*\)[*+]/.test(source)) return true;
	return false;
};

const renderCommand = (
	options: HostServiceResolvedOptions,
	port: number,
): {
	readonly command: string;
	readonly args: ReadonlyArray<string>;
	readonly env: NodeJS.ProcessEnv;
} => {
	const renderedEnv: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(options.env)) {
		renderedEnv[key] = renderPortToken(value, port);
	}
	return {
		command: renderPortToken(options.command, port),
		args: options.args.map((arg) => renderPortToken(arg, port)),
		env: renderedEnv,
	};
};

const hostServiceValue = (
	options: HostServiceResolvedOptions,
	port: number,
	rendered: { readonly command: string; readonly args: ReadonlyArray<string> },
	routedUrl: string | null,
): HostServiceValue => ({
	name: options.serviceName,
	endpointName: options.endpointName,
	command: rendered.command,
	args: rendered.args,
	cwd: options.cwd,
	port,
	// Canonical routed URL when the supervisor derived one, raw loopback
	// otherwise. `port` above always stays the real bound loopback port —
	// callers that need the bind target (readiness, direct host tooling)
	// read `.port`, not `.url`.
	url: routedUrl ?? `http://127.0.0.1:${port}`,
});

const terminateChild = (
	child: HostProcessChild,
	timeoutMs: number,
	logger: LoggerShape,
	pluginKey: PluginKey,
	tag: string,
): Effect.Effect<void> =>
	terminateManagedProcess(child, {
		graceMs: timeoutMs,
		processGroup: true,
		onEscalate: () =>
			logger.log(tag, pluginKey, {
				level: 'warn',
				message: 'host service did not exit after SIGTERM; sending SIGKILL',
				fields: { [SpanAttr.event]: 'process.shutdown.escalated' },
			}),
	});

const httpReady = (
	url: string,
	timeoutMs: number,
	intervalMs: number,
	exit: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>,
	processError: Promise<unknown>,
	error: HostServiceAcquireError,
): Effect.Effect<void, HostServiceAcquireError> =>
	awaitManagedProcessReady({
		ready: waitForHttpEndpoint({
			endpoint: url,
			timeoutMs,
			intervalMs,
			// HTTP readiness is a health check: require a 200. Point `url` at an
			// endpoint that returns 200 once the service is actually ready (the
			// default is the service root). Anything else — a still-compiling
			// dev server, a 5xx, a redirect — keeps polling until the readiness
			// timeout. Use a `log` probe instead when 200-at-a-URL isn't the
			// right readiness signal.
			validate: (response) => response.status === 200,
		}).pipe(
			Effect.mapError(
				(cause) =>
					new HostServiceAcquireError({
						...error,
						phase: 'ready',
						message: `host service did not become ready at ${url} within ${timeoutMs}ms`,
						cause,
					}),
			),
		),
		exit,
		processError,
		onExitBeforeReady: (status) =>
			new HostServiceAcquireError({
				...error,
				phase: 'exit',
				message: 'host service exited before readiness',
				exitCode: status.code,
				signal: status.signal,
			}),
		onProcessErrorBeforeReady: (cause) =>
			new HostServiceAcquireError({
				...error,
				phase: 'spawn',
				message: 'host service process failed before readiness',
				cause,
			}),
	});

export const logReady = (
	ready: Extract<HostServiceReadyProbe, { readonly kind: 'log' }>,
	readySignal: Promise<void>,
	exit: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>,
	processError: Promise<unknown>,
	error: HostServiceAcquireError,
): Effect.Effect<void, HostServiceAcquireError> =>
	awaitManagedProcessReady({
		ready: Effect.tryPromise({
			try: () =>
				new Promise<void>((resolveReady, rejectReady) => {
					const timeout = setTimeout(() => {
						rejectReady(
							new HostServiceAcquireError({
								...error,
								phase: 'ready',
								message: `host service did not emit readiness log within ${ready.timeoutMs ?? DEFAULT_LOG_READY_TIMEOUT_MS}ms`,
							}),
						);
					}, ready.timeoutMs ?? DEFAULT_LOG_READY_TIMEOUT_MS);
					readySignal.then(
						() => {
							clearTimeout(timeout);
							resolveReady();
						},
						// Thread a rejecting readiness signal through as the
						// inner-Promise rejection (a non-tagged cause). Without
						// this `onRejected` handler a rejected signal would be an
						// unhandled rejection and the `catch:` arm below could
						// never see it. The `catch` arm preserves this raw cause
						// on `HostServiceAcquireError.cause`.
						(cause: unknown) => {
							clearTimeout(timeout);
							rejectReady(cause);
						},
					);
				}),
			catch: (cause) =>
				cause instanceof HostServiceAcquireError
					? cause
					: new HostServiceAcquireError({
							serviceName: error.serviceName,
							cwd: error.cwd,
							command: error.command,
							args: error.args,
							phase: error.phase,
							message: error.message,
							exitCode: error.exitCode,
							signal: error.signal,
							cause,
						}),
		}),
		exit,
		processError,
		onExitBeforeReady: (status) =>
			new HostServiceAcquireError({
				...error,
				phase: 'exit',
				message: 'host service exited before readiness',
				exitCode: status.code,
				signal: status.signal,
			}),
		onProcessErrorBeforeReady: (cause) =>
			new HostServiceAcquireError({
				...error,
				phase: 'spawn',
				message: 'host service process failed before readiness',
				cause,
			}),
	});

const allocateHostPort = (
	options: HostServiceResolvedOptions,
	ctx: HostServiceAcquireContext,
): Effect.Effect<number, HostServiceAcquireError, Scope.Scope> =>
	ctx.allocatePort(options.preferredPort).pipe(
		Effect.mapError(
			(cause) =>
				new HostServiceAcquireError({
					serviceName: options.serviceName,
					cwd: options.cwd,
					command: options.command,
					args: options.args,
					phase: 'allocate-port',
					message: 'host service failed to allocate HTTP port',
					cause,
				}),
		),
	);

const startHostProcess = (
	options: HostServiceResolvedOptions,
	ctx: HostServiceAcquireContext,
	port: number,
): Effect.Effect<void, HostServiceAcquireError, Scope.Scope> =>
	Effect.gen(function* () {
		const rendered = renderCommand(options, port);
		// Per-stack discovery identity for in-child build integrations
		// (the `devstack` Vite plugin). These are a LOW-precedence base
		// layer: the inherited process env and the user's explicit
		// `options.env` both spread on top, so a user-set
		// `DEVSTACK_STACK` / `DEVSTACK_RUNTIME_ROOT` always wins. The
		// literal var names + the `RUNTIME_ROOT`-over-`STATE_DIR`
		// preference mirror `resolveDiscoveryEnv` (the plugin's reader);
		// `runtimeRoot` is absolute, so `discoverManifestPath` resolves
		// `<runtimeRoot>/stacks/<stack>/manifest.json` directly — exactly
		// where the supervisor writes the manifest.
		const discoveryEnv: NodeJS.ProcessEnv =
			ctx.discoveryIdentity === undefined
				? {}
				: {
						DEVSTACK_STACK: ctx.discoveryIdentity.stack,
						DEVSTACK_RUNTIME_ROOT: ctx.discoveryIdentity.runtimeRoot,
					};
		const env: NodeJS.ProcessEnv = {
			...discoveryEnv,
			...(ctx.processEnv ?? process.env),
			...rendered.env,
			PORT: String(port),
		};
		const tag = `host-service/${options.serviceName}`;
		// One-time ReDoS-shape warning. The log observer runs `RegExp.test`
		// synchronously per stdout/stderr line; a catastrophic-backtracking
		// pattern would wedge the observer fiber on adversarial output.
		if (
			options.ready?.kind === 'log' &&
			options.ready.pattern instanceof RegExp &&
			looksRedosProne(options.ready.pattern)
		) {
			yield* ctx.logger.log(tag, ctx.pluginKey, {
				level: 'warn',
				message:
					'host service readiness pattern has a nested-quantifier shape that may exhibit catastrophic backtracking on adversarial output; prefer anchored, non-nested patterns',
				fields: {
					[SpanAttr.serviceName]: options.serviceName,
					[SpanAttr.event]: 'host-service.ready-pattern.redos-warning',
					// Namespaced diagnostic field (the offending pattern source),
					// consistent with the `event` name above. A bare `pattern`
					// key collides with the generic attribute vocabulary.
					'host-service.ready-pattern.source': options.ready.pattern.source,
				},
			});
		}
		let resolveLogReady: (() => void) | undefined;
		const logReadySignal =
			options.ready?.kind === 'log'
				? new Promise<void>((resolveReady) => {
						resolveLogReady = resolveReady;
					})
				: null;
		const observeReadinessLine = (line: string, stream: 'stdout' | 'stderr'): void => {
			if (options.ready?.kind !== 'log') return;
			if (
				options.ready.stream !== undefined &&
				options.ready.stream !== 'both' &&
				options.ready.stream !== stream
			) {
				return;
			}
			const matches =
				typeof options.ready.pattern === 'string'
					? line.includes(options.ready.pattern)
					: options.ready.pattern.test(line);
			if (matches) resolveLogReady?.();
		};

		const spawnChild = ctx.spawner ?? nodeProcessSpawner;
		// Mutable cells declared before the setup block so the terminator
		// finalizer below can observe them.
		let shuttingDown = false;
		let exitStatus: {
			readonly code: number | null;
			readonly signal: NodeJS.Signals | null;
		} | null = null;
		// Atomic, deadlock-free process setup.
		//
		// Three things happen in one `Effect.uninterruptible` region — spawn,
		// fork the stdout/stderr line drains (`observeProcessLines`), and
		// register the kill finalizer — so that:
		//
		//  1. No interrupt can land between a successful spawn and the finalizer
		//     registration. That gap was the original leak window: a SIGINT
		//     mid-boot could orphan a detached child still holding its port.
		//
		//  2. The terminator finalizer is registered *after* the drain fibers,
		//     so on scope close (LIFO) it runs *before* they are interrupted.
		//     This ordering is load-bearing: the drains read the child's stdout/
		//     stderr via `Stream.fromAsyncIterable`, whose `iterator.next()`
		//     park is NON-interruptible — it only unblocks when the stream ends.
		//     The child's streams end when the child is killed. So the
		//     terminator must run first to kill the child (ending the streams),
		//     which lets the drains drain-to-end and their interrupts complete.
		//     Registering the terminator *before* the drains (e.g. via
		//     `acquireRelease` at the top, or any pre-`observeProcessLines`
		//     finalizer) inverts this and deadlocks scope close: the drain
		//     interrupt can never complete because the terminator that would end
		//     its stream is queued to run after it.
		//
		// The post-readiness `exited`/`processError` observers below are
		// registered later still, so they are interrupted before the terminator
		// runs — their `Effect.promise` waits are interruptible, so that unwinds
		// cleanly without needing the child to exit first.
		const child = yield* Effect.uninterruptible(
			Effect.gen(function* () {
				const spawned = yield* Effect.try({
					try: () =>
						spawnChild(rendered.command, rendered.args, {
							cwd: options.cwd,
							env,
							stdio: 'pipe',
							detached: process.platform !== 'win32',
						}),
					catch: (cause) =>
						new HostServiceAcquireError({
							serviceName: options.serviceName,
							cwd: options.cwd,
							command: rendered.command,
							args: rendered.args,
							phase: 'spawn',
							message: 'host service spawn failed',
							cause,
						}),
				});
				yield* observeProcessLines(
					{
						stdout: readableToByteStream(
							spawned.stdout as unknown as AsyncIterable<Uint8Array> | null | undefined,
						),
						stderr: readableToByteStream(
							spawned.stderr as unknown as AsyncIterable<Uint8Array> | null | undefined,
						),
					},
					{
						logger: ctx.logger,
						pluginKey: ctx.pluginKey,
						tag,
						fields: { [SpanAttr.serviceName]: options.serviceName },
						onLine: ({ line, stream }) =>
							Effect.sync(() => {
								observeReadinessLine(line, stream);
							}),
					},
				);
				yield* Effect.addFinalizer(() =>
					Effect.gen(function* () {
						shuttingDown = true;
						if (exitStatus !== null) return;
						yield* terminateChild(spawned, options.shutdownGraceMs, ctx.logger, ctx.pluginKey, tag);
					}),
				);
				return spawned;
			}),
		);
		const exited = onceProcessExit(child).then((status) => {
			exitStatus = status;
			return status;
		});
		const processError = onceProcessError(child);

		const baseError = new HostServiceAcquireError({
			serviceName: options.serviceName,
			cwd: options.cwd,
			command: rendered.command,
			args: rendered.args,
			phase: 'ready',
			message: 'host service readiness failed',
		});
		const awaitReadiness = (() => {
			if (options.ready?.kind === 'http') {
				const url = renderPortToken(options.ready.url ?? 'http://127.0.0.1:{port}', port);
				return httpReady(
					url,
					options.ready.timeoutMs ?? DEFAULT_HTTP_READY_TIMEOUT_MS,
					options.ready.intervalMs ?? DEFAULT_HTTP_READY_INTERVAL_MS,
					exited,
					processError,
					baseError,
				);
			}
			if (options.ready?.kind === 'log' && logReadySignal !== null) {
				return logReady(options.ready, logReadySignal, exited, processError, baseError);
			}
			return Effect.gen(function* () {
				yield* awaitManagedProcessReady({
					ready: Effect.promise(
						() => new Promise<void>((resolveReady) => setTimeout(resolveReady, 0)),
					),
					exit: exited,
					processError,
					onExitBeforeReady: (status) =>
						new HostServiceAcquireError({
							...baseError,
							phase: 'exit',
							message: 'host service exited before readiness',
							exitCode: status.code,
							signal: status.signal,
						}),
					onProcessErrorBeforeReady: (cause) =>
						new HostServiceAcquireError({
							...baseError,
							phase: 'spawn',
							message: 'host service process failed before readiness',
							cause,
						}),
				});
			});
		})();
		const readinessExit = yield* Effect.exit(awaitReadiness);
		if (Exit.isFailure(readinessExit)) {
			shuttingDown = true;
			if (exitStatus === null) {
				yield* terminateChild(child, options.shutdownGraceMs, ctx.logger, ctx.pluginKey, tag);
			}
			return yield* Effect.failCause(readinessExit.cause);
		}

		// Post-readiness observers. These previously used `void
		// promise.then(() => Effect.runPromise(...))` which could fire
		// AFTER the surrounding Scope had already closed (running logger
		// effects outside any scope, with `.catch(() => {})` swallowing
		// any failures). Fork into the Scope via `Effect.forkScoped` so
		// that scope-close interrupts the observer fiber cleanly — the
		// finalizer flips `shuttingDown` first, so expected-exit cases
		// still no-op as before. These observers are registered after the
		// terminator finalizer, so on scope close they are interrupted before
		// it runs; their `Effect.promise` waits are interruptible, so they
		// unwind cleanly without waiting on the child to exit.
		yield* Effect.forkScoped(
			Effect.promise(() => exited).pipe(
				Effect.flatMap((status) =>
					shuttingDown
						? Effect.void
						: ctx.logger.log(tag, ctx.pluginKey, {
								level: 'error',
								message: 'host service exited after readiness',
								fields: {
									[SpanAttr.event]: 'process.exited',
									[SpanAttr.serviceName]: options.serviceName,
									[SpanAttr.exitCode]: status.code,
									[SpanAttr.exitSignal]: status.signal,
									[SpanAttr.exitStatus]: describeProcessExitStatus(status),
								},
							}),
				),
			),
		);
		yield* Effect.forkScoped(
			Effect.promise(() => processError).pipe(
				Effect.flatMap((cause) =>
					shuttingDown
						? Effect.void
						: ctx.logger.log(tag, ctx.pluginKey, {
								level: 'error',
								message: 'host service process emitted an error after readiness',
								fields: {
									[SpanAttr.event]: 'process.error',
									[SpanAttr.serviceName]: options.serviceName,
									[SpanAttr.errorCause]: cause,
								},
							}),
				),
			),
		);
	});

export const prepareHostService = (
	options: HostServiceResolvedOptions,
	ctx: HostServiceAcquireContext,
): Effect.Effect<PreparedHostService, HostServiceAcquireError, Scope.Scope> =>
	Effect.gen(function* () {
		const port = yield* allocateHostPort(options, ctx);
		const rendered = renderCommand(options, port);
		const started = yield* Ref.make(false);
		const start = Effect.gen(function* () {
			if (yield* Ref.get(started)) return;
			yield* startHostProcess(options, ctx, port);
			yield* Ref.set(started, true);
		});

		return {
			value: hostServiceValue(options, port, rendered, ctx.routedUrl ?? null),
			start,
		};
	});

export const acquireHostService = (
	options: HostServiceResolvedOptions,
	ctx: HostServiceAcquireContext,
): Effect.Effect<HostServiceValue, HostServiceAcquireError, Scope.Scope> =>
	Effect.gen(function* () {
		const prepared = yield* prepareHostService(options, ctx);
		yield* prepared.start;
		return prepared.value;
	});
