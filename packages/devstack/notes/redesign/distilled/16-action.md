# 16 Action (distilled)

## Purpose

An action is the conceptual category for a **one-shot on-chain effect** in devstack: a Sui
programmable-transaction (or analogous side-effecting operation) that must run exactly once after
its declared upstream refs are ready, then surface its receipt (digest + effects + object/balance
changes) as a yieldable, depend-uponable ref. Today implemented as a thin adapter over the
`onChainArtifact` substrate, sharing cache/verify/register discipline with publish/deploy
primitives. Concept-wise it is a first-class kind: "execute, observe, persist receipt, never run
again unless invalidated."

## What "one-shot effect" means

Distinguishes from long-running services along several axes:

- **No readiness loop.** A service polls a health-check until "up"; a one-shot effect's readiness IS
  the completion of its execution. There is no liveness signal to keep watching.
- **No port, no socket, no listener.** A one-shot effect produces a _receipt_ (a value), not an
  endpoint or a process. Nothing binds, nothing listens.
- **No long-lived resource.** No container, file handle, or fiber kept alive after completion. The
  supervisor has nothing to "stop" for it on shutdown.
- **Single-execution semantics.** Within a chain lifetime (a given `chainId`) the effect is fired at
  most once; subsequent acquires return the cached receipt. Compare to services, which
  re-acquire/re-start the actual process each cycle.
- **Restart semantics differ.** A hot-restart of the supervisor re-yields the ref but should NOT
  re-fire the effect — the chain's writable state plus the persisted receipt suffice. Services, by
  contrast, re-establish their runtime fresh each cycle.
- **No `stopping` / `stopped` lifecycle events.** Only `acquiring → ready/failed`. Teardown is a
  noop.
- **TUI presentation differs.** A row in an "actions" section, status word collapses to "done" (not
  "ready") to signal terminal-success-no-longer-running.
- **Shutdown counting differs.** The supervisor doesn't count actions among pending-stop work —
  there is no work to wait for.

The category exists to give the engine a uniform way to express "ordered, dep-graph-participating,
cached, idempotent side effect" without forcing it into the long-running-service mold.

## Responsibilities

- Declare its **dependencies**: a signer/account ref plus an arbitrary set of upstream refs the
  effect needs resolved (typically published packages whose IDs the transaction targets).
- Participate in the **dep graph**: its key flows into downstream refs' upstream sets so consumers
  can wait on it.
- **Build** the transaction body from the resolved upstream state, optionally tuning execution
  parameters (e.g. gas budget).
- **Execute** the transaction through the signer.
- **Cache the receipt** keyed on a deterministic content hash of
  `(name, signer identity, upstream dep keys, chainId, optional user-supplied discriminator)`.
- **Verify** the cached receipt against current chain state on each acquire (probe that the digest
  still resolves) and evict if it doesn't.
- **Surface a typed receipt value** that consumers can `yield*` and read (digest, effects, object
  changes, balance changes).
- **Narrate sub-phases** (building, executing) to observability so the TUI/log can show progress
  while the effect runs.
- **Wrap execution failure** in a stable, discriminable error shape so downstream handlers can
  pattern-match without inspecting raw signer errors.
- **Stay out of in-process registries.** Unlike a `publishMove` which populates package/coin
  registries, an action's receipt is ad-hoc and doesn't get registered.

## Lifecycle states

- **Pending.** Declared but its turn in the dep graph hasn't come yet. Upstream refs still
  resolving.
- **Acquiring.** Upstream resolved; cache lookup in flight or produce path is running.
  - Sub-phase **building**: constructing the transaction body from resolved upstream state.
  - Sub-phase **executing**: signing and sending; awaiting the receipt.
- **Completed (ready/done).** A receipt is in hand (either from cache or freshly executed) and has
  been persisted (best-effort). Stays in this terminal state until process exit. Status word renders
  as "done."
