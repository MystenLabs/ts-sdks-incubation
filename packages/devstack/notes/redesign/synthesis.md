# Synthesis: Cross-cutting concerns for the devstack redesign

This synthesis is the bridge from Phase 1 (24 distilled component docs) into Phase 2 (architecture).
It names the first-class concepts the substrate must support, surfaces tensions, and consolidates
open questions. It does **not** propose architecture; that is Phase 2's job.

---

## Goals recap

The redesign aims to replace ~75k LOC of organically-grown devstack with a layered system whose
seams are designed deliberately:

- **L0 engine core.** Agnostic lifecycle substrate: node graph, topo scheduler, event bus, command
  queue, state-store, resource brokers (ports, leases, locks), identity, paths, file-watcher,
  dep-graph, phases. Zero knowledge of services, containers, TUI, networks.
- **L1 runtime adapters.** Concrete `ContainerRuntime` implementations behind a generic interface.
  Docker today; podman, host-process, sandbox plausible.
- **L2 plugins.** Per-service drivers (sui, walrus, seal, deepbook, pyth, postgres, account, coin,
  package, faucet, wallet, action) and renderers (tui, plain, silent).
- **L3 orchestrators.** Snapshot, router, watch-dispatcher.
- **L4 surfaces.** CLI, TUI, programmable API, codegen, build integrations — all peers subscribing
  to a typed event stream and publishing typed commands.
- **L5 consumers.** Example apps; they consume codegen output, never import the engine.

Six plugin contracts mediate the seams: `NodePlugin` (the unit of composition), `ContainerRuntime`
(runtime adapter), `Snapshotable`, `Routable`, `NetworkResolver`, `Codegenable`. The two
non-negotiable principles: **the engine knows zero service names** (lint-enforced) and **surfaces
are symmetric** (CLI, TUI, programmable API, codegen, build integrations all read events and publish
commands; none is privileged). Quantitative targets are ~25k LOC realistic / ~15k stretch, with
per-layer LOC budgets treated as design pressure, not aspirational ceilings.

---

## Dependency graph

Layered top-to-bottom; arrows point downward (consumer → provider). Each component is placed where
its _core responsibilities_ belong, even when today's implementation straddles boundaries (those
straddles become "Substrate violations" below).

```
┌─ L5 CONSUMERS ──────────────────────────────────────────┐
│  24-examples                                             │
└──────────────────────────────────────────────────────────┘
              ↑ (codegen output only — NEVER import engine)
┌─ L4 SURFACES ───────────────────────────────────────────┐
│  20-cli   21-tui   22-programmable-api                   │
│  19-codegen   23-build-integrations                      │
└──────────────────────────────────────────────────────────┘
              ↑ events  ↓ commands
┌─ L3 ORCHESTRATORS ──────────────────────────────────────┐
│  17-snapshot   18-router   (watch-dispatcher = engine)   │
└──────────────────────────────────────────────────────────┘
              ↑ capability calls  ↓ specs
┌─ L2 PLUGINS ────────────────────────────────────────────┐
│  Services: 05-sui   06-walrus   07-seal   08-deepbook    │
│            09-pyth   10-postgres   11-faucet   12-account│
│            13-coin   14-package   15-wallet   16-action  │
│  Renderers: tui  plain  silent (today co-located in TUI) │
└──────────────────────────────────────────────────────────┘
              ↑ hooks / events  ↓ capability calls
┌─ L1 RUNTIME ADAPTERS ───────────────────────────────────┐
│  04-runtime-docker   (host-process, podman, sandbox …)   │
└──────────────────────────────────────────────────────────┘
┌─ L0 ENGINE CORE ────────────────────────────────────────┐
│  01-engine-core   02-engine-resources   03-observability │
│  (lifecycle, scheduler, dep-graph, ports, leases, locks, │
│  state-store, file-watcher, identity, paths, log buffer, │
│  error taxonomy, BigInt codec, span conventions)         │
└──────────────────────────────────────────────────────────┘
```

### Inter-component edges within layers (load-bearing)

- **05-sui is a substrate-of-substrate inside L2.** Account (12), Coin (13), Package (14), Walrus
  (06), Seal (07), Deepbook (08), Pyth (09), Wallet (15), Action (16), Faucet (11) all consume Sui's
  RPC client, chain id, chain-probe, and (where present) faucet URL. Sui is structurally the
  "foundation service" the engine cannot name.
- **Composite L2 → L2 edges.** Walrus, Seal, Deepbook lift inner siblings (`gitFetch`,
  `dockerImage`, `publishMove`) that the topo scheduler must see at level 0 alongside Sui. Pyth has
  the same shape but lighter (in-process).
- **Faucet ↔ siblings.** Faucet auto-registers strategies from Sui (HTTP), Walrus (WAL exchange),
  Package (treasury-cap mint) — a cross-plugin pub/sub on a capability key (coinType). The
  dispatcher doesn't see strategy providers in its dep graph.
- **Package → Coin.** Package's publish discovery is the _sole_ producer of CoinRegistry entries;
  Coin only reads.
- **Account → many.** Every signed-tx member yields Account (Sui, Package, Coin mint, Action,
  Deepbook market-maker, etc.).
- **Wallet → Account.** Wallet HTTP server routes to resolved Account sign closures.

### Cycles or coupling the redesign must break

1. **Engine ↔ TUI vocabulary inversion** (engine names display concepts: `markReady(display)`,
   `title`, `primary`, `extras`, `setPhase`). One-way fix: engine emits facts; renderers project.
2. **Supervisor → 11 service registries.** `engine/supervisor.ts` imports every service registry by
   name to merge into the default Layer. Must collapse to a plugin-walked Layer composition.
3. **Engine errors.ts as junk drawer.** ~20 tagged errors, most service-specific. Per-service errors
   must live with their services; the central walker stays duck-typed.
4. **Snapshot hardcoded per-service paths** (e.g. `runtime/seal/master-key.env`). Must invert to a
   Snapshotable contract each plugin satisfies.
5. **Router hardcoded knowledge.** Hostname/id minting per-service inside engine. Must invert to
   Routable per-plugin.
6. **Runtime substrate (`src/runtime/`) straddles L3/L4/L5.** Schema + producer + reader all in one
   ambiguous directory.
7. **Faucet engine/service split.** Two code paths (direct HTTP + registered strategy) for the same
   SUI funding; auto-mounted strategy is dead code on the most common path.
8. **Per-name semaphore registries reimplemented** three times (`ensure-container`,
   `containerPrimitive`, file-lock).
9. **Three lock implementations** (file-lock sync; state-store retry loop; sui-fork variant) ~90%
   identical.
10. **Three tempfile+rename code paths** (atomic-write, state-store, global registry) implementing
    the same protocol.
11. **Three path-resolution duplications** (state-store, service-paths, snapshot each inline env >
    config > network-aware-default).
12. **Two cause walkers** (engine summarizer vs pretty-error) can disagree on tag detection.

---

## First-class concepts the redesign must support

### 1. Plugin (the unit of composition)

A keyed, schedulable, supervisable thing the engine treats uniformly. Carries: identity key, kind
classification, declared upstream keys, declared watch paths (optional), display projection
(optional), build function (returning a resolved value + optional capabilities), optional extra
layers / lifted siblings for composites.

**Evidenced by every distilled doc.** Currently expressed via the `tag` / `provide` substrate (22),
with hand-rolled escape hatches (`__layer`/`__layers`/`__extraMembers` POJOs) for composites and
hand-rolled members.

