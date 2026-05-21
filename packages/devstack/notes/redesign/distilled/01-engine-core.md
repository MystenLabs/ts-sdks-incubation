# 01 Engine Core (distilled)

## Purpose

The agnostic lifecycle substrate of devstack: owns per-node lifecycle state transitions, the
per-cycle topological scheduler, the static dependency graph that backs cascade / closure
computation, the in-process restart/shutdown signalling channels that drive hot-restart, and the
selective per-primitive invalidation surface that closes only the affected subtree. It is what
remains after stripping the Docker layer, renderers (TUI/plain/silent), per-service registries, and
the snapshot/codegen/manifest pipelines. Conceptually it is one composable subsystem; in the current
implementation it is split across an "engine service" (state cells, signals, scope registry) and a
"supervisor" (compose-time graph build, launch loop, watch dispatch).

## Responsibilities

- Track every keyed primitive's lifecycle status and surface state changes to whatever observer
  (renderer, log sink, diagnostic dump) wants them.
- Provide a per-primitive lifecycle wrap that any Layer-building primitive can opt into, so
  transitions (acquiring/ready/failed/stopping/stopped) happen automatically.
- Maintain a per-primitive scope registry so individual primitives can be torn down without dragging
  the whole stack down.
- Compute the static dependency graph from declared upstream keys at compose time, including
  downstream-closure and topological levelisation.
- Schedule layer builds level-by-level so providers complete before consumers start, with same-level
  siblings building concurrently and shared providers deduped (diamond resolution).
- Offer two distinct restart paths: a full-stack hot-restart (user-driven or external signal) and a
  selective restart scoped to one affected closure (file-watch-driven).
- Coalesce concurrent restart requests into a single wake without losing a request that arrives
  between wake and next-await.
- Offer a one-shot shutdown signal that is idempotent under repeated requests.
- Run scope finalizers in parallel on teardown so worst-case grace-period stacking collapses to
  max(grace) instead of sum(grace).
- Aggregate per-primitive watch declarations into a single filter and route filtered, debounced FS
  events to the affected primitive set.
- Emit cascade-diagnostic messaging (which primitives will restart, which carry heavy reboot cost)
  co-derived with the affected set so the human-facing message and the engine signal cannot drift.
- Maintain a bounded log tail and per-entry log-tail in a way that keeps the two views in sync.
- Survive hot-restart cycles: engine state cells live at supervisor lifetime, not per-cycle, so a
  restart does not re-open locks, re-mount watchers, or re-install handlers.

## Lifecycle states

There are three nested lifetimes that compose this component.

**Supervisor lifetime.** Begins when the supervisor is launched and ends when shutdown is requested.
The engine's state cells (entry map, log ring, header, restart/shutdown signals, scope registry,
shadow cache) and any externally-owned resources that must survive `r` (file watcher, state-store,
identity, registry) are scoped here. There is one supervisor lifetime per process run.

**Cycle lifetime.** Each hot-restart cycle within a supervisor lifetime. A cycle: reseeds entry rows
from the static stack; races a layer build against shutdown; on success, races a restart signal
against shutdown; on shutdown wins, returns to supervisor (terminating); on restart wins, closes the
cycle scope (cascading parallel teardown of every primitive scope built during this cycle) and
re-enters the loop. The cycle scope uses a parallel finalizer strategy so primitive teardowns
interleave instead of serialising. The cycle counter is part of the header for observers.

**Primitive lifetime.** Each keyed primitive's build scope, forked off the cycle scope through the
MemoMap. States: `pending` (seeded but not yet built) → `acquiring` (build effect running) → `ready`
(build succeeded) or `failed` (build erred). Long-running primitives that own a docker container or
similar also pass through `ready` → `stopping` → `stopped` on teardown if the primitive opts into
emitting those transitions. Status mutations are idempotent and merge-not-replace: a late
`acquiring` after `ready` must not drop the resolved title. `markAcquiring` of an unseen key
auto-registers the entry; `setPhase` of an unseen key is a silent no-op (no auto-register). On the
ready/failed transition, transient narration fields (phase, last-log, selective-restart highlight)
are cleared.