- **Failed.** Upstream failed during resolution, build callback raised, sign+execute raised, or
  cache-key derivation raised. Lifecycle reports a stable error; the row stops with a failure cause.
  Downstream consumers stay pending.

### How re-runs work

Re-running is **invalidation-driven**, not user-triggered:

- **Cache hit + verify success** → no re-run, receipt returned verbatim.
- **Cache hit + verify-fail** (digest no longer resolves on chain) → entry evicted, produce path
  runs, fresh receipt persisted.
- **Cache miss** (no entry at this key) → produce path runs, receipt persisted.
- **Hot-restart** (in-process) → typically cache-hits because chain state and cache survive. No
  re-fire.
- **`docker stop`/`docker commit` cycles** → typically cache-hits because chain writable layer is
  preserved.
- **`wipe` / forced teardown / regenesis** → chainId changes → different cache key → cache miss →
  re-fire.
- **Snapshot restore** → snapshot brings back both chain state and cache → matching chainId → cache
  hits → no re-fire.
- **User-driven re-fire** → only mechanism is to change a discriminator that's folded into the cache
  key (e.g. supply a dynamic user key). The body callback itself is opaque to the cache; mutating it
  without changing the discriminator yields the old cached receipt.

## Inputs / dependencies

- **Signer ref.** Account-like ref providing an address (folded into the cache key for identity) and
  a sign-and-execute capability.
- **Needs.** Ordered set of other refs the effect depends on (commonly published packages whose IDs
  the transaction targets). Their identity keys fold into the cache key; reordering changes the key.
  Whatever values these refs resolve to are reachable from the build callback via the substrate's
  resolved-upstream context.
- **Build callback.** User-provided function from a fresh transaction-builder to a (possibly
  Effectful) result that mutates the builder. Opaque to the cache; can yield upstream refs
  internally.
- **Optional execution-parameter overrides.** E.g. gas budget. Applied before the build callback.
  Currently NOT folded into the cache key.
- **Optional discriminator (user key).** A string or Effect-yielding string folded into the cache
  key. Allows callers to express "the body's semantics depend on these external facts." Effect form
  is re-yielded on every acquire (including hits) so it can participate in the dep graph.
- **From the substrate (implicit).** Current chain identity (chainId), a chain probe for verify, the
  state-store for caching.

## Outputs / capabilities provided

- **A yieldable receipt ref.** Downstream consumers `yield*` it to obtain the receipt value
  (digest + effects + object changes + balance changes). Carries its identity key, its kind tag
  ("action"-style — i.e. one-shot effect), and the flattened upstream key list so consumers can be
  ordered after it.
- **A persisted cache entry.** Keyed deterministically; valued at the receipt. Survives hot-restart
  and snapshot capture/restore; invalidated by chainId flip or verify-fail eviction.
- **TUI row + observability output.** Sub-phase narration during execution; a "done" terminal row on
  success; failure cause routed through the engine's failure-reporting channel; spans annotated with
  cache namespace/key/outcome.
- **Lifecycle hooks for downstream ordering.** The ref's "ready" event is what unblocks consumers
  that declared it in their own needs list.
- **On-chain side effects.** The real-world artifact (minted coins, created singletons, etc.). These
  persist in the chain's writable layer and are what `docker commit` snapshots capture.

## Invariants and constraints

- **Cache key MUST be deterministic** over
  `(name, signer identity, upstream dep keys, chainId, optional discriminator)`. Any change in those
  inputs MUST yield a different key; same inputs MUST yield the same key.
- **Body callback is opaque to the cache.** The substrate cannot canonicalize a function body;
  semantic changes to the body MUST be expressed via the discriminator.
- **Verify MUST be lenient** against transient RPC failures. A blip can't be allowed to
  mass-invalidate. Only a confirmed "not present" / "unresolvable" reading should evict.
- **Discriminator Effects MUST be evaluated at acquire time, not declaration time.** They often need
  to yield upstream refs to derive their value.
- **Discriminator Effects evaluate on every acquire**, including cache hits, so they remain
  dep-graph participants.
