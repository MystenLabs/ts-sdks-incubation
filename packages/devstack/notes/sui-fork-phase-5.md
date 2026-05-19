# Sui-fork Phase 5 — exploration plan

**Status:** Draft (2026-05-19). Greenfield exploration follow-up to `notes/sui-fork-integration.md`
(Phases −1..4 substantially complete). Split from `notes/post-launch-sweep.md` per closeout-sweep
§10 decision 5.

**Gate:** Wave 4 §6.3 of `post-launch-sweep.md` (the `examples/fork-greeting/` example app scaffold)
should land first so this plan has a real harness.

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

- [ ] **P5.1.1** Identify upstream `sui-indexer-alt-graphql` image source. Vendor or pin.
- [ ] **P5.1.2** Add `SuiGraphQLShim` service factory. Optional per-stack.
- [ ] **P5.1.3** Wire to `walrusLocalCluster`'s chain-client config so it points at the shim when
      fork mode is active.
- [ ] **P5.1.4** Update `resolveDeploymentNetwork` to accept `walrusLocalCluster` in fork mode
      (currently rejects per Phase 3).
- [ ] **P5.1.5** Snapshot meta extension: record the shim's container ID + endpoint URL.

**Test gate:**

- [ ] **P5.T1a** Docker-gated e2e: stand up `examples/fork-greeting/` with `walrusLocalCluster`,
      write+read a blob.
- [ ] **P5.T1b** Snapshot round-trip with shim present.

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

- [ ] **P5.3.1** Audit seal key-server source (`~/code/seal/` or upstream repo) for chain-client
      construction.
- [ ] **P5.3.2** Document findings in `notes/sui-fork-phase-5-seal-audit.md` (one-pager).

**If gRPC-capable:**

- [ ] **P5.4.1** Allow `sealLocalKeygen` in fork mode (update `resolveDeploymentNetwork`).
- [ ] **P5.4.2** Add fork-mode integration test (`seal/local-keygen.docker.test.ts` variant).

**If JSON-RPC-bound:**

- [ ] **P5.4.x** Document the upstream block. Add a `SealForkBlocked` typed error pointing at the
      upstream issue.

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

- [ ] **P5.5.1** Add `autoTickMs?: number` to `SuiForkOptions`.
- [ ] **P5.5.2** Supervisor-side `Effect.forkScoped` schedule that calls
      `ForkControl.advanceClock(autoTickMs)` on a `Schedule.spaced` cadence.
- [ ] **P5.5.3** TUI surface: log "auto-tick active (1000ms)" once at acquire; nothing per-tick.
- [ ] **P5.5.4** Snapshot meta: record `autoTickMs` so resume restores the cadence.

### Test gate

- [ ] **P5.T2a** Docker-gated: deploy a Move package with a clock-gated function; verify it executes
      correctly under auto-tick.
- [ ] **P5.T2b** Verify manual `advanceClock` still works alongside auto-tick.

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

- [ ] **P5.6.1** Audit: what state does fork mode add that two stacks could race on? (cache dir is
      the main candidate.)
- [ ] **P5.6.2** Test: two `Sui({fork:...})` stacks pointing at the same upstream + different data
      dirs, concurrent acquire.
- [ ] **P5.6.3** Test: two stacks pointing at _different_ upstreams (e.g., mainnet vs testnet fork),
      concurrent.

### Test gate

- [ ] **P5.T3** Concurrency test as above.

### Parallel

✅ standalone.

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
- [ ] **P5.7.2** Once shipped: update the image pin to the version with baked state.
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

- [ ] **P5.10.1** Audit SDK's `SuiGrpcClient` for `SubscribeCheckpoints` support; identify the
      streaming RPC surface.
- [ ] **P5.10.2** Update `engine/sui-fork/control.ts` to consume the subscription; expose as an
      Effect Stream.
- [ ] **P5.10.3** Implement disconnect fallback: on stream error, switch to polling
      Schedule.spaced(2s) until reconnect succeeds.
- [ ] **P5.10.4** Update consumers (`fork status` CLI, dev-wallet fork tab) to read from the Stream.
- [ ] **P5.10.5** Snapshot meta: subscription is ephemeral; no meta change.

### Test gate

- [ ] **P5.10.T1** Unit test: stream emits on checkpoint advance.
- [ ] **P5.10.T2** Unit test: disconnect → polling fallback → reconnect.
- [ ] **P5.10.T3** Docker-gated: long-running stream against a real fork; advance-checkpoint
      triggers emission.

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
