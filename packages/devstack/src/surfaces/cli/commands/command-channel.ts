// CLI surface — typed command publisher abstraction.
//
// Architecture (distilled/20-cli.md § Surface-equality principle):
// "The CLI subscribes to typed engine events and publishes typed
// commands — never reaches into engine internals directly."
//
// This module defines the seam the CLI commands depend on: a thin
// `publish(EngineCommand)` Effect. The dispatcher binds it to the
// supervisor's command queue (or, in tests, a buffered list). The
// CLI commands themselves see only this interface.
//
// The same shape backs TUI keypresses, programmable API calls, and
// build-integration invocations — Surface-equality in action.

import type { Effect } from 'effect';

import type { EngineCommand, EngineEvent } from '../../../substrate/events.ts';

/** Publisher seam. Resolves once the engine has accepted the command
 *  onto its queue; does NOT wait for the command to take effect. */
export interface CommandPublisher {
	readonly publish: (cmd: EngineCommand) => Effect.Effect<void, unknown>;
}

/** Subscriber seam. Subscribes to the live event stream and returns
 *  an unsubscribe Effect. Implementations are responsible for fanning
 *  out one delivery per subscriber. Implementations that need a
 *  `Scope` (filesystem-backed tailing) MUST handle scope acquisition
 *  internally — see `channel-deps.ts::makeChannelSubscriber` which
 *  forks the tail into an internal scope and returns the
 *  unsubscribe-via-Scope.close handle. */
export interface EventSubscriber {
	readonly subscribe: (
		handler: (event: EngineEvent) => Effect.Effect<void>,
	) => Effect.Effect<{ readonly unsubscribe: Effect.Effect<void> }>;
}
