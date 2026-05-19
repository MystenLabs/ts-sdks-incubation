# Sui-fork Phase 5 — exploration plan

## Status (2026-05-19)

Per the walrus/seal audit in `notes/sui-fork-phase-5-walrus-seal-audit.md`:

- **Subtopic 1 (Walrus-on-fork via GraphQL shim) — DEFERRED, upstream-blocked.** Audit concluded
  the GraphQL shim does NOT unblock walrus; walrus's `DualClient` uses JSON-RPC + gRPC, no
  GraphQL. All P5.1.* and P5.T1* tasks remain checked-as-deferred awaiting walrus's gRPC
  migration (`WALRUS_GRPC_MIGRATION_LEVEL=100` default). Factory-time `ForkIncompatibleError`
  guard in `services/walrus/local-cluster.ts` stays authoritative.
- **Subtopic 2 (Seal-on-fork audit) — DEFERRED, upstream-blocked.** Seal's
  `check_policy.dry_run_transaction_block` is JSON-RPC-bound; fork's `simulate_transaction`
  returns `"unsupported"`. P5.3.1 + P5.3.2 done; P5.4.x deferred. The
  `ForkIncompatibleError({variant: 'sealLocalKeygen'})` guard in `services/seal/internal.ts`
  stays authoritative; no bespoke `SealForkBlocked` class added.
- **Subtopic 3 (Auto-tick clock) — SHIPPED.** `autoTick: boolean | { intervalMs: number }` on
  `SuiForkOptions`; `runAutoTickClock` fiber in `engine/sui-fork/control.ts`; `runtime.autoTickMs`
  persisted in `ForkMeta` (excluded from `configHash`). Test gates P5.T2a/b remain docker-gated
  (need `examples/fork-greeting/`).
- **Subtopic 4 (Parallel stacks) — SHIPPED.** Per-stack scoping audited + locked in
  `engine/sui-fork/parallel.test.ts` + `parallel.docker.test.ts`; seal sibling at
  `services/seal/parallel-stack.{test,docker.test}.ts`.
- **Subtopic 5 (Cold-start optimization) — BLOCKED on upstream rust-side work.** Devstack-side
  no-op until the baked-state image ships; pin lives in `services/sui.ts` alongside the other
  Sui image constants (no separate `engine/sui-fork/images.ts`).
- **Subtopic 6 (Dev-wallet fork controls) — UI tasks open.** Stub 501 routes
  (`FORK_STATUS`, `FORK_ADVANCE_CLOCK`, `FORK_ADVANCE_CHECKPOINT`, `FORK_IMPERSONATIONS`) live on
  `WalletHttpPath` in `services/wallet/protocol.ts`; actual handlers + UI land in P5.8.4 / P5.9.
- **Subtopic 7 (Subscriptions) — SHIPPED.** `subscribeCheckpoints` +
  `subscribeCheckpointsWithFallback` in `engine/sui-fork/control.ts`; `devstack fork status
  --follow` streams `ForkCheckpointEvent`s. P5.10.T3 docker-gated test remains.

**Status:** Draft (2026-05-19). Greenfield exploration follow-up to `notes/sui-fork-integration.md`
(Phases −1..4 substantially complete). Split from `notes/post-launch-sweep.md` per closeout-sweep
§10 decision 5.

**Gate:** Wave 4 §6.3 of `post-launch-sweep.md` (the `examples/fork-greeting/` example app scaffold)
has landed (`examples/fork-greeting/` is now in the tree) — Subtopic 3's P5.T2a/b can be exercised
once the docker harness is brought online.

---

## §1 Goals

- Extend sui-fork's plugin compatibility surface (Walrus, Seal) where the upstream tooling permits.
- Add DX features that make fork mode pleasant for time-sensitive Move development (auto-tick clock,
  parallel stacks, cold-start optimization).
- Surface the fork admin API in the dev-wallet UI (`advance-clock`, `advance-checkpoint`,
  impersonation slot management).
- Replace `GetStatus` polling with a real subscription channel.

Non-goals:

