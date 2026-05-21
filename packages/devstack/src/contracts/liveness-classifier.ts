// LifenessClassifier capability — architecture Decision §10.
//
// Plugin-emitted; the L3 prune orchestrator dispatches to it given
// a registry entry's persisted hints. Keeps service-specific
// "alive/dormant/stale/abandoned" rules with the plugin instead of
// in L3.

import type { Effect } from 'effect';

export type LifenessClassification = 'alive' | 'dormant' | 'stale' | 'abandoned';

/** Per-entry hints persisted in `~/.devstack/registry.json`. The L3
 *  orchestrator passes them to the plugin's classifier. */
export interface LifenessHints {
	readonly heartbeatAt: number | null;
	readonly claimPid: number | null;
	readonly claimStartTime: number | null;
	readonly pluginHints: Readonly<Record<string, unknown>>;
}

export interface LifenessClassifierDecl {
	readonly kind: 'liveness-classifier';
	readonly classify: (hints: LifenessHints) => Effect.Effect<LifenessClassification>;
}
