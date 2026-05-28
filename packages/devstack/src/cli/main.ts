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
//   2. Attached `up` constructs substrate Layers directly so signals
//      reach scope finalizers.
//   3. `apply` is live-aware: publish to an attached supervisor when
//      one owns the selected stack; otherwise run the one-shot path.
//   4. Maintenance commands either publish to the attached supervisor
//      or refuse/directly mutate only after a live-supervisor check.

import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
	Cause,
	Effect,
	Exit,
	Fiber,
	FileSystem,
	Layer,
	Logger,
	Option,
	Queue,
	Scope,
	Stream,
	SubscriptionRef,
} from 'effect';

import { appName, chainId, stackName } from '../substrate/brand.ts';
import type { Identity } from '../substrate/identity.ts';
import type { EngineCommand, EngineEvent } from '../substrate/events.ts';
import type { SubscribableState } from '../substrate/projection.ts';
import { StackPathsService } from '../substrate/runtime/paths.ts';
import { decodeUnknownSync } from '../substrate/runtime/runtime-decode.ts';
import {
	makeProjectionRef,
	persistProjectionChanges,
	readProjectionSnapshot,
	claim,
	commandChannelPaths,
	EventRecordSchema,
	heartbeatFiber,
	makeCommandChannelPublisher,
	makeCommandChannelSubscriber,
	release,
	tailRecords,
	type EventRecord,
	type SupervisedStack,
	type SupervisorCommandHandler,
	type SupervisorHandle,
	writeProjectionSnapshot,
} from '../substrate/runtime/index.ts';
import { buildSubstrateLayers, superviseStackEffect } from '../orchestrators/run.ts';

import {
	dispatch,
	type CliDeps,
	CliConfigInvalidError,
	CliConfigNotFoundError,
	CliInternalError,
	CliSupervisorLiveError,
	CliUnavailableError,
} from '../surfaces/cli/index.ts';
import { probeSupervisorPresence } from '../surfaces/cli/commands/index.ts';
import { defaultProbes } from './doctor-probes.ts';
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
} from '../orchestrators/built-in-plugin-layers.ts';
import type { StatusReader } from '../surfaces/cli/commands/status.ts';
import type { GlobalFlags } from '../surfaces/cli/flags.ts';
import { ExitCode } from '../surfaces/cli/sysexits.ts';
import { makeTuiSurface } from '../surfaces/tui/index.ts';
import { makeSnapshotReader } from './snapshot-reader.ts';
import { makeQueueCommandPublisher, resolveUpRendererMode } from './up-lifecycle.ts';
import { resolveAppName, resolveNetworkSync, resolveStackName } from '../api/inference-network.ts';
import { readStackEngine, type Stack } from '../api/define-devstack.ts';
import { makeDirectPruneDeps } from './prune-direct.ts';
import {
	collectLifecyclePruneInventory,
	defaultLifecyclePruneSelection,
	DEFAULT_LIFECYCLE_PRUNE_RESOURCES,
	runLifecyclePrune,
} from '../orchestrators/lifecycle-prune/index.ts';
import { removeRouterDispatchFilesForStack } from '../orchestrators/router/cleanup.ts';

// -----------------------------------------------------------------------------
// Config loader (default-export = Stack)
// -----------------------------------------------------------------------------

const DEFAULT_CONFIG_PATH = './devstack.config.ts';
const LIVE_APPLY_ACK_TIMEOUT_MILLIS = 10 * 60 * 1000;
const LIVE_SNAPSHOT_CAPTURE_TIMEOUT_MILLIS = 60 * 60 * 1000;

const stackRootFor = (runtimeRoot: string, stack: string): string =>
	resolvePath(runtimeRoot, 'stacks', stack);

const rosterPathsFor = (stackRoot: string) => ({
	stackLockFile: resolvePath(stackRoot, 'stack.lock'),
	rosterFile: resolvePath(stackRoot, 'roster.json'),
});

const provideFileSystem = <A, E>(
	fs: FileSystem.FileSystem,
	effect: Effect.Effect<A, E, FileSystem.FileSystem>,
): Effect.Effect<A, E, never> => effect.pipe(Effect.provideService(FileSystem.FileSystem, fs));

const hasString = (value: Record<string, unknown>, key: string): boolean =>
	typeof value[key] === 'string';

