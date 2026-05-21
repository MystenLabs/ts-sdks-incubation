# Architecture critique

## Verdict summary

The architecture is solid in its high-level shape — six layers, eight capability contracts, a clean
separation of fact from display, an event-stream/command-channel substitute for the proxy-engine. It
correctly resolves the highest-leverage tensions (TUI vocabulary out of the engine,
OnChainArtifactPublisher as a substrate primitive, snapshot

- router as registry-walking orchestrators). However, it is **not yet ready for Phase 3
  implementation**. The design has several places where it appears to resolve a tension by renaming
  it; several places where two decisions don't compose cleanly under stress; a real type-safety
  puzzle in CompositePrimitive that is acknowledged but shoved into Phase 3 without scoping; and an
  LOC budget that is arithmetically self-contradictory (the per-layer numbers sum to ~25-36k for src
  alone, ~50-72k once tests are included, blowing past the goals doc's "25k realistic / 50k
  including tests" total budget even on the optimistic end). The cross-process safety story for two
  concurrent `pnpm dev` invocations is still hand-wavy in ways that mirror the synthesis's flagged
  gap. The "engine knows zero service names" rule has at least two unresolved escape valves.
  Recommend one revision pass focused on (a) tightening the LOC accounting against the goals doc,
  (b) closing the cross-process safety lifecycle gaps, (c) deciding whether composite refusal lives
  at the type level or not (the "decide later" punt is exactly the historical escape-hatch failure
  mode the goals doc warns against), and (d) specifying the missing capability contracts (chain
  probe, build container consumer, FaucetStrategy distinct from StrategyContributor).

## Critical issues

### C1. LOC budget is internally inconsistent with the goals doc

The architecture's "LOC sanity check" table (architecture.md § Implementation hint sketch / LOC
sanity check) totals **25–36k for src alone**. The goals doc § Quantitative targets sets the budget
at **~25k realistic / ~15k stretch — TOTAL, including tests**, with today's total at 75.5k (50.7k
src + 24.8k tests). The architecture later says "tests roughly double; total package size ~50k
including tests, vs today's 75k" — which means the architecture is silently re-baselining the budget
from "25k total" to "25k src + 25k tests = 50k total." This is a budget _raise_ not a budget _hit_,
and the goals doc explicitly says:

> **Discipline mechanism**: when a layer's LOC budget is exceeded during impl, the rule is _stop and
> rethink the design_, not _raise the budget_.

The architecture has done exactly the latter at the design stage, before any code is written. The
upper bound of the per-layer table (36k src + ~36k tests = 72k) is **96% of today's total**, which
is not a rewrite — it's a refactor with extra steps.

Consequence: every later decision that "buys" a primitive in L0 (the thick watcher,
OnChainArtifactPublisher substrate, lease broker, build container in L1, etc.) is paid against a
budget that has already silently doubled. The original ~75% reduction target is unreachable on the
current shape.

### C2. "Engine knows zero service names" has unenforced escape valves

The architecture lists this as a non-negotiable principle and asserts it's lint-enforced. But
several decisions silently keep service-shaped knowledge in places the lint rule won't catch:

- **Decision §11** (endpoint-name registry ownership) makes endpoint names plugin-emitted — good —
  but the manifest schema in L0 (§Component placement: "Manifest schema + endpoint-declaration
  registry shape | L0 | S") is described as a typed shape that the router orchestrator and manifest
  writer both consume. A typed manifest schema either has named service slots (in which case L0
  knows service names) or it's `Record<string, unknown>` (in which case the type-safety claim
  collapses for consumers). The architecture never says which.

- **§Decisions on the 11 deferred layering questions / #10** introduces a "L3 prune orchestrator's
  state" that holds the cross-invocation `~/.devstack/registry.json`. The synthesis (#19
  "Cross-process safety") makes clear this file classifies stack lifecycle states
  (`active | dormant | stale | abandoned`). Doctor/prune commands consult it. This means **L3 has to
  know about lifecycle classification rules that today depend on service-specific definitions of
  "alive"** (e.g. is a fork-mode Sui with auto-tick paused but data-dir-locked "dormant" or
  "abandoned"?). The architecture is silent.

- **Capability contract #5 (NetworkResolver)** says "live networks expose a trivially-succeeding
  funds-ready gate." That phrase presupposes that the engine knows what "funds-ready" means as a
  generic capability slot. Today this is Sui-specific. Lifting funds-ready to L0 means the engine
  knows there's an asset that needs to be ready before transactions can settle — that's a
  Sui-specific abstraction with a Sui-shaped name. Is it really generic? The architecture doesn't
  say.

