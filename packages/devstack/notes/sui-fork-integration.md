# sui-fork integration plan

Living design doc + progress tracker. **This file is self-contained** — a fresh Claude/dev session
should be able to pick up work by reading from the top and finding the first unchecked task in the
current phase.

**Status (2026-05-19): TRIMMED — Phases −1..4 task lists removed.** All five phases substantially
complete; remaining test gates extracted to `notes/post-launch-sweep.md` Wave 4 §§6.2–6.5. Phase 5
(exploration) split to `notes/sui-fork-phase-5.md`. Preserved here for the **risk register
(R1–R12)**, **design decisions (D1–D6)**, **file paths reference**, and **glossary**.

**SDK note (2026-05-18):** `@mysten/sui` now ships the forking proto natively. Every `SuiGrpcClient`
exposes `client.forkingService: ForkingServiceClient` constructed against the same transport
(`~/code/ts-sdks/packages/sui/src/grpc/client.ts:72,90`). The SDK uses the same
single-server-same-port wiring sui-fork exposes (`crates/sui-fork/src/startup.rs:192-198` —
`with_custom_service(ForkingServiceServer)` registers admin RPCs on the same `RpcService` as
ledger/state/execution/subscription). Phase 1's "vendor + codegen" tasks (formerly P1.4-P1.6) are
deleted; we just bump the SDK version.

**Owner:** unassigned.

---

## How to resume in a clean session

1. Read § "Background" and § "Critical landmines" so you have the constraints.
2. Read § "Phase status" to find the current phase.
3. Inside that phase, find the first `- [ ]` (unchecked) item — that's your next task.
4. When a task completes, change `- [ ]` → `- [x]` in the same edit as the code change. Add a
   one-line `<!-- done YYYY-MM-DD by … -->` comment if useful.
5. A phase is complete when its **test gate** at the bottom of the phase section is fully green (all
   rows checked).
6. When all gate rows are checked, advance § "Phase status" to the next phase.

**Don't skip the test gates** — they prevent silent regressions. Every plugin and engine seam
touched by fork mode has a corresponding e2e test.

**Audit findings preserved in this document.** Five subagent audits were run on 2026-05-18 covering
plugins, engine, codegen+frontend, CLI, the sui-fork source itself, and the JS SDK gRPC client.
Their findings are folded into the per-phase task lists below — you don't need to re-run them.

---

## Phase status

- [x] **Phase -1** — gRPC-default migration repo-wide (prerequisite)
- [x] **Phase 1** — minimal fork mode (image, factory, control object) — unit gates green; docker
      gates gated behind `RUN_FORK_DOCKER_TESTS=1` + deferred to a pre-merge CI run.
- [x] **Phase 2** — funding + accounts (impersonation) — 9/10 tasks done + 2/6 test gate boxes green
      (the unit-testable pieces); P2.8 (faucet strategy) deferred to Phase 3; the four `~docker`
      test pieces deferred to a pre-merge CI run alongside Phase 1's docker gate. Hard-stop after
      this per the resume instructions.
- [x] **Phase 3** — plugin compatibility (DeepBook / Walrus / Seal known-deployment branches) — all
      7 tasks done + 4/9 unit test gates green (P3.T1, P3.T4, P3.T6, P3.T8); docker gates (P3.T2,
      P3.T3, P3.T5, P3.T7) stubbed behind `RUN_FORK_DOCKER_TESTS=1`; P3.T9 deferred pending Phase
      2's `examples/fork-greeting/` scaffold (P2.T6 was itself deferred).
- [x] **Phase 4** — CLI, snapshots, doctor, DX — unit gates green; docker gates `*.docker.test.ts`
      deferred behind `RUN_FORK_DOCKER_TESTS=1` to a pre-merge CI run
- [ ] **Phase 5** — exploration (auto-tick, GraphQL shim, parallel stacks)

Phases are gated. Don't start phase N+1 until phase N's test gate is green.

---

## Background

### What `sui-fork` is

A Rust binary at `crates/sui-fork` in `MystenLabs/sui` (currently in `~/code/sui` on Mike's
machine). Spins up a single-validator fork of mainnet/testnet/devnet (or a custom GraphQL endpoint)
at a chosen checkpoint, using `simulacrum` for execution and the canonical `sui-rpc-api` for the
data plane.

Surface:

- **`sui-rpc-api` gRPC** on one port (default `127.0.0.1:9000`): ledger / state /
  transaction-execution / subscription. **No JSON-RPC, no faucet HTTP, no GraphQL.**
