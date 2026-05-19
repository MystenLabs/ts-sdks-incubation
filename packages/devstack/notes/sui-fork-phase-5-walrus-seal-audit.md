# sui-fork Phase 5 — walrus & seal on-fork audit

## Status (2026-05-19)

Audit is the authoritative source for Subtopic 1 + Subtopic 2 deferral. No state change since
initial publication — both primitives stay upstream-blocked. Re-open when the unblock criteria in
§4 fire.

**Status:** Audit (2026-05-19). Closes `sui-fork-phase-5.md` Subtopic 1 (P5.1) and Subtopic 2 (P5.3)
with a shared finding: both primitives are **upstream-blocked on the same JSON-RPC dependency**, so
the devstack-side implementation work (`SuiGraphQLShim` service factory, walrus rewire, seal-on-fork
test gate) is deferred until upstream walrus / seal complete their gRPC migrations.

The plan's Subtopic-1 framing — "stand a GraphQL shim in front of the fork and walrus will speak to
it" — does not survive contact with the upstream source. Walrus's chain client doesn't use GraphQL
at all; it uses JSON-RPC + gRPC. A GraphQL endpoint in front of the fork would not unblock walrus.

This document is the single source of truth for the "why these stay deferred" decision; the
per-primitive `ForkIncompatibleError` factory-time guards in `services/walrus/local-cluster.ts` and
`services/seal/internal.ts` point here in their comments.

---

## §1 What walrus needs from sui

The upstream walrus crate `walrus-sui` (vendored at
`examples/private-content/.devstack/git/walrus.move-source/<rev>/crates/walrus-sui/`) constructs a
`DualClient` from a single RPC URL:

```rust
// crates/walrus-sui/src/client/dual_client.rs:140-155
pub async fn new(rpc_url: impl AsRef<str>, …) -> Result<Self, SuiClientError> {
    let sui_client = Some(SuiClientBuilder::default().build(rpc_url).await?);
    let grpc_client = GrpcClient::new(rpc_url).context("unable to create grpc client")?;
    Ok(Self { sui_client, grpc_client })
}
```

The module's own preamble (lines 1-7) flags the intent:

> Client to access Sui via both JSON RPC and gRPC. This module is intended to facilitate a migration
> from Sui JSON RPC to gRPC by **gradually migrating callsites away from the JSON RPC Client
> `SuiClient`**.

The migration is in-flight, not complete. As of the pinned walrus ref (`devnet-v1.48.0`),
`walrus-sui/src/client/retry_client/retriable_sui_client.rs` still has **12+ load-bearing JSON-RPC
call sites** on `SuiClient.read_api()` / `coin_read_api()`:

| Path                                                   | Use case                                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `read_api().get_object_with_options(…)`                | system/staking object reads, package reads, blob-object reads                  |
| `read_api().get_transaction_with_options(…)`           | finalization confirmation + event extraction (see line 2110-2111)              |
| `read_api().multi_get_objects(…)`                      | committee-storage-node batch lookups                                           |
| `coin_read_api().select_coins(…)`                      | gas-coin selection during deploy + register flow (lines 712, 832)              |
| `read_api().get_owned_objects(…)`                      | per-account object enumeration (e.g. WAL coin lookup post-seed)                |
| `event_api().query_events(…)` (via `read_api` adapter) | `BlobEvent` polling on storage-node bootstrap (the `get_blob_event(...)` path) |

There is **no GraphQL** in walrus's chain-client surface at this ref:

```
$ grep -rln "graphql\|GraphQL" .../walrus.move-source/.../crates/
# (only doc/notebook files; no source files use GraphQL)
```

The `walrus-deploy` one-shot inside the wrapper image (`packages/devstack/walrus-image/Dockerfile`)
and every storage-node binary inherit `DualClient`, so the JSON-RPC surface is required from the
first container boot.

**Conclusion:** A GraphQL endpoint in front of the fork does not unblock `walrusLocalCluster`. The
only unblock paths are:

1. **Wait for upstream walrus to complete the gRPC migration**
   (`DualClient.sui_client: Option<SuiClient>` → `None`), then bump `DEFAULT_WALRUS_REF` past that
   release. Tracked upstream in the walrus `WALRUS_GRPC_MIGRATION_LEVEL` env var (see walrus
   `CLAUDE.md` § "Simulation Tests (msim)" — `MSIM_TEST_SEED=1` runs the migration tests at level
   `0` and `100`).
2. **Stand up a JSON-RPC shim in front of the fork.** This was not the plan's original framing and
   is materially harder than a GraphQL shim: walrus exercises the `read_api()` + `event_api()` +
   `coin_read_api()` surface broadly, including paginated `multi_get_objects` and event-stream
   subscriptions. Re-implementing JSON-RPC over the fork's gRPC store would be a ~2-3 week project
   of its own and would carry an ongoing maintenance tax as walrus bumps its `SuiClient` dependency.

