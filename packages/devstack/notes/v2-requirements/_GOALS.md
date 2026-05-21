# devstack v2 — goals and problems

This is the **charter** for the devstack rewrite. Read this before opening any of the 24
requirements docs. It captures the why, the target shape, the failure mode this rewrite must NOT
repeat, and the constraints the design phase commits to.

The 24 numbered docs (`01-engine-core.md` through `24-examples.md`) plus `00-index.md` are the
authoritative requirements spec — what the current code DOES and DEPENDS ON. This doc is the
framing.

## Why this rewrite exists

### The current state

`packages/devstack/` is 75,486 LOC (50,715 src + 24,771 tests) across 12 top-level dirs. It is
**functional but structurally unmaintainable**:

- The "agnostic engine substrate" is not agnostic. `engine/` (31.7k LOC) mixes lifecycle
  orchestration with TUI projection, Docker container management, per-service registries,
  per-service errors, per-service snapshot paths, and Sui-specific drivers (sui-cli,
  sui-build-container, fork orchestration, chain-probe, faucet, on-chain-artifact).
- The engine's public API speaks TUI vocabulary (`markReady(display)`, `appendTagLog`,
  `setEntryTitle`). Every plugin depends on that shape, so extracting the TUI isn't a refactor —
  it's an interface redesign that touches every service.
- `engine/supervisor.ts` (2,112 lines) imports 11 service registries by name and merges them into
  the default Layer. The "agnostic supervisor" mints a context that names every service.
- `engine/errors.ts` is a junk drawer of 20 tagged errors, most service-specific.
- `engine/snapshot.ts` hardcodes per-service paths: `runtime/seal/master-key.env`,
  `runtime/walrus/<name>/deploy/`, etc.
- Docker is hard-coupled to the engine boot path — there is no container-runtime interface.

