# v2-requirements — index

24 component requirements documents (~21,000 lines total), extracted exhaustively from the current
`packages/devstack/` source + tests. These are the **input** to the architecture-design phase that
follows. Each doc captures what its component DOES and DEPENDS ON today — not what it should become.

> **New session? Start with [\_GOALS.md](./_GOALS.md).** It captures the rewrite charter — why this
> exists, the past failure mode this attempt must not repeat, the target architecture, the LOC
> budgets, and the discipline mechanisms.

## How to use this index

- **Doing architecture design**: read in the order under
  [Reading order for design](#reading-order-for-design).
- **Need one component**: find it in [Doc inventory](#doc-inventory).
- **Looking for cross-component patterns or known bugs**:
  [Cross-cutting findings](#cross-cutting-findings) and
  [Critical open questions](#critical-open-questions-for-design-phase) collect what emerged across
  all 24 reads.
- **Doc template**: `_TEMPLATE.md` for the shared structure every doc follows.

## Doc inventory

| #   | Doc                                              | Lines | Scope                                                                                 |
| --- | ------------------------------------------------ | ----- | ------------------------------------------------------------------------------------- |
| 01  | [engine-core](./01-engine-core.md)               | 715   | Node graph, state machine, scheduler, dep-graph, selective restart, event bus, phases |
| 02  | [engine-resources](./02-engine-resources.md)     | 1,854 | State store, ports, leases, locks, file watcher, identity, paths, cache, content-hash |
| 03  | [observability](./03-observability.md)           | 1,587 | Errors taxonomy, pretty-print, log buffer, capture-command, spans, renderer factory   |
| 04  | [runtime-docker](./04-runtime-docker.md)         | 1,015 | Docker adapter — image, ensure-container, exec, logs, inventory, network, sweep, wrap |
| 05  | [sui](./05-sui.md)                               | 698   | Sui blockchain — local/live/fork modes, CLI driver, Move build container, chain-probe |
| 06  | [walrus](./06-walrus.md)                         | 1,510 | 4-shard cluster, deploy + fingerprint, fork-known, fork-localcluster-refused          |
| 07  | [seal](./07-seal.md)                             | 585   | BLS keygen, key server, key manager, composite primitive, fork modes                  |
| 08  | [deepbook](./08-deepbook.md)                     | 747   | Pools, margin, indexer, server — 4 separate state registries                          |
| 09  | [pyth](./09-pyth.md)                             | 505   | Price feeds — pure in-process host (no container)                                     |
| 10  | [postgres](./10-postgres.md)                     | 412   | Postgres database (used by deepbook indexer)                                          |
| 11  | [faucet](./11-faucet.md)                         | 719   | Strategy registry — actual Sui faucet HTTP runs inside sui-localnet container         |
| 12  | [account](./12-account.md)                       | 505   | Per-account keypair gen, persistence, ephemeral / impersonate / fork variants         |
| 13  | [coin](./13-coin.md)                             | 911   | Custom coin minting, CoinRegistry — populated by package.publish                      |
| 14  | [package](./14-package.md)                       | 1,303 | Move publish, known-package, cache by content hash, PublishError                      |
| 15  | [wallet](./15-wallet.md)                         | 551   | HTTP signing server, token pairing, no UI in server (UI lives in vite plugin)         |
| 16  | [action](./16-action.md)                         | 373   | One-shot effect — thin adapter over `onChainArtifact` substrate                       |
| 17  | [snapshot](./17-snapshot.md)                     | 578   | Capture/restore, stage-and-swap, cross-chain guard (currently dead)                   |
| 18  | [router](./18-router.md)                         | 590   | Traefik file-provider, hostname dispatch, deliberately NOT docker-provider            |
| 19  | [codegen](./19-codegen.md)                       | 505   | Manifest emit, bindings, packages/accounts/coins/extras emitters                      |
| 20  | [cli](./20-cli.md)                               | 705   | 12 subcommands, JSON envelope, sysexits (not propagated), no `restart` verb           |
| 21  | [tui](./21-tui.md)                               | 940   | Ink dashboard, plain renderer, 15s heartbeat — 14-method proxy engine is dead         |
| 22  | [programmable-api](./22-programmable-api.md)     | 564   | defineDevstack + tag/provide + composite primitives + lifted siblings                 |
| 23  | [build-integrations](./23-build-integrations.md) | 1,317 | Vite, Vitest, Playwright, Browser, Runtime (manifest substrate, 2.3k LOC)             |
| 24  | [examples](./24-examples.md)                     | 1,636 | 9 example apps; `pnpm dev` → `devstack up` (NOT `vite dev`)                           |

**Total**: 20,925 lines of requirements documentation across 24 components.

## Reading order for design

The order minimizes "I need to know about X first" interruptions.

1. **`22-programmable-api`** — the user-facing surface. Drives what every other component must
   support.
2. **`01-engine-core`** + **`02-engine-resources`** + **`03-observability`** — the substrate.
   Determines what plugins get for free.
3. **`04-runtime-docker`** — the container adapter. Becomes one impl behind a `ContainerRuntime`
   interface.
4. **`05-sui`** — the most entangled service. If the new plugin contract survives Sui's three modes,
   it survives everything.
5. **`06-walrus`** + **`07-seal`** + **`08-deepbook`** — composite primitives with lifted siblings,
   cluster topology, multi-registry surface. Pressure-tests the composite story.
6. **`17-snapshot`** + **`18-router`** + **`19-codegen`** — cross-cutting orchestrators. Each
   currently hardcodes per-service knowledge; the design phase decides whether they become
   plugin-driven.
7. **`20-cli`** + **`21-tui`** — surfaces. Should be pure subscribers to engine events / publishers
   of commands.
8. **`23-build-integrations`** + **`24-examples`** — consumers. Define the outward-facing contract
   the rest of the design must serve.
9. **Smaller services** (`09-pyth`, `10-postgres`, `11-faucet`, `12-account`, `13-coin`,
   `14-package`, `15-wallet`, `16-action`) — read alongside their primary integrations as needed.

## Dependency map

L0 (substrate) ← L1 (runtime) ← L2 (services) ← L3 (orchestrators) ← L4 (surfaces) ← L5 (consumers).

```
L5 consumers          24-examples
                          │
L4 surfaces        20-cli       21-tui       22-programmable-api
                     │            │                    │
L3 orchestrators    17-snapshot       18-router       19-codegen
                            │             │              │
L2 services    05-sui  06-walrus  07-seal  08-deepbook  09-pyth  10-postgres
               11-faucet  12-account  13-coin  14-package  15-wallet  16-action
                                              │
L1 runtime                       04-runtime-docker
                                              │
L0 substrate    01-engine-core   02-engine-resources   03-observability
```

**Cross-cutting consumer:** `23-build-integrations` (Vite/Vitest/Playwright/runtime/) sits across
L4–L5; the `runtime/` manifest substrate inside it is consumed by L3 orchestrators and L4 surfaces.

**Within-layer dependencies that matter:**

- Sui (05) is the foundation chain for every other service in L2
- Account (12) depends on Sui + Faucet (11) for funding
- Coin (13) depends on Account + Package (14) for minting infrastructure
- Wallet (15) depends on Account for keypairs
- Deepbook (08) depends on Sui + Postgres + Pyth
- Walrus / Seal / Deepbook all have `fork-known` modes that depend on Sui being in fork mode first

## Cross-cutting findings

What emerged across multiple docs. **These should inform every architecture decision below — they're
the symptoms a clean redesign must address by design, not by patch.**

### 1. Engine knows about every service by name

The "agnostic substrate" isn't agnostic today:

- `engine/registries.ts` declares 14 service-specific registries (Account, Coin, Package, Sui, Seal,
  Walrus, Deepbook, DeepbookIndexer, DeepbookServer, DeepbookMargin, Pyth, Postgres, plus endpoint
  registries) and exports a `RegistriesLive` that merges them all. Engine boot mints a context
  naming every service. _(02, 03, plus every service doc)_
- `engine/errors.ts` is a junk drawer of 20 tagged errors, most service-specific (SuiError,
  WalrusError, SealError, DeepbookError, DeepbookIndexerError, DeepbookServerError, PythError,
  PostgresError, AccountError, PublishError, WalletAppError, ForkUnsupportedError,
  ForkIncompatibleError, SeedManifestMismatchError, HostProcessError, ConfigLoadError,
  Manifest*Error, DockerError). *(03)\*
- `engine/supervisor.ts` imports all 11 service registries by name at lines 75-86 and merges them in
  the default layer at 349-363. _(01)_
- `engine/snapshot.ts` hard-codes per-service paths: `runtime/seal/master-key.env`,
  `runtime/walrus/<name>/deploy/`, `runtime/accounts/<name>.key`, `runtime/wallet/token`. _(17)_
- `engine/network.ts` is entirely `SuiNetwork`-shaped. _(05)_
- Shutdown grace numbers are hard-coded per service in `supervisor.ts` comments (sui=30s,
  walrus=20s, seal=15s). _(01)_

### 2. TUI vocabulary is baked into the engine's API

- `EngineHandle.markReady(name, display?: TuiDisplay)` — engine's lifecycle API takes a TUI
  projection. _(01)_
- `EngineHandle.markAcquiring/setPhase/setEntryTitle/appendLog/appendTagLog` all speak TUI rows.
  _(01, 03)_
- TUI consumes the engine via direct method calls on a prop-passed `EngineHandle` — there's no event
  bus today. _(21)_
- A 14-method "proxy engine" wrapper exists in `tui/index.ts` whose per-cycle-swap purpose is dead.
  _(21)_
- `engine/tui-state.ts` data shapes (`TuiState`, `TuiEntry`, `TuiHeader`, `TuiLog`) live in
  `engine/` but are pure renderer state. _(01, 03, 21)_

### 3. Cache-key shape mismatches (potential correctness bugs)

Five separate components have parallel cache-key schemes where the `state-store-keys.ts` builder
doesn't match production usage:

- **seal**: `state-store-keys.ts:64-78` builders omit `inputsHash` vs inline `buildCacheKey(...)` in
  `seal/internal.ts:622-631`. One path is wrong; either helpers are dead or production is. _(07)_
- **package**: `StateStoreKeys.publishMove` has zero non-test callers — its test guards a contract
  no one uses. Production uses `onChainArtifact` + `withCache` with a different key shape. _(14)_
- **pyth**: `StateStoreKeys.pythPackage` / `pythPusher` builders don't match actual
  `contentHash`-folded keys produced by `onChainArtifact`. Likely dead code. _(09)_
- **coin**: `services/coin.ts:388` builds the `coin/mint/...` key inline rather than via
  `StateStoreKeys.coinMint(...)`. Duplicate literal. _(13)_
- **walrus**: wrapper image content hash inputs don't include Move source — potential staleness when
  contracts change but image base doesn't. _(06)_

**This is exactly the kind of drift that a clean state-key system with single-source-of-truth
derivation would prevent by design.**

### 4. Composite primitives lack shared infrastructure

`walrus`, `seal`, `sui-localnet`, `postgres`, `deepbook` all hand-roll the SAME POJO field set:

```ts
{
	(__layer,
		__layers,
		__extraMembers,
		key,
		__kind,
		__pluginName,
		__displayTitle,
		__upstreamKeys,
		__watchPaths);
}
```

…because `withEngineLifecycle` only wraps single-shape `Effect<A>`, not multi-tag projections. The
field set is load-bearing for the dep graph, TUI sectioning, and selective restart — drift is
silent. No `compositeTag({...})` helper exists. _(22, plus 05/06/07/08)_

Side effect: deepbook owns 4 state registries (`runtime/service.ts:164-168` already comments this as
a wart). Walrus has 4-shard deploy logic that reimplements port allocation patterns each shard. Seal
projects two narrow tags from a closure-bound private `Internal` service.

### 5. Dead code surfacing across components

Direct candidates for deletion in the rewrite (or earlier):

- `markAllReady` may be unused _(01)_
- `depTreeLevels` field on `TuiState` defined but never populated _(01, 21)_
- `TuiState.endpoints` top-level array unused (per-entry `TuiEntry.endpoints` is the actual surface)
  _(21)_
- shadow-cache in engine is workaround for missing Effect MemoMap eviction _(01)_
- `displayPath` lives in `engine/` but consumed only by codegen _(02, 19)_
- `ManifestShapeError` omitted from test inventory walker _(03)_
- `StateStoreKeys.publishMove` / `pythPackage` / `pythPusher` / `coinMint` builders mostly dead
  _(09, 13, 14)_
- `STATE_KEY_PUSHER_PREFIX_INTERNAL` export has no callers _(09)_
- `pythMid` (226 LOC) may be entirely dead _(09)_
- `CoinMetadataLoaderLive` exported with no in-production consumers _(13)_
- `'register-coins'` PublishPhase enum entry is dead _(14)_
- 14-method "proxy engine" wrapper in `tui/index.ts` is dead infrastructure _(21)_
- `getTraefikRouterIp` + memoization machinery has zero in-tree consumers _(18)_
- `DEVSTACK_DIRECT_PORTS` JSDoc'd at `docker/core.ts:182` but never read _(18)_
- Cross-chain guard at `snapshot.ts:710-725` — engine has it, CLI never wires `expectedChainId`;
  dead in production _(17)_
- `stageAndSwap` exists and is tested but `restore()` uses non-atomic `rm + mkdir + tar -x`
  _(17, 19)_
- `dockerOneShot` + `hostScript` primitives scheduled for sunset 2026-11-19 with zero in-tree
  callers _(22)_
- `setup-devstack.ts` referenced in vitest header doesn't exist _(23)_
- Sysexit codes emitted into the JSON envelope but never propagated to OS exit code (`main.ts:43`
  always returns 1) _(20)_

### 6. Placeholder / stub test files

Five test files that the architecture phase must decide to implement or delete:

- `engine/fork.e2e.docker.test.ts` — 20-line placeholder, just asserts
  `RUN_FORK_DOCKER_TESTS === '1'` _(05)_
- `engine/snapshot.fork.docker.test.ts` — 30-LOC stub, references nonexistent meta fields _(17)_
- `engine/snapshot-deepbook.docker.test.ts` — 50 LOC of `it.todo` _(08, 17)_
- `services/action.fork.docker.test.ts` — 22-line placeholder body _(16)_
- `services/postgres.docker.test.ts` — referenced in `postgres.ts:3-5` header but does NOT exist;
  "Phase-5 integration sweep" deferred _(10)_

### 7. Duplicated code that should be extracted

Same logic, multiple sites:

- **3 lock implementations** share 90% code _(02)_
- **`state-store` + `service-paths`** duplicate path resolution _(02)_
- **`containerBuildCmd`** (sui-cli.ts:274) + **`runBuildInside`** (sui-build-container.ts:543)
  duplicate awk-staging + Move.lock scrub + HIGH-R5 security hardening ~50 LOC each _(05)_
- **Sui's embedded Postgres sidecar** (services/sui.ts:119-137, 515-566, 776-784, 899-945)
  duplicates ~70 LOC of generic `Postgres()` machinery _(05, 10)_
- **`makeOutputLineSink`** identical bytes in `walrus/deploy.ts:53-65` and `walrus/nodes.ts:46-58`
  _(06)_
- **`DEVSTACK_LOG_LEVEL` parsing + secret-redaction** duplicated across seal and walrus _(06, 07)_
- **8+ hand-rolled** `JSON.stringify`+sort+tab patterns across 4 codegen emitters _(19)_
- **`publishRouterRoute(...)`** helper missing — wallet (`internal.ts:213-245`) and dev/hostProcess
  (`internal.ts:316-356`) duplicate ~30-line YAML+finalizer+entrypoint blocks _(15, 18)_
- **~600 LOC of dapp-kit boilerplate** duplicated across 7 example apps _(24)_
- **Three places define endpoint metadata** (`endpoint-names.ts` declaration, `service.ts` grouper,
  `read-stack-context.ts:96-115` flat table) _(23)_
- **`gatherManifest()` + `ExtrasResolved`** resolved 3× per cycle by codegen _(19)_
- **Triple-mirrored `LocalPackage` shape** (TS interface + Schema + structural type guard with
  hand-rolled compile-time assertion) _(14)_

### 8. Cross-process safety gap (real risk)

Two concurrent `pnpm dev` invocations of the same app can both **adopt** the same containers
(reuse-if-image-matches works), but the second invocation registers a `docker stop` finalizer that
fires on its own scope close — potentially stopping containers the first process is still using.
Per-name semaphores cover in-process; docker `--name` atomicity covers create races; orphan sweep is
gated. The two-processes-adopting case has no apparent protection. _(04)_

### 9. Documentation drift (file/feature comments don't match code)

- `services/coin.ts` references `notes/coin-auto-discovery.md` — absent (deleted completed plan)
  _(13)_
- `services/postgres.ts:3-5` references `postgres.docker.test.ts` — doesn't exist _(10)_
- Postgres factory header claims a state-store cache that isn't implemented _(10)_
- `account.ts` documents on-disk path in 3 places; 2 reference wrong `.keys/` instead of
  `runtime/accounts/` _(12)_
- `engine/docker/router.ts:35-39` claims a `docker stop` finalizer that doesn't exist in code _(18)_
- `engine/engine.ts:322` comment references `accounts({...})` composite factory that doesn't exist
  as an API _(01, 12)_
- `vitest/index.ts:20` references `../playwright/setup-devstack.ts` — file doesn't exist _(23)_

### 10. Runtime substrate is cross-cutting and underdesigned

`src/runtime/` (2,283 LOC) is genuinely cross-cutting — a manifest produce/consume substrate sitting
between the supervisor (writes via `emitManifest`) and every reader (Playwright `webServer`, Vite
alias-target, CLI `status` / `manifest` / `fork`, codegen `gatherManifest`, services consuming
`EndpointName`). It's filed under build-integrations but doesn't fully belong there. _(23)_

## Critical open questions for design phase

These are decisions the architecture phase must answer **before** writing the plugin contract. Each
blocks specific design work downstream.

1. **Composite primitives & lifted siblings — first-class or sugar?** Today
   `walrus`/`seal`/`deepbook`/`postgres` hand-roll `{__layer, __layers, __extraMembers}` POJOs that
   participate in dep-graph + sectioning + selective restart. Does the new contract make these
   first-class (a `compositeTag` helper), or push composition out to the user? _(22)_

2. **Centralized vs distributed registry ownership.** Current: `engine/registries.ts` declares every
   service registry. Future: each service plugin declares its own. But codegen reads them all — does
   it iterate a meta-registry, or each plugin declares its own codegen contribution? _(02, 19, 22)_

3. **TUI ↔ engine seam.** Direct method calls today. Should the engine emit a typed event stream and
   TUI subscribe? Same question for CLI/snapshot/codegen subscribers. _(01, 21)_

4. **Snapshot — orchestrator or plugin-driven?** Today snapshot.ts hardcodes per-service paths.
   Future: each service declares a `Snapshotable` capability (`{paths, serialize?}`) and an
   orchestrator walks ready nodes. But who owns the cross-chain guard, the resume verification, the
   manifest sidecar? _(17, plus every service)_

5. **Cross-process two-`pnpm dev` claim semantics.** No protection today. Design choice: per-process
   container labels? File-locked claim registry? Refuse concurrent adoption? _(04)_

6. **`devstack restart` semantics.** No CLI verb exists today; the closest is `stack down` + SIGUSR2
   to the supervisor pid. Should `restart` be CLI-side, engine command-queue based, or stay implicit
   via the file watcher? _(01, 20)_

7. **Sysexit code propagation.** `main.ts:43` always returns 1 on failure; JSON envelope carries the
   real code. CI agents that branch on numeric exit code see only success/fail. Fix in CLI rewrite
   or design around it? _(20)_

8. **Runtime substrate ownership.** `src/runtime/` is 2.3k LOC of manifest produce/consume that
   touches L3, L4, L5. Is it part of the engine, a peer module, or a separate package? _(23)_

9. **The 14-method "proxy engine" in TUI.** Originally for per-cycle engine swaps; that purpose is
   dead. Cull entirely in the rewrite, or is there a latent reason to preserve? _(21)_

10. **`effect-app` and `pnpm preview` for production deploy.** Example apps don't document a
    release/deploy story; `dapp-kit-config.ts` would bake a wallet bearer token into a built bundle.
    Is this a known limitation, or is there an intended pattern not yet codified? _(24)_

## What's next

The architecture-design phase consumes this corpus. Recommended sequence:

1. **Resolve the 10 critical open questions above.** Each unlocks specific design work.
2. **Write the plugin contract in real TypeScript** (the `NodePlugin`, `ContainerRuntime`,
   `Snapshotable`, `Routable`, `NetworkResolver`, `Codegenable` interfaces from the architecture
   sketch).
3. **Port Sui as the reference service** on paper, against the contract — Sui's three modes
   pressure-test almost every seam.
4. **Walk the gnarly cases** in the architecture sketch's hard-case list (composite primitives with
   lifted siblings, walrus 4-shard dedup, seal keygen-then-deploy, fork-from-live, selective restart
   through composites, parallel stacks).
5. **Invariants doc.** Lint rules / CI greps for "engine doesn't import service names", "no file in
   engine/ exceeds N lines", "no composite POJO outside `compositeTag`", "every capability requested
   through NodeContext".

If any of the 10 open questions don't have clear answers from this corpus, that's a gap requiring
additional reading or a deliberate design call — flag it before starting the contract.