// Exhaustive switch over `EngineCommand['tag']`. Adding a new
// command variant to `EngineCommand` without extending this switch
// will fail typecheck via the `_exhaustive: never` proof — no manual
// tag tuple to drift.
const isEngineCommand = (value: unknown): value is EngineCommand => {
	if (typeof value !== 'object' || value === null) return false;
	const record = value as Record<string, unknown>;
	const tag = record.tag;
	if (typeof tag !== 'string') return false;
	const knownTag = tag as EngineCommand['tag'];
	switch (knownTag) {
		case 'stack.start':
		case 'stack.stop':
		case 'stack.restart':
		case 'codegen.requested':
		case 'snapshot.list':
		case 'wipe.requested':
		case 'prune.requested':
		case 'shutdown.requested':
			return true;
		case 'snapshot.restore':
		case 'snapshot.delete':
			return hasString(record, 'snapshotId');
		case 'advance-clock.requested':
			return typeof record.toMillis === 'number';
		case 'shutdown.hardKillRequested':
			return (
				(record.signal === 'SIGINT' || record.signal === 'SIGTERM') &&
				typeof record.exitCode === 'number' &&
				typeof record.at === 'number'
			);
		case 'selective-restart.requested':
			return hasString(record, 'pluginKey');
		case 'apply.requested':
			return record.pluginKey === undefined || typeof record.pluginKey === 'string';
		case 'snapshot.capture':
			return (
				(record.snapshotId === undefined || typeof record.snapshotId === 'string') &&
				(record.name === undefined || typeof record.name === 'string')
			);
		default: {
			const _exhaustive: never = knownTag;
			void _exhaustive;
			return false;
		}
	}
};