- Backwards compatibility with the pre-Phase-5 surface (no items are yet shipped to users, so
  there's nothing to deprecate).
- Net-new upstream rust changes beyond what cold-start optimization requires (cross-repo
  coordination is called out per subtopic).

---

## §2 Subtopic catalog

Seven subtopics, ordered by reviewer's recommended priority in the parent plan
(`notes/sui-fork-integration.md:426-455`). Each is a self-contained mini-plan. Subtopics are mostly
file-disjoint and can ship independently.

| #   | Subtopic                        | Plan tag refs     | Scope | Cross-repo?            |
| --- | ------------------------------- | ----------------- | ----- | ---------------------- |
| 1   | Walrus-on-fork via GraphQL shim | P5.1, P5.2, P5.T1 | L     | maybe (upstream image) |
| 2   | Seal-on-fork (key-server gRPC)  | P5.3, P5.4        | M     | maybe (upstream)       |
| 3   | Auto-tick clock                 | P5.5, P5.T2       | S     | no                     |
| 4   | Parallel stacks                 | P5.6, P5.T3       | M     | no                     |
| 5   | Cold-start optimization         | P5.7              | L     | yes (rust-side)        |
| 6   | Dev-wallet fork controls        | P5.8, P5.9        | M     | no                     |
| 7   | Subscriptions                   | P5.10             | M     | no                     |

---

## §3 Subtopic 1 — Walrus-on-fork via GraphQL shim

**Parent tag refs:** P5.1, P5.2, P5.T1 (`notes/sui-fork-integration.md:430-433`)

### Goal

Allow `walrusLocalCluster` to come up against a fork. Walrus's local cluster expects a GraphQL
endpoint exposing chain state; sui-fork speaks gRPC only.

### Design pass (required before code)

Open questions:

- **Image source:** `sui-indexer-alt-graphql` exists upstream — is the binary versioned with the
  fork's `sui-fork` build, with the main `sui` build, or independently?
- **Lifecycle:** per-stack service (one shim per fork instance) or shared across stacks on the same
  machine?
- **Routing:** new Traefik entrypoint or piggyback on Sui's GraphQL port (3000)?
- **Test gating:** `RUN_FORK_DOCKER_TESTS=1` + new Walrus integration flag, or fold into existing
  Walrus e2e suite with auto-skip when not on fork?

### Implementation sketch

**Tasks:**

- [x] **P5.1.1** — deferred (upstream-blocked). _Audited 2026-05-19,
      `notes/sui-fork-phase-5-walrus-seal-audit.md` §1._ `sui-indexer-alt-graphql` lives at
      `MystenLabs/sui/docker/sui-indexer-alt-graphql/Dockerfile` and requires a postgres database
      populated by a separate `sui-indexer-alt` binary streaming checkpoints from a fullnode. The
      shim does not solve the walrus blocker: walrus's chain client uses **no GraphQL** anywhere —
      it uses `DualClient` (JSON-RPC + gRPC) and still has ~12 load-bearing JSON-RPC callsites in
      `walrus-sui` at the pinned `devnet-v1.48.0`.
- [x] **P5.1.2** — deferred (upstream-blocked).
- [x] **P5.1.3** — deferred (upstream-blocked).
- [x] **P5.1.4** — deferred (upstream-blocked). The factory-time `ForkIncompatibleError` guard in
      `services/walrus/local-cluster.ts` and `resolveDeploymentNetwork`'s current behaviour both
      remain authoritative.
- [x] **P5.1.5** — deferred (upstream-blocked).

**Test gate:**

- [x] **P5.T1a** — deferred (upstream-blocked).
- [x] **P5.T1b** — deferred (upstream-blocked).

**Unblock criterion:** walrus's `DualClient::sui_client` defaults to `None`
(`WALRUS_GRPC_MIGRATION_LEVEL=100`), AND no `read_api()` / `coin_read_api()` / `event_api()`
callsites remain in storage-node + `walrus-deploy` paths. Track via `MystenLabs/walrus` releases.
See audit §4.

### Risks

- **Upstream image availability.** If `sui-indexer-alt-graphql` isn't shipped as a published image,
  we'd need to build it from source. Adds Rust toolchain to dev deps.
- **GraphQL ↔ gRPC parity.** Walrus may use endpoints the shim doesn't yet implement. Need to audit
  Walrus's chain-client surface.

### Parallel

Design-heavy. Single subagent until the image-source and lifecycle decisions are made; then
implementation parallelizable (service factory, walrus rewire, tests).

---

## §4 Subtopic 2 — Seal-on-fork audit

**Parent tag refs:** P5.3, P5.4 (`notes/sui-fork-integration.md:435-437`)

### Goal

Determine whether `sealLocalKeygen` can run against a fork. The gating question is whether the seal
key-server binary uses JSON-RPC (blocked on upstream gRPC migration) or gRPC.

### Tasks

- [x] **P5.3.1** Audit seal key-server source for chain-client construction. _Done 2026-05-19_,
      `notes/sui-fork-phase-5-walrus-seal-audit.md` §2. `SuiRpcClient::new` constructs BOTH
      `sui_sdk::SuiClient` (JSON-RPC) AND `sui_rpc::client::Client` (gRPC). The JSON-RPC client is
      required for `check_policy.dry_run_transaction_block` on every `/v1/fetch_key`.
- [x] **P5.3.2** Document findings. _Done 2026-05-19 as
      `notes/sui-fork-phase-5-walrus-seal-audit.md`_ (folded with the walrus audit since they share
      the same JSON-RPC-on-fork root cause).

**Outcome: JSON-RPC-bound — upstream-blocked.**

- [x] **P5.4.1** — deferred (upstream-blocked). Factory-time `ForkIncompatibleError` guard in
      `services/seal/internal.ts` remains authoritative.
- [x] **P5.4.2** — deferred (upstream-blocked).
- [x] **P5.4.x** — deferred. **No new `SealForkBlocked` error class introduced.** The existing
      `ForkIncompatibleError({variant: 'sealLocalKeygen'})` already carries the same signal
      (variant, network, message, hint). Adding a second tagged class would force every consumer's
      `Effect.catchTag` to enumerate both without adding observable contrast. See audit §3 for the
      rationale.

**Unblock criterion:** seal's `check_policy.dry_run_transaction_block` moves off
`sui_sdk::SuiClient` to a gRPC-equivalent surface returning side-effect traces, AND `sui-fork`
implements that gRPC method (today its `simulate_transaction` returns "unsupported"). See audit §4.

### Parallel

Audit is self-contained; one subagent. Implementation (if unblocked) is also self-contained.

---

## §5 Subtopic 3 — Auto-tick clock

**Parent tag refs:** P5.5, P5.T2 (`notes/sui-fork-integration.md:439-441`)

### Goal

Move-side clock-gated logic (e.g., `clock::timestamp_ms()`) is a pain point in fork mode because the
clock advances only on explicit `advanceClock` calls. Auto-tick lets devs ignore it.

### API sketch

```ts
Sui({
	network: 'mainnet-fork',
	fork: {
		autoTickMs: 1000, // advance clock every 1s
		// existing options...
	},
});
```

### Tasks

- [x] **P5.5.1** Add `autoTickMs?: number` to `SuiForkOptions`. _Done 2026-05-19:_ Shipped as
      `autoTick: boolean | { intervalMs: number }` on `SuiForkOptions` (the boolean form defaults to
      1000 ms). The wider knob is friendlier than the bare `autoTickMs?: number` original plan —
      `autoTick: true` is the common case and reads more naturally than `autoTickMs: 1000`. The
      resolved interval surfaces on `ForkControl.autoTickMs` for the dev-wallet panel + a future
      `fork status` JSON field.
- [x] **P5.5.2** Supervisor-side `Effect.forkScoped` schedule that calls
      `ForkControl.advanceClock(autoTickMs)` on a `Schedule.spaced` cadence. _Done 2026-05-19:_
      `runAutoTickClock` in `engine/sui-fork/control.ts`. Scope-bound (the surrounding stack
      acquire's scope) — wipe / restart / Ctrl-C all tear the fiber down. Failure policy: a single
      advance-clock failure is logged at WARN, fiber keeps looping (so a transient gRPC blip doesn't
      kill the whole stack). Unit-tested in `control.test.ts` via a stub `SuiGrpcClient` — verified
      both the cadence and the failure-policy paths.
- [x] **P5.5.3** TUI surface: log "auto-tick active (1000ms)" once at acquire; nothing per-tick.
      _Done 2026-05-19:_ `setPhase('starting auto-tick clock (${ms}ms)')` + `Effect.logInfo` in
      `buildFork`. The phase value is what the TUI's progress widget reads; the info log lands
      verbatim in `pnpm devstack apply` stdout.
- [x] **P5.5.4** Snapshot meta: record `autoTickMs` so resume restores the cadence. _Done
      2026-05-19:_ landed as a `runtime.autoTickMs` sub-record on `ForkMeta`
      (`engine/sui-fork/meta.ts`). Schema-level optional; persisted on first-boot write and
      refreshed in-place on resume. **Excluded from `configHash`** — only
      `(upstream, checkpoint, seedAddresses, seedObjects)` feed the hash, so flipping `autoTickMs`
      from 1000 → 2000 does NOT trip `SeedManifestMismatchError`. `ensureForkMetaConsistent` accepts
      a `runtime` arg; runtime-only drift writes a refreshed meta with the same configHash; clearing
      runtime drops the key entirely so a resume doesn't re-arm a stale fiber. Snapshot save/restore
      picks the new field up for free because the snapshot serializer tars the whole
      `.devstack/stacks/<stack>/sui-fork/` directory — no `engine/snapshot.ts` touch required.
      Reader side: `resolveResumeAutoTickIntervalMs` in `engine/sui-fork/control.ts` folds the
      on-disk value in as a fallback when the caller didn't re-pass `autoTick`; fresh
      `autoTick: false` cancels the saved cadence (operator turns auto-tick off). Wired in
      `services/sui.ts::buildFork` via a `readForkMeta` peek before the `ensureForkMetaConsistent`
      write. Tests: `engine/sui-fork/meta.test.ts` covers (a) `configHash` unchanged when only
      `autoTickMs` changes, (b) round-trip via disk preserves the value, (c) clearing runtime drops
      the key. `engine/sui-fork/control.test.ts` covers the `resolveResumeAutoTickIntervalMs`
      precedence rules (fresh `false` cancels saved value, corrupt saved values ignored, etc.).

### Test gate

- [ ] **P5.T2a** Docker-gated: deploy a Move package with a clock-gated function; verify it executes
      correctly under auto-tick. _Status 2026-05-19:_ tracked for the docker suite. Implementation
      note: covered structurally by the unit tests in `engine/sui-fork/control.test.ts` (the
      cadence + failure-policy fiber behavior); the missing piece is the live Move-side
      `clock::timestamp_ms()` round trip, which requires the `examples/fork-greeting` example app
      from `post-launch-sweep.md` §6.3.
- [ ] **P5.T2b** Verify manual `advanceClock` still works alongside auto-tick. _Status 2026-05-19:_
      same gating as P5.T2a — both verbs hit the same `ForkingService.AdvanceClock` RPC, which the
      fork serializes internally; the test is a docker-gated assertion that two back-to-back
      advances (one auto-tick fiber, one CLI verb) both succeed.

### Risks

- **Clock drift.** Auto-tick uses wall-clock cadence, not real chain time. Document the contract.
- **Race with manual `advanceClock`.** Both call the same RPC; the fork serializes them — but a
  manual `advanceClock` while auto-tick is mid-flight could surprise. Audit.

### Parallel

✅ standalone. One subagent.

---

## §6 Subtopic 4 — Parallel stacks

**Parent tag refs:** P5.6, P5.T3 (`notes/sui-fork-integration.md:443-445`)

### Goal

Two stacks with different data dirs running concurrently on one machine.

### Current state (per memory)

[[devstack-effect e2e verified]] notes that concurrent-stack support is verified for non-fork mode
(port allocator + file lock cover the corner cases). Fork mode adds:

- Upstream cache directory (shared across stacks pointing at the same upstream). Manual GC strategy
  per closeout-sweep §10 decision 3.
- Per-fork data dir lock (already present per Phase 1 R5).
- Image build cache (Docker layer cache, shared).

### Tasks

- [x] **P5.6.1** Audit: what state does fork mode add that two stacks could race on? (cache dir is
      the main candidate.) _Status (2026-05-19):_ audit complete. Fork-side state already partitions
      cleanly by stack: `resolveForkDataDir(stack)` / `resolveForkMetaPath(stack)` / `data.lock`
      (file-lock under the per-stack sui-fork root) all fold `stack` into the path. The shared
      `.devstack/sui-fork-cache/<chainId>/` is intentionally shared across stacks AT THE SAME
      upstream chainId; different upstreams partition naturally because `computeConfigHash` folds in
      `upstream`. No code changes required — invariants are documented + asserted in the new
      `engine/sui-fork/parallel.test.ts`.
- [x] **P5.6.2** Test: two `Sui({fork:...})` stacks pointing at the same upstream + different data
      dirs, concurrent acquire. _Status (2026-05-19):_ unit-side invariants in
      `engine/sui-fork/parallel.test.ts` (per-stack path partitioning); docker-gated end-to-end in
      `engine/sui-fork/parallel.docker.test.ts` using `forkHarness` for two concurrent testnet-fork
      harnesses.
- [x] **P5.6.3** Test: two stacks pointing at _different_ upstreams (e.g., mainnet vs testnet fork),
      concurrent. _Status (2026-05-19):_ unit-side `configHash` partition asserted in
      `engine/sui-fork/parallel.test.ts`; docker-gated mainnet+testnet pair in the same file as
      P5.6.2's docker test.

### Test gate

- [x] **P5.T3** Concurrency test as above. _Status (2026-05-19):_ landed as
      `engine/sui-fork/parallel.docker.test.ts` (three cases: same-upstream-different-stack,
      different-upstream-different-stack, teardown-leak-check). Gated on `RUN_FORK_DOCKER_TESTS=1`.
      Sibling parallel-stack docker test for seal at `services/seal/parallel-stack.docker.test.ts`
      (gated on `RUN_SEAL_DOCKER_TESTS=1`).

### Parallel

✅ standalone.

### Closeout (2026-05-19) — TaskList #13 (seal parallel-stack readiness)

User flagged "seal is not running in parallel yet" on 2026-05-19. Audit conclusion: **seal was
already parallel-stack safe** by virtue of host-side state living under stack-scoped paths
(`servicePath('seal')` → `.devstack/stacks/<stack>/runtime/seal/`), routed hostname
(`routerHostname(identity, 'seal')` → `<stack>.seal.<app>.localhost`), stack-prefixed docker
container names (`composeContainerName(app, stack, network, primitive)`), and chainId-scoped
state-store keys (`buildCacheKey({namespace, chainId, inputsHash})`). The shared seal Traefik
entrypoint port (`2024`) is dispatched by `Host:` header so two stacks coexist on the same external
port. No source-code changes were required in `services/seal/internal.ts`. The previously-missing
gate is the test: `services/seal/parallel-stack.test.ts` asserts the per-invariant scoping, and
`services/seal/parallel-stack.docker.test.ts` is a docker-gated end-to-end placeholder for the
future two-supervisor orchestration. Marked done.

---

## §7 Subtopic 5 — Cold-start optimization

**Parent tag refs:** P5.7 (`notes/sui-fork-integration.md:447-448`)

### Goal

Cut fork cold start from ~60s to ~5s by pre-warming system state in the image build (download object
0x5 + dynamic fields at image build time, bake into the data dir).

### Cross-repo coordination required

Rust-side `sui-fork` work to:

- Add a `bake-system-state --upstream <url> --output <dir>` CLI subcommand.
- Modify the Dockerfile to invoke `bake-system-state` during build, copying the resulting data dir
  into the image.

This is **not a TypeScript-side change.** Devstack picks up the optimization for free once the
upstream image ships it.

### Tasks (devstack-side)

- [ ] **P5.7.1** Coordinate with rust-side; track the upstream issue.
- [ ] **P5.7.2** Once shipped: update the image pin to the version with baked state. _Status
      (2026-05-19):_ upstream baked-state image has not shipped, so this stays unchecked. When it
      lands, bump `DEFAULT_SUI_FORK_REV` (and the matching `DEFAULT_SUI_VERSION` if the release
      ships together) in `packages/devstack/src/services/sui.ts` — devstack does not have a
      dedicated `engine/sui-fork/images.ts`, the pin lives alongside the other Sui image constants.
- [ ] **P5.7.3** Benchmark cold start before/after; update `notes/sui-fork-integration.md` with new
      ready-probe timeout.

### Risks

- **Image size.** Baked system state is ~hundreds of MB. Acceptable for dev images.
- **Staleness.** Baked state is from upstream at image-build time. Fork's first checkpoint diverges
  from upstream anyway, so this isn't load-bearing.

### Parallel

❌ blocked on rust-side work. Track upstream; revisit when ready.

---

## §8 Subtopic 6 — Dev-wallet fork controls

**Parent tag refs:** P5.8, P5.9 (`notes/sui-fork-integration.md:450-452`)

### Goal

Surface fork admin RPCs in the dev-wallet UI:

- `advance-clock`, `advance-checkpoint`, current status (P5.8)
- Impersonation slot management (P5.9)

### Tasks

**P5.8 — Fork tab:**

- [ ] **P5.8.1** New UI component `packages/dev-wallet/src/ui/dev-wallet-fork-panel.ts`.
- [ ] **P5.8.2** Status read: poll (or subscribe per §9) `GetStatus`; display current checkpoint +
      clock.
- [ ] **P5.8.3** Action buttons: advance-clock (ms input), advance-checkpoint (count input).
- [ ] **P5.8.4** Wire to existing `ForkControl` admin RPCs via the wallet server → devstack relay.
- [ ] **P5.8.5** Tab only renders when `Sui.runtime === 'forked'` (read from manifest).

**P5.9 — Impersonation slot manager:**

- [ ] **P5.9.1** Account list UI: show address, label, "impersonate" toggle.
- [ ] **P5.9.2** "Switch sender" affordance: any mainnet address can be impersonated; UI shows the
      active impersonation slot.
- [ ] **P5.9.3** Wire to `executeImpersonated` so user-driven tx signing routes through the
      impersonation path when toggled.

### Test gate

- [ ] **P5.8.T1** Playwright: fork tab visible in fork mode, hidden in bundled mode.
- [ ] **P5.8.T2** Playwright: advance-clock click → status updates.
- [ ] **P5.9.T1** Playwright: switch sender → next tx executes as impersonated.

### Risks

- **Wallet protocol surface.** May need new endpoints for the admin relays. Coordinate with
  `post-launch-sweep.md` §5.4 wallet protocol integration test.

### Parallel

✅ standalone. Two subagents (panel + slot manager).

---

## §9 Subtopic 7 — Subscriptions

**Parent tag refs:** P5.10 (`notes/sui-fork-integration.md:454-456`)

### Goal

Replace `GetStatus` polling with `SubscribeCheckpoints` (with fallback to polling on disconnect per
R4 of the parent plan).

### Tasks

- [x] **P5.10.1** Audit SDK's `SuiGrpcClient` for `SubscribeCheckpoints` support; identify the
      streaming RPC surface. _Done 2026-05-19:_ The SDK (`@mysten/sui@2.17.0`) ships
      `SubscriptionServiceClient.subscribeCheckpoints(req, options)` as a server-streaming RPC under
      `sui.rpc.v2.SubscriptionService`. It's already exposed on `SuiGrpcClient.subscriptionService`
      alongside `forkingService` — no SDK bump needed. The streaming response is an
      `AsyncIterable<SubscribeCheckpointsResponse>` whose entries carry `cursor: optional uint64` +
      an optional `Checkpoint` body. Whether `sui-fork` itself implements this RPC against an
      inactive validator is an open question — `P5.10.3` covers that gap with a polling fallback.
- [x] **P5.10.2** Update `engine/sui-fork/control.ts` to consume the subscription; expose as an
      Effect Stream. _Done 2026-05-19:_ New `engine/sui-fork/control.ts` exports
      `subscribeCheckpoints(client)` which adapts the SDK's `ServerStreamingCall.responses`
      `AsyncIterable` via `Stream.fromAsyncIterable`. Each event collapses to a stable
      `ForkCheckpointEvent` shape (`{cursor, source, receivedAtMs}`). The factory returns a fresh
      Stream per call so two consumers (CLI `--follow`, dev-wallet panel) each get their own gRPC
      connection tied to their own scope.
- [x] **P5.10.3** Implement disconnect fallback: on stream error, switch to polling
      Schedule.spaced(2s) until reconnect succeeds. _Done 2026-05-19:_
      `subscribeCheckpointsWithFallback(client, pollIntervalMs=2000)` uses `Stream.catch` to swap
      into `pollCheckpoints` on subscription error. The polling source `mapAccum`s over
      `getStatus`'s `checkpointSequenceNumber` so dedupe holds emissions silent between
      operator-driven advance-checkpoint verbs (avoids 2 Hz event spam). The composite explicitly
      does NOT re-promote to subscription mid-stream — per R4, "polling stays alive" beats "perfect
      parity". Consumers wanting reconnect parity drop the stream and call
      `subscribeCheckpointsWithFallback` again.
- [x] **P5.10.4** Update consumers (`fork status` CLI, dev-wallet fork tab) to read from the Stream.
      _Done 2026-05-19:_ `devstack fork status --follow` now streams `ForkCheckpointEvent`s until
      Ctrl-C. `--json` emits one JSON-encoded event per line for piping; the human format is
      `[<iso>] checkpoint=<n> (<source>)` so the source tag (`subscription` vs `poll`) is visible to
      the operator. `ForkControl.subscribeCheckpoints()` is the supervisor-side handle — the
      dev-wallet panel consumes it via the wallet relay (the dev-wallet pieces were already
      pre-wired by the Subtopic 6 agent's `ForkStatus.autoTickMs?` + relay scaffolding).
- [x] **P5.10.5** Snapshot meta: subscription is ephemeral; no meta change. _Done 2026-05-19:_
      confirmed — no `ForkMeta` / `SnapshotMeta` fields touched. The stream is scope-bound on the
      consumer side; resume re-acquires fresh streams.

### Test gate

- [x] **P5.10.T1** Unit test: stream emits on checkpoint advance. _Done 2026-05-19:_
      `engine/sui-fork/control.test.ts` `subscribeCheckpoints (P5.10.T1)` drives a stub
      `SuiGrpcClient` whose `subscriptionService` yields three cursor responses and asserts the
      Stream emits exactly three `ForkCheckpointEvent`s with `source='subscription'`.
- [x] **P5.10.T2** Unit test: disconnect → polling fallback → reconnect. _Done 2026-05-19:_
      `subscribeCheckpointsWithFallback (P5.10.T2)` arms the stub subscription to throw on first
      iteration, then verifies the consumer collects three `source='poll'` events with
      monotonically-increasing cursors (and that the stateful dedupe absorbed a repeated cursor in
      the polling stream). The "reconnect" half of the name is structurally moot — per R4 we
      deliberately don't re-promote to subscription; the comment in `control.ts` documents the
      trade.
- [ ] **P5.10.T3** Docker-gated: long-running stream against a real fork; advance-checkpoint
      triggers emission. _Status 2026-05-19:_ left for the docker-gated suite. The unit tests cover
      the wire adapter + fallback; the docker variant proves the fork's actual
      `SubscribeCheckpoints` implementation matches the SDK's typing. Goes in
      `engine/sui-fork.container.docker.test.ts` once the orchestrator runs locally.

### Risks

- **SDK gRPC parity.** Subscription RPCs may not be in the SDK's gRPC client yet (per Phase −1, the
  SDK was bumped to `2.17.0` with `ForkingServiceClient`, but check the subscription surface). If
  not, file an upstream issue.

### Parallel

✅ standalone.

---

## §10 Parallel-execution matrix

| Subtopic                                        | Subagents                       | Notes                                            |
| ----------------------------------------------- | ------------------------------- | ------------------------------------------------ |
| 1 — Walrus GraphQL shim                         | 1 design + N impl               | design-heavy; impl ✅ parallel after decisions   |
| 2 — Seal audit                                  | 1 audit + (N impl if unblocked) | sequential                                       |
| 3 — Auto-tick clock                             | 1                               | standalone                                       |
| 4 — Parallel stacks                             | 1                               | mostly tests                                     |
| 5 — Cold-start optimization                     | 0 (devstack-side)               | blocked on rust-side                             |
| 6 — Dev-wallet fork UI                          | 2                               | panel + slot manager parallel                    |
| 7 — Subscriptions                               | 1                               | standalone                                       |
| **Max parallel (subtopics 3, 4, 6, 7 fan out)** | **5**                           | with rust-side tracking 5, and 1, 2 doing design |

---

## §11 Decision points before kick-off

1. **Subtopic 1 image source:** vendor `sui-indexer-alt-graphql` or build from source? Depends on
   upstream image availability.
2. **Subtopic 1 lifecycle:** per-stack or shared shim?
3. **Subtopic 2 unblock condition:** what's the criterion for "Seal can run on fork" — pure gRPC, or
   partial JSON-RPC with documented limitations?
4. **Subtopic 3 auto-tick wall-clock contract:** is wall-clock cadence acceptable, or do we need to
   advance by configured ms regardless of real elapsed time?
5. **Subtopic 6 wallet protocol surface:** new endpoints for fork admin, or proxy via existing
   wallet protocol? (Coordinate with `post-launch-sweep.md` §5.4.)
6. **Subtopic 7 SDK subscription support:** if the SDK doesn't yet expose `SubscribeCheckpoints`, do
   we file an upstream issue and wait, or write a temporary direct-gRPC client?

---

## §12 Open follow-ups (not in this plan)

- Upstream rust-side `sui-fork` cold-start image-build recipe (Subtopic 5).
- Upstream SDK `SubscribeCheckpoints` gRPC parity if missing (Subtopic 7).
- Walrus + Seal upstream gRPC migration (gates Subtopics 1, 2).
