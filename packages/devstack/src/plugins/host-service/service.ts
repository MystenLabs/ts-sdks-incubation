import { resolve } from 'node:path';

import { Effect, Exit, Ref } from 'effect';
import type { Scope } from 'effect';

import type { PluginKey } from '../../substrate/brand.ts';
import type { AnyResourceRef } from '../../api/define-plugin.ts';
import {
	expectNonEmptyString,
	expectOneOf,
	expectOptionalNonEmptyString,
	expectOptionalPort,
	expectOptionalPositiveInteger,
	expectStringRecord,
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
			readonly pattern: string | RegExp;
			readonly stream?: 'stdout' | 'stderr' | 'both';
			readonly timeoutMs?: number;
	  };

interface HostServiceCommandOptions<Needs extends ReadonlyArray<AnyResourceRef>> {
	readonly name?: string;
	readonly endpointName?: string;
	readonly needs?: Needs;
	readonly command: string;
	readonly args?: ReadonlyArray<string>;
	readonly script?: never;
	readonly cwd?: string;
	readonly port?: number;
	readonly env?: Readonly<Record<string, string>>;
	readonly ready?: HostServiceReadyProbe;
	readonly shutdownGraceMs?: number;
}

interface HostServiceScriptOptions<Needs extends ReadonlyArray<AnyResourceRef>> {
	readonly name?: string;
	readonly endpointName?: string;
	readonly needs?: Needs;
	readonly script: string;
	readonly command?: never;
	readonly args?: never;
	readonly cwd?: string;
	readonly port?: number;
	readonly env?: Readonly<Record<string, string>>;
	readonly ready?: HostServiceReadyProbe;
	readonly shutdownGraceMs?: number;
}

export type HostServiceOptions<
	Needs extends ReadonlyArray<AnyResourceRef> = ReadonlyArray<AnyResourceRef>,
> = HostServiceCommandOptions<Needs> | HostServiceScriptOptions<Needs>;

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
	readonly port: number;
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
}

const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;
const DEFAULT_HTTP_READY_TIMEOUT_MS = 60_000;
const DEFAULT_HTTP_READY_INTERVAL_MS = 250;
const DEFAULT_LOG_READY_TIMEOUT_MS = 60_000;

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
		expectOptionalNonEmptyString(ready.url, { field: 'ready.url', mkError });
		expectOptionalPositiveInteger(ready.timeoutMs, { field: 'ready.timeoutMs', mkError });
		expectOptionalPositiveInteger(ready.intervalMs, { field: 'ready.intervalMs', mkError });
		return ready;
	}
	if (ready.kind === 'log') {
		if (typeof ready.pattern !== 'string' && !(ready.pattern instanceof RegExp)) {
			throw mkError({ field: 'ready.pattern', message: 'must be a string or RegExp' });
		}
		if (ready.stream !== undefined) {
			expectOneOf(ready.stream, ['stdout', 'stderr', 'both'] as const, {
				field: 'ready.stream',
				mkError,
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

	const hasCommand = 'command' in options && options.command !== undefined;
	const hasScript = 'script' in options && options.script !== undefined;
	if (hasCommand === hasScript) {
		throw mkError({ field: 'command', message: 'provide exactly one of command or script' });
	}

	const preferredPort = expectOptionalPort(options.port, { field: 'port', mkError });
	const cwd = resolve(options.cwd ?? process.cwd());
	const env = expectStringRecord(options.env, { field: 'env', mkError });
	const shutdownGraceMs =
		expectOptionalPositiveInteger(options.shutdownGraceMs, {
			field: 'shutdownGraceMs',
			mkError,
		}) ?? DEFAULT_SHUTDOWN_GRACE_MS;
	const ready = normalizeReadyProbe(serviceName, options.ready);

	if (hasScript) {
		return {
			serviceName,
			endpointName,
			command: 'bash',
			args: ['-lc', expectNonEmptyString(options.script, { field: 'script', mkError })],
			cwd,
			...(preferredPort === undefined ? {} : { preferredPort }),
			env,
			...(ready === undefined ? {} : { ready }),
			shutdownGraceMs,
		};
	}

	return {
		serviceName,
		endpointName,
		command: expectNonEmptyString(options.command, { field: 'command', mkError }),
		args: options.args ?? [],
		cwd,
		...(preferredPort === undefined ? {} : { preferredPort }),
		env,
		...(ready === undefined ? {} : { ready }),
		shutdownGraceMs,
	};
};

const renderPortToken = (value: string, port: number): string =>
	value.replaceAll(HOST_SERVICE_PORT_TOKEN, String(port));

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
): HostServiceValue => ({
	name: options.serviceName,
	endpointName: options.endpointName,
	command: rendered.command,
	args: rendered.args,
	cwd: options.cwd,
	port,
	url: `http://127.0.0.1:${port}`,
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
		ready: waitForHttpEndpoint({ endpoint: url, timeoutMs, intervalMs }).pipe(
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

const logReady = (
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
					readySignal.then(() => {
						clearTimeout(timeout);
						resolveReady();
					});
				}),
			catch: (cause) => (cause instanceof HostServiceAcquireError ? cause : error),
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
		const env: NodeJS.ProcessEnv = {
			...(ctx.processEnv ?? process.env),
			...rendered.env,
			PORT: String(port),
		};
		const tag = `host-service/${options.serviceName}`;
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
		const child = yield* Effect.try({
			try: () =>
				spawnChild(rendered.command, rendered.args, {
					cwd: options.cwd,
					env,
					stdio: 'pipe',
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
		let shuttingDown = false;
		let exitStatus: {
			readonly code: number | null;
			readonly signal: NodeJS.Signals | null;
		} | null = null;
		const exited = onceProcessExit(child).then((status) => {
			exitStatus = status;
			return status;
		});
		const processError = onceProcessError(child);
		yield* observeProcessLines(
			{
				stdout: readableToByteStream(
					child.stdout as unknown as AsyncIterable<Uint8Array> | null | undefined,
				),
				stderr: readableToByteStream(
					child.stderr as unknown as AsyncIterable<Uint8Array> | null | undefined,
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
				yield* terminateChild(child, options.shutdownGraceMs, ctx.logger, ctx.pluginKey, tag);
			}),
		);

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

		void exited.then((status) => {
			if (shuttingDown) return;
			void Effect.runPromise(
				ctx.logger.log(tag, ctx.pluginKey, {
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
			).catch(() => {});
		});
		void processError.then((cause) => {
			if (shuttingDown) return;
			void Effect.runPromise(
				ctx.logger.log(tag, ctx.pluginKey, {
					level: 'error',
					message: 'host service process emitted an error after readiness',
					fields: {
						[SpanAttr.event]: 'process.error',
						[SpanAttr.serviceName]: options.serviceName,
						[SpanAttr.errorCause]: cause,
					},
				}),
			).catch(() => {});
		});
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
			value: hostServiceValue(options, port, rendered),
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
