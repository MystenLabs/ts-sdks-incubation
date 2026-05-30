// Dashboard GraphQL schema (Pothos, code-first) — assembly entry.
//
// One typed schema covers the control plane:
//   - queries:       `state` (full projection snapshot, real object types),
//                    relay node/connection access, and a `ping` probe.
//   - mutations:     map to `EngineCommand`s (restart, snapshot, apply, …),
//                    each returning a typed `CommandResult`.
//   - subscriptions: `state` streams projection changes over SSE (yoga).
//
// The schema is defined at module level across `./schema/{builder,enums,
// types,root}.ts`; importing those modules registers their enums/types/root
// fields on the shared `builder`. The package is marked `sideEffects: true`, so
// these registration imports are preserved through the bundler. Per-request
// dependencies (the `state` ref + `publishCommand`) flow through the GraphQL
// context (`DashboardContext`).

import { builder } from './schema/builder.ts';
import './schema/enums.ts';
import './schema/types.ts';
import './schema/root.ts';

export type { DashboardContext } from './schema/builder.ts';

/** The dashboard control-plane GraphQL schema. */
export const dashboardSchema = builder.toSchema();
