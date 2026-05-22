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
//   1. The Stricli-backed dispatcher validates argv and builds command-
//      scoped flags.
//   2. Attached `up` and one-shot `apply` construct substrate Layers
//      directly so signals reach scope finalizers.
//   3. Offline/direct commands read or mutate the selected stack root
//      without publishing peer commands to a live supervisor.

import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
	Cause,
	Effect,
	Exit,
	FileSystem,
	Layer,
	Logger,
	Queue,
	Stream,
	SubscriptionRef,
} from 'effect';

import { appName, chainId, stackName } from '../substrate/brand.ts';
import type { Identity } from '../substrate/identity.ts';
import type { EngineEvent } from '../substrate/events.ts';
import type { SubscribableState } from '../substrate/projection.ts';
import { StackPathsService } from '../substrate/runtime/paths.ts';
import {
	makeProjectionRef,
	persistProjectionChanges,
	readProjectionSnapshot,
	type SupervisedStack,
	type SupervisorCommandHandler,
	writeProjectionSnapshot,
} from '../substrate/runtime/index.ts';
import { buildSubstrateLayers, superviseStackEffect } from '../substrate/runtime/run.ts';

import {
	dispatch,
	type CliDeps,
	CliConfigInvalidError,
	CliConfigNotFoundError,
	CliSupervisorLiveError,
} from '../surfaces/cli/index.ts';
import { defaultProbes, probeSupervisorPresence } from '../surfaces/cli/commands/index.ts';
import { nodeConfirmPrompt } from '../surfaces/cli/commands/confirm-node.ts';
import type { LoadedConfig } from '../surfaces/cli/commands/config-loader.ts';
import {
	SnapshotOrchestratorService,
	type RestoreParticipant,
	type SnapshotMetadata,
} from '../orchestrators/snapshot/index.ts';
import {
	buildProductionOrchestratorSinks,
	buildProductionPostAcquireHook,
	layerProductionOrchestrators,
} from '../orchestrators/runtime-composition.ts';
import {
	extendBuiltInPluginContext,
	layerBuiltInPluginRuntime,
} from '../runtime/built-in-plugin-layers.ts';
import type { StatusReader } from '../surfaces/cli/commands/status.ts';
import type { GlobalFlags } from '../surfaces/cli/flags.ts';
import { makeTuiSurface } from '../surfaces/tui/index.ts';
import { makeSnapshotReader } from './snapshot-reader.ts';
import { makeQueueCommandPublisher, resolveUpRendererMode } from './up-lifecycle.ts';
import { resolveAppName, resolveStackName } from '../api/inference-network.ts';
import { readStackEngine, type Stack } from '../api/define-devstack.ts';
import { makeDirectPruneDeps } from './prune-direct.ts';
import { removeRouterDispatchFilesForStack } from '../orchestrators/router/cleanup.ts';

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
	let stack: SupervisedStack;
	try {
		stack = readStackEngine(def as Stack<SupervisedStack['members']>);
	} catch (cause) {
		throw new CliConfigInvalidError({
			message: `config at ${resolvedConfigPath} default-exported an invalid Stack handle: ${cause instanceof Error ? cause.message : String(cause)}`,
		});
	}
	return {
		stack,
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
	readonly stacksRoot: string;
	readonly stackRoot: string;
	readonly rosterFile: string;
}

/** Resolve identity from flags + env. App and stack fall through the
 *  shared cwd/package metadata resolver before their defaults. */
const resolveIdentity = (params: {
	readonly app: string | undefined;
	readonly stack: string | undefined;
	readonly network: string | undefined;
	readonly stateDir: string | undefined;
	readonly cwd?: string;
}): ResolvedIdentity => {
	const cwd = params.cwd ?? process.cwd();
	const app = resolveAppName({
		explicit: params.app,
		cwd,
	});
	const stateDir =
		params.stateDir ??
		process.env.DEVSTACK_STATE_DIR ??
		resolvePath(process.env.HOME ?? process.cwd(), '.devstack');
	const runtimeRoot = resolvePath(stateDir);
	const stacksRoot = resolvePath(runtimeRoot, 'stacks');
	const stack = resolveStackName({
		explicit: params.stack,
		cwd,
	});
	const network = params.network ?? process.env.DEVSTACK_NETWORK ?? 'sui:local';
	const stackRoot = resolvePath(stacksRoot, stack);
	return {
		app,
		stack,
		network,
		runtimeRoot,
		stacksRoot,
		stackRoot,
		rosterFile: resolvePath(stackRoot, 'roster.json'),
	};
};

// -----------------------------------------------------------------------------
// Verb deps composition (attached + direct/offline)
// -----------------------------------------------------------------------------