- **§Substrate violations / #20** "Plugins declare their own reboot-cost" is fine in principle but
  the description ("A `rebootCost` field on the plugin declaration; the renderer's cascade formatter
  walks plugin decls") puts the cascade formatter in renderers (L2). But the cascade formatter today
  is consumed by CLI exit codes and by the prune orchestrator's stale-stack decisioning — both of
  which need a numeric/ordinal sense of cost to decide what to abandon. So either renderers
  re-expose the numeric data (which means renderer becomes a substrate, breaking L2's role) or L3
  reads `rebootCost` directly from plugin decls (which makes "the engine knows reboot cost per
  plugin" a real thing again, just at L3 not L0).

### C3. Composite refusal type-level work is punted at exactly the wrong moment

§Tension 11 says: "Runtime now; type-level refinement in Phase 3." This is exactly the historical
failure mode the goals doc warns against: a deferred decision that, when re-opened
mid-implementation, becomes an escape hatch. The synthesis (§Tension 11 — Composite refusal as type
vs runtime) is clear that **Walrus's local cluster on `*-fork` should not even be a
type-system-legal stack composition**, because the user types `Walrus.localCluster()` knowing it's
local but they have `network: { mode: 'fork' }` elsewhere. Today's "throw at factory call" satisfies
the user but lies to the type system.

The architecture says (§Open question 3): "Default: Runtime now; type-level refinement deferred to
Phase 3. If Phase 3 finds the type-level work cheap, we do it; if expensive, we stay with runtime
refusal." But Phase 3 is where the user-facing config API gets typed. If composite refusal is
structurally expressible at the type level, it has to be designed _into_ the discriminated-union
shape of `NetworkResolver`-result-driven factory exports. Punting this to Phase 3 means Phase 3
inherits a fait-accompli: factories already exist with their current type signatures; refining them
later breaks the user surface. This is exactly when the lesson from synthesis §Closing note #2 ("How
composite primitives express themselves at the type level") needed to be answered, not deferred.

### C4. Cross-process safety: the lifecycle gap is renamed not closed

§Tension 12 ("Two stop finalizers, one container") resolution: "Per-stack cross-process file lock +
adopt-tracking in a typed Ref." And §Pressure test #11: both processes succeed in acquiring shared
read locks, both increment a typed Ref counter, last-leaver runs the stop finalizer.

But this answer **only works inside one process at a time**:

- A typed `Context.Reference<Ref<…>>` is in-process. It cannot be the cross-process counter. The
  cross-process counter must be the file (or its modifications). The architecture doesn't say how
  the typed Ref and the file stay in sync.

- What happens if process A is mid-restart when process B starts? Process A's scope close has begun
  (decrementing); process B is also incrementing. Without a CAS protocol on the shared file (the
  architecture never describes one), the counter is racy.

- "Both processes succeed in acquiring shared read locks" — the unified lock primitive (§decision
  §12, §L0) is described as O_EXCL based. O_EXCL is exclusive; shared-read is not a property of
  O_EXCL. The architecture is silently mixing two different locking models.

- What if process A crashes between claim and release? The "PID + start-time match" pattern
  (synthesis §19) is fine for _exclusive_ locks where the holder is identifiable. For a counter that
  multiple peers share, "did the dead peer hold a count?" is harder — you need a roll-call protocol
  over the shared file. The architecture doesn't describe one.

- What if both want to snapshot concurrently? Snapshot pauses containers (§3 Snapshotable /
  Substrate provides: pause/commit). Pausing while a peer process is mid-acquire (which the engine
  doesn't see because it's the other process) means the peer's ready-probes start failing. This is
  not addressed.

The synthesis listed this as the canonical open question (§Closing note #5). The architecture's
response is "do what we say to the in-process Ref + use a file lock" — which is the right shape but
not actually a protocol. Phase 3 will hit this at line N and have to choose an escape hatch.

### C5. Capability contracts under-specified at the composition points

The eight capability contracts compose via shared substrate, but several composition points are
described informally:

- **Walrus participates in Snapshotable + Routable + Codegenable + CompositePrimitive + uses
  ContainerRuntime + reads from NetworkResolver + writes a StrategyContributor (WAL faucet).**
  That's six contracts on one plugin. The architecture has no worked example showing how all six
  interlock for Walrus — only high-level pressure-test paragraphs. In particular: does Walrus's
  Snapshotable descriptor refer to its CompositePrimitive's inner-participant container labels, or
  to the composite's row key? The synthesis (§17, §06) is clear that labels are the right answer;
  the architecture says "managed containers (identified by label tuples)" but doesn't show how the
  label tuples are minted from the composite key.

- **The Codegenable contract reads "typed registries / services it reads at emit time"** (§contract
  6 / Plugin must provide). In synthesis §19, the codegen surface today re-resolves the same
  manifest snapshot and ExtrasResolved multiple times per cycle. The architecture says "resolve-once
  memoization" lives in the Codegenable substrate — but the substrate doesn't know what "extras"
  are. Either Codegenable substrate has a hardcoded notion of user-extras (engine knows a
  user-config concept), or each emitter does it independently (resolve-once is on the plugin author,
  contradicting "substrate provides"). The architecture doesn't pick.

- **OnChainArtifactPublisher** describes "verify probe MUST consume a typed schema-validated
  chain-probe accessor (no raw SDK property access)" — but the chain probe is a separate capability
  that today only Sui provides. The architecture mentions a "chain-probe service" in §Substrate
  violations #9 ("an L2 capability slot service plugins declare 'I need a chain probe'; Sui provides
  one impl") but it is not in the list of eight capability contracts. This is a missing top-level
  contract, not a sub-shape.

### C6. The decision to "keep Effect" leaks into user-facing surface in undisclosed places

The goals doc cautions against leaking Effect into user-facing APIs ("user-facing type safety;
internal types may be loose" — synthesis §1). The architecture commits to Effect (§Effect, or not?)
and claims the L0/L4/L5 separation keeps it out of bundle for L5 consumers. But:

- **Codegenable emit operation** (§contract 6): "resolved-snapshot → files-under-staging". In
  §implementation hint sketch §contracts/ the contracts are presented as TS shapes. Codegen output
  is L5; but the emit operation is L2 (plugin-side). If `emit` is an `Effect`, then every plugin
  author writes Effect.

- **NodePlugin.start** (§contract 1): "A typed plugin runtime context" → "produces a resolved value
  plus zero or more capability declarations." The "plugin runtime context" is Context.Tag-based
  (Effect). Plugin authors write Effects. The goals doc says plugin authoring should be ~15 lines
  for a new service (synthesis §22 "Plugin-author primitives (container, image, git-fetch) make new
  container-backed services land in ~15 lines"). Effect-flavored 15 lines is not the same affordance
  as plain-JS 15 lines.

- The architecture doesn't show a single example plugin in syntax. Phase 3 will discover the
  ergonomics, not the architect.

### C7. Faucet's "one dispatch path" elides a real distinction

§Tension 8 + Decisions §11 / §Substrate violations #8: faucet collapses to one dispatch path via
`StrategyContributor`. But synthesis (§7 Strategy registry) is clear that the strategy registry is
the **scope-local, capability-keyed map** for both faucet strategies and other things. Synthesis
open question (§Tensions 13) also says "If a third-party finds them lacking, we add primitives based
on real need." But faucet's needs are specific:

- Strategy values carry **branded units** (synthesis §Cleanup opportunities/Tighten: "faucet WAL
  takes SUI MIST, faucet SUI ignores amount, treasury-cap takes raw u64"). A generic
  StrategyContributor can't enforce this.

- Auto-mount visibility (synthesis §Tension 13) is faucet-specific rule: auto-mounted are hidden,
  user-supplied are not, and the detection used to be key-prefix-fragile.

The architecture says (§Open questions for Phase 3 / §1) "if we find we need others
mid-implementation (e.g. a FaucetStrategy distinct from StrategyContributor, …), they're sub-shapes
of the general contracts — not new top-level capabilities. The discipline mechanism: a new top-level
capability requires explicit re-opening of this document." This is a Phase-2-can't-decide
masquerading as discipline. If FaucetStrategy is a sub-shape, what does it inherit and what does it
override? The architecture has no sub-shape machinery defined.

## Significant gaps or hand-waves

### S1. Build-container's lifecycle vs ContainerRuntime contract

§Decision §5: "Substrate-level build-container service in L1, agnostic to stack and network, scoped
per-app." But the ContainerRuntime contract (§2) explicitly is "the only layer that knows
containers." If the build container is an L1 component, then either (a) it's a ContainerRuntime
_consumer_ (so Move publish, codegen consumer, etc. dispatch through the build-container component),
or (b) it's a separate L1 sub-runtime with its own adopt-or-create state machine duplicating
ContainerRuntime's logic (synthesis §05 Sui: "the build container's adopt-or-recreate state machine
MUST reject the helper's auto-recreate-on-resume-failed path"). The architecture doesn't say. The L1
LOC budget includes "build-container 0.3k" alongside "Docker 1.8k" — implying option (b), which
doubles per-container state-machine code.

### S2. Resolve-once for extras: where exactly does it live?

The architecture lists this as a "collapsed" thing (§What's collapsed: "Manifest writer + codegen
emitter + dapp-kit config (each re-resolving user extras) → resolve-once at acquire; one blob
threaded everywhere"). But "at acquire" is ambiguous: is it part of the Stack supervisor's boot
(L0)? Part of the manifest writer (L3)? Codegen-surface-only (L4)? Threaded via Context (engine
knows about "extras")? The architecture never points at the L0/L3/L4 home. Synthesis §22
(Resolve-once memoization) lists this as a real bug class — silent contract gap.

### S3. The watcher debounce + content-hash dedup belong "in L0" but only one consumer is acknowledged

§Tension 15 / §L0: "Thick watcher in L0. Minimatch filter + 250ms debounce + content-hash dedup all
live in the L0 watcher primitive." Synthesis §02 (file watcher): today the supervisor's watcher
dedup lives in a module-global Map. The L3 watch dispatcher receives events. But codegen also has
its own watcher-loop avoidance (the "output dir excluded from watcher" invariant, synthesis §19).
Where does the exclusion list live? In L0's watcher (so it knows about a codegen-specific output
dir, breaking L0 substrate-cleanliness)? In L4 codegen (so it filters after the fact)? In L3 watch
dispatcher (but L3 watches plugin decls, not codegen output)? The architecture doesn't say.

### S4. State-store vs cache vs in-memory registry boundary still hand-wavy

§Data models § State store / Cache draw a boundary: "Cache is content-addressed and idempotent;
state store is per-stack persistent typed KV." Fine. But synthesis flags the BRANDed typed-key shape
as a "tighten/formalize" item (§Tighten/formalize: "BRAND `StateStoreKeys` with opaque typed-key
shape"). The architecture says (§Cache) "BRANDed typed keys (a registry of typed key constructors;
one source). Plugin owns the key namespace under its plugin-key prefix." But there's no
specification of the constructor registry, no said-where (L0 substrate? Per-plugin?). If per-plugin,
then types from one plugin can collide with types from another at the same namespace; if L0, then L0
has a list of typed keys which mentions every plugin's vocabulary.

### S5. Renderer subscribable projection — what's actually projected?

§Decisions §8: "subscribable state-ref projection that survives cycles." But what's IN the
projection? The architecture lists event categories (§Event stream) but the projection (the
"state-ref" the renderer reads instead of subscribing) is never specified. Today's TUI consumes ~15
fields per row (synthesis §21). The renderer-facing projection is supposed to be "the smallest
superset of fields any consumer needs" (synthesis §21 / what to do instead in the redesign). The
architecture defers this to "the renderer interprets" — but renderers can only interpret what's in
the projection. Without an enumeration, the architect has not actually proven that no engine
vocabulary leaks into the projection.

### S6. Composites declare "lifted-sibling keys" but key conventions are unspecified

§Contract 8 / CompositePrimitive / Plugin must provide: "Lifted- sibling declarations (named tags
whose execution is promoted to scheduler level 0 alongside Sui boot, and which dedupe across
multiple composites of the same kind)." The dedup mechanism is key-based. But synthesis §6 Walrus
"two walrus instances sharing one git source clone" requires that two _different_ Walrus composites
lift the same key. Cross-plugin dedup, in other words. The architecture says "first-wins by key."
But who decides what the key is? If Walrus's lifted-sibling for git source is `walrus.upstream-git`,
then a different plugin (say a future walrus-mirror) declaring the same lifted sibling key has
either to know that key by convention (engine knows a name) or to use a key generated from a content
hash (in which case two different versions of walrus never dedup with each other). The dedup
contract has been left to Phase 3 by silence.

### S7. Hot-restart semantics for one-shots vs long-running mixed in dep-graph

§One-shot effect lifecycle: "no automatic retry. A transient `execute` failure stays `failed` until
hot-restart." §Selective restart cascading: "cascade through dep-graph edges by default. A plugin
that wants to break the cascade opts in via a typed flag." But if an upstream long-running plugin
invalidates, and a downstream one-shot is in `done` state, what happens? Does it re-execute?
Synthesis §8 says: "Optional discriminator-as-Effect re-yielded on every cycle so the dep-graph
still sees the node (cache hits collapse to immediate done)." The architecture says (§Deferred:
"Action's optional discriminator-as-Effect re-yielded on cache hits — keep, document as the
documented behavior under the OnChainArtifactPublisher contract"). But the contract does not mention
this re-yield. Hot-restart and one-shot interplay is the most obscure piece of today's behavior; the
architecture handwaves.

### S8. Manifest-version vs schema-version on persisted artifacts

§Snapshot / Cache: snapshot-image GC and cross-network/cross-stack restore are deferred. But
snapshot METADATA has a version field (synthesis §17 opens metadata-versioning as an open question).
The architecture also says "Cache key includes content-hash already; schema drift surfaces as decode
failure → re-produce. Versioning can be added later." For cache this is fine (re-produce is cheap).
For snapshot metadata it is not (re-produce is impossible — the artifact is what's frozen). The
architecture says "Snapshot metadata schema version" is in §Tighten/formalize list, but it's not in
any contract description. Deferred to Phase 3 means: not actually decided.

## LOC budget pressure

Two specific places where the LOC claim is most fragile.

### LOC1. Sui's port: 1.5k is implausible

The architecture allocates Sui 1.5k LOC. Today Sui is the largest service (~2k LOC just for the
factory file per distilled §05). To hit 1.5k, the substrate must absorb:

- OnChainArtifactPublisher (~0.5k off Sui).
- Build-container (~0.3k off Sui).
- Chain-probe (~0.2k off Sui).
- KnownPackage seed-object strategy (~0.1k off Sui).

That's ~1.1k worth of substrate-eating. But Sui retains:

- Three mode dispatch builders (localnet, external, live, fork — four counting external as a
  degenerate).
- Fork-mode SDK guard (synthesizes wrapping every `client.core.*` method).
- Auto-tick fiber.
- Container readiness probe (RPC + faucet + GraphQL concurrent).
- Postgres sidecar (synthesis: ~70 lines today duplicating postgres machinery — does this dedup or
  stay duplicated?).
- Move.lock scrub script (host path + container path).
- Fork data-dir lock (uses the unified L0 lock — but the data-dir semantics, holder-liveness probe,
  etc., are Sui-specific).
- Image build (Dockerfile, content-hash, build args).
- The chain-id-folded cache-key disciplines for fork upstream cache.

That's a generous 2.5-3k LOC plug, even with substrate generosity.

The architecture acknowledges this risk in the closing paragraph: "If Sui's port lands at 2.5k
instead of 1.5k, the walrus/seal/ deepbook ports likely follow proportionally." But the discipline
mechanism it names ("stop and rethink the design") is the same phrase the goals doc uses — and the
architect is, right now, the person who would have to stop and rethink. The current design has not
yet had that conversation.

### LOC2. L0 supervisor at 1k LOC while including scheduler + lifecycle SM + event-bus + command-channel

§LOC sanity check breakdown for L0: "scheduler 1k, watcher 0.5k, event/command 0.5k, OCA 0.5k, lock
0.4k, state-store 0.4k, cache 0.4k, identity/paths 0.3k, lifecycle SM 0.3k, observability 0.5k,
manifest-schema 0.4k, supervisor 1k, misc 0.3k" — that's already 6.6k assuming no inter-module glue.
Today's `engine/supervisor.ts` alone is 2.1k LOC. The architecture's claim is that an "outer driver"
version of the supervisor is 1k, but the things removed from supervisor (orphan sweep, traefik,
signals, log routing) are re-homed without LOC totals — they're scattered across L1 (reverse-proxy
0.6k, build-container 0.3k), L3 (prune 0.4k), and L2 (renderers 0.8k). The L3 prune orchestrator
owning cross-invocation registry classifier alone (synthesis §02 global registry) is at least
0.3-0.4k just for the classifier + retry write + tempfile rename + registry schema. The
architecture's "0.4k" for prune is plausible only if you don't also count its consumers (CLI
doctor/prune verbs: today 600 LOC for prune alone in CLI per synthesis §Wrong abstraction).

Net: 0.5-1k of "moved" code is silently dropped from accounting.

## Synthesis coverage audit

24 concepts, 11 deferred decisions, 20 violations, 15 tensions.

### 24 first-class concepts

| #   | Concept                         | Status                                                                                                                                                             |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Plugin                          | Present + resolved (NodePlugin contract)                                                                                                                           |
| 2   | Runtime adapter                 | Present + resolved (ContainerRuntime + InProcessRuntime + ReverseProxyRuntime)                                                                                     |
| 3   | Composite primitive             | Present + hand-waved (refusal at type-level deferred; lifted-sibling dedup keys unspecified — S6)                                                                  |
| 4   | Lifted sibling                  | Present + hand-waved (key conventions, cross-plugin dedup unspecified — S6)                                                                                        |
| 5   | On-chain artifact publish       | Present + resolved (OnChainArtifactPublisher)                                                                                                                      |
| 6   | Service mode                    | Present + resolved (NetworkResolver)                                                                                                                               |
| 7   | Strategy registry               | Present + resolved (StrategyContributor) — but C7 questions whether faucet really fits                                                                             |
| 8   | One-shot effect                 | Present + hand-waved (S7: hot-restart cascade vs one-shot done not specified)                                                                                      |
| 9   | Snapshotable                    | Present + resolved (with caveats per C5)                                                                                                                           |
| 10  | Routable                        | Present + resolved                                                                                                                                                 |
| 11  | NetworkResolver                 | Present + resolved                                                                                                                                                 |
| 12  | Codegenable                     | Present + hand-waved (S2: resolve-once-extras home unspecified)                                                                                                    |
| 13  | Lifecycle state                 | Present + resolved                                                                                                                                                 |
| 14  | Phase narration                 | Present + resolved (free-form wins; closed-enum dropped — but §Tensions 14 narrows to "Phase 3 concern of error-tag enumeration if needed" which is itself a punt) |
| 15  | Display projection              | Present + hand-waved (S5: contents of subscribable state ref not enumerated)                                                                                       |
| 16  | Typed event stream              | Present + resolved                                                                                                                                                 |
| 17  | Typed command publication       | Present + resolved                                                                                                                                                 |
| 18  | Identity / chain-identity guard | Present + resolved                                                                                                                                                 |
| 19  | Cross-process safety            | **Present + hand-waved** (C4 — protocol-shape only, not actual protocol)                                                                                           |
| 20  | Quiescence                      | Present + resolved                                                                                                                                                 |
| 21  | Sibling self-registration       | Present + resolved (StrategyContributor)                                                                                                                           |
| 22  | Resolve-once for user extras    | Present + hand-waved (S2)                                                                                                                                          |
| 23  | Endpoint declaration            | Present + resolved (plugin-emitted, walked by substrate)                                                                                                           |
| 24  | In-process runtime as peer      | Present + resolved (InProcessRuntime)                                                                                                                              |

**Net: 17 resolved, 7 hand-waved, 0 missing.** The hand-waves are concentrated on the cross-cutting
concerns (cross-process safety, extras resolution, projection contents, lifted-sibling keys,
one-shot/hot-restart interplay).

### 11 deferred layering decisions

| #   | Decision                                       | Status                                                        |
| --- | ---------------------------------------------- | ------------------------------------------------------------- |
| 1   | Runtime substrate scope                        | Resolved (three-way split)                                    |
| 2   | Snapshot orchestrator vs plugin-driven         | Resolved (L3 orchestrator)                                    |
| 3   | Engine / supervisor split                      | Resolved (aggressive 3-way split)                             |
| 4   | Codegen-as-plugin vs surface                   | Resolved (surface walks Codegenable decls)                    |
| 5   | Build-container ownership                      | Resolved at decision level, hand-waved at contract level (S1) |
| 6   | Coin discovery placement                       | Resolved (Coin owns, event-driven)                            |
| 7   | Action vs publish unification                  | Resolved (OnChainArtifactPublisher specialization)            |
| 8   | Renderer mount lifetime                        | Resolved at decision level, hand-waved at contract level (S5) |
| 9   | Reverse-proxy vs container-runtime             | Resolved (two interfaces)                                     |
| 10  | State-store / state-registry / global boundary | Resolved (two L0 primitives + L3 prune state)                 |
| 11  | Endpoint-name registry ownership               | Resolved (plugin-emitted)                                     |

**Net: 11 resolved at decision-level; 3 (#5, #8, #10) hand-waved at the contract level.**

### 20 substrate violations

All 20 listed in architecture §Substrate violations and structurally addressed. **Real concern**:
substrate violations §16 (`displayPath` lives in engine) and §20 (heavy-infra reboot-cost in engine)
are addressed via "L4 codegen owns displayPath" and "plugins declare their own rebootCost." Both
move data, but the reboot-cost data still has to be readable by the cascade formatter, which the
architecture puts in renderers (L2). If renderers contain the cascade-formatter logic, surfaces like
CLI (which today consumes the cascade formatter for `wipe`/`prune` confirm-prompt severity) would
have to re-implement it — or CLI re-imports from renderer (L2 → L4 import is forbidden by the layer
model). C2's last point applies.

**Net: 19 structurally prevented; 1 (substrate violation §20) relies on a convention that doesn't
compose with the surface boundaries.**

### 15 tensions

| #   | Tension                                       | Status                                                   |
| --- | --------------------------------------------- | -------------------------------------------------------- |
| 1   | Type-safety vs minimal config                 | Resolved (loose internal, tight surface)                 |
| 2   | Plugin extensibility vs LOC                   | Resolved (cut speculative; reintroduce on demand)        |
| 3   | Fork-mode vs swappable runtimes               | Resolved (fork is a network mode)                        |
| 4   | Symmetric surfaces vs CLI-specific            | Resolved (JSON envelope = projection)                    |
| 5   | Convention vs configuration                   | Resolved (convention default, env override)              |
| 6   | Engine omniscience vs zero-service-names      | Hand-waved (C2)                                          |
| 7   | Cache best-effort vs verify integrity         | Resolved (in OnChainArtifactPublisher)                   |
| 8   | Hidden auto-fills vs discoverability          | Resolved (visibility flag + error lists registered keys) |
| 9   | Atomic restore vs per-phase                   | Resolved (bracketed-atomic)                              |
| 10  | Build container per-app vs per-stack          | Resolved (substrate-level, per-app)                      |
| 11  | Composite refusal type vs runtime             | **Deferred to Phase 3** (C3 — the wrong move)            |
| 12  | Two stop finalizers, one container            | Hand-waved (C4)                                          |
| 13  | Auto-mounted hidden vs explicit user-supplied | Resolved (visibility flag, key-equality suppression)     |
| 14  | Receipt-as-raw-blob vs typed accessor         | Resolved (raw + opt-in helpers)                          |
| 15  | Watcher thickness                             | Resolved (thick watcher)                                 |

**Net: 12 resolved, 2 hand-waved (#6, #12), 1 deferred (#11). The deferral is the most concerning —
see C3.**

## Pressure-test audit

The 11 hard cases from `_GOALS.md` hard-case list.

| #   | Hard case                                                | Convincing?                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Composite primitives with lifted siblings                | **Hand-waved.** Maps directly to CompositePrimitive contract, but the contract itself has S6 (lifted-sibling key conventions).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2   | Walrus's 4-shard cluster sharing one image build         | Convincing for one-stack case. For two parallel walrus composites (synthesis §6 — admin tag asymmetry, plus the "two parallel stacks" constraint), the architecture handwaves on whether the lifted-sibling key dedup happens per-app, per-stack, or per-process.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 3   | Seal's keygen-then-deploy-once                           | Convincing. OCA + Snapshotable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 4   | Sui's fork-from-live                                     | Hand-waved on KnownPackage strategy contribution. Synthesis §05 makes clear this accumulator has a "clear-between-composes" contract — the architecture says "no module-scope mutable. No clear-between-composes contract. The substrate's normal cleanup runs on scope close." But Phase 2 isn't building scopes yet; it's specifying contracts. If scope-cleanup is the contract, then two composes in one process must each get a fresh scope. The architecture never names the scope boundary.                                                                                                                                                                                                                                                                                                   |
| 5   | Selective restart cascading through a composite          | Convincing for happy path. S7 (one-shot interaction) is unaddressed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 6   | Parallel stacks sharing port broker etc.                 | Convincing for in-process case. Cross-process case (= two `pnpm dev` of _different_ stacks) is conflated with #11 in the architecture — they have different sharing semantics (different identity = different lock files, but shared port broker dir). The pressure test treats them as the same.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 7   | Live-network service depending on local one              | Convincing. NodePlugin uniformity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 8   | Hot-restart mid-TUI without losing renderer subscription | Convincing in shape (subscribable projection). S5 (projection contents unenumerated) means the contract is still aspirational.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 9   | Action depending on 5 services                           | Convincing. One-shot lifecycle + OCA.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 10  | Codegen artifacts before example app's dev server starts | Convincing in shape but hides a subtle issue: build integrations are "pure readers of manifest + key files + env vars + a typed global bridge slot. NO engine subscription." If codegen is the producer and Vite is the reader, what's the gate that says "codegen has emitted, Vite can start"? The architecture says "supervisor's own boot sequence emits a `stack.ready` event only after codegen has emitted. The example app's dev-server start command (driven by the supervisor or by Vite reading the manifest) waits for codegen." This adds a NEW supervisor responsibility (driving dev-server) that wasn't in the layer model. Either Vite is engine-aware (breaking "NO engine subscription") or it polls the manifest on disk (synthesis §23 — but that has its own race conditions). |
| 11  | Cross-process two-`pnpm dev`                             | **Hand-waved.** C4 — the protocol is named but not specified.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

**Net: 6 convincing, 5 hand-waved (#1, #2, #4, #8, #10, #11).** That is a substantial fraction of
the hard-case list — and exactly the list the goals doc says must "survive on paper before impl
starts."

## Recommendations

In priority order.

1. **Fix the LOC budget accounting.** Reconcile the per-layer table with the goals doc's all-in
   target. Either the goals doc's "25k total including tests" is loosened explicitly (with user
   sign-off — this is exactly the "checkpoint when budget is exceeded" rule), or the per-layer
   numbers tighten. The current "25k src + ~25k tests = 50k total" silent revision is the
   discipline-breach the goals doc warns against.

2. **Decide composite refusal at the type level NOW, not in Phase 3.** If type-level refinement is
   too expensive (the architect's stated risk), commit to runtime refusal as the final answer, with
   type-level escapes from the user-facing factory shape (e.g. mode-narrowed factory exports per
   `NetworkResolver` result). Pushing this to Phase 3 means Phase 3 inherits factory signatures that
   may not refine. Either way, decide.

3. **Specify the cross-process safety protocol concretely.** Pick a counter-on-disk protocol (file
   with append-only entries per-process? read-modify-write under flock? PID + entropy table?). Spell
   out the snapshot-during-acquire interaction. The architecture's "shared read locks + Ref
   counter + last-leaver" is a sketch, not a protocol. Phase 3 will run aground here.

4. **Add the missing capability contract for chain-probe.** It's referenced in
   OnChainArtifactPublisher and in §Substrate violations #9 but it is not in the eight-contract
   list. Either inline it into the eight (renaming "eight" to "nine"), or make it a typed
   `Context.Reference` slot with a single reference implementation declared.

5. **Enumerate the renderer-facing projection.** The "subscribable state-ref projection that
   survives cycles" is the load-bearing replacement for the proxy-engine. Without a field- level
   enumeration, the architect cannot prove no display vocabulary has leaked into the engine. This
   needs ~15 entries of structured fields, with explicit "the engine emits FACTS X, Y, Z and the
   renderer projects them into rows."

6. **Specify the resolve-once-extras home.** L0, L3, or L4. Pick one. The current text says
   "resolved-once at acquire" without pointing at which layer's acquire.

7. **Spell out the build-container's relationship to ContainerRuntime.** Is it a ContainerRuntime
   consumer (one adopt-or-create state machine), or an L1 sibling component with its own state
   machine? Today's synthesis §05 makes clear the build container's state machine has subtleties
   Docker ContainerRuntime doesn't share (must reject auto-recreate-on- resume-failed). Phase 3 will
   need this answered.

8. **Decide endpoint-name registry schema discipline.** If L0 owns the manifest schema, either it
   has named slots (engine knows service names — but lint passes because there are no string
   literals matching service names — except the schema's own keys, which ARE the names) or it's
   `Record<string, unknown>` (and type-safety claim collapses for consumers). Make the call.

9. **Specify the lifted-sibling key namespace.** Cross-plugin dedup vs same-plugin dedup vs
   same-key-different-version: which wins? The current "first-wins by key" is half a protocol.

10. **Either delete the "L3 prune classifier" responsibility or move global-registry knowledge to
    L0.** The current placement (L3 owns cross-invocation state) requires L3 to classify
    `alive | dormant | stale | abandoned`, which requires service-shape knowledge. Either the
    classifier is service- agnostic (no `rebootCost`-aware logic), or the classifier isn't actually
    L3-shaped.

11. **For Phase 3 (not blocking Phase 2 acceptance): write a sample plugin in pseudo-TypeScript**
    showing how the eight contracts compose for one canonical case (Walrus, since it's the
    highest-coverage composite). The goals doc explicitly asks for Sui-on-paper as the reference
    plugin. The architecture cites "Phase 3c — Sui as the reference plugin" as the next step; do
    that before opening Phase 3. If the contracts survive Sui on paper, they survive the rest. If
    they don't, the contracts grow; the architecture revises here, not in code.

12. **Reopen the "Effect leaks to user-facing API" question with one example.** A 15-line example of
    authoring a new service plugin, using all eight contracts as required. Effect-flavored code is
    fine internally; the user-facing factory call should look like ~3 lines of declarative config.
    Show one example, and verify the goals doc's "third-party plugin author lands a new service in
    ~15 lines" claim survives Effect's surface cost.