**Conceptual contract:** a single discriminated shape — explicitly distinguishes leaf plugins,
composite plugins, and per-instance vs canonical-interface plugins — eliminating the structural-cast
pattern at every consumer site (01, 22). The lifecycle wrap that plugins opt into today must be an
automatic property of _all_ plugins, including composites (today only tag/provide-shape plugins get
auto-wrap; hand-rolled composites must call markAcquiring/markReady manually — 22).

### 2. Runtime adapter

A backend that can manage processes/containers: ensureImage, ensureContainer, exec, logs, inventory,
network, sweep, plus snapshot primitives (pause/commit/save/load/tag). Docker is one impl; host
binary, podman, sandbox are plausible siblings.

**Evidenced by 04-runtime-docker** (the only impl today; ~25 distinct operations behind one
boundary), with 09-pyth and 11-faucet showing the **in-process-runtime** counterpart (no container,
no port, no healthcheck — lifecycle = scoped fiber lifetime). The redesign must treat in-process as
a peer runtime, not a degenerate case.

**Conceptual contract:** every backend must satisfy the generic contract section in 04 — name-atomic
create, inspect-by-name, resume of stopped, adopt-if-healthy, label-stamping, label-filtered
enumeration, content-addressed image build with cache short-circuit, per-line log follow, exit-wait,
pause/commit, exec, ready-probe race against exit, etc. Reverse-proxy is plausibly a _sibling_
interface to ContainerRuntime, not nested inside it.

### 3. Composite primitive

One supervisor row, many inner members. Walrus (06), Seal (07), Deepbook (08), Pyth (09 in lighter
form). The composite presents as a single key but internally composes N inner cache-backed artifact
tags, optionally one or more inner one-shots, optionally one or more long-running containers,
optionally a Move publish, and projects the aggregate value into one or more narrow service tags.

**Evidenced by 06, 07, 08, 09, 14.** Today expressed via the `__layer`/`__layers`/`__extraMembers`
POJO escape hatch (~5 services hand-roll the same shape).

**Conceptual contract:**

- A composite declares its lifted siblings, its inner cache-backed artifacts, and the projections of
  its resolved value into one or more interface tags.
- All inner containers' TUI events route to the **composite row key**, never their own (06).
- Phase narration is per-composite, not per-container (06).
- Stop finalizers run in a forked parallel-strategy scope so teardown is `max(grace)`, not
  `sum(grace)` (06, 04).
- **Composite refusal**: some compositions are illegal under certain network modes (Walrus local
  cluster on `*-fork`, Seal local-keygen on `*-fork`). Refusal must be synchronous with an
  actionable hint (06, 07).
- Asymmetric tag fan-out: the type system _enforces_ "no admin tag on known-deployment" (06, 07).

### 4. Lifted sibling

An inner tag promoted to top-level so the scheduler runs it in parallel with other foundations (sui
boot) AND dedupes it across multiple consumers (two walrus instances sharing one git source clone).

**Evidenced by 06, 07, 08.** Today via `__extraMembers`. Three contract points: declaration site
(composite says "I have these siblings"), dedupe protocol (first-wins by key), and scheduler
contract (place at level 0 alongside other leaves; composite's acquire waits on them via
upstream-keys).

**Conceptual contract:** an opaque "I lift these named tags" hint the composite emits; the substrate
handles dedupe, scheduling, and TUI row presentation. Today the composite reinvents the
slim-primary- slice + upstream-keys edges + dedup-by-key triad each time.

### 5. On-chain artifact publish (cache-key, verify, produce, register)

The recurring discipline: derive a stable identifier from a content-addressed input set; cache the
result keyed by namespace + chainId + content-hash; verify the cached value against chain before
trusting it; produce on miss or verify-fail; register on **every** cycle (hit AND miss) so
downstream consumers always see fresh registries.

**Evidenced by 14 (Move publish — canonical), 13 (coin mint), 06 (walrus deploy), 07 (seal keypair +
key-server object), 08 (deepbook pools + margin pools + balance managers), 09 (pyth package + pyth
feeds), 16 (action receipts).**

**Conceptual contract:**

- Inputs canonicalize before hash (caller responsibility).
- Cache key folds chainId so regenesis cleanly invalidates.
- Verify probe is **lenient** (transient RPC failure → re-run, not evict) and consumes a stable
  identifier produced by previous run.
- Produce runs only on miss / verify-fail.
- Register fires on **every cycle** (08, 14): in-memory registries are per-supervisor-invocation,
  downstream consumers can't tell hit from miss.
- Cache writes after successful on-chain side effects are **best-effort**: an IO defect must not
  roll back the on-chain reality (13, 14).
- Verify probes must route through **typed schema-validated** chain-probe accessors, never raw SDK
  property access (08 — the load-bearing learning).

This pattern is so pervasive (~7 services, 12+ artifact kinds) that making it a substrate-level
primitive is one of the redesign's highest-leverage moves.

### 6. Service mode (local / known / live / fork)

The dispatch axis that determines whether a service stands up containers, projects a frozen registry
record, or refuses composition.

**Evidenced by 05 (sui: local-container / local-external-rpc / live-testnet|mainnet|custom / fork),
06 (walrus: local-cluster / known-deployment / fork-routes-to-known / fork-cluster-refused), 07
(seal: local-keygen / live / fork-known / fork-localkeygen-refused), 08 (deepbook: localnet / live /
fork), 09 (pyth: localnet / known-package / devnet-unsupported), 12 (account: ephemeral-funded
auto-promotes to fork-impersonate under fork Sui).**

**Conceptual contract:** the network is the canonical mode discriminator, resolved once at compose
time from explicit option or env. Each service declares which modes it supports and how each mode
dispatches (local builder, known builder, refusal). The "trivially-succeeding funds-ready gate on
faucet-less networks" property must be first-class (05) rather than per-service branching. Mode
determines **population** of strategy/route registries, never dispatch at acquire (11).

### 7. Strategy registry

A capability-keyed, scope-local, pub/sub registry. Sibling primitives self-register strategies for
known capability keys; the dispatcher selects by key, never by mode.

**Evidenced by 11 (faucet — canonical) and the same pattern would fit signer/keystore selection,
snapshot backends, codegen emitters, network resolvers, runtime adapters.**

**Conceptual contract:**

- Scope-local map, NEVER module-level (parallel stacks would mis-fund).
- Capability key is what callers ask for; mode shapes population, not dispatch.
- Strategies close over their dependencies at construction; dispatch site is context-free.
- Last-write-wins for caller override of built-ins.
- Auto-mounted strategy providers should be hidden from the TUI; only user-supplied surfaces show as
  rows.

### 8. One-shot effect (vs long-running service)

A first-class kind: fire once after upstream is ready, cache the receipt, surface a yieldable ref,
never run again unless invalidated. No port, no listener, no fiber kept alive, no `stopping/stopped`
transitions, no shutdown-pending count contribution.

**Evidenced by 16 (Action — canonical), 13 (Coin mint), 14 (publishMove), 06 (walrus deploy
one-shot), 07 (seal keygen one-shot), 08 (deepbook pool creation, margin setup, margin-seed), 09
(pyth pusher first tick).**

**Conceptual contract:** one branch of the on-chain-artifact pattern (see Concept 5) plus distinct
TUI/lifecycle treatment:

- `ready` collapses to `done`.
- Excluded from shutdown-pending count.
- Optional discriminator-as-Effect re-yielded on every acquire (even cache hits) so it stays in the
  dep graph.
- No automatic retry (16 — transient execute failure stays failed until hot-restart).

### 9. Snapshotable capability

What a service or composite must declare to participate in capture and restore.

\*\*Evidenced by 17 (canonical), 05 (sui contributes chain-id metadata

- fork data extras), 06 (walrus runtime dir), 07 (seal master-key env-file + yaml), 10 (postgres
  writable layer with PGDATA relocation), 12 (account keystore file), 15 (wallet token file), 08
  (deepbook indexer postgres DB).\*\*

