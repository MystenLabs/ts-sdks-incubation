// Supervisor wiring helpers.
//
// Tiny support module for the supervisor's substrate-wiring concerns:
// fallback Logger, fallback StrategyRegistry, event publishing helpers,
// projection-level mapping, the transition emitter builder, and the
// OptionalService<T> helper that centralises the "look up an optional
// service in pluginContext, fall back if absent" pattern endemic to
// the supervisor boundary.
//
// Split out of the monolith per backlog #38 + #40.

import { Context, Effect, type Exit, Option, Queue, SubscriptionRef } from 'effect';

import type { StrategyRegistry } from '../../../contracts/strategy-contributor.ts';
import type { PluginKey } from '../../brand.ts';
import type { EngineEvent } from '../../events.ts';
import type { LifecycleStatus } from '../../lifecycle.ts';
import type { SubscribableState } from '../../projection.ts';
import { StrategyNotFoundError } from '../errors.ts';
import type { LoggerShape, LogStoreShape } from '../observability/index.ts';
import { serviceKeyFor } from '../observability/index.ts';
import { updateRef } from '../projection/update.ts';

// -----------------------------------------------------------------------------
// Best-effort lifecycle mutation
// -----------------------------------------------------------------------------

/**
 * Swallow BOTH the typed failure and any defect of a best-effort
 * effect, discarding its outcome. Lifecycle mutations
 * (`registry.transition` / `markReady` / `markFailed`) validate against
 * the transition table via `assertTransition`, which `Effect.die`s (a
 * DEFECT, not a typed failure) on an off-table move — reachable when a
 * concurrent selective-restart races an in-flight acquire. `Effect.catch`
 * only intercepts the typed `E` channel, so a die would escape and bubble
 * unguarded through the unbounded acquire fan-out (supervisor wedge).
 * `Effect.exit` captures failure AND defect into an `Exit` we discard,
 * keeping these mutations genuinely best-effort.
 */
export const bestEffort = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
): Effect.Effect<Exit.Exit<A, E>, never, R> => Effect.exit(effect);

// -----------------------------------------------------------------------------
// OptionalService<T> — substrate-wide "service-or-default" helper
// -----------------------------------------------------------------------------

/**
 * Read an optional service from a `Context.Context<never>` or fall back
 * to a default value. The supervisor's `pluginContext` is name-blind: a
 * caller may or may not have layered a `Logger`, `RuntimeRoot`, or
 * `StrategyRegistry`. The lookup pattern was open-coded in three
 * sites until backlog #40 lifted it here.
 *
 * Upstream-watch (Phase 5 reviewer): Effect v4 exposes `Context.getOption`
 * (returns `Option<S>`) and `Context.getUnsafe` (throws on missing), but
 * NO `getOptionUnchecked`-style variant that returns `Option<S>` over a
 * `Context<never>` without the typed cast we perform here. The wrapper
 * stays until upstream adds an unchecked optional getter — at which
 * point the body collapses to a thin alias.
 */
export const OptionalService = <S, I>(tag: Context.Key<I, S>) => ({
	read: (ctx: Context.Context<never>, fallback: S): S => {
		const opt = Context.getOption(ctx as Context.Context<I>, tag);
		return Option.isSome(opt) ? opt.value : fallback;
	},
});

// -----------------------------------------------------------------------------
// Fallback services for bare smoke-test `supervise()` paths
// -----------------------------------------------------------------------------

/** Fallback used when the supervisor's `pluginContext` doesn't carry a
 *  Logger service. Swallows every line — the trade-off is that bare
 *  `supervise()` smoke tests stay log-free, while the wired CLI / e2e
 *  layer stack picks up the real Logger. */
export const noopLogger: LoggerShape = {
	log: () => Effect.void,
	readTag: () => Effect.succeed({ lines: [], truncated: false }),
	readAll: Effect.succeed(new Map()),
	clearTag: () => Effect.void,
};

