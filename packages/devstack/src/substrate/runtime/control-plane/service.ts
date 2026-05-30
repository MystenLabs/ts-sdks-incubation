// Control-plane seam exposed to in-process surfaces (the dashboard plugin).
//
// Plugins don't normally receive the supervisor's projection ref, event
// hub, or command channel — those live in `SupervisorState`. This service
// hands an in-process surface (the dashboard) a read view of the live
// projection plus a fire-and-forget command publisher, so it can render
// state and issue controls without reaching into supervisor internals.
//
// The projection ref is process-scoped and survives engine cycles, so a
// subscriber stays valid across `stack.restart` (only `cycle.id` bumps).
// Command dispatch mirrors the queue publisher the TUI uses: offer onto
// the supervisor's command queue and observe the effect via `state`.
//
// The `domain` surface is GENERIC and name-blind: it exposes the snapshot
// catalog + restore/delete (which never round-trip through the void
// `publishCommand`), the cross-service observability rings, and a single
// generic `resolvedValues` accessor that hands out resolved plugin VALUES
// WITHOUT interpreting them. Plugin-name-aware shaping (deepbook/seal/coin/
// postgres/mode/mint) lives ABOVE the substrate in the dashboard plugin,
// which is allowed to name plugins. The projection (`SubscribableState`)
// stays CLOSED — none of this leaks into it. Each accessor is a
// self-contained `Effect` the supervisor populates from the resolved
// registry / snapshot orchestrator it holds at wiring time.

import { Context, type Effect, type SubscriptionRef } from 'effect';
import type { EngineCommand } from '../../events.ts';
import type { SubscribableState } from '../../projection.ts';
import type {
	LogFilter,
	LogRecord,
	SpanFilter,
	SpanRecord,
} from '../observability/index.ts';

// -----------------------------------------------------------------------------
// Domain data shapes — app-agnostic projections of plugin-resolved values.
// These intentionally stay generic so the control-plane surface and the
// dashboard schema stay decoupled from plugin internals.
// -----------------------------------------------------------------------------

/** One catalog entry the snapshot orchestrator's `list` produced. */
export interface ControlPlaneSnapshotEntry {
	readonly id: string;
	readonly label: string | null;
	readonly createdAt: number | null;
	readonly app: string | null;
	readonly stack: string | null;
	readonly network: string | null;
	readonly participants: ReadonlyArray<string>;
	readonly containerCount: number;
	readonly subtreeCount: number;
	/** `true` when the metadata file was absent/corrupt (do-not-trust). */
	readonly corrupt: boolean;
}

/** One resolved plugin value, handed out GENERICALLY (uninterpreted) so an
 *  in-process surface above the substrate (the dashboard plugin) can match
 *  + shape it by resource-id prefix itself. `id` is the resource id the
 *  plugin factory minted (an opaque string here — the substrate never
 *  pattern-matches it); `pluginKey` is the registry key for the node. The
 *  substrate imports NO plugin types — `value` is genuinely `unknown`. */
export interface ControlPlaneResolvedValue {
	/** The registry key for the resolved node. */
	readonly pluginKey: string;
	/** The resource id the plugin factory minted (opaque to the substrate). */
	readonly id: string;
	/** The resolved plugin value, uninterpreted. */
	readonly value: unknown;
}

/** The plugin-domain accessor surface. GENERIC + name-blind: it exposes
 *  the snapshot catalog, the observability rings, and a single generic
 *  `resolvedValues` accessor. Each member is a self-contained Effect the
 *  supervisor wires from the data it holds at boot. The Effects never fail
 *  (`E = never`); they degrade to empty/`null` so a single missing plugin
 *  can't take down the dashboard query. */
export interface ControlPlaneDomain {
	/** Snapshot catalog (id/label/created/participants/containers). */
	readonly snapshots: Effect.Effect<ReadonlyArray<ControlPlaneSnapshotEntry>>;
	/** Restore a snapshot by id. Mirrors the orchestrator surface so the
	 *  dashboard gets a real result the void `publishCommand` can't carry. */
	readonly restoreSnapshot: (id: string) => Effect.Effect<{ readonly ok: boolean; readonly detail: string | null }>;
	/** Delete a snapshot by id. */
	readonly deleteSnapshot: (id: string) => Effect.Effect<{ readonly ok: boolean; readonly detail: string | null }>;
	/** ALL resolved plugin values, in graph order, handed out
	 *  uninterpreted. The seam an in-process surface above the substrate
	 *  (the dashboard plugin) uses to find + shape plugin-domain values
	 *  itself — the substrate stays name-blind. */
	readonly resolvedValues: Effect.Effect<ReadonlyArray<ControlPlaneResolvedValue>>;
	/** Cross-service queryable log history (the dashboard Console "Logs"
	 *  tab). Filterable by service / level / substring / time window; the
	 *  per-row projection tail is a separate, row-scoped surface. Degrades
	 *  to empty when no log store is wired. */
	readonly logs: (filter?: LogFilter) => Effect.Effect<ReadonlyArray<LogRecord>>;
	/** Distinct services currently present in the log ring (filter UI). */
	readonly logServices: Effect.Effect<ReadonlyArray<string>>;
	/** Completed-span ring (the dashboard Console "Traces" tab). Filterable
	 *  by service / status / substring / time window. Degrades to empty when
	 *  no span store is wired. */
	readonly spans: (filter?: SpanFilter) => Effect.Effect<ReadonlyArray<SpanRecord>>;
	/** Distinct services currently present in the span ring (filter UI). */
	readonly spanServices: Effect.Effect<ReadonlyArray<string>>;
}

export interface ControlPlane {
	/** Live projection ref. Read a snapshot with `SubscriptionRef.get`,
	 *  subscribe to updates with `SubscriptionRef.changes`. */
	readonly state: SubscriptionRef.SubscriptionRef<SubscribableState>;
	/** Publish a command to the supervisor (fire-and-forget). Observe the
	 *  resulting effect via the projection `state`. */
	readonly publishCommand: (command: EngineCommand) => Effect.Effect<void>;
	/** Generic, name-blind plugin-domain accessors (snapshot catalog,
	 *  observability rings, resolved plugin values). See
	 *  `ControlPlaneDomain`. */
	readonly domain: ControlPlaneDomain;
}

export class ControlPlaneService extends Context.Service<ControlPlaneService, ControlPlane>()(
	'@devstack/substrate/ControlPlane',
) {}