**Conceptual contract (lifted from 17):**

- Capture descriptor: filesystem subtrees (auto-included if under the `runtime/<service>/`
  convention, opt-in extras otherwise), managed containers (identified by label tuples, not
  service-specific names), optional typed metadata slice.
- Quiescence hook: how to make my state consistent before commit (typically "pause container";
  postgres needs longer grace).
- Pre-restore hook: identity-guard contribution (chain identity is canonical; others may contribute
  their own).
- Post-restore hook: re-validate / warm cache.
- Missing-tolerance flag.
- File mode bits MUST round-trip (07 master-key 0o600, 12 keystore 0o600, 15 token 0o600).

### 10. Routable capability

What a service must declare for the router to dispatch traffic to it.

**Evidenced by 18 (canonical), 04 (file-provider YAML write/remove), 05 (sui RPC + faucet + GraphQL
routed), 06 (walrus aggregator + publisher + per-node), 07 (seal key-server), 08 (deepbook indexer +
server metrics + REST), 10 (postgres optional host-port + internal alias), 15 (wallet).**

**Conceptual contract (lifted from 18):**

- Backend identity from `(app, stack, service)` → hostname + dispatch-id (parallel stacks must
  produce distinct hostnames).
- Named entrypoint selection (component never picks a port).
- Upstream target — container-on-router-network OR host-process-on-loopback (the router resolves the
  URL; for containers it learns the IP after network attach with bounded retry).
- Optional CORS opt-in.
- Optional wire protocol (HTTP / h2c).
- File-provider only — NEVER docker-provider (the IP timing race forces this).
- Atomic dispatch-file writes (Traefik can torn-read).

### 11. NetworkResolver capability

A service asks "what network am I on?" and adapts its build. Forking is a network mode, not a
separate orchestrator. The resolver returns
`{ mode: 'local' | 'live' | 'fork', chain, rpc?, source?, checkpoint? }`.

**Evidenced by 05 (canonical: sui dispatches local/external-rpc/ live/fork on this signal), 06
(walrus auto-routes `*-fork` → upstream known), 07 (seal `*-fork` lookup), 08 (deepbook same), 09
(pyth same), 10 (postgres anticipates "live" mode for Cloud SQL).**

**Conceptual contract:** one shared resolver consulted by every service; the resolver is computed
once per stack acquire from CLI override > env var > config > default. Live networks expose a
trivially-succeeding funds-ready gate (no faucet branch in service code).

### 12. Codegenable capability

What a service contributes to the user's source tree.

**Evidenced by 19 (canonical), 14 (packages → bindings + per-package ids), 12 (accounts →
name→address map), 13 (coins → typed map), 05 (sui → endpoints + chain id), 06/07/08/09/10
(per-service state), 15 (wallet → dapp-kit config carrying pair URL token).**

**Conceptual contract (lifted from 19):**

- Name (unique across run).
- Registries / services read.
- Emit operation: resolved-snapshot → files-under-staging.
- Optional per-instance state (fingerprint cache).
- Sensitivity flags (drive permissions + .gitignore).
- All emitters share one staging dir + one atomic promote.
- Stable output paths; byte-deterministic re-emit; no mtime touches when content unchanged.

### 13. Status / lifecycle state (engine's view of a primitive)

The closed state machine: `pending → acquiring → ready | failed`; long-running primitives extend
with `ready → stopping → stopped`; one-shots collapse to `ready = done`.

**Evidenced by 01 (canonical).**