const findCliSupervisorLiveError = (cause: Cause.Cause<unknown>): CliSupervisorLiveError | null => {
	for (const reason of cause.reasons) {
		if (!Cause.isFailReason(reason)) continue;
		const error = reason.error;
		if (
			typeof error === 'object' &&
			error !== null &&
			(error as { readonly _tag?: unknown })._tag === 'CliSupervisorLiveError'
		) {
			return error as CliSupervisorLiveError;
		}
	}
	return null;
};

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
		params.stateDir ?? process.env.DEVSTACK_STATE_DIR ?? resolvePath(cwd, '.devstack');
	const runtimeRoot = resolvePath(stateDir);
	const stacksRoot = resolvePath(runtimeRoot, 'stacks');
	const stack = resolveStackName({
		explicit: params.stack,
		cwd,
	});
	// Centralized explicit > env > default ladder. Throws
	// `DevstackNetworkParseError` on a malformed value so the CLI fails
	// fast with a structured error instead of a downstream cryptic
	// chain-probe failure. The raw input is preserved (not the
	// canonical name) so chain-keyed cache namespaces stay stable.
	const network = resolveNetworkSync({
		explicit: params.network,
		env: process.env.DEVSTACK_NETWORK,
		explicitSource: '--network',
	}).raw;
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
		snapshot: makeSnapshotDeps(identity),
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
	readonly runtimeRoot: string;
}): SupervisorCommandHandler => {
	return (cmd, handlerCtx) => {
		switch (cmd.tag) {
			case 'snapshot.capture':
				return provideFileSystem(
					params.fs,
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
				return provideFileSystem(params.fs, params.snapshot.restore({ id: cmd.snapshotId })).pipe(
					Effect.map((meta) => [
						{
							tag: 'snapshot.restored',
							snapshotId: meta.id,
							at: Date.now(),
						},
					]),
				);
			case 'snapshot.list':
				return provideFileSystem(params.fs, params.snapshot.list).pipe(Effect.as([]));
			case 'snapshot.delete':
				return provideFileSystem(params.fs, params.snapshot.delete(cmd.snapshotId)).pipe(
					Effect.as([]),
				);
			case 'wipe.requested':
				return provideFileSystem(params.fs, params.snapshot.wipe({})).pipe(Effect.as([]));
			case 'prune.requested':
				// Route to the same orchestrator the offline `devstack prune`
				// verb uses (`runLifecyclePrune`), NOT the snapshot-orchestrator
				// prune (which only cleans the snapshot catalog and would leave
				// stale containers/networks/volumes/images behind for an attached
				// supervisor — silent under-prune is the bug we're closing).
				// Live supervisor implies the current stack's group is live and
				// therefore excluded from the default selection — exactly the
				// invariant the live-attached `prune` needs (operator can prune
				// sibling stacks under the same Docker daemon without touching
				// the running one).
				return collectLifecyclePruneInventory({ runtimeRoot: params.runtimeRoot }).pipe(
					Effect.flatMap((inventory) =>
						runLifecyclePrune(
							{ runtimeRoot: params.runtimeRoot },
							{
								groupKeys: defaultLifecyclePruneSelection(
									inventory,
									DEFAULT_LIFECYCLE_PRUNE_RESOURCES,
								),
								resources: DEFAULT_LIFECYCLE_PRUNE_RESOURCES,
								dryRun: false,
							},
						),
					),
					Effect.as([]),
				);
			default:
				return Effect.succeed([]);
		}
	};
};

const installLiveSupervisorRoster = (params: {
	readonly stackRoot: string;
	readonly app: string;
	readonly stack: string;
}): Effect.Effect<void, unknown, Scope.Scope> =>
	Effect.gen(function* () {
		const paths = rosterPathsFor(params.stackRoot);
		const claimed = yield* claim(paths);
		if (!claimed.soleHolder) {
			yield* release(paths).pipe(Effect.catch(() => Effect.void));
			return yield* Effect.fail(
				new CliSupervisorLiveError({
					app: params.app,
					stack: params.stack,
					hint: 'use `devstack apply` from another shell, or choose a different --stack name',
				}),
			);
		}
		yield* Effect.addFinalizer(() => release(paths).pipe(Effect.catch(() => Effect.void)));
		yield* Effect.forkScoped(heartbeatFiber(paths));
	});

const installCommandChannelBridge = (params: {
	readonly stackRoot: string;
	readonly handle: SupervisorHandle;
}): Effect.Effect<
	{
		readonly publishEvent: (event: EngineEvent) => Effect.Effect<void>;
	},
	unknown,
	Scope.Scope
> =>
	Effect.gen(function* () {
		const subscriber = yield* makeCommandChannelSubscriber(commandChannelPaths(params.stackRoot), {
			fromOffset: 'current',
		});

		yield* Effect.forkScoped(
			subscriber.commands.pipe(
				Stream.runForEach((record) =>
					Effect.gen(function* () {
						if (!isEngineCommand(record.command)) {
							yield* subscriber
								.fail(record.id, 'invalid command', 'command payload did not match EngineCommand')
								.pipe(Effect.catch(() => Effect.void));
							return;
						}
						yield* params.handle.runCommand(record.command).pipe(
							Effect.andThen(subscriber.ack(record.id)),
							Effect.catchCause((cause) =>
								subscriber
									.fail(record.id, 'command failed', Cause.pretty(cause as Cause.Cause<unknown>))
									.pipe(Effect.catch(() => Effect.void)),
							),
						);
					}),
				),
				Effect.catchCause((cause) =>
					Effect.sync(() => {
						process.stderr.write(
							`command channel failed: ${Cause.pretty(cause as Cause.Cause<unknown>)}\n`,
						);
					}),
				),
			),
		);

		return {
			publishEvent: (event: EngineEvent) =>
				subscriber.publishEvent(event).pipe(Effect.catch(() => Effect.void)),
		};
	});

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
					process.exitCode =
						err._tag === 'CliConfigNotFoundError' ? ExitCode.NO_INPUT : ExitCode.CONFIG;
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
			const snapshotCommandHandler = makeSnapshotCommandHandler({
				snapshot,
				fs,
				runtimeRoot: identity.runtimeRoot,
			});
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
							const stackPaths = yield* StackPathsService;
							// Reconcile any half-promoted snapshot restore from a
							// prior supervise (process hard-killed mid `tagImage`
							// loop, Docker daemon outage, etc.) BEFORE any plugin
							// acquire fires. The scanner is idempotent and a no-op
							// when no marker is present; partial recovery surfaces
							// via the returned summary's `stillPending` list which
							// we log so the operator can investigate.
							const recovery = yield* snapshot.recoverPendingRestore.pipe(
								Effect.tapCause((cause) =>
									Effect.sync(() => {
										process.stderr.write(
											`snapshot recovery scan failed: ${Cause.pretty(cause as Cause.Cause<unknown>)}\n`,
										);
									}),
								),
								Effect.catch(() => Effect.succeed(null)),
							);
							if (recovery && !recovery.noMarker) {
								const summary = `snapshot.recover-pending: inspected=${recovery.inspected} recovered=${recovery.recovered} stillPending=${recovery.stillPending.length} markerCleared=${recovery.markerCleared}`;
								process.stderr.write(`${summary}\n`);
								if (recovery.stillPending.length > 0) {
									for (const entry of recovery.stillPending) {
										process.stderr.write(
											`  pending: ${entry.targetImageName} ← ${entry.stagedImageTag} (${entry.plugin}/${entry.role})\n`,
										);
									}
								}
							}
							const commandChannel = yield* installCommandChannelBridge({
								stackRoot: stackPaths.stackRoot,
								handle,
							});
							yield* installLiveSupervisorRoster({
								stackRoot: stackPaths.stackRoot,
								app: String(identityValue.app),
								stack: String(identityValue.stack),
							});
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
							yield* Effect.forkScoped(
								persistProjectionChanges(stackPaths.stackRoot, handle.state),
							);
							yield* Effect.forkScoped(
								Stream.fromQueue(handle.events).pipe(
									Stream.runForEach((event) =>
										Effect.gen(function* () {
											yield* Queue.offer(rendererEvents, event);
											yield* commandChannel.publishEvent(event);
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
						const live = findCliSupervisorLiveError(cause as Cause.Cause<unknown>);
						if (live !== null) {
							process.stderr.write(`error: supervisor live for ${live.app}/${live.stack}\n`);
							if (live.hint !== undefined) {
								process.stderr.write(`hint: ${live.hint}\n`);
							}
							process.exitCode = ExitCode.SUPERVISOR_LIVE;
							return;
						}
						process.stderr.write(
							`\nerror: stack failed\n${Cause.pretty(cause as Cause.Cause<unknown>)}\n`,
						);
						process.exitCode = ExitCode.GENERIC;
					}),
				onSuccess: () =>
					Effect.sync(() => {
						process.exitCode ??= 0;
					}),
			}),
		);
	});
};

