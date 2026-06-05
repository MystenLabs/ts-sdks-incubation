# Devstack Simplification — Step 5 Follow-ups

Branch: `mh/devstack-cleanup`.

## Status

- `[x]` Public Postgres plugin removed. Sui keeps an internal indexer database sidecar under
  `src/plugins/internal/postgres-sidecar/`.
- `[x]` Dashboard Postgres panel and GraphQL field removed.
- `[x]` `examples/fork-greeting` promoted to runnable examples.
- `[x]` Fork mode docs now cover checkpoint, seed, auto-tick, and `ForkAdminSurface`.
- `[x]` Warm invalidation redesign: warm baseline validity now uses a resolved graph key, while
  `CacheService`, Docker image builds, and container recreation record runtime invalidations that
  force recapture after a restored boot when state actually changed.

## Verification Gates

- Focused devstack unit tests for sidecar, Sui indexer, dashboard domain/schema, docs parity, and
  router entrypoints.
- Dashboard schema print plus `gql.tada` type generation.
- Docs validation.
- `pnpm --filter @mysten-incubation/devstack typecheck`
- Focused warm/cache/Docker/CLI boot Vitest slice.
- Targeted Docker e2e: Sui indexer sidecar reset/reverify and warm-cache restore/recapture.
- `pnpm --filter @mysten-incubation/devstack test`
- `pnpm --filter @mysten-incubation/devstack build`
- Full e2e matrix before PR.