const projectionStatusReader = (identity: ResolvedIdentity): StatusReader => ({
	readState: (_app, _stack) =>
		Effect.sync(() => readProjectionSnapshot(identity.stackRoot) as SubscribableState | null),
});

const commandResultFromProcess = (): { readonly exitCode: number } => ({
	exitCode: typeof process.exitCode === 'number' ? process.exitCode : 0,
});

const buildDirectDeps = (identity: ResolvedIdentity): CliDeps => {
	const loader = makeConfigLoader();
	return {
		up: {
			run: (flags) =>
				runUpLive(flags.configPath, identity, {
					renderer: flags.renderer,
					stdoutIsTty: Boolean((process.stdout as { isTTY?: boolean }).isTTY),
				}).pipe(Effect.map(() => commandResultFromProcess())),
		},
		apply: {
			run: (flags) =>
				runApplyLive(flags.configPath, identity).pipe(Effect.map(() => commandResultFromProcess())),
		},
		status: { reader: projectionStatusReader(identity) },
		snapshot: makeDirectSnapshotDeps(identity),
		prune: makeDirectPruneDeps({ runtimeRoot: identity.runtimeRoot }),
		doctor: {
			probes: defaultProbes({
				stateDir: identity.runtimeRoot,
				appRoot: identity.stacksRoot,
			}),
		},
		config: { loader },
		wipe: {
			wipe: () => runWipeDirect(identity),
			confirm: nodeConfirmPrompt,
		},
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

	return (cmd, handlerCtx) => {
		switch (cmd.tag) {
			case 'snapshot.capture':
				return provideFileSystem(
					params.snapshot.capture({
						id: cmd.snapshotId,
						label: cmd.name,
						onProgress: (progress) =>
							handlerCtx.publish({
								tag: 'snapshot.captureProgress',
								...(cmd.snapshotId === undefined ? {} : { snapshotId: cmd.snapshotId }),
								...(cmd.name === undefined ? {} : { name: cmd.name }),
								phase: progress.phase,
								...(progress.detail === undefined ? {} : { detail: progress.detail }),
								...(progress.pausedContainers === undefined
									? {}
									: { pausedContainers: progress.pausedContainers }),
								...(progress.totalContainers === undefined
									? {}
									: { totalContainers: progress.totalContainers }),
								at: Date.now(),
							}),
					}),
				).pipe(
					Effect.map((meta) => [
						{
							tag: 'snapshot.captured',
							snapshotId: meta.id,
							...(meta.label === null ? {} : { name: meta.label }),
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
 * Run `devstack up`. Wires the substrate Layer stack, supervisor,
 * attached renderer, and in-process TUI command queue. The Effect runs
 * as the outer Node fiber so SIGINT reaches scope finalizers.
 */
const runUpLive = (
	configPath: string | undefined,
	identity: ResolvedIdentity,
	options: {
		readonly renderer: GlobalFlags['renderer'];
		readonly stdoutIsTty: boolean;
	},
): Effect.Effect<void> => {
	const loader = makeConfigLoader();
	return Effect.gen(function* () {
		const loaded = yield* loader.load(configPath).pipe(
			Effect.catch((err) =>
				Effect.sync(() => {
					process.stderr.write(`error: ${err.message}\n`);
					process.exitCode = err._tag === 'CliConfigNotFoundError' ? 66 : 78;
					return null;
				}),
			),
		);
		if (loaded === null) return;
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
			const postAcquireHook = yield* buildProductionPostAcquireHook({
				extras: stack.options.extras,
			});
			yield* superviseStackEffect(
				{ _tag: 'Stack', members: stack.members, options: stack.options },
				identityValue,
				state,
				{
					orchestratorSinks,
					commandHandler: snapshotCommandHandler,
					postAcquireHook,
					extendContext: extendBuiltInPluginContext,
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
							const stackPaths = yield* StackPathsService;
							yield* Effect.forkScoped(
								persistProjectionChanges(stackPaths.stackRoot, handle.state),
							);
							yield* Effect.forkScoped(
								Stream.fromQueue(handle.events).pipe(
									Stream.runForEach((event) =>
										Effect.gen(function* () {
											yield* Queue.offer(rendererEvents, event);
										}),
									),
								),
							);
						}),
				},
			).pipe(Effect.provide(layerBuiltInPluginRuntime(orchestratorSinks)));
		});

		yield* program.pipe(
			Effect.provide(substrateLayers),
			Effect.provide(Logger.layer([])),
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
	});
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
			const postAcquireHook = yield* buildProductionPostAcquireHook({
				extras: stack.options.extras,
			});
			yield* superviseStackEffect(
				{ _tag: 'Stack', members: stack.members, options: stack.options },
				identityValue,
				state,
				{
					orchestratorSinks,
					postAcquireHook,
					lifetime: 'one-shot',
					extendContext: extendBuiltInPluginContext,
				},
			).pipe(Effect.provide(layerBuiltInPluginRuntime(orchestratorSinks)));
			const stackPaths = yield* StackPathsService;
			yield* writeProjectionSnapshot(stackPaths.stackRoot, yield* SubscriptionRef.get(state));
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

const snapshotIdentityParticipants = (meta: SnapshotMetadata): ReadonlyArray<RestoreParticipant> =>
	Object.entries(meta.identity).map(([plugin, value]) => ({
		plugin,
		liveIdentity: Effect.succeed({ [plugin]: value }),
	}));

const identityValueFor = (identity: ResolvedIdentity, stack?: SupervisedStack): Identity => ({
	app: appName(identity.app),
	stack: stackName(stack?.options.stackName ?? identity.stack),
	chain: chainId(identity.network),
});

const directSnapshotLayers = (identity: ResolvedIdentity) =>
	layerProductionOrchestrators().pipe(
		Layer.provideMerge(buildSubstrateLayers(identityValueFor(identity), identity.runtimeRoot)),
	);

const provideFileSystem = <A, E>(
	fs: FileSystem.FileSystem,
	effect: Effect.Effect<A, E, FileSystem.FileSystem>,
): Effect.Effect<A, E, never> => effect.pipe(Effect.provideService(FileSystem.FileSystem, fs));

const ensureNoLiveSupervisor = (
	identity: ResolvedIdentity,
	hint: string,
): Effect.Effect<void, CliSupervisorLiveError> =>
	Effect.gen(function* () {
		const presence = yield* probeSupervisorPresence(identity.rosterFile).pipe(
			Effect.catch(() => Effect.succeed({ live: false, pid: null, hostname: null })),
		);
		if (presence.live) {
			return yield* Effect.fail(
				new CliSupervisorLiveError({
					app: identity.app,
					stack: identity.stack,
					hint,
				}),
			);
		}
	});

const runSnapshotRestoreDirect = (
	identity: ResolvedIdentity,
	snapshotId: string,
): Effect.Effect<void, unknown> => {
	const program = Effect.gen(function* () {
		const snapshot = yield* SnapshotOrchestratorService;
		const fs = yield* FileSystem.FileSystem;
		const entries = yield* provideFileSystem(fs, snapshot.list);
		const meta = entries.find((entry) => entry.id === snapshotId)?.metadata ?? null;
		const participants = meta === null ? [] : snapshotIdentityParticipants(meta);
		yield* provideFileSystem(fs, snapshot.restore({ id: snapshotId, participants }));
	});
	const restored = program.pipe(
		Effect.provide(directSnapshotLayers(identity)),
		Effect.provide(Logger.layer([Logger.consolePretty()])),
	);
	return ensureNoLiveSupervisor(
		identity,
		'shut down the attached `devstack up` session before restoring a snapshot',
	).pipe(Effect.andThen(restored));
};

const runSnapshotDeleteDirect = (
	identity: ResolvedIdentity,
	snapshotId: string,
): Effect.Effect<void, unknown> => {
	const program = Effect.gen(function* () {
		const snapshot = yield* SnapshotOrchestratorService;
		const fs = yield* FileSystem.FileSystem;
		yield* provideFileSystem(fs, snapshot.delete(snapshotId));
	});
	return program.pipe(
		Effect.provide(directSnapshotLayers(identity)),
		Effect.provide(Logger.layer([Logger.consolePretty()])),
	);
};

const runSnapshotCaptureDirect = (
	identity: ResolvedIdentity,
	args: { readonly snapshotId?: string; readonly name?: string; readonly configPath?: string },
): Effect.Effect<{ readonly snapshotId: string; readonly name: string }, unknown> => {
	const loader = makeConfigLoader();
	return Effect.gen(function* () {
		const loaded = yield* loader.load(args.configPath);
		const stack = (loaded as LoadedConfig & { readonly stack: SupervisedStack }).stack;
		const identityValue = identityValueFor(identity, stack);
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
			const snapshot = yield* SnapshotOrchestratorService;
			const fs = yield* FileSystem.FileSystem;
			const orchestratorSinks = yield* buildProductionOrchestratorSinks();
			const postAcquireHook = yield* buildProductionPostAcquireHook({
				extras: stack.options.extras,
			});
			let captureExit: Exit.Exit<void, unknown> = Exit.succeed(undefined);
			const capturedMeta: { current: SnapshotMetadata | null } = { current: null };
			yield* superviseStackEffect(
				{ _tag: 'Stack', members: stack.members, options: stack.options },
				identityValue,
				state,
				{
					orchestratorSinks,
					postAcquireHook,
					lifetime: 'one-shot',
					extendContext: extendBuiltInPluginContext,
					withinScope: () =>
						provideFileSystem(fs, snapshot.capture({ id: args.snapshotId, label: args.name })).pipe(
							Effect.tap((meta) =>
								Effect.sync(() => {
									capturedMeta.current = meta;
								}),
							),
							Effect.asVoid,
							Effect.exit,
							Effect.tap((exit) =>
								Effect.sync(() => {
									captureExit = exit;
								}),
							),
							Effect.asVoid,
						),
				},
			).pipe(Effect.provide(layerBuiltInPluginRuntime(orchestratorSinks)));
			if (Exit.isFailure(captureExit)) {
				yield* Effect.failCause(captureExit.cause);
			}
			if (capturedMeta.current === null) {
				return yield* Effect.die('snapshot capture completed without metadata');
			}
			const meta = capturedMeta.current;
			const stackPaths = yield* StackPathsService;
			yield* writeProjectionSnapshot(stackPaths.stackRoot, yield* SubscriptionRef.get(state));
			return { snapshotId: meta.id, name: meta.label ?? meta.id };
		});

		return yield* program.pipe(
			Effect.provide(substrateLayers),
			Effect.provide(Logger.layer([Logger.consolePretty()])),
		);
	});
};

const makeDirectSnapshotDeps = (identity: ResolvedIdentity): CliDeps['snapshot'] => ({
	reader: makeSnapshotReader(identity),
	capture: (args) => runSnapshotCaptureDirect(identity, args),
	restore: (snapshotId) => runSnapshotRestoreDirect(identity, snapshotId),
	delete: (snapshotId) => runSnapshotDeleteDirect(identity, snapshotId),
	confirm: nodeConfirmPrompt,
});

const runWipeDirect = (identity: ResolvedIdentity): Effect.Effect<void, unknown> =>
	Effect.gen(function* () {
		yield* ensureNoLiveSupervisor(identity, 'shut down the attached `devstack up` session first');
		const program = Effect.gen(function* () {
			const snapshot = yield* SnapshotOrchestratorService;
			const fs = yield* FileSystem.FileSystem;
			yield* provideFileSystem(fs, snapshot.wipe({}));
			yield* removeRouterDispatchFilesForStack({
				runtimeRoot: identity.runtimeRoot,
				app: identity.app,
				stack: identity.stack,
			});
		});
		return yield* program.pipe(
			Effect.provide(directSnapshotLayers(identity)),
			Effect.provide(Logger.layer([Logger.consolePretty()])),
		);
	});

const identityInputsFromArgv = (
	argv: ReadonlyArray<string>,
	env: Readonly<Record<string, string | undefined>>,
) => {
	let app = env.DEVSTACK_APP;
	let stack = env.DEVSTACK_STACK;
	let network = env.DEVSTACK_NETWORK;
	let stateDir = env.DEVSTACK_STATE_DIR;
	let configPath = env.DEVSTACK_CONFIG;
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i]!;
		const readValue = (name: string): string | undefined => {
			if (token.startsWith(`--${name}=`)) return token.slice(name.length + 3);
			if (token === `--${name}`) return argv[i + 1];
			return undefined;
		};
		app = readValue('app') ?? app;
		stack = readValue('stack') ?? stack;
		network = readValue('network') ?? network;
		stateDir = readValue('state-dir') ?? stateDir;
		configPath = readValue('config') ?? configPath;
	}
	return { app, stack, network, stateDir, configPath };
};

const identityCwdFromConfig = (configPath: string | undefined): string => {
	const resolved = resolveConfigPath(configPath);
	return resolved === null ? process.cwd() : dirname(resolved);
};

// -----------------------------------------------------------------------------
// Bin entry
// -----------------------------------------------------------------------------

export const runCli = async (
	argv: ReadonlyArray<string> = process.argv.slice(2),
): Promise<void> => {
	const stdinIsTty = Boolean((process.stdin as { isTTY?: boolean }).isTTY);
	const env: Record<string, string | undefined> = { ...process.env };
	const identityInputs = identityInputsFromArgv(argv, env);
	const identity = resolveIdentity({
		app: identityInputs.app,
		stack: identityInputs.stack,
		network: identityInputs.network,
		stateDir: identityInputs.stateDir,
		cwd: identityCwdFromConfig(identityInputs.configPath),
	});
	const deps = buildDirectDeps(identity);
	await Effect.runPromise(
		dispatch(deps, {
			argv,
			env: {
				...env,
				DEVSTACK_APP: identity.app,
				DEVSTACK_STACK: identity.stack,
				DEVSTACK_STATE_DIR: identity.runtimeRoot,
			},
			stdinIsTty,
		}),
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