const runApplyAgainstLiveSupervisor = (
	identity: ResolvedIdentity,
	identityValue: Identity,
): Effect.Effect<boolean> =>
	Effect.gen(function* () {
		const stackRoot = stackRootFor(identity.runtimeRoot, String(identityValue.stack));
		const presence = yield* probeSupervisorPresence(resolvePath(stackRoot, 'roster.json')).pipe(
			Effect.catch(() => Effect.succeed({ live: false, pid: null, hostname: null })),
		);
		if (!presence.live) return false;

		const exit = yield* Effect.exit(
			Effect.gen(function* () {
				const publisher = yield* makeCommandChannelPublisher(commandChannelPaths(stackRoot));
				const published = yield* publisher.publish({ tag: 'apply.requested' });
				const reply = yield* publisher.awaitCompletion(published.id, {
					timeoutMillis: LIVE_APPLY_ACK_TIMEOUT_MILLIS,
				});
				if (!reply.ok) {
					return yield* Effect.fail(reply.message);
				}
			}),
		);

		if (Exit.isFailure(exit)) {
			process.stderr.write(
				`\nerror: live stack apply failed\n${Cause.pretty(exit.cause as Cause.Cause<unknown>)}\n`,
			);
			process.exitCode = ExitCode.GENERIC;
			return true;
		}

		process.exitCode ??= 0;
		return true;
	});

type SnapshotCaptureCompletionEvent = Extract<
	EngineEvent,
	{ readonly tag: 'snapshot.captured' | 'snapshot.captureFailed' | 'snapshot.captureSkipped' }
>;

