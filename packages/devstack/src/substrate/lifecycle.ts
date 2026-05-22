// Lifecycle state machine — one closed shape for every plugin.
//
// Architecture § Lifecycle state. Services stop at `stopped`; tasks
// finish at `done`. Both flow through `acquiring` → `ready` and
// degrade to `failed` on error.

/** Closed state set the scheduler tracks. */
export type LifecycleStatus =
	| 'pending'
	| 'acquiring'
	| 'ready'
	| 'failed'
	| 'stopping'
	| 'stopped'
	| 'done';

/** Phases on top of statuses. Free-form (architecture Tension 14):
 *  the engine treats phase as opaque text; renderers project. */
export type PhaseNarration = string;

/** Author-facing plugin role. Services own long-lived resources;
 *  tasks acquire a value and then complete. */
export type PluginRole = 'service' | 'task';

/** Allowed transitions, expressed as a type-level lookup. The
 *  scheduler asserts moves against this table; off-table moves are
 *  programmer error (an Effect.die, not a typed failure). */
export type LifecycleTransition =
	| { readonly from: 'pending'; readonly to: 'acquiring' | 'failed' }
	| { readonly from: 'acquiring'; readonly to: 'ready' | 'failed' }
	| { readonly from: 'ready'; readonly to: 'stopping' | 'failed' | 'done' }
	| { readonly from: 'stopping'; readonly to: 'stopped' | 'failed' }
	| { readonly from: 'failed'; readonly to: 'pending' /* via hot-restart */ }
	| { readonly from: 'stopped'; readonly to: 'pending' /* via hot-restart */ }
	| { readonly from: 'done'; readonly to: 'pending' /* via hot-restart */ | 'failed' };

/** A merge-not-replace lifecycle event the substrate accumulates per
 *  plugin row. Phase/lastError are transient annotations
 *  cleared on transition to ready/failed. */
export interface LifecycleFact {
	readonly status: LifecycleStatus;
	readonly phase: PhaseNarration | null;
	/** Set by the scheduler when transitioning. Renderers may read it
	 *  to highlight subgraph restarts. */
	readonly selectiveRestartHighlight: boolean;
}
