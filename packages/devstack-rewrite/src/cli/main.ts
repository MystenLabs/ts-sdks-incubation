// devstack CLI bin entry — argv → dispatch → exit.
//
// This file is the executable entry the `bin: { devstack: ... }`
// package.json field points at. Build output: `dist/cli/main.mjs`.
//
// Architecture invariant (surfaces/cli/index.ts header):
//   "`up` must hand its long-running effect to the outer Node runtime
//    directly, not nest a runtime — otherwise SIGINT cannot reach
//    scope finalizers and container teardown leaks."
//
// Shape:
//   1. Parse argv via the SAME `parseGlobalFlags` the dispatcher uses
//      (no shim parser — every flag the dispatcher knows works on `up`).
//   2. Resolve identity (app/stack/network) from flags + env.
//   3. If verb is `up`: construct substrate Layers, build LIVE deps
//      (publisher writes to a local in-process queue AND mirrors to
//      the cross-process command channel for peer CLIs), and dispatch.
//      Effect runs as the outer Node fiber so SIGINT reaches Scope
//      finalizers.
//   4. Otherwise: build CHANNEL deps (publisher/subscriber backed by
//      `<stackRoot>/{commands,events}.ndjson`) and dispatch.

import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Cause, Effect, Exit, Fiber, FileSystem, Layer, Logger, Queue, Stream } from 'effect';

import { appName, chainId, stackName } from '../substrate/brand.ts';
import type { Identity } from '../substrate/identity.ts';
import type { EngineCommand, EngineEvent } from '../substrate/events.ts';
import type { SubscribableState } from '../substrate/projection.ts';
import { StackPathsService } from '../substrate/runtime/paths.ts';
import {
	makeProjectionRef,
	type SupervisedStack,
	type SupervisorCommandHandler,
} from '../substrate/runtime/index.ts';
import { buildSubstrateLayers, superviseStackEffect } from '../substrate/runtime/run.ts';
import {
	commandChannelPaths,
	makeCommandChannelSubscriber,
} from '../substrate/runtime/cross-process/index.ts';

import {
	dispatch,
	type CliDeps,
	CliConfigInvalidError,
	CliConfigNotFoundError,
} from '../surfaces/cli/index.ts';
import {
	makeChannelPublisher,
	makeChannelSubscriber,
	defaultProbes,
	type ChannelDepsContext,
} from '../surfaces/cli/commands/index.ts';
import type {
	CommandPublisher,
	EventSubscriber,
} from '../surfaces/cli/commands/command-channel.ts';
import type { LoadedConfig, ShutdownLatch } from '../surfaces/cli/commands/up.ts';
import { SnapshotOrchestratorService } from '../orchestrators/snapshot/index.ts';
import {
	buildProductionOrchestratorSinks,
	buildProductionPostAcquireHook,
	layerProductionOrchestrators,
} from '../orchestrators/runtime-composition.ts';
import type { StatusReader } from '../surfaces/cli/commands/status.ts';
import { parseGlobalFlags } from '../surfaces/cli/flags.ts';
import { makeTuiSurface } from '../surfaces/tui/index.ts';
import { makeSnapshotReader } from './snapshot-reader.ts';
import { makeQueueCommandPublisher, resolveUpRendererMode } from './up-lifecycle.ts';

// -----------------------------------------------------------------------------
// Config loader (default-export = Stack)
// -----------------------------------------------------------------------------

const DEFAULT_CONFIG_PATH = './devstack.config.ts';

const resolveConfigPath = (configPath: string | undefined): string | null => {
	const target = configPath ?? DEFAULT_CONFIG_PATH;
	const explicit = isAbsolute(target) ? target : resolvePath(process.cwd(), target);
	if (existsSync(explicit)) return explicit;
	if (configPath !== undefined && configPath !== DEFAULT_CONFIG_PATH) return null;
	let dir = process.cwd();
	for (;;) {
		const candidate = resolvePath(dir, 'devstack.config.ts');
		if (existsSync(candidate)) return candidate;
		const parent = resolvePath(dir, '..');
		if (parent === dir) return null;
		dir = parent;
	}
};