- **Every one-shot effect is cached.** No opt-out; users force re-fires by supplying a dynamic
  discriminator.
- **Execution failure MUST be wrapped in a stable, discriminable error shape** distinct from raw
  signer errors.
- **Does NOT populate in-process registries.** Ad-hoc receipts don't fit registry shapes.
- **The ref MUST be tagged as a one-shot-effect kind.** Drives TUI section, status-word collapse to
  "done," and exclusion from the supervisor's shutdown-pending count.
- **The receipt MUST be serializable** to the state-store. Implies plain-JSON-able (with bigint
  accommodation if any numeric fields require it).
- **Idempotence is the caller's responsibility.** If chain state survives but the cache invalidates
  (e.g. verify-fail), the body will re-execute; non-idempotent bodies create duplicates. The
  category provides no enforcement, only the cache discipline.

## Edge cases and known failure modes

- **Build callback raises.** Surfaces through the lifecycle as a failure; downstream stays blocked.
- **Sign-and-execute raises** (RPC failure, insufficient gas, on-chain abort, missing key). Wrapped
  in the stable error shape; same lifecycle path.
- **Verify probe returns "not found"** on a cache hit. Entry evicted, produce path runs, fresh
  receipt persisted. Caller surprise if the body wasn't idempotent.
- **Cache persist IO defect.** Swallowed; receipt returned to the consumer; next cycle will re-fire
  as a miss.
- **Cache evict IO defect** on verify-fail. Swallowed; fresh value still returned; stale entry may
  linger and fail verify again next cycle.
- **Upstream ref fails to acquire.** The effect's lifecycle reports the failure at its own row (not
  the upstream's directly).
- **Discriminator Effect raises.** Same failure path as the body.
- **Pruned-transaction edge case.** A local node that prunes old transactions may make a
  previously-cached digest unverifiable, causing surprise re-runs after long idle periods.
- **No automatic retry/backoff.** A transient execute failure means the row goes to failed
  immediately; recovery requires hot-restart.
- **Stale receipts on SDK upgrades.** If the receipt shape changes between SDK versions, persisted
  entries deserialize with the older shape; no entry-versioning in the state-store.

## Learnings from current implementation

- Treating one-shot effects as just-another-onChainArtifact unifies cache/verify/register discipline
  with publish/deploy and pays off — restart and snapshot semantics fall out for free.
- The substrate's strict "upstream is a record" shape forces an awkward synthetic-alias bridge to
  accept a positional list of needs. The category genuinely wants both: a typed slot for the signer
  plus an ordered iterable of additional dependencies.
- Caching with no opt-out is the right default. Force re-fires via dynamic discriminators rather
  than an "always re-run" branch.
- Effect-form discriminators are essential because the discriminator often needs to read other
  resolved refs' state. Construction-time evaluation would miss the dep graph.
- The cache key MUST include chainId. Regenesis-as-implicit-invalidation is the cleanest way to
  handle wipes/forks/resets without explicit GC.
- Sub-phase narration (building, executing) materially improves the user's mental model when an
  execute hangs.
- Verify leniency is load-bearing. RPC blips on a busy local node would otherwise re-fire actions
  constantly.
- Mapping one-shot effects to a TUI row that says "done" (not "ready") and is excluded from the
  shutdown-pending count is a small but real UX signal that distinguishes them from long-running
  services.
- Generic plugin attribution flattens the TUI's information density. Each action ends up grouped
  under a single "action" bucket regardless of the logical domain it belongs to.
- Receipts are useful but raw; consumers commonly want a typed lookup ("which object of type T did
  this create") not raw arrays.
- The body callback's effect-context channel is captured for type inference (so yielded refs thread
  their identity through) even though the substrate doesn't actually provide services into it at
  runtime — this dual-purpose role is subtle.
- Execution-parameter overrides (gas budget) being excluded from the cache key is plausibly
  intentional (once it succeeded, the receipt is what matters) but goes unstated.

