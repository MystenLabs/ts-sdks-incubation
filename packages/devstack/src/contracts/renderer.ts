// Renderer capability contract (architecture §11 — sub-shape of
// NodePlugin).
//
// Mounts once per process; the engine cycle re-runs many times; the
// renderer never sees the cycle swap. Lifetime is process-scoped via
// the subscribable state-ref projection.

import type { Effect, Scope, Stream, SubscriptionRef } from 'effect';

import type { EngineEvent } from '../substrate/events.ts';
import type { SubscribableState } from '../substrate/projection.ts';

/**
 * Renderer contract — TUI, plain, silent all satisfy this. The
 * renderer subscribes to the live event stream OR samples the
 * subscribable state-ref; the engine never sees the renderer's
 * choice.
 */
export interface Renderer {
	readonly mount: (
		stateRef: SubscriptionRef.SubscriptionRef<SubscribableState>,
		events: Stream.Stream<EngineEvent, never>,
	) => Effect.Effect<void, RendererError, Scope.Scope>;
	readonly flush: Effect.Effect<void, RendererError>;
}

export interface RendererError {
	readonly _tag: 'RendererError';
	readonly reason: 'mount-failed' | 'subscription-lost';
	readonly detail: string;
}