interface RawConfigModule {
	readonly default?: unknown;
}

const validateStackModule = (
	resolvedConfigPath: string,
	mod: unknown,
): LoadedConfig & { readonly stack: SupervisedStack } => {
	const m = mod as RawConfigModule;
	const def = m.default;
	if (def === null || typeof def !== 'object' || (def as { _tag?: unknown })._tag !== 'Stack') {
		throw new CliConfigInvalidError({
			message: `config at ${resolvedConfigPath} does not default-export a Stack value (got _tag=${String((def as { _tag?: unknown })?._tag)})`,
		});
	}
	return {
		stack: def as SupervisedStack,
		resolvedConfigPath,
	};
};

const makeConfigLoader = () => ({
	load: (configPath: string | undefined) =>
		Effect.gen(function* () {
			const abs = resolveConfigPath(configPath);
			if (abs === null) {
				const attempted =
					configPath !== undefined
						? resolvePath(process.cwd(), configPath)
						: resolvePath(process.cwd(), DEFAULT_CONFIG_PATH);
				return yield* Effect.fail(
					new CliConfigNotFoundError({
						message: `devstack config not found at ${attempted}`,
						searchedPaths: [attempted],
					}),
				);
			}
			const url = pathToFileURL(abs).href;
			const mod = yield* Effect.tryPromise({
				try: () => import(url) as Promise<unknown>,
				catch: (cause) =>
					new CliConfigInvalidError({
						message: `failed to import ${abs}: ${cause instanceof Error ? cause.message : String(cause)}`,
						cause,
					}),
			});
			return yield* Effect.try({
				try: () => validateStackModule(abs, mod),
				catch: (cause) =>
					cause instanceof CliConfigInvalidError
						? cause
						: new CliConfigInvalidError({
								message: `invalid config at ${abs}`,
								cause,
							}),
			});
		}) as Effect.Effect<LoadedConfig, CliConfigNotFoundError | CliConfigInvalidError>,
});

// -----------------------------------------------------------------------------
// Identity resolution
// -----------------------------------------------------------------------------

interface ResolvedIdentity {
	readonly app: string;
	readonly stack: string;
	readonly network: string;
	readonly runtimeRoot: string;
	readonly stackRoot: string;
	readonly rosterFile: string;
	readonly appRoot: string;
}

/** Resolve identity from flags + env. Stack is also inferred from
 *  `<appRoot>/.active` when neither flag nor env carries a value. */
const resolveIdentity = (params: {
	readonly app: string | undefined;
	readonly stack: string | undefined;
	readonly network: string | undefined;
	readonly stateDir: string | undefined;
}): ResolvedIdentity => {
	const app = params.app ?? process.env.DEVSTACK_APP ?? 'devstack';
	const stateDir =
		params.stateDir ??
		process.env.DEVSTACK_STATE_DIR ??
		resolvePath(process.env.HOME ?? process.cwd(), '.devstack');
	const appRoot = resolvePath(stateDir, app);
	let stack = params.stack ?? process.env.DEVSTACK_STACK;
	if (stack === undefined) {
		const activeFile = resolvePath(appRoot, '.active');
		if (existsSync(activeFile)) {
			try {
				// Inline read — cheap, sync, deterministic at boot. The
				// node:fs sync read is the canonical "active stack" probe
				// across both surfaces (CLI + TUI).
				// eslint-disable-next-line @typescript-eslint/no-require-imports
				const { readFileSync } = require('node:fs') as typeof import('node:fs');
				const content = readFileSync(activeFile, 'utf8').trim();
				if (content.length > 0) stack = content;
			} catch {
				// fall through to default
			}
		}
	}
	stack = stack ?? 'main';
	const network = params.network ?? process.env.DEVSTACK_NETWORK ?? 'sui:local';
	const stackRoot = resolvePath(appRoot, stack);
	return {
		app,
		stack,
		network,
		runtimeRoot: stateDir,
		stackRoot,
		rosterFile: resolvePath(stackRoot, 'roster.json'),
		appRoot,
	};
};