export const noopStrategyRegistry: StrategyRegistry = {
	get: (key) =>
		Effect.fail(
			new StrategyNotFoundError({
				capabilityKey: key,
				registeredKeys: [],
			}),
		),
	list: () => Effect.succeed([]),
	register: () => Effect.void,
};

// -----------------------------------------------------------------------------
// Event publishing
// -----------------------------------------------------------------------------

/** Publishing helper: writes the event to the projection ref AND
 *  enqueues it onto the live event hub for renderers that subscribe to
 *  the raw stream. */
export const publish = (
	ref: SubscriptionRef.SubscriptionRef<SubscribableState>,
	hub: Queue.Enqueue<EngineEvent>,
	event: EngineEvent,
): Effect.Effect<void> =>
	Effect.gen(function* () {
		yield* updateRef(ref, event);
		yield* Queue.offer(hub, event);
	});

export const setCyclePhase = (
	ref: SubscriptionRef.SubscriptionRef<SubscribableState>,
	phase: SubscribableState['cycle']['phase'],
): Effect.Effect<void> =>
	SubscriptionRef.update(ref, (state) => ({
		...state,
		cycle: {
			...state.cycle,
			startedAt: state.cycle.startedAt === 0 ? Date.now() : state.cycle.startedAt,
			phase,
		},
	}));

// -----------------------------------------------------------------------------
// Logger overlay — projects structured log lines into `log.appended`
// -----------------------------------------------------------------------------

export const projectionLevel = (
	level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal',
): Extract<EngineEvent, { tag: 'log.appended' }>['level'] | null => {
	switch (level) {
		case 'trace':
		case 'debug':
			return null;
		case 'info':
			return 'info';
		case 'warn':
			return 'warn';
		case 'error':
		case 'fatal':
			return 'error';
		default: {
			const _exhaustive: never = level;
			void _exhaustive;
			return 'info';
		}
	}
};

export const withEventPublishingLogger = (
	base: LoggerShape,
	ref: SubscriptionRef.SubscriptionRef<SubscribableState>,
	hub: Queue.Enqueue<EngineEvent>,
	/** Optional cross-service queryable store. Every logged line is teed
	 *  into it (the SAME source that feeds the projection's per-row tail —
	 *  see log-store.ts), so the dashboard's "Logs" tab gets a filterable
	 *  cross-service history without a second log reader. Absent in bare
	 *  smoke-test paths that don't wire a LogStore. */
	logStore: LogStoreShape | null = null,
): LoggerShape => ({
	...base,
	log: (tag, pluginKey, payload) =>
		Effect.gen(function* () {
			yield* base.log(tag, pluginKey, payload);
			// Tee into the cross-service store regardless of plugin key —
			// the queryable surface keeps supervisor-level lines too (the
			// projection tail below is row-scoped, so it only takes
			// plugin-attributed lines).
			if (logStore !== null) {
				yield* logStore.append({
					level: payload.level,
					service: serviceKeyFor(tag, pluginKey),
					message: payload.message,
					fields: payload.fields,
				});
			}
			if (pluginKey === null) return;
			const level = projectionLevel(payload.level);
			if (level === null) return;
			yield* publish(ref, hub, {
				tag: 'log.appended',
				pluginKey,
				line: payload.message,
				level,
				at: Date.now(),
			});
		}),
});

// -----------------------------------------------------------------------------
// Transition emitter
// -----------------------------------------------------------------------------

/** Build the registry's `onTransition` callback — turns status changes
 *  into typed events. */
export const buildTransitionEmitter =
	(
		ref: SubscriptionRef.SubscriptionRef<SubscribableState>,
		hub: Queue.Enqueue<EngineEvent>,
	): ((key: PluginKey, from: LifecycleStatus, to: LifecycleStatus) => Effect.Effect<void>) =>
	(key, from, to) =>
		publish(ref, hub, {
			tag: 'lifecycle.statusChanged',
			pluginKey: key,
			from,
			to,
			at: Date.now(),
		});
