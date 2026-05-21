// CLI verb: `devstack up` — boot a stack and stay attached until
// interrupted.
//
// Architecture (distilled/20-cli.md § Lifecycle / invocation patterns
// § Long-running until interrupt):
//   "`up` (engine supervisor loop)."
//   "`up` must hand its long-running effect to the outer Node runtime
//    directly, not nest a runtime — otherwise SIGINT cannot reach
//    scope finalizers and container teardown leaks."
//
// The bin entry owns live supervisor construction and outer Node fiber
// handoff. This surface command is the channel-backed shape used by the
// dispatcher seam: load config, publish `stack.start`, and wait for the
// supplied shutdown latch.

import { Effect } from 'effect';

import type { CommandPublisher, EventSubscriber } from './command-channel.ts';
import {
	type CliError,
	CliConfigInvalidError,
	CliConfigNotFoundError,
	CliInternalError,
} from '../errors.ts';
import { emitSuccess } from '../output.ts';
import type { CommandContext, CommandResult } from './index.ts';

/** Config loader seam. The dispatcher implements this against the
 *  resolved `configPath` (default `./devstack.config.ts`, walking up
 *  if not found). Returns a verified `Stack` value or a typed
 *  `CliConfig*` error. */
export interface ConfigLoader {
	readonly load: (
		configPath: string | undefined,
	) => Effect.Effect<LoadedConfig, CliConfigNotFoundError | CliConfigInvalidError>;
}

/** Minimum shape the `up` command pulls off a loaded config. Mirrors
 *  the `Stack<Members>` surface in `api/define-devstack.ts` without
 *  importing it (this file stays L4-surface-clean). */
export interface LoadedConfig {
	readonly stack: { readonly _tag: 'Stack' };
	readonly resolvedConfigPath: string;
}

/** Shutdown latch: an Effect that resolves when the supervisor has
 *  fully drained (either via signal or via a published
 *  `shutdown.requested`). The dispatcher constructs this from the
 *  supervisor's `awaitShutdown` handle. */
export interface ShutdownLatch {
	readonly await: Effect.Effect<void>;
}

export interface UpDeps {
	readonly loader: ConfigLoader;
	readonly publisher: CommandPublisher;
	readonly subscriber: EventSubscriber;
	readonly shutdown: ShutdownLatch;
}

/**
 * Run `devstack up`. Wiring:
 *   1. Apply `--network` to `process.env.DEVSTACK_NETWORK` BEFORE
 *      loading the config (architecture invariant: top-level config
 *      reads of network env must observe the flag). The dispatcher
 *      does this before invoking us.
 *   2. Load the user's `devstack.config.ts` via the loader seam.
 *   3. Publish `stack.start` and `await` the shutdown latch. Live
 *      supervisor construction and scope handoff happen in the bin
 *      entry so process signals reach runtime finalizers.
 *   4. On shutdown, emit the success envelope and exit 0.
 *
 * Long-running shape: this Effect resolves only when the latch fires.
 * The dispatcher's outer `Effect.runFork` must keep the surrounding
 * scope alive so finalizers run on SIGINT.
 */
export const runUp = (deps: UpDeps, ctx: CommandContext): Effect.Effect<CommandResult, CliError> =>
	Effect.gen(function* () {
		const started = Date.now();
		const loaded = yield* deps.loader.load(ctx.flags.configPath);
		yield* deps.subscriber
			.subscribe(() => Effect.void)
			.pipe(
				Effect.catch((cause: unknown) =>
					Effect.fail(new CliInternalError({ message: 'event subscribe failed', cause })),
				),
			);
		yield* deps.publisher
			.publish({ tag: 'stack.start' })
			.pipe(
				Effect.catch((cause: unknown) =>
					Effect.fail(new CliInternalError({ message: 'stack.start publish failed', cause })),
				),
			);
		yield* deps.shutdown.await;
		const elapsedMs = Date.now() - started;
		yield* emitSuccess(ctx.io, ctx.flags.outputMode, {
			command: 'up',
			elapsedMs,
			data: {
				configPath: loaded.resolvedConfigPath,
				shutdownCause: 'clean' as const,
			},
			humanLines: ['stack shutdown clean'],
		});
		return { exitCode: 0 } as CommandResult;
	}).pipe(Effect.withSpan('cli.up'));