**Conceptual contract:** idempotent merge-not-replace transitions; auto- register on `markAcquiring`
(so composites' inner tags surface); no auto-register on phase narration; transient narration fields
cleared on transition to ready/failed; selective-restart highlight is a cosmetic flag, not a
separate state.

### 14. Phase narration (multi-step progress)

A free-form annotation a publisher attaches to its acquiring primitive to drive TUI right-column
status. Today the engine has both a closed phase-tuples module and free-form `setPhase` calls;
per-domain phase strings ("building image", "deploying contracts") drift between typed errors and
TUI narration (06).

**Evidenced by 01, 06 (vocabulary drift problem), 14, 07, 08.**

**Conceptual contract:** structured facet (verb + detail) attached to a primitive's state. Renderer
interprets; engine doesn't name phases. Composite primitives publish phases to the composite row;
container-internal phases (image build, ready probe) become sub-steps under one composite phase.

### 15. Display projection (renderer-side concern)

What the TUI sees vs what the engine knows. The single biggest substrate violation today:
`markReady(display)` makes the engine write renderer vocabulary (title, primary, extras, endpoints,
lastLog, selectiveRestart).

**Evidenced by 01 (the substrate-violation), 21 (the consequence — "proxy engine" with 14 noop stubs
feeding React).**

**Conceptual contract:** publisher emits the resolved value plus opaque structured fields; renderer
reads the state ref and computes its own display projection. Engine state shape never names
"title"/"primary"/"extras".

### 16. Typed event stream (surface-equality channel)

The engine publishes structured lifecycle facts (status transition, phase set, log append, endpoint
registered, error reported, build-status change). Every surface (CLI, TUI, programmable API,
codegen, build-integrations) subscribes to the same stream.

**Evidenced by 20, 21, 22, 23, 19 — all five surface docs describe the same requirement.**

**Conceptual contract:** event facts are renderer-agnostic — they say _what_ happened, not _how to
display it_. Today only TUI consumes this surface directly; CLI's `up` and `prune --interactive` use
renderer-shaped output; CLI's JSON envelope is its own per-verb shape. The redesign should make the
JSON envelope a _projection_ of the same event stream.

### 17. Typed command publication (inbound channel)

The same event-stream pattern in reverse: surfaces publish commands (start, apply, snapshot, wipe,
prune, restart-request, shutdown-request, advance-clock, …) onto a typed channel. Engine consumes;
no surface reaches into engine internals.

**Evidenced by 20 (canonical: CLI subcommands are commands), 21 (TUI keypresses become
shutdown-request / restart-request — today they call engine methods directly through Effect runtime
escapes), 22 (programmable-API parity), 16 (fork advance ops as commands).**

**Conceptual contract:** typed command surface every consumer can publish into; engine internals
never leak. Specifically: TUI's ~14-method "proxy engine" collapses to "subscribable projection +
typed command publisher" (21).

### 18. Identity / chain-identity guard

The `(app, stack, network)` triple flows through docker labels, filesystem paths, hostname
composition, default password derivation. Chain identity is the cross-cutting guard that prevents
cross-chain restore mishaps.

**Evidenced by 02 (canonical identity validation), 17 (chain-identity guard refuses cross-chain
restore — but the CLI doesn't thread it today, making the guard effectively dead), 04
(label-stamping), 18 (hostname/id minting), 13/14/19 (chainId folded into every cache key).**

**Conceptual contract:**

- `(app, stack, network)` is validated once at engine boot.
- Names match a strict regex that survives docker labels AND path joins (no `..`, `/`, spaces, shell
  metas).
- chainId folded into every on-chain artifact cache key.
- Snapshot identity-guard must fire BEFORE any destructive mutation; CLI must thread identity
  through (17 — today missing).
- Identity validation errors should surface as TUI rows, not Layer build aborts (02).

### 19. Cross-process safety

Multiple `pnpm dev` invocations against the same `(app, stack)` must not corrupt each other. Today
the locking story is multi-layered (state-store lock, file-locks, name-atomic docker create,
per-name in-process semaphore) but incomplete (open question in 04: peer processes adopt then both
register stop finalizers).

\*\*Evidenced by 02 (state-store lock canonical), 04 (docker name-atomic

- ATTACHED_FOLLOWERS dedupe), 05 (sui fork data-dir lock, move-build lock), 14 (move-build advisory
  lock under `~/.move`), 12 (EXCL keypair write), 15 (file-locked token file), 02 (file-lock module
  shared across three sites with ~90% duplication).\*\*

**Conceptual contract:** one unified lock primitive (sync + Effect variants behind one config), one
cross-process O_EXCL claim protocol with stale-PID reclaim, one process-liveness check (pid +
start-time match). Foreign-host bodies treated as alive (NFS).

### 20. Quiescence / pause-around-commit

For snapshots: stateful containers must be paused around `docker commit` so the captured writable
layer is internally consistent. WAL flush, RocksDB flush, etc.

**Evidenced by 17, 10 (postgres canonical), 04 (pause/commit/unpause primitives), 06 (walrus storage
node grace ≥20s for RocksDB).**

**Conceptual contract:** the orchestrator pauses by label, commits, unpauses unconditionally
(success AND failure paths). Stopped containers must NOT be paused. Containers declare
quiescence-hook expectations (most are "pause"; some may need app-level flush).

### 21. Sibling self-registration via serviceOption

The substrate-level pattern that lets one plugin contribute to another's scope without a direct
dep-graph edge.

**Evidenced by 11 (faucet — Walrus and Package self-register coin strategies via
`Effect.serviceOption`), 14 (Package contributes KnownPackage seed-objects to Sui fork via a
process-scope accumulator), 05 (`KnownPackage` accumulator is module-scope mutable state with
explicit clear-between-composes — the canonical "fights the substrate" pattern), 16 (action receipts
contribute to nothing today, but conceptually could).**

**Conceptual contract:** scoped registries that siblings can write into via optional service yields;
consumers read at acquire time. The module-scope accumulator must die — `KnownPackage` is the
canonical foot-gun.

### 22. Resolve-once for user-supplied values (extras)

User-supplied `() => ({...})` extras must produce the SAME blob on every read across manifest write,
codegen emit, dapp-kit config.

**Evidenced by 23 (canonical — "Resolve once" was a real bug class fixed by memoizing at infra-layer
build time), 19 (codegen consumes `ExtrasResolved`), 22 (the API contract).**

**Conceptual contract:** the engine resolves user extras once at acquire and threads the resolved
blob through every consumer. No producer re-invokes the user's factory.

### 23. Endpoint declaration (the third place)

The contract a service satisfies to surface an endpoint AND its manifest projection AND its
conventional-URL fallback. Today this metadata lives in three places: declaration, structured
projection, flat lookup (23).

**Evidenced by 23 (canonical), 18 (entrypoint registry), 10 (plain URL + credentialed URL split), 15
(wallet endpoint with pair URL), 06 (walrus per-node endpoints).**

**Conceptual contract:** one declaration drives all three projections. Today three sites; the
redesign must collapse to one. The wallet shows the pattern's full power: a plain URL, a
credentialed URL, a display-redacted projection, and a manifest projection (with mode 0o600 for the
on-disk file vs an open manifest carrying the same token in its fragment — that asymmetry must be
resolved).

### 24. In-process runtime as a peer to container runtime

Some plugins (pyth, faucet, action, account) have no container at all — their lifecycle IS a scoped
fiber's lifetime. Their "readiness" is the completion of their cache + register pass; their teardown
is interrupt-immediate; they have no port, no health probe, no exit-code translation.

**Evidenced by 09 (canonical), 11, 12, 16.**

**Conceptual contract:** in-process runtime is a peer to docker / host-process, not a degenerate
case. The substrate's ready/teardown contract must accommodate "no health probe, scope-bounded
fiber" without forcing in-process services to simulate ready-that-never-stops.

---

## Recurring patterns and primitives

Patterns that show up in multiple components and should be first-class building blocks:

- **Content-hash cache key.** SHA-256 truncated at varying lengths (12 for image tags, 16 for cache
  keys, 24 for codegen fingerprints, 64 for full digest). Folded with namespace + chainId for cache
  isolation. Used by 02, 04, 05, 13, 14, 06, 07, 08, 09, 19.
- **Atomic stage-and-swap.** Tempfile+rename for files; backup-and- swap for directory trees.
  Codegen uses one outer swap; snapshot should but doesn't (17). Three tempfile+rename
  implementations today: atomic-write, state-store, global-registry (02).
- **Name-atomic create with adopt-on-collision.** Docker's `--name` atomicity is the canonical
  signal (04). The redesign should generalize this to other resources (network names, hostnames,
  router IDs) so race-safe-adopt is one pattern, not many.
- **Dep-graph scheduling with level-batched parallelism.** Level K-1 providers complete before level
  K consumers start; same-level siblings build concurrently; shared providers dedupe via MemoMap
  (01). The composite primitive's lifted siblings ride this.
- **Ready-vs-healthy distinction.** Socket-bound (TCP listen) is not funds-transferable (05 — the
  canonical case where a faucet HTTP socket binds before the validator can execute transfers). The
  redesign must distinguish "service ready" from "service capable of serving the next operation";
  the funds-ready gate is one example, postgres's `pg_isready` vs TCP listen is another (10).
- **Bounded retry with jitter for warmup races.** 15 attempts, 90s budget, 500ms initial delay, 1.5x
  backoff, [0.8,1.2) jitter — used by 11 (faucet), recurs informally in 10 (postgres `pg_isready`),
  05 (sui ready probes), 09 (pyth pusher). The "warmup-friendly retry profile" should be a named
  primitive.
- **Lenient vs strict chain probes.** Lenient = transient RPC failure is absence, strict = raise.
  Schema-validated. Drives the verify step of every on-chain artifact (05 — canonical). Past raw SDK
  property access silently masked B1/B3/B5-class bugs (08).
- **Best-effort post-success persistence.** Cache write after a successful on-chain side effect is
  best-effort — chain reality trumps cache IO defects (13, 14, 16). The substrate should make this
  discipline visible at the type level.
- **Idempotent re-execution.** Cache hit + verify success = no-op; cache miss / verify-fail =
  re-fire. Pattern recurs in 05, 06, 07, 08, 09, 13, 14, 16.
- **Parallel teardown with grace.** Forked parallel-strategy scope so N container stops run
  `max(grace)` instead of `sum(grace)` (01, 04 composite stop, 06 walrus 4-node committee canonical,
  07 across stack).
- **Watch-debounce-content-hash dedup.** File watcher emits raw events; consumers re-add minimatch
  filter + 250ms debounce + content-hash dedup. Engine-resources doc (02) flags this as a
  load-bearing smell — the thin watcher forces every consumer to reinvent.
- **Phase-set as closed enum vs free-form narration.** Every service defines a closed phase set for
  typed errors AND emits free-form narration to the TUI; they drift (06). The redesign should pick
  one.
- **Per-line streaming sink with level promotion.** Docker logs carrying embedded WARN/ERROR markers
  must be normalized to the matching log level (04). Duplicated across walrus, seal, deepbook log
  sinks (06, 07).
- **Signal-forwarding entrypoint shell.** Sui, walrus, seal, deepbook all wrap their binary as a
  non-PID-1 child of a signal-forwarding shell because the binary installs no signal handler (05,
  07, 06). Shared image template.
- **Per-address sign serialization.** Per-address semaphore around sign-and-execute so two parallel
  calls don't race the gas-coin version (12 canonical, 02 leasing primitive).
- **Resolve-once memoization.** User extras must produce the SAME blob across manifest + codegen +
  dapp-kit (23, 19).
- **Two-network attach with deferred IP-readback.** Router-network + per-stack network with bounded
  retry to learn the assigned IP (04, 06, 18 canonical).
- **Symbol resolution with case-insensitive precedence.** Coin (13) has the canonical
  case-insensitive multi-key lookup with ambiguity vs no-match distinction. Could generalize to
  other registry lookups.

---

## Substrate violations in the current implementation

Concrete leaks the redesign must invert:

### TUI vocabulary in the engine's public API (01, 21)

`engine.markReady(display: TuiDisplay)`, `engine.setPhase`, `engine.appendTagLog`,
`engine.setEntryTitle` make every plugin's start path depend on the renderer's vocabulary. The
engine's state shape names `title`, `primary`, `extras`, `endpoints`, `lastLog`, `selectiveRestart`
— all renderer-side ideas. **The single biggest agnostic-substrate violation.**

### "Proxy engine" with 14 noop methods feeding React (21)

The TUI accepts the full engine handle (~20+ methods) as a prop; to swap across cycles, a proxy
implementing every method gets built — but ~14 are noop stubs. Each noop is an engine concern with
no business being visible to the renderer.

### Engine error junk drawer (03, 01)

`engine/errors.ts` holds ~20 tagged errors, most service-specific (walrus, seal, deepbook, pyth,
sui, postgres, account, …). The pretty- walker is duck-typed so per-service errors can move home;
the centralization is purely registry-centralization with no consumer benefit.

### Engine maintains its own cause walker (03)

`summarizeCause`, `extractDeepestMessage`, `rawFailure` live in engine; pretty-error has no "deepest
message" helper, so engine rolls its own. Two walkers can disagree on tag detection,
stderr-vs-message priority, recursion shape.

### Codegen-path-aware emitters (19, 23)

Manifest writer and codegen emitter resolve registries multiple times per cycle; emitters know about
specific services (Deepbook config emitter accumulates margin reverse-mapping, Pyth merging,
hard-coded SUI seeding). Domain knowledge should live in services, not emitters.

### Snapshot hardcoded per-service paths (17)

`runtime/seal/master-key.env`, `runtime/walrus/<name>/deploy/`, `runtime/accounts/`,
`runtime/sui-fork/`. Adding a service today requires either routing through the shared
`runtime/<service>/` convention (so it auto-rides) or editing snapshot to register an opt-in extras
entry. No plugin hook.

### Router hardcoded knowledge (18)

Hostname/id minting per-service today; the entrypoint registry is process-global; "Routable" is two
open-coded call sites (docker-backend opt-in, host-process opt-in) rather than a contract.

### Faucet engine/service split (11)

Two error paths for the most common SUI funding: direct HTTP (used by Account top-up) and registry
(used by cross-cutting funding loop). The auto-registered SUI strategy is therefore dead code on the
common path.

### Sui hosting cross-cutting substrate (05)

The on-chain-artifact substrate, the chain-probe service, and the build-container service all live
in Sui's scope but are consumed by Package, Coin, Walrus, Seal, Deepbook, Pyth. Sui's factory file
is ~2k LOC because the four live-mode builders share boilerplate; the substrate-vs-service boundary
is blurry.

### Runtime substrate (`src/runtime/`) straddles three layers (23)

Schema + producer (supervisor-lifecycle) + reader (consumer code) + endpoint declaration registry —
all in one ambiguous directory. The goals doc flags this as symptom #10.

### Compose mutates Context.Service classes via Object.assign (01)

To attach metadata, the substrate mutates the canonical class. The class identity becomes global
mutable state. Same pattern in the tag substrate (22) and composite escape-hatch sites.

### Three lock implementations, three tempfile+rename impls, three path resolvers (02)

The "engine resources" doc itself flags these as the canonical deduplication candidates. The
duplication has shipped real bugs (file-lock module header explicitly flags it).

### EngineHandle conflates lifecycle control with log routing (03)

`appendLog` / `appendTagLog` live on the engine handle; every consumer of the engine surface
inherits log-write capability. TUI's proxy carries log-related shims with different forwarding
semantics.

### TuiLoggerLayer lives in tui/ but has zero ink/React dependency (03)

Co-located by accident.

### `phases.ts` lives in `engine/` but only error classes and the renderer import it (01, 03)

Engine itself never uses it — substrate-misclassified.

### `displayPath` lives in `engine/` but only codegen consumes it (02, 03)

Same pattern.

### `KnownPackage` seed-object accumulator is module-scope mutable state (05, 14)

Explicit clear-between-composes contract — the user must remember. Fights the
everything-is-an-Effect architecture.

### Module-global watcher dedup cache lives in supervisor.ts (01)

A per-file content-hash dedup Map at module scope. Should ride with the file-watcher primitive.

### Three module-global mutables in the docker layer (04)

`ATTACHED_FOLLOWERS`, `traefikRouterIpCache`, the per-name lock map. Each was introduced for a real
race but each is exactly the anti-pattern `ClaimedContainers` (an explicit
`Context.Reference<Ref<Set<string>>>`) was introduced to avoid.

### Heavy-infra reboot-cost annotations hardcoded in the engine (01)

Sui, Walrus, Seal reboot-cost strings live in engine code. Per-service primitives should declare
their own; the cascade formatter reads.

---

## Repeated invariants across components

Invariants that should be enforced once in substrate, not per plugin:

### Cache-verify-or-skip (5, 6, 7, 8, 9, 13, 14, 16)

Every cached on-chain artifact verifies against chain on hit, with a lenient probe. The substrate
should expose this as a single `withCache + verify + produce + register` primitive. Today every
service threads it manually.

### Atomic-write everywhere (2, 4, 7, 10, 15, 17, 18, 19)

Tempfile+rename is the only durable-write protocol. State-store, service-paths, snapshot, router
dispatch files, wallet token, manifest, atomic-write itself, codegen output. Three duplicated
implementations today (02).

### Write-after-read ordering inside subset invalidation (1)

Evict the shadow-cache entry BEFORE closing the scope; concurrent watcher fire must not see
closed-but-still-registered scopes.

### Parallel teardown (1, 4, 6, 7)

Cycle-scope finalizers run in parallel-strategy scope so docker stop grace windows don't stack.
Composite primitives override the default reuse-scope with a child scope. Measured ~145s sequential
vs ~30s parallel for production stack.

### Idempotent re-execution (5, 6, 7, 8, 9, 13, 14, 16)

A second `apply` against an unchanged stack must be a near-no-op (cache hits everywhere, register on
every cycle, no side effects). This is the resume-after-snapshot, the warm-restart, AND the
`pnpm dev` re-run case.

### Identity-guard before destructive mutation (17)

Chain-identity check fires BEFORE pre-cleanup, scalar-state copy, host-tree wipe.

### Register on every cycle (14, 13, 9, 8)

In-memory registries are per-supervisor-invocation; downstream consumers must see them populated
whether the artifact was rebuilt or reused.

### Best-effort writes after on-chain success (13, 14, 16)

The chain has executed; cache IO defect must not roll it back.

### Lenient verify probes (5, 6, 7, 8, 13, 14, 16)

Transient RPC failure → re-run, not evict.

### Foreign-host bodies treated as alive (2)

Cross-host PIDs aren't comparable; NFS lock holders are always alive by definition.

### Per-address sign serialization (12)

Two parallel sign-and-execute calls from the same address must serialize; gas-coin version races
otherwise.

### Post-submit finality wait (12, 14)

Every sign-and-execute waits for finality before resolving, so follow-up tx referencing
newly-created objects don't race the indexer.

### Resolve-once for user-supplied factories (23, 19)

User extras factory called exactly once per acquire.

### Mode bits round-trip through snapshot (17, 7, 12, 15)

Tar capture preserves 0o600 for secret material.

### chainId folded into every on-chain artifact cache key (5, 6, 7, 8, 9, 13, 14)

Regenesis cleanly invalidates everything.

### No host-published port when router fronts (7, 18)

Routed services dispatch by Host header on a shared entrypoint port; two stacks share the same
well-known port.

### File-mode 0o600 inside 0o700 parent for secret material (7, 12, 15)

Best-effort with platform fallback; re-applied on every cycle to recover from manual chmods.

### Watcher excludes its own emit dir (19, 1)

Codegen writes into the watched source tree; the watcher must exclude the output dir or the swap
loops the watcher.

---

## Layering decisions deferred to Phase 2

Cases where multiple distilled docs hand off ambiguously:

### Runtime substrate scope (23 — the canonical case)

The `src/runtime/` directory straddles L3 (write path is supervisor- lifecycle, needs Scope), L4/L5
(read path is pure consumer code), and the shape itself (manifest schema + endpoint declarations is
shared substrate). Three plausible splits:

- Keep one shared manifest module shared between engine and surfaces.
- Split write-path into supervisor / snapshot orchestrator; keep read-path with consumers.
- Pull schema + endpoint declarations into a third shared module; producer + consumers each depend
  on it.

### Snapshot orchestrator vs plugin-driven (17, plus open question in goals)

A unified Snapshotable participant registry is the redesign's central simplification — but where
does the orchestration logic live? Engine? Snapshot-specific module? Plugin-author surface? The
redesign must pick and document.

### Engine / supervisor split (01)

Today `engine/supervisor.ts` is ~2k LOC mixing engine-core (scheduler, dep graph, watch dispatch,
restart loop), engine-resources (state-store / identity / file-lock), runtime-docker (orphan sweep,
traefik, hard- kill), observability (signal handlers, log routing). The redesign must decide the
seam between "agnostic supervisor loop" and "concrete sweep / signal / log plumbing."

### Codegen-as-plugin vs surface (19)

Is codegen a Layer-4 surface (subscribes to readiness, emits files) or an L2 plugin (its own
`Codegenable` interface)? The goals doc says surface; today's implementation has it as a stack
member with its own `needs:` edges (more plugin-like). The redesign must pick.

### Build-container ownership (05, 14)

Sui owns the per-app build sleeper but Move-publish (Package), summary- build (Codegen), and
arbitrary host-CLI builds (out-of-tree plugins) all consume it. Either: keep Sui-owned, OR make
build-container a substrate-level service Sui simply consumes. Today's Sui-owned implementation has
the build sleeper agnostic to stack and network across all stacks of the same app (intentional
dedup) — moving it breaks that property unless designed carefully.

### Coin discovery + metadata enrichment placement (13, 14)

Today inside Package's publish module; logically belongs in Coin. Cross-module concern: a circular
dependency between Package and Coin unless one of them is split.

### Action vs publish unification (16, 14)

Action is one branch of the on-chain-artifact pattern; the substrate should make the unified pattern
visible and let Action be a thin specialization (no register, terminal `done` state) rather than a
parallel module.

### Renderer mount lifetime vs engine cycle lifetime (21, 03)

TUI must mount exactly once per process; engine cycle re-runs across hot-restarts. Today the TUI
installs an internal proxy that re-points at the per-cycle engine. The redesign should choose:
subscribable projection that survives cycles, OR a renderer that's torn down with the cycle (with a
flush hook for the next cycle to drive).

### Reverse-proxy vs container-runtime interface (04, 18)

Router primitives currently live in the same package as the docker runtime adapter because they
share the subprocess seam. Conceptually a backend swap (docker → podman) is independent of a router
swap (traefik → caddy / envoy). Two interfaces vs one.

### State-store / state-registry / global-stack-registry boundaries (02)

Three publish-subscribe primitives today: per-service in-memory registries (publish/subscribe Ref
pattern), the disk-backed key-value state-store (cross-process safe), and the global
`~/.devstack/registry.json` (cross-invocation). The redesign should clarify which lives where —
particularly whether the global registry is engine-resources or its own subsystem.

### Endpoint-name registry ownership (23, 18)

The `defineEndpoint` declaration registry is engine-level today, but every well-known endpoint name
is service-specific. The "engine knows zero service names" rule suggests endpoint metadata should
live with plugins; the substrate should walk a plugin-emitted registry.

---

## Open questions consolidated

Grouped by theme.

### Caching / persistence

- One cache-key derivation path or many? Today: a centralized state-store-keys catalog AND inline
  cache-key calls; they produce different slot shapes (07, 13, 14, 09).
- Tombstone on verify-miss vs sentinel undefined (02, 08).
- Schema versioning on persisted cache entries? Action receipts can desync against SDK upgrades
  (16). Manifest version field (23).
- Cache GC for orphaned chainId entries (16). Snapshot-image GC (17).
- Should `safe-env` allowlist be extensible per plugin (02)?
- Are `safe-env` defaults appropriate for arbitrary plugins (02)?

### Identity

- Identity-guard fail-closed when one side is undefined (17).
- Cross-stack restore semantics (17).
- Cross-network restore semantics (17).
- Should `Identity` validate `network` (02)?
- Should identity-validation errors surface as TUI rows (02)?
- Bare-form auto-promotion of ephemeral-funded to fork-impersonate is undocumented silent behavior
  (12).
- Should chain id of a fork be upstream's real id or fork-derived (05)?

### Lifecycle

- Selective re-acquire trigger pathway (01 — empirically asserted by tests, production mechanism
  unclear).
- In-flight transition during subset-invalidate (01).
- `__hidden` interplay with selective restart (01).
- Restart semantics for one-shot actions (16).
- Auto-tick cancellation/reconfiguration in fork mode (05).
- Cancellation of in-flight signs when wallet scope closes (15).
- POSIX signal handling hand-rolled until Effect v4 lands (01).
- "Mark all remaining pending/acquiring to ready" safety-net method has no obvious production call
  site (01).

### Surfaces

- Should the engine expose a generic event stream + state-snapshot Ref + command channel, or just a
  SubscriptionRef + commands (21)?
- Should there be a JSON renderer for programmatic consumers (21)?
- Should renderer mount receive a narrow engineRef rather than the raw tuiStateRef (03)?
- Per-row presentation knobs (column widths, truncation caps, log buffer size, heartbeat interval) —
  user-configurable at what scope (21)?
- Long-running envelope stream for `up` and `fork status --follow` (20)?
- Per-verb JSON envelopes on `stack *` and `prune --interactive` (20)?
- Per-flag schema introspection for `--schema --json` (20)?
- Restart verb wrapping engine's hot-restart signal (20)?
- Schema-emit action under malformed argv (20)?
- Should every verb propagate envelope's numeric exit code to process.exitCode (20)?

### Plugins

- Composite primitive helper shape — fields, lifecycle hooks owned vs delegated, advanced-only vs
  main barrel (22).
- Lifted-sibling protocol formalization — declaration site, dedupe, scheduler contract (06, 07, 08,
  22).
- Sunset disposition for one-shot container + host-script (no in-tree callers, 22).
- Should plugin-author authoring tier be `/advanced` subpath imports (22)?
- Composite refusal — synchronous throw vs typed error (06, 07).
- Plugin attribution for one-shot effects (16).
- Discriminated config for mode-local options (06 — `local` ignored on testnet today).

### Networking / routing

- Should the redesign add an optional TLS mode (18)?
- Bootstrap re-pay on hot-reload to recover from external mutations (18)?
- `defineDevstack` accepting `router:{…}` config surface vs env vars (18)?
- Plugin-contributed endpoint metadata (23).
- Hot-reloadable entrypoint set (18).

### Snapshot

- Snapshot-from-live (17).
- Fork-mode metadata shape (top-level vs nested under Sui slice) (17).
- Container-enumeration ownership: orchestrator discovers vs caller passes (17).
- Restore as atomic stage-and-swap vs per-phase idempotent (17).
- Image GC ownership (17).
- Host-tree size mitigation (17).
- Canonical snapshot catalog location (17).
- Plugin-contributed metadata visibility for out-of-tree consumers (17).

### Testing / examples

- `pnpm preview` security posture — bearer token inlined into bundle (24).
- `mountUI: true` for embedded dev-wallet panel — every app pairs via popup today (24).
- Multi-instance composition semantics for Seal/Walrus/Postgres in one stack (07, 06, 10).
- `effect-app` production deploy path (24, 22).
- Build-time check that user's app type-checks against generated files alone, with devstack removed
  from dependency graph (19, 24).

---

## Cleanup opportunities consolidated

Aggregated `Opportunities noticed` sections across the 24 docs.

### Duplication to extract

- Three lock implementations → unified sync + Effect variants behind one config (02).
- Three tempfile+rename implementations → one (02).
- Three path-resolution duplications → one shared resolver returning
  `{stateDir, runtimeDir, stateFile, lockFile}` (02).
- Three `dependsOn` implementations in Pyth alone (09).
- Two log-level env parsers (seal + walrus) (07).
- Per-line docker log sink duplicated across walrus, seal, deepbook (06, 07, 08).
- Network-name computation in two postgres call sites by convention (10).
- Sui's embedded postgres sidecar duplicates ~70 lines of postgres machinery (10).
- Move.lock scrub script duplicated host-build path + container-build path (05).
- `useSignAndExecute` ~25 LOC × 3 example apps (24).
- `dapp-kit.ts` ~20 LOC × 7 example apps (24).
- `main.tsx` shell ~25 LOC × 3+ example apps (24).
- `Wallet({allowedOrigins})` two-line litany per app (24).
- `hotRestart: PLAYWRIGHT === '1' ? false : undefined` boilerplate (24).
- Shell guard `if [ -f src/generated/... ]` in every example's `package.json` (24).
- Project-name fold computed twice (04 compose-style labels).
- 5 compose-style docker labels duplicated across run + networkCreate (04).
- Coin discovery + metadata enrichment lives in Package; logically belongs in Coin (14, 13).
- `findPool` closure not testable in isolation (08).
- Test-only state-store-key-prefix exports replaced by typed key builder (13).
- Tests partially duplicate between non-streaming and streaming capture suites (03).

### Dead / dying code

- `depTreeLevels` field declared but no producer (01).
- "Mark all remaining to ready" safety-net method — no production caller (01).
- `phases.ts` lives in engine but engine never imports it (01, 03).
- `displayPath` consumed only by codegen (02, 03).
- `CoinMetadataLoader` context service exported but no production consumer (13).
- `mintFromTreasury` not in public barrel; only one internal consumer via relative path (13).
- Manifest `register-coins` phase enum entry never thrown (14).
- `StateStoreKeys.publishMove` builder disagrees with actual key shape, no production callers (14).
- One-shot container + host-script primitives — no in-tree callers (22).
- Unused IP-memoization helper (`getTraefikRouterIp` + its memo cell
  - test-reset hook) (04, 18).
- `DEVSTACK_DIRECT_PORTS` env documented but not implemented (04).
- `DockerLabel.NETWORK`, `labels?`, `mounts[].readonly?` reserved knobs silently ignored (04).
- Walrus's `registerCommittee` cache wrapper returns null (06).
- Walrus's `waitForCommittee` admin op is void (06).
- Seal's unused `keyServer` slot on typed error (07).
- Wallet declared-but-unimplemented fork-control protocol paths (15).
- Sui's `SUI_CHECKPOINT_VOLUME` no clear consumer (05).
- Sui's `forkUpstream(network)` defensively unreachable (05).
- Engine-requires-merge-order endpoint registry layer (01).
- Action's optional discriminator-as-Effect re-evaluated even on cache hits — correct but
  undocumented (16).
- `runtimeIncluded` metadata field redundant with checking host-tree tar existence on disk (17).
- Bindings emitter exists but no example imports `src/generated/ bindings/` (24).
- Vitest preset is 17-line shim that "doesn't pull its weight" (23).

### Wrong abstraction

- Engine.markReady(display) — renderer-vocabulary in engine API (01).
- Engine's own cause walker duplicates pretty-error (03).
- TuiLoggerLayer lives in tui/ with zero ink dependency (03).
- KnownPackage seed accumulator is module-scope mutable state (05, 14).
- Snapshot hardcodes per-service paths (17).
- Router minting per-service (18).
- Faucet engine/service split — auto-mounted SUI strategy is dead code for the most common path
  (11).
- Walrus's wrapper-image hand-rolled content hash bypasses standard helper (06).
- Pyth's `dependsOn` three different implementations across three primitives (09).
- Deepbook's `Object.assign(fn, {seed: fn})` sugar — separate top-level export is clearer (08).
- Account's persisted keypair file bypasses typed-state-store-keys registry (12).
- Action's `PublishError` overloaded for mint failures (13).
- Wallet's two near-identical option types with translation fold (15).
- Codegen Deepbook emitter accumulates domain knowledge that belongs in Deepbook (19).
- CLI prune file is 600+ LOC, should be split per-mode (20).
- Manifest carries unredacted pair URL inline (15, 23).
- Three sites manage endpoint metadata (declaration, structured projection, flat lookup) (23).
- Two deepbook vendor schemes (`.devstack/imports/` vs `.devstack/vendor/`) (24).

### Leaky interfaces

- StackMember is structural; consumers cast to reach optional fields (01, 22).
- `__layer`/`__layers`/`__extraMembers` hand-rolled composite POJO (22, 06, 07, 08).
- Two ways to attribute a plugin name (option vs HOF stamping) (22).
- engine.compose mutates Context.Service class via Object.assign (01).
- Engine-requires-merge-order endpoint registry layer (01).
- Module-scope mutables in docker layer (`ATTACHED_FOLLOWERS`, `traefikRouterIpCache`, per-name lock
  map) (04).
- `globalThis.__devstackDAppKit__` slot vs typed bridge (23).

### Tighten / formalize

- BRAND `StateStoreKeys` with opaque typed-key shape (02).
- Tagged discriminator in cache verify result (02).
- Per-strategy amount branded units (faucet WAL takes SUI MIST, faucet SUI ignores amount,
  treasury-cap takes raw u64) (11).
- Validate `network` inside `Identity` (02).
- Make hidden-or-not a type-level discriminant on options (22).
- Manifest carries `manifestVersion` field (23).
- Snapshot metadata schema version (17).
- Coin `BUILTIN_COINS` either close door (SUI only) or open it curated list (13).

---

## Tensions / trade-offs to resolve

Places where two principles pull against each other.

### 1. Type-safety vs minimal config

- The trivial `devstack.config.ts` should be a one-liner (22, 24); trailing-options bag must be
  discriminated from members structurally, which forces a brand symbol that hand-rolled composites
  don't always carry.
- Discriminated union returns from factories (local vs known) defeat type narrowing downstream (09);
  making them structurally identical weakens type safety, making them distinct loses default-fill
  UX.
- `local: Record<string, unknown>` pass-through on top-level facades loses autocomplete for the most
  common knob (08, 24).
- Loud-by-default warnings for missing upstream declarations vs ergonomics of "Sui auto-fills,
  doesn't need declaration" (22).

### 2. Plugin extensibility vs LOC budget

- A unified composite-primitive helper + lifted-sibling protocol + on-chain-artifact substrate is
  the central simplification — but it's also new substrate code that adds to engine LOC.
- Plugin authors need primitives (container, image, git-fetch, host-process, one-shot) (22). Some
  have no in-tree callers (one-shot container, host-script). Cut to budget vs preserve for future
  plugins?
- Stretch budget (~15k) only reachable if speculative / dead code is aggressively cut and tests
  testing wrong abstractions are dropped not ported (goals). Each cut risks losing a real future
  need.

### 3. Fork-mode-as-first-class vs swappable runtimes

- Goals doc: forking is just a network mode (NetworkResolver returns fork). Services dispatch on it.
- Reality (05): fork has its own image build, its own meta gate, its own SDK guard wrapping, its own
  admin RPC surface, its own auto-tick fiber, its own data-dir file lock, its own seed-objects
  accumulator, its own incompatibility refusals with Walrus/Seal local clusters.
- The mode discriminant is mostly contained in the Sui driver, but the refusal-at-compose-time edges
  and the seed-objects pre-population ripple into every composite. Making fork "just a mode"
  requires these cross-plugin contracts to be first-class, not Sui-specific.

### 4. Symmetric surfaces vs CLI-specific concerns

- Goals: all surfaces subscribe to the same event stream and publish the same commands.
- Reality (20): the CLI has its own envelope schema, exit-code taxonomy, prompt severity tiers,
  sysexits mapping, dry-run shape, --json discipline. The TUI doesn't need any of those.
- The redesign must decide whether the JSON envelope is a projection of the event stream (CLI is
  then "just another subscriber") or its own surface contract.

### 5. Convention vs configuration

- Convention beats configuration for host paths: services routing through `runtime/<service>/`
  auto-ride the host-tree tar (17).
- But: every cross-cutting concern (runtime substrate, codegen output location, manifest path,
  snapshot catalog location, port allocator dir, lock dir) has env-var overrides. The redesign must
  decide which overrides to keep and which to convention-fy.

### 6. Engine omniscience vs zero-service-names principle

- Goals (lint-enforced): engine knows zero service names.
- Reality: heavy-infra reboot-cost annotations are in engine (01), endpoint name registry is
  engine-level (23), service-specific snapshot paths are in snapshot (17), per-service drivers are
  referenced by name in the supervisor's Layer composition (01).
- Inverting these is the redesign's central work. The lint rule is the discipline mechanism. But the
  inversion has cost — composite refusals (Walrus local cluster on `*-fork`) require cross-plugin
  type awareness; achieving it via the type system without naming services is a hard puzzle.

### 7. Cache best-effort vs verify integrity

- Mint succeeds on-chain, cache write fails: best-effort, next cycle re-mints, accept duplicate
  (13).
- But: if cache invalidates spuriously, non-idempotent bodies create duplicates the user doesn't
  expect (16).
- The substrate must surface idempotence-is-caller's-responsibility at the type level (or by
  convention), then trust callers.

