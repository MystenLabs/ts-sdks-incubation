// Dashboard Pothos `SchemaBuilder` — the single module-level instance.
//
// One typed schema covers the control plane: the live projection (`state`),
// relay node/connection access over the snapshot arrays, control mutations,
// and the projection subscription. The builder is parameterized with the
// relay, simple-objects, and with-input plugins (Pothos v4 defaults).
//
// Dependencies (the `state` ref + a `publishCommand`) are supplied per
// request through the GraphQL context (`DashboardContext`), so the schema is
// a single module-level value with no per-instance closure state. Resolvers
// read deps from the 3rd resolver argument.

import SchemaBuilder from '@pothos/core';
import RelayPlugin from '@pothos/plugin-relay';
import SimpleObjectsPlugin from '@pothos/plugin-simple-objects';
import WithInputPlugin from '@pothos/plugin-with-input';
import type { Effect, SubscriptionRef } from 'effect';
import type { EngineCommand } from '../../../substrate/events.ts';
import type { SubscribableState } from '../../../substrate/projection.ts';
import type { ControlPlaneDomain } from '../../../substrate/runtime/control-plane/service.ts';

/** Per-request GraphQL context for the dashboard control plane. Resolvers
 *  read the live projection ref, the command publisher, and the
 *  plugin-domain accessor surface from here (3rd resolver arg), so the
 *  schema carries no closed-over state. */
export interface DashboardContext {
	readonly state: SubscriptionRef.SubscriptionRef<SubscribableState>;
	readonly publishCommand: (command: EngineCommand) => Effect.Effect<void>;
	/** Typed accessors for data the browser cannot reach directly:
	 *  snapshot catalog + restore/delete, postgres wire-protocol stats,
	 *  deepbook/seal/coin capability ids, fork-vs-local mode. */
	readonly domain: ControlPlaneDomain;
}

interface SchemaTypes {
	Context: DashboardContext;
	// Output fields are non-nullable unless a resolver opts in with
	// `nullable: true` — the projection always resolves a concrete value.
	DefaultFieldNullability: false;
}

/** The single module-level builder. Object types, enums, and root types are
 *  defined against this instance across the sibling `schema/*` modules; the
 *  built schema is `dashboardSchema` (see `../schema.ts`). */
export const builder = new SchemaBuilder<SchemaTypes>({
	plugins: [SimpleObjectsPlugin, RelayPlugin, WithInputPlugin],
	relay: {},
	defaultFieldNullability: false,
});
