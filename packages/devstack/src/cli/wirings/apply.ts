// `devstack apply` verb wiring.
//
// Live-aware: if a supervisor owns the selected stack, publish an
// `apply.requested` command and await its ack. Otherwise run a
// one-shot supervise that exits when all plugins are ready.
//
// Logger layer: `Logger.consolePretty()`. `apply` is the documented
// one-shot mode (no TUI) — its consumers are CI logs and ad-hoc
// operator runs that read raw stderr. Structured `Effect.log*` records
// are the only operator-visible diagnostic for non-TUI surfaces, so we
// route them through the pretty console layer. The sibling `up` verb
// silences this layer (see `wirings/up.ts` header) because it owns the
// TUI and would render duplicate / scrambled output otherwise.

import { dirname, resolve as resolvePath } from 'node:path';

import { Cause, Effect, Exit, Logger, SubscriptionRef } from 'effect';

import type { Identity } from '../../substrate/identity.ts';
import { StackPathsService } from '../../substrate/runtime/paths.ts';
import {
	commandChannelPaths,
	makeCommandChannelPublisher,
	makeProjectionRef,
	type SupervisedStack,
	writeProjectionSnapshot,
} from '../../substrate/runtime/index.ts';
import {
	buildProductionContributionDispatcher,
	buildProductionPostAcquireHook,
	extendBuiltInPluginContext,
	layerBuiltInPluginRuntime,
	superviseStackEffect,
} from '../../orchestrators/boot.ts';
import {
	recoverInterruptedRestore,
	SnapshotOrchestratorService,
} from '../../orchestrators/snapshot/index.ts';
import { type CliError, CliInternalError } from '../../surfaces/cli/errors.ts';
import { type CommandResult, probeSupervisorPresence } from '../../surfaces/cli/commands/index.ts';
import { ExitCode } from '../../surfaces/cli/sysexits.ts';
import type { LoadedConfig } from '../../surfaces/cli/commands/config-loader.ts';

import { cliErrorFromConfigExit } from '../bail.ts';
import { makeConfigLoader } from './config-loader.ts';
import {
	identityValueFor,
	resolvedIdentityForStack,
	stackRootFor,
	type ResolvedIdentity,
} from './identity.ts';
import { buildVerbLayers } from './build-verb-layers.ts';

const LIVE_APPLY_ACK_TIMEOUT_MILLIS = 10 * 60 * 1000;

/** Outcome of the live-supervisor probe + dispatch:
 *  - `kind: 'direct'` — no supervisor; caller runs the direct path.
 *  - `kind: 'live-ok'` — live supervisor acked; verb is done.
 *  - `kind: 'live-failed'` — live supervisor refused/timed-out; caller
 *    surfaces the typed `CliError` via the dispatcher envelope. */
type ApplyDispatch =
	| { readonly kind: 'direct' }
	| { readonly kind: 'live-ok' }
	| { readonly kind: 'live-failed'; readonly error: CliError };

/** Probe the roster file; if a supervisor is live, publish
 *  `apply.requested` and await its ack. */
const runApplyAgainstLiveSupervisor = (
	identity: ResolvedIdentity,
	identityValue: Identity,
): Effect.Effect<ApplyDispatch> =>
	Effect.gen(function* () {
		const stackRoot = stackRootFor(identity.runtimeRoot, String(identityValue.stack));
		const presence = yield* probeSupervisorPresence(resolvePath(stackRoot, 'roster.json')).pipe(
			Effect.catch(() => Effect.succeed({ live: false, pid: null, hostname: null })),
		);
		if (!presence.live) return { kind: 'direct' as const };

		const exit = yield* Effect.exit(
			Effect.gen(function* () {
				const publisher = yield* makeCommandChannelPublisher(commandChannelPaths(stackRoot));
				const published = yield* publisher.publish({ tag: 'apply.requested' });
				const reply = yield* publisher.awaitCompletion(published, {
					timeoutMillis: LIVE_APPLY_ACK_TIMEOUT_MILLIS,
				});
				if (!reply.ok) {
					return yield* Effect.fail(reply.message);
				}
			}),
		);

		if (Exit.isFailure(exit)) {
			return {
				kind: 'live-failed' as const,
				error: new CliInternalError({
					message: 'live stack apply failed',
					cause: Cause.pretty(exit.cause as Cause.Cause<unknown>),
				}),
			};
		}

		return { kind: 'live-ok' as const };
	});

