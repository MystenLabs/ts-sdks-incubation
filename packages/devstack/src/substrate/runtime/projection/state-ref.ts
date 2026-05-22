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
 * Compile-time guard: the projection shape MUST NOT contain display
 * vocabulary. These conditional types resolve to `never` (and would
 * fail to assign anywhere they're used) if `title`/`primary`/
 * `extras` were ever added to `SubscribableState` or `Row`.
 *
 * The architecture's invariant becomes a TS error at the boundary
 * — the projection layer can't be wired up if a renderer-display
 * concept leaks into the engine's data model.
 */
type _NoDisplayVocabAtTop = 'title' extends keyof SubscribableState
	? never
	: 'primary' extends keyof SubscribableState
		? never
		: 'extras' extends keyof SubscribableState
			? never
			: true;
type _NoDisplayVocabInRow = 'title' extends keyof Row
	? never
	: 'primary' extends keyof Row
		? never
		: 'extras' extends keyof Row
			? never
			: true;
export type __NoDisplayVocab = _NoDisplayVocabAtTop & _NoDisplayVocabInRow extends true
	? true
	: never;

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
