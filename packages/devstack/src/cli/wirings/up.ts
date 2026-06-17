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

import { dirname, resolve as resolvePath } from 'node:path';

import { Cause, Effect, Exit, FileSystem, Queue, Scope, Stream } from 'effect';

import type { Identity } from '../../substrate/identity.ts';
import type { EngineEvent } from '../../substrate/events.ts';
import { StackPathsService } from '../../substrate/runtime/paths.ts';
import {
	claim,
	heartbeatFiber,
	release,
	type SupervisedStack,
	type SupervisorCommandHandler,
} from '../../substrate/runtime/index.ts';
import {
	collectLifecyclePruneInventory,
	defaultLifecyclePruneSelection,
	DEFAULT_LIFECYCLE_PRUNE_RESOURCES,
	runLifecyclePrune,
} from '../../orchestrators/lifecycle-prune/index.ts';
import {
	computeSnapshotGraphInputFromStack,
	recoverInterruptedRestore,
	SnapshotOrchestratorService,
} from '../../orchestrators/snapshot/index.ts';
import type { Stack } from '../../api/define-devstack.ts';
import {
	runStackWithBoot,
	type CommandHandlerFactory,
	type RunStackBootBag,
} from '../../api/run-stack-internal.ts';
import type { BootError } from '../../api/run-stack.ts';
import {
	type CliError,
	CliInternalError,
	CliSnapshotNotFoundError,
	CliSupervisorLiveError,
	CliUsageError,
	type GlobalFlags,
} from '../../surfaces/cli/index.ts';
import type { CommandResult } from '../../surfaces/cli/commands/index.ts';
import { ExitCode } from '../../surfaces/cli/sysexits.ts';
import { makeTuiSurface } from '../../surfaces/tui/index.ts';
import type { LoadedConfig } from '../../surfaces/cli/commands/config-loader.ts';

import { cliErrorFromConfigExit } from '../bail.ts';
import { makeQueueCommandPublisher, resolveUpRendererMode } from '../up-lifecycle.ts';
import { makeConfigLoader } from './config-loader.ts';
import { makeSnapshotReader } from '../snapshot-reader.ts';
import {
	findCliSupervisorLiveError,
	identityValueFor,
	resolvedIdentityForStack,
	type ResolvedIdentity,
} from './identity.ts';
import { installCommandChannelBridge } from './up-ipc.ts';
import { provideFileSystem } from './provide-file-system.ts';
import { readDevstackVersion } from './read-devstack-version.ts';

const rosterPathsFor = (stackRoot: string) => ({
	stackLockFile: resolvePath(stackRoot, 'stack.lock'),
	rosterFile: resolvePath(stackRoot, 'roster.json'),
});

// -----------------------------------------------------------------------------
// Supervisor command handler — snapshot/wipe/prune injected dispatch
// -----------------------------------------------------------------------------

/** Build the snapshot/wipe/prune `commandHandler` as a FACTORY the seam
 *  resolves against its LIVE substrate (see `CommandHandlerFactory`). The
 *  factory yields the seam's `SnapshotOrchestratorService` + `FileSystem` —
 *  the SAME orchestrator instance the supervisor's contribution dispatcher
 *  registers live participants on, so an operator `snapshot save` captures
 *  real chain/blob/db state, not an empty set — and returns a handler
 *  (R = `never`, as the command loop requires) that closes over them
 *  directly. No Deferred hand-off: the seam runs this factory before
 *  `startSupervisor` consumes the handler. */
