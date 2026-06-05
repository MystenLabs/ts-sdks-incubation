// Subscribable projection state-ref.
//
// Architecture § Renderer § "Subscribable projection — exact field
// enumeration" (G2) + § "Renderer mount lifetime vs engine cycle
// lifetime" (decision #8). The state-ref is process-scoped (mounted
// once); the engine cycle re-runs many times and never re-creates the
// ref. The renderer subscribes once at mount; the engine updates
// in-place across cycles.
//
// The projection's TypeScript shape is enforced closed by
// `__ProjectionFieldsClosed` in `../../projection.ts`. Adding a
// display-vocabulary field (`title`, `primary`, `extras`) at this
// layer would fail to assign into `SubscribableState` — renderers
// derive those from `rows[*].kind` + display rules.

import { Effect, SubscriptionRef } from 'effect';

import type {
	BuildEntry,
	AccountProjection,
	Endpoint,
	PackageProjection,
	Row,
	StructuredError,
	SubscribableState,
} from '../../projection.ts';

/**
 * Empty initial projection. Cycle starts at `id: 0`, `phase:
 * 'booting'`. Identity fields are placeholder; the engine MUST
 * replace via `update.ts::setIdentity` before any renderer is
 * notified of anything user-visible.
 *
 * The shape here is the entire contract the renderer sees — no
 * service names, no display vocabulary. If a future field needs
 * adding, the architecture-revision discipline kicks in via
 * `__ProjectionFieldsClosed`.
 */
export const emptyProjection = (): SubscribableState => ({
	identity: { app: '', stack: '', network: '' },
	cycle: { id: 0, startedAt: 0, phase: 'booting' },
	rows: [],
	endpoints: [],
	accounts: [],
	packages: [],
	errors: [],
	lastEvent: { seq: 0, at: 0 },
	stackBuild: [],
});

/**
 * Create the subscribable projection ref. One per process.
 *
 * Engine cycle: the ref outlives the engine cycle. Stop-and-restart
 * keeps the same ref; only `cycle.id` increments. Renderers see a
 * continuous stream — that's the whole point of decoupling renderer
 * lifetime from engine cycle.
 */
export const makeProjectionRef = (): Effect.Effect<
	SubscriptionRef.SubscriptionRef<SubscribableState>
> => SubscriptionRef.make(emptyProjection());

/**
 * Sync-only constructor for the subscribable projection ref. The
 * `runStack(...)` API allocates the ref BEFORE the supervised
 * Effect runs so callers can subscribe to `state.changes` ahead of
 * boot — that allocation path has no Effect runtime to run under and
 * must complete synchronously.
 *
 * Callers that already live inside an Effect should use the
 * Effect-wrapped `makeProjectionRef()` so future changes to the
 * constructor stay Effect-correct without breaking those call
 * sites. This sync variant is pinned at the substrate boundary: any
 * future refactor of `makeProjectionRef` (e.g. layering a `withSpan`
 * or annotation) MUST keep `makeProjectionRefSync` synchronous — if
 * that ever becomes impossible the boot-time call site needs a
 * different signaling strategy (Deferred-handoff), not a silent
 * `Effect.runSync` crash on an async effect.
 *
 * `SubscriptionRef.make` is sync-effect today (no async, no
 * side-effects beyond an `unbounded` `PubSub.unbounded({ replay:
 * 1 })`), so `Effect.runSync` is safe right now; the indirection
 * exists so the constraint is documented at the constructor, not
 * inferred from the caller.
 */
export const makeProjectionRefSync = (): SubscriptionRef.SubscriptionRef<SubscribableState> =>
	Effect.runSync(makeProjectionRef());

// Re-export the sub-types renderers reach for so they don't import
// across the substrate boundary directly — `state-ref.ts` is the
// renderer-facing entry point.
export type {
	AccountProjection,
	BuildEntry,
	Endpoint,
	PackageProjection,
	Row,
	StructuredError,
	SubscribableState,
};
