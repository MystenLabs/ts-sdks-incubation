# Friction journal

Per `CLAUDE.md`: when something hurts (hardcoded port, copy-paste,
manual step, brittle interaction), capture it here as a one-line
entry + file path. Phase 2+ extracts patterns from the journal —
don't silently work around the pain, the pain is the data.

Entries are roughly chronological. New entries at the bottom.

## Open

### Walrus 1.48.0 storage nodes panic on TLS startup

Walrus-node 1.48.0 starts cleanly, opens RocksDB, binds REST API on
`10.<octet>.0.10:9185`, then panics in `axum-server-0.8.0/src/
tls_rustls/mod.rs:204:14` (`JoinError::Cancelled`). Pre-existing
upstream issue; only `private-content` end-to-end blob upload is
affected (Seal works without walrus storage nodes; the upload path
needs them). Other walrus-using flows are blocked.

**Fix shape**: bump `WALRUS_REV` in `plugins/walrus/build.ts:32`
to a rev past the axum-server 0.8.0 dep. `WRAPPER_REV` r3 → r4 to
invalidate the local image cache. Tracked as PR 37 in
`round-3-plan.md`.

## Closed (chronological, one line each)

| Entry | Closed by |
| ----- | --------- |
| Hardcoded ports across plugin instantiations | PR 8 (per-stack port allocator) |
| wallet-server manifest race on cold-first-run | PR 9 (Register/Serve split) |
| Faucet 500 on cold-first-bring-up | `keys.ts:64` retry-with-backoff |
| Playwright `defineDevstackPlaywrightConfig` baseURL hardcoded | PR 16 (extend.webServer/use shallow merge) |
| Reconciler runs same-signer transactions in parallel | PR 17 (`runsAs` soft constraint) |
| Walrus subnet hardcoded at `10.0.0.0/24` blocks per-stack siblings | PR 23 (per-(app, stack) octet + sed-patch deploy script) |
| Same-account signer used by both supervisor + browser path equivocates | PR 31 (interim `mm` workaround) → PR 33+34+35 (address-balance funding; SDK auto-picks `payment: []` AB-mode) |
