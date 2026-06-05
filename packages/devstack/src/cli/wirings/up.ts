// `devstack up` verb wiring.
//
// Wires the substrate Layer stack, supervisor, attached renderer, and
// in-process TUI command queue. The Effect runs as the outer Node fiber
// so SIGINT reaches scope finalizers (see surfaces/cli/index.ts
// architecture invariant).
//
// Logger layer: `Logger.layer([])` (silent). `up` owns the TUI, which is
// the operator-facing output channel; routing structured `Effect.log*`
// records to stderr would scribble on top of the live ink renderer in
// human mode and would duplicate the structured event stream the plain
// renderer already emits in non-TTY mode. The sibling `apply` verb (no
// TUI) uses `Logger.consolePretty()` because its consumer is CI.

import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';

import { Cause, Deferred, Effect, Exit, FileSystem, Queue, Ref, Scope, Stream } from 'effect';

import type { Identity } from '../../substrate/identity.ts';
import type { EngineCommand, EngineEvent } from '../../substrate/events.ts';
import { StackPathsService } from '../../substrate/runtime/paths.ts';
import {
	claim,
	commandChannelPaths,
	heartbeatFiber,
	makeCommandChannelSubscriber,
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
import {
	recoverInterruptedRestore,
	SnapshotOrchestratorService,
} from '../../orchestrators/snapshot/index.ts';
import { computeWarmFingerprint } from '../../orchestrators/warm/fingerprint.ts';
import { runWarmCapture, runWarmRestore } from '../../orchestrators/warm/hooks.ts';
import { runStackWithBoot, type RunStackBootBag } from '../../api/run-stack-internal.ts';
import type { BootError } from '../../api/run-stack.ts';
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
import {
	findCliSupervisorLiveError,
	identityValueFor,
	resolvedIdentityForStack,
	type ResolvedIdentity,
} from './identity.ts';
import { provideFileSystem } from './provide-file-system.ts';

const rosterPathsFor = (stackRoot: string) => ({
	stackLockFile: resolvePath(stackRoot, 'stack.lock'),
	rosterFile: resolvePath(stackRoot, 'roster.json'),
});

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

/** The snapshot orchestrator + filesystem the `commandHandler` drives —
 *  the SEAM's instances, handed over via Deferreds the
 *  `beforeInitialAcquire` hook resolves (the handler runs with `R = never`
 *  so it can't yield substrate; see the resolve-Deferreds note at the
 *  `commandHandler` build site). Using the seam's ONE snapshot instance is
 *  load-bearing — it carries the LIVE participant registry the supervisor's
 *  contribution dispatcher populated, so an operator `snapshot save`
 *  captures real chain/blob/db state, not an empty set. */
interface SnapshotCommandHandlerSlots {
	readonly snapshot: Deferred.Deferred<
		import('../../orchestrators/snapshot/index.ts').SnapshotOrchestrator
	>;
	readonly fs: Deferred.Deferred<FileSystem.FileSystem>;
}

const makeSnapshotCommandHandler = (params: {
	readonly slots: SnapshotCommandHandlerSlots;
	readonly runtimeRoot: string;
}): SupervisorCommandHandler => {
	// Await the seam's substrate services (resolved by `beforeInitialAcquire`
	// before any command source is wired) once per command, then dispatch.
	const withServices = <A>(
		body: (
			snapshot: import('../../orchestrators/snapshot/index.ts').SnapshotOrchestrator,
			fs: FileSystem.FileSystem,
		) => Effect.Effect<A, unknown, never>,
	): Effect.Effect<A, unknown, never> =>
		Effect.flatMap(Deferred.await(params.slots.snapshot), (snapshot) =>
			Effect.flatMap(Deferred.await(params.slots.fs), (fs) => body(snapshot, fs)),
		);
	return (cmd) => {
		switch (cmd.tag) {
			case 'snapshot.capture':
				// The L3 capture is the bounce's gather → stop → commit → retag
				// → hard-rm half; the RESUME (recreate + wait-write-ready) is the
				// command-loop's converge after this handler succeeds (it owns the
				// graph), mirroring restore. So no `resume` is injected here.
				return withServices((snapshot, fs) =>
					provideFileSystem(
						fs,
						snapshot.capture({ id: cmd.snapshotId, ...(cmd.name === undefined ? {} : { label: cmd.name }) }),
					).pipe(
						Effect.map((meta) => [
							{
								tag: 'snapshot.captured',
								snapshotId: meta.id,
								...(meta.label === null ? {} : { name: meta.label }),
								at: Date.now(),
							},
						]),
					),
				);
			case 'snapshot.restore':
				return withServices((snapshot, fs) =>
					provideFileSystem(fs, snapshot.restore({ id: cmd.snapshotId })).pipe(
						Effect.map((meta) => [
							{
								tag: 'snapshot.restored',
								snapshotId: meta.id,
								at: Date.now(),
							},
						]),
					),
				);
			case 'snapshot.list':
				return withServices((snapshot, fs) =>
					provideFileSystem(fs, snapshot.list).pipe(Effect.as([])),
				);
			case 'snapshot.delete':
				return withServices((snapshot, fs) =>
					provideFileSystem(fs, snapshot.delete(cmd.snapshotId)).pipe(Effect.as([])),
				);
			case 'wipe.requested':
				return withServices((snapshot, fs) =>
					provideFileSystem(fs, snapshot.wipe({})).pipe(Effect.as([])),
				);
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
 *  on failure). The `summary` is surfaced through `awaitCompletion`'s
 *  reply.payload. */
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

		// Drive the command stream so a stream-LEVEL failure does not
		// permanently wedge cross-process IPC. The subscriber's `commands`
		// tail decodes with the `onDecodeError: 'fail'` default, so ONE
		// malformed/truncated NDJSON line (CLI killed mid-append, partial
		// disk write) raises `CommandChannelError` and terminates the
		// stream. If `runForEach` were the only consumer, the live
		// supervisor would then process NO further commands for the rest of
		// the `up` session (a sibling `snapshot save`/`apply`/`prune`
		// appends but is never read, and its `awaitCompletion` times out
		// with no diagnostic). Instead we log the failure and RE-SUBSCRIBE:
		// `subscriber.commands` is `tailRecords(... fromOffset: 'current')`,
		// and each subscription re-runs its builder, re-anchoring the tail
		// at the file's current EOF — so the corrupt line (and any records
		// that were buffered alongside it) are skipped and subsequent
		// commands are processed again. A short delay before resume avoids a
		// busy spin if the tail keeps failing. The publisher's reply-tail
		// already uses `onDecodeError: 'skip'` for the same NDJSON-tolerance
		// reason; this gives the command-subscriber side equivalent
		// resilience without touching the shared subscriber.
		const consumeCommands: Effect.Effect<void, never, Scope.Scope> = subscriber.commands
			.pipe(
				Stream.runForEach((record) =>
					Effect.gen(function* () {
						if (!isEngineCommand(record.command)) {
							yield* subscriber
								.publishReply(record.id, {
									kind: 'error',
									message: 'invalid command',
									detail: 'command payload did not match EngineCommand',
								})
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
								// plain auto-ack path — the CLI side mints an id, so
								// this branch is defensive.
								yield* params.handle.runCommand(cmd).pipe(
									Effect.andThen(subscriber.publishReply(record.id, { kind: 'ack' })),
									Effect.catchCause((cause) =>
										subscriber
											.publishReply(record.id, {
												kind: 'error',
												message: 'command failed',
												detail: Cause.pretty(cause as Cause.Cause<unknown>),
											})
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
											.publishReply(record.id, {
												kind: 'error',
												message: 'command failed',
												detail: Cause.pretty(cause as Cause.Cause<unknown>),
											})
											.pipe(Effect.catch(() => Effect.void));
									}),
								),
							);
							return;
						}
						yield* params.handle.runCommand(cmd).pipe(
							Effect.andThen(subscriber.publishReply(record.id, { kind: 'ack' })),
							Effect.catchCause((cause) =>
								subscriber
									.publishReply(record.id, {
										kind: 'error',
										message: 'command failed',
										detail: Cause.pretty(cause as Cause.Cause<unknown>),
									})
									.pipe(Effect.catch(() => Effect.void)),
							),
						);
					}),
				),
			)
			.pipe(
				Effect.catchCause((cause): Effect.Effect<void, never, Scope.Scope> => {
					// Scope-close interrupts this forked fiber via an interrupt
					// cause. Re-raise it so the fork stops cleanly on `up`
					// teardown — resuming here would leak the fiber and spam
					// stderr forever.
					if (Cause.hasInterrupts(cause as Cause.Cause<unknown>)) {
						return Effect.failCause(cause as Cause.Cause<never>);
					}
					// Otherwise a stream-level failure (e.g. a corrupt NDJSON
					// line tripping the subscriber's `onDecodeError: 'fail'`
					// default). Log it, pause briefly to avoid a busy spin, then
					// re-subscribe by recursing — a fresh tail re-anchors at the
					// file's current EOF, so the next command is processed
					// instead of IPC wedging for the session.
					return Effect.sync(() => {
						process.stderr.write(
							`command channel decode failed; resuming tail: ${Cause.pretty(cause as Cause.Cause<unknown>)}\n`,
						);
					}).pipe(
						Effect.andThen(Effect.sleep('200 millis')),
						Effect.andThen(Effect.suspend(() => consumeCommands)),
					);
				}),
			);

		yield* Effect.forkScoped(consumeCommands);

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
						.publishReply(pending.commandId, {
							kind: 'ack',
							detail: 'captured',
							payload: ackFromEvent.payload,
						})
						.pipe(Effect.catch(() => Effect.void));
					return;
				}
				if (ackFromEvent.payload.kind === 'failed') {
					yield* subscriber
						.publishReply(pending.commandId, {
							kind: 'error',
							message: 'snapshot capture failed',
							detail: ackFromEvent.payload.summary,
							payload: ackFromEvent.payload,
						})
						.pipe(Effect.catch(() => Effect.void));
					return;
				}
				// skipped
				yield* subscriber
					.publishReply(pending.commandId, {
						kind: 'error',
						message: 'snapshot capture skipped',
						detail: ackFromEvent.payload.reason,
						payload: ackFromEvent.payload,
					})
					.pipe(Effect.catch(() => Effect.void));
			});

		return { publishEvent };
	});

