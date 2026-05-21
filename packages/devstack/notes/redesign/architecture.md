# Devstack — architecture design (Phase 2)

## Overview

The new devstack is a **plugin-supervised lifecycle substrate** with five strict layers and exactly
**nine capability contracts**. The engine is a topological scheduler over a graph of opaque plugin
instances. It never names a service, never speaks a renderer's vocabulary, never opens a socket,
never writes a file outside its own state directory. Everything concrete — containers, processes,
on-chain transactions, file emission, snapshot tar streams, HTTP routing — lives in plugins that
satisfy small capability contracts.

Plugins fall into two structural kinds: **leaf plugins** (one schedulable unit, one resolved value,
optionally one running resource) and **composite plugins** (one supervisor row, N inner participants
including lifted siblings that the scheduler sees at level zero). Both kinds run through identical
lifecycle code; the leaf/composite distinction is a shape property, not a separate scheduler.

Surfaces (CLI, TUI, programmable API, codegen, build integrations) are all peers. None calls into
the engine directly; all of them subscribe to a **typed event stream** of lifecycle facts and
publish onto a **typed command channel** of intent. Codegen is one such surface, emitting on
idempotent ticks driven by `ready` events. The TUI is a renderer subscribing to a projection of the
event stream; if it is swapped or remounted, the engine never notices.

Forking is a network mode, not an orchestrator. Snapshots are an orchestrator that walks a registry
of `Snapshotable` participants — no service paths in its code. Routing is an orchestrator that walks
a registry of `Routable` participants — no service names in its code. The on-chain-artifact
discipline (cache → verify → produce → register) that recurs across seven services becomes a single
shared **OnChainArtifactPublisher** primitive callable from any plugin.

The package boundary is sharp: a single runtime substrate package exposes the engine, the capability
contracts, and one reference implementation per contract; service plugins live in their own folders
that import only the contracts; codegen output is the sole import surface for example apps.
Simplicity is not aspirational — it falls out of removing four classes of duplication (locks,
atomic-writes, path-resolvers, log-sinks), one class of escape hatch (the
`__layer/__layers/__extraMembers` POJO), and one entire vocabulary inversion (`markReady(display)`).

---

## Layer model

Six layers (L0–L5). The synthesis used the same numbering; this design keeps it.

### L0 — substrate primitives

**Purpose.** Pure, name-free, mostly-pure-Effect plumbing the rest of the system stands on. The
engine kernel.

**What's in it.**

- Node graph + topological scheduler with level-batched parallelism.
- Lifecycle state machine (pending → acquiring → ready | failed; long- running primitives gain
  stopping/stopped; one-shots collapse ready to done).
- Typed event bus (lifecycle facts) and typed command channel (intent).
- Scope, fiber, and parallel-strategy teardown helpers.
- File watcher with built-in minimatch filter + 250ms debounce + content-hash dedup (thick watcher;
  see Tension 15).
- Identity (`{ app, stack, network }`) — validated once at boot, threaded as Context.
- Path resolver (state-dir, runtime-dir, snapshot-catalog, port-broker dir, lock dir) — single
  source for env > config > default precedence.
- Resource brokers: port broker, lease broker (per-key fair semaphore), lock broker (in-process +
  cross-process, one impl, two facades).
- Atomic write primitive (tempfile + rename; one impl).
- Cache primitive (content-addressed key → bytes; lookup, write, GC).
- State store (typed per-stack persistent KV; cache and snapshot are separate stores).
- BigInt-safe JSON codec.
- Error taxonomy primitives (engine-level tags only: scheduling, resource exhaustion, identity,
  cancellation). Service-specific errors do NOT live here.
- Observability primitives: structured log buffer, span/annotation conventions, cause walker (shared
  with renderers, not duplicated).
- Strategy-registry primitive (capability-keyed pub/sub map).

**What's NOT in it.** Any service name (lint-enforced). Any renderer concept (`title`, `primary`,
`extras`, `selectiveRestart`). Any container/process/network/HTTP/codegen concept. Any module-level
mutable state (per-name locks, attached-followers caches, IP-readback memo — all become typed
Context Refs).

**Allowed dependencies.** `effect`, `@effect/*`, Node stdlib.

**Complexity posture.** L0 substrate should be small enough that any contributor can read it
end-to-end in an afternoon. The hardest pieces are the scheduler, the thick watcher, the
cross-process lock + roster protocol, and the typed event/command channels; if any single one of
these starts feeling like its own subsystem, the diagnosis is "extract a primitive," not "add code
to L0."

### L1 — runtime adapters

**Purpose.** Backends that manage processes / containers / hosted-VM- images / in-process fibers,
plus the reverse-proxy backend that fronts them. One generic adapter interface per backend kind.

**What's in it.**

- `ContainerRuntime` interface plus one reference implementation (Docker today). Stub plumbing for
  podman / host-process / sandbox is not built but is not foreclosed.
- `InProcessRuntime` — peer to `ContainerRuntime`. Trivial: scope- bounded fiber that resolves to a
  value. Deepbook's internal Pyth feed module, Faucet's strategy dispatcher, Account, Action all run
  on it.
- `ReverseProxyRuntime` interface plus one reference implementation (Traefik). Separate from
  `ContainerRuntime` (see Tension under Tensions section below).
- Image build primitive (content-addressed digest, push to a layer- cache, short-circuit on hit).
- Shared per-line streaming sink with level promotion (WARN/ERROR marker normalization). This used
  to live duplicated in walrus / seal / deepbook log glue; it's a single shared utility here.
- Signal-forwarding entrypoint shell image template (shared Dockerfile template that Sui / walrus /
  seal / deepbook all reference).
- Network attach + bounded retry for IP-readback.
- Pause/commit/save/load/tag operations expressed as `ContainerRuntime` methods (consumed by the
  snapshot orchestrator).

**What's NOT in it.** Service knowledge (knows images/containers/ networks/labels, not Walrus/Sui).
Snapshot orchestration (exposes pause/commit primitives; orchestrator drives). Routing logic (writes
dispatch files when told; orchestrator decides). Module-level mutable state — `ATTACHED_FOLLOWERS`,
`traefikRouterIpCache`, per-name lock map all become typed Context Refs supplied by L0.

**Allowed dependencies.** L0, `dockerode` (or equivalent), `effect`.

**Complexity posture.** L1 is mostly thin adapters around external backends (Docker, Traefik) plus a
handful of shared primitives (log-sink, signal-shell template, image build). The Docker adapter is
the largest piece by necessity; everything else should read like a straightforward wrapper. If a
non-Docker adapter starts approaching the Docker adapter's weight, that's the signal a substrate
primitive is missing in L0.

### L2 — plugins (services and renderers)

**Purpose.** All concrete service drivers and all renderer implementations. This is the only layer
that knows a service exists.

**What's in it.**

- Service plugin folders: sui, walrus, seal, deepbook, postgres, account, coin, package, wallet,
  faucet, action. One folder each, each conforming to `NodePlugin`. Pyth is an internal module of
  the deepbook plugin (price-feed implementation detail), not a top-level plugin — promote to peer
  plugin only if external market-makers surface a need.
- Renderer plugins: TUI (Ink), plain (line-printer), silent. Each satisfies a `Renderer` contract:
  subscribe to event stream, mount, flush. The TUI loses its 14-method "proxy engine" entirely.
- Per-plugin tagged errors. Live next to the plugin that throws them; the central cause walker
  doesn't know they exist.
- Per-plugin Snapshotable, Routable, NetworkResolver-mode, Codegenable, StrategyContributor
  capability declarations.
- The on-chain-artifact discipline used via the `OnChainArtifactPublisher` primitive — plugins call
  it; they don't reimplement it.

**What's NOT in it.** Other services' internals (Plugin A imports contracts, not Plugin B's source;
cross-plugin contributions go through scope-local strategy registries or capability slots). Renderer
vocabulary in services (services emit lifecycle facts; renderers project).

**Allowed dependencies.** L0, L1, `effect`, the service's own SDK. Plugin A may NOT import from
Plugin B.

**Complexity posture.** A typical L2 service plugin should be expressible as a single file (or a
small handful) — its acquire procedure plus its capability declarations. Sui is the heaviest because
it drives three network modes; its substrate-of-substrate role moves into L0/L1 + the ChainProbe
contract so the remaining surface is plugin-shaped, not engine-shaped. If a service plugin starts
needing its own state machines, lifecycle hooks, or cross-plugin wiring beyond capability decls, the
leak belongs in L0 or a capability contract — not in the plugin.

### L3 — orchestrators

**Purpose.** Coordinate plugins via capabilities. Each orchestrator walks a registry of plugin
contributions; never names services.

**What's in it.**

- **Snapshot orchestrator** — collects all `Snapshotable` decls, pauses managed containers via
  runtime, runs quiescence hooks, commits, exports tar (host-tree + container images + metadata
  slice), atomic stage-and-swap for restore, identity-guard fires before any destructive mutation.
- **Router orchestrator** — collects all `Routable` decls, mints hostnames from
  `(app, stack, dispatch-id)`, writes file-provider dispatch files atomically, reads IPs from the
  runtime adapter with bounded retry.
- **Watch dispatcher** — collects all plugin `watch` declarations, receives watcher events from L0
  (which already debounced + dedup'd), triggers selective restart through the scheduler's
  invalidate-with- cascade.
- **Network resolver** — single resolver consulted by every plugin; resolves once per acquire from
  CLI > env > config > default; returns `{ mode, chain, rpc?, source?, checkpoint? }`. Live networks
  expose a trivially-succeeding funds-ready gate.
- **Manifest writer** — driven by lifecycle events on the event stream; gathers from plugin-emitted
  Codegenable+endpoint declarations; one atomic write; one slow-tick repeater for late
  registrations; one flush-on-scope-close. Manifest schema lives in L0.

**What's NOT in it.** Service names (lint-enforced). Hardcoded paths (route through L0's path
resolver). Direct plugin imports (orchestrators read from typed registry Context entries).

**Allowed dependencies.** L0, L1. May not import L2.

**Complexity posture.** Each orchestrator should fit on a page or two of code: walk a capability
registry, do the cross-cutting work, emit events. If one starts branching on service names (or
service-shaped discriminators), the orchestrator has acquired knowledge that belongs on the plugin
side as a capability declaration.

### L4 — surfaces

**Purpose.** Where humans and tools touch devstack. All surfaces are symmetric peers: they subscribe
to the typed event stream and publish typed commands.

**What's in it.**

- CLI — argv → command, lifecycle event → envelope, exit code from envelope severity.
- TUI renderer — Ink mount, subscribes to event stream, presents rows/columns.
- Programmable API — exposes the same event stream + command channel as a library surface.
- Codegen — subscribes to `ready`/`endpoint.registered`/etc. events, walks plugin Codegenable decls,
  writes files atomically with byte- determinism.
- Build integrations (Vite/Vitest/Playwright/browser-bundle helpers) — pure readers of manifest +
  key files + env vars + a typed global bridge slot. NO engine subscription. They consume codegen
  output and the on-disk manifest.

**What's NOT in it.** Direct engine method calls (CLI/TUI/API route through the command channel; no
"proxy engine"). Plugin-author-only escape hatches.

**Allowed dependencies.** L0 (events/commands/manifest schema), L3 (Codegenable decls; manifest
writer output). No direct L2 imports.

**Complexity posture.** Every surface is "subscribe to events, publish commands" plus a thin
projection. The CLI is the heaviest because it owns argv parsing and exit-code shaping; other
surfaces should look small next to it. If a surface starts duplicating engine logic — its own
scheduler, its own lifecycle bookkeeping — the symptom is a missing event or command type, not a
surface that needs to grow.

### L5 — consumers (example apps)

**Purpose.** Apps consuming the stack as users do. They never import the engine. They import codegen
output and build-integration helpers.

**What's in it.**

- Example apps (wallet demo, deepbook UI, walrus demo, seal demo, fullstack demo). Pyth surfaces
  through the deepbook example, not as a standalone demo.
- A small shared `examples/_shared/` for the four duplications listed in the synthesis
  (useSignAndExecute, dapp-kit.ts, main.tsx, Wallet options bag).

**What's NOT in it.** Engine internals (lint-enforced: examples may not import from L0-L3). Per-app
reimplementations of useSignAndExecute, dapp-kit, main shell — the shared module owns them.

**Allowed dependencies.** L4 (codegen output, build-integration helpers), public SDKs.

**Complexity posture.** Examples consume codegen output and build-integration helpers; they should
read like ordinary user applications, with the only devstack-specific code being the shared
boilerplate in `examples/_shared/`. If an example needs to reach for engine internals, the
build-integration surface is missing something.

---

## Component placement