### 8. Hidden auto-fills vs discoverability

- Faucet auto-mounts hidden so the user doesn't see infra they didn't type (11).
- But: when a faucet request fails on mainnet because no SUI strategy was registered, the error
  pointed at a hidden component the user doesn't know exists (11). The "auto-mount visibility" knob
  has two values that no caller sets explicitly.

### 9. Atomic restore vs per-phase idempotency

- Snapshot restore should be atomic against external watchers (17).
- But: pre-cleanup is best-effort (daemon down tolerated), container loads accumulate harmlessly
  under re-run, scalar-state can be partially overwritten. Two-flavor design: bracket whole restore
  behind one atomic swap, OR make every phase individually re-runnable with same final result.

### 10. Build container per-app vs per-stack vs substrate-level (05)

- Today: per-app (stack- and network-agnostic) so dep caches share across stacks; Move builds
  serialize via container exec queueing.
- But: substrate-level shared service would let codegen + package + out-of-tree plugins all consume
  one build container without it being "owned" by Sui. The dep-cache dedup property is the load-
  bearing constraint.

### 11. Composite refusal as type vs runtime

- Walrus local cluster on `*-fork` must refuse synchronously with an actionable hint (06). Same for
  Seal local-keygen on `*-fork` (07), Deepbook live mode without explicit pools (08).