// -----------------------------------------------------------------------------
// CLI boot bundle — the `commandHandler` + `boot` hooks the seam consumes
// -----------------------------------------------------------------------------

export interface UpBootBundleInput {
	readonly stack: SupervisedStack;
	readonly identityValue: Identity;
	readonly runtimeRoot: string;
	readonly appRoot: string;
	readonly resolvedConfigPath: string;
	readonly devstackVersion: string;
	readonly rendererMode: import('../../surfaces/tui/mode-detect.ts').RendererMode;
	readonly warmEnabled: boolean;
}

export interface UpBootBundle {
	readonly commandHandler: SupervisorCommandHandler;
	readonly boot: RunStackBootBag;
}

/**
 * Build the CLI's boot concerns as a VALUE bundle the seam consumes — the
 * snapshot/wipe/prune `commandHandler` plus the `beforeInitialAcquire`
 * (recover → warm-restore → IPC bridge → roster claim → TUI mount + event
 * tee, in that PR#21 order) and `withinScope` (warm-capture) hooks. Pure
 * value construction: no substrate is touched here; the hooks pull the
 * SEAM's substrate services at boot (they run inside the supervised scope).
 *
 * Extracted from `runUpLive` so the Docker-free CLI-boot smoke test drives
 * the EXACT bundle the production path feeds `runStackWithBoot` — the only
 * non-e2e gate on the cutover (`main.test.ts` only runs `up --help`).
 */
