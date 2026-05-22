// Lifecycle state machine — one closed shape for every plugin.
//
// Architecture § Lifecycle state. The state machine has separate
// terminal states for long-running plugins (`stopped`) and one-shots
// (`done`); both flow through `acquiring` → `ready` and degrade to
// `failed` on error.

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

/** Plugin classification registry — drives lifecycle transitions and
 *  renderer vocabulary computation. */
export interface DevstackPluginKindRegistry {
	readonly 'leaf-long-running': {};
	readonly 'leaf-one-shot': {};
	readonly composite: {};
	readonly 'hidden-leaf': {};
	readonly renderer: {};
}

export type PluginKind = keyof DevstackPluginKindRegistry & string;

/** Reboot-cost ordinal declared per plugin. Pure data; the cascade
 *  formatter (L0) reads it. Substrate violation §20 — plugins own
 *  the cost classification, not the engine. */
export type RebootCost = 'cheap' | 'moderate' | 'heavy';

/** Allowed transitions, expressed as a type-level lookup. The
 *  scheduler asserts moves against this table; off-table moves are
 *  programmer error (an Effect.die, not a typed failure). */
export type LifecycleTransition =
	| { readonly from: 'pending'; readonly to: 'acquiring' | 'failed' }
	| { readonly from: 'acquiring'; readonly to: 'ready' | 'failed' }
	| { readonly from: 'ready'; readonly to: 'stopping' | 'failed' | 'done' }
	| { readonly from: 'stopping'; readonly to: 'stopped' | 'failed' }
	| { readonly from: 'failed'; readonly to: 'pending' /* via hot-restart */ }
	| { readonly from: 'stopped'; readonly to: 'pending' /* via hot-restart */ };

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