- **Admin gRPC `sui.forking.v1alpha.ForkingService`** on the same port: `AdvanceClock(duration_ms)`,
  `AdvanceCheckpoint`, `GetStatus`.
- **CLI** `sui-fork start | advance-clock | advance-checkpoint | status` — `start` is the
  long-running process; the others are thin gRPC clients.

Key properties:

- Every accepted tx becomes its own checkpoint; the clock only advances on the admin RPC.
- **Empty-signature impersonation** — `ForkedTransactionExecutor::execute_transaction`
  (`crates/sui-fork/src/rpc/executor.rs:70`) routes unsigned txs through
  `simulacrum::execute_transaction_impersonating`, letting the caller execute _as_ any declared
  sender without that sender's keys.
- **Persistent data dir** at `{base}/{network}/forked_at_{checkpoint}/` with a write-once
  `seed_manifest.json`. Restart with the same `--data-dir + --network + --checkpoint` resumes;
  passing `--address`/`--object` re-seed flags after a manifest exists is a hard error.
- **Network access to upstream GraphQL required** at startup (system state warming) and on every
  object/tx miss thereafter. No retry, no backoff, no auth headers, no rate-limit accommodation.
- **No published binary, no upstream Docker image.** We build from source at a pinned commit.
- **Fork's `chainId` == upstream's `chainId`** — a mainnet-fork has the real mainnet chain ID, which
  has consequences for state-store paths and snapshot keys.

### What devstack is

Declarative reconciler + plugin harness for fully-seeded Sui local dev. Lives at
`packages/devstack/`. Key concepts:

- **`Ref` / `provide` / `tag`** (`src/advanced/tag.ts`) — a `Ref` is an Effect Layer + tag in one.
  Factories like `Sui()`, `Account()`, `Package()` return `Ref`s that compose into a stack via
  `devstack({...})`.
- **`SuiTag`** (`src/services/sui.ts:145`) — the canonical Sui Context.Service tag. The `Sui`
  interface (line 119) carries `network`, `rpc`, `faucet?`, `graphql?`, `client`, `chainId`,
  `runtime`, `waitForTransactionsReady`.
- **Per-stack docker networks**, hostname-based Traefik routing, content-addressed image tags,
  `docker commit`-based snapshots.
- **Frontend (codegen + dev-wallet) is already on gRPC** via `@mysten/sui/grpc`'s `SuiGrpcClient`.
  Internal devstack code is mid-migration — see Phase -1.

### Critical landmines (risk register)

These behaviors are non-obvious from the README and shape the design. Each has a mitigation tracked
in the relevant phase.

| #   | Behavior                                                                                                               | Source                                                              | Mitigation phase                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------- |
| R1  | `get_balance` / `list_balances` / legacy `get_coin_info` are `todo!()` panics — **crash the fork process** when called | `crates/sui-fork/src/store.rs:1198,1206,1214`                       | Phase 1 (adapter guard)                               |
| R2  | Upstream GraphQL has no retry/backoff/auth; failures silently degrade to `ObjectNotFound`                              | `crates/sui-fork/src/store.rs:704-706` + `src/gql/client.rs:90-110` | Phase 1 (health side-channel)                         |
| R3  | `simulate_transaction` returns `"unsupported"` → SDK auto-gas-budget path errors                                       | `crates/sui-fork/src/rpc/executor.rs:143-147`                       | Phase 1 (`defaultGasBudget`)                          |
| R4  | `SubscribeCheckpoints` silently drops slow consumers at 256 buffered; out-of-order panics the broker                   | `sui-rpc-api/src/subscription.rs:107-136`                           | Phase 1 (poll `GetStatus`, don't rely on subs)        |
| R5  | No cross-process lock on `--data-dir` — concurrent fork procs trample each other silently                              | `crates/sui-fork/design/owned_objects_design.md:131`                | Phase 1 (devstack file-lock)                          |
| R6  | Seed manifest is write-once; restart with different seeds = hard fail                                                  | `crates/sui-fork/src/seed.rs:128,144,153`                           | Phase 4 (`SeedManifestMismatchError` UX)              |
| R7  | Owned-object index is **partial** — only seeded addresses + post-fork writes appear in `listOwnedObjects`              | `crates/sui-fork/design/owned_objects_design.md:23,133`             | Phase 2 (default seed pattern)                        |
| R8  | Single-validator committee — checkpoint signatures don't verify against real upstream committee                        | `crates/sui-fork/src/startup.rs:218`                                | Documented constraint                                 |
| R9  | Per-tx-becomes-checkpoint → local sequence diverges from upstream immediately                                          | `crates/sui-fork/src/rpc/executor.rs:66-74`                         | Document; expose `forkedAtCheckpoint` separately      |
| R10 | First-boot serial GraphQL reads (system state) → slow cold start (30-90s typical)                                      | `crates/sui-fork/src/startup.rs:127`                                | Phase 1 (180s probe budget); Phase 5 (baked snapshot) |
| R11 | `dryRunTransactionBlock` / `dev_inspect` don't exist; gRPC `simulate_transaction` returns unsupported                  | Same as R3                                                          | Phase 1 (typed error)                                 |
| R12 | `ParentSync::get_latest_parent_entry_ref_deprecated` panics on older protocol paths                                    | `crates/sui-fork/src/store.rs:725-729`                              | Documented                                            |

### Audit findings (preserved for resume sessions)

The five 2026-05-18 audits established:

- **JS SDK gRPC client supports empty `signatures: []`** at wire level. No length-check in
  `SuiGrpcClient.executeTransaction` (`~/code/ts-sdks/packages/sui/src/grpc/core.ts:375-392`).
  Browser gRPC-Web works via `GrpcWebFetchTransport` (the default).
- **SDK does NOT ship `sui.forking.v1alpha` proto types.** We must vendor `forking.proto` and run
  the SDK's protobuf-ts codegen to get `ForkingServiceClient`. Transport (`GrpcWebFetchTransport` /
  `RpcTransport`) is reusable.