// -----------------------------------------------------------------------------
// Verb deps composition (channel-backed)
// -----------------------------------------------------------------------------

const emptyStatusReader = (): StatusReader => ({
	readState: (_app, _stack) => Effect.succeed<SubscribableState | null>(null),
});

/** Build the deps bundle for non-`up` verbs. The publisher/subscriber
 *  go through the cross-process command channel; the publisher probes
 *  the roster for a live supervisor on every publish (cheap — same
 *  liveness predicate the substrate already uses). */
const buildChannelDeps = (identity: ResolvedIdentity): CliDeps => {
	const loader = makeConfigLoader();
	const channelCtx: ChannelDepsContext = {
		app: identity.app,
		stack: identity.stack,
		stackRoot: identity.stackRoot,
		rosterFile: identity.rosterFile,
	};
	const publisher: CommandPublisher = makeChannelPublisher(channelCtx);
	const subscriber: EventSubscriber = makeChannelSubscriber(channelCtx);
	const shutdown: ShutdownLatch = { await: Effect.void };
	return {
		up: { loader, publisher, subscriber, shutdown },
		down: { publisher },
		status: { reader: emptyStatusReader() },
		snapshot: { publisher, reader: makeSnapshotReader(identity) },
		prune: { publisher },
		logs: { subscriber, shutdown: Effect.void },
		doctor: {
			probes: defaultProbes({
				stateDir: identity.runtimeRoot,
				appRoot: identity.appRoot,
			}),
		},
		codegen: { publisher },
		config: { loader },
		apply: { publisher },
		wipe: { publisher },
		stack: {
			resolveAppRoot: () => Effect.succeed(identity.appRoot),
		},
		fork: { publisher },
	};
};

// -----------------------------------------------------------------------------
// `up` — live wiring
// -----------------------------------------------------------------------------

const makeSnapshotCommandHandler = (params: {
	readonly snapshot: import('../orchestrators/snapshot/index.ts').SnapshotOrchestrator;
	readonly fs: FileSystem.FileSystem;
}): SupervisorCommandHandler => {
	const provideFileSystem = <A, E>(
		effect: Effect.Effect<A, E, FileSystem.FileSystem>,
	): Effect.Effect<A, E, never> =>
		effect.pipe(Effect.provideService(FileSystem.FileSystem, params.fs));

	return (cmd) => {
		switch (cmd.tag) {
			case 'snapshot.capture':
				return provideFileSystem(params.snapshot.capture({ label: cmd.label })).pipe(
					Effect.map((meta) => [
						{
							tag: 'snapshot.captured',
							snapshotId: meta.id,
							at: Date.now(),
						},
					]),
				);
			case 'snapshot.restore':
				return provideFileSystem(params.snapshot.restore({ id: cmd.snapshotId })).pipe(
					Effect.map((meta) => [
						{
							tag: 'snapshot.restored',
							snapshotId: meta.id,
							at: Date.now(),
						},
					]),
				);
			case 'snapshot.list':
				return provideFileSystem(params.snapshot.list).pipe(Effect.as([]));
			case 'snapshot.delete':
				return provideFileSystem(params.snapshot.delete(cmd.snapshotId)).pipe(Effect.as([]));
			case 'wipe.requested':
				return provideFileSystem(params.snapshot.wipe({})).pipe(Effect.as([]));
			case 'prune.requested':
				return provideFileSystem(params.snapshot.prune({})).pipe(Effect.as([]));
			default:
				return Effect.succeed([]);
		}
	};
};

/**
 * Run `devstack up`. Wires the substrate Layer stack + supervisor +
 * cross-process command-channel subscriber so peer CLI publishes reach
 * the in-process supervisor. The Effect runs as the outer Node fiber.
 *
 * The command channel is "outside" the in-process queue: a peer's
 * `down` writes to `commands.ndjson`, which a forwarder fiber reads
 * and offers onto the supervisor's `commands` queue. Events from the
 * supervisor's hub are mirrored to `events.ndjson` so peer CLIs can
 * tail them.
 */