Option 1 is the only one that scales. Option 2 is not justified by Phase 5's scope.

## §2 What seal needs from sui

The vendored seal source at
`examples/private-content/.devstack/git/seal.source/<rev>/crates/key-server/src/` constructs a
`SuiRpcClient` with **both** an `sui_sdk::SuiClient` and a `sui_rpc::client::Client` (gRPC):

```rust
// crates/key-server/src/server.rs:205-217
async fn new(mut options: KeyServerOptions, …) -> Self {
    let sui_rpc_client = SuiRpcClient::new(
        SuiClientBuilder::default()
            .request_timeout(options.rpc_config.timeout)
            .build(&options.node_url())   // ← JSON-RPC
            .await
            .expect("…"),
        SuiGrpcClient::new(options.node_url()).expect("…"),  // ← gRPC
        options.rpc_config.retry_config.clone(),
        metrics,
    );
    …
}
```

The two are NOT redundant — they serve different code paths:

| Method on `SuiRpcClient`        | Transport    | Hot path?                       | Notes                                                                              |
| ------------------------------- | ------------ | ------------------------------- | ---------------------------------------------------------------------------------- |
| `get_object<T>(…)`              | **gRPC**     | yes (every `/v1/fetch_key`)     | Reads `KeyServer`, package, `seal_package`, and policy objects. Migrated to gRPC.  |
| `get_reference_gas_price()`     | **gRPC**     | yes (every `/v1/fetch_key`)     | Per-request gas budget input to dry-run. Migrated.                                 |
| `dry_run_transaction_block(tx)` | **JSON-RPC** | **yes (every `/v1/fetch_key`)** | `check_policy` runs the `seal_approve*` Move call as a dry-run to evaluate access. |

The dry-run path is non-negotiable for seal: every key-fetch is gated on a PTB dry-run that
evaluates the caller-supplied `seal_approve*` predicate. The upstream `sui-sdk` crate's
`read_api().dry_run_transaction_block(…)` has no gRPC equivalent today (`sui-rpc` exposes
`simulate_transaction` but it returns the gas profile only, not the side-effect trace seal's policy
evaluator needs).

**Sub-blocker — `dry_run_transaction_block` on the fork itself.** Even with a JSON-RPC adapter in
front of the fork, the fork's `simulate_transaction` RPC returns `"unsupported"` per R3 in
`sui-fork-integration.md` line 124 (`crates/sui-fork/src/rpc/executor.rs:143-147`). A working
dry-run requires either:

- An upstream rust-side fork patch implementing `simulate_transaction` (out of scope for devstack),
  or
- The seal key-server switching `check_policy` to the gRPC `simulate_transaction` surface — which
  has the same return-shape problem (no side-effect trace).

Both require upstream Mysten work. The seal team's own `seal-cli` audit at
`crates/key-server/src/sui_rpc_client.rs:9-10` confirms the migration is in-flight:

```rust
use sui_rpc::client::Client as SuiGrpcClient;
…
use sui_sdk::{error::SuiRpcResult, rpc_types::DryRunTransactionBlockResponse, SuiClient};
```

— two transports coexist exactly because the dry-run path hasn't moved.

**Conclusion:** seal-on-fork is **upstream-blocked**, same root cause as walrus-on-fork. The
criterion for unblock (per `sui-fork-phase-5.md` §11 decision point 3) is: when seal's
`check_policy` is migrated to a gRPC-equivalent transport AND the fork implements that gRPC method,
we can revisit. Until then, fork-mode users must compose `sealKnownKeyServer({network})` and accept
that the policy evaluator runs against the upstream chain rather than the fork's mutated state — the
same trade-off the `ForkIncompatibleError` guard in `services/seal/internal.ts:251-262` already
enforces with an actionable hint.

## §3 Deferred work

### Walrus (P5.1.1–5, P5.T1a/b)

- [ ] **P5.1.1** — Identify upstream `sui-indexer-alt-graphql` image source. _Audited 2026-05-19:_
      image lives at `MystenLabs/sui/docker/sui-indexer-alt-graphql/Dockerfile`, builds from the
      main `sui` workspace (not `sui-fork`). Requires a populated postgres database written to by
      `sui-indexer-alt` (a separate binary that streams checkpoints from a fullnode). The fork's
      checkpoint stream format has not been validated against `sui-indexer-alt`'s consumer
      expectations, and even if it works, the resulting GraphQL endpoint does not solve the walrus
      blocker (walrus needs JSON-RPC, not GraphQL). **Deferred — wrong tool for the job.**
- [ ] **P5.1.2** — `SuiGraphQLShim` service factory. **Deferred — see above.**
- [ ] **P5.1.3** — Wire walrus's chain-client config to the shim. **Deferred.**
- [ ] **P5.1.4** — Allow `walrusLocalCluster` in fork mode in `resolveDeploymentNetwork`.
      **Deferred** (the factory-time guard in `services/walrus/local-cluster.ts:96-108` remains).