Every component named in the synthesis, placed in a layer. **R** = reference implementation (the one
we ship); **C** = capability contract (a seam third parties can implement); **S** = substrate (no
plugin contract needed; it's just engine plumbing).

| Component                                                                                                        | Layer | Kind                                                                | Notes                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01 engine core (scheduler, dep-graph, lifecycle SM)                                                              | L0    | S                                                                   |                                                                                                                                                                                                                                                                                                                                                                                                     |
| 02 engine resources (paths, identity, port broker, leases, locks, file-lock, state-store, watcher, atomic-write) | L0    | S                                                                   | Three locks / three atomic-writes / three path-resolvers consolidated to one each.                                                                                                                                                                                                                                                                                                                  |
| 03 observability (logs, spans, cause walker)                                                                     | L0    | S                                                                   | Cause walker is shared between engine and renderers; no engine-only duplicate.                                                                                                                                                                                                                                                                                                                      |
| Event stream / command channel                                                                                   | L0    | S                                                                   | Typed; one shape; surfaces subscribe / publish.                                                                                                                                                                                                                                                                                                                                                     |
| OnChainArtifactPublisher                                                                                         | L0    | S                                                                   | Cache + verify + produce + register. Pure substrate; no service names.                                                                                                                                                                                                                                                                                                                              |
| Strategy-registry primitive                                                                                      | L0    | S                                                                   | Generalized faucet pattern.                                                                                                                                                                                                                                                                                                                                                                         |
| Per-stack registries (Package, Coin)                                                                             | L0    | S                                                                   | One `Context.Service` per stack scope (`PackageRegistryService`, `CoinRegistryService`). All package / coin plugins in a stack yield the SAME instance via Context, so two `localPackage(...)` calls share one registry and warm-restart verify reuses the previous packageId as a hint. Service-name-blind: the registry types are generic maps of plain records (no plugin imports in substrate). |
| Manifest envelope + endpoint-declaration shape                                                                   | L0    | S                                                                   | Envelope is name-blind: identity tuple, manifestVersion, and an open `services: Record<PluginKey, unknown>` slot. The typed per-service projection is each plugin's responsibility (see Decision §11).                                                                                                                                                                                              |
| 04 runtime docker                                                                                                | L1    | R(C: `ContainerRuntime`)                                            | Docker is the reference impl.                                                                                                                                                                                                                                                                                                                                                                       |
| In-process runtime                                                                                               | L1    | R(C: `InProcessRuntime`)                                            | Peer to container runtime.                                                                                                                                                                                                                                                                                                                                                                          |
| Reverse-proxy runtime (Traefik)                                                                                  | L1    | R(C: `ReverseProxyRuntime`)                                         | Separate interface from `ContainerRuntime`.                                                                                                                                                                                                                                                                                                                                                         |
| 05 sui                                                                                                           | L2    | R(C: `NodePlugin`, modes via `NetworkResolver`)                     | Drives local/live/fork.                                                                                                                                                                                                                                                                                                                                                                             |
| 06 walrus                                                                                                        | L2    | R(`NodePlugin` composite + `Snapshotable` + `Routable`)             |                                                                                                                                                                                                                                                                                                                                                                                                     |
| 07 seal                                                                                                          | L2    | R(`NodePlugin` composite + `Snapshotable` + `Routable`)             |                                                                                                                                                                                                                                                                                                                                                                                                     |
| 08 deepbook                                                                                                      | L2    | R(`NodePlugin` composite + `Routable`)                              | Pyth lives inside deepbook as an internal price-feed module (in-process), not a top-level plugin. Promote only if external market-makers surface a need.                                                                                                                                                                                                                                            |
| 10 postgres                                                                                                      | L2    | R(`NodePlugin` + `Snapshotable` + `Routable`)                       |                                                                                                                                                                                                                                                                                                                                                                                                     |
| 11 faucet                                                                                                        | L2    | R(`NodePlugin`, in-process runtime, `StrategyContributor` consumer) | One dispatch path; auto-mounted strategies same path.                                                                                                                                                                                                                                                                                                                                               |
| 12 account                                                                                                       | L2    | R(`NodePlugin`, in-process)                                         | Per-address sign serialization is an L0 lease primitive.                                                                                                                                                                                                                                                                                                                                            |
| 13 coin                                                                                                          | L2    | R(`NodePlugin`, in-process)                                         | Coin discovery + metadata enrichment lives HERE, not Package.                                                                                                                                                                                                                                                                                                                                       |
| 14 package                                                                                                       | L2    | R(`NodePlugin` + `Codegenable`)                                     | Move publish; KnownPackage seed-object self-registration via typed registry.                                                                                                                                                                                                                                                                                                                        |
| 15 wallet                                                                                                        | L2    | R(`NodePlugin` + `Routable`)                                        | One options bag; one URL with redaction projection.                                                                                                                                                                                                                                                                                                                                                 |
| 16 action                                                                                                        | L2    | R(`NodePlugin` one-shot)                                            | Specialization of OnChainArtifactPublisher with no `register` step.                                                                                                                                                                                                                                                                                                                                 |
| TUI renderer                                                                                                     | L2    | R(C: `Renderer`)                                                    | 14-method proxy gone; subscribes to projection.                                                                                                                                                                                                                                                                                                                                                     |
| Plain renderer                                                                                                   | L2    | R(`Renderer`)                                                       |                                                                                                                                                                                                                                                                                                                                                                                                     |
| Silent renderer                                                                                                  | L2    | R(`Renderer`)                                                       |                                                                                                                                                                                                                                                                                                                                                                                                     |
| 17 snapshot                                                                                                      | L3    | R                                                                   | Walks `Snapshotable` decls; one orchestrator, no service paths.                                                                                                                                                                                                                                                                                                                                     |
| 18 router                                                                                                        | L3    | R                                                                   | Walks `Routable` decls; one orchestrator, no service hostnames hardcoded.                                                                                                                                                                                                                                                                                                                           |
| Watch dispatcher                                                                                                 | L3    | R                                                                   | Reads plugin watch decls; triggers invalidate-with-cascade.                                                                                                                                                                                                                                                                                                                                         |
| `NetworkResolver` consultation                                                                                   | L3    | R                                                                   | One resolver; every plugin asks.                                                                                                                                                                                                                                                                                                                                                                    |
| Manifest writer                                                                                                  | L3    | R                                                                   | Producer of the on-disk manifest.                                                                                                                                                                                                                                                                                                                                                                   |
| 20 cli                                                                                                           | L4    | R                                                                   | Argv → commands; events → envelopes.                                                                                                                                                                                                                                                                                                                                                                |
| 21 tui (mount + state ref + command pub)                                                                         | L4    | R                                                                   | Lives in surfaces; renderer plugin lives in L2.                                                                                                                                                                                                                                                                                                                                                     |
| 22 programmable API                                                                                              | L4    | R                                                                   | Mirrors CLI command set.                                                                                                                                                                                                                                                                                                                                                                            |
| 19 codegen                                                                                                       | L4    | R                                                                   | Subscribes to events; walks Codegenable decls.                                                                                                                                                                                                                                                                                                                                                      |
| 23 build integrations (Vite/Vitest/Playwright/browser)                                                           | L4    | R                                                                   | Manifest schema lives in L0; producer in L3; readers here.                                                                                                                                                                                                                                                                                                                                          |
| 24 examples                                                                                                      | L5    | R                                                                   |                                                                                                                                                                                                                                                                                                                                                                                                     |

---

## Capability contracts (conceptual)

Nine capability contracts. Each is described by responsibilities, plugin obligations, substrate
guarantees, and failure modes. **No code.**

The nine: NodePlugin, ContainerRuntime, Snapshotable, Routable, NetworkResolver, Codegenable,
StrategyContributor, CompositePrimitive, ChainProbe. OnChainArtifactPublisher is L0 substrate
(callable from plugins; no plugin-side contract to implement). Renderer is a sub-shape of
NodePlugin, listed inline below.

### 1. NodePlugin — the universal plugin contract

**Responsibilities.** Identify a schedulable unit and let the engine acquire and release it. Every
L2 service and renderer satisfies this.

**Plugin must provide.**

- A stable identity key (unique per stack acquire) and a kind classification (leaf vs composite,
  long-running vs one-shot, hidden-from-display or visible).
- Declared upstream keys (the keys this plugin depends on; engine uses them for dep-graph topology).
  Capability-typed upstreams (e.g. "an Account capability") are also expressible; the scheduler
  resolves them to concrete keys via the strategy registry or context.
- Declared watch paths (optional; consumed by L3 watch dispatcher).
- An acquire procedure that, given a typed plugin runtime context, produces a resolved value plus
  zero or more capability declarations (Snapshotable, Routable, Codegenable, etc.).
- For composites: declared lifted-sibling keys (see below) and declared inner participants.
  Composites are first-class — they go through the same acquire pipeline; the substrate auto-wraps
  inner lifecycle into the composite row's narration.
- For one-shots: ready collapses to done; no `stopping/stopped` transitions.
- Optional display projection hint — opaque to the engine; only renderers interpret.

**Substrate provides.**

- Scope-bounded acquire with automatic lifecycle state-machine transitions.
- Automatic registration of inner participants for composites (no manual `markAcquiring` for lifted
  siblings).
- Identity-typed context (Identity, NetworkResolver result, path resolver, strategy registry, all L1
  runtimes).
- Resource brokers (port, lease, lock) ready to use.
- Parallel teardown by default.
- Per-line streaming sink ready to use.
- Phase narration channel attached to the plugin's lifecycle key.

**Plugin runtime context — the R-channel seam.** The substrate services a plugin's `acquire` body
needs (`IdentityContext`, `ContainerRuntimeService`, `RuntimeRoot`, `StackPathsService`,
`CacheService`, `StrategyRegistryService`, `StateStoreService`, `Logger`,
`LiftedSiblingRegistryService`) are NOT exposed on `BuildContext` — `BuildContext` stays tag-shaped
(sync `.get(tag)` over upstream resolved values) per the lifecycle invariant. Instead, the substrate
widens `acquire`'s **R-channel**: a plugin yields the `Context.Service` tags it needs from within
its `Effect.gen` body, and the supervisor's plugin acquisition path provides the substrate context
BEFORE running the effect. The signature is:

```
acquire: (ctx: BuildContext<Consumes[number]>) =>
   Effect<ResolvedOf<Provides>, E, R>
```

where `R` is open (`any` at the substrate boundary). Each plugin's inferred R lists exactly the
substrate services its body yielded; the supervisor's `Effect.provide(pluginContext)` narrows R to
`Scope.Scope` before the per-plugin Scope is provided. Net effect: plugin authors write
`const runtime = yield* ContainerRuntimeService` / `const identity = yield* IdentityContext`
directly in `acquire`, get the live substrate instance, and the type system rejects yields that
weren't packaged into the supervisor's plugin context. The supervisor itself is service-name-blind —
it takes a `Context.Context<never>` and forwards it; the orchestrator layer (L3) builds the context
from its layer stack and hands it to `supervise(stack, identity, state, pluginContext)`. (The
earlier `BuildContext`-as-accessor option was rejected because it would force every plugin's
BuildContext type to mention concrete substrate services, breaking the "BuildContext is sync over
tag values only" invariant.)

**Failure modes.**

- `start` fails → `failed` state, error available via cause walker, cascade to downstream consumers.
- Composite refusal (illegal mode combination) → synchronous structured refusal at acquire time; the
  dep-graph never sees the composite (see Tension 11).
- Watch invalidation while in-flight → engine drains the in-flight acquire and re-fires (one acquire
  at a time per key).

**Tag usage constraint.** Tags are static identifiers, not first-class runtime values. A plugin
author constructs a tag once (at the plugin's barrel) and imports it where needed; tag _objects_ are
not passed around as data, stored in arrays for dynamic dispatch, or recomputed at runtime. The
substrate-level type system relies on this discipline: it treats tag types as covariant in their
resolved value (so a narrow tag flows into a wider slot when the substrate upcasts members for
variadic composition), which is sound only as long as tag values are not themselves runtime-passed.
If a future feature needs dynamic stack composition or plugin registries that treat tags as values,
the variance becomes unsound and must be revisited (a bivariant or invariant phantom encoding closes
the gap at the cost of ergonomic ceremony). Documented as a known constraint; acceptable today
because every in-tree consumer uses tags as imported constants.

---

### 2. ContainerRuntime

**Responsibilities.** Manage container-shaped resources (long-running processes, optionally a port,
optionally a network) behind a generic backend interface.

**Plugin (runtime adapter) must provide.**

- Image build (from a build context or pre-built reference); content-addressed; cache short-circuit.
- Name-atomic container create with adopt-if-healthy semantics.
- Inspect by name; resume of stopped; label-stamping and label-filtered enumeration.
- Per-line log follow; exit-wait; pause/commit; exec; ready-probe race against exit.
- Network create/attach with IP-readback (bounded retry).
- Sweep (label-filtered cleanup at orphan time).
- Tag/save/load of committed images (snapshot's mechanism).

**Substrate provides.**

- The `ClaimedContainers` typed-Ref (replaces the today-module-level `ATTACHED_FOLLOWERS`).
- The per-name lease broker (replaces today's per-name semaphore map).
- The router IP cache (typed Ref).

**Failure modes.**

- Daemon down → typed error surfacing via cause walker; supervisor decides whether to retry or fail.
- Name collision after probe-then-create → adopt; never duplicate.
- Image build cache poisoning → reproducible-build assumption; rebuild on hash mismatch.

---

### 3. Snapshotable

**Responsibilities.** Let snapshot orchestrator capture and restore a plugin's state without naming
the plugin.

**Plugin must provide.**

- Capture descriptor: zero or more filesystem subtrees (auto-included if under
  `runtime/<plugin-key>/`; opt-in extras otherwise), zero or more managed containers (identified by
  **label tuples** the runtime filters on — not plugin names), optional typed metadata slice.
- Quiescence hook: how to make state consistent before commit. The default is "pause container" —
  only postgres / RocksDB / similar declare longer grace. Stopped containers are skipped.
- Pre-restore hook: contribute identity-guard data. Chain identity is canonical; others may
  contribute (e.g. postgres major version).
- Post-restore hook: re-validate / warm caches.
- Missing-tolerance flag: is absence of the capture descriptor on restore fatal or fine?
- File-mode promise: 0o600 inside 0o700 parent for secret material; the orchestrator preserves and
  re-applies.

**Substrate provides.**

- Tar capture with mode round-trip.
- Container pause/commit via the runtime adapter (driven by labels).
- Atomic stage-and-swap (one tempdir, one rename for the whole restore).
- Identity-guard execution BEFORE any destructive mutation.

**Failure modes.**

- Identity mismatch → refusal; nothing touched.
- Container daemon unreachable → quiescence-best-effort under a documented flag; commit refuses
  cleanly otherwise.
- Partial tar → restore rejects the snapshot.

---

### 4. Routable

**Responsibilities.** Let the router orchestrator dispatch traffic to a plugin's HTTP endpoint(s).

**Plugin must provide.**

- A dispatch-id stable across the `(app, stack, plugin-key)` triple (parallel stacks must mint
  distinct hostnames).
- A named entrypoint selection (the plugin doesn't choose a port; the port broker assigns; the
  entrypoint selection just says "I serve HTTP / GraphQL / etc.").
- Upstream target — a typed sum: container-on-router-network OR host-process-on-loopback. The router
  resolves URL.
- Optional CORS opt-in (the plugin doesn't write CORS headers; the router does).
- Optional wire protocol (HTTP / h2c).

**Substrate provides.**

- File-provider dispatch file write (atomic). Never docker-provider.
- IP-readback for containers (bounded retry).
- Hostname minting from identity + dispatch-id.
- Endpoint-registered event on the typed event stream.

**Failure modes.**

- IP-readback timeout → typed error; cascade to downstream consumers.
- Dispatch file corruption (Traefik torn-read) → atomic write prevents it structurally.

---

### 5. NetworkResolver

**Responsibilities.** Provide one consistent answer to "what network am I on?" for every plugin.

**Plugin (resolver author) must provide.**

- A resolution function: CLI override > env > config > default →
  `{ mode: 'local' | 'live' | 'fork', chain, rpc?, source?, checkpoint? }`.

**Substrate provides.**

- Single resolver consulted once per acquire.
- Typed slot in plugin runtime context.

**Funds-ready is NOT engine-generic.** The engine does not know what "funds ready" means. Instead,
the StrategyContributor registry has a typed capability key `gate:funds-ready` whose value type is
an opaque async predicate. Plugins that need to wait on funds (Wallet, Faucet consumers) read this
capability slot. The Sui plugin contributes a default implementation (the only one in-tree today);
the slot is trivially-succeeding when no contributor is registered (e.g. live networks where Sui
chose not to contribute). This generalizes: any future "X is ready" gate is a typed capability key,
not an engine primitive. The previous "L0 exposes `awaitFunds`" wording was a service-shaped name
leaking into L0; it's gone.

**Failure modes.**

- Invalid `mode` for a plugin (e.g. Walrus local cluster on `*-fork`) → composite refusal at the
  type level (factory namespace narrows by mode discriminator); for dynamic compositions the
  type-system can't see, runtime refusal at compose-time with a structured error and
  legal-alternatives hint. Tension 11.

---

### 6. Codegenable

**Responsibilities.** Let a plugin contribute files to the user's source tree without the codegen
surface knowing the plugin exists.

**Plugin must provide.**

- A unique emitter name.
- A list of typed registries / services it reads at emit time.
- An emit operation: resolved-snapshot → files-under-staging.
- Optional per-instance state (fingerprint cache).
- Sensitivity flags (drive permissions + .gitignore inclusion).

**Substrate provides.**

- One staging dir per cycle.
- One atomic outer promote (replaces today's per-emitter mtime touch).
- Byte-deterministic re-emit (no mtime churn on unchanged content).
- Stable output paths via L0's path resolver.
- Resolve-once memoization of user extras (one factory call per acquire; one resolved blob threaded
  through every emitter).

**Failure modes.**

- Emitter writes outside its declared staging slice → typed error.
- Two emitters claim the same output path → typed error at register time, not at emit time.

---

### 7. StrategyContributor — the faucet pattern, generalized

**Responsibilities.** Let one plugin contribute to a sibling's capability-keyed registry without an
explicit dep-graph edge. This is how faucet receives WAL/SUI/treasury-cap strategies; how Account is
selected; how renderer plugins enumerate; how codegen emitters are discovered.

**Contributor must provide.**

- A capability key (e.g. `coinType: SUI`, `coinType: WAL`).
- A closed-over strategy (already-bound dependencies; dispatch site is context-free).
- Visibility flag (auto-mounted contributors are hidden from renderers; user-supplied are not).

**Consumer must provide.**

- A capability key to dispatch on. Mode shapes population, never dispatch — so the consumer never
  branches on `network.mode`.

**Substrate provides.**

- Scope-local registry (NEVER module-level — parallel stacks must isolate).
- Last-write-wins for user override of built-ins.
- Subscription event on the typed stream when a strategy registers (renderers can show "1 of N
  contributors registered").

**Failure modes.**

- No strategy for requested capability key → typed error at dispatch with the list of registered
  keys (no silent fall-through).
- Two strategies with the same key and same priority → last write wins; structured warning event.

---

### 8. CompositePrimitive — one row, many children

**Responsibilities.** Let a plugin present as one supervisor row while internally composing N inner
participants (lifted siblings, inner cache-backed artifacts, optional inner one-shots, optional
inner long-running containers).

**Plugin must provide.**

- Composite key (the row).
- Lifted-sibling declarations (named tags whose execution is promoted to scheduler level 0 alongside
  Sui boot, and which dedupe across multiple composites of the same kind).
- Inner-participant declarations.
- Aggregate-value projection (the resolved blob the composite returns to consumers).
- Asymmetric tag fan-out hints (e.g. "this composite resolves an admin tag in local mode but not in
  known-deployment mode" — must be expressible at the type level so consumers of the admin tag get a
  compile error on known mode).
- Composite-row phase narration (sub-step phases — image build, ready probe — surface as text under
  one composite phase, not as separate rows).

#### Lifted-sibling key conventions

Key shape and dedup rules are spelled out so cross-composite dedup is predictable. This closes the
critique's S6.

**Key shape.** A lifted-sibling key is a typed record:
`{ plugin: PluginNamespace, kind: SiblingKind, scope: SiblingScope, inputHash: ContentHash }`.

- `plugin` — the namespace of the plugin family that owns the sibling. Walrus and a future
  "walrus-mirror" plugin share namespace `walrus` if and only if they explicitly opt in via the
  namespace declaration on their plugin metadata (a typed field, not a string literal in code). Two
  plugins with different namespaces NEVER dedup, regardless of `kind`.
- `kind` — a closed sum per namespace (`'upstream-git'`, `'image'`, etc.). Defined by the plugin
  namespace, not by the engine.
- `scope` — closed sum: `'per-app'`, `'per-stack'`, `'per-process'`. Per-app means two stacks of the
  same app dedup; per-stack means parallel stacks of the same app don't dedup; per-process is the
  rare case where the sibling shares only within one process.
- `inputHash` — content-hash of the inputs that determine the sibling's output (e.g. git ref +
  Move.toml hash for `upstream-git`). Two siblings with the same `(plugin, kind, scope)` but
  different `inputHash` are different artifacts — they do NOT dedup. The hash has two regimes (see
  below): a **literal-typed hash** (e.g. a pinned git ref string the plugin author types as a string
  literal) and a **runtime-computed hash** (e.g. SHA of a Move.toml read at acquire time). Both are
  first-class; they differ only in _when_ the dedup conflict surfaces.

**Dedup contract:**

- Identical keys (all four fields equal): **first-wins**. The second composite registers and
  immediately resolves against the first composite's resolved value. The substrate logs a
  `sibling.deduped` event.
- Same `(plugin, kind, scope)`, different `inputHash`: **refuse**. Two regimes for _when_ the
  refusal fires:
  - **Literal `inputHash`** (the hash is a string-literal type the plugin author wrote at the call
    site — e.g. a pinned git ref `'v2.0.0'`): the substrate refuses at **compile time**. The
    prototype proved this works via union-to-intersection collapsing on the literal hash type; the
    user sees a TS error before the stack runs. This is a strict improvement over the original spec
    ("refuse at compose time") — same misconfiguration, caught earlier, for free.
  - **Runtime-computed `inputHash`** (the hash is opaque to the type system — e.g. a content-hash of
    a Move.toml read at acquire): the substrate refuses at **compose time** (runtime), with the same
    structured error listing both inputs. The compile-time regime is impossible here because two
    opaque branded strings are indistinguishable to the type checker. Both regimes refuse on the
    same condition; only the surfacing moment differs. Plugin authors get whichever applies based on
    how they declared the hash.
- Different `plugin` namespace: never dedup. Two different plugin families do not share lifted
  siblings even if their `kind` names collide (because `plugin` is part of the key).

**Namespace boundary.** `plugin` is the canonical boundary. The engine treats it as opaque (no
string matching). A new "walrus-mirror" plugin that wants to share Walrus's git fetch must declare
`namespace: 'walrus'` in its plugin metadata — an explicit, typed, auditable opt-in. The engine has
no convention for guessing namespace sharing.

**Version drift.** A version drift in the input is exactly an `inputHash` change. The dedup contract
above turns this into a refusal ("two composites of the same kind in the same scope want different
inputs"). The plugin's typical resolution: bump the scope to `'per-stack'` so each stack gets its
own sibling, or fix the inputs so they converge.

**Pseudo-example (Walrus).** Walrus's `upstream-git` lifted sibling:
`{ plugin: 'walrus', kind: 'upstream-git', scope: 'per-app', inputHash: hash(gitRef + moveTomlHash) }`.
Two Walrus composites in the same stack with the same git ref share — same input hash, dedup fires.
Two Walrus composites with different git refs in the same app refuse at compose time — the error
tells the user which two composites conflict. A future Walrus-mirror plugin that wants to share the
same fetch declares `namespace: 'walrus'` in its declaration; otherwise it does not dedup.

**Substrate provides.**

- Topo-scheduler placement: lifted siblings at level 0; composite acquire waits on them via
  upstream-keys.
- Dedup-by-key for lifted siblings (first composite wins; subsequent ones reference the cached
  value).
- TUI row aggregation (all inner container TUI events route to the composite key, not their own; one
  row, many sub-statuses).
- Parallel teardown via forked parallel-strategy scope: `teardown = max(grace)`, not `sum(grace)`.
- Auto-wrap of `markAcquiring` / `markReady` for inner participants (composites stop hand-rolling
  lifecycle markers).

**Registry scope.** Lifted-sibling entries live for the stack scope; there are no per-registration
finalizers. The Phase-3 contract type currently lists `Scope.Scope` as a requirement on `register`;
that requirement is satisfied by the ambient stack scope — no per-entry finalizer is created or torn
down.

**Failure modes.**

- Type-level refusal: an illegal composition (Walrus local cluster on `*-fork`) does not type-check
  at the user-facing factory site. Runtime refusal remains as defense-in-depth for dynamic
  compositions (factory selected via env var, out-of-tree plugins that decline to expose
  mode-narrowed factories) — synchronous structured throw at compose-time, before the scheduler sees
  the composite. Tension 11 resolution.
- Inner participant failure → composite's status becomes failed; cascade through dep-graph as usual.

---

### 9. ChainProbe — schema-validated on-chain reads

**Responsibilities.** Provide a typed, schema-validated read surface over an on-chain RPC such that
consumers (verify probes, account balance checks, codegen receipts) never depend on raw SDK property
access.

**Plugin (provider) must provide.**

- A `get(key, schema, mode)` operation where `mode` is `'lenient' | 'strict'`. Lenient returns
  absence for both not-found and transient RPC failure (so verify probes re-derive on the next cycle
  rather than fail boot); strict throws on transient failure.
- Plugin-typed `key` shapes (object id, transaction digest, etc.) and a Schema decoder for the
  expected shape. Decode failure is a structured probe error.
- Capability-key metadata so consumers find the right probe via the StrategyContributor registry
  (key shape: `chain-probe:<chainId>`).
- Optional batch read (multi-key in one RPC round-trip).

**Consumer (plugin) must provide.**

- A chainId selector (which probe to consume) — usually derived from NetworkResolver.
- A Schema for the expected shape at each call site.

**Substrate provides.**

- The chain-probe slot is a capability key, not a global. Plugins request `ChainProbe` from the
  typed strategy registry; multiple chain-probes can coexist (Sui mainnet probe, Sui devnet probe).
- A reference implementation lives next to the Sui plugin (the only in-tree provider today); the
  contract is shared substrate so a future non-Sui chain-probe slots in cleanly.
- Lenient retry profile (warmup-friendly named primitive shared with OnChainArtifactPublisher).

**Failure modes.**

- Schema mismatch (SDK rename) → structured decode error, NOT silent `undefined`. This is the
  load-bearing learning from deepbook.
- No registered probe for the requested chainId → structured error listing registered chainIds.

**Why a contract, not a primitive.** Today's chain-probe lives inside Sui's folder. Lifting it to a
contract lets future chains (non-Sui) provide their own implementation and lets cache-key folding in
OnChainArtifactPublisher consume probes without naming Sui. The substrate-vs-contract distinction is
exactly: substrate primitives are name-blind reusable code; contracts are plugin-implementable
seams. ChainProbe is the latter because the RPC surface differs per chain.

---

### 10. OnChainArtifactPublisher — cache + verify + produce + register

**Status.** This is an L0 **substrate primitive**, not a plugin contract — plugins call it; no
plugin implements an OCA interface. It is described here alongside the contracts because plugin
authors interact with it heavily; from the substrate's perspective it's a library function in the
kernel.

**Responsibilities.** Encode the discipline that recurs in 7+ plugins (Move publish, coin mint,
walrus deploy, seal keygen + key-server, deepbook pools, pyth feeds, action receipts) as substrate.

**Plugin must provide.**

- A namespace + cache-key derivation (canonical input bytes → content-hash; substrate folds chainId
  into the final key).
- A verify procedure that calls the ChainProbe capability with a typed Schema and a lenient mode —
  transient RPC failure → re-run, not evict.
- A produce procedure: run on miss / verify-fail.
- A register procedure: fires on **every** cycle (hit AND miss) into the plugin's in-memory
  registry, so downstream consumers always see fresh data.

**Substrate provides.**

- Content-addressed cache lookup (key folded with chainId).
- Lenient retry profile (15 attempts, 90s budget, 500ms initial, 1.5× backoff, [0.8,1.2) jitter —
  the warmup-friendly named primitive from synthesis).
- Best-effort post-success persistence: a successful on-chain side effect followed by a cache-write
  IO defect does NOT roll back the on-chain reality; next cycle re-verifies and idempotently
  registers.
- Idempotent re-execution: cache hit + verify success = no-op.
- Snapshot integration: the cache file is a Snapshotable subtree by default.

**Failure modes.**

- Produce fails → failed plugin state; user sees the structured cause.
- Verify fails twice in a row (lenient retries exhausted) → re-produce (the documented behavior;
  assumed transient failure).
- Cache key collision (very unlikely with content-hash) → second plugin's register overrides;
  structured warning event.

---

### 11. Renderer — typed event stream subscriber (sub-shape of NodePlugin)

**Responsibilities.** Project the lifecycle event stream into a user- visible form. TUI, plain,
silent, JSON-renderer (Phase 3 decision — see open questions) all satisfy this.

**Plugin must provide.**

- A mount procedure (start the projection).
- A subscription on the event stream.
- A flush procedure (end of cycle).
- A teardown (release any resources).

**Substrate provides.**

- The typed event stream (one stream; one shape).
- A subscribable state-ref projection of the stream (renderers that want a current-state view rather
  than a live stream subscribe here).
- The command channel (renderers that emit input — TUI keypresses becoming `restart-request` —
  publish here).
- Lifetime independence: the renderer mounts once per process; the engine cycle re-runs many times;
  the renderer never sees the cycle swap. (Tension and deferred decision resolved below.)

#### Subscribable projection — exact field enumeration

The projection is the load-bearing replacement for the proxy-engine handle. Renderers consume only
this projection plus the live event stream; nothing else from the engine is in scope. The fields are
enumerated below — adding a field requires an architecture revision, not a code change. This is the
discipline mechanism that makes "no display vocabulary leaks into engine" verifiable.

**Top-level state object:**

- `identity: { app, stack, network }` — frozen at boot.
- `cycle: { id, startedAt, phase: 'booting' | 'running' | 'restarting' | 'shutting-down' }` — engine
  cycle metadata.
- `rows: Row[]` — one row per visible plugin instance (excluding hidden auto-mounts).
- `endpoints: Endpoint[]` — flat list of routable endpoints (registered + released).
- `errors: ErrorEntry[]` — most recent N structured errors (capped buffer).
- `lastEvent: { seq, at }` — pointer into the event stream so renderers can tell "I'm caught up."
- `stackBuild: BuildEntry[]` — image build progress events that don't belong to a single row (e.g.
  lifted-sibling builds).

**Row shape** (per plugin instance):

- `key: PluginKey` — opaque branded string.
- `kind` — leaf-long-running | leaf-one-shot | composite | renderer.
- `status` — pending | acquiring | ready | failed | stopping | stopped | done.
- `phase: string | null` — free-form phase narration. Free-form is intentional (Tension 14).
- `lastError: StructuredError | null` — **the failure that drove the row's current
  `status: failed`**, not "most recent observed." A warn-level `error.reported` on a `ready` row
  updates the top-level `errors[]` ring but does NOT overwrite `lastError`; only a transition into
  `failed` writes it. Cleared on transition out.
- `logTail: { lines: string[], level: 'info' | 'warn' | 'error', truncated: boolean }` — bounded log
  buffer (default 100 lines), level promoted by the per-line streaming sink.
- `endpoints: PluginKey[]` — endpoints owned by this row, looked up in the top-level `endpoints`
  list.
- `compositeChildren: PluginKey[] | null` — keys of inner participants for composite rows.
- `selectiveRestartHighlight: boolean` — cosmetic flag (Lifecycle properties #4).
- `narrationByContributor: Record<string, string> | null` — for composites, the per-child phase
  strings that fold into the composite row narration.
- `rebootCost: 'cheap' | 'moderate' | 'heavy' | null` — plugin-declared (Substrate violation §20),
  read by the cascade formatter.
- `displayHint: unknown` — opaque blob from `NodePlugin.start`'s optional display projection hint;
  renderer-interpreted only.

**Endpoint shape:**

- `endpointKey: EndpointKey` — branded `(pluginKey, dispatchId)`.
- `pluginKey: PluginKey` — owning row backlink, carried explicitly so the reducer doesn't decode the
  brand. Brand rule: `endpointKey = digest(pluginKey + dispatchId)`.
- `name: string` — plugin-emitted endpoint name (e.g. `aggregator`).
- `url: string` — final URL after router minted hostname + port.
- `displayUrl: string | null` — optional codegen-friendly variant (the moved `displayPath` data).
- `wireProtocol: 'http' | 'h2c' | string` — plugin-declared.
- `registeredAt: number`.

**ErrorEntry shape:**

- `at: number`, `pluginKey: PluginKey | null`, `tag: string`, `summary: string`, `chain: string[]`
  (cause-walker output), `severity: 'warn' | 'error' | 'fatal'`.

**BuildEntry shape:**

- `pluginKey: PluginKey | null` (null for lifted-sibling builds shared across composites),
  `phase: string`, `progress: string`, `startedAt: number`.

Fields explicitly NOT in the projection: `title` (renderers compute from `key` + display rules),
`primary` (a CLI-vs-TUI presentation concept, computed from the projection by each surface),
`extras` (today's catch-all — every "extra" must now be a typed field above or a typed event in the
live stream).

**Capacity constants (architecture-blessed defaults).** Bounded buffers have fixed defaults:
`errors[]` 100, `stackBuild[]` 200, `rows[].logTail.lines[]` 100, log line 16 KiB max,
structured-field truncate 8 KiB. Not user-tunable; the substrate's back-pressure budget. Raise via
architecture revision if a real workload exceeds them.

**Failure modes.**

- Renderer crash → engine continues; structured event; restart hint.
- Renderer mount lifetime mismatch with engine cycle (today's proxy-engine wart) — structurally
  prevented by the subscribable projection that survives cycles.

---

If we find we need others mid-implementation (e.g. a `FaucetStrategy` distinct from
`StrategyContributor`, a `KeystoreBackend` distinct from `StrategyContributor`), they're sub-shapes
of the general contracts — not new top-level capabilities. The discipline mechanism: a new top-level
capability requires explicit re-opening of this document.

---

## Data models

Conceptual entity model. Eleven entities.

### Stack

**Scope.** One `(app, stack, network)` triple. One in-process acquire; one set of resolved plugin
values.

**Identity.** `(app, stack, network)` validated once at boot. `app` and `stack` match a strict regex
(`[a-z][a-z0-9-]*`, no `..`, no `/`, no spaces, no shell metas) so they survive docker labels and
path joins. `network` is validated against the NetworkResolver's accepted set.

**Lifetime.** From `acquire` through `release`. Multiple cycles within one stack lifetime
(hot-restart, watch invalidation) reuse the stack's identity but produce fresh plugin instances.
Renderer mounts survive cycle swaps.

### Plugin instance

**Identity.** A key unique within one stack acquire. Composite children's keys are namespaced under
the composite (`walrus.node-1`, `walrus.deploy`).

**Kind.** A closed sum: leaf-long-running, leaf-one-shot, composite, hidden-leaf (auto-mount),
renderer.

**Upstream keys.** Concrete keys (`sui`) or capability-typed keys ("an Account capability for
`app`"). Substrate resolves capability-typed upstreams once per acquire.

**Capabilities it implements.** Zero or more of: Snapshotable, Routable, Codegenable,
StrategyContributor (with capability key set), CompositePrimitive.

**Output.** The resolved blob downstream consumers see. For composites, this is the projection (the
admin tag, the known tag, etc.).

**Plugin type carries its declarations.** Four pieces: (a) provided tag, (b) consumed tags, (c)
capability tuple, (d) lifted-sibling tuple. Both tuples are structurally available to type
computation, not erased. Codegen shapes, snapshot slices, routable triples, and sibling literal
hashes flow through. Erasing the capability set collapses consumer types to `never`; erasing the
sibling tuple silently disables compile-time dedup. **Plugin-factory authors must declare
`liftedSiblings` as `as const`** — without literal narrowing the fourth generic widens and dedup
degrades from compile-time to runtime silently.

### Lifecycle state

A closed state machine — one shape for all plugins:

```
                     +-- (transient)  acquiring
                     |                    |
   pending --------->+                    |
                     |                    v
                     |                  ready ----+
                     |                    |       |
                     +----- failed <------+       |
                                                  |
                  (long-running only:             |
                   ready -> stopping -> stopped)  |
                                                  |
                   (one-shot:                     |
                    ready collapses to done) <----+
```

**Properties.**

- Merge-not-replace transitions. `markAcquiring` is idempotent.
- Auto-register on first `markAcquiring` (so composites' inner tags surface).
- Phase narration is a transient annotation; cleared on transition to ready/failed.
- Selective-restart highlight is a cosmetic flag attached to a row, not a separate state.
- One-shot done is distinct from long-running ready in the event stream (consumers can tell apart)
  but identical in scheduler semantics (downstream gating).

### Manifest

**What it carries.** A JSON document under `.devstack/stacks/<stack>/manifest.json`. The L0 envelope
is name-blind: `identity` tuple, `manifestVersion`, an open `services: Record<PluginKey, unknown>`
slot, an `endpoints` flat lookup (declared endpoint name → URL), and an opaque
`extras: Record<PluginKey, unknown>` slot. The typed per-service projection (e.g. the typed Sui
slice) is defined by each plugin's Codegenable contribution and consumed by codegen output, NOT by
the manifest envelope itself.

**Who writes it.** The manifest writer orchestrator. Reads plugin-emitted endpoint declarations and
codegen contributions; writes atomically; slow-tick repeater for late registrations;
flush-on-scope-close.

**Who reads it.** Build integrations (Vite alias, Vitest preset, Playwright config-load), example
apps at runtime, CLI commands like `stack url`. The schema is in L0; the reader surfaces are in L4
(sync + Effect variants behind the same schema).

**Manifest version policy.** L0 pins a `CURRENT_MANIFEST_VERSION` constant; readers compare on every
read: equal → accept; older → accept with a structured advisory recommending re-run `up`; newer →
refuse with a structured advisory recommending the build-integration upgrade (reader returns nothing
rather than guessing forward-compat). The writer always emits at `CURRENT_MANIFEST_VERSION`.

### Codegen output

**Categories of files emitted.**

- Endpoint constants (typed map of endpoint names → URLs / display URLs).
- Package binding skeletons (per-published-package Move binding + typed package id).
- Account map (name → address).
- Coin map (symbol → typed coin metadata).
- App extras (typed projection of resolved-once factory output).
- Optional dapp-kit config (per-app, opt-in).

**Discipline.** One staging dir; one atomic promote per cycle. Byte-deterministic re-emit. No mtime
touch when content unchanged (watcher loop avoidance). Permissions + .gitignore from Codegenable
sensitivity flags.

### Snapshot

**What's captured per plugin.** A tar of declared filesystem subtrees, committed container images
(one per managed container identified by label tuples), a typed metadata slice (identity-guard
contributions + plugin's structured state).

**Identity guard.** `(app, stack, network)` plus chain identity plus optional plugin contributions.
Fires before any destructive mutation.

**Atomicity guarantees.** Stage-and-swap at the snapshot directory level (one tempdir, one rename).
Pause-around-commit for managed containers (always unpaused on success AND failure paths). Mode bits
round-trip (0o600 for secret material, 0o700 for parents).

### Cache

**Key shape.** `(namespace, chainId, content-hash)`. Namespace is the plugin's choice (e.g.
`package`, `coin`, `walrus.deploy`). Content- hash is SHA-256 truncated at a length the substrate
picks (12 bytes for image tags, 16 for cache keys, 24 for codegen fingerprints).

**Verify contract.** Plugins declare a verify probe (lenient, schema-validated chain-probe).
Substrate calls it on every cache hit.

**GC.** Orphaned-chainId entries reaped by a background sweeper (periodic; on stack release).
Snapshot images GC'd alongside.

**Corruption-as-miss is deliberate.** Cache reads that fail to parse (truncated JSON, schema-decode
failure, IO error mid-read) are treated as cache _misses_, not errors. The miss path falls through
to produce-and-write, which atomically overwrites the corrupt entry. Sits alongside the
schema-versioning posture (content-hash + decode-fail → re-produce suffices). State store (durable
typed KV) follows the OPPOSITE posture — see § State store for its typed error channel.

### State store

**Boundary with cache.** Cache is content-addressed and idempotent; state store is per-stack
persistent typed KV (e.g. seal master-key, account keypair file, postgres PGDATA path). Cache
entries can be dropped at will; state-store entries are durable until the stack is wiped.

**Boundary with snapshot.** Snapshot captures the state store. State store is the live thing;
snapshot is the frozen replica.

**Key shape.** BRANDed typed keys (a registry of typed key constructors; one source). Plugin owns
the key namespace under its plugin-key prefix.

**Error channel.** Explicit typed: IO faults, JSON-parse on corrupt blobs, Schema decode (drift),
lock-contention timeouts. Plugins that depend on durable readable state must be able to fail loudly
when it isn't — the substrate does not silently swallow.

**Tombstone vs missing.** On disk the state store distinguishes a tombstoned entry from an entry
never written; at the typed boundary both present as `null`. Rationale: (a) snapshot fidelity — a
restored tombstone reads identically to an omitted key; (b) no resurrection- after-interrupt — a
delete that crashed mid-write must NOT re-appear from an older write.

### Event stream

**Categories of typed events.**

- `lifecycle.statusChanged` — a plugin transitioned.
- `lifecycle.phaseSet` — a transient narration was attached.
- `log.appended` — a log line for a plugin (with level promotion).
- `endpoint.registered` — a Routable emitted an endpoint URL.
- `endpoint.released` — a Routable went away.
- `strategy.registered` / `strategy.unregistered` — capability registry change.
- `manifest.flushed` — the manifest writer atomically committed.
- `codegen.emitted` — one or more files emitted.
- `error.reported` — a structured error surfaced (cause walker output).
- `build.statusChanged` — image build phases (for renderers that show build progress).
- `restart.requested` / `restart.completed` — hot-restart and selective restart.
- `snapshot.captured` / `snapshot.restored` — snapshot orchestrator events.

**Who emits.** Engine (lifecycle, error), L1 runtimes (logs, build), L3 orchestrators (endpoint,
manifest, snapshot, restart), L2 plugins (phase narration, codegen).

**Who consumes.** L2 renderers, L4 surfaces (CLI envelope, codegen trigger, programmable API
consumers, build integrations only via the manifest file on disk — not the live stream).

### Command stream

**Categories of typed commands.**

- `stack.start` / `stack.stop` / `stack.restart` — full stack lifecycle.
- `apply.requested` — re-acquire after watch invalidation.
- `snapshot.capture` / `snapshot.restore` / `snapshot.list` / `snapshot.delete`.
- `wipe.requested` — full state wipe.
- `prune.requested` — orphan sweep.
- `advance-clock.requested` — fork-mode time advance.
- `shutdown.requested` — graceful shutdown.
- `selective-restart.requested` — specific plugin key restart.

**Who publishes.** CLI (argv parses to a command), TUI (keypresses), programmable API (library
caller), build integrations (Vite-init optionally publishes `stack.start` if a flag is set).

**Who handles.** The engine consumes; never reaches back into surfaces. The same command arriving
from CLI or TUI takes the same code path.

---

## Lifecycle / state management

### Stack lifecycle

```
   defineStack(config)
       │
       ▼
   Identity validated  ──► boot logs go to event stream from this point
       │
       ▼
   NetworkResolver consulted (once)
       │
       ▼
   Plugin instance dep-graph computed
       │
       ▼
   Scheduler begins level-batched parallel acquire
       │   │   │
       │   │   └── level 0: Sui, lifted siblings (git fetch, image build)
       │   └────── level 1: services depending on Sui
       └────────── … through to one-shot actions at the leaves
       │
       ▼
   All ready → manifest.flushed event → codegen surfaces fire → ready event
       │
       ▼
   Cycle running: watch dispatcher listens; commands flow
       │
       ▼  (watch event invalidates a subtree)
   Subset invalidate → scheduler restarts subgraph in parallel
       │
       ▼
   shutdown.requested → parallel teardown (max grace, not sum grace)
       │
       ▼
   Scope close → state-store flush → renderers flush → process exits
```

### Plugin lifecycle within a stack

**Resolution.** Upstream keys (concrete or capability-typed) resolve once. Lifted-sibling
dedup-by-key fires before scheduler emits the level-0 batch.

**Scheduling.** Plugin enters `pending`. When all upstream keys are `ready`, scheduler begins
`acquiring`. Per-key serialization: only one acquire at a time per key (an in-flight watch
invalidation drains and re-fires; never overlaps).

**Composite inner participants carry an implicit `compositeParent` indegree** — declared upstreams
PLUS a synthetic edge from the composite parent. An inner participant whose declared upstreams are
all at level 0 still runs at `level(compositeParent) + 1` at the earliest.

**Ready gate.** Plugin's acquire procedure returns the resolved value

- capability decls. Substrate writes them to the typed registries. Plugin transitions to `ready`.
  Downstream consumers are unblocked.

**BuildContext.get is sync over Effect-resolved values.** A substrate-managed side-channel
`Map<PluginKey, ResolvedValue>` is populated on `markReady`; the sync accessor reads it without
re-entering the Effect runtime. The "ready gate" wording above describes _when_ values become
readable; the read itself is sync. Plugins never write to the side-channel.

**Watch-triggered invalidation.** L0 watcher emits a debounced+deduped content-hash event. L3 watch
dispatcher consults plugin watch decls. Matched plugins enter `selective-restart-pending`. Scheduler
runs subset invalidate: evict shadow-cache entry BEFORE closing scope; run finalizers (parallel
strategy); re-acquire. The state machine permits `failed → pending` and `stopped → pending` so the
slice walks `stopped → pending → acquiring → ready` without recreating row identity.

**Selective restart cascading.** Invalidating a composite invalidates its children. Invalidating a
producer invalidates downstream consumers along dep-graph edges (cascade semantics — engine already
has this).

**Cycle replacement (hot-restart).** Triggered by `restart.requested` command. Whole stack
teardown + re-acquire. Renderer subscription survives via the stable state-ref projection (see
Renderer mount lifetime decision below).

### Container lifecycle within a runtime adapter

```
   ensureImage  ──► content-addressed build / pull / cache-short-circuit
       │
       ▼
   ensureContainer  ──► name-atomic create
       │
       │     ┌─── existing healthy: adopt (label-checked)
       │     ├─── existing stopped: resume
       │     └─── name collision in race: adopt
       │
       ▼
   network attach with bounded IP-readback retry
       │
       ▼
   ready probe race against exit
       │
       ▼
   running: per-line log follow with level promotion
       │
       ▼  (stop / scope close)
   pause? (snapshot only)  ─► commit  ─► unpause (success AND failure)
       │
       ▼
   stop with grace
       │
       ▼
   release claim on ClaimedContainers Ref
```

### Snapshot lifecycle

```
   snapshot.capture command
       │
       ▼
   Walk Snapshotable registry; group by plugin
       │
       ▼
   For each plugin in dep-graph order:
       │   pause managed containers (unless stopped)
       │   tar host-tree subtrees with mode round-trip
       │   docker commit + tag committed images
       │   collect metadata slice
       │   unpause (always)
       ▼
   Stage everything in tempdir
       │
       ▼
   Atomic rename → snapshot catalog entry
       │
       ▼
   snapshot.captured event

   snapshot.restore command
       │
       ▼
   Identity guard (chain identity + plugin contributions)
       │
       ▼  (refuse and stop if mismatch — nothing touched)
   Stage atomic restore in tempdir
       │
       ▼
   Per plugin: load committed images, expand tar to staging,
               run post-restore hooks (validate, warm cache)
       │
       ▼
   Atomic swap into runtime dir
       │
       ▼
   snapshot.restored event → next stack acquire picks it up
```

Restore is **bracketed-atomic** (Tension 9 decision: one outer atomic swap, not per-phase
idempotency). Pre-cleanup is still best-effort within the bracket.

### One-shot effect lifecycle

```
   pending → acquiring → done
                          │
                          └─ no port, no listener, no fiber kept alive
                          └─ no stopping/stopped transitions
                          └─ excluded from shutdown-pending count
                          └─ optional discriminator-as-Effect
                             re-yielded on every cycle so the dep-graph
                             still sees the node (cache hits collapse
                             to immediate done)
```

Re-evaluation is substrate-driven, not plugin-driven: each cycle the substrate re-resolves the
one-shot's declared discriminators (chainId, content hash, etc.) and, if any changed, invalidates
the cached receipt and re-runs the one-shot body — plugins do not write retry or re-trigger logic.

No automatic retry. A transient `execute` failure stays `failed` until hot-restart (preserves user
control).

---

## Cross-process safety protocol

This section spells out the protocol referenced by Tension 12. It is the single most fragile area of
today's implementation; the design here is deliberately conservative.

### What is locked, and where

Three artifacts per stack on disk, all under `~/.devstack/<app>/<stack>/`:

- **`stack.lock`** — an OS-advisory exclusive lock file. Used only for short critical sections
  (roster mutations, snapshot reservation). Acquired via `flock(LOCK_EX)` on Unix and `LockFileEx`
  on Windows; never held across a long operation.
- **`roster.json`** — the authoritative cross-process record of which OS processes are currently
  "in" this stack. Schema: a versioned JSON document with a `holders` array; each holder carries
  `{ pid, startTime, hostname, claimedAt, heartbeatAt, intent: 'normal' | 'snapshot' }`.
- **`container-claims.json`** — a sibling file alongside `roster.json` recording which process
  claims each managed container. Same lock discipline (mutations under `stack.lock`), same
  atomic-write codec, same liveness-sweep rules. NOT a widening of `RosterDocument` — the sibling
  split isolates per-container claim churn from the per-process holder list.
- **`snapshot.reservation`** — present-or-absent file. Present means some peer holds the snapshot
  privilege. Atomic `O_EXCL` create is the acquire; unlink is the release. Payload carries
  `{ pid, startTime, hostname, claimedAt }` so the orphan-sweep applies the same
  foreign-host-conservatively-alive rule the roster uses. Without `hostname`, snapshot orphan checks
  degrade to same-host-only.

The unified L0 lock primitive's _exclusive_ facade backs `stack.lock`. The "shared read" framing
from the earlier sketch is gone — `stack.lock` is exclusive, held only across roster mutations,
never across long operations. Concurrent peers do NOT both hold a shared lock; they take turns under
the exclusive lock for the brief moments they mutate the roster.

### Claim protocol

When a process opens a stack:

1. Acquire `stack.lock` (exclusive, advisory). Block up to 5 seconds; if unavailable, retry with
   backoff.
2. Read `roster.json`. If missing or unparseable, initialize an empty roster.
3. **Sweep stale holders** under the lock: for each entry, check liveness — process exists AND its
   start-time (as read from `/proc/<pid>/stat` on Linux, `ps -o lstart` on macOS, or equivalent)
   matches the recorded `startTime`. Foreign-host entries (`hostname` differs) are treated as alive
   — NFS-safe conservative default. Holders whose `heartbeatAt` is older than 3× the heartbeat
   interval (default 30s) AND who fail the PID liveness check are evicted.
4. Append this process's holder entry with `claimedAt = now`, `heartbeatAt = now`,
   `intent = 'normal'`, `pid` and `startTime` for this process.
5. Atomic write `roster.json` (tempfile + rename via L0's atomic-write primitive).
6. Release `stack.lock`.

### Heartbeat protocol

A background fiber (one per process per stack) wakes every 10 seconds and:

1. Acquires `stack.lock`.
2. Reads `roster.json`.
3. Updates this process's holder entry's `heartbeatAt`.
4. Atomic write + release lock.

A heartbeat miss does not by itself evict — only sweep-during-claim evicts (peers find the dead
entry when they next try to claim). Heartbeats keep the timestamp fresh so a slow peer isn't falsely
considered stale.

### Release protocol

When a process closes its scope:

1. Acquire `stack.lock`.
2. Read `roster.json`. Locate this process's entry.
3. Remove it.
4. If `holders` is now empty, this process is the **last-leaver** and must run the stop finalizer:
   stop managed containers, write their final state, leave images on disk.
5. Atomic write `roster.json` (or `unlink` if empty and the convention is "absent = empty").
6. Release `stack.lock`.

### A-mid-restart-while-B-starts

Process A enters its release protocol (step 1, holds the lock). Process B's claim protocol blocks at
step 1 until A releases. When B acquires the lock at step 1, the roster reflects A's removal (or A's
continued presence if A's release hasn't reached that step yet — but A holds the lock contiguously,
so this case cannot occur). B's liveness check at step 3 finds A removed (or A still alive); either
way, B's claim entry is consistent. **No race window** because mutation is always under the
exclusive lock.

If A is "mid-restart" in the sense of "in-process hot-restart" (the process stays alive; the engine
cycle restarts), there is no roster mutation: A's holder entry is unchanged, A's pid + startTime are
unchanged, and B sees A as alive.

### A-crashes-between-claim-and-release

A's roster entry persists with stale `heartbeatAt`. Next time any process (B, C, or A's successor)
runs the claim protocol's step 3 sweep, A's entry fails the PID-liveness check (pid no longer exists
OR pid exists but `startTime` differs because the kernel reused the pid). A's entry is evicted. If A
was the only holder, the next process is the new sole holder and inherits responsibility for the
stop finalizer at its own release.

**Containers are not stopped by the crash sweep.** Containers adopted from a crashed process are
inherited by the live holders through ordinary adopt-if-healthy. The stop finalizer fires only at
last-leaver release, which is by-design — a crash leaves containers running; the next live holder
adopts them.

### Concurrent snapshot

Snapshot requires exclusive control of the stack's container set (pause-around-commit means peer
processes' ready-probes would fail if uncoordinated).

1. The snapshotting process acquires `snapshot.reservation` via `O_EXCL` create. If creation fails
   (peer holds it), the snapshot refuses with a structured "snapshot in progress by peer pid X"
   error.
2. Under `stack.lock`, it updates its holder entry's `intent` to `'snapshot'` and writes the roster.
3. Peer processes observe `intent = 'snapshot'` on the next sweep they perform. Their ready-probes
   get a longer tolerance window (configurable, default 60s) while a peer is snapshotting. Their own
   commands (`apply`, `restart`) refuse with "stack is snapshotting" until the reservation file
   disappears.
4. The snapshotting process performs pause / commit / unpause.
5. It unlinks `snapshot.reservation`, restores its `intent` to `'normal'` under `stack.lock`, and
   releases.

If the snapshotting process crashes mid-snapshot, the reservation file persists. The next process's
claim-protocol sweep detects an orphan reservation (the holder whose pid matches the reservation's
creator entry is dead) and unlinks it; containers are left in whatever state the crash interrupted
(commit may have completed; the roster sweep does not roll back side effects).

### Why this is the right shape

- One file with a clear schema replaces the previous sketch's blend of "shared read locks + typed
  Ref + last-leaver."
- Mutation is always under the exclusive `stack.lock`. There is no CAS protocol because there is no
  contended read-modify-write outside the lock.
- Liveness check is PID + start-time match — the same industry-standard approach the synthesis
  cited.
- Snapshot is a separate reservation file so the common case (no snapshot in flight) carries no
  extra IO.
- Foreign-host entries are conservatively-alive (NFS-safe). On single-host setups, this never fires.

### Where the protocol lives

The protocol implementation lives in L0 alongside the lock and atomic-write primitives — the roster
codec, sweep logic, heartbeat fiber, and snapshot-reservation handling are all part of the same
small cross-process-safety module. Its reach is bounded: it only ever mediates roster mutations and
snapshot reservations, never holds locks across long operations, and never grows new
responsibilities. If a new cross-process concern arises, it gets its own primitive next door, not a
new branch inside this one.

---

## Decisions on the 11 deferred layering questions

### 1. Runtime substrate scope (synthesis "Layering decisions deferred to Phase 2" #1)

**Question.** The `src/runtime/` directory straddles L3 (write path = supervisor-lifecycle), L4/L5
(read path = pure consumer code), and the manifest schema + endpoint declarations is shared
substrate. Three plausible splits.

**Decision.** **Three-way split.**

- **Manifest schema + endpoint-declaration registry shape** → L0. Both producer and consumers depend
  on this. It's pure data shape with no scope dependency.
- **Manifest writer (producer)** → L3 orchestrator. It needs Scope, reads plugin registries, runs as
  part of stack acquire.
- **Manifest readers (sync + Effect)** → L4 build integrations. Pure consumers; walk-up discovery;
  conventional-URL fallback.

**Reasoning.** This is the principled split. Forcing manifest into a single shared module (option a)
reproduces the L3/L4/L5 straddle that caused this redesign. Pushing schema into a producer-only
module (option b) means readers re-declare the schema and drift. Splitting the schema/declarations
into L0 lets both sides depend on it cleanly.

**Consequence.** The `src/runtime/` directory disappears. Endpoint metadata becomes plugin-emitted
(see deferred decision #11 below). Build integrations shrink to a thin set of pure manifest readers
because the schema split makes producer-side concerns invisible to them.

### 2. Snapshot orchestrator vs plugin-driven (#2)

**Question.** Where does snapshot orchestration logic live? Engine? Snapshot-specific module?
Plugin-author surface?

**Decision.** **Dedicated L3 orchestrator** that walks the `Snapshotable` registry. Engine has zero
snapshot knowledge. Plugin-author surface is just: declare a `Snapshotable` capability slice from
your `NodePlugin.start` return.

**Reasoning.** Engine-hosted snapshot reproduces the today-symptom of `engine/snapshot.ts` with
hardcoded per-service paths. Plugin- hosted (each plugin owns its capture) loses the cross-cutting
orchestration (atomic stage-and-swap, identity-guard, pause-around- commit), and snapshot is
fundamentally cross-cutting — N participants, one tar, one identity-guard. The orchestrator is the
right home for all of that.

**Consequence.** Snapshot orchestrator is a registry-walker — it walks `Snapshotable` decls and
never names a service. Adding a new plugin to snapshot is declaring a Snapshotable capability — zero
changes to the orchestrator. The hardcoded `runtime/seal/master-key.env` etc. paths disappear.

### 3. Engine / supervisor split (#3)

**Question.** Today's `engine/supervisor.ts` is a single very large file mixing scheduler, dep
graph, watch dispatch, restart, state-store, identity, file-lock, orphan sweep, traefik routing,
signal handlers, and log routing.

**Decision.** **Aggressive split.** Three sharper concepts:

- **Scheduler** (L0): dep-graph, level-batched parallel acquire, subset invalidate, ready-gate
  evaluation.
- **Watch dispatcher** (L3 orchestrator): receives debounced watcher events, maps file paths to
  plugin watch decls, drives the scheduler's subset invalidate.
- **Stack supervisor** (L0): the outer driver — boot identity, consult network resolver, run
  scheduler, fire shutdown finalizers, emit lifecycle events.

Orphan sweep, traefik writes, signal handling, log routing all leave the supervisor: orphan sweep →
L3 prune orchestrator (driven by command); traefik → L1 reverse-proxy runtime; signals → L0 (one
POSIX signal handler at process boot), routed via the command channel; log routing → renderers (L2)
subscribing to the event stream.

Dev-server supervision (Vite, the example app's `pnpm dev`, etc.) is not a special supervisor
responsibility — a dev server is just a registered plugin, and the supervisor drives it through the
same NodePlugin lifecycle as any other plugin, with no dev-server-aware code path in L0.

**Reasoning.** One supervisor file owning everything is the symptom. The seam between "agnostic
supervisor loop" and "concrete plumbing" only stays clean if the plumbing has separate addresses;
otherwise the supervisor keeps absorbing new concerns the way it has today.

**Consequence.** L0 supervisor + scheduler stand alone as two small focused modules; watch dispatch,
sweep, signal handling, and log routing each live at their proper address (L3 / L3 / L0 / L2). No
single file is the load-bearing-everything anymore.

### 4. Codegen-as-plugin vs surface (#4)

**Question.** Is codegen a surface (subscribes to readiness, emits files) or an L2 plugin (its own
`Codegenable` interface)?

**Decision.** **Codegen is a surface (L4)** that walks the **plugin-emitted `Codegenable` capability
decls**. The two are not in tension once we have a Codegenable contract: each plugin owns its own
emitter declaration (a Codegenable slice from `NodePlugin.start`), and the codegen surface is a
single event-driven harvester.

**Reasoning.** Today's "stack member with its own `needs:` edges" makes codegen a plugin so it can
sit in the dep-graph; but the only real edge it needs is "fire after all referenced plugins ready,"
which is exactly what subscribing to lifecycle events expresses. Promoting codegen to a surface
unifies it with build integrations and the manifest writer (both also fire on lifecycle events). The
`Codegenable` contract preserves the principle that emitter domain-knowledge lives with the plugin
(the symptom today: Deepbook emitter accumulating margin reverse-mapping in codegen instead of in
Deepbook).

**Consequence.** The codegen surface is a small event-driven harvester that walks Codegenable decls
— no service knowledge inside it. Per-plugin codegen emission is a small declaration co-located with
the plugin that owns the domain knowledge.

### 5. Build-container ownership (#5)

**Question.** Sui owns the per-app build sleeper but Move-publish, codegen summary-build, and
arbitrary host-CLI builds all consume it. Substrate-level vs Sui-owned.

**Decision.** **Build-container is a ContainerRuntime _consumer_, not a new L1 sub-runtime.** A
small L1 service `BuildContainerService` sits next to (not above) the Docker reference impl and
calls `ContainerRuntime.ensureImage`/`ensureContainer`/`exec` like any other L2 consumer would. It
is L1-placed because it must speak the runtime adapter interface (it is not service-shaped enough to
be L2), and because it composes the ContainerRuntime contract for the build-specific lifecycle:
per-app scope key, long-lived sidecar, exec-driven (no ready-probe race), no Routable, no
Snapshotable.

The build-container's "adopt-or-recreate" state machine that the distilled doc §05 calls out is NOT
a duplication of ContainerRuntime's state machine — it is a _policy_ on top of ContainerRuntime's
primitives:

- Adoption uses `ensureContainer` with adopt-if-healthy.
- The "reject auto-recreate-on-resume-failed" rule is encoded by setting a `recreate: 'never'` flag
  on the `ensureContainer` call; the underlying ContainerRuntime is responsible for honoring it
  (this becomes part of the ContainerRuntime contract — see below).

**Updated ContainerRuntime contract.** `ensureContainer` accepts a recreate policy enum:
`'on-failure' | 'never' | 'on-config-change'`. This was implicit before; the build-container's needs
make it explicit. All consumers benefit; today's per-name lease broker handles the policy uniformly.

**Reasoning.** The critique was right that "L1 sibling component with its own state machine"
duplicates code. ContainerRuntime is already the only layer that knows containers. Build-container
is just a consumer with a particular policy; making it a ContainerRuntime _consumer_ unifies the
state machine. The seven plugins that consume build-container (Sui, Package, any future codegen
plugin) all share the same per-app scope key — derived from identity via the L0 path resolver.

**Consequence.** L1 grows by one small consumer module plus a tiny extension to the ContainerRuntime
contract. Sui shrinks. Move publish, codegen, and out-of-tree plugins all consume the same service
without coupling to Sui. No duplicate state machine.

### 6. Coin discovery + metadata enrichment placement

**Decision.** Coin owns discovery and metadata. Package fires `package.published` on the typed event
stream; Coin subscribes, inspects for `Coin<T>` types, enriches, registers. No direct import either
way; circular-dep risk gone.

### 7. Action vs publish unification

**Decision.** Action is a one-shot specialization of OnChainArtifactPublisher — no `register`
callback, terminal `done`. Action receipts, Move publish receipts, coin mint receipts are all the
same shape; substrate unifies them.

### 8. Renderer mount lifetime vs engine cycle lifetime

**Decision.** Subscribable projection survives cycles. Process-lifetime state-ref + event stream;
renderers subscribe at process start and never unsubscribe. The 14-method proxy-engine wart
disappears.

### 9. Reverse-proxy vs container-runtime interface

**Decision.** Two interfaces. ContainerRuntime and ReverseProxyRuntime are siblings in L1. Backend
swap (docker→podman) is independent of router swap (traefik→caddy).

### 10. State-store / state-registry / global-stack-registry boundaries (#10)

**Question.** Three publish-subscribe primitives today: per-service in-memory registries
(publish/subscribe Ref), disk-backed key-value state-store (cross-process), and global
`~/.devstack/registry.json` (cross-invocation).

**Decision.** **Three primitives, but they live in two layers.**

- Per-service in-memory registries → L0 typed registries (one primitive: capability-keyed
  scope-local Ref). Strategy registry uses this. Coin registry uses this. Same shape, parameterized.
- Disk-backed key-value state-store → L0 (one primitive; typed BRANDed keys; cross-process safe via
  the unified lock).
- Global `~/.devstack/registry.json` → **L0 owns the file (read/write/lock/schema), L3 prune
  orchestrator drives the lifecycle decision via a per-plugin `LifenessClassifier` contribution.**

**Lifeness classification is plugin-emitted.** L3's prune orchestrator asks the registry "give me
all entries for this `(app, stack)` pair," then walks them. For each entry, it dispatches to the
originating plugin's optional `LifenessClassifier` capability (declared as part of
`NodePlugin.start`): given the entry's persisted hints (last heartbeat, claim-PID, claim-start-time,
any plugin-specific marker like a data-dir lockfile path), the plugin returns one of
`alive | dormant | stale | abandoned`. If a plugin emits no classifier, the default — built into L0
— uses only the engine-level hints (PID liveness + heartbeat age threshold). Service-specific rules
("fork-mode Sui with auto-tick paused but data-dir lock held = dormant, not abandoned") live with
the Sui plugin, never in L3 code.

**Reasoning.** The registry _file_ is mechanical (durable typed KV with a lock and an append-safe
codec). Its _interpretation_ is service-shaped (a fork-mode Sui's "alive" rule is Sui-specific). The
critique's leak was conflating these. Splitting them keeps L0 name-blind and L3 walking-only.

**Consequence.** L0 has two registries (in-memory typed + disk-backed typed) plus the global
`~/.devstack/registry.json` file primitive. L3 prune orchestrator is a registry-walker that
dispatches classification to plugins through a typed capability — same pattern as Snapshotable /
Routable.

### 11. Endpoint-name registry ownership (#11)

**Question.** `defineEndpoint` declaration registry is engine-level today, but every well-known
endpoint name is service-specific.

**Decision.** **Plugin-emitted, walked by a substrate registry.** L0 provides the registry shape (a
typed endpoint declaration with name, path projection, conventional host pattern, wire protocol).
Each L2 plugin declares its endpoints from `NodePlugin.start`. The router orchestrator (L3) and
manifest writer (L3) walk the registry. No engine code names `sui-rpc` or `walrus-aggregator`.

**Reasoning.** This is the "engine knows zero service names" principle applied to one more place.
Plugin-emitted declarations already happen for Routable / Codegenable / Snapshotable; endpoint names
follow the same pattern.

**Consequence.** Adding a new plugin with an endpoint = declaring the endpoint from its `start`.
Nothing edits a central registry file. Engine's endpoint-related code (today: imports and merge
order) disappears.

---

## Tensions resolved

15 tensions from synthesis. Each addressed.

### 1. Type-safety vs minimal config

**Resolution.** Type-safety at the user-facing config edge, loosely-typed internals.
`defineDevstack` and plugin factories expose tight discriminated unions + branded keys; internal
substrate uses opaque Brands and treats plugin instances as structurally uniform.

### 2. Plugin extensibility vs substrate simplicity

**Resolution.** Cut speculative for-future-plugins primitives. New plugin authoring needs only
NodePlugin + the capability contracts. Add primitives based on real need.

### 3. Fork-mode-as-first-class vs swappable runtimes

**Resolution.** Fork is a network mode (NetworkResolver returns `fork`); cross-plugin refusals are
typed (Tension 11). Sui's fork specifics stay in Sui's folder; seed-objects accumulator becomes a
StrategyContributor.

### 4. Symmetric surfaces vs CLI-specific concerns

**Resolution.** JSON envelope is a projection of the event stream. CLI is "just another subscriber"
with one projection (events → envelopes → stdout JSON + exit code). Each surface owns its
projection.

### 5. Convention vs configuration

**Resolution.** Convention by default; one env override mechanism via L0's path resolver.
Plugin-specific env-override knobs collapse.

### 6. Engine omniscience vs zero-service-names

**Resolution.** Zero service names, lint-enforced; cross-plugin type-awareness via capability slots.
Cross-plugin contracts (Walrus refusing in fork) expressed via typed refusal, not name-based.

### 7. Cache best-effort vs verify integrity

**Resolution.** Best-effort persistence + lenient verify; codified in OnChainArtifactPublisher.

### 8. Hidden auto-fills vs discoverability

**Resolution.** Auto-mounts visible as `strategy.registered` events, hidden from renderer rows by
default (typed visibility flag). When a strategy lookup fails, the error lists registered
capabilities.

### 9. Atomic restore vs per-phase idempotency

**Resolution.** Bracketed-atomic. One outer stage-and-swap; pre-cleanup best-effort within the
bracket.

### 10. Build container per-app vs per-stack vs substrate-level

**Resolution.** ContainerRuntime consumer, per-app scope. (See Decision §5.)

### 11. Composite refusal as type vs runtime

**Resolution.** **Type-level refusal AND runtime refusal — both, by construction.** The user-facing
plugin namespace exports factories indexed by the `NetworkResolver` result discriminator. The
mechanism, conceptually:

- `defineDevstack` takes a `network` config that is a discriminated union over `mode`. Each plugin
  namespace exposes its factories as a mapped object keyed by mode. `Walrus.localCluster` exists
  only in the branch where mode is `'local'`; in a `'fork'`-typed stack the property does not exist
  — compile-time refusal with a hint listing legal alternatives.
- Cross-plugin compositions (Walrus local cluster requires Sui local) use phantom-typed
  preconditions on factory return types. Composite's resolved value carries a witness ("requires
  local Sui"); the stack-level type-check ensures all witnesses are satisfied.
- Runtime refusal remains as defense-in-depth for dynamic factory selection (env-driven) and
  out-of-tree plugins that decline the discriminator — same structured-error path as today.

**Two surfaces for `defineDevstack`.** The prototype confirmed that a single flat-variadic surface
cannot automatically thread `options.network` into plugin factories that need to mode-narrow
_before_ they are evaluated (the type checker sees plugin factories before it parses the trailing
options bag). The user-facing API therefore exposes **both** surfaces; plugin authors and stack
authors pick the one that fits the stack:

- **Flat-variadic form** — `defineDevstack(memberA, memberB, ..., { network, ... })`. The canonical
  surface for stacks whose composites do not need network-discrimination at the type level. Authors
  who do want network-discrimination on a flat call site thread the network explicitly per factory
  (e.g. `Walrus.for(network).localCluster()`). This is verbose but stays flat.
- **Callback form** — `defineDevstack({ network, ... }, namespaces => [...])`. The canonical surface
  for mode-narrowed composites. The callback receives a namespaces object whose factories are
  already narrowed by the resolved network mode; the user composes from the narrowed set and the
  compiler refuses illegal modes structurally. This is the recommended form when more than one
  composite needs network-discrimination, because it lets the compiler do the threading.

Both surfaces are first-class; neither is a "transitional" or "compat" form. The substrate ships
them together because they cover disjoint ergonomic cases.

**Refusal-regime contrast.** On the flat-variadic form, type-level refusal is opt-in by ceremony —
the user threads the network explicitly per factory (`Walrus.for(network).localCluster()` or
`walrusFor(network).localCluster()`), and without that threading refusal degrades to runtime; on the
callback form, type-level refusal is automatic, because the network parameter passed into the
callback is the discriminator the compiler narrows against.

**Why decide now.** Phase 3 builds the user-facing factory shapes; refining them later breaks every
example app. The discriminator-narrowing pattern is standard TS; the cost is in namespace shape, not
plugin-author code. If phantom-witness ergonomics fail in Phase 3, fall back to runtime refusal for
cross-plugin witnesses only; single-plugin refusal is the floor we do not concede.

### 12. Two stop finalizers, one container

**Resolution.** **Roster-file protocol — concrete.** The in-process typed Ref is for in-process
bookkeeping only; the authoritative cross-process state is one on-disk roster file per stack. The
protocol is spelled out below (see § Cross-process safety protocol). The in-process Ref tracks the
local process's claims; it is mirrored into the roster but is never the source of truth for peer
processes.

### 13. Auto-mounted hidden vs explicit user-supplied

**Resolution.** Typed visibility flag (`autoMounted: true`) replaces key-prefix detection.
User-supplied contributor with the same key suppresses the auto-mount via key-equality. Explicit; no
fragile prefix matching.

### 14. Receipt-as-raw-blob vs typed accessor (Action)

**Resolution.** Raw blob in resolved value; typed accessor helpers in the receipt library surface.
Substrate stays simple; consumers opt into structure.

### 15. Watcher thickness

**Resolution.** Thick watcher in L0: minimatch filter + 250ms debounce + content-hash dedup live in
the L0 watcher primitive. Removes per-consumer reinvention; the substrate carries one debounce
implementation, not N.

---

## Substrate violations: structural prevention

The 20 violations from synthesis, each prevented by construction.

1. **TUI vocabulary in engine API (`markReady(display)`).** Engine API never names display fields.
   Plugin's `start` returns resolved value + opaque capability decls; renderers compute projections
   from events. Lint: no `title|primary|extras|endpoints|lastLog|selectiveRestart` literal in L0.
2. **"Proxy engine" 14 noop methods.** Subscribable state-ref projection survives cycles; renderer
   sees a stable ref + event stream. Nothing to proxy.
3. **Engine error junk drawer.** Per-plugin tagged errors live with the plugin. L0 owns only
   engine-tagged errors (scheduling, identity, cancellation, resource exhaustion).
4. **Engine maintains its own cause walker.** One cause walker in L0, shared by all renderers. Lint:
   `summarizeCause` / `extractDeepestMessage` outside L0 returns zero.
5. **Codegen-path-aware emitters.** Emitters are plugin-owned; codegen surface walks Codegenable
   decls. Codegen surface never imports a service.
6. **Snapshot hardcoded per-service paths.** Snapshotable decls; orchestrator walks. Lint: no
   service-name string literal under `snapshot/`.
7. **Router hardcoded knowledge.** Routable decls; orchestrator mints hostnames from
   `(app, stack, dispatch-id)`. No service hostnames in router code.
8. **Faucet engine/service split.** One dispatch path via StrategyContributor. Auto-mounted SUI
   strategy uses the same path as user-supplied strategies. Dead-code branch disappears.
9. **Sui hosting cross-cutting substrate.** OCA → L0 substrate; chain-probe → capability contract
   #9; build-container → L1 ContainerRuntime consumer. Sui becomes a driver.
10. **`src/runtime/` straddles three layers.** Three-way split: manifest envelope → L0; producer →
    L3; readers → L4. Directory disappears.
11. **Compose mutates Context.Service via Object.assign.** Plugin metadata travels in typed Context
    slots, never on class identities. Lint: `Object.assign(\s*\w+\s*,` outside an approved helper
    returns zero.
12. **Three locks / tempfile-renames / path resolvers.** One lock primitive, one atomic-write, one
    path resolver — all in L0. Lint: `fs.rename` / `O_EXCL` / `flock` outside `engine-resources/`
    returns zero.
13. **EngineHandle conflates lifecycle with log routing.** Log routing is a renderer concern.
    Plugins publish `log.appended` events; renderers subscribe. No `appendLog`/`appendTagLog` on a
    handle.
14. **TuiLoggerLayer in `tui/` with zero React dependency.** L0 owns the log buffer; L2 renderers
    consume it. Co-location accidents are structurally impossible by dep direction.
15. **`phases.ts` lives in engine but engine never imports it.** No `phases.ts` — phase narration is
    a typed annotation on the event stream. Free-form narration wins; closed-enum dropped.
16. **`displayPath` in engine but only codegen consumes it.** `displayPath` lives in L4 codegen.
    Lint: no `displayPath` exported from L0.
17. **`KnownPackage` seed-object accumulator is module-scope mutable.** Typed StrategyContributor
    from Package; Sui's fork plugin consumes the registry at acquire time. No module-scope mutable;
    substrate cleanup runs on scope close.
18. **Module-global watcher dedup cache in supervisor.** Watcher dedup lives in the watcher
    primitive itself (typed Ref).
19. **Three module-global mutables in docker layer.** `ClaimedContainers`, `RouterIpCache`,
    `PerNameLeaseBroker` — typed Context.References in L0. Lint: `let` at module top-level in L1/L2
    is denied.
20. **Heavy-infra reboot-cost annotations hardcoded in engine.** Plugins declare their own
    `rebootCost` (closed enum `cheap | moderate | heavy`, opaque ordinal). The **cascade formatter
    lives in L0 observability as a pure function** that reads plugin declarations and the dep-graph;
    CLI, TUI, and prune orchestrator all call it. No back-import from CLI to renderer. The L0
    formatter's signature is fixed: `formatCause(cause) => string` — pure, sync, no overload, no
    options. Every consumer (prune, CLI, TUI, programmable API) is type-checked against it.
    Structured output reads `rows[].lastError` / `errors[]` off the projection; only stringification
    goes through `formatCause`.

---

## Effect, or not?

**Decision: keep Effect v4.** The architecture above leans on Scope, Layer/Context, Schema, Fiber,
and Cause — Effect's core primitives. The existing test corpus is Effect-flavored, and the substrate
primitives we'd otherwise rebuild (Scope teardown semantics, structured Cause, typed Layer DI) would
be a meaningful in-house plumbing investment. Inheriting them simplifies the substrate rather than
adds to it.

User-facing surface stays plain: factory configs, typed manifest reads, codegen output have no
Effect types in them (L0/L4/L5 separation enforces this). Plugin authors do write Effect; that's the
substrate's authoring vocabulary. Phase 3 must validate that plugin-author ergonomics hit the goals
doc's "~15 lines for a new service" target — if Effect overhead pushes that higher, the contract
widens with helpers, not the substrate switches.

Concrete follow-on: **upgrade to Effect v4** uniformly (devstack is mid-migration today). POSIX
signal handling becomes an Effect v4 primitive; we don't hand-roll it.

---

## What's collapsed, what's deferred

### Collapsed (pairs/triples of today's concepts becoming one)

- **Three locks** (file-lock sync, state-store retry loop, sui-fork variant) → **one lock
  primitive** with sync + Effect facades.
- **Three tempfile+rename impls** (atomic-write, state-store, global registry) → **one atomic-write
  primitive**.
- **Three path resolvers** (state-store, service-paths, snapshot) → **one path resolver** returning
  a typed bundle.
- **Three per-name semaphore registries** (ensure-container, containerPrimitive, file-lock) → **one
  lease broker** with typed Refs.
- **Two cause walkers** (engine summarizer, pretty-error walker) → **one cause walker** in L0.
- **Two log-level env parsers** (seal, walrus) → **one helper in L1**.
- **Three per-line docker log sinks** (walrus, seal, deepbook) → **one per-line streaming sink**
  with level promotion in L1.
- **Two engine/service paths for faucet** → **one dispatch path** via `StrategyContributor`.
- **`__layer` + `__layers` + `__extraMembers` POJOs** (5 plugins) → **one `CompositePrimitive`
  contract**.
- **Three sites managing endpoint metadata** (declaration, structured projection, flat lookup) →
  **one Routable / endpoint declaration** emitted by the plugin, projected by the manifest writer.
- **Manifest writer + codegen emitter + dapp-kit config** (each re-resolving user extras) →
  **resolve-once at acquire**; one blob threaded everywhere.
- **Two near-identical wallet option types** → **one options bag**.
- **Action vs Move publish vs coin mint vs walrus deploy vs seal keygen vs deepbook pools vs pyth
  feeds** (7 instances of the same pattern) → **one `OnChainArtifactPublisher`** primitive; one-shot
  vs persistent are structural variants.
- **State-store + per-service registries + global stack registry** → **two L0 primitives**
  (in-memory typed registry, disk-backed typed KV) **+ L3 prune orchestrator's state** (the
  cross-invocation knowledge).
- \*\*Engine.markReady(display) + Engine.setPhase + Engine.appendTagLog
  - Engine.setEntryTitle** → **plugin → typed event publish\*\* (one shape, one channel).
- **EngineHandle's lifecycle + log routing** → **separate event channels** (lifecycle, log) on the
  typed event stream.
- **TuiLoggerLayer + the renderer's React component** → **single L2 renderer plugin**.
- **runtime/ as schema + producer + reader directory** → **schema in L0, producer in L3, reader in
  L4**.
- **Sui's per-app build-sleeper** (Sui-owned) → **substrate-level build-container service in L1**.
- **Package's coin discovery + metadata enrichment** → **Coin owns its discovery** via event
  subscription.
- **Engine's signal handler + supervisor's signal forwarding + per-runtime signal handling** → **one
  Effect v4 signal handler at L0; everything else listens via the command channel**.

### Deferred (recoverable as additive features)

- One-shot container primitive, host-script primitive (no in-tree callers). Recoverable as `kind:`
  discriminators on NodePlugin.
- Optional TLS in router; `defineDevstack({ router: {...} })` knob; per-flag schema introspection;
  schema-emit on malformed argv; long-running envelope stream for `up`/`fork status --follow`.
- Schema versioning on persisted cache (content-hash + decode-fail → re-produce suffices);
  tombstone-vs-sentinel for cache miss.
- Cross-stack restore, cross-network restore, snapshot-from-live — all refuse by default; recover
  with explicit override later.
- Plugin-contributed snapshot metadata for out-of-tree consumers; bootstrap re-pay on hot-reload
  (document as known limitation).
- `pnpm preview` bearer-token security posture; `effect-app` production deploy path.

### Dropped (dead code; not recovered)

Bindings emitter, `CoinMetadataLoader`, `mintFromTreasury` private path, `register-coins` phase
enum, `StateStoreKeys.publishMove`, `getTraefikRouterIp`, `DEVSTACK_DIRECT_PORTS`, reserved
DockerLabel knobs, Walrus `registerCommittee`/`waitForCommittee`, Wallet fork-control protocol,
`SUI_CHECKPOINT_VOLUME`, Sui's `forkUpstream(network)`, engine merge-order endpoint registry,
`runtimeIncluded` snapshot metadata, the 17-line vitest preset.

Kept-and-documented: Action's optional discriminator-as-Effect re-yielded on cache hits — kept under
OnChainArtifactPublisher.

These deferrals + drops remove a meaningful share of today's surface area — code the current
codebase carries that the redesign does not port.

---

## Open questions for the user / Phase 3

The architecture commits to a default for each; user confirmation desirable before Phase 3 ships.

1. **JSON renderer** for programmatic consumers — default: **no**. CLI envelope projection covers
   programmatic use; add later if a real need emerges.
2. **Top-level `router:` knob on `defineDevstack`** — default: **no**. Env vars + L0 path resolver
   suffice; revisit if users ask.
3. **`safe-env` allowlist plugin-extensible?** Default: **yes**, via typed allowlist Ref each
   plugin's `start` may add to.
4. **CLI exit-code propagation to `process.exitCode`** — default: **yes**, sysexits taxonomy applied
   uniformly; per-verb override via flag.
5. **Selective restart cascading semantics** — default: cascade through dep-graph edges; opt-out via
   a typed flag on plugin declaration.
6. **`pnpm preview` bearer token** in default templates — default: **drop**. Documented opt-in for
   the demo case.
7. **Per-row presentation knobs scope** — default: **process-level env vars** + per-plugin overrides
   via config. Avoid a new config surface.
8. **Build-time CI check: app type-checks with devstack removed from dep graph** — default: **yes**,
   as the load-bearing test of "L5 doesn't import the engine."
9. **`mountUI: true` embedded dev-wallet panel** — default: defer to Phase 3. UX decision, not
   substrate.
10. **Typed builder for capability declarations** — default: **yes**. The prototype confirmed that
    `as const` arrays for the capability tuple are fragile: forgetting `as const` silently widens
    the tuple element types and erases the per-decl narrow information (codegen-emitted shapes
    resolve to `never` for consumers). Phase 3 should ship a typed builder (a variadic helper that
    infers and preserves the tuple shape without requiring `as const` at the call site). Plugin
    authors should not have to remember a single annotation to get type safety.
11. **Branded structured-error types for type-level rejections** — default: **yes**. The prototype
    found that diagnostics for `MissingProviders`, `UnsatisfiedWitnesses`, and `SiblingHashConflict`
    currently surface as "not assignable to parameter of type 'never'" — correct but opaque. Phase 3
    should use branded tagged-error object types (a tagged struct whose field name describes the
    failure, e.g. a field called `__missing_providers` populated with the offending tag union) so
    the IDE shows a self-describing error.
12. **Substrate-level `defineWitness` helper** — default: **yes**. Phantom witnesses today (e.g.
    `Witness<'sui-local'>`) are just `{ readonly [_witness]: 'sui-local' }`. Phase 3 should expose a
    substrate helper that mints the witness symbol centrally so two out-of-tree plugins cannot
    accidentally collide on the same witness tag.

---

## Pressure-test walkthroughs

The 11 hard cases from `_GOALS.md` § "The hard-case list". Each walked in 2-4 sentences against the
architecture.

### 1. Composite primitives with lifted siblings (today's `__extraMembers`, walrus `upstreamImage`, seal `sealImage`)

The composite plugin satisfies `CompositePrimitive`. Lifted siblings are declared by name+factory in
the composite decl; substrate promotes them to scheduler level 0 alongside Sui and dedupes by key
across multiple composites of the same kind. No `__extraMembers` POJO. Maps directly onto
`CompositePrimitive` + lifted-sibling substrate semantics.

### 2. Walrus's 4-shard cluster sharing one image build

The 4 storage-node instances are inner participants of one Walrus composite. They share one
lifted-sibling image build (declared with a key like `walrus.image`); substrate dedupes by key — the
second walrus composite (e.g. a second Walrus in the same stack) sees the same key and references
the already-built image. Maps to `CompositePrimitive` + `ContainerRuntime.ensureImage` cache short-
circuit.

#### Walrus capability composition — worked walkthrough

Walrus is the highest-coverage composite in the codebase: one plugin participates in six contracts
and consumes a seventh. The interactions are spelled out so we can prove the contracts compose
cleanly under the maximum-load case.

**The seven contracts Walrus touches:**

1. **NodePlugin** (implements). Walrus declares a composite key `walrus`, upstream keys
   `[sui, identity, network]` plus an upstream capability `ChainProbe@<chainId>`, watch paths under
   `runtime/walrus/`, and an acquire procedure that emits capability decls for the other contracts
   below.
2. **CompositePrimitive** (implements). Walrus declares lifted siblings: `walrus.upstream-git` (the
   git fetch of the walrus source tree) and `walrus.image` (the docker image build). Inner
   participants: N storage nodes (`walrus.node-1..N`), one aggregator, one publisher, one deploy
   one-shot.
3. **Snapshotable** (implements). Capture descriptor: managed containers identified by **label
   tuple** `(app=<app>, stack=<stack>, plugin=walrus, role=storage-node)` and similar tuples for
   aggregator/publisher — labels are derived from the composite key via a deterministic function the
   substrate provides; plugins never mint label strings by hand. Host-tree subtree
   `runtime/walrus/`. Metadata slice: chainId + storage-node epoch. Quiescence: pause-with-grace
   ≥20s for RocksDB flush.
4. **Routable** (implements, multiple decls). One Routable per public endpoint: aggregator,
   publisher, optional per-node debug. Each has a dispatch-id derived from `(walrus, role)` so two
   Walrus composites in parallel stacks mint distinct hostnames without naming conflict.
5. **Codegenable** (implements). Emits the walrus endpoint constants and aggregator/publisher URLs
   into the `endpoints` slot. Consumes the resolved-once user-extras blob (resolved at acquire — see
   § Resolve-once below).
6. **StrategyContributor** (consumer side). Walrus optionally registers a `coinType: WAL` faucet
   strategy (when local mode). It reads the `chain-probe:<chainId>` slot from the capability
   registry to instantiate its verify probes.
7. **ContainerRuntime** (consumer). Walrus uses `ContainerRuntime.ensureImage` for the image build
   (the lifted sibling backs this), and `ensureContainer` for each inner participant.

Optional: Walrus calls **OnChainArtifactPublisher** (L0 substrate) for its deploy receipt — a typed
one-shot that publishes the Move package, caches the receipt, verifies via ChainProbe, registers.

**Where the overlaps are, and how they resolve:**

- **Snapshotable label tuples vs CompositePrimitive composite key.** The composite key is `walrus`.
  Container labels include `plugin=walrus` plus a per-role discriminator. The substrate provides one
  helper, `labelTupleFor(compositeKey, role)`, that mints labels deterministically. Snapshot
  orchestrator filters by the tuple's `plugin` field (substrate-blind to the value); the
  composite-row aggregation in renderers filters on the same `plugin` field. One source of truth:
  the composite key.
- **Routable dispatch-id vs lifted-sibling dedup key.** Different namespaces. Routable dispatch-ids
  name HTTP endpoints (`(walrus, aggregator)`, `(walrus, publisher)`); lifted-sibling keys name
  parallel-built artifacts (`walrus.upstream-git`, `walrus.image`). They never collide because
  Routable lives under `endpoints:` and lifted siblings live under `siblings:` in plugin
  declarations.
- **Codegen reads from the same chain-probe Walrus's verify uses?** Yes, intentionally. Both go
  through the typed `chain-probe:<chainId>` capability slot. ChainProbe is shared state, not
  duplicated state. Resolve-once-extras (see § Decision on resolve-once below) is computed once and
  threaded into both verify and codegen — they read the same blob.
- **NetworkResolver mode constrains which inner participants exist.** In `live` mode, Walrus's
  composite shape is "no inner containers; resolved value is the live aggregator/publisher URLs"; in
  `fork` mode, Walrus is illegal (its local cluster only makes sense against a local Sui). The
  mode-narrowed factory namespace from Tension 11 makes `Walrus.localCluster()` exist only in
  `local` mode; in `fork` mode the factory doesn't typecheck.
- **Two Walrus composites in one stack** (synthesis §6 admin tag asymmetry). Both reference the same
  `walrus.image` lifted-sibling key — substrate dedupes first-wins. Their composite keys differ
  (`walrus-a`, `walrus-b`). Container label tuples include the distinct composite key. Snapshot
  captures both independently; router mints distinct hostnames from the distinct composite keys.

This walkthrough demonstrates that the contracts compose without new top-level seams. The areas that
needed explicit decision — label-tuple minting from composite keys, codegen-and-verify sharing the
same chain-probe slot, lifted-sibling vs dispatch-id namespacing — are addressed by the substrate
helpers and the contract shapes above.

### 3. Seal's keygen-then-deploy-once semantics

OnChainArtifactPublisher cache entry under Seal's namespace, chainId folded in. First run
produces+registers; subsequent runs hit cache, verify via ChainProbe against the key-server object,
register idempotently. Snapshotable carries the keypair with the 0o600/0o700 mode promise.

### 4. Sui's fork-from-live

NetworkResolver returns `mode: 'fork'`. Sui's fork producer snapshots from live RPC and boots the
fork container. Services-in-fork inherit deployment data via Package's `KnownPackage`
StrategyContributor emission — Sui's fork plugin consumes that registry at acquire time. No
module-scope accumulator. The "fresh scope per compose" property is the substrate-default (strategy
registries are scope-local; each compose gets a fresh scope by construction).

### 5. Selective restart cascading through a composite

Composite declares watch paths; L0 watcher fires; L3 watch dispatcher matches and triggers scheduler
subset-invalidate. Composite's children and downstream consumers inherit invalidation via dep-graph
edges. One-shot consumers that are `done` re-evaluate via the optional discriminator-as-Effect
(re-yielded on every cycle; cache hits collapse to immediate `done`) — kept behavior under
OnChainArtifactPublisher.

### 6. Parallel stacks sharing port broker + state-store + claim labels

Identity is per-stack Context; port broker keys, state-store keys, and container labels all include
the stack triple. Two parallel stacks share the app-scoped port-broker dir (file-locked) but never
collide.

### 7. A live-network service depending on a local one

A live-mode plugin returns a no-op handle (no container to manage); the scheduler is mode-agnostic,
so a no-op ready is still ready; downstream consumers see ready and proceed.

### 8. Hot-restart mid-TUI without losing the renderer subscription

Renderer subscribes to a process-lifetime state-ref at process start. Engine cycle ends, new cycle
begins; the state-ref contents change; renderer sees new state through its existing subscription. No
proxy. (Field enumeration: see § Subscribable projection above.)

### 9. An action that depends on five services

Action is a one-shot OnChainArtifactPublisher with five declared upstream keys. Scheduler runs it
after they're ready. On success: transitions to `done`; excluded from shutdown-pending; no fiber
kept alive.

### 10. Codegen artifacts before example app's dev server starts

Codegen subscribes to `ready` events, walks Codegenable decls, emits atomically, fires
`codegen.emitted`. The supervisor's `stack.ready` event fires only after codegen has emitted. Vite's
start command is gated on `stack.ready` either via the supervisor (when supervisor drives the dev
server) or via a polling read of the manifest manifestVersion field (when Vite owns its own
startup). The manifest's manifestVersion increments per emit; Vite reads it once and stops polling.
Build integrations remain "no engine subscription" by reading the manifest, not the event stream.

### 11. Cross-process two-`pnpm dev` concurrent claim protection

Each process runs the claim/heartbeat/release protocol defined in § Cross-process safety protocol.
The authoritative state is the `roster.json` file under exclusive `stack.lock`; the in-process Ref
mirrors the local view only. Container adoption uses ordinary adopt-if-healthy. Last-leaver (empty
roster at release time) is the process that runs the stop finalizer. Snapshot uses the separate
`snapshot.reservation` file with documented refusal semantics for concurrent peers. Maps directly to
L0's unified lock + atomic-write

- the protocol section.

---

## Implementation hint sketch

Light implementation plan.

### Package directory (sketch)

```
src/
  kernel/         (L0)  identity, paths, lock, atomic-write,
                        port-broker, lease, state-store, cache,
                        watcher (thick), scheduler, lifecycle,
                        event-bus, command-channel,
                        strategy-registry, on-chain-artifact,
                        observability, manifest-schema, supervisor,
                        roster (cross-process safety), errors
  runtimes/       (L1)  container/{contract,docker,log-sink},
                        in-process, reverse-proxy/{contract,traefik},
                        build-container (ContainerRuntime consumer),
                        signal-shell template
  services/       (L2)  sui, walrus, seal, deepbook (with internal
                        pyth module), postgres, faucet, account, coin,
                        package, wallet, action
  renderers/      (L2)  tui, plain, silent
  orchestrators/  (L3)  snapshot, router, watch-dispatcher,
                        network-resolver, manifest-writer, prune
  surfaces/       (L4)  cli, tui-mount, programmable, codegen,
                        build-integrations/{vite,vitest,playwright,
                        browser,manifest-reader}
  contracts/            node-plugin, container-runtime, snapshotable,
                        routable, network-resolver, codegenable,
                        strategy-contributor, composite-primitive,
                        chain-probe, renderer
test/                   mirrors src/ layout (test/kernel/, test/runtimes/,
                        test/services/, test/orchestrators/, test/e2e/).
                        No `*.test.ts` siblings inside src/.
lint-plugin/rules/      no-service-names-outside-services,
                        no-renderer-vocab-in-kernel,
                        no-composite-pojo-outside-helper,
                        no-module-mutables,
                        no-engine-imports-in-l5
```

### Phase 3 type-system implementation rules

These are mechanical rules — not architectural decisions — that the prototype proved necessary for
the contracts to compose at the type level. They are recorded here so the type-system implementation
absorbs them by construction.

- **Phantom witnesses must use return-position variance.** A phantom marker field that participates
  in a `<T, unknown>` upcast relation (the tag flowing into a member slot, the capability decl
  flowing into the stack-level set, the cross-plugin witness flowing through the composite's
  resolved value) must be encoded as a thunk-returning field. The parameter-position encoding looks
  superficially equivalent but is contravariant on its phantom; the prototype showed it silently
  widens to `unknown` and defeats the witness mechanism entirely. Mode-narrowing collapses if any
  phantom on the path uses parameter-position variance. This applies to every phantom in the
  substrate: tag identity, capability emit-shape, cross-plugin witnesses.
- **Capability declarations use a typed builder, not raw arrays.** See open question #10 — the
  substrate ships a builder that infers and preserves the per-decl narrow type without requiring
  `as const` at the call site. The raw-array form is reserved for substrate internals.
- **Witness symbols are minted via a substrate helper.** See open question #12 — the substrate
  exposes a witness-mint helper so two out-of-tree plugins cannot collide on the same symbol.
- **Constraint-widening pitfall.** Every type-level helper over the member tuple (`ConsumedIdsOf`,
  `ProvidedIdsOf`, `MissingProviders`, `ConflictingGroups`, etc.) declares its generic UNCONSTRAINED
  and rewrites the constraint as an outer `Members extends ReadonlyArray<unknown> ? body : never`.
  With a parameter-position constraint the compiler uses the constraint's element type (`unknown`)
  for narrowing and collapses `Members[number]` to `unknown` — silently breaks dedup, missing-
  provider detection, and capability extraction.
- **Empty-tuple Tag-Id widening.** `readonly [] extends ReadonlyArray<Tag<infer Id, unknown>>`
  infers `Id = string`, not `never`. Helpers walking `consumes` / `liftedSiblings` discriminate on
  `tuple['length']` matched against `0` before the inference site.
- **Intermediate type aliases erase narrow inference.** Multi-helper chains return `never` where the
  inline-flat form returns the right conflict. The dedup helper MUST stay inlined — re-verify the
  negative test before any refactor.
- **`defineDevstack` validation surfaces at the PARAMETER position.** `Args & ValidateArgs<Members>`
  must appear on the function parameter; only that form names the missing piece in the IDE. The
  return-type encoding type-checks the same programs but yields an opaque "not assignable to
  `never`".

### Build order

- **Phase 3a — contracts + kernel skeleton.** Nine capability contracts as standalone shapes; L0
  kernel including the roster protocol; minimal lint rules.
- **Phase 3b — runtimes.** ContainerRuntime + Docker; InProcessRuntime; ReverseProxyRuntime +
  Traefik; build-container as ContainerRuntime consumer; signal-shell; log-sink.
- **Phase 3c — Sui as reference plugin.** All modes (local/live/fork) via NodePlugin + ChainProbe +
  NetworkResolver dispatch + Snapshotable. **If Sui doesn't fit, the contract grows; no escape
  hatch.** Discipline checkpoint.
- **Phase 3d — orchestrators.** Snapshot, router, watch dispatcher, network resolver, manifest
  writer, prune. Walk capability registries; no service names.
- **Phase 3e — remaining services in parallel.** Walrus, Seal, Deepbook (with internal Pyth module),
  Postgres, Faucet, Account, Coin, Package, Wallet, Action.
- **Phase 3f — surfaces.** CLI, TUI mount, programmable API, codegen, build integrations.
- **Phase 3g — examples migration.** Examples consume codegen output + build integrations only.
  Shared `examples/_shared/` for dedup'd boilerplate.
- **Phase 3h — lint hardening.** Remaining invariant rules + CI check "user app typechecks against
  generated files alone."

### Dependency graph

Kernel → none. Runtimes → kernel. Services → kernel + runtimes + contracts. Orchestrators → kernel +
runtimes (NOT services). Surfaces → kernel + orchestrators + contracts. Examples → surfaces. Acyclic
by construction; lint enforces no upward imports.

### Simplicity posture

The redesign is meant to be substantially simpler than the current implementation — not "the same
complexity rearranged into nicer layers." The discipline is qualitative, not numeric.

**What we measure simplicity by.**

- **Concepts a reader has to hold.** Five layers, nine capability contracts, one lifecycle state
  machine, one event stream + command channel. A contributor reading the kernel should not have to
  learn service vocabulary; a contributor reading a service should not have to learn scheduler
  internals.
- **Places a new plugin author has to look.** Adding a plugin should mean writing one folder against
  one contract (NodePlugin) plus optional capability declarations. There should be no central
  registry file to edit, no engine-side switch to extend, no service-name string the engine knows.
- **Escape hatches the substrate ships.** Zero is the target. The `__layer/__layers/__extraMembers`
  POJO, the `Engine.markReady(display)` vocabulary inversion, the proxy-engine 14-method handle, and
  the module-level mutable caches all leave; no new escape hatches are introduced.
- **Capability contracts a typical plugin participates in.** Most plugins should touch NodePlugin
  plus 1-3 capability decls. Walrus, the heaviest case, touches seven; that's deliberately the
  ceiling and motivated the pressure-test walkthrough.

**What we don't measure.** We don't set LOC targets, and we don't treat LOC as the discipline
mechanism. LOC is a lagging indicator — the symptom of architectural decisions, not the lever for
them. Arguing about a 25k vs 28k headline distracts from the questions that actually produce the
line count: are services declaring capabilities or carrying their own state machines? Are
orchestrators walking registries or branching on names? Is the substrate growing primitives that the
leaks asked for, or speculative ones?

#### Discipline mechanism

When a layer feels complex — a file is hard to read end-to-end, a plugin needs a feature that
doesn't fit a capability contract, an orchestrator wants to know a service name — the diagnosis is
almost always **"reach for a substrate primitive,"** not "add more code in this layer."
Specifically:

1. **Lift a per-plugin reinvention into a substrate primitive.** The most common right answer. Three
   locks → one lock primitive; three atomic-writes → one; N per-line log sinks → one. When a plugin
   needs something a sibling plugin also reinvented, the primitive was missing.
2. **Strengthen a capability contract.** If an orchestrator wants to special-case a service, the
   contract is under-specified. Extend the capability decl shape so the orchestrator stays
   name-blind.
3. **Drop an explicitly-listed deferred feature back in scope.** Rare; requires user sign-off. Some
   complexity is real and the deferred list was wrong.
4. **Accept the complexity with a written justification.** Open a checkpoint with the user, not a
   quiet block of code.

The signal is complexity or awkwardness, not a line count. If a layer ends up materially larger than
the current implementation's corresponding piece, that re-opens the design — but the question "why
is this larger?" is the architectural one, not "did we breach a budget?"

---

## Revision log

- Round 7: Plugin runtime context wiring decided (Option A — R-channel widening on `acquire`).
  Plugins now yield `IdentityContext`, `ContainerRuntimeService`, etc. directly from within their
  `acquire` `Effect.gen` body; the supervisor provides a `Context.Context<never>` of substrate
  services BEFORE running the effect. Rejected: Option B (substrate-service accessors on
  `BuildContext`) — would have broken the "BuildContext is sync over tag values only" lifecycle
  invariant. Rejected: Option C (both) — duplicates the seam without benefit. Implementation:
  `acquire`'s return type is `Effect<ResolvedOf<Provides>, any, any>`; supervisor's `acquireNode`
  calls `Effect.provide(acquire(ctx), pluginContext)` before `Scope.provide`. Stubs removed from
  sui, postgres, walrus, deepbook, account, wallet barrels. Coin / package / seal / faucet
  L3-capability stubs (publisher, probe, registry, sdk) are unchanged — those bind via
  `StrategyRegistry` / `OnChainArtifactPublisher`, not via substrate context. The NodePlugin
  contract section now documents the R-channel seam explicitly.

- Round 6: Pyth scoped to deepbook implementation detail (per user 2026-05-19); test files live in
  parallel test/ dir mirroring src/.

- Round 5: absorbed Phase-3 + Phase-5-Stage-1 implementation findings. No architectural reversals;
  all 18 items were spec ambiguities or load-bearing details the original elided.
  - Data model: `StackMember` has FOUR generics (provided, consumed, capabilities, lifted-siblings);
    plugin factories must declare `liftedSiblings` as `as const`.
  - Phase-3 type rules: constraint-widening pitfall + outer `extends ReadonlyArray<unknown>`
    conditional; empty-tuple Tag-Id widening special case; ConflictingGroups inlined; defineDevstack
    validates on the parameter position.
  - Cross-process: `snapshot.reservation` carries `hostname`; `container-claims.json` is a sibling
    file to `roster.json`.
  - Lifecycle: BuildContext.get is sync via substrate side-channel populated on `markReady`;
    composite inner participants get a synthetic `compositeParent` indegree; selective-restart walks
    slice via `failed→pending` / `stopped→pending`.
  - State store: typed error channel; tombstone-vs-missing internal, `null` at the typed boundary.
  - Lifted-sibling registry: scope is the stack scope; no per-entry finalizers.
  - Cache: corruption-as-miss is deliberate; contrasted with state-store's typed errors.
  - Endpoint shape: `pluginKey` explicit; brand rule `endpointKey = digest(pluginKey + dispatchId)`.
  - Manifest: read-side version policy (equal/older/newer).
  - Projection: capacity defaults (100/200/100/16KiB/8KiB).
  - `lastError`: "what's broken now," not "most recent observed."
  - Cause formatter signature pinned: `formatCause(cause) => string`.

- Round 4 polish: flat-vs-callback refusal regime explicit; supervisor treats dev-server-plugin as
  any other plugin; one-shot re-evaluation is substrate-driven.

- Round 3: absorbed type-prototype findings — Caps generic on StackMember, phantom variance rule,
  network-threading decision, literal-vs-runtime inputHash distinction, tag covariance documented,
  typed capability builder noted for Phase 3.
  - Plugin instance data model: added a paragraph stating that a plugin's substrate-level type
    carries (a) provided tag, (b) consumed tags, (c) capability set; the capability set is
    structurally available to substrate type computation so codegen emit shapes, snapshot
    descriptors, and routable triples flow through downstream without erasing.
  - NodePlugin contract: added a Tag usage constraint subsection noting that tags are static
    identifiers, not first-class runtime values, and that the substrate's covariant-tag treatment is
    sound only under that discipline.
  - Lifted-sibling dedup contract (G3): refined the `inputHash` regime — literal-typed hashes
    produce compile-time refusal (strict improvement on the original spec); runtime-computed hashes
    degrade to compose-time runtime refusal. Both first-class.
  - Tension 11: decided the network-threading question; both surfaces ship — flat-variadic for
    stacks without mode-narrowed composites, callback form as the canonical surface when
    mode-narrowing is needed.
  - Implementation hint sketch: added a Phase 3 type-system rules section documenting
    return-position-only phantom variance, the typed capability builder, and the substrate-minted
    witness symbols.
  - Open questions list rewritten: removed the resolved composite-refusal-ergonomics question
    (Tension 11 + the dual surface decision settle it). Added three new questions raised by the
    prototype — a typed builder for capability declarations (#10), branded error types for
    type-level rejections (#11), and a substrate-level `defineWitness` helper to prevent symbol
    collisions (#12).

- Round 2: dropped specific LOC budgets per user directive; simplicity is the discipline metric.
  - Per-layer LOC budgets in the layer model removed; replaced with qualitative "complexity posture"
    subsections describing what each layer should read like and what the signal of trouble is.
  - The "LOC sanity check" / "Per-layer src budget" / "Risk-adjusted view" / "Discipline mechanism"
    block is gone; replaced with a "Simplicity posture" section that names what we actually measure
    (concepts to hold, plugin-author look-points, escape hatches, capability-contract participation)
    and why we don't set numeric targets (LOC is a lagging indicator of architectural decisions, not
    a lever for them).
  - "When a layer overruns its budget" framing replaced with "when a layer feels complex, the
    diagnosis is usually 'reach for a substrate primitive,' not 'add more code in this layer.'" The
    signal is complexity, not LOC.
  - Cross-references that depended on LOC framing rephrased qualitatively (Decision §1, §2, §3, §4,
    §5 consequences; Tension 2 retitled "plugin extensibility vs substrate simplicity"; Tension 15
    "Net LOC negative" reframed; "Effect, or not?" no longer leans on a LOC budget argument).
  - Open question on numeric LOC posture dropped — the user resolved it by directive.

- Round 1: closed critical issues C1–C5 and gaps G1–G3 from critique.
  - C1: reframed simplicity posture as the discipline mechanism — qualitative measures (concepts to
    hold, look-points for new authors, escape-hatch count, capability-contract participation) rather
    than numeric LOC accounting.
  - C2: pushed service knowledge out of engine — manifest envelope is name-blind; prune
    classification dispatches to plugin-emitted `LifenessClassifier`; funds-ready becomes a
    `gate:funds-ready` capability slot; cascade formatter moves to L0 substrate.
  - C3: composite refusal decided at type level — mode-narrowed factory namespaces + phantom-typed
    cross-plugin witnesses, with runtime refusal as defense-in-depth.
  - C4: cross-process safety protocol spelled out (roster.json under exclusive stack.lock,
    PID+startTime liveness, snapshot.reservation file, A-mid-restart/B-starts and crash-recovery
    paths covered).
  - C5: Walrus 7-contract walkthrough added; ChainProbe added as capability contract #9; OCA
    explicitly named as L0 substrate.
  - G1: build-container is now a ContainerRuntime consumer (not a separate L1 sub-runtime);
    ContainerRuntime contract extended with recreate-policy enum.
  - G2: renderer subscribable projection enumerated field-by-field (top-level state + Row +
    Endpoint + ErrorEntry + BuildEntry shapes); explicit "fields NOT in projection" list.
  - G3: lifted-sibling key shape specified `(plugin, kind, scope, inputHash)`; dedup contract
    first-wins on identical keys, refuse on same (plugin,kind,scope) with different inputHash,
    never-dedup across plugin namespaces.