const runUpLive = (
	configPath: string | undefined,
	identity: ResolvedIdentity,
	options: {
		readonly renderer: ReturnType<typeof parseGlobalFlags>['renderer'];
		readonly stdoutIsTty: boolean;
	},
): Effect.Effect<void> => {
	const loader = makeConfigLoader();
	return Effect.gen(function* () {
		const loaded = yield* loader.load(configPath).pipe(
			Effect.matchEffect({
				onFailure: (err) =>
					Effect.gen(function* () {
						process.stderr.write(`error: ${err.message}\n`);
						process.exitCode = err._tag === 'CliConfigNotFoundError' ? 66 : 78;
						return yield* Effect.fail('config-load-failed' as const);
					}),
				onSuccess: (v) => Effect.succeed(v),
			}),
		);
		const stack = (loaded as LoadedConfig & { readonly stack: SupervisedStack }).stack;

		const identityValue: Identity = {
			app: appName(identity.app),
			stack: stackName(stack.options.stackName ?? identity.stack),
			chain: chainId(identity.network),
		};

		const appRoot = dirname(loaded.resolvedConfigPath);
		const rendererMode = resolveUpRendererMode({
			cliRenderer: options.renderer,
			stackRenderer: stack.options.renderer,
			stdoutIsTty: options.stdoutIsTty,
		});
		const substrateLayers = layerProductionOrchestrators({
			codegen: {
				appRoot,
				outputDir: stack.options.codegen?.outputDir,
				stackSubdir: stack.options.codegen?.stackSubdir ?? null,
			},
		}).pipe(Layer.provideMerge(buildSubstrateLayers(identityValue, identity.runtimeRoot)));

		const program = Effect.gen(function* () {
			const state = yield* makeProjectionRef();
			const snapshot = yield* SnapshotOrchestratorService;
			const fs = yield* FileSystem.FileSystem;
			const snapshotCommandHandler = makeSnapshotCommandHandler({ snapshot, fs });
			const orchestratorSinks = yield* buildProductionOrchestratorSinks();
			const postAcquireHook = yield* buildProductionPostAcquireHook();
			yield* superviseStackEffect(
				{ _tag: 'Stack', members: stack.members, options: stack.options },
				identityValue,
				state,
				{
					orchestratorSinks,
					commandHandler: snapshotCommandHandler,
					postAcquireHook,
					beforeInitialAcquire: (handle) =>
						Effect.gen(function* () {
							const rendererEvents = yield* Queue.unbounded<EngineEvent>();
							const renderer = makeTuiSurface({
								mode: rendererMode,
								publishCommand: makeQueueCommandPublisher(handle.commands),
							});
							yield* Effect.addFinalizer(() =>
								renderer.flush.pipe(Effect.catch(() => Effect.void)),
							);
							yield* Effect.forkScoped(
								renderer.mount(handle.state, Stream.fromQueue(rendererEvents)).pipe(
									Effect.catch((cause) =>
										Effect.sync(() => {
											process.stderr.write(`renderer failed: ${cause.detail ?? String(cause)}\n`);
										}),
									),
								),
							);
							// Bridge the cross-process command channel into the
							// supervisor. Peer CLIs publishing `down` /
							// `snapshot.*` / `prune` / `apply.requested` etc.
							// write to `commands.ndjson`; this fiber forwards
							// each into the supervisor's in-process command
							// queue. Engine events are mirrored back to
							// `events.ndjson` so peer logs/status tailers see
							// the supervisor's emissions.
							const stackPaths = yield* StackPathsService;
							const channelPaths = commandChannelPaths(stackPaths.stackRoot);
							const channel = yield* makeCommandChannelSubscriber(channelPaths, {
								fromOffset: 'current',
							}).pipe(Effect.catch(() => Effect.succeed(null)));
							if (channel !== null) {
								yield* Effect.forkScoped(
									channel.commands.pipe(
										Stream.runForEach((record) =>
											Effect.gen(function* () {
												yield* Queue.offer(handle.commands, record.command as EngineCommand);
												yield* channel.ack(record.id).pipe(Effect.catch(() => Effect.void));
											}),
										),
										Effect.catch(() => Effect.void),
									),
								);
							}
							yield* Effect.forkScoped(
								Stream.fromQueue(handle.events).pipe(
									Stream.runForEach((event) =>
										Effect.gen(function* () {
											yield* Queue.offer(rendererEvents, event);
											if (channel !== null) {
												yield* channel.publishEvent(event).pipe(Effect.catch(() => Effect.void));
											}
										}),
									),
								),
							);
						}),
				},
			);
		});

		yield* program.pipe(
			Effect.provide(substrateLayers),
			Effect.provide(Logger.layer([Logger.consolePretty()])),
			Effect.matchCauseEffect({
				onFailure: (cause) =>
					Effect.sync(() => {
						process.stderr.write(
							`\nerror: stack failed\n${Cause.pretty(cause as Cause.Cause<unknown>)}\n`,
						);
						process.exitCode = 1;
					}),
				onSuccess: () =>
					Effect.sync(() => {
						process.exitCode ??= 0;
					}),
			}),
		);
	}).pipe(Effect.catch(() => Effect.void));
};