- **Frontend already uses gRPC.** Dapp-kit codegen emits `new SuiGrpcClient(...)`; dev-wallet uses
  `SuiGrpcClient`. The four example apps' generated configs use gRPC.
- **5 internal devstack sites still use JSON-RPC** — see Phase -1 task list.
- **Vendored sui binary `devnet-v1.71.0` serves both JSON-RPC and gRPC on port 9000.** Confirmed via
  the fact that dapp-kit + dev-wallet work today against localnet over gRPC.
- **CLI surface, engine seams, plugin coupling, codegen, and dev-wallet UX** — findings folded into
  per-phase tasks below.

---

## Design decisions

### D1 — Network identity

Conflated today: `SuiNetwork`, `sui.network`, `sui.chainId`. For fork mode they must diverge:

- **`SuiNetwork`** (internal `Identity.network`) — drives state-store path routing, sweep
  partitioning, snapshot metadata. Introduce literals **`'mainnet-fork'`**, **`'testnet-fork'`**,
  **`'devnet-fork'`** in `engine/network.ts:26`.
- **`sui.network`** (what dapp-kit + wallet-standard see) — must match the real upstream for
  `getChainIdentifier` validation. Codegen translates `'mainnet-fork'` → `'mainnet'` before
  emitting.
- **`sui.chainId`** — stays the real upstream chain ID (UNCHANGED). Cache keys that need
  cross-checkpoint isolation also fold `forkedAtCheckpoint`.

This segregates `.devstack/networks/mainnet.json` (real mainnet cache) from
`.devstack/networks/mainnet-fork.json` while keeping dapp-kit's MVR + wallet-standard checks happy.

### D2 — Signing & impersonation

The fork's empty-signature impersonation isn't reachable via the SDK's high-level signing.
`Transaction.sign()` always produces a real signature.

Approach: a new helper `executeImpersonated(client, sender, transaction, gasBudget)` that builds
`TransactionData` with the declared sender, BCS-serializes, and calls
`client.core.executeTransaction({ transaction: bcsBytes, signatures: [] })`. The fork's executor
(`crates/sui-fork/src/rpc/executor.rs:70`) routes empty-signature txs through
`execute_transaction_impersonating`.

This plumbs through as a new `AccountSource` variant `{ from: 'impersonate', sender: '0x...' }`.
Default `Account('alice')` auto-promotes to `{ from: 'ephemeral, fundedBy: 'impersonate' }` when
`sui.runtime === 'forked'` and a seed address is configured. Without a seed: structured error.

### D3 — Sui interface revisions