- Today's "throw at factory call site" is correct but loses the type system's help. Encoding the
  refusal at the type level (mode → available factories) hardens it; encoding via runtime check
  preserves the simple call-site API.

### 12. Two stop finalizers, one container (04 open)

- Two `pnpm dev` processes against the same `(app, stack)` adopt the same containers fine. But each
  registers a stop finalizer that fires on its own scope close, potentially stopping containers the
  peer is still using.
- File-lock at the engine layer (cross-process)? Per-stack lock? Documented user-don't-do-that? The
  cross-process safety story has a gap and the redesign must close it.

### 13. Auto-mounted hidden vs explicit user-supplied (11, 22)

- Default-fill of Sui and Faucet keeps the trivial config a one-liner.
- But: user-supplied equivalents (custom Faucet name) must suppress the auto-fill via key-prefix
  detection. The detection rule is fragile and undocumented; user-renamed primitives can
  accidentally drop the default.

### 14. Receipt-as-raw-blob vs typed accessor (16)

- Action receipts surface raw `effects` / `objectChanges` / `balanceChanges` arrays; consumers
  commonly want a typed lookup ("which object of type T did this create").
- Typed accessor adds substrate complexity; raw blob is portable and matches SDK.

### 15. Watcher thickness (02)

- Goals doc and engine-resources both flag that the thin watcher forces every consumer to re-add
  minimatch filter + 250ms debounce + content-hash dedup. Pushing them into the watcher absorbs
  supervisor lines but trades simplicity for thickness.