const runApplyLive = (
	configPath: string | undefined,
	identity: ResolvedIdentity,
): Effect.Effect<void> => {
	const loader = makeConfigLoader();
	return Effect.gen(function* () {
		const loaded = yield* loader.load(configPath).pipe(
			Effect.matchEffect({
				onFailure: (err) =>
					Effect.gen(function* () {
						process.stderr.write(`error: ${err.message}\n`);
						process.exitCode = err._tag === 'CliConfigNotFoundError' ? 66 : 78;
						return yield* Effect.fail('config-load-failed' as const);
					}),
				onSuccess: (v) => Effect.succeed(v),
			}),
		);
		const stack = (loaded as LoadedConfig & { readonly stack: SupervisedStack }).stack;
		const identityValue: Identity = {
			app: appName(identity.app),
			stack: stackName(stack.options.stackName ?? identity.stack),
			chain: chainId(identity.network),
		};
		const appRoot = dirname(loaded.resolvedConfigPath);
		const substrateLayers = layerProductionOrchestrators({
			codegen: {
				appRoot,
				outputDir: stack.options.codegen?.outputDir,
				stackSubdir: stack.options.codegen?.stackSubdir ?? null,
			},
		}).pipe(Layer.provideMerge(buildSubstrateLayers(identityValue, identity.runtimeRoot)));

		const program = Effect.gen(function* () {
			const state = yield* makeProjectionRef();
			const orchestratorSinks = yield* buildProductionOrchestratorSinks();
			const postAcquireHook = yield* buildProductionPostAcquireHook();
			yield* superviseStackEffect(
				{ _tag: 'Stack', members: stack.members, options: stack.options },
				identityValue,
				state,
				{
					orchestratorSinks,
					postAcquireHook,
					lifetime: 'one-shot',
				},
			);
		});

		yield* program.pipe(
			Effect.provide(substrateLayers),
			Effect.provide(Logger.layer([Logger.consolePretty()])),
			Effect.matchCauseEffect({
				onFailure: (cause) =>
					Effect.sync(() => {
						process.stderr.write(
							`\nerror: stack apply failed\n${Cause.pretty(cause as Cause.Cause<unknown>)}\n`,
						);
						process.exitCode = 1;
					}),
				onSuccess: () =>
					Effect.sync(() => {
						process.exitCode ??= 0;
					}),
			}),
		);
	}).pipe(Effect.catch(() => Effect.void));
};

// -----------------------------------------------------------------------------
// Bin entry
// -----------------------------------------------------------------------------

const findVerb = (argv: ReadonlyArray<string>): string | undefined => {
	try {
		const flags = parseGlobalFlags(argv, {
			env: { ...process.env },
			stdinIsTty: Boolean((process.stdin as { isTTY?: boolean }).isTTY),
		});
		return flags.rest.find((tok) => !tok.startsWith('-'));
	} catch {
		for (const tok of argv) {
			if (tok === '--') return undefined;
			if (!tok.startsWith('-')) return tok;
		}
	}
	return undefined;
};

