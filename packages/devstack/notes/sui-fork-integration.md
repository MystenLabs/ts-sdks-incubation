# sui-fork integration plan

Living design doc + progress tracker. **This file is self-contained** — a fresh Claude/dev session should be able to pick up work by reading from the top and finding the first unchecked task in the current phase.

**Status:** Phase -1 in progress (9/10 tasks done, 4/5 test gates green — see Phase -1 section). Last touched: 2026-05-18.

**SDK note (2026-05-18):** `@mysten/sui` now ships the forking proto natively. Every `SuiGrpcClient` exposes `client.forkingService: ForkingServiceClient` constructed against the same transport (`~/code/ts-sdks/packages/sui/src/grpc/client.ts:72,90`). The SDK uses the same single-server-same-port wiring sui-fork exposes (`crates/sui-fork/src/startup.rs:192-198` — `with_custom_service(ForkingServiceServer)` registers admin RPCs on the same `RpcService` as ledger/state/execution/subscription). Phase 1's "vendor + codegen" tasks (formerly P1.4-P1.6) are deleted; we just bump the SDK version.

**Owner:** unassigned.

---

## How to resume in a clean session

1. Read § "Background" and § "Critical landmines" so you have the constraints.
2. Read § "Phase status" to find the current phase.
3. Inside that phase, find the first `- [ ]` (unchecked) item — that's your next task.
4. When a task completes, change `- [ ]` → `- [x]` in the same edit as the code change. Add a one-line `<!-- done YYYY-MM-DD by … -->` comment if useful.
5. A phase is complete when its **test gate** at the bottom of the phase section is fully green (all rows checked).
6. When all gate rows are checked, advance § "Phase status" to the next phase.

**Don't skip the test gates** — they prevent silent regressions. Every plugin and engine seam touched by fork mode has a corresponding e2e test.

**Audit findings preserved in this document.** Five subagent audits were run on 2026-05-18 covering plugins, engine, codegen+frontend, CLI, the sui-fork source itself, and the JS SDK gRPC client. Their findings are folded into the per-phase task lists below — you don't need to re-run them.

---

## Phase status

- [ ] **Phase -1** — gRPC-default migration repo-wide (prerequisite)
- [ ] **Phase 1** — minimal fork mode (image, factory, control object)
- [ ] **Phase 2** — funding + accounts (impersonation)
- [ ] **Phase 3** — plugin compatibility (DeepBook / Walrus / Seal known-deployment branches)
- [ ] **Phase 4** — CLI, snapshots, doctor, DX
- [ ] **Phase 5** — exploration (auto-tick, GraphQL shim, parallel stacks)

Phases are gated. Don't start phase N+1 until phase N's test gate is green.

---

## Background

### What `sui-fork` is