export const runApplyLive = (
	configPath: string | undefined,
	identity: ResolvedIdentity,
): Effect.Effect<CommandResult, CliError> => {
	const loader = makeConfigLoader();
	return Effect.gen(function* () {
		// Config-load failures surface as typed `CliError`s; the
		// dispatcher's outer `emitFailure` renders the envelope.
		const loadExit = yield* Effect.exit(loader.load(configPath));
		if (Exit.isFailure(loadExit)) {
			return yield* Effect.fail(cliErrorFromConfigExit(loadExit));
		}
		const loaded = loadExit.value;
		const stack = (loaded as LoadedConfig & { readonly stack: SupervisedStack }).stack;
		// Re-derive the identity against the EFFECTIVE stack (explicit
		// `--stack`/`$DEVSTACK_STACK` > `config.stackName` > inferred) so
		// the live-supervisor probe + roster paths target the same stack
		// the operator selected — matching `snapshot.ts`. An explicit
		// `--stack` must NOT be overridden by `config.stackName`, otherwise
		// `apply` would probe/boot the wrong stack's supervisor.
		const effectiveIdentity = resolvedIdentityForStack(identity, stack);
		const identityValue: Identity = identityValueFor(effectiveIdentity);
		const dispatch = yield* runApplyAgainstLiveSupervisor(effectiveIdentity, identityValue);
		if (dispatch.kind === 'live-failed') {
			return yield* Effect.fail(dispatch.error);
		}
		if (dispatch.kind === 'live-ok') {
			return { exitCode: ExitCode.OK };
		}
		const appRoot = dirname(loaded.resolvedConfigPath);
		const substrateLayers = buildVerbLayers({
			identity: identityValue,
			stack,
			appRoot,
			runtimeRoot: effectiveIdentity.runtimeRoot,
		});

		const program = Effect.gen(function* () {
			const state = yield* makeProjectionRef();
			const contributionDispatcher = yield* buildProductionContributionDispatcher();
			const postAcquireHook = yield* buildProductionPostAcquireHook({
				extras: stack.options.extras,
			});
			const stackPaths = yield* StackPathsService;
			// Mirror the up-path recovery: resume any restore interrupted by a
			// hard kill between the atomic swap and the image-promotion handoff
			// completing (the interrupted-restore sentinel rode the swap into the
			// live root and was never cleared) BEFORE the one-shot apply starts
			// the stack. Idempotent + no-op when no sentinel is present.
			const snapshot = yield* SnapshotOrchestratorService;
			yield* recoverInterruptedRestore({
				liveRoot: stackPaths.stackRoot,
				restoreSnapshot: (id) => snapshot.restore({ id }),
			});
			yield* superviseStackEffect(
				{ _tag: 'Stack', members: stack.members, options: stack.options },
				identityValue,
				state,
				{
					contributionDispatcher,
					postAcquireHook,
					lifetime: 'one-shot',
					extendContext: extendBuiltInPluginContext,
				},
			).pipe(Effect.provide(layerBuiltInPluginRuntime));
			yield* writeProjectionSnapshot(stackPaths.stackRoot, yield* SubscriptionRef.get(state));
		});

		return yield* program.pipe(
			Effect.provide(substrateLayers),
			Effect.provide(Logger.layer([Logger.consolePretty()])),
			Effect.matchCauseEffect({
				onFailure: (cause): Effect.Effect<CommandResult, CliError> =>
					Effect.fail(
						new CliInternalError({
							message: 'stack apply failed',
							cause: Cause.pretty(cause as Cause.Cause<unknown>),
						}),
					),
				onSuccess: (): Effect.Effect<CommandResult, CliError> =>
					Effect.succeed({ exitCode: ExitCode.OK }),
			}),
		);
	});
};