- Same trade-off applies to: cache eviction (substrate vs caller), retry-with-jitter (substrate vs
  caller).

---

## Closing note

The 24 distilled docs converge on a small set of repeating concepts: the on-chain-artifact pattern
(cache + verify + produce + register), composite primitives with lifted siblings, mode-driven
service dispatch, capability registries (Snapshotable, Routable, Codegenable, NetworkResolver,
FaucetStrategy), and the engine/renderer vocabulary inversion. These are the redesign's first-class
concepts. Phase 2 must pick:

1. **Where the on-chain-artifact substrate lives** (engine? own L2 substrate? L3 alongside
   snapshot?). It is consumed by 7+ services and is the single most reused pattern in the codebase.

2. **How composite primitives express themselves at the type level** (one shape with lifted-sibling
   declaration? two shapes — leaf and composite? plugin authors plus library composites?). This is
   the highest-leverage seam: getting it right makes Walrus/Seal/Deepbook declarative; getting it
   wrong forces every composite to reinvent the `__layer`/`__layers`/`__extraMembers` POJO.

3. **The renderer-engine boundary** (subscribable projection + command channel — same channel
   CLI/programmable-API/TUI/codegen/ build-integrations all use). This is what "surfaces are
   symmetric" means in code; today's `markReady(display)` is its negation.

4. **The runtime substrate's home** (manifest + endpoint declarations + resolve-once-extras +
   sync/Effect read paths). The "L3/L4/L5 straddle" is the symptom; the resolution is one of: shared
   module between engine and surfaces, write-path-with-supervisor / read-path-with-consumers split,
   or shared schema/declarations module both sides depend on.

5. **Cross-process safety story for concurrent `pnpm dev`** — the open gap where two adopters both
   register stop finalizers (04). One of: per-stack file lock at engine, peer detection at adopt, or
   document-and-accept.

Everything else is design that flows from these five.
