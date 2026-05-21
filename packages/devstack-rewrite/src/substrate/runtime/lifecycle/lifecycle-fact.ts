// LifecycleFact bridge.
//
// `substrate/lifecycle.ts` declares `LifecycleFact` — the merge-not-
// replace per-plugin lifecycle slice the projection consumes. Until
// now the projection updater consumed raw `EngineEvent` cases directly
// and the `LifecycleFact` type was orphan.
//
// This module is the typed bridge: it projects an `EngineEvent` into a
// `LifecycleFact` delta (when the event represents a lifecycle change)
// and exposes a single applier `applyLifecycleFact(row, fact)` the
// projection updater calls instead of writing out each
// status / phase / restart field independently. The reducer for non-
// lifecycle events is unchanged.

import type { Row } from '../../projection.ts';
import type { LifecycleFact, LifecycleStatus } from '../../lifecycle.ts';
import type { EngineEvent } from '../../events.ts';

/** Per-plugin fact delta. Each field is optional — only the fields the
 *  source event carries are populated. The projection's `applyLifecycleFact`
 *  merges a delta into the existing `Row`. */
export interface LifecycleFactDelta {
	readonly status?: LifecycleStatus;
	readonly phase?: LifecycleFact['phase'];
	readonly selectiveRestartHighlight?: boolean;
}

/** Project a lifecycle-shaped `EngineEvent` into a per-plugin delta.
 *  Returns `null` for events that don't carry lifecycle information so
 *  the reducer can short-circuit. The substrate stays event-name-blind
 *  by routing through this single mapping table. */
export const factFromEvent = (
	event: EngineEvent,
): { readonly pluginKey: string; readonly delta: LifecycleFactDelta } | null => {
	switch (event.tag) {
		case 'lifecycle.statusChanged':
			return {
				pluginKey: event.pluginKey,
				delta: { status: event.to },
			};
		case 'lifecycle.phaseSet':
			return {
				pluginKey: event.pluginKey,
				delta: { phase: event.phase },
			};
		default:
			// `restart.requested` ALSO updates cycle.phase + clears
			// other rows' highlights — that's a multi-row reducer
			// concern the projection handles directly. We deliberately
			// keep the bridge scoped to the closed `LifecycleFact`
			// shape (status / phase / selectiveRestartHighlight) so
			// callers can derive per-plugin facts without rebuilding
			// the cycle phase too.
			return null;
	}
};

/** Apply a fact delta to a row. Pure. Fields not in the delta are
 *  preserved verbatim — the merge-not-replace shape `LifecycleFact`
 *  promises. */
export const applyLifecycleFact = (row: Row, delta: LifecycleFactDelta): Row => ({
	...row,
	...(delta.status !== undefined ? { status: delta.status } : {}),
	...(delta.phase !== undefined ? { phase: delta.phase } : {}),
	...(delta.selectiveRestartHighlight !== undefined
		? { selectiveRestartHighlight: delta.selectiveRestartHighlight }
		: {}),
});

/** Reconstruct the closed `LifecycleFact` shape from a `Row`. Used by
 *  diagnostic surfaces that want the typed fact instead of the wider
 *  display Row. */
export const factFromRow = (row: Row): LifecycleFact => ({
	status: row.status,
	phase: row.phase,
	selectiveRestartHighlight: row.selectiveRestartHighlight,
});
