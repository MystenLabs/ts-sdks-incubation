// `devstack up` verb wiring.
//
// Wires the substrate Layer stack, supervisor, attached renderer, and
// in-process TUI command queue. The Effect runs as the outer Node fiber
// so SIGINT reaches scope finalizers (see surfaces/cli/index.ts
// architecture invariant).

import { dirname, resolve as resolvePath } from 'node:path';

import { Cause, Effect, Exit, FileSystem, Logger, Queue, Ref, Scope, Stream } from 'effect';

import type { Identity } from '../../substrate/identity.ts';
import type { EngineCommand, EngineEvent } from '../../substrate/events.ts';
import { StackPathsService } from '../../substrate/runtime/paths.ts';
import {
	claim,
	commandChannelPaths,
	heartbeatFiber,
	makeCommandChannelSubscriber,
	makeProjectionRef,
	persistProjectionChanges,
	release,
	type SupervisedStack,
	type SupervisorCommandHandler,
	type SupervisorHandle,
} from '../../substrate/runtime/index.ts';
import {
	collectLifecyclePruneInventory,
	defaultLifecyclePruneSelection,
	DEFAULT_LIFECYCLE_PRUNE_RESOURCES,
	runLifecyclePrune,
} from '../../orchestrators/lifecycle-prune/index.ts';
import { superviseStackEffect } from '../../orchestrators/run.ts';
import {
	buildProductionOrchestratorSinks,
	buildProductionPostAcquireHook,
} from '../../orchestrators/runtime-composition.ts';
import {
	extendBuiltInPluginContext,
	layerBuiltInPluginRuntime,
} from '../../orchestrators/built-in-plugin-layers.ts';
import { SnapshotOrchestratorService } from '../../orchestrators/snapshot/index.ts';
import {
	type CliError,
	CliInternalError,
	CliSupervisorLiveError,
	type GlobalFlags,
} from '../../surfaces/cli/index.ts';
import type { CommandResult } from '../../surfaces/cli/commands/index.ts';
import { ExitCode } from '../../surfaces/cli/sysexits.ts';
import { makeTuiSurface } from '../../surfaces/tui/index.ts';
import type { LoadedConfig } from '../../surfaces/cli/commands/config-loader.ts';

import { cliErrorFromConfigExit } from '../bail.ts';
import { makeQueueCommandPublisher, resolveUpRendererMode } from '../up-lifecycle.ts';
import { makeConfigLoader } from './config-loader.ts';
import { isEngineCommand } from './engine-command.ts';
import { findCliSupervisorLiveError, identityValueFor, type ResolvedIdentity } from './identity.ts';
import { buildVerbLayers } from './build-verb-layers.ts';

const rosterPathsFor = (stackRoot: string) => ({
	stackLockFile: resolvePath(stackRoot, 'stack.lock'),
	rosterFile: resolvePath(stackRoot, 'roster.json'),
});

const provideFileSystem = <A, E>(
	fs: FileSystem.FileSystem,
	effect: Effect.Effect<A, E, FileSystem.FileSystem>,
): Effect.Effect<A, E, never> => effect.pipe(Effect.provideService(FileSystem.FileSystem, fs));

// -----------------------------------------------------------------------------
// Supervisor command handler — snapshot/wipe/prune injected dispatch
// -----------------------------------------------------------------------------

/** Captured snapshot metadata is round-tripped through the
 *  command-channel ack payload so the publisher's `awaitCompletion`
 *  can surface it without tailing the engine event stream. */
interface SnapshotCaptureAckPayload {
	readonly kind: 'captured' | 'failed' | 'skipped';
	readonly snapshotId?: string;
	readonly name?: string;
	readonly summary?: string;
	readonly reason?: string;
}