```ts
interface Sui {
  // existing
  readonly network: SuiNetwork;                // 'mainnet-fork' for a mainnet fork
  readonly chainId: string;                    // real upstream chain id (UNCHANGED)
  readonly rpc: Endpoint;
  readonly faucet?: Endpoint;                  // undefined for fork
  readonly graphql?: Endpoint;                 // undefined for fork
  readonly client: SuiGrpcClient;              // ← Phase -1 retypes to gRPC

  // expanded
  readonly runtime: 'bundled' | 'external' | 'forked';

  // new
  readonly fork?: ForkControl;
}

interface ForkControl {
  readonly upstream: 'mainnet' | 'testnet' | 'devnet' | string;
  readonly forkedAtCheckpoint: number;
  status(): Effect.Effect<ForkStatus, SuiError>;
  advanceCheckpoint(count?: number): Effect.Effect<...>;
  advanceClock(durationMs?: number): Effect.Effect<...>;
  impersonate(sender: string, tx: Transaction, opts?: { gasBudget?: bigint }): Effect.Effect<TxResponse, SuiError>;
}
```

**Implementation note:** `ForkControl` is a thin Effect-friendly adapter over
`client.forkingService` (already on every `SuiGrpcClient`). Each method wraps the
`UnaryCall<Req, Resp>` returned by the SDK's protobuf-ts client with `Effect.tryPromise` and a typed
`SuiError` mapping. No separate transport, no separate client construction. The `sui.fork` field is
`undefined` when `runtime !== 'forked'`; we don't try to detect "is this a fork?" from
`forkingService.getStatus` round trips at construct time — `runtime` is decided by the factory
branch.

### D4 — gRPC default, no JSON-RPC

Phase -1 prerequisite. Devstack internals migrate to `SuiGrpcClient` exclusively. JSON-RPC support
remains in `@mysten/sui` for users who want it; devstack itself doesn't import it. Enforced via an
oxlint rule + grep meta-test.

### D5 — Plugin strategy for fork mode

Local-cluster variants of Walrus + Seal are **off-limits in fork mode** (they require GraphQL +
JSON-RPC, and their binaries dial sui directly). Fork mode forces the known-deployment branch:

- `Walrus()` on fork → `walrusKnownDeployment` against the wrapped upstream's real Walrus.
- `Seal()` on fork → `sealKnownKeyServer`.
- `DeepBook()` on fork → `deepbookKnownPackage`.

Phase 5 explores putting a GraphQL indexer in front of the fork to unlock the local-cluster paths.

### D6 — Open decisions

- [x] **OD1** Default seed address — refuse to start without explicit seed. Docs point at the
      configuration.
- [x] **OD2** Stay on `Sui({ network: 'mainnet-fork', fork: {...} })`. No `Fork({ upstream })` sugar
      factory.
- [x] **OD3** Poll `GetStatus` at 1Hz for supervisor checkpoint awareness. `SubscribeCheckpoints` is
      Phase-5 experimental only.
- [x] **OD4** Ship both binaries in the fork image (the implementation went with
      binaries-side-by-side rather than an alias; see P1.2).
- [x] **OD5** Pre-built fork image published to GHCR per main push; devstack defaults to
      `dockerImage({ pull })`.

---

## Phase −1..4 closeout (open items)

Implementation complete; the task lists are removed from this document. Remaining test gate items
are extracted to `notes/post-launch-sweep.md` Wave 4:

- §6.2 — Sui-fork docker local sweep (`RUN_FORK_DOCKER_TESTS=1`, 15+ tests across Phases 1–4)
- §6.3 — `examples/fork-greeting/` example app scaffold (P2.T6)
- §6.4 — Live-net gRPC suite (P-1.T5, not yet written)
- §6.5 — Playwright × 4 apps re-run (P-1.T3)

Blocked on upstream: `examples/arena/` gRPC migration (P-1.9) — needs SDK `queryTransactionBlocks`
gRPC parity.

---

## Phase 5 — split to its own plan

Phase 5 exploration (Walrus shim, Seal audit, auto-tick, parallel stacks, cold-start, dev-wallet
fork UI, subscriptions) lives in `packages/devstack/notes/sui-fork-phase-5.md` with its own design
log and decision points.

---

## Glossary

- **Fork** — a `sui-fork` instance forking from an upstream chain (mainnet / testnet / devnet /
  custom) at a specific checkpoint.
- **Upstream** — the chain the fork is initialized from.
- **`forkedAtCheckpoint`** — the upstream checkpoint number at which the fork was created. Local
  checkpoints diverge from upstream after this point.
- **Seed manifest** — the immutable `seed_manifest.json` file the fork writes on first boot,
  recording the `--address` / `--object` seeds. Subsequent boots verify config matches manifest.
