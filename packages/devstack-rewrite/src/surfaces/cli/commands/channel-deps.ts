// Build CLI verb deps backed by the cross-process command channel.
//
// The CLI's verb dependencies (publisher / subscriber / snapshot
// reader / status reader / etc.) need a transport. When the user
// runs a non-`up` verb against a stack with a live supervisor, the
// transport is the filesystem-backed command channel at
// `<stackRoot>/{commands,events}.ndjson`.
//
// This module wires those deps. The presence probe (roster-based) is
// consulted lazily — verbs that don't need a live supervisor
// (`config`, `status` against a missing stack) tolerate absence
// gracefully; verbs that REQUIRE one (`down`, `snapshot save|restore`,
// `prune`, `codegen`, `logs`) fail with
// `CliNoSupervisorError` so the user gets a clear "the stack isn't
// running" message instead of a silent no-op.

import { Effect, Exit, Scope, Stream } from 'effect';

import {
	type CommandChannelPaths,
	commandChannelPaths,
	makeCommandChannelPublisher,
	type EventRecord,
} from '../../../substrate/runtime/cross-process/index.ts';
import { CliInternalError, CliNoSupervisorError } from '../errors.ts';
import { probeSupervisorPresence } from './supervisor-presence.ts';
import type { CommandPublisher, EventSubscriber } from './command-channel.ts';
import type { EngineEvent, EngineCommand } from '../../../substrate/events.ts';

export interface ChannelDepsContext {
	readonly app: string;
	readonly stack: string;
	readonly stackRoot: string;
	readonly rosterFile: string;
}

/**
 * Build a `CommandPublisher` that — on first publish — probes the
 * roster for a live supervisor. If absent, fails the publish with
 * `CliNoSupervisorError`; if present, writes the command to
 * `commands.ndjson`.
 *
 * The probe is per-publish (not per-construction) so the deps bundle
 * is safe to build once at dispatcher boot — the actual state-of-the-
 * world check happens at command time.
 */
export const makeChannelPublisher = (ctx: ChannelDepsContext): CommandPublisher => {
	const paths: CommandChannelPaths = commandChannelPaths(ctx.stackRoot);
	return {
		publish: (cmd: EngineCommand) =>
			Effect.gen(function* () {
				const presence = yield* probeSupervisorPresence(ctx.rosterFile).pipe(
					Effect.catch((cause) =>
						Effect.fail(
							new CliInternalError({
								message: 'failed to probe supervisor liveness',
								cause,
							}),
						),
					),
				);
				if (!presence.live) {
					return yield* Effect.fail(
						new CliNoSupervisorError({
							app: ctx.app,
							stack: ctx.stack,
							hint: `start the stack with \`devstack up\` first`,
						}),
					);
				}
				const publisher = yield* makeCommandChannelPublisher(paths).pipe(
					Effect.catch((cause) =>
						Effect.fail(
							new CliInternalError({
								message: 'failed to open command channel',
								cause,
							}),
						),
					),
				);
				yield* publisher.publish(cmd).pipe(
					Effect.catch((cause) =>
						Effect.fail(
							new CliInternalError({
								message: 'failed to publish command',
								cause,
							}),
						),
					),
				);
			}),
	};
};

/**
 * Build an `EventSubscriber` that tails `events.ndjson`. The
 * subscription Effect resolves immediately with an unsubscribe Effect;
 * the supervisor's event records flow through the handler in the
 * background.
 *
 * Unlike the publisher (which probes per-publish), the subscriber
 * tails unconditionally — a supervisor that boots AFTER the subscribe
 * call still publishes to the same file, so consumers receive events
 * from boot onwards. This matches the `logs` verb's "attach now,
 * receive going forward" expectation.
 */
export const makeChannelSubscriber = (ctx: ChannelDepsContext): EventSubscriber => {
	const paths: CommandChannelPaths = commandChannelPaths(ctx.stackRoot);
	return {
		subscribe: (handler: (event: EngineEvent) => Effect.Effect<void>) =>
			Effect.gen(function* () {
				// Open a fresh scope owned by the subscription. `unsubscribe`
				// closes the scope, which interrupts the forked tail and
				// closes the channel's underlying file handles.
				const scope = yield* Scope.make();
				const tailEffect = Effect.gen(function* () {
					const publisher = yield* makeCommandChannelPublisher(paths);
					yield* publisher.events.pipe(
						Stream.filter(
							(rec): rec is Extract<EventRecord, { kind: 'engine' }> => rec.kind === 'engine',
						),
						Stream.runForEach((rec) => handler(rec.event as EngineEvent)),
					);
				}).pipe(
					Scope.provide(scope),
					Effect.catch(() => Effect.void),
				);
				yield* Effect.forkChild(tailEffect);
				return {
					unsubscribe: Scope.close(scope, Exit.void).pipe(Effect.catch(() => Effect.void)),
				};
			}),
	};
};
