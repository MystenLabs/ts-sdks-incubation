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

import { Cause, Effect, Exit, FileSystem, Queue, Ref, Scope, Stream } from 'effect';

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
	recoverInterruptedRestore,
	SnapshotOrchestratorService,
} from '../../orchestrators/snapshot/index.ts';
import { computeWarmFingerprint } from '../../orchestrators/warm/fingerprint.ts';
import { runWarmCapture, runWarmRestore } from '../../orchestrators/warm/hooks.ts';
import {
	runStackWithBoot,
	type CommandHandlerFactory,
	type RunStackBootBag,
} from '../../api/run-stack-internal.ts';
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
import {
	findCliSupervisorLiveError,
	identityValueFor,
	resolvedIdentityForStack,
	type ResolvedIdentity,
} from './identity.ts';
import { installCommandChannelBridge } from './up-ipc.ts';
import { provideFileSystem } from './provide-file-system.ts';

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
}): CommandHandlerFactory =>
	Effect.gen(function* () {
		const snapshot = yield* SnapshotOrchestratorService;
		const fs = yield* FileSystem.FileSystem;
		const handler: SupervisorCommandHandler = (cmd) => {
			switch (cmd.tag) {
				case 'snapshot.capture':
					// The L3 capture is the bounce's gather → stop → commit → retag
					// → hard-rm half; the RESUME (recreate + wait-write-ready) is the
					// command-loop's converge after this handler succeeds (it owns the
					// graph), mirroring restore. So no `resume` is injected here.
					return provideFileSystem(
						fs,
						snapshot.capture({
							id: cmd.snapshotId,
							...(cmd.name === undefined ? {} : { label: cmd.name }),
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
					return provideFileSystem(fs, snapshot.restore({ id: cmd.snapshotId })).pipe(
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
	readonly appRoot: string;
	readonly resolvedConfigPath: string;
	readonly devstackVersion: string;
	readonly rendererMode: import('../../surfaces/tui/mode-detect.ts').RendererMode;
	readonly warmEnabled: boolean;
}

export interface UpBootBundle {
	readonly commandHandler: CommandHandlerFactory;
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

	// The snapshot/wipe/prune `commandHandler` — a FACTORY the seam resolves
	// against its LIVE substrate (the seam runs it before `startSupervisor`
	// consumes the handler). The factory closes over the seam's ONE
	// `SnapshotOrchestratorService` instance — the same one the supervisor's
	// contribution dispatcher registers live participants on — so an operator
	// `snapshot save` captures the LIVE chain/blob/db state, not an empty set
	// off a sibling orchestrator. No Deferred hand-off.
	const commandHandler = makeSnapshotCommandHandler({ runtimeRoot });

	const boot: RunStackBootBag = {
		beforeInitialAcquire: (h) =>
			Effect.gen(function* () {
				// The seam's substrate services — the SAME instances the
				// `commandHandler` factory closed over and the supervisor uses,
				// driven here for the recover/warm/IPC/roster/TUI work.
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