const isMetaRequest = (flags: ReturnType<typeof parseGlobalFlags>): boolean =>
	flags.schemaEmit || flags.version || flags.help;

export const runCli = async (
	argv: ReadonlyArray<string> = process.argv.slice(2),
): Promise<void> => {
	const stdinIsTty = Boolean((process.stdin as { isTTY?: boolean }).isTTY);
	const env: Record<string, string | undefined> = { ...process.env };
	let preFlags;
	try {
		preFlags = parseGlobalFlags(argv, { env, stdinIsTty });
	} catch {
		// Let the dispatcher render the parse error in its own envelope.
		preFlags = {
			app: undefined,
			stack: undefined,
			network: undefined,
			stateDir: undefined,
		} as { app?: string; stack?: string; network?: string; stateDir?: string };
	}
	const identity = resolveIdentity({
		app: preFlags.app,
		stack: preFlags.stack,
		network: preFlags.network,
		stateDir: preFlags.stateDir,
	});

	// `up` and one-shot `apply` construct substrate Layers locally.
	// Other verbs go through the standard dispatcher with channel-backed
	// deps and target a live supervisor.
	if ('rest' in preFlags && isMetaRequest(preFlags)) {
		const deps = buildChannelDeps(identity);
		await Effect.runPromise(
			dispatch(deps, { argv, env, stdinIsTty }) as Effect.Effect<void, never, never>,
		);
		return;
	}

	const verb =
		'rest' in preFlags ? preFlags.rest.find((tok) => !tok.startsWith('-')) : findVerb(argv);

	if (verb === 'up' || verb === 'apply') {
		// Parse via the same global flag parser the dispatcher uses, so
		// `up` gets every flag — `--dry-run`, `--verbose`, `--state-dir`,
		// `--json`, etc. — not just the four the old shim parser knew.
		let flags;
		try {
			flags = parseGlobalFlags(argv, {
				env,
				stdinIsTty,
			});
		} catch (err) {
			process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
			process.exitCode = 64;
			return;
		}
		const identity = resolveIdentity({
			app: flags.app,
			stack: flags.stack,
			network: flags.network,
			stateDir: flags.stateDir,
		});
		// Apply `--network` before config import — the loader reads env
		// at top level, so this must happen before runUpLive's loader
		// runs. The dispatcher applies this for the channel path; we
		// mirror here.
		if (flags.network !== undefined) {
			process.env.DEVSTACK_NETWORK = flags.network;
		}
		const program =
			verb === 'up'
				? runUpLive(flags.configPath, identity, {
						renderer: flags.renderer,
						stdoutIsTty: Boolean((process.stdout as { isTTY?: boolean }).isTTY),
					})
				: runApplyLive(flags.configPath, identity);
		const fiber = Effect.runFork(program);
		const exit = await Effect.runPromise(
			Fiber.await(fiber) as Effect.Effect<Exit.Exit<void, unknown>, never, never>,
		);
		if (process.exitCode === undefined || process.exitCode === 0) {
			if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
				process.exitCode = 1;
			}
		}
		return;
	}

	// Every other verb: channel-backed deps + dispatcher.
	// Identity resolution mirrors `up`'s path so verbs hit the same
	// stack root. The dispatcher re-parses argv from scratch.
	const deps = buildChannelDeps(identity);
	await Effect.runPromise(
		dispatch(deps, { argv, env, stdinIsTty }) as Effect.Effect<void, never, never>,
	);
};

const isMainEntrypoint = (): boolean => {
	const argvPath = process.argv[1];
	if (argvPath === undefined) return false;
	try {
		return realpathSync(argvPath) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return import.meta.url === pathToFileURL(argvPath).href;
	}
};

if (isMainEntrypoint()) {
	runCli().catch((err) => {
		process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
		process.exitCode = 1;
	});
}