- [ ] **P5.1.5** — Snapshot meta extension for shim container ID + endpoint URL. **Deferred.**
- [ ] **P5.T1a** — Docker-gated e2e (fork-greeting + walrus local cluster, blob round-trip).
      **Deferred.**
- [ ] **P5.T1b** — Snapshot round-trip with shim present. **Deferred.**

### Seal (P5.3.1–2, P5.4.x)

- [x] **P5.3.1** — Audit seal key-server source for chain-client construction. _Done 2026-05-19:_
      `SuiRpcClient::new` constructs both `SuiClient` (JSON-RPC) and `SuiGrpcClient` (gRPC) from
      `options.node_url()`. The JSON-RPC path is non-negotiable for
      `check_policy.dry_run_transaction_block`. See §2.
- [x] **P5.3.2** — Document findings. _This document._
- [ ] **P5.4.1** — Allow `sealLocalKeygen` in fork mode. **Deferred — upstream-blocked.** The
      factory-time guard in `services/seal/internal.ts:251-262` remains authoritative; users are
      routed to `sealKnownKeyServer({network})` with an actionable hint.
- [ ] **P5.4.2** — Fork-mode integration test variant. **Deferred.**
- [ ] **P5.4.x** — `SealForkBlocked` typed error. **Deferred —
      `ForkIncompatibleError({variant: 'sealLocalKeygen'})` already serves this role.** A bespoke
      `SealForkBlocked` would duplicate the existing typed-error contract without adding signal. The
      existing error already carries `variant`, `network`, `message`, and `hint`; adding a second
      tagged class for the same condition would force every consumer's `Effect.catchTag` to
      enumerate both.

## §4 Unblock criteria

A future Phase 5.x revisit of either subtopic should check the following before re-opening
implementation work:

### Walrus unblock criterion

The pinned walrus ref's `DualClient::sui_client` field is gated to `None` by default (i.e.
`WALRUS_GRPC_MIGRATION_LEVEL=100` is the default, not opt-in), AND
`crates/walrus-sui/src/client/retry_client/retriable_sui_client.rs` no longer has any `read_api()` /
`coin_read_api()` / `event_api()` callsites in the storage-node or `walrus-deploy` execution paths.
Track upstream via walrus's `CHANGELOG.md` and the workspace migration-level flag.

### Seal unblock criterion

`crates/key-server/src/sui_rpc_client.rs::SuiRpcClient::dry_run_transaction_block` moves off
`sui_sdk::SuiClient` to a gRPC-equivalent (either `sui-rpc`'s `simulate_transaction` returning the
necessary side-effect trace, or a new upstream gRPC method seal proposes), AND `sui-fork` implements
that gRPC method (today its `simulate_transaction` returns `"unsupported"` per R3).

## §5 Resume plan when unblocked

When upstream lifts the block, the implementation footprint is small and file-disjoint (the
audit-time investigation already mapped the seams):

- **walrus:** remove the factory-time `ForkIncompatibleError` in
  `services/walrus/local-cluster.ts:96-108`. Allow `walrusLocalCluster` in fork mode via
  `resolveDeploymentNetwork`. Verify the `walrus-deploy` one-shot can dial the fork's gRPC port (the
  per-stack docker network + `sui-fork`'s `sui-fork` alias should "just work" without further
  wiring, since walrus-side code now consumes gRPC URLs directly).
- **seal:** remove the factory-time `ForkIncompatibleError` in `services/seal/internal.ts:251-262`.
  Update the key-server config-render in `renderSealKeyServerConfig` so `network: !Devnet` and
  `node_url` point at the fork's gRPC URL.
- **tests:** P5.T1a / P5.4.2 docker-gated e2e tests under `examples/fork-greeting/` (Wave 4 §6.3 of
  `post-launch-sweep.md` would already have shipped the harness by then).

No engine-side or supervisor-side changes are anticipated. The two `*.ts` files plus their
`*.fork-*-refused.test.ts` siblings are the entire devstack-side surface.

---

## §6 Cross-references

- Factory-time guards (audit-documented):
  - `packages/devstack/src/services/walrus/local-cluster.ts:96-108` (`walrusLocalCluster` refuses
    fork mode)
  - `packages/devstack/src/services/seal/internal.ts:251-262` (`sealLocalKeygen` refuses fork mode)
- Test gates that lock in the refusal (run on every CI):
  - `packages/devstack/src/services/walrus.fork-localcluster-refused.test.ts`
  - `packages/devstack/src/services/seal.fork-localkeygen-refused.test.ts`
- Parent plan: `packages/devstack/notes/sui-fork-phase-5.md` §3 (Subtopic 1) + §4 (Subtopic 2).
- Upstream gRPC migration tracking: `notes/sui-fork-integration.md` D4 + D5 (devstack-side gRPC-only
  policy + plugin strategy under fork mode).