See [00-index.md § Cross-cutting findings](./00-index.md#cross-cutting-findings) for the full
inventory.

### Why targeted refactors haven't worked

Past attempts to clean things up incrementally failed because the engine doesn't have the interfaces
it would need to host plugins. **You can't extract a thing through a door that hasn't been cut.**
Every targeted refactor hits the same wall — designing the missing contract — and defers it again.

### Why a rewrite is the right call now

Three conditions are true that weren't true before:

1. **The feature set is functional and stable.** All major service capabilities work; ~25k LOC of
   tests encode the contract. The rewrite ships against a known target.
2. **The target architecture is articulated.** This doc plus [00-index.md](./00-index.md) define
   what good looks like and what every component currently requires.
3. **The lessons are recorded.** The 24 requirements docs surface dozens of cross-cutting structural
   issues — what to keep, what to delete, what to consolidate.

## The past failure mode this rewrite MUST NOT repeat

Quoting the user verbatim, from the session this corpus was produced in:

> We have tried re-building from scratch before, and it failed because we didn't design
> holistically, and we started with a good architecture, but didn't stay disciplined and hacked more
> and more in as we ran into issues.

This is the most important sentence in the whole project. The failure mode was not "wrong design."
It was:

> **Architecture wasn't pressure-tested against the gnarly cases before implementation started. So
> when the first gnarly case hit at line 4,000, an escape hatch was cheaper than re-doing the seams.
> Six escape hatches later, the architecture was gone.**

The antidote is structural, not motivational:

- **Requirements before design.** This corpus is the requirements phase. Done.
- **Design every boundary explicitly in real TypeScript before writing impl.** Compile-checks the
  seams.
- **Pressure-test the design against every gnarly case.** Hard cases below.
- **No escape hatches.** If a service can't be expressed through the contract, fix the contract.
  Don't add a `__layer` POJO bypass.
- **Machine-checkable invariants.** Lint rules / CI greps for the spirit of the architecture (engine
  doesn't import service names, no file in engine/ exceeds N lines, no hand-rolled composite POJOs).
- **Per-layer LOC budgets.** Blown budget triggers a redesign discussion, not a budget raise.

## What good looks like

### Two principles

1. **The engine knows zero service names.** No `sui`, `walrus`, `seal`, `deepbook`, `pyth`,
   `postgres`, `account`, `coin`, `package`, `wallet`, `faucet`, `action` strings or types appear in
   `engine/` code. Enforced by lint.
2. **Surfaces are symmetric.** CLI, TUI, programmable API, codegen, build-integrations all subscribe
   to a typed event stream and publish typed commands. No surface is privileged. The engine is not
   "the TUI's engine" or "the CLI's engine" — it's an engine, and all surfaces are peers.

### The five-layer target architecture

```
┌────────────────────────────────────────────────────────────┐
│ L5 CONSUMERS                                               │
│   examples/ apps   (consume the stack as users do)        │
└────────────────────────────────────────────────────────────┘
                                  ↑
┌────────────────────────────────────────────────────────────┐
│ L4 SURFACES — subscribe to events, publish commands       │
│   cli   tui   programmable-api   codegen   build-plugins  │
└────────────────────────────────────────────────────────────┘
                       events ↑   ↓ commands
┌────────────────────────────────────────────────────────────┐
│ L3 ORCHESTRATORS — coordinate plugins via capabilities    │
│   snapshot   router   watch-dispatcher                    │
│   (forking is a Sui mode, NOT a separate orchestrator)    │
└────────────────────────────────────────────────────────────┘
                       capability calls ↓ ↑ specs
┌────────────────────────────────────────────────────────────┐
│ L2 PLUGINS                                                │
│   runtimes/  docker  (host, podman, sandbox later)        │
│   services/  sui  walrus  seal  deepbook  pyth  postgres │
│              account  coin  package  faucet  wallet      │
│              action                                       │
│   renderers/ tui-renderer  plain-renderer  silent        │
└────────────────────────────────────────────────────────────┘
                       hooks/events ↑ ↓ capability calls
┌────────────────────────────────────────────────────────────┐
│ L1 RUNTIME ADAPTERS                                       │
│   (impls behind ContainerRuntime; sit between L0 and L2) │
└────────────────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────────┐
│ L0 ENGINE CORE — agnostic lifecycle substrate             │
│   node graph · scheduler · event bus · command queue      │
│   state-store · resource brokers (ports, leases, locks)   │
│   identity · paths · file-watcher · dep-graph · phases    │
│   Zero knowledge of: services, containers, TUI, networks  │
└────────────────────────────────────────────────────────────┘
```

### The plugin contracts (the seams)

Six small interfaces. Everything else is implementation.

- **`NodePlugin`** — the unit of composition.
  `{ key, kind, upstream, watch?, start(ctx): Effect<NodeHandle> }`. Services, packages, accounts,
  actions all satisfy this.
- **`ContainerRuntime`** —
  `ensureImage / ensureContainer / exec / logs / inventory / network / sweep`. Docker is one impl.
  Others (host process, podman, sandbox) become trivially addable.
- **`Snapshotable`** — `{ paths: readonly string[], serialize?: () => Effect<Bytes> }`. A node
  returns this from `start()` if it has snapshottable state. Snapshot orchestrator collects them all
  — no more hardcoded `runtime/seal/`.
- **`Routable`** — `{ hostname?, port, upstream, health? }`. A node returns these for any HTTP ports
  it wants routed. Router orchestrator collects them — no more per-service router branches.
- **`NetworkResolver`** —
  `Network = { mode: 'local' | 'live' | 'fork', chain, rpc?, source?, checkpoint? }`. Services ask
  "what network am I on?" and adapt their `start`. **Forking is just a network mode**, not a
  separate orchestrator.
- **`Codegenable`** — `{ emit(registries): Effect<ArtifactSet> }`. Codegen plugins read registries
  and write files.

### Feature → home mapping

Every feature the current devstack supports must have exactly one home in the new architecture. From
the earlier design conversation:

| Feature                           | New home                                                                    |
| --------------------------------- | --------------------------------------------------------------------------- |
| Service lifecycle                 | Engine (state machine) + service plugin (driver)                            |
| Snapshots                         | Snapshot orchestrator + each service's `Snapshotable`                       |
| Parallel stacks                   | Engine (per-stack identity + port broker + container claim labels)          |
| Localhost routing                 | Router orchestrator + each service's `Routable`                             |
| Forking                           | Service's own driver dispatched by `NetworkResolver` mode='fork'            |
| Live networks                     | `NetworkResolver` returns `live` → service's `start` returns a no-op handle |
| All services                      | L2 plugins, one folder each, self-contained                                 |
| Plugin API                        | L3 contracts (`NodePlugin` + capabilities)                                  |
| TUI                               | Renderer plugin, subscribes to event bus                                    |
| CLI                               | Surface, publishes commands                                                 |
| Codegen                           | `Codegenable` plugin, runs after relevant nodes ready                       |
| Watch / hot-restart               | Engine's file-watcher capability + watch-dispatcher orchestrator            |
| Selective restart                 | Engine's invalidate-with-cascade through dep-graph (already works)          |
| Port allocation                   | Engine capability (existing port-allocator, file-locked)                    |
| Identity / paths / leases / locks | Engine capabilities (already exist)                                         |
| Endpoints                         | Engine event (`endpoint.registered`); router/codegen subscribe              |
| Account / coin / package state    | Service plugins own their registries                                        |
| Pretty error rendering            | Renderer concern (TUI plugin), NOT engine                                   |

## Quantitative targets

### LOC budgets per layer

| Layer                                         | Today                           | Target                                |
| --------------------------------------------- | ------------------------------- | ------------------------------------- |
| L0 engine substrate (incl. tests)             | 31.7k                           | **6–8k** (75% reduction)              |
| L1 runtime adapters                           | (within engine/docker/)         | **2–3k**                              |
| L2 service plugins (12 services)              | 24.7k → ~28k after engine moves | **10–14k** (avg ~1k per service)      |
| L3 orchestrators (snapshot, router)           | ~3k scattered                   | **2–3k** consolidated                 |
| L4 surfaces (cli, tui, programmable, codegen) | ~13k                            | **4–6k**                              |
| L5 consumers (examples, build integrations)   | ~5k                             | **2–3k** after dedup                  |
| **TOTAL**                                     | **75.5k**                       | **~25k (realistic) / ~15k (stretch)** |

Realistic = 33% of current. Stretch = 20% of current (user's stated aspiration). The stretch is
reachable IF (a) speculative / dead code is aggressively cut, (b) tests testing wrong abstractions
are dropped not ported, and (c) per-service driver dedup through the plugin contract pulls its
weight.

**Discipline mechanism**: when a layer's LOC budget is exceeded during impl, the rule is _stop and
rethink the design_, not _raise the budget_. Budgets are predictions; missed predictions are
evidence.

### Machine-checkable invariants

Examples to enforce via lint plugin or CI grep:

- `engine/` files import only from `effect`, `@effect/*`, Node stdlib, and other `engine/` files. No
  imports from `services/`, `runtimes/`, `renderers/`, or any per-service name.
- No file under `engine/` exceeds N lines (TBD — likely 500-800).
- No file outside `services/` references service names (`sui`, `walrus`, `seal`, `deepbook`, `pyth`,
  `postgres`, `account`, `coin`, `package`, `wallet`, `faucet`).
- No hand-rolled `{__layer, __layers, __extraMembers}` POJO outside of an approved helper (the
  `compositeTag` or equivalent).
- Every capability requested through `NodeContext` — no module-level singletons for resources.
- Every public function ≥ 50 lines has a one-line `// why` comment (the rule isn't "comments
  everywhere"; the rule is "long thing has an obvious why").

## What's broken today (summary)

The full inventory is in
[00-index.md § Cross-cutting findings](./00-index.md#cross-cutting-findings). The 10 symptom
categories:

1. **Engine knows every service by name** — registries, errors, supervisor imports, snapshot paths,
   network types.
2. **TUI vocabulary baked into the engine's API** — `markReady(display: TuiDisplay)` couples engine
   to renderer.
3. **Cache-key shape mismatches** in 5 components (seal, package, pyth, coin, walrus) — real
   correctness risk.
4. **Composite primitives lack shared infrastructure** — 5 services hand-roll the same
   `{__layer, __layers, __extraMembers}` POJO.
5. **Dead code surfaces across components** — ~20+ specific candidates from index.
6. **Placeholder/stub test files** — 5 files that are `it.todo` or placeholder bodies.
7. **Duplicated code that should be extracted** — security hardening, log sinks, lock impls,
   dapp-kit boilerplate.
8. **Cross-process safety gap** — two concurrent `pnpm dev` invocations can stomp on each other.
9. **Documentation drift** — file headers reference files and features that don't exist.
10. **Runtime substrate is cross-cutting and underdesigned** — `src/runtime/` (2.3k LOC) touches L3,
    L4, L5 without a clear home.

## What's NOT in scope

- **Adding new features.** Rewrite to current feature parity, then evolve. Anything that's not in
  the current code or in the requirements docs is out.
- **Breaking changes to `defineDevstack()` user surface** unless they enable the architecture.
  Example apps continue to work.
- **Compat shims for unreleased APIs.** Devstack is unreleased; strip any "previous version"
  branches, vN markers, phase markers. From [memory feedback](feedback_no_compat_for_never_cases):
  "no compat for never-cases."
- **Targeted speculative additions** (new runtimes, new services, new orchestrators) until the
  substrate is proven on the existing feature set.
- **Performance optimization beyond avoiding obvious waste.** Correctness first, then perf if a
  budget is missed.

## How to use this corpus

For a fresh session starting the next phase:

1. **Read this doc first.** You're doing it.
2. **Read [00-index.md](./00-index.md) next.** It surfaces the cross-cutting findings and the
   dependency map and gives a reading order for the 24 component docs.
3. **Resolve the
   [10 critical open questions](./00-index.md#critical-open-questions-for-design-phase) at the
   bottom of the index.** Each blocks specific design work downstream.
4. **Write the plugin contract in real TypeScript** as the first concrete artifact — the six
   interfaces from § "The plugin contracts (the seams)" above, with phantom types where needed, in a
   `contracts/` folder that compiles.
5. **Port Sui on paper as the reference service.** Sui's three modes (local/live/fork) and the most
   entangled current implementation — if the contract survives Sui, it survives all the others. If
   Sui doesn't fit, grow the contract; do NOT add an escape hatch.
6. **Walk the hard-case list** below against the working contract. If any case is hand-wavy, the
   contract has a gap.
7. **Write the invariants doc.** Lint rules / CI greps that make the spirit machine-checkable. This
   is the discipline mechanism that survives the team forgetting.

### The hard-case list (must survive on paper before impl starts)

- Composite primitives with lifted siblings (today's `__extraMembers`, walrus `upstreamImage`, seal
  `sealImage`)
- Walrus's 4-shard cluster sharing one image build (dedup through the contract)
- Seal's keygen-then-deploy-once semantics (persist on first run, reuse forever)
- Sui's fork-from-live (snapshot from live RPC, boot fork container, services-in-fork inherit
  deployment data)
- Selective restart cascading through a composite (walrus source changes → which nodes invalidate)
- Parallel stacks sharing port broker + state-store namespace + container claim labels
- A live-network service depending on a local one (mixed-mode stacks)
- Hot-restart mid-TUI without losing the renderer subscription
- An action that depends on five services, runs once, then completes (scheduler treats "ready and
  done")
- An example app needing codegen artifacts before its dev server starts (codegen-as-plugin
  scheduling)
- Cross-process two-`pnpm dev` concurrent claim protection (currently a real risk)

## Open questions blocking the next phase

These must be answered before the plugin contract is written. From
[00-index.md § Critical open questions](./00-index.md#critical-open-questions-for-design-phase):

1. Composite primitives & lifted siblings — first-class or sugar?
2. Centralized vs distributed registry ownership
3. TUI ↔ engine seam (direct calls vs event bus)
4. Snapshot orchestrator or plugin-driven
5. Cross-process two-`pnpm dev` claim semantics
6. `devstack restart` semantics (CLI verb? command queue?)
7. Sysexit code propagation to OS exit code
8. Runtime substrate ownership (where does `src/runtime/` live)
9. The 14-method "proxy engine" in TUI — kill it?
10. `effect-app` and `pnpm preview` production deploy story

Each of these influences specific design decisions. Resolving them before contract design is faster
than discovering them mid-design.

## A note to the next session

This corpus exists because the user explicitly chose **requirements before design** to avoid the
past failure mode of "started clean, lost discipline, hacked in." The discipline mechanisms above
(no escape hatches, LOC budgets, lint-enforced invariants) are not aspirations — they are the
project's contract with itself.

If at any point during the next phase a decision feels like an escape hatch or a budget breach,
**stop and ask the user**. The cost of a 60-second checkpoint is much lower than the cost of
slipping back into the failure mode this rewrite exists to escape.

The 24 requirements docs are the authoritative spec for what every component currently does. They
should be treated as ground truth — if the architecture wants to drop a feature documented there,
that's a deliberate choice with a written justification, not an omission.
