// `devstack apply` verb wiring.
//
// Live-aware: if a supervisor owns the selected stack, publish an
// `apply.requested` command and await its ack. Otherwise run a
// one-shot supervise that exits when all plugins are ready.

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
import { probeSupervisorPresence } from '../../surfaces/cli/commands/index.ts';
import { ExitCode } from '../../surfaces/cli/sysexits.ts';
import type { LoadedConfig } from '../../surfaces/cli/commands/config-loader.ts';

import { makeConfigLoader } from './config-loader.ts';
import { identityValueFor, stackRootFor, type ResolvedIdentity } from './identity.ts';
import { buildVerbLayers } from './build-verb-layers.ts';

const LIVE_APPLY_ACK_TIMEOUT_MILLIS = 10 * 60 * 1000;

/** Probe the roster file; if a supervisor is live, publish
 *  `apply.requested` and await its ack. Returns `true` when the live
 *  path handled the verb (caller should not run the direct path). */
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

export const runApplyLive = (
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
		const identityValue: Identity = identityValueFor(identity, stack);
		if (yield* runApplyAgainstLiveSupervisor(identity, identityValue)) {
			return;
		}
		const appRoot = dirname(loaded.resolvedConfigPath);
		const substrateLayers = buildVerbLayers({
			identity: identityValue,
			stack,
			appRoot,
			runtimeRoot: identity.runtimeRoot,
		});

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