const makeSnapshotCommandHandler = (params: {
	readonly runtimeRoot: string;
	readonly stack: SupervisedStack;
	readonly devstackVersion: string;
}): CommandHandlerFactory =>
	Effect.gen(function* () {
		const snapshot = yield* SnapshotOrchestratorService;
		const fs = yield* FileSystem.FileSystem;
		const computeGraphInput = computeSnapshotGraphInputFromStack({
			stack: params.stack,
			devstackVersion: params.devstackVersion,
		});
		const handler: SupervisorCommandHandler = (cmd) => {
			switch (cmd.tag) {
				case 'snapshot.capture':
					// The L3 capture is the bounce's gather → stop → commit → retag
					// → hard-rm half; the RESUME (recreate + wait-write-ready) is the
					// command-loop's converge after this handler succeeds (it owns the
					// graph), mirroring restore. So no `resume` is injected here.
					return provideFileSystem(
						fs,
						computeGraphInput.pipe(
							Effect.flatMap((graphInput) =>
								snapshot.capture({
									id: cmd.snapshotId,
									...(cmd.name === undefined ? {} : { label: cmd.name }),
									graphInput,
									...(cmd.replaceExisting === true ? { replaceExistingLabel: true } : {}),
								}),
							),
						),
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
					return provideFileSystem(
						fs,
						computeGraphInput.pipe(
							Effect.flatMap((currentGraphInput) =>
								snapshot.restore({
									id: cmd.snapshotId,
									currentGraphInput,
									graphInputMismatchPolicy: 'warn',
								}),
							),
						),
					).pipe(
						Effect.map((meta) => [
							{
								tag: 'snapshot.restored',
								snapshotId: meta.id,
								at: Date.now(),
							},
						]),
					);
				case 'snapshot.list':
					return provideFileSystem(fs, snapshot.list).pipe(Effect.as([]));
				case 'snapshot.delete':
					return provideFileSystem(fs, snapshot.delete(cmd.snapshotId)).pipe(Effect.as([]));
				case 'wipe.requested':
					return provideFileSystem(fs, snapshot.wipe({})).pipe(Effect.as([]));
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
		return handler;
	});

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

// -----------------------------------------------------------------------------
// CLI boot bundle — the `commandHandler` + `boot` hooks the seam consumes
// -----------------------------------------------------------------------------

export interface UpBootBundleInput {
	readonly stack: SupervisedStack;
	readonly identityValue: Identity;
	readonly runtimeRoot: string;
	readonly devstackVersion: string;
	readonly rendererMode: import('../../surfaces/tui/mode-detect.ts').RendererMode;
	readonly startFromSnapshot?: {
		readonly id: string;
		readonly stalePolicy: 'warn' | 'block' | 'clean-start';
	};
	readonly snapshotCache?: {
		readonly name: string;
		readonly existingSnapshotId?: string;
	};
}

export interface UpBootBundle {
	readonly commandHandler: CommandHandlerFactory;
	readonly boot: RunStackBootBag;
}

type StartFromSnapshot = NonNullable<UpBootBundleInput['startFromSnapshot']>;
type SnapshotCache = NonNullable<UpBootBundleInput['snapshotCache']>;

/**
 * Build the CLI's boot concerns as a VALUE bundle the seam consumes — the
 * snapshot/wipe/prune `commandHandler` plus the `beforeInitialAcquire`
 * (recover → IPC bridge → roster claim → TUI mount + event tee). Pure
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
		devstackVersion,
		rendererMode,
		startFromSnapshot,
		snapshotCache,
	} = input;

	const computeGraphInput = computeSnapshotGraphInputFromStack({ stack, devstackVersion });
	let refreshSnapshotCache =
		snapshotCache !== undefined && snapshotCache.existingSnapshotId === undefined;

	// The snapshot/wipe/prune `commandHandler` — a FACTORY the seam resolves
	// against its LIVE substrate (the seam runs it before `startSupervisor`
	// consumes the handler). The factory closes over the seam's ONE
	// `SnapshotOrchestratorService` instance — the same one the supervisor's
	// contribution dispatcher registers live participants on — so an operator
	// `snapshot save` captures the LIVE chain/blob/db state, not an empty set
	// off a sibling orchestrator. No Deferred hand-off.
	const commandHandler = makeSnapshotCommandHandler({ runtimeRoot, stack, devstackVersion });

	const boot: RunStackBootBag = {
		devstackVersion,
		beforeInitialAcquire: (h) =>
			Effect.gen(function* () {
				// The seam's substrate services — the SAME instances the
				// `commandHandler` factory closed over and the supervisor uses,
				// driven here for the recover/IPC/roster/TUI work.
				const snapshot = yield* SnapshotOrchestratorService;
				const fs = yield* FileSystem.FileSystem;
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
					restoreSnapshot: (id) =>
						computeGraphInput.pipe(
							Effect.flatMap((currentGraphInput) =>
								snapshot.restore({
									id,
									currentGraphInput,
									graphInputMismatchPolicy: 'warn',
								}),
							),
						),
				});
				if (snapshotCache !== undefined) {
					if (snapshotCache.existingSnapshotId === undefined) {
						yield* Effect.logWarning(
							`snapshot cache ${snapshotCache.name} was not found; boot will refresh it`,
						);
					} else {
						const graphInput = yield* computeGraphInput;
						const catalog = yield* provideFileSystem(fs, snapshot.list);
						const entry = catalog.find(
							(snapshotEntry) => snapshotEntry.id === snapshotCache.existingSnapshotId,
						);
						const snapshotGraphInputId = entry?.metadata?.graphInput.graphInputId ?? null;
						if (snapshotGraphInputId === graphInput.graphInputId) {
							refreshSnapshotCache = false;
							yield* provideFileSystem(
								fs,
								snapshot.restore({
									id: snapshotCache.existingSnapshotId,
									currentGraphInput: graphInput,
									graphInputMismatchPolicy: 'block',
								}),
							);
						} else {
							refreshSnapshotCache = true;
							yield* Effect.logWarning(
								`snapshot cache ${snapshotCache.name} graph input is stale or unreadable; boot will refresh it`,
							);
						}
					}
				} else if (startFromSnapshot !== undefined) {
					const graphInput = yield* computeGraphInput;
					if (startFromSnapshot.stalePolicy === 'clean-start') {
						const catalog = yield* provideFileSystem(fs, snapshot.list);
						const entry = catalog.find(
							(snapshotEntry) => snapshotEntry.id === startFromSnapshot.id,
						);
						const snapshotGraphInputId = entry?.metadata?.graphInput.graphInputId ?? null;
						if (snapshotGraphInputId !== graphInput.graphInputId) {
							yield* Effect.logWarning(
								`snapshot ${startFromSnapshot.id} graph input is stale; clean-start policy skipped restore`,
							);
						} else {
							yield* provideFileSystem(
								fs,
								snapshot.restore({
									id: startFromSnapshot.id,
									currentGraphInput: graphInput,
									graphInputMismatchPolicy: 'block',
								}),
							);
						}
					} else {
						yield* provideFileSystem(
							fs,
							snapshot.restore({
								id: startFromSnapshot.id,
								currentGraphInput: graphInput,
								graphInputMismatchPolicy: startFromSnapshot.stalePolicy,
							}),
						);
					}
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
					// Opt-in quiet plain stream (readiness/endpoint/codegen
					// milestones + warns/errors only). Set by embedded consumers
					// that pipe `devstack up` output through another tool — the
					// Playwright `webServer` (see `devstackPlaywrightWebServer`)
					// — where the full per-event firehose reads as `[WebServer]`
					// noise. No effect on a TTY (`ink`) or normal CI `plain` run.
					quiet: process.env.DEVSTACK_PLAIN_QUIET === '1',
				});
				yield* Effect.addFinalizer(() => renderer.flush.pipe(Effect.catch(() => Effect.void)));
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
		withinScope: (h) =>
			Effect.gen(function* () {
				if (snapshotCache === undefined || !refreshSnapshotCache) return;
				yield* h.supervisor.runCommand({
					tag: 'snapshot.capture',
					name: snapshotCache.name,
					replaceExisting: true,
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
		readonly fromSnapshot?: string;
		readonly snapshotCache?: string;
		readonly snapshotStalePolicy?: GlobalFlags['snapshotStalePolicy'];
	},
): Effect.Effect<CommandResult, CliError> => {
	const loader = makeConfigLoader();
	return Effect.gen(function* () {
		if (options.fromSnapshot !== undefined && options.snapshotCache !== undefined) {
			return yield* Effect.fail(
				new CliUsageError({
					message: '--snapshot-cache cannot be combined with --from-snapshot',
				}),
			);
		}
		if (options.snapshotCache !== undefined && options.snapshotStalePolicy !== undefined) {
			return yield* Effect.fail(
				new CliUsageError({
					message: '--snapshot-stale is only valid with --from-snapshot',
				}),
			);
		}
		const loadExit = yield* Effect.exit(loader.load(configPath));
		if (Exit.isFailure(loadExit)) {
			return yield* Effect.fail(cliErrorFromConfigExit(loadExit));
		}
		const loaded = loadExit.value;
		const publicStack = (
			loaded as LoadedConfig & {
				readonly stack: Stack<SupervisedStack['members']>;
			}
		).stack;
		const stack = (loaded as LoadedConfig & { readonly engine: SupervisedStack }).engine;

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

		const devstackVersion = readDevstackVersion({ fallback: '0.0.0' });
		const rendererMode = resolveUpRendererMode({
			cliRenderer: options.renderer,
			stackRenderer: stack.options.renderer,
			stdoutIsTty: options.stdoutIsTty,
		});
		let startFromSnapshot: StartFromSnapshot | undefined;
		let snapshotCache: SnapshotCache | undefined;
		if (options.fromSnapshot !== undefined) {
			const resolved = yield* makeSnapshotReader({ stackRoot: effectiveIdentity.stackRoot })
				.resolve(options.fromSnapshot)
				.pipe(
					Effect.mapError(
						(cause) =>
							new CliInternalError({
								message: 'snapshot lookup failed',
								cause,
							}),
					),
				);
			switch (resolved.tag) {
				case 'found':
					startFromSnapshot = {
						id: resolved.entry.snapshotId,
						stalePolicy: options.snapshotStalePolicy ?? 'warn',
					};
					break;
				case 'not-found':
					return yield* Effect.fail(
						new CliSnapshotNotFoundError({ snapshotRef: options.fromSnapshot }),
					);
				case 'ambiguous':
					return yield* Effect.fail(
						new CliUsageError({
							message: `snapshot reference is ambiguous: ${resolved.snapshotRef}`,
							hint: `matches: ${resolved.matches.map((entry) => entry.snapshotId).join(', ')}`,
						}),
					);
			}
		}
		if (options.snapshotCache !== undefined) {
			const resolved = yield* makeSnapshotReader({ stackRoot: effectiveIdentity.stackRoot })
				.resolve(options.snapshotCache)
				.pipe(
					Effect.mapError(
						(cause) =>
							new CliInternalError({
								message: 'snapshot lookup failed',
								cause,
							}),
					),
				);
			switch (resolved.tag) {
				case 'found':
					snapshotCache = {
						name: options.snapshotCache,
						existingSnapshotId: resolved.entry.snapshotId,
					};
					break;
				case 'not-found':
					snapshotCache = { name: options.snapshotCache };
					break;
				case 'ambiguous':
					return yield* Effect.fail(
						new CliUsageError({
							message: `snapshot reference is ambiguous: ${resolved.snapshotRef}`,
							hint: `matches: ${resolved.matches.map((entry) => entry.snapshotId).join(', ')}`,
						}),
					);
			}
		}

		// The CLI concerns (snapshot/wipe/prune `commandHandler` + the
		// recover/roster/IPC/TUI boot hooks) as a value bundle — the
		// EXACT thing the seam consumes, extracted so the Docker-free CLI-boot
		// smoke test can drive the real bundle (see `test/cli/up-boot-smoke`).
		const { commandHandler, boot } = buildUpBootBundle({
			stack,
			identityValue,
			runtimeRoot: effectiveIdentity.runtimeRoot,
			devstackVersion,
			rendererMode,
			...(startFromSnapshot === undefined ? {} : { startFromSnapshot }),
			...(snapshotCache === undefined ? {} : { snapshotCache }),
		});

		// The ONE boot seam. `runStackWithBoot` owns the substrate Layer
		// composition, the contribution dispatcher + post-acquire hook +
		// `extendContext` assembly, the projection ref, and the
		// forkDetach/Deferred boot lifecycle — `up` no longer forks its own
		// parallel orchestration. The CLI concerns (recover/roster/IPC/TUI
		// + snapshot handler) are passed as injected hooks + `commandHandler`.
		const handle = runStackWithBoot(publicStack, {
			identity: {
				app: String(identityValue.app),
				stack: String(identityValue.stack),
				network: String(identityValue.network),
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
					Effect.catchCause(
						(cause): Effect.Effect<never, CliError> =>
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