- **Owned-object index** — the fork's local index of address-owned objects. Only contains seeded
  addresses + post-fork local writes. **NOT a full upstream inventory.**
- **Impersonation** — submitting a tx with `signatures: []` so the fork executes it as the declared
  sender without keys. Wire-level signal is the empty signature list.
- **Known-deployment** — devstack's name for a `*KnownPackage`-style factory that uses
  upstream-shipped package addresses (vs. publishing local source).
- **gRPC default** — devstack policy as of Phase -1: internal code uses `SuiGrpcClient` exclusively;
  `@mysten/sui/jsonRpc` is banned outside the allowlist.

## File paths quick reference

### sui-fork source (`~/code/sui/crates/sui-fork/`)

- `src/cli.rs` — CLI surface
- `src/startup.rs` — initialization flow
- `src/rpc/executor.rs:70` — empty-signature impersonation branch
- `src/store.rs:1198,1206,1214` — `todo!()` panics (R1)
- `src/store.rs:704-706` — silent ObjectNotFound on upstream error (R2)
- `src/seed.rs:128,144,153` — seed manifest mismatch errors (R6)
- `proto/sui/forking/v1alpha/forking_service.proto` — admin RPC schema
- `design/poc.md`, `design/seeding_design.md`, `design/owned_objects_design.md` — design docs

### Devstack seams

- `packages/devstack/src/services/sui.ts:119` — `Sui` interface (Phase 1 extends)
- `packages/devstack/src/services/sui.ts:124` — `client` field (Phase -1 retypes)
- `packages/devstack/src/services/account.ts:128-209` — `AccountSource` union (Phase 2 extends)
- `packages/devstack/src/services/account.ts:325-334` — fork-mode guard
- `packages/devstack/src/services/account.ts:432,460` — JSON-RPC method calls (Phase -1)
- `packages/devstack/src/services/package/internal.ts:444` — JSON-RPC `getObject` (Phase -1)
- `packages/devstack/src/services/walrus/internal.ts:802` — `getBalance` (Phase -1, R1)
- `packages/devstack/src/services/walrus/deploy.ts:323` — independent JSON-RPC client (Phase -1)
- `packages/devstack/src/engine/network.ts:26,47` — `SuiNetwork` union (Phase 1 widens)
- `packages/devstack/src/engine/state-store.ts:138` — path routing (Phase 1)
- `packages/devstack/src/engine/snapshot.ts:88` — `SnapshotMeta` (Phase 1 extends)
- `packages/devstack/src/engine/docker/router.ts:94,317-405` — Traefik (Phase 1 adds h2c)
- `packages/devstack/src/codegen/emitters/dapp-kit-config.ts:112` — emitter network translation
  (Phase 3)
- `packages/devstack/src/cli/index.ts` — CLI noun registration (Phase 4)

### SDK references

- `~/code/ts-sdks/packages/sui/src/grpc/core.ts:375-392` — `executeTransaction` accepts empty
  signatures
- `~/code/ts-sdks/packages/sui/src/grpc/client.ts:72,90` —
  `client.forkingService: ForkingServiceClient` (shipped, shares transport with all other services)
- `~/code/ts-sdks/packages/sui/src/grpc/proto/sui/forking/v1alpha/forking_service.client.ts` —
  generated `ForkingServiceClient` class
- `~/code/ts-sdks/packages/sui/src/grpc/proto/sui/forking/v1alpha/forking_service.ts` — generated
  request/response message types
- `~/code/ts-sdks/packages/sui/src/grpc/client.ts:83-90` — pattern showing all service clients
  sharing one `GrpcWebFetchTransport`
- `~/code/ts-sdks/packages/sui/src/grpc/index.ts` — gRPC barrel; **`ForkingServiceClient` is NOT
  re-exported** (only accessible via `client.forkingService`); `GrpcWebFetchTransport` re-export is
  present

## Change log

- 2026-05-18 — Initial plan written. Audits run. No code yet.
- 2026-05-18 — `@mysten/sui` ships forking proto support. `ForkingServiceClient` lands on every
  `SuiGrpcClient` as `client.forkingService` (`packages/sui/src/grpc/client.ts:72,90`). Plan
  updated: P1.4–P1.6 (vendor + codegen) replaced by a single SDK-bump task (P-1.0) and an
  import-path verification task (new P1.4). D3 implementation note added explaining `ForkControl`
  wraps the existing `client.forkingService`. SDK references section refreshed.