## Cross-component references

- **Engine core / substrate.** The category exists as a specialization of the unified
  on-chain-artifact pattern (publish → cache → verify → register, with register omitted here). Cache
  key namespacing, state-store IO, content-hashing, span annotation, log lines, lifecycle wrapping
  all come from the substrate.
- **Observability.** Sub-phase narration, lifecycle markers (acquiring, ready, failed),
  cache-outcome span annotations. No stopping/stopped markers.
- **State-store.** Persisted receipt entries; survives across cycles, captured by snapshot,
  naturally orphaned by chainId flip.
- **Chain probe.** Verify-side dependency on the chain's transaction lookup surface. MUST use a
  probe method that's permitted in fork mode (i.e. NOT a balance-derived surface).
- **Account / signer.** Provides the identity folded into the cache key and the sign-and-execute
  capability.
- **Package refs (and similar published-artifact refs).** Typical content of the needs list; their
  identity keys participate in the cache key.
- **Sui (chain context).** Provides chainId; the cache key's middle slot.
- **TUI.** Section placement (one-shot-effect section), status-word collapse to "done," exclusion
  from shutdown-pending count.
- **Snapshot.** Captures both chain writable state and the state-store cache so a restore brings the
  effect back to "already done."
- **Wipe / regenesis.** Implicit cache invalidator via chainId flip.

## Open questions / decisions deferred

- Should execution-parameter overrides (gas budget, etc.) be folded into the cache key, or remain
  explicitly excluded? If excluded, encode that as a tested invariant.
- Should the category expose a typed "object created of type T" helper on receipts, or leave it to a
  separate helper module / a richer downstream registry?
- Should one-shot effects carry their own plugin attribution (so the TUI can group them by logical
  domain) rather than collapsing into a single category bucket?
- What's the right contract when a body callback raises a typed error from an upstream ref — let it
  propagate through the lifecycle widely-typed, or require the body to catch in-place?
- Is automatic retry/backoff on transient execute failures in scope for the category, or strictly
  the caller's job?
- Should the state-store have GC / versioning for receipts (and any other onChainArtifact entries)
  so orphaned chainId entries don't accumulate?
- Does a watch / file-change subscription belong on one-shot effects (re-fire on source change), or
  does that escape the category's "fire once per chainId" contract?
- Should the synthetic-aliasing of positional needs be lifted into the substrate so other primitives
  (codegen, dev) stop reinventing it?
- What renders for the TUI row on supervisor shutdown? Today there is no terminal teardown event;
  behavior is implicit.
- Should the receipt shape be entry-versioned so SDK upgrades that change projections don't silently
  corrupt cached entries?

## Opportunities noticed

- The category genuinely wants both a typed signer slot AND a positional iterable of additional
  needs. Lifting that pattern into the substrate would also serve other primitives.
- The "fire-once on-chain effect" category and the long-running-service category share a base (refs
  in the dep graph, lifecycle wrap, observability) but diverge clearly on resource ownership,
  readiness semantics, and teardown — a redesign should make that split explicit at the top of the
  type hierarchy rather than having one-shots simulate "ready that never stops."
- Receipts could be sharpened from raw blobs to a typed accessor surface (e.g. lookup created object
  by type), which would significantly reduce body-callback boilerplate at consumer sites.
- Plugin attribution wants to be threaded through; today it's flattened.
- Cache GC across all onChainArtifact consumers is a shared concern, not action-specific.
- The current "services/" directory mixes long-running services and one-shot primitive factories;
  redesign can split these out at the package level (e.g. `services/` vs `primitives/` or similar).
- Shared test harness (mock state-store / chain probe / signer) deserves to be a first-class testing
  utility rather than duplicated per primitive's test file.
- Discriminator-as-Effect being re-evaluated on every acquire, including hits, is correct but
  deserves a clearly documented contract — the asymmetry "we still must yield even when we'll throw
  the result away because cache hit" is non-obvious.
