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

**Fix shape (deferred — no upstream fix in flight)**:
`MystenLabs/walrus@main` HEAD (5/01) has no axum/TLS/panic-related
commits in the last ~100; the v1.49.0 bump is just a version
string. Speculative `WALRUS_REV` bump would risk a 10-minute
rebuild for no fix. Re-evaluate on next walrus release tag, or
report upstream with the `JoinError::Cancelled(Id(349))` stack
trace + this localnet repro:

  cd examples/private-content && pnpm devstack apply
  docker logs private-content-main-walrus-node-0 | grep tls_rustls

Workaround: the only consumer is `private-content`'s blob-upload
e2e. Other walrus-using flows (read-only, KeyServer registration,
deploy outputs) work fine.

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