const mintCliSnapshotId = (): string =>
	`snap-${Date.now()}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;

const snapshotCaptureCompletionEvent = (
	event: unknown,
	snapshotId: string,
): SnapshotCaptureCompletionEvent | null => {
	if (typeof event !== 'object' || event === null) return null;
	const record = event as Partial<SnapshotCaptureCompletionEvent>;
	switch (record.tag) {
		case 'snapshot.captured':
			return record.snapshotId === snapshotId ? (record as SnapshotCaptureCompletionEvent) : null;
		case 'snapshot.captureFailed':
			return record.snapshotId === snapshotId ? (record as SnapshotCaptureCompletionEvent) : null;
		case 'snapshot.captureSkipped':
			// A peer CLI's skipped event must not terminate THIS invocation. Only the
			// supervisor's skip for our own snapshotId is a completion. If the supervisor
			// emitted a skip without a snapshotId (legacy publishers), fall through to
			// non-match so we don't misattribute.
			return record.reason === 'already-running' && record.snapshotId === snapshotId
				? (record as SnapshotCaptureCompletionEvent)
				: null;
		default:
			return null;
	}
};

const decodeEventRecord = (raw: unknown): EventRecord =>
	decodeUnknownSync(EventRecordSchema, raw, {
		source: 'cli/snapshot/event-tail',
		mkError: (issue) => issue,
	});

const runSnapshotCaptureAgainstLiveSupervisor = (
	identity: ResolvedIdentity,
	args: { readonly snapshotId?: string; readonly name?: string },
): Effect.Effect<{ readonly snapshotId: string; readonly name: string } | null, unknown> =>
	Effect.gen(function* () {
		const presence = yield* probeSupervisorPresence(identity.rosterFile).pipe(
			Effect.catch(() => Effect.succeed({ live: false, pid: null, hostname: null })),
		);
		if (!presence.live) return null;

		const snapshotId = args.snapshotId ?? mintCliSnapshotId();
		return yield* Effect.scoped(
			Effect.gen(function* () {
				const paths = commandChannelPaths(identity.stackRoot);
				const publisher = yield* makeCommandChannelPublisher(paths);
				const eventsOffset = existsSync(paths.eventsFile) ? statSync(paths.eventsFile).size : 0;
				// `onDecodeError: 'skip'` keeps the event tail alive when the supervisor's
				// atomic append races our poll loop and we observe a truncated/corrupt
				// line — per STYLE_GUIDE §20, decode failure becomes "skip + logDebug",
				// never a stream death that would hang the completion await.
				const completionFiber = yield* tailRecords<EventRecord>(
					paths.eventsFile,
					decodeEventRecord,
					{ fromOffset: eventsOffset, onDecodeError: 'skip' },
				).pipe(
					Stream.map((record) =>
						record.kind === 'engine'
							? snapshotCaptureCompletionEvent(record.event, snapshotId)
							: null,
					),
					Stream.filter((event): event is SnapshotCaptureCompletionEvent => event !== null),
					Stream.runHead,
					Effect.timeoutOption(`${LIVE_SNAPSHOT_CAPTURE_TIMEOUT_MILLIS} millis`),
					Effect.map((outer) => Option.getOrNull(Option.flatten(outer))),
					Effect.forkScoped,
				);

				const published = yield* publisher.publish({
					tag: 'snapshot.capture',
					snapshotId,
					...(args.name === undefined ? {} : { name: args.name }),
				});
				const reply = yield* publisher.awaitCompletion(published.id, {
					timeoutMillis: LIVE_SNAPSHOT_CAPTURE_TIMEOUT_MILLIS,
				});
				if (!reply.ok) {
					return yield* Effect.fail(
						new CliUnavailableError({
							service: 'devstack supervisor',
							message: reply.message,
							hint: 'check the attached `devstack up` session and try again',
						}),
					);
				}

				const completion = yield* Fiber.join(completionFiber);
				if (completion === null) {
					return yield* Effect.fail(
						new CliUnavailableError({
							service: 'devstack supervisor',
							message: 'timed out waiting for snapshot capture result',
							hint: 'check the attached `devstack up` session and try again',
						}),
					);
				}

				switch (completion.tag) {
					case 'snapshot.captured':
						return {
							snapshotId: completion.snapshotId,
							name: completion.name ?? args.name ?? completion.snapshotId,
						};
					case 'snapshot.captureFailed':
						return yield* Effect.fail(
							new CliInternalError({
								message: `snapshot capture failed: ${completion.summary}`,
							}),
						);
					case 'snapshot.captureSkipped':
						return yield* Effect.fail(
							new CliUnavailableError({
								service: 'snapshot capture',
								message: 'another snapshot capture is already running',
								hint: 'wait for the current snapshot to finish and try again',
							}),
						);
				}
			}),
		);
	});

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
						process.exitCode =
						err._tag === 'CliConfigNotFoundError' ? ExitCode.NO_INPUT : ExitCode.CONFIG;
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
		if (yield* runApplyAgainstLiveSupervisor(identity, identityValue)) {
			return;
		}
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
			// Mirror the up-path recovery: reconcile any half-promoted
			// snapshot restore from a prior supervise BEFORE the one-shot
			// apply starts the stack. Idempotent + no-op when no marker.
			const snapshot = yield* SnapshotOrchestratorService;
			yield* snapshot.recoverPendingRestore.pipe(
				Effect.tapCause((cause) =>
					Effect.sync(() => {
						process.stderr.write(
							`snapshot recovery scan failed: ${Cause.pretty(cause as Cause.Cause<unknown>)}\n`,
						);
					}),
				),
				Effect.catch(() => Effect.succeed(null)),
			);
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
						process.exitCode = ExitCode.GENERIC;
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

const resolvedIdentityForStack = (
	identity: ResolvedIdentity,
	stack: SupervisedStack,
): ResolvedIdentity => {
	const stackValue = stack.options.stackName ?? identity.stack;
	const stackRoot = stackRootFor(identity.runtimeRoot, stackValue);
	return {
		...identity,
		stack: stackValue,
		stackRoot,
		rosterFile: resolvePath(stackRoot, 'roster.json'),
	};
};

const directSnapshotLayers = (identity: ResolvedIdentity) =>
	layerProductionOrchestrators().pipe(
		Layer.provideMerge(buildSubstrateLayers(identityValueFor(identity), identity.runtimeRoot)),
	);

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
		return yield* runSnapshotCaptureDirectLoaded(identity, loaded, args);
	});
};

const runSnapshotCaptureDirectLoaded = (
	identity: ResolvedIdentity,
	loaded: LoadedConfig,
	args: { readonly snapshotId?: string; readonly name?: string },
): Effect.Effect<{ readonly snapshotId: string; readonly name: string }, unknown> =>
	Effect.gen(function* () {
		const stack = (loaded as LoadedConfig & { readonly stack: SupervisedStack }).stack;
		const effectiveIdentity = resolvedIdentityForStack(identity, stack);
		const identityValue = identityValueFor(effectiveIdentity);
		const appRoot = dirname(loaded.resolvedConfigPath);
		const substrateLayers = layerProductionOrchestrators({
			codegen: {
				appRoot,
				outputDir: stack.options.codegen?.outputDir,
				stackSubdir: stack.options.codegen?.stackSubdir ?? null,
			},
		}).pipe(Layer.provideMerge(buildSubstrateLayers(identityValue, effectiveIdentity.runtimeRoot)));

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

		return yield* ensureNoLiveSupervisor(
			effectiveIdentity,
			'shut down the attached `devstack up` session before saving a snapshot',
		).pipe(
			Effect.andThen(
				program.pipe(
					Effect.provide(substrateLayers),
					Effect.provide(Logger.layer([Logger.consolePretty()])),
				),
			),
		);
	});

const runSnapshotCaptureLiveAware = (
	identity: ResolvedIdentity,
	args: { readonly snapshotId?: string; readonly name?: string; readonly configPath?: string },
): Effect.Effect<{ readonly snapshotId: string; readonly name: string }, unknown> =>
	Effect.gen(function* () {
		if (args.configPath === undefined && resolveConfigPath(undefined) === null) {
			const live = yield* runSnapshotCaptureAgainstLiveSupervisor(identity, args);
			if (live !== null) return live;
			return yield* runSnapshotCaptureDirect(identity, args);
		}
		const loaded = yield* makeConfigLoader().load(args.configPath);
		const stack = (loaded as LoadedConfig & { readonly stack: SupervisedStack }).stack;
		const effectiveIdentity = resolvedIdentityForStack(identity, stack);
		const live = yield* runSnapshotCaptureAgainstLiveSupervisor(effectiveIdentity, args);
		if (live !== null) return live;
		return yield* runSnapshotCaptureDirectLoaded(effectiveIdentity, loaded, args);
	});

const makeSnapshotDeps = (identity: ResolvedIdentity): CliDeps['snapshot'] => ({
	reader: makeSnapshotReader(identity),
	capture: (args) => runSnapshotCaptureLiveAware(identity, args),
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

/** @internal Exported for tests. Resolves identity flag inputs from a
 *  `--app <x>` / `--stack <x>` / `--network <x>` / `--state-dir <x>` /
 *  `--config <x>` argv, falling back to `DEVSTACK_*` env vars. Throws
 *  on a missing or flag-shaped value so a typo doesn't silently demote
 *  a downstream flag. */
export const identityInputsFromArgv = (
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
			// `--name=value` form: trust the literal between `=` and end.
			if (token.startsWith(`--${name}=`)) return token.slice(name.length + 3);
			// `--name value` form: peek the next token. Reject another
			// flag token (`--foo`) as the value — it almost certainly
			// means the user meant `--name <empty>` (typo / forgotten
			// argument) and quietly absorbing `--foo` as the value
			// silently demotes a downstream flag.
			if (token === `--${name}`) {
				const next = argv[i + 1];
				if (next === undefined) {
					throw new Error(`flag --${name} requires a value`);
				}
				if (next.startsWith('--')) {
					throw new Error(`flag --${name} requires a value; got "${next}" which looks like a flag`);
				}
				return next;
			}
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
	runCli()
		.catch((err) => {
			process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
			process.exitCode = ExitCode.GENERIC;
		})
		.then(() => {
			process.exit(process.exitCode ?? 0);
		});
}