export const buildUpBootBundle = (input: UpBootBundleInput): UpBootBundle => {
	const {
		stack,
		identityValue,
		runtimeRoot,
		appRoot,
		resolvedConfigPath,
		devstackVersion,
		rendererMode,
		warmEnabled,
	} = input;

	// Warm-baseline state shared between the two boot hooks:
	// `beforeInitialAcquire` (warm-restore) sets `warmRestored` when it
	// restores the baseline and records the computed `warmFingerprint`;
	// `withinScope` (baseline-capture) reads both to decide whether to
	// capture, and reuses the fingerprint for the sidecar write. Both Refs
	// are allocated synchronously here so the two hook closures — passed as
	// values to `runStackWithBoot` — observe the same cells. (`Ref.make` is
	// a pure sync effect; `runSync` is safe.)
	const warmRestored = Effect.runSync(Ref.make(false));
	const warmFingerprint = Effect.runSync(Ref.make<string | null>(null));

	// The snapshot/wipe/prune `commandHandler` runs inside the supervisor's
	// command loop (R = `never`), so it cannot yield substrate services. It
	// reads the SEAM's `SnapshotOrchestratorService` + `FileSystem` from
	// these Deferreds, which `beforeInitialAcquire` resolves at its very
	// start (before it wires the IPC/TUI command sources). The command loop
	// only ever processes a snapshot command once a command arrives on the
	// public/IPC channel — which can't happen until those sources are wired
	// — so the Deferreds are always resolved before the handler reads them.
	// Using the seam's ONE orchestrator instance is load-bearing: it is the
	// instance the supervisor's contribution dispatcher registers live
	// participants on, so an operator `snapshot save` captures the LIVE
	// chain/blob/db state instead of an empty participant set off a sibling
	// orchestrator. (`Deferred.make` is a pure sync effect; `runSync` safe.)
	const snapshotSlot = Effect.runSync(
		Deferred.make<import('../../orchestrators/snapshot/index.ts').SnapshotOrchestrator>(),
	);
	const fsSlot = Effect.runSync(Deferred.make<FileSystem.FileSystem>());
	const commandHandler = makeSnapshotCommandHandler({
		slots: { snapshot: snapshotSlot, fs: fsSlot },
		runtimeRoot,
	});

	const boot: RunStackBootBag = {
		beforeInitialAcquire: (h) =>
			Effect.gen(function* () {
				// Resolve the seam's substrate services FIRST so the
				// `commandHandler` (which reads them off the shared Deferreds)
				// always sees the same instances the supervisor uses, and so
				// the recover/warm bodies below drive them too.
				const snapshot = yield* SnapshotOrchestratorService;
				const fs = yield* FileSystem.FileSystem;
				yield* Deferred.succeed(snapshotSlot, snapshot);
				yield* Deferred.succeed(fsSlot, fs);
				const stackPaths = yield* StackPathsService;
				// Resume any restore interrupted by a hard kill / power-loss
				// between the atomic swap and the end of the image-promotion
				// handoff (the interrupted-restore sentinel rode the swap into
				// the live root and was never cleared). Runs BEFORE any plugin
				// acquire so a half-promoted image set is reconciled before any
				// L2 lookup observes the runtime root. No-op when the sentinel
				// is absent (the clean-boot case); idempotent re-run of restore
				// when present.
				//
				// `restore({ id })` passes NO participants on purpose: this
				// hook fires BEFORE the initial acquire registers any snapshot
				// participant, so there is no live stack to contribute identity.
				// `runRestore` reads the empty participant set as "no live
				// stack" and skips ONLY the cross-plugin contribution guard
				// (the runtime + snapshot-emptiness guards still fire). With a
				// participants-required guard this recovery could never clear
				// the sentinel — it failed `IdentityMissingLive` every boot.
				yield* recoverInterruptedRestore({
					liveRoot: stackPaths.stackRoot,
					restoreSnapshot: (id) => snapshot.restore({ id }),
				});
				// WARM-RESTORE. Gated on `--warm`. The hit/miss/stale
				// decision (recompute fingerprint → match sidecar + artifact
				// → restore IN PLACE of a cold boot, NO `resume`; else drop a
				// stale baseline and fall through to cold) lives in
				// `runWarmRestore`, dependency-injected so production and the
				// e2e harness drive the identical path. It never fails (wraps
				// itself in catch→log→continue), so a warm failure can't wedge
				// boot — it degrades to cold.
				if (warmEnabled) {
					yield* runWarmRestore({
						snapshot,
						fs,
						stackRoot: stackPaths.stackRoot,
						computeFingerprint: computeWarmFingerprint({
							stack,
							appRoot,
							configPath: resolvedConfigPath,
							devstackVersion,
						}),
						warmRestoredRef: warmRestored,
						warmFingerprintRef: warmFingerprint,
					});
				}
				const commandChannel = yield* installCommandChannelBridge({
					stackRoot: stackPaths.stackRoot,
					handle: h.supervisor,
				});
				yield* installLiveSupervisorRoster({
					stackRoot: stackPaths.stackRoot,
					app: String(identityValue.app),
					stack: String(identityValue.stack),
				});
				const rendererEvents = yield* Queue.unbounded<EngineEvent>();
				const renderer = makeTuiSurface({
					mode: rendererMode,
					publishCommand: makeQueueCommandPublisher(h.commands),
				});
				yield* Effect.addFinalizer(() =>
					renderer.flush.pipe(Effect.catch(() => Effect.void)),
				);
				yield* Effect.forkScoped(
					renderer.mount(h.state, Stream.fromQueue(rendererEvents)).pipe(
						Effect.catch((cause) =>
							Effect.sync(() => {
								process.stderr.write(`renderer failed: ${cause.detail ?? String(cause)}\n`);
							}),
						),
					),
				);
				yield* Effect.forkScoped(
					h.events.pipe(
						Stream.runForEach((event) =>
							Effect.gen(function* () {
								yield* Queue.offer(rendererEvents, event);
								yield* commandChannel.publishEvent(event);
							}),
						),
					),
				);
			}),
		// BASELINE-CAPTURE. `withinScope` fires ONCE, only when the
		// stack came fully up (boot.ts runs it after the booted race
		// wins, never on shutdown). Capture the warm baseline UNLESS
		// this boot was itself a warm restore (no point re-capturing an
		// identical tree). NO `resume` — the stack is already live, so
		// `capture`'s post-publish bounce re-converges it in place. Any
		// failure is swallowed (log + continue): a warm-capture failure
		// must not fail an otherwise-successful `up`. Runs AFTER the
		// readiness gate resolves (the seam composes the built-in gate
		// first), so a slow docker-commit can't delay `handle.start`.
		withinScope: () =>
			Effect.gen(function* () {
				if (!warmEnabled) return;
				const snapshot = yield* SnapshotOrchestratorService;
				const fs = yield* FileSystem.FileSystem;
				const stackPaths = yield* StackPathsService;
				// Capture the baseline + write the sidecar UNLESS this boot
				// was itself a warm restore. The gate + capture + sidecar
				// write live in `runWarmCapture` (the same effect the e2e
				// harness runs); it swallows its own failure so a warm
				// capture failure never fails an otherwise-successful `up`.
				yield* runWarmCapture({
					snapshot,
					fs,
					stackRoot: stackPaths.stackRoot,
					computeFingerprint: computeWarmFingerprint({
						stack,
						appRoot,
						configPath: resolvedConfigPath,
						devstackVersion,
					}),
					warmRestoredRef: warmRestored,
					warmFingerprintRef: warmFingerprint,
				});
			}),
	};

	return { commandHandler, boot };
};

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
		readonly warm?: boolean;
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

		// Re-derive the identity against the EFFECTIVE stack (explicit
		// `--stack`/`$DEVSTACK_STACK` > `config.stackName` > inferred) so
		// the roster lock, command channel, and container/router naming all
		// target the same stack the operator selected — matching what
		// `snapshot.ts` already does. Without this, an explicit `--stack`
		// would boot the supervisor under the config's `stackName` and a
		// concurrent default-stack `up` would falsely collide on the live
		// supervisor (`error: supervisor live for <app>/<stack>`, exit 40).
		const effectiveIdentity = resolvedIdentityForStack(identity, stack);
		const identityValue: Identity = identityValueFor(effectiveIdentity);

		const appRoot = dirname(loaded.resolvedConfigPath);
		const resolvedConfigPath = loaded.resolvedConfigPath;
		// Warm boot-cache toggle: the CLI `--warm` flag (tri-state from
		// main.ts) wins over the config's `defineDevstack({ warm })`; default
		// off. When off, every warm hook below is skipped (zero behavior
		// change). Evaluated AFTER the config loads so the config option is
		// visible.
		const warmEnabled = options.warm ?? stack.options.warm ?? false;
		// devstack version — a fingerprint signal (an SDK upgrade must
		// invalidate a stale baseline). Reuses the `surfaces/cli/index.ts`
		// `readFileSync(new URL('../../../package.json'))` pattern, relative
		// to THIS file. Defensive: a missing/garbled package.json degrades to
		// a sentinel rather than wedging boot — only consumed under `--warm`.
		const devstackVersion = ((): string => {
			try {
				const raw = readFileSync(new URL('../../../package.json', import.meta.url), 'utf8');
				const pkg = JSON.parse(raw) as { readonly version?: unknown };
				return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
			} catch {
				return '0.0.0';
			}
		})();
		const rendererMode = resolveUpRendererMode({
			cliRenderer: options.renderer,
			stackRenderer: stack.options.renderer,
			stdoutIsTty: options.stdoutIsTty,
		});

		// The CLI concerns (snapshot/wipe/prune `commandHandler` + the
		// recover/warm/roster/IPC/TUI boot hooks) as a value bundle — the
		// EXACT thing the seam consumes, extracted so the Docker-free CLI-boot
		// smoke test can drive the real bundle (see `test/cli/up-boot-smoke`).
		const { commandHandler, boot } = buildUpBootBundle({
			stack,
			identityValue,
			runtimeRoot: effectiveIdentity.runtimeRoot,
			appRoot,
			resolvedConfigPath,
			devstackVersion,
			rendererMode,
			warmEnabled,
		});

		// The ONE boot seam. `runStackWithBoot` owns the substrate Layer
		// composition, the contribution dispatcher + post-acquire hook +
		// `extendContext` assembly, the projection ref, and the
		// forkDetach/Deferred boot lifecycle — `up` no longer forks its own
		// parallel orchestration. The CLI concerns (warm/recover/roster/IPC/TUI
		// + snapshot handler) are passed as injected hooks + `commandHandler`.
		const handle = runStackWithBoot(stack, {
			identity: {
				app: String(identityValue.app),
				stack: String(identityValue.stack),
				network: String(identityValue.chain),
			},
			appRoot,
			runtimeRoot: effectiveIdentity.runtimeRoot,
			codegen: stack.options.codegen,
			commandHandler,
			boot,
		});

		// The outer fiber BLOCKS on `awaitShutdown` so SIGINT reaches the
		// supervisor's in-scope signal handler (forked inside `startSupervisor`)
		// and drives teardown through the command-channel/latch — the same path
		// the CLI used as the outer fiber before the cutover. `Effect.scoped`
		// owns the supervised scope so the TUI flush finalizer + roster release
		// run on scope close.
		//
		// Errors project through the seam's DISCRIMINATED channels — no
		// `matchCauseEffect` re-discrimination:
		//   - `handle.start` fails ⇒ BOOT-time `BootError`. Extract a
		//     `CliSupervisorLiveError` (roster-claim loss) for exit 40; else
		//     wrap as `CliInternalError`.
		//   - `handle.awaitShutdown` fails ⇒ MID-RUN cause. Wrap as
		//     `CliInternalError` (boot already succeeded by then).
		return yield* Effect.scoped(
			Effect.gen(function* () {
				yield* handle.start.pipe(
					Effect.catch((bootError: BootError) => {
						const live = findCliSupervisorLiveError(bootError.cause);
						return Effect.fail(
							live ??
								new CliInternalError({
									message: 'stack failed',
									cause: Cause.pretty(bootError.cause),
								}),
						);
					}),
				);
				yield* handle.awaitShutdown.pipe(
					Effect.catchCause((cause): Effect.Effect<never, CliError> =>
						Effect.fail(
							new CliInternalError({
								message: 'stack failed',
								cause: Cause.pretty(cause as Cause.Cause<unknown>),
							}),
						),
					),
				);
				return { exitCode: ExitCode.OK } satisfies CommandResult;
			}),
		);
	});
};