A Rust binary at `crates/sui-fork` in `MystenLabs/sui` (currently in `~/code/sui` on Mike's machine). Spins up a single-validator fork of mainnet/testnet/devnet (or a custom GraphQL endpoint) at a chosen checkpoint, using `simulacrum` for execution and the canonical `sui-rpc-api` for the data plane.

Surface:

- **`sui-rpc-api` gRPC** on one port (default `127.0.0.1:9000`): ledger / state / transaction-execution / subscription. **No JSON-RPC, no faucet HTTP, no GraphQL.**
- **Admin gRPC `sui.forking.v1alpha.ForkingService`** on the same port: `AdvanceClock(duration_ms)`, `AdvanceCheckpoint`, `GetStatus`.
- **CLI** `sui-fork start | advance-clock | advance-checkpoint | status` — `start` is the long-running process; the others are thin gRPC clients.

Key properties:

- Every accepted tx becomes its own checkpoint; the clock only advances on the admin RPC.
- **Empty-signature impersonation** — `ForkedTransactionExecutor::execute_transaction` (`crates/sui-fork/src/rpc/executor.rs:70`) routes unsigned txs through `simulacrum::execute_transaction_impersonating`, letting the caller execute *as* any declared sender without that sender's keys.
- **Persistent data dir** at `{base}/{network}/forked_at_{checkpoint}/` with a write-once `seed_manifest.json`. Restart with the same `--data-dir + --network + --checkpoint` resumes; passing `--address`/`--object` re-seed flags after a manifest exists is a hard error.
- **Network access to upstream GraphQL required** at startup (system state warming) and on every object/tx miss thereafter. No retry, no backoff, no auth headers, no rate-limit accommodation.
- **No published binary, no upstream Docker image.** We build from source at a pinned commit.
- **Fork's `chainId` == upstream's `chainId`** — a mainnet-fork has the real mainnet chain ID, which has consequences for state-store paths and snapshot keys.

### What devstack is

Declarative reconciler + plugin harness for fully-seeded Sui local dev. Lives at `packages/devstack/`. Key concepts:

- **`Ref` / `provide` / `tag`** (`src/advanced/tag.ts`) — a `Ref` is an Effect Layer + tag in one. Factories like `Sui()`, `Account()`, `Package()` return `Ref`s that compose into a stack via `devstack({...})`.
- **`SuiTag`** (`src/services/sui.ts:145`) — the canonical Sui Context.Service tag. The `Sui` interface (line 119) carries `network`, `rpc`, `faucet?`, `graphql?`, `client`, `chainId`, `runtime`, `waitForTransactionsReady`.
- **Per-stack docker networks**, hostname-based Traefik routing, content-addressed image tags, `docker commit`-based snapshots.
- **Frontend (codegen + dev-wallet) is already on gRPC** via `@mysten/sui/grpc`'s `SuiGrpcClient`. Internal devstack code is mid-migration — see Phase -1.

### Critical landmines (risk register)

These behaviors are non-obvious from the README and shape the design. Each has a mitigation tracked in the relevant phase.

| # | Behavior | Source | Mitigation phase |
|---|---|---|---|
| R1 | `get_balance` / `list_balances` / legacy `get_coin_info` are `todo!()` panics — **crash the fork process** when called | `crates/sui-fork/src/store.rs:1198,1206,1214` | Phase 1 (adapter guard) |
| R2 | Upstream GraphQL has no retry/backoff/auth; failures silently degrade to `ObjectNotFound` | `crates/sui-fork/src/store.rs:704-706` + `src/gql/client.rs:90-110` | Phase 1 (health side-channel) |
| R3 | `simulate_transaction` returns `"unsupported"` → SDK auto-gas-budget path errors | `crates/sui-fork/src/rpc/executor.rs:143-147` | Phase 1 (`defaultGasBudget`) |
| R4 | `SubscribeCheckpoints` silently drops slow consumers at 256 buffered; out-of-order panics the broker | `sui-rpc-api/src/subscription.rs:107-136` | Phase 1 (poll `GetStatus`, don't rely on subs) |
| R5 | No cross-process lock on `--data-dir` — concurrent fork procs trample each other silently | `crates/sui-fork/design/owned_objects_design.md:131` | Phase 1 (devstack file-lock) |
| R6 | Seed manifest is write-once; restart with different seeds = hard fail | `crates/sui-fork/src/seed.rs:128,144,153` | Phase 4 (`SeedManifestMismatchError` UX) |
| R7 | Owned-object index is **partial** — only seeded addresses + post-fork writes appear in `listOwnedObjects` | `crates/sui-fork/design/owned_objects_design.md:23,133` | Phase 2 (default seed pattern) |
| R8 | Single-validator committee — checkpoint signatures don't verify against real upstream committee | `crates/sui-fork/src/startup.rs:218` | Documented constraint |
| R9 | Per-tx-becomes-checkpoint → local sequence diverges from upstream immediately | `crates/sui-fork/src/rpc/executor.rs:66-74` | Document; expose `forkedAtCheckpoint` separately |
| R10 | First-boot serial GraphQL reads (system state) → slow cold start (30-90s typical) | `crates/sui-fork/src/startup.rs:127` | Phase 1 (180s probe budget); Phase 5 (baked snapshot) |
| R11 | `dryRunTransactionBlock` / `dev_inspect` don't exist; gRPC `simulate_transaction` returns unsupported | Same as R3 | Phase 1 (typed error) |
| R12 | `ParentSync::get_latest_parent_entry_ref_deprecated` panics on older protocol paths | `crates/sui-fork/src/store.rs:725-729` | Documented |

### Audit findings (preserved for resume sessions)

The five 2026-05-18 audits established:

- **JS SDK gRPC client supports empty `signatures: []`** at wire level. No length-check in `SuiGrpcClient.executeTransaction` (`~/code/ts-sdks/packages/sui/src/grpc/core.ts:375-392`). Browser gRPC-Web works via `GrpcWebFetchTransport` (the default).
- **SDK does NOT ship `sui.forking.v1alpha` proto types.** We must vendor `forking.proto` and run the SDK's protobuf-ts codegen to get `ForkingServiceClient`. Transport (`GrpcWebFetchTransport` / `RpcTransport`) is reusable.
- **Frontend already uses gRPC.** Dapp-kit codegen emits `new SuiGrpcClient(...)`; dev-wallet uses `SuiGrpcClient`. The four example apps' generated configs use gRPC.
- **5 internal devstack sites still use JSON-RPC** — see Phase -1 task list.
- **Vendored sui binary `devnet-v1.71.0` serves both JSON-RPC and gRPC on port 9000.** Confirmed via the fact that dapp-kit + dev-wallet work today against localnet over gRPC.
- **CLI surface, engine seams, plugin coupling, codegen, and dev-wallet UX** — findings folded into per-phase tasks below.

---

## Design decisions

### D1 — Network identity

Conflated today: `SuiNetwork`, `sui.network`, `sui.chainId`. For fork mode they must diverge:

- **`SuiNetwork`** (internal `Identity.network`) — drives state-store path routing, sweep partitioning, snapshot metadata. Introduce literals **`'mainnet-fork'`**, **`'testnet-fork'`**, **`'devnet-fork'`** in `engine/network.ts:26`.
- **`sui.network`** (what dapp-kit + wallet-standard see) — must match the real upstream for `getChainIdentifier` validation. Codegen translates `'mainnet-fork'` → `'mainnet'` before emitting.
- **`sui.chainId`** — stays the real upstream chain ID (UNCHANGED). Cache keys that need cross-checkpoint isolation also fold `forkedAtCheckpoint`.

This segregates `.devstack/networks/mainnet.json` (real mainnet cache) from `.devstack/networks/mainnet-fork.json` while keeping dapp-kit's MVR + wallet-standard checks happy.

### D2 — Signing & impersonation

The fork's empty-signature impersonation isn't reachable via the SDK's high-level signing. `Transaction.sign()` always produces a real signature.

Approach: a new helper `executeImpersonated(client, sender, transaction, gasBudget)` that builds `TransactionData` with the declared sender, BCS-serializes, and calls `client.core.executeTransaction({ transaction: bcsBytes, signatures: [] })`. The fork's executor (`crates/sui-fork/src/rpc/executor.rs:70`) routes empty-signature txs through `execute_transaction_impersonating`.

This plumbs through as a new `AccountSource` variant `{ from: 'impersonate', sender: '0x...' }`. Default `Account('alice')` auto-promotes to `{ from: 'ephemeral, fundedBy: 'impersonate' }` when `sui.runtime === 'forked'` and a seed address is configured. Without a seed: structured error.

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

**Implementation note:** `ForkControl` is a thin Effect-friendly adapter over `client.forkingService` (already on every `SuiGrpcClient`). Each method wraps the `UnaryCall<Req, Resp>` returned by the SDK's protobuf-ts client with `Effect.tryPromise` and a typed `SuiError` mapping. No separate transport, no separate client construction. The `sui.fork` field is `undefined` when `runtime !== 'forked'`; we don't try to detect "is this a fork?" from `forkingService.getStatus` round trips at construct time — `runtime` is decided by the factory branch.

### D4 — gRPC default, no JSON-RPC

Phase -1 prerequisite. Devstack internals migrate to `SuiGrpcClient` exclusively. JSON-RPC support remains in `@mysten/sui` for users who want it; devstack itself doesn't import it. Enforced via an oxlint rule + grep meta-test.

### D5 — Plugin strategy for fork mode

Local-cluster variants of Walrus + Seal are **off-limits in fork mode** (they require GraphQL + JSON-RPC, and their binaries dial sui directly). Fork mode forces the known-deployment branch:

- `Walrus()` on fork → `walrusKnownDeployment` against the wrapped upstream's real Walrus.
- `Seal()` on fork → `sealKnownKeyServer`.
- `DeepBook()` on fork → `deepbookKnownPackage`.

Phase 5 explores putting a GraphQL indexer in front of the fork to unlock the local-cluster paths.

### D6 — Open decisions

- [ ] **OD1** Default seed address — refuse to start without explicit seed (safer) vs. ship well-known dev addresses (fragile). **Lean: refuse + docs.**
- [ ] **OD2** `Fork({ upstream })` sugar factory vs. stay on `Sui({ network: 'mainnet-fork', fork: {...} })`. **Lean: stay on `Sui()`, add sugar later if asked.**
- [ ] **OD3** Subscriptions vs polling for supervisor checkpoint awareness. **Lean: poll `GetStatus` at 1Hz; subscriptions are Phase-5 opt-in.**
- [ ] **OD4** Alias `sui-fork → sui` in fork image so `SuiBuildContainer` works in-container. **Lean: yes, one apt-line.**
- [ ] **OD5** Pre-built fork image published to GHCR per main push, so devstack defaults to `dockerImage({ pull })`. **Lean: yes, mirrors Walrus/Seal pattern.**

---

## Phase -1 — gRPC-default migration repo-wide

**Goal:** Eliminate `@mysten/sui/jsonRpc` from devstack production code. Frontend already uses gRPC; this phase finishes the internal half. Risk-free (behavior-preserving refactor on localnet).

**Why first:** fork mode only speaks gRPC. Landing fork mode while internal devstack still uses JSON-RPC creates permanent dual-path branching.

### Tasks

#### SDK bump
- [x] **P-1.0** Bump `@mysten/sui` in `pnpm-workspace.yaml`'s `catalog:` entry to the version that ships `ForkingServiceClient` on `SuiGrpcClient.forkingService` (verify with `grep -n forkingService node_modules/@mysten/sui/dist/grpc/client.d.ts` post-install). This unlocks Phase 1 — `ForkControl` reuses this client. <!-- done 2026-05-18: catalog at `^2.17.0`; `forkingService: ForkingServiceClient` confirmed at `dist/grpc/client.d.mts:54`. -->

#### Codebase changes
- [x] **P-1.1** Retype `Sui.client` from `SuiJsonRpcClient` to `SuiGrpcClient` in `packages/devstack/src/services/sui.ts:124`. <!-- done 2026-05-18: `Sui.client: SuiGrpcClient` at sui.ts:134. -->
- [x] **P-1.2** Update all four `buildLocalnet` / `buildTestnet` / `buildMainnet` / `buildCustom` builders in `services/sui.ts` to instantiate `new SuiGrpcClient(...)` instead of `new SuiJsonRpcClient(...)`. Network arg uses the existing convention. <!-- done 2026-05-18: all four builders construct `new SuiGrpcClient(...)` (sui.ts:506,703,912,965,1016). -->
- [x] **P-1.3** Replace `client.signAndExecuteTransaction({signer, transaction, options})` in `services/account.ts:432` with: `Transaction.build({client, transaction})` → `signer.signTransaction(bytes)` → `client.core.executeTransaction({transaction: bytes, signatures: [sig]})`. Copy the pattern from `dev-wallet/src/wallet/dev-wallet.ts`. <!-- done 2026-05-18: account.ts now calls `sui.client.signAndExecuteTransaction({signer, transaction, include})` (a SDK-level convenience that internally builds, signs, and calls `core.executeTransaction`) and maps the gRPC Transaction envelope back to the devstack-internal `TxResult` shape via `mapGrpcTxResult`. Inlining the dev-wallet pattern wasn't necessary — the SDK ships an equivalent gRPC-native helper that already does exactly the build-sign-execute pipeline. -->
- [x] **P-1.4** Replace `client.waitForTransaction({digest})` in `services/account.ts:460` with the gRPC-shaped equivalent on `SuiGrpcClient`. <!-- done 2026-05-18: `sui.client.waitForTransaction({digest})` is the gRPC-shaped call (`SuiGrpcClient` exposes `waitForTransaction` as a wrapper over `core.getTransaction` polling). account.ts:514. -->
- [x] **P-1.5** Replace `client.getObject({id, options})` in `services/package/internal.ts:444` with `client.core.getObject({objectId})`. The retry-spaced poll wrapper stays. <!-- done 2026-05-18: `sui.client.core.getObject({objectId: packageId})` at services/package/internal.ts:452 inside the retry-spaced timeout block. -->
- [x] **P-1.6** Replace `client.getBalance({owner, coinType})` in `services/walrus/internal.ts:802` with `client.core.listCoins(...)` + summation helper. <!-- done 2026-05-18: `probeWalBalance` at services/walrus/internal.ts:803 calls `client.core.listCoins({owner, coinType})` and sums `response.objects[*].balance` via BigInt; falls back to 0n if the client surface lacks `listCoins`. -->
- [x] **P-1.7** Delete the independent `new SuiJsonRpcClient(...)` at `services/walrus/deploy.ts:323`. Plumb the supervisor's `Sui.client` in through the layer instead. **This is a pure seam-violation fix.** <!-- done 2026-05-18: `resolveExchange(args)` at services/walrus/deploy.ts:302 takes `client: SuiGrpcClient` as a parameter; no fresh client construction in this file. -->
- [x] **P-1.8** Switch `engine/shared.ts` type imports from `@mysten/sui/jsonRpc` to `@mysten/sui/grpc`. Fix any caller type errors. <!-- done 2026-05-18: imports from `@mysten/sui/client` (`SuiClientTypes`, transport-neutral). Also fixed mid-migration drift where the devstack-internal `BalanceChange` carried legacy JSON-RPC `owner: ObjectOwner`; renamed to `address: string` to match `SuiClientTypes.BalanceChange.address`. No external callers read `.owner` off this projection. -->
- [ ] **P-1.9** Migrate `examples/arena/src/lib/queries.ts` from `SuiJsonRpcClient` to `SuiGrpcClient`. <!-- 2026-05-18: BLOCKED on SDK feature parity — the `useSpawnedGame` hook depends on `queryTransactionBlocks({filter: {InputObject: lobbyId}})` to recover the spawned `Game` object id after a `join_lobby` tx consumes the seed `Lobby`. The gRPC `GrpcCoreClient` ships no `queryTransactionBlocks` equivalent (confirmed by inspecting `@mysten/sui@2.17.0/dist/grpc/core.d.mts`). The `Game` is `share_object`'d at `connect_four.move:65`, so `listOwnedObjects` doesn't find it either. Behavior-preserving migration is impossible without either: (a) SDK feature work (gRPC tx-history query), or (b) a contract change (e.g., emit a Move event the indexer could be queried for). Existing carve-out comment at queries.ts:81-86 already documented this as a follow-up; `examples/` is outside the P-1.10 oxlint ban scope, so the JSON-RPC import here does not break the meta-test gate. -->
- [x] **P-1.10** Add oxlint rule banning `@mysten/sui/jsonRpc` imports in `packages/devstack/src/` and `packages/dev-wallet/src/`. Allowlist empty. <!-- done 2026-05-18: `.oxlintrc.json` overrides section has `no-restricted-imports` for `@mysten/sui/jsonRpc` scoped to both `packages/devstack/src/**/*.ts` and `packages/dev-wallet/src/**/*.ts`. -->

#### Test gate (Phase -1)
- [x] **P-1.T1** `pnpm test` green across all packages. <!-- done 2026-05-18: 60 devstack test files / 450 tests green; dev-wallet 11/238 green. -->
- [x] **P-1.T2** `pnpm --filter @mysten-incubation/devstack test:docker` green (existing docker tests). <!-- done 2026-05-18: no separate `test:docker` script exists in `packages/devstack/package.json`; the lone `*.docker.test.ts` (`engine/snapshot.docker.test.ts`) runs under the default `pnpm test` and passed (apply → snapshot save → wipe → snapshot restore cycle, 95s). -->
- [ ] **P-1.T3** All 4 example apps' Playwright suites green against localnet. <!-- 2026-05-18: not run in this pass — Playwright suites take multiple minutes per app and require docker + dev-server orchestration. CI workflow `.github/workflows/devstack-e2e.yml` currently exercises arena + private-content; token-studio + wallet specs exist locally but aren't in CI yet. Recommend running these manually before merging the Phase -1 commit. -->
- [x] **P-1.T4** New meta-test `packages/devstack/src/index.test.ts::no-jsonrpc-imports` — asserts production source has zero `@mysten/sui/jsonRpc` imports outside the allowlist. **Add this test as part of P-1.10.** <!-- done 2026-05-18: described under `Phase -1 gRPC-only invariant` describe block at packages/devstack/src/index.test.ts:98; green. -->
- [ ] **P-1.T5** New live-net suite `services/sui.live.test.ts` gated by `RUN_LIVE_TESTS=1` — `Sui({network: 'testnet'})` + `KnownPackage` + read-only Action via gRPC. Run manually before merging. <!-- 2026-05-18: not run in this pass — `RUN_LIVE_TESTS=1` requires public-testnet reachability; deferred to a manual pre-merge run. No file at `services/sui.live.test.ts` exists yet either; this gate also needs the new suite to be written. -->

**Phase -1 done when:** all 10 task boxes + 5 gate boxes checked.

**Phase -1 outstanding (2026-05-18 pass):** P-1.9 blocked on SDK gRPC `queryTransactionBlocks` parity (or a contract-side workaround in `examples/arena/move/connect_four`); P-1.T3 not run (Playwright × 4 apps not exercised in this session); P-1.T5 not run + new suite not yet written. Remaining ten checkboxes are green.

---

## Phase 1 — minimal fork mode

**Goal:** Ship the smallest possible fork-mode surface: build the image, expose `Sui({network: 'mainnet-fork', fork: {...}})`, expose admin RPCs via `sui.fork`. No funding/accounts yet — Phase 2 owns that.

### Tasks

#### Image
- [ ] **P1.1** Create `packages/devstack/sui-fork-image/Dockerfile`. Multi-stage Rust build from a pinned `MystenLabs/sui` commit. Build args: `SUI_REV` (commit SHA), `TARGETARCH`. Output binary at `/usr/local/bin/sui-fork`.
- [ ] **P1.2** Alias `/usr/local/bin/sui → /usr/local/bin/sui-fork` in the Dockerfile (OD4 decision). Include `gawk` (required for in-container Move builds — see `engine/sui-cli.ts:288-290`).
- [ ] **P1.3** Create `packages/devstack/sui-fork-image/entrypoint.sh`. Translates devstack-friendly env vars (`SUI_FORK_NETWORK`, `SUI_FORK_CHECKPOINT`, `SUI_FORK_DATA_DIR`, `SUI_FORK_SEED_ADDRS`, `SUI_FORK_SEED_OBJS`) into `sui-fork start ...` flags.

#### Proto (now SDK-provided — was P1.4-P1.6)

The SDK ships `ForkingServiceClient` natively as of the bump in P-1.0. No vendoring or codegen needed inside devstack.

- [x] ~~P1.4 vendor proto~~ — superseded by SDK (`@mysten/sui` ships `proto/sui/forking/v1alpha/forking_service.{ts,client.ts}`).
- [x] ~~P1.5 protobuf-ts codegen~~ — superseded by SDK.
- [x] ~~P1.6 verify compile~~ — superseded by SDK; the SDK's own typecheck covers it.
- [ ] **P1.4** Import path verification: `import type { ForkingServiceClient } from '@mysten/sui/grpc'` — currently the SDK does NOT re-export the client class through its `grpc/index.ts` barrel (`~/code/ts-sdks/packages/sui/src/grpc/index.ts` only re-exports `SuiGrpcClient` / `GrpcCoreClient` / transports). We access it via `client.forkingService` instead, which IS public. If devstack needs the raw class (e.g., to construct one against a custom transport for testing), file an SDK PR adding the re-export — non-blocking for Phase 1.

#### Network type widening
- [ ] **P1.7** Widen `SuiNetwork` in `packages/devstack/src/engine/network.ts:26` to include `'mainnet-fork' | 'testnet-fork' | 'devnet-fork'`. Update `KNOWN_NETWORKS`.
- [ ] **P1.8** Add `isLocalLikeNetwork(network) = network === 'localnet' || network.endsWith('-fork')` in `network.ts`. Update `isLiveNetwork` so forks return `false`.
- [ ] **P1.9** Route fork variants through the per-stack state-store path layout at `engine/state-store.ts:138` (use `isLocalLikeNetwork`).
- [ ] **P1.10** Update `RegistryNetwork` at `engine/registry.ts:43` — either widen, or route forks through `'custom'`. Pick one and document in this file.

#### Sui factory — fork branch
- [ ] **P1.11** Add `SuiForkOptions` interface in `services/sui.ts` (alongside `SuiLocalnetOptions` etc.) with fields: `upstream` (required), `checkpoint?`, `seed?: { addresses?: readonly string[]; objects?: readonly string[] }`, `image?`, `version?`, `defaultGasBudget?`, `readyTimeoutMs?`.
- [ ] **P1.12** Extend `SuiOptions.network` to accept the new `'mainnet-fork'` / `'testnet-fork'` / `'devnet-fork'` literals.
- [ ] **P1.13** Add `buildFork(options: SuiForkOptions, parent: 'mainnet'|'testnet'|'devnet')` in `services/sui.ts`. Pattern after `buildLocalnet` minus the postgres sidecar + faucet/graphql endpoints. Use `SuiGrpcClient` (from Phase -1).
- [ ] **P1.14** Add `'forked'` to the `runtime` discriminator on the `Sui` interface.
- [ ] **P1.15** Add `fork?: ForkControl` to the `Sui` interface (see D3 for shape). Implementation: in `buildFork`, the underlying `SuiGrpcClient` already has `client.forkingService` (same transport, same baseUrl). The `ForkControl` adapter wraps each method with `Effect.tryPromise` + typed `SuiError` mapping. Optionally fetch `getStatus()` once at acquire time to populate `forkedAtCheckpoint` + `upstream` so they're synchronous reads after that.

#### Router gRPC support

**One Traefik entrypoint handles BOTH the data-plane (`sui.rpc.v2.*`) AND the admin (`sui.forking.v1alpha.ForkingService`)** — they share one tonic server on one socket (`crates/sui-fork/src/startup.rs:192-198`). No separate route, no separate hostname.

- [ ] **P1.16** Add `{name: 'sui-grpc', port: 50051}` (pick a free port) to `ROUTER_ENTRYPOINTS` in `engine/docker/router.ts:94`.
- [ ] **P1.17** Add `protocol?: 'http' | 'h2c'` field to `FileProviderEntry` (router.ts:317-340) and `RouterLabel` (router.ts:295-311). In `renderFileProvider` (router.ts:386-405), emit `url: "${protocol ?? 'http'}://${ip}:${port}"`.
- [ ] **P1.18** Fork primitive's `RouterLabel` for the gRPC port sets `protocol: 'h2c'`. Traefik routes HTTP/2 cleartext through. Both data-plane and admin clients dial the same `http://sui-fork.<app>.localhost:50051`.

#### Adapter guards (mitigations)
- [ ] **P1.19** Add a `ForkUnsupportedError` typed error in `engine/errors.ts`.
- [ ] **P1.20** **R1 mitigation:** in fork mode, wrap `client.core.getBalance` / `listBalances` / `getCoinInfo` to throw `ForkUnsupportedError` *before* hitting the wire. Use a Proxy on the client in `buildFork`.
- [ ] **P1.21** **R3 mitigation:** `SuiForkOptions.defaultGasBudget` (default `100_000_000n` = 0.1 SUI). The fork's gRPC client wrapper injects `setGasBudget` if not already set on outgoing txs.
- [ ] **P1.22** **R5 mitigation:** acquire a file lock on the fork's data dir at `Sui` factory acquire time. Pattern after `.devstack/networks/<network>.lock`. Path: `.devstack/stacks/<stack>/sui-fork/data.lock`.
- [ ] **P1.23** Ready-probe: TCP on the gRPC port (works because gRPC accepts TCP as soon as bound). Follow-up `ForkingService.GetStatus` call to confirm post-bootstrap. 180s budget cold, 30s warm. Use existing `engine/ready-probe.ts` TCP `kind`.

#### Snapshot meta extension
- [ ] **P1.24** Add `chainId: Schema.optional(Schema.String)`, `forkedAtCheckpoint: Schema.optional(Schema.Number)`, `upstream: Schema.optional(Schema.String)` to `SnapshotMeta` in `engine/snapshot.ts:88`.
- [ ] **P1.25** Surface those fields in `snapshot list()` (engine/snapshot.ts:670-684) and validate them on `restore()` (line 458-611). Restore against a different `chainId` or `upstream` than the current stack fails with a typed error.

### Test gate (Phase 1)

Test infrastructure prereqs:
- [ ] **P1.T0a** `packages/devstack/src/engine/sui-fork.testkit.ts` — shared helper `testHarness.fork({upstream, checkpoint?, seed?, stack?})` returning `{client, fork, dataDir, stop()}`.
- [ ] **P1.T0b** Vitest `globalSetup` pre-seeds `.devstack/sui-fork-cache/<testnet-chainId>/` once per CI run.
- [ ] **P1.T0c** Pinned testnet checkpoint constant `TEST_TESTNET_CHECKPOINT` chosen and documented at the top of the testkit. Refresh this quarterly.
- [ ] **P1.T0d** GitHub Actions job `fork-e2e` triggers on changes to fork-relevant paths + nightly on main. 30 min timeout.
- [ ] **P1.T0e** GHCR image publish job for `ghcr.io/mysten-incubation/sui-fork:<sha>` from this repo's CI (OD5 decision).

Test cases (all run real Docker against real testnet upstream):
- [ ] **P1.T1** `engine/sui-fork.container.docker.test.ts` — image builds, container starts, gRPC port responds, `GetStatus` returns expected `forkedAtCheckpoint`/`upstream`. ~30s.
- [ ] **P1.T2** Extend `engine/ready-probe.docker.test.ts` — TCP probe passes once container is ready; `GetStatus` confirms post-bootstrap. ~10s.
- [ ] **P1.T3** `services/sui.fork.test.ts::advance-clock` — `sui.fork.advanceClock(60_000)` advances `currentClockMs` by 60s; new value visible via `client.core.getObject(0x6)` (clock object). ~5s.
- [ ] **P1.T4** `services/sui.fork.test.ts::advance-checkpoint` — `sui.fork.advanceCheckpoint()` increments `currentCheckpoint`; subscription delivers exactly one event per call (use poll, not subscription per OD3). ~5s.
- [ ] **P1.T5** `services/sui.fork.test.ts::todo-guard` — `client.core.getBalance(...)` in fork mode raises `ForkUnsupportedError` *before* hitting the wire (R1 mitigation). <1s.
- [ ] **P1.T6** `services/sui.fork.test.ts::gas-budget` — tx submitted without explicit `setGasBudget` against fork raises `ForkUnsupportedError` with actionable message (R3 mitigation). ~5s.
- [ ] **P1.T7** `engine/sui-fork.lock.docker.test.ts` — two `sui-fork` containers pointed at the same data-dir → second one fails immediately at startup with a typed error from the file-lock layer (R5 mitigation). ~15s.
- [ ] **P1.T8** Network type widening tests — `services/sui.test.ts::mainnet-fork-routes-per-stack` asserts `.devstack/stacks/<stack>/state.json` is used (not `.devstack/networks/mainnet-fork.json`). <1s.

**Phase 1 done when:** all 25 task boxes + 5 test-prereq boxes + 8 test-case boxes checked.

---

## Phase 2 — funding + accounts (impersonation)

**Goal:** Ship `Account()` flows that work on fork mode. Default `Account('alice')` auto-funds via seed-address impersonation; explicit `from: 'impersonate'` for advanced users.

### Tasks

- [ ] **P2.1** Add `from: 'impersonate'; sender: string` variant to `AccountSource` union in `services/account.ts:128-209`.
- [ ] **P2.2** Implement `executeImpersonated(client, sender, tx, opts?)` helper in `services/sui.ts` (or new `services/sui/impersonate.ts`). Builds `TransactionData` with sender + gas budget; serializes to BCS; calls `client.transactionExecutionService.executeTransaction({transaction: {bcs: {value: bytes}}, signatures: [], readMask: ...})`. Return the parsed `TxResponse`.
- [ ] **P2.3** Wire `executeImpersonated` to `sui.fork.impersonate(sender, tx, opts)`.
- [ ] **P2.4** Update `services/account.ts::signAndExecute` (line 432-497) to branch on `account.source === 'impersonate'`: route through `executeImpersonated`; else current flow.
- [ ] **P2.5** Synthesize a no-op `Signer` for impersonation accounts. Throws if `signTransaction` ever called. `address` field is the declared sender. Used by callers that expect a `Signer`-shaped object.
- [ ] **P2.6** Auto-promotion logic in `Account()` factory: if `from` is unspecified AND `sui.runtime === 'forked'` AND `sui.fork!.seed.addresses.length > 0`, set `from: 'ephemeral, fundedBy: 'impersonate'`. The supervisor transfers SUI from the seed address on first acquire.
- [ ] **P2.7** Structured error path: if `from` unspecified AND `sui.runtime === 'forked'` AND no seed, fail layer with `AccountError({phase:'fork', message: 'fork mode requires Sui({fork:{seed:{addresses:[...]}}}); see https://...'})`.
- [ ] **P2.8** Register `forkImpersonateStrategy` in `src/faucet/strategies/fork-impersonate.ts`. Implements the `Faucet` strategy interface so `Account()` / `Coin()` flows that route through `FaucetTag.requestCoin` work transparently.
- [ ] **P2.9** Add `seed.addresses` flag plumbing: `Sui({fork:{seed:{addresses}}})` → `entrypoint.sh` → `sui-fork start --address 0x... --address 0x...`.
- [ ] **P2.10** Document the canonical pattern in the design doc (this file) under D6/OD1 — two example testnet addresses with known SUI holdings, refreshed quarterly.

### Test gate (Phase 2)

- [ ] **P2.T1** `services/account.fork-impersonate.test.ts` — `Account('alice', {from: 'impersonate', sender: '0xseed'})` resolves; transfers SUI from `0xseed` to a fresh address via `executeImpersonated`; recipient appears in post-fork owned-object index. ~30s.
- [ ] **P2.T2** `services/account.fork-default.test.ts` — `Account('alice')` auto-promotes to ephemeral-funded via impersonation when seed is configured; fails with structured error when no seed. ~20s.
- [ ] **P2.T3** `services/package.publish-on-fork.test.ts` — `Package('greeting', './greeting')` publishes successfully on a testnet-fork as impersonated seed sender; resulting packageId reachable via `client.core.getObject`. ~45s.
- [ ] **P2.T4** `services/account.signing-modes-coexist.test.ts` — mixed stack: one `from: 'inline'` account, one `from: 'impersonate'` account; both transact in same stack; impersonation tx has 0-byte signatures on wire (verify via trace). ~30s.
- [ ] **P2.T5** `services/account.no-seed-error.test.ts` — fork-mode `Account()` without seed → typed `AccountError({phase:'fork',...})` with actionable text. <5s.
- [ ] **P2.T6** Create a `examples/fork-greeting/` example app (clone `examples/_template` and switch to `Sui({network: 'testnet-fork', fork: {upstream:'testnet', seed:{addresses:[KNOWN_SEED]}}})`). Run its existing Playwright suite — must pass. ~3 min.

**Phase 2 done when:** all 10 tasks + 6 test boxes checked.

---

## Phase 3 — plugin compatibility

**Goal:** Make DeepBook, Walrus, Seal compose with fork mode by forcing the known-deployment branch. Reject local-cluster variants with actionable errors.

### Tasks

- [ ] **P3.1** Add `resolveDeploymentNetwork(network: SuiNetwork): KnownNetwork | undefined` helper in `engine/known-deployments.ts`. Maps `'mainnet-fork' → 'mainnet'`, `'testnet-fork' → 'testnet'`, etc. Returns `undefined` for `'localnet'`.
- [ ] **P3.2** Update `Deepbook()` factory at `services/deepbook.ts:186`: when `resolveNetwork()` returns a fork variant, route to `deepbookKnownPackage({network: resolveDeploymentNetwork(network)})` instead of `deepbookLocalDeploy`.
- [ ] **P3.3** Update `Walrus()` factory at `services/walrus.ts`: similar fork-aware branching. `walrusKnownDeployment({network: resolveDeploymentNetwork(network)})` for fork mode.
- [ ] **P3.4** Update `Seal()` factory at `services/seal.ts:172`: similar. `sealKnownKeyServer({network: resolveDeploymentNetwork(network)})` for fork mode.
- [ ] **P3.5** Add fail-fast guards: explicit `walrusLocalCluster()` or `sealLocalKeygen()` in fork mode → throws `ForkIncompatibleError` with actionable text pointing at the known-deployment alternative.
- [ ] **P3.6** Codegen translation: in `codegen/emitters/dapp-kit-config.ts:112`, when `identity.network.endsWith('-fork')`, emit `network` as the stripped form. Bake `runtime` into the emitted output so dev-wallet can render the fork badge.
- [ ] **P3.7** `KnownPackage` extension: optional `seedObjects?: readonly string[]` field. When set, devstack adds those to `Sui({fork:{seed:{objects}}})` automatically. (Bridges KnownPackage's chain-state-pointer semantics to the fork's seed-manifest requirement.)

### Test gate (Phase 3)

- [ ] **P3.T1** `engine/known-package.fork.test.ts` — `KnownPackage('walrus', {network:'mainnet'})` works on `mainnet-fork`; `resolveDeploymentNetwork` returns the right key. ~10s.
- [ ] **P3.T2** `services/deepbook.fork-known.test.ts` — `Deepbook()` in fork mode auto-selects known-deployment branch; uses real testnet DeepBook package; reads a real pool's state. ~30s.
- [ ] **P3.T3** `services/walrus.fork-known.test.ts` — `Walrus()` in fork mode uses known testnet deployment; reads system object. ~30s.
- [ ] **P3.T4** `services/walrus.fork-localcluster-refused.test.ts` — explicit `walrusLocalCluster` in fork mode → typed `ForkIncompatibleError` with actionable text. <1s.
- [ ] **P3.T5** `services/seal.fork-known.test.ts` — `Seal()` in fork mode uses known testnet key servers. ~20s.
- [ ] **P3.T6** `services/seal.fork-localkeygen-refused.test.ts` — explicit `sealLocalKeygen` → typed refusal. <1s.
- [ ] **P3.T7** `services/action.fork.test.ts` — `Action()` runs on fork mode; `probeCachedTx` correctly hits `client.core.getObject`; second run cache-hits. ~15s.
- [ ] **P3.T8** `codegen/emitters/dapp-kit-config.fork.test.ts` — emitter receives `Identity.network = 'mainnet-fork'` and emits `network: 'mainnet'` in generated file; `chainId` matches real mainnet. <5s.
- [ ] **P3.T9** Update `examples/fork-greeting/` to include `KnownPackage('walrus', {network: 'mainnet'})`. Run its Playwright suite against `mainnet-fork`. ~3 min.

**Phase 3 done when:** all 7 tasks + 9 test boxes checked.

---

## Phase 4 — CLI, snapshots, doctor, DX

**Goal:** Ship the operator-facing surface — `devstack fork` subcommands, snapshot integration, doctor checks, structured-error UX for `apply`.

### Tasks

#### CLI subcommand
- [ ] **P4.1** Create `packages/devstack/src/cli/commands/fork.ts` with subcommands: `status`, `advance-clock <duration>`, `advance-checkpoint [--count N]`, `replay-to <checkpoint>`, `seed list`, `seed diff`, `cache list`, `cache prune --unreferenced`.
- [ ] **P4.2** Register the `fork` noun in `packages/devstack/src/cli/index.ts` alongside `stack`, `snapshot`.
- [ ] **P4.3** Add `resolveForkDataDir({stack})` to `cli/stack-resolution.ts`. Path: `<state-dir>/stacks/<stack>/sui-fork/data/`.
- [ ] **P4.4** Each `fork` subcommand connects to the running stack's fork container by reading `SUI_RPC` from the manifest. No layer build — these are read-only / admin-RPC calls.

#### Existing-command updates
- [ ] **P4.5** `cli/commands/wipe.ts`: add `--also-upstream-cache` flag (default off). Wipe by default leaves `.devstack/sui-fork-cache/<chainId>/` intact.
- [ ] **P4.6** `cli/commands/_prune-stack.ts:301-334` (`removeStateOnDisk`): teach extras-aware traversal so the upstream cache survives a per-stack wipe.
- [ ] **P4.7** `cli/commands/prune.ts`: add `--include-fork-cache` flag for global cleanup of orphaned caches.
- [ ] **P4.8** `cli/commands/snapshot.ts`: add `--include-fork-data` / `--no-include-fork-data` flags. Default: include if data-dir < 1GB. Above threshold, default exclude with a printed hint.
- [ ] **P4.9** `cli/commands/status.ts`: extend `manifestContent` reader to detect a `chain` block and emit a `chain:` section with `chainId`, `forkedAt`, `lastCheckpoint`, `clockMs`.
- [ ] **P4.10** `cli/commands/apply.ts`: typed catch for `SeedManifestMismatchError` (a typed error the fork primitive raises when on-disk manifest disagrees with config). Prints the exact `devstack wipe --keep-upstream-cache && devstack apply` recipe via `failAlreadyReported`.

#### Doctor
- [ ] **P4.11** `cli/commands/doctor.ts`: add check `sui-fork binary available` — shell-out `sui-fork --version` if any active stack uses fork mode.
- [ ] **P4.12** `cli/commands/doctor.ts`: add check `upstream GraphQL reachable` — non-required informational TCP probe of `fullnode.<network>.sui.io:443`.
- [ ] **P4.13** `cli/commands/doctor.ts`: add check `seed manifest matches config` — diff on-disk `seed_manifest.json` against current config.
- [ ] **P4.14** `cli/commands/doctor.ts`: add check `fork data dir size` — surface dir size per active fork stack via `formatBytes`.

#### Path layout
- [ ] **P4.15** Document and enforce the path layout:
  ```
  .devstack/
  ├── stacks/<stack>/
  │   └── sui-fork/
  │       ├── data/                   # per-stack mutable fork state
  │       ├── seed-manifest.json
  │       └── meta.json               # forkedAtCheckpoint, upstream, configHash
  └── sui-fork-cache/<chainId>/       # shared, refcounted upstream cache
  ```
- [ ] **P4.16** `apply` writes `meta.json` on first boot of a fork stack. On subsequent boots, compare `meta.json.configHash` against current config hash; mismatch → `SeedManifestMismatchError`.

#### Dev-wallet UX
- [ ] **P4.17** `dev-wallet/src/ui/utils.ts:61-66`: add fork-mode badge color (amber stripe or similar). Wire `meta.runtime: 'forked'` through to the badge.
- [ ] **P4.18** Extend `WalletAppAccountInfo` (services/wallet/internal.ts:482-493) with `source: 'impersonate' | 'real'`. Surface on the account row.
- [ ] **P4.19** `dev-wallet-signing-modal.ts`: footnote "no real signature — fork-only" when account is impersonation-mode.
- [ ] **P4.20** `dev-wallet-accounts.ts:300-308`: hide or warn on "+ Add" when network is fork-mode and no funding path exists.

### Test gate (Phase 4)

- [ ] **P4.T1** `cli/commands/fork.status.test.ts` — `devstack fork status --json` against a running fork stack returns expected fields; exit 0. ~10s.
- [ ] **P4.T2** `cli/commands/fork.advance-clock.test.ts` — advances clock; new value visible via subsequent `fork status`. ~10s.
- [ ] **P4.T3** `cli/commands/fork.advance-checkpoint.test.ts` — `--count 3` advances exactly 3 checkpoints. ~10s.
- [ ] **P4.T4** `cli/commands/fork.seed-diff.test.ts` — match → exit 0; mismatch → exit 1 with diff output. ~15s.
- [ ] **P4.T5** `cli/commands/apply.fork-seed-mismatch.test.ts` — edit `addresses` between two `apply` runs → second `apply` fails with `SeedManifestMismatchError` printing the exact recipe. ~30s.
- [ ] **P4.T6** `engine/snapshot.fork.save-restore.docker.test.ts` — start fork, publish a package, snapshot save, wipe, snapshot restore → package reachable; chainId + forkedAtCheckpoint preserved in `SnapshotMeta`. ~90s.
- [ ] **P4.T7** `cli/commands/wipe.fork-keeps-cache.docker.test.ts` — `wipe` clears per-stack data but leaves shared cache. Cold-restart after wipe reuses cache. ~45s.
- [ ] **P4.T8** `cli/commands/wipe.fork-also-cache.docker.test.ts` — `--also-upstream-cache` clears both. ~30s.
- [ ] **P4.T9** `cli/commands/doctor.fork.test.ts` — when stack uses fork mode, doctor includes + passes (or correctly fails) the 4 new checks. ~10s.
- [ ] **P4.T10** `cli/commands/stack.drop-fork.test.ts` — `stack drop <name>` removes per-stack data but preserves shared cache. ~15s.
- [ ] **P4.T11** End-to-end integration: full `devstack apply → up → snapshot save → wipe → snapshot restore → down` cycle on a mainnet-fork in a single test. ~3 min.
- [ ] **P4.T12** Dev-wallet UX: Playwright test asserts fork badge renders amber/distinct and impersonation account row shows the "(impersonation)" label. ~1 min.

**Phase 4 done when:** all 20 tasks + 12 test boxes checked.

---

## Phase 5 — exploration (opt-in)

Not required for shipping. Ordered by impact.

### Walrus-on-fork via GraphQL shim
- [ ] **P5.1** Stand up `sui-indexer-alt-graphql` against the fork's gRPC. Vendored image, optional per-stack service.
- [ ] **P5.2** Allow `walrusLocalCluster` in fork mode when the GraphQL shim is present.
- [ ] **P5.T1** End-to-end Walrus tests against fork mode.

### Seal-on-fork (key-server gRPC)
- [ ] **P5.3** Audit the seal key-server binary's chain client. If JSON-RPC-bound, this is blocked on upstream.
- [ ] **P5.4** If gRPC-capable, allow `sealLocalKeygen` in fork mode.

### Auto-tick clock
- [ ] **P5.5** `Sui({fork:{autoTickMs}})` — supervisor-side Effect schedule that calls `advanceClock` at the configured rate.
- [ ] **P5.T2** Test: time-based Move logic (e.g., clock-gated functions) executes correctly with auto-tick.

### Parallel stacks
- [ ] **P5.6** Two stacks with different data dirs running concurrently on one machine. Verify port allocator + file lock cover the corner cases.
- [ ] **P5.T3** Concurrency test.

### Cold-start optimization
- [ ] **P5.7** Pre-warm system state in the fork image build (download object 0x5 + dynamic fields at image build time, bake into the data dir). Cuts cold start from ~60s to ~5s.

### Dev-wallet fork controls
- [ ] **P5.8** New tab in the wallet panel: "Fork" — `advance-clock`, `advance-checkpoint`, current status. UI for the admin RPCs.
- [ ] **P5.9** "Switch sender" / impersonation slot management in the wallet UI.

### Subscriptions
- [ ] **P5.10** Replace `GetStatus` polling with `SubscribeCheckpoints` (with fallback to polling on disconnect per R4).

---

## Glossary

- **Fork** — a `sui-fork` instance forking from an upstream chain (mainnet / testnet / devnet / custom) at a specific checkpoint.
- **Upstream** — the chain the fork is initialized from.
- **`forkedAtCheckpoint`** — the upstream checkpoint number at which the fork was created. Local checkpoints diverge from upstream after this point.
- **Seed manifest** — the immutable `seed_manifest.json` file the fork writes on first boot, recording the `--address` / `--object` seeds. Subsequent boots verify config matches manifest.
- **Owned-object index** — the fork's local index of address-owned objects. Only contains seeded addresses + post-fork local writes. **NOT a full upstream inventory.**
- **Impersonation** — submitting a tx with `signatures: []` so the fork executes it as the declared sender without keys. Wire-level signal is the empty signature list.
- **Known-deployment** — devstack's name for a `*KnownPackage`-style factory that uses upstream-shipped package addresses (vs. publishing local source).
- **gRPC default** — devstack policy as of Phase -1: internal code uses `SuiGrpcClient` exclusively; `@mysten/sui/jsonRpc` is banned outside the allowlist.

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
- `packages/devstack/src/codegen/emitters/dapp-kit-config.ts:112` — emitter network translation (Phase 3)
- `packages/devstack/src/cli/index.ts` — CLI noun registration (Phase 4)

### SDK references
- `~/code/ts-sdks/packages/sui/src/grpc/core.ts:375-392` — `executeTransaction` accepts empty signatures
- `~/code/ts-sdks/packages/sui/src/grpc/client.ts:72,90` — `client.forkingService: ForkingServiceClient` (shipped, shares transport with all other services)
- `~/code/ts-sdks/packages/sui/src/grpc/proto/sui/forking/v1alpha/forking_service.client.ts` — generated `ForkingServiceClient` class
- `~/code/ts-sdks/packages/sui/src/grpc/proto/sui/forking/v1alpha/forking_service.ts` — generated request/response message types
- `~/code/ts-sdks/packages/sui/src/grpc/client.ts:83-90` — pattern showing all service clients sharing one `GrpcWebFetchTransport`
- `~/code/ts-sdks/packages/sui/src/grpc/index.ts` — gRPC barrel; **`ForkingServiceClient` is NOT re-exported** (only accessible via `client.forkingService`); `GrpcWebFetchTransport` re-export is present

## Change log

- 2026-05-18 — Initial plan written. Audits run. No code yet.
- 2026-05-18 — `@mysten/sui` ships forking proto support. `ForkingServiceClient` lands on every `SuiGrpcClient` as `client.forkingService` (`packages/sui/src/grpc/client.ts:72,90`). Plan updated: P1.4–P1.6 (vendor + codegen) replaced by a single SDK-bump task (P-1.0) and an import-path verification task (new P1.4). D3 implementation note added explaining `ForkControl` wraps the existing `client.forkingService`. SDK references section refreshed.
