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
// The `domain` surface widens the control plane with everything the
// browser genuinely cannot reach: codegen-capability ids (deepbook/seal/
// coin), in-process plugin state (deepbook market-maker), the snapshot
// catalog + restore/delete (which never round-trip through the void
// `publishCommand`), and Postgres wire-protocol stats. The projection
// (`SubscribableState`) stays CLOSED — none of this leaks into it. Each
// accessor is a self-contained `Effect` the supervisor populates from the
// resolved registry / snapshot orchestrator / container runtime it holds
// at wiring time. App-agnostic plain data shapes keep the dashboard schema
// from importing plugin internals.

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
// These intentionally duplicate the relevant fields of each plugin's
// resolved value (rather than re-export plugin types) so the control-plane
// surface and the dashboard schema stay decoupled from plugin internals.
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

/** One DeepBook deployment the stack resolved (registry/admin/pool ids +
 *  in-process market-maker state). Pool prices / order books are
 *  chain-direct and intentionally absent. */
export interface ControlPlaneDeepbookPool {
	readonly name: string;
	readonly poolId: string;
	readonly baseCoinType: string;
	readonly quoteCoinType: string;
}

export interface ControlPlaneDeepbookInfo {
	readonly pluginKey: string;
	readonly name: string;
	readonly mode: 'local' | 'override' | 'known';
	readonly chain: string;
	readonly packageId: string;
	readonly registryId: string;
	readonly adminCapId: string | null;
	readonly deepTreasuryId: string | null;
	readonly pools: ReadonlyArray<ControlPlaneDeepbookPool>;
	readonly marketMakerRunning: boolean;
	readonly serverUrl: string | null;
	readonly indexerUrl: string | null;
}

/** Seal key-server deployment ids + threshold/mode. The HTTP health probe
 *  is browser-direct, so it is NOT exposed here. */
export interface ControlPlaneSealKeyServer {
	readonly objectId: string;
	readonly weight: number;
}

export interface ControlPlaneSealInfo {
	readonly pluginKey: string;
	readonly mode: 'local-keygen' | 'live' | 'fork-known';
	readonly objectId: string;
	readonly keyServerUrl: string;
	readonly keyServers: ReadonlyArray<ControlPlaneSealKeyServer>;
	/** Threshold = number of registered key-server configs. */
	readonly threshold: number;
}

/** A coin's treasury-cap id (drives the Mint action) + addressing facts. */
export interface ControlPlaneCoinCap {
	readonly pluginKey: string;
	readonly symbol: string | null;
	readonly fullCoinType: string;
	readonly decimals: number;
	readonly source: 'registry' | 'on-chain' | 'builtin';
	readonly treasuryCapId: string | null;
	readonly packageId: string | null;
}

/** Postgres stats reachable only over the PG wire protocol (the browser
 *  cannot speak it). Gathered by exec'ing `psql` inside the running
 *  container — no new client dependency. */
export interface ControlPlanePostgresTable {
	readonly schema: string;
	readonly name: string;
	readonly rowEstimate: number;
	readonly totalBytes: number;
}

export interface ControlPlanePostgresStats {
	readonly pluginKey: string;
	readonly database: string;
	/** Plain (password-less) DSN — the credentialed form NEVER leaves the
	 *  backend. */
	readonly plainUrl: string;
	readonly databaseBytes: number;
	readonly connectionCount: number;
	readonly tables: ReadonlyArray<ControlPlanePostgresTable>;
	/** `null` when stats could not be gathered (container down, exec
	 *  failure). The dashboard renders a degraded state rather than
	 *  failing the whole query. */
	readonly available: boolean;
	readonly detail: string | null;
}

/** The plugin-domain accessor surface. Each member is a self-contained
 *  Effect the supervisor wires from the data it holds at boot. The
 *  Effects never fail (`E = never`); they degrade to empty/`null` so a
 *  single missing plugin can't take down the dashboard query. */
export interface ControlPlaneDomain {
	/** Fork-vs-local mode, derived from the resolved sui plugin's chain
	 *  identity. Used for advance-clock gating. `null` when no sui plugin
	 *  is present. */
	readonly mode: Effect.Effect<'fork' | 'local' | 'live' | null>;
	/** Snapshot catalog (id/label/created/participants/containers). */
	readonly snapshots: Effect.Effect<ReadonlyArray<ControlPlaneSnapshotEntry>>;
	/** Restore a snapshot by id. Mirrors the orchestrator surface so the
	 *  dashboard gets a real result the void `publishCommand` can't carry. */
	readonly restoreSnapshot: (id: string) => Effect.Effect<{ readonly ok: boolean; readonly detail: string | null }>;
	/** Delete a snapshot by id. */
	readonly deleteSnapshot: (id: string) => Effect.Effect<{ readonly ok: boolean; readonly detail: string | null }>;
	/** DeepBook deployments (registry/admin/pool ids + MM state). */
	readonly deepbook: Effect.Effect<ReadonlyArray<ControlPlaneDeepbookInfo>>;
	/** Seal key-server deployments (objectId/threshold/mode). */
	readonly seal: Effect.Effect<ReadonlyArray<ControlPlaneSealInfo>>;
	/** Coin treasury caps (drives Mint). */
	readonly coinCaps: Effect.Effect<ReadonlyArray<ControlPlaneCoinCap>>;
	/** Postgres wire-protocol stats per postgres plugin instance. */
	readonly postgresStats: Effect.Effect<ReadonlyArray<ControlPlanePostgresStats>>;
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
	/** Typed plugin-domain accessors for the data the browser cannot
	 *  reach directly. See `ControlPlaneDomain`. */
	readonly domain: ControlPlaneDomain;
}

export class ControlPlaneService extends Context.Service<ControlPlaneService, ControlPlane>()(
	'@devstack/substrate/ControlPlane',
) {}
