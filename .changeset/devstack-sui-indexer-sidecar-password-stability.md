---
'@mysten-incubation/devstack': patch
---

Fix the sui-owned GraphQL-indexer Postgres sidecar failing auth (`FATAL: password authentication failed for user "devstack"`) on a reused/restored data dir, which crash-looped the validator's embedded indexer and broke every e2e that boots a bare `sui()` (snapshot-restore matrix + the deepbook/token-studio/warm-cache/action-cache/indexer-reverify boots).

The sidecar password derived from `(app, stack, stackRoot)`, but its PGDATA rides the owner's snapshot and its committed layer is aliased onto the content-addressed `devstack-build:*` build tag, which a later boot reuses. The password baked into PGDATA at first init is never re-applied on reuse/restore, so a `stackRoot`-folded credential (which churns whenever the runtime root changes — every e2e boot mints a fresh tmpdir root) stopped matching the persisted data dir. Sidecar passwords now derive from `(app, stack, role)` only — invariant across runs of the same stack, matching how the snapshot/image persist — so reuse/restore is always credential-safe. User-declared `postgres()` is unchanged (it keeps the per-checkout `stackRoot` isolation; it has no sidecar's shared-image collapse).