**Selective sub-lifetime.** A subset of primitive scopes within one cycle can be invalidated,
closing only those scopes (concurrently) without disturbing the cycle scope. The invalidated
primitives' shadow-cache entries are evicted before their scopes close, so a concurrent re-acquire
sees consistent state. The user-driven `r` path must NOT take this route (it closes the cycle scope
directly and would double-close).

## Inputs / dependencies

**From user config (per supervisor lifetime):** the stack array (ordered primitives), an optional
stack name, an optional network identifier, an optional explicit watch-set, optional hot-restart
toggle (defaults true when any watch root is declared), optional renderer kind (TTY-vs-not default),
optional state dir, optional extras.

**From environment:** a stack-name fallback env var; an opt-in env var that aggregates a warning
about primitives missing declared upstream keys; the process TTY flag (for default renderer
selection only).

**From every primitive (per-primitive, factory-time):** an identity key, a kind classification, an
optional friendly title, an optional plugin label, a hidden flag, the declared upstream keys (always
stamped, even empty, so "no upstreams" is distinguishable from "forgot to declare"), declared watch
paths, an optional display projection of the resolved value, optional extra layers to fold in. Plus
the primitive's Layer itself.

**From the Effect runtime:** scopes, MemoMap, dropping queues, deferreds, refs, layer composition
(`provideMerge` / `mergeAll`), platform services and a ChildProcessSpawner (for primitive plumbing
it doesn't itself use), and a stream-callback bridge from POSIX signals.

**From sibling subsystems (today wired directly in compose):** state-store, identity, registry, port
allocator, file-watcher, per-service registries, container-claim tracker, traefik bootstrap. The
engine consumes these as Layer requirements at the supervisor's compose boundary rather than as
injected service capabilities.

## Outputs / capabilities provided

- A live state model of every keyed primitive: status, kind, plugin tag, friendly title, phase
  narration, last error summary, last log line, selective-restart highlight, plus the resolved
  display projection on success.
- A header model: app name, stack name, network, build-status
  (`idle`/`running`/`failed`/`restarting`/`shutting-down`), cycle counter.
- A bounded global log ring (currently 200 lines).
- An endpoint list aggregating per-primitive endpoints.
- An optional per-stack topological-levels view (currently declared as state but unwritten — see
  Open Questions).
- A lifecycle wrap that primitives opt into to get auto-transitions and scope registration.
- Restart/shutdown request/await pairs forming an in-process pub/sub for control flow.
- An "invalidate this subset of keys" operation that closes the affected primitives' scopes in
  parallel.
- A static dep-graph projection: per-primitive upstream/downstream sets, downstream closure
  (strictly-downstream, excluding the owner itself), topological levels with stable in-level input
  order, cycle detection failure at compose time, dangling-upstream tolerance.
- A watch-filter projection: include patterns AND not negation patterns, with always-applied default
  excludes; a watch-owners map from absolute path to the primitive(s) owning it.
- A cascade-formatter: given a set of matched watch owners and a downstream closure, produces both
  the affected set and the diagnostic message in one call.

## Invariants and constraints

- All `mark*` transitions are idempotent and merge-not-replace; a late `markAcquiring` after
  `markReady` must not drop the resolved title/primary.
- `markAcquiring` of an unseen key auto-registers (so composite primitives' inner tags show up);
  `setPhase` of an unseen key is a no-op (so phase narration cannot manufacture kindless rows).
- The phase / last-log / selective-restart-highlight fields are cleared on `markReady` and
  `markFailed`.
- The restart signal coalesces concurrent producers into a single wake AND preserves a request
  arriving between wake and next-await (the latter ruled out a prior `Ref<Deferred>` design).
- The shutdown signal is idempotent: second press / signal-handler overlap must not throw.
- A primitive's scope registry entry is dropped BEFORE its scope is closed (so a concurrent watcher
  fire does not see the closed scope as still registered).
- Subset invalidation evicts the shadow-cache entry BEFORE closing the scope (symmetry with the
  above).
- Subset invalidation runs scope-closes concurrently (sequential would stack docker stop grace
  windows; the team has measured ~145s sequential vs ~30s parallel for the production stack).
- Subset invalidation on an unknown key, or on an empty set, is a silent no-op.
- An explicit single-scope close MUST NOT touch the shadow cache; only subset invalidation evicts.
  This is load-bearing because the user-`r` path closes the cycle scope without going through the
  subset path.
- The user-`r` path must NOT invoke subset invalidation; it closes the cycle scope and lets the
  cascade run.
- Selective restart spares scopes outside the affected set — this is the entire point of the
  feature.
- Engine state cells live at supervisor lifetime, not cycle lifetime; otherwise `r` would re-open
  the state-store lock, re-mount watchers, re-install signal handlers.
- The topological scheduler must place every provider strictly below every consumer, place
  same-level siblings in a single `mergeAll`, dedupe shared providers (diamond resolution via
  MemoMap), and preserve user-declaration order within a level (so the dashboard surfaces siblings
  in the authored sequence).
- The dep graph fails hard on cycles (synchronous error at compose time, not infinite-loop the
  closure walk), silently drops dangling upstream references (so removing a primitive from the stack
  doesn't crash other primitives that referenced it), silently skips members without a key
  (hand-rolled escape hatches), and resolves duplicate keys with first-occurrence-wins (matching the
  duplicate-key warning).
- Downstream closure is STRICTLY downstream — the owner is not in its own closure, so callers must
  union `{owner} ∪ closure[owner]` to get the actual affected set.
- Composite primitives' nested members are flattened recursively at compose time.
- Declared upstream keys are stamped even when empty, so missing-declaration vs no-upstreams is
  distinguishable.
- Watch attribution: only positive bare paths contribute to the owners map; globs and negations
  contribute to the filter only. The filter requires a positive match AND no negation match; default
  excludes are always prepended and cannot be opted out of (only a positive include into an excluded
  subtree can override).
- Content-hash short-circuit: format-on-save with unchanged bytes must NOT trigger a restart.
- Watch-fire on an owned path uses the subset path; watch-fire on an unowned path falls back to a
  full restart.
- The cascade formatter produces the affected set AND the log message in a single call so the
  diagnostic line and the engine signal cannot drift.
- Cycle build races against shutdown; cycle post-build wait also races against shutdown; both races
  must give shutdown priority.
- Failed root-cause extraction walks the cause chain to the innermost message (outer-wrapper
  preambles would eat the 80-char budget), prefers tagged-error stderr over message (docker/sui-cli
  stderr is what the user needs to copy), and trims to a fixed width.
- The global log ring is bounded; long-running stacks must not grow it unbounded. Per-entry last-log
  and global log are written atomically together so the two views do not drift.
- The engine state ref is the single source of truth — observers (renderers, signal-handler summary,
  diagnostic dump) read it directly rather than re-deriving state.

## Edge cases and known failure modes

- Compose-time graph cycle from a typo'd upstream-keys annotation: hard error, no fallback.
- Mid-build primitive acquire failure: per-primitive wrap has already marked the row failed and
  logged before the outer race catches it. In a TTY render mode the supervisor falls through to
  await-restart so the user can press `r`; in non-TTY mode on the first cycle it fails the process
  (CI fast-fail).
- A watcher fiber for one root throws or emits a defect: that single fiber logs a warning and dies;
  siblings stay alive; the root is unwatched until process restart. (Possibly wrong abstraction — no
  auto-respawn.)
- Hash-on-read failure (race with delete, permissions): fail-open and proceed with the restart; next
  save re-hashes successfully.
- Close-unknown-key / invalidate-unknown-key: dep graph and scope registry can disagree if a
  primitive failed before registering its scope; both must be silent no-ops.
- A restart request arriving in the wake/next-await gap: must be preserved (queue not deferred).
- Concurrent subset-invalidate AND outer-cycle-scope cascade on shutdown: scope close is idempotent;
  the second closer collapses to no-op.
- A `q` keypress mid-build: shutdown wins the build race; partial-acquire scopes roll back through
  the cycle scope. Critically, downstream cleanup steps that depend on a successful build (orphan
  sweep) must be skipped because their claim sets are incomplete.
- Hand-rolled Layer escape hatches that bypass the lifecycle wrap: no row, no scope registration;
  only the outer cycle-scope cascade catches them on shutdown. A "mark all remaining
  `pending`/`acquiring` to `ready`" safety-net method exists for this but its production call site
  is currently unclear.
- A primitive currently mid-transition (`acquiring → setPhase → setPhase → markReady`) gets
  subset-invalidated: the build effect is interrupted by scope close, but the entry in state is
  mid-transition. The reset behaviour here is not clearly specified.
- Hidden primitives never register a scope; selective restart cannot reach them. They can only be
  torn down by the outer cycle cascade on full restart.
- Selective re-acquire trigger pathway is empirically asserted by tests but the production mechanism
  is unclear (see Open Questions): the watch fiber invalidates and returns, the supervisor loop is
  blocked on `awaitRestart`, so who actually re-acquires? Hypothesis: the next consumer that yields
  the affected key hits the now-empty shadow cache and rebuilds.

## Learnings from current implementation

**Properties to preserve:**

- Hot-restart that doesn't rebuild long-lived infra is enormously valuable; the engine's
  supervisor-vs-cycle lifetime split is a real win.
- Parallel scope teardown is a measurable win on docker-heavy stacks (~30s vs ~145s in production).
- Selective restart is implementable as a small surface (a scope registry plus an
  "evict-and-close-subset" operation) AND has end-to-end tests that pin the spare-unaffected-scopes
  invariant.
- Co-deriving the affected set and the human-facing cascade diagnostic from one call eliminates
  drift.
- Idempotent merge-not-replace status transitions and auto-register-on-acquire mean composite
  primitives "just work" without the engine needing to know they're composites.
- The dropping-queue plus dropping-semantics is the right primitive for restart coalescing; the
  prior `Ref<Deferred>` design lost requests in the wake/next-await gap.
- Declared upstream keys as a compose-time annotation (rather than runtime introspection of layer
  dependencies) gives a clean, testable static graph with cycle detection.
- Default watch excludes (Move.lock, build dirs, etc.) being non-opt-out has prevented a class of
  "watcher fires constantly during compile" footguns.
- Failed root-cause extraction (walk the cause chain to the innermost message, prefer stderr over
  message) is a meaningful UX win for docker / sui-cli errors.

**Bad things to avoid:**

- The engine publishes renderer vocabulary in its state model (`title`, `primary`, `extras`,
  `endpoints`, `lastLog`, `selectiveRestart`). The state shape is named "TUI" even though the engine
  is its writer and the renderer is the reader. The `markReady` API takes a renderer-side display
  projection rather than the resolved value. This dependency direction inversion is the single
  biggest "agnostic substrate" violation in the current implementation.
- The engine reaches up into a per-domain phase-string module for narration vocabulary it never
  imports — phases are tied to error classes and the pretty-error renderer rather than being opaque
  strings to the engine.
- The shadow cache exists ONLY because Effect's MemoMap has no per-entry eviction surface; it is
  bookkeeping that mirrors MemoMap by presence/absence. The sentinel-value-only design pays memory
  and write cost for a presence bit.
- An endpoint-registry layer still requires the engine handle in its R channel "for merge-order
  stability" though its body no longer touches it. Leaked dependency.
- The stack-member shape is structurally narrowed via runtime `(m as { __X?: T }).__X` patterns at
  every consumer site; TS can't help because every `__` field is optional. The same
  `{key, kind, title, plugin, watchPaths, upstreamKeys}` projection is reconstructed three times
  across the supervisor.
- Compose mutates the canonical Context.Service class via `Object.assign`; the rationale ("one
  provide call per stack") still leaves the class identity as global mutable state.
- Heavy-infra reboot-cost annotations are hardcoded in the engine (Sui, Walrus, Seal). Per-service
  primitives should declare their own.
- The supervisor file is ~2k LOC and mixes concerns: engine-core (scheduler, dep graph wiring, watch
  dispatch, restart loop), engine-resources (state-store / identity / file-lock), runtime-docker
  (orphan sweep, traefik, hard-kill), observability (signal handlers, log routing).
- Restart-signal and shutdown-signal use different primitives (dropping queue vs deferred) for what
  is structurally the same in-process pub/sub.
- Repeated `Layer.empty as unknown as Layer.Layer<any, any, any>` casts inside scheduler folds — the
  abstraction's boundary is leaking.
- Shutdown copy strings are duplicated between supervisor and TUI components by deliberate
  non-import; symptom of engine code knowing rendering vocabulary.

**Recurring bug sources:**

- Race conditions around watch dispatch and selective invalidation (the
  in-flight-transition-during-invalidate case is still ambiguous).
- Order-of-operations around evict-vs-close in subset invalidation (the team specifically pins
  "evict before close").
- Drift between the global log and per-entry last-log if not written atomically.
- Per-cycle vs supervisor-lifetime scope confusion has historically caused "r re-opens
  state.json.lock" regressions.

**Confirmed or suspected dead code:**

- `depTreeLevels` field on the state model is declared but no producer writes it.
- The "mark all remaining pending/acquiring to ready" safety-net method has no obvious production
  call site in current code.
- Phase tuples module sits under `engine/` but the engine itself never imports it; only error
  classes and the renderer do.

## Cross-component references

- **04 runtime-docker:** the parallel-teardown invariant exists primarily because docker
  `stop --time N` grace windows are what dominates teardown cost; the orphan-sweep step also reads
  the cycle-built claim set and must be skipped on interrupted builds.
- **Engine-resources (state-store, identity, registry, port allocator, file-watcher):** all built
  into the bootstrap layer alongside the engine and shared across hot-restart cycles. The engine
  itself owns no persistent state — every persistent thing lives in engine-resources.
- **Observability:** root-cause extraction calls into pretty-error formatting; per-primitive
  lifecycle wrap calls into span/identity annotation; signal-handler diagnostic summary reads the
  engine state. The phase-tuples module is conceptually observability vocabulary parked under
  `engine/`.
- **Renderers (TUI / plain / silent):** consume the engine's state model directly via the state ref.
  The renderer kind affects two narrow supervisor branches: default selection from the TTY flag, and
  CI fast-fail behaviour on first-cycle non-TTY failure.
- **Plugin authors (tag/provide surface):** the lifecycle wrap is what plugin-authored primitives
  opt into; the upstream-keys annotation is what they declare; the watch-paths declaration is theirs
  to set. The engine consumes these via structural fields on the stack member.
- **Per-service tags (sui, walrus, seal, deepbook, postgres, pyth, etc.):** each declares its own
  classification kind, friendly title, plugin label, upstream keys, watch paths, display projection.
  They are observers (via state changes) and producers (via the lifecycle wrap calling engine
  methods).
- **CLI / TUI surfaces:** restart and shutdown signals are the input edges from those surfaces;
  status and log state are the output edges to them.

## Open questions / decisions deferred

- `depTreeLevels` on the state model: planned surface or stale field? Either wire it after
  topo-levelisation completes, or drop it.
- The "mark all remaining to ready" safety-net method: does anything still call it in production?
  May be dead.
- The selective re-acquire trigger pathway: after subset-invalidate evicts the shadow cache and
  closes the scopes, what actually drives the affected primitives to rebuild? The supervisor's loop
  is blocked on `awaitRestart`. The end-to-end test fakes the re-acquire by manually calling the
  consumer; production has no such manual loop. Either MemoMap evicts scope-closed entries (so the
  next yield drives a fresh build), or there's a stale-value-from-closed-scope bug, or something
  else implicit. This needs to be ratified — the redesign should make the trigger explicit.
- In-flight transition during subset-invalidate: if a primitive is
  mid-`acquiring → setPhase → setPhase → markReady` and gets invalidated, is there an explicit state
  reset, or does the entry stay in `acquiring` until the next cycle?
- `__hidden` interplay with selective restart: hidden primitives never register a scope, so subset
  invalidation cannot reach them. Is full-restart the only teardown path, and is that intentional?
- Phase-strings module placement: engine-core vocabulary, or observability vocabulary? Today it
  lives under `engine/` but couples to errors and pretty-error.
- Hand-rolled Layer escape hatches: are they supported, anti-pattern, or undefined? They can call
  into the engine if wired manually, but bypass scope registration / dep graph / duplicate-key
  checks / seed pass by default.
- Per-cycle logger sink installation vs supervisor-lifetime logger sink: should logger scoping match
  engine state-cell scoping or remain independent?
- Effect guarantee for `'parallel'` finalizer strategy: does Effect actually run cycle-scope
  finalizers concurrently with subset-invalidate-as-finalizer? Asserted in code comments but not
  pinned by tests.
- Composite-nesting depth: the flatten helper handles arbitrarily deep nesting in tests, but
  production composites currently only nest one level. Is recursive flatten defensive or
  load-bearing?
- POSIX signal handling is hand-rolled because Effect v4 doesn't expose it in core/platform-node
  yet; should collapse to a stable primitive once upstream lands.

## Opportunities noticed

- Publish a domain-neutral lifecycle event model from the engine; strip renderer vocabulary
  (`title`, `primary`, `extras`, `endpoints`, `lastLog`, `selectiveRestart`) out of the engine's
  public surface and let renderers project. Removes the engine→TUI vocabulary inversion the source
  explicitly admits.
- Replace the renderer-side display projection on the ready transition with a generic "resolved
  value publish"; let the renderer compute display fields off the resolved value.
- Delete the shadow cache by getting eviction-on-scope-close into Effect's MemoMap (upstream Effect
  work) — current workaround is the most architecturally fraught block in the engine.
- Stop mutating Context.Service classes in compose. Wrap the class in a fresh holder per provide
  call so identity is not state-dependent.
- Discriminated union for stack members: split LayeredTag-shape from hand-rolled-Layer-shape so TS
  narrows away the runtime structural casts at every consumer.
- Lift heavy-infra reboot-cost annotations out of engine-core. Per-service primitives declare their
  own cost; the cascade formatter reads and dedupes.
- Unify restart-signal and shutdown-signal into one typed pub/sub abstraction with coalescing
  semantics; replace the queue + deferred asymmetry.
- Extract POSIX signal plumbing into a `process-signals` module the engine doesn't need to know
  about.
- Refactor the engine-requires-merge-order endpoint registry layer to no longer hold the engine in
  its R channel.
- Consolidate the `__kind`/`__displayTitle`/`__pluginName`/`__watchPaths`/`__upstreamKeys`
  extraction into one canonical projection used by all three call sites in supervisor.
- Move the compose-time pure synchronous transforms (flatten members, duplicate-key guard,
  watch-owners aggregation) into a `stack-canonical` module alongside the dep-graph helpers; they
  don't belong in launch wiring.
- Test-helper surface for synthetic scope registration so tests don't reach into private wiring.
- Either implement or remove the `depTreeLevels` state field.
- Confirm and delete (or wire correctly) the "mark all remaining to ready" safety-net method.
- Bundle content-hash-on-watch with the watcher / dispatch code (currently lives in supervisor.ts
  with a module-scoped Map).
- Compile-once builder for the watch filter rather than per-call resolving of bare-vs-glob.
- The shadow cache's value-typed map should honestly be a Set since the engine only ever uses
  presence semantics.
- Either centralise phase-strings as `{name, color?, override?}` metadata used by every consumer, or
  split per-consumer enums.
- Unify the two `Effect.race(_, awaitShutdown)` sites (during-build and post-build) into one named
  primitive returning a typed verdict.
- Helper for the "fork a parallel-finalizer scope" pattern; called identically in two lifetimes with
  the same intent.
- Share a reverse-edges helper between graph build and topo-levelisation rather than reconstructing
  it in each.
- Downstream closure currently BFSes from every node with a fresh visited set (O(V·(V+E))); a single
  DFS with memoisation would be O(V+E). Probably irrelevant at current stack sizes but worth noting.
- Cross-component cleanup: `phases.ts`'s actual home is observability; consider moving it during the
  redesign so engine-core stops nominally owning a module it never imports.