const makeSnapshotCommandHandler = (params: {
	readonly snapshot: import('../../orchestrators/snapshot/index.ts').SnapshotOrchestrator;
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

interface PendingSnapshotCapture {
	readonly commandId: string;
	readonly snapshotId: string;
	readonly name?: string;
}

/** Detect snapshot-capture completion events on the published stream
 *  so we can ack/fail the originating `snapshot.capture` command with
 *  a structured payload (snapshot metadata on success; failure summary
 *  on failure). Drops the legacy tail-fiber on the CLI side — the
 *  `summary` is now surfaced through `awaitCompletion`'s reply.payload. */
const snapshotCaptureAckFromEvent = (
	event: unknown,
): { readonly snapshotId: string; readonly payload: SnapshotCaptureAckPayload } | null => {
	if (typeof event !== 'object' || event === null) return null;
	const record = event as {
		readonly tag?: string;
		readonly snapshotId?: string;
		readonly name?: string;
		readonly summary?: string;
		readonly reason?: string;
	};
	if (typeof record.snapshotId !== 'string') return null;
	if (record.tag === 'snapshot.captured') {
		return {
			snapshotId: record.snapshotId,
			payload: {
				kind: 'captured',
				snapshotId: record.snapshotId,
				...(record.name === undefined ? {} : { name: record.name }),
			},
		};
	}
	if (record.tag === 'snapshot.captureFailed') {
		return {
			snapshotId: record.snapshotId,
			payload: {
				kind: 'failed',
				snapshotId: record.snapshotId,
				...(record.name === undefined ? {} : { name: record.name }),
				...(typeof record.summary === 'string' ? { summary: record.summary } : {}),
			},
		};
	}
	if (record.tag === 'snapshot.captureSkipped') {
		return {
			snapshotId: record.snapshotId,
			payload: {
				kind: 'skipped',
				snapshotId: record.snapshotId,
				...(typeof record.reason === 'string' ? { reason: record.reason } : {}),
			},
		};
	}
	return null;
};

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

		// snapshotId → pending command record id. Populated when the
		// bridge dispatches a `snapshot.capture` command; drained when
		// the matching completion event flows through `publishEvent`.
		const pendingCaptures = yield* Ref.make<ReadonlyMap<string, PendingSnapshotCapture>>(new Map());

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
						const cmd: EngineCommand = record.command;
						// Snapshot capture is a background task in the supervisor:
						// `runCommand` returns as soon as the fork is scheduled, so
						// auto-acking here would race the actual capture. We defer
						// ack/fail until the matching `snapshot.captured` /
						// `snapshot.captureFailed` / `snapshot.captureSkipped` event
						// flows through `publishEvent` below.
						if (cmd.tag === 'snapshot.capture') {
							if (cmd.snapshotId === undefined) {
								// Without a snapshotId we cannot correlate the completion
								// event back to this command record. Fall through to the
								// legacy auto-ack path — the CLI side mints an id today, so
								// this branch is defensive.
								yield* params.handle.runCommand(cmd).pipe(
									Effect.andThen(subscriber.ack(record.id)),
									Effect.catchCause((cause) =>
										subscriber
											.fail(record.id, 'command failed', Cause.pretty(cause as Cause.Cause<unknown>))
											.pipe(Effect.catch(() => Effect.void)),
									),
								);
								return;
							}
							yield* Ref.update(pendingCaptures, (map) => {
								const next = new Map(map);
								next.set(cmd.snapshotId!, {
									commandId: record.id,
									snapshotId: cmd.snapshotId!,
									...(cmd.name === undefined ? {} : { name: cmd.name }),
								});
								return next;
							});
							yield* params.handle.runCommand(cmd).pipe(
								Effect.catchCause((cause) =>
									Effect.gen(function* () {
										// Synchronous dispatch failure (e.g. command-loop refused).
										// Drain the pending entry and surface the failure now.
										yield* Ref.update(pendingCaptures, (map) => {
											const next = new Map(map);
											next.delete(cmd.snapshotId!);
											return next;
										});
										yield* subscriber
											.fail(
												record.id,
												'command failed',
												Cause.pretty(cause as Cause.Cause<unknown>),
											)
											.pipe(Effect.catch(() => Effect.void));
									}),
								),
							);
							return;
						}
						yield* params.handle.runCommand(cmd).pipe(
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

		const publishEvent = (event: EngineEvent): Effect.Effect<void> =>
			Effect.gen(function* () {
				// First, route the event to the events file so peer
				// subscribers see it. THEN drain any matching pending
				// capture so the ack lands after the engine event — this
				// preserves the "captured before ack" ordering tests rely
				// on (test/cli/main.test.ts:483-491 publishes captured then
				// acks; we mirror that ordering from the supervisor side).
				yield* subscriber.publishEvent(event).pipe(Effect.catch(() => Effect.void));
				const ackFromEvent = snapshotCaptureAckFromEvent(event);
				if (ackFromEvent === null) return;
				const pending = yield* Ref.modify(pendingCaptures, (map) => {
					const entry = map.get(ackFromEvent.snapshotId);
					if (entry === undefined) return [null, map];
					const next = new Map(map);
					next.delete(ackFromEvent.snapshotId);
					return [entry, next];
				});
				if (pending === null) return;
				if (ackFromEvent.payload.kind === 'captured') {
					yield* subscriber
						.ack(pending.commandId, 'captured', ackFromEvent.payload)
						.pipe(Effect.catch(() => Effect.void));
					return;
				}
				if (ackFromEvent.payload.kind === 'failed') {
					yield* subscriber
						.fail(
							pending.commandId,
							'snapshot capture failed',
							ackFromEvent.payload.summary,
							ackFromEvent.payload,
						)
						.pipe(Effect.catch(() => Effect.void));
					return;
				}
				// skipped
				yield* subscriber
					.fail(
						pending.commandId,
						'snapshot capture skipped',
						ackFromEvent.payload.reason,
						ackFromEvent.payload,
					)
					.pipe(Effect.catch(() => Effect.void));
			});

		return { publishEvent };
	});

/**
 * Run `devstack up`. Wires the substrate Layer stack, supervisor,
 * attached renderer, and in-process TUI command queue. The Effect runs
 * as the outer Node fiber so SIGINT reaches scope finalizers.
 *
 * Returns a typed `CommandResult` / fails with a typed `CliError` so
 * the dispatcher's `emitFailure` renders the envelope (JSON mode) or
 * human-mode stderr line. Wirings MUST NOT write raw bytes to
 * `process.stderr` or mutate `process.exitCode` for terminal failures —
 * the dispatcher owns the projection.
 */
export const runUpLive = (
	configPath: string | undefined,
	identity: ResolvedIdentity,
	options: {
		readonly renderer: GlobalFlags['renderer'];
		readonly stdoutIsTty: boolean;
	},
): Effect.Effect<CommandResult, CliError> => {
	const loader = makeConfigLoader();
	return Effect.gen(function* () {
		const loadExit = yield* Effect.exit(loader.load(configPath));
		if (Exit.isFailure(loadExit)) {
			return yield* Effect.fail(cliErrorFromConfigExit(loadExit));
		}
		const loaded = loadExit.value;
		const stack = (loaded as LoadedConfig & { readonly stack: SupervisedStack }).stack;

		const identityValue: Identity = identityValueFor(identity, stack);

		const appRoot = dirname(loaded.resolvedConfigPath);
		const rendererMode = resolveUpRendererMode({
			cliRenderer: options.renderer,
			stackRenderer: stack.options.renderer,
			stdoutIsTty: options.stdoutIsTty,
		});
		const substrateLayers = buildVerbLayers({
			identity: identityValue,
			stack,
			appRoot,
			runtimeRoot: identity.runtimeRoot,
		});

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

		// `Effect.matchCauseEffect` projects the inner program's
		// cause to a typed `CliError` outcome — `CliSupervisorLiveError`
		// when the roster-claim path failed, otherwise a wrapped
		// `CliInternalError` whose `cause` carries the cascade for the
		// envelope renderer's `error.chain[]`.
		return yield* program.pipe(
			Effect.provide(substrateLayers),
			Effect.provide(Logger.layer([])),
			Effect.matchCauseEffect({
				onFailure: (cause): Effect.Effect<CommandResult, CliError> => {
					const live = findCliSupervisorLiveError(cause as Cause.Cause<unknown>);
					if (live !== null) {
						return Effect.fail(live);
					}
					return Effect.fail(
						new CliInternalError({
							message: 'stack failed',
							cause: Cause.pretty(cause as Cause.Cause<unknown>),
						}),
					);
				},
				onSuccess: (): Effect.Effect<CommandResult, CliError> =>
					Effect.succeed({ exitCode: ExitCode.OK }),
			}),
		);
	});
};
