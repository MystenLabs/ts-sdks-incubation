---
'@mysten-incubation/devstack': patch
---

Local-mode Sui now bases on the upstream `mysten/sui-tools` image (pinned to the build carrying the embedded-fullnode resume fix, sui #26884), so both the validator and the embedded fullnode resume from their persisted dbs across `docker stop`/`start` — there is no per-boot genesis re-sync.

GraphQL and its indexer run against a sui-owned Postgres sidecar that is ON BY DEFAULT for a bare `sui()`: the sidecar auto-creates its `sui_indexer` DB, so the full GraphQL surface boots with no cross-plugin wiring. `indexer: false` opts out (RPC + faucet only, no sidecar); `indexerDb: { url, network, database? }` points GraphQL at a Postgres you already run instead.
