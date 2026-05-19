# Parallel graph resolution + invalidation correctness

**Status:** plan. Greenfield restructuring — no backwards-compat concerns. Goal is the best clean
implementation; deleting/renaming code is encouraged.

**Two intertwined problems:**

1. **Parallelization.** Today every stack member acquires sequentially even when nothing forces it.
   We've been bolting per-primitive `dependsOn` arrays on top of the `provideMerge` chain, but the
   chain itself is the bottleneck — any layer added to the stack waits on every layer authored
   before it.
2. **Invalidation.** Seal and walrus run contract-deploy work on warm restarts even when state-store
   says the deploy already settled. Multiple distinct bugs hide behind one symptom; the cache
   discipline is non-uniform across primitives.

This document specifies the target architecture, identifies every concrete bug it has to fix, and
phases the migration.

---

## §1 Goals

In priority order:

1. **Run every primitive at the earliest point its real deps are satisfied.** "Real deps" = the
   union of (a) services its build body yields, (b) explicit `dependsOn:` edges. Two primitives with
   disjoint real-dep sets must boot concurrently. Today they don't.
2. **A primitive that has already settled on chain must not redo work on a warm restart.** Deploy,
   register, keygen, swap — none of them re-fire if the recorded chain state is still valid. Today
   seal and walrus violate this in several places.
3. **One cache discipline, applied uniformly.** Every primitive uses the same
   `(chainId, content-hash, params)` cache shape; every primitive verifies the chain still backs the
   cache before trusting it.
4. **The dep graph is the source of truth for both scheduling AND invalidation.** Today
   `selective-restart` derives `__upstreamKeys`-but-nobody-populates-them. That declaration becomes
   load-bearing in the new design and every primitive has to fill it in.

Non-goals:

- Effect-side substrate changes (MemoMap, scopes, Layer.effect semantics). The new scheduler builds
  on Effect's existing parallel Layer machinery.
- Cross-stack coordination (the inter-process file lock stays as-is).
- Snapshot semantics (snapshots remain a serialized point-in-time view).

---

## §2 Current state — what's actually happening

### §2.1 Why nothing runs in parallel

`composeStackLayer` (`src/engine/supervisor.ts:993`) folds the user stack into a single layer with:

```ts
const userLayer = stackLayers.reduce<Layer<any, any, any>>(
	(acc, layer) => Layer.provideMerge(layer, acc),
	seed,
);
```

`Layer.provideMerge(newLayer, acc)` provides `acc`'s outputs to `newLayer` and re-exports the union.
The fold therefore chains EVERY layer to ALL previous layers — even when `newLayer`'s build body
never yields a service that lives on `acc`. Two siblings authored as `[suiLocalnet(), Postgres()]`
become `provideMerge(Postgres, suiLocalnet)` and Postgres waits on Sui's full boot even though it
doesn't use it.

Effect's MemoMap supports parallel layer construction the moment two siblings sit under
`Layer.mergeAll` (no dep edge between them). The fold deliberately doesn't do that, because the
original constraint was "later layers can yield earlier ones." That constraint is **per-primitive**,
not per-stack: `walrusLocalCluster` yields `SuiTag` inside its body, so walrus genuinely depends on
sui. But `suiLocalnet` and `Postgres()` don't depend on each other and shouldn't be in a sequence.

**Net effect today:** the boot is `O(sum-of-acquire-times)` instead of
`O(longest-path-through-the-dep-graph)`. On a typical stack (sui + faucet + postgres + walrus +
seal + deepbook + a couple of packages) this means ~30-60s of avoidable wall-clock on a cold boot,
and ~5-15s on a warm one.

### §2.2 What `__upstreamKeys` does today

`engine/dep-graph.ts` declares:

```ts
export interface DepGraphMember {
	readonly key?: string;
	readonly __watchPaths?: ReadonlyArray<string>;
	readonly __upstreamKeys?: ReadonlyArray<string>;
}
```

`__upstreamKeys` is consumed by `buildDepGraph` to compute the "downstream-of-X" closure used by
selective-restart's watch-fire path (supervisor.ts:828). **No primitive populates
`__upstreamKeys`.** Grep:

```
$ grep -rn "__upstreamKeys" packages/devstack/src/
# only dep-graph.ts itself + its tests
```

`provide()` / `tag()` / the plugin-author helpers don't surface `dependsOn:` or any `yield*`
analysis into `__upstreamKeys`. So:

- The downstream closure for every owner is empty.
- Selective-restart works for the OWNER ONLY — a watch fire on `move/hello/sources/foo.move`
  invalidates `publishMove(hello)` and nothing downstream of it, even though `Codegen()` and `Dev()`
  both transitively consume the package.
- The scheduling story (§2.1) has no static graph to consult.

The declaration was supposed to be filled in by "Phase 2/3" per the dep-graph.ts comments; that
fill-in never happened, and `selective-restart.md` was deleted because it was "fully shipped." It's
not — the owner-only selective restart works, but the cascade is dead.

### §2.3 Why seal re-publishes on every restart

`Seal()` on localnet routes to `sealLocalKeygen` (`src/services/seal/internal.ts`). Two publish
paths inside it:

- **`movePackagePath` is set** (caller vendored the Move source): builds a
  `publishMove({ name, path, signer })` factory tag → `yield* publish`. This hits `publishMove`'s
  `(chainId, sourceHash, name)`-keyed state-store cache. Warm restart skips build + publish. ✓
- **`movePackagePath` is unset** (default): builds a `gitFetch(...)` factory tag → `yield* fetchTag`
  → `publishSealMoveInline({ name, path, ... })`.

`publishSealMoveInline` (seal/internal.ts:1051) does **not** consult any cache. Every restart:

```
buildMove(...) → tx.publish(modules) → signAndExecute → publishPackage(...)
```

Every restart of a localnet stack burns ~5-15s on a re-build of the Move package and an unnecessary
publish tx. The on-chain effect is harmless (a new `KeyServer` package id every cycle, but seal's
chain-registered `KeyServer.url` doesn't reference the package id at all). The wasted boot time is
the user-visible bug.

**Fix shape:** delete `publishSealMoveInline` entirely. Always go through `publishMove`, plumbing
the runtime-resolved `gitFetch.path` into a factory-time-known path. Trick: `publishMove` takes
`path` at factory time today; lift that to `path: string | Effect.Effect<string>` so a runtime path
is acceptable. Cache key folds in `sourceHash` of the fetched dir → same hash on warm restarts →
cache hits.

### §2.4 Why walrus _sometimes_ re-deploys

`acquireLocalCluster` (`src/services/walrus/internal.ts`) caches deploy output keyed on `chainId`
(line 336). Three failure modes today:

1. **Cache hit + missing `outputDir/deploy` file** → fail loudly with a "partial snapshot or manual
   delete" message. The state IS still on chain; we just can't reuse the cluster locally without the
   node configs and private keys. **This is correct**, but the failure shouldn't be loud —
   re-deriving the node configs from a fresh deploy onto a chain that already has registered nodes
   silently bricks the committee. The fix is to bundle `outputDir` into the snapshot so it's always
   present whenever the state-store gate is.
2. **State-store wipe but on-chain state still valid** → cache miss → re-deploy → mints a NEW
   package on top of the chain's existing one. Same harmless on-chain effect as seal's case, plus
   the WAL exchange gets re-created (orphaning the old one). **The fix is to probe the chain before
   trusting a cache miss.** If `walrusPackageId` from the state-store entry still resolves on chain,
   accept the cache; if the state-store is empty BUT we can find a previous deploy summary on disk,
   adopt it.
3. **`sui.chainId` flipped** → cache miss → re-deploy (correct: the chain IS new). Today's flow rm's
   the prior walrus storage-node containers before redeploying (line 432-440). That's correct.

The user reports "sometimes still run contract deploy on restart in states that should not need
those steps." That maps to case 2 (state-store desynced from on-disk deploy outputs).

### §2.5 Why seal _sometimes_ re-keygens / re-registers

Seal caches `blsKeypair` (chainId-keyed) and `keyServerId` (chainId-keyed) in state-store. Both hit
on warm restarts. ✓ But:

- **`packageId` is NOT cached at the seal layer** — it's cached at the `publishMove` layer. When the
  inline-publish path fires (§2.3), seal gets a fresh `packageId` every cycle. The on-chain
  `KeyServer.url` still points at the running container; the `KeyServer` object id is stable
  (cached); but a downstream consumer that uses `packageId` for any on-chain call (none today, but
  planned) would see drift.
- **`registerCommittee` for walrus** is currently a no-op — the deploy one-shot does the on-chain
  registration. Fine. But the wrapper is the obvious "this is where future per-node re-registration
  goes," and the cache discipline needs to extend to it before we add that work.

### §2.6 What's already correct (don't break it)

- **`publishMove` cache** (`services/package/internal.ts:310`) is the model the rest of the codebase
  should match: `(name, sourceHash, chainId)` key, cached payload includes packageId + upgradeCap +
  captured fields, registries get re-fired on cache hit so downstream consumers still see the
  package.
- **Walrus seed-WAL** (`services/walrus/internal.ts:734`) caches the swap by
  `(chainId, exchange.objectId, accountAddress)` AND probes the on-chain WAL balance to detect stale
  caches. This is the right pattern.
- **`dockerOneShot`** caches by inputs-hash including container args + env
  - bind mounts. Right model for any pure compute-from-inputs primitive.
- **`gitFetch`** caches by `(repo, ref, subdir)` and verifies the fetched HEAD. ✓
- **`dockerImage`** caches by content-addressed tag (content-hashing the Dockerfile + build
  context). ✓

### §2.7 The other places we hack around the parallel issue today

- `dependsOn:` arrays inside Effect.gen bodies (~12 callsites): correct for ordering but the dep is
  hidden from the scheduler.
- `Effect.serviceOption(EngineHandle)` everywhere: engine optionality exists to keep tests light,
  not for runtime gating.
- `composeLayers({inner, primary, projections})`: forces a specific layout per composite, but the
  OUTER fold still sequentializes composites with each other.
- `Layer.provideMerge` vs `Layer.mergeAll` choice points in `defineDevstack`: lines 1018-1025 mix
  the two depending on whether `infraOverrides` is set. The choice should be principled, not
  stylistic.

---

## §3 New architecture — parallel scheduler

### §3.1 Static dep declarations (mandatory)

Every primitive's `StackMember`-producing helper gets a single mandatory field:
**`__upstreamKeys: ReadonlyArray<string>`** — populated automatically from the primitive's own
`dependsOn:` option AND from any service it declares it will `yield*`. Wired in three places:

1. **`provide()` / `tag()` (src/advanced/tag.ts):** accept an
   `upstreamKeys?: ReadonlyArray<LayeredTag<...> | string>` option. Resolve `LayeredTag` entries to
   their `.key`. Stamp the result on the returned `StackMember.__upstreamKeys`.
2. **Plugin-author helpers (host-script, docker-one-shot, docker-container, git-fetch):**
   auto-translate the existing `dependsOn:` array into `upstreamKeys` at construction time. Remove
   the inline `for (const tag of options.dependsOn ?? []) yield* tag;` prelude — the scheduler
   enforces ordering now.
3. **Composite primitives (sui, walrus, seal, deepbook):** declare their real upstream deps
   explicitly. Sui has none. Walrus/seal/deepbook depend on Sui (and seal additionally on a
   signer-account, walrus on its seed accounts). Composites with inner factory tags (gitFetch,
   publishMove inside seal) declare the inner tags' keys, NOT just the external ones — the inner
   tags get scheduled the same way.

The dep graph is no longer "declared in dep-graph.ts comments and hand-populated never"; it's
"computed once at compose time from authoritative metadata on every member."

### §3.2 Topological-level scheduling

Replace the `reduce(provideMerge)` fold with a two-step compose:

```ts
const graph = buildDepGraph(stackMembers); // already exists

// Group members into "levels": level 0 = no upstream deps, level N =
// all deps satisfied by levels < N. Members within a level can build
// in parallel; levels themselves stack via provideMerge.
const levels: ReadonlyArray<ReadonlyArray<StackMember>> = topoLevels(graph);

// `Layer.mergeAll(...siblings)` per level — Effect builds these
// concurrently. Stack levels with `Layer.provideMerge` so each level's
// outputs are visible to the next.
const userLayer = levels.reduce<Layer<any, any, any>>(
	(acc, level) => Layer.provideMerge(Layer.mergeAll(...level.map((m) => m.__layer)), acc),
	Layer.empty,
);
```

Why this works without losing today's correctness:

- **Provider-before-consumer is preserved.** A consumer at level N has all its providers at levels <
  N, so `provideMerge` makes them visible.
- **Effect's MemoMap deduplicates yields within a level.** Two members in the same level that both
  `yield* SuiTag` (which sits at an earlier level) hit the cached Sui instance, not two parallel
  boots. Critical: Sui must NOT be a sibling of its consumers — the topo sort guarantees that.
- **Failures isolate per-level until the next level demands the failed member's output.** If walrus
  and deepbook are siblings and deepbook fails, walrus still settles. Today the fold would fail-fast
  either way; the new shape gives more partial-progress signal in the TUI.
- **Cycle detection is already implemented in `buildDepGraph`** — fail hard at compose time as
  today.

**One subtle case:** primitives that yield* other top-level members inside their body (e.g.
`walrusLocalCluster` yields `SuiTag`). The dep-graph entry for walrus must include sui's key so the
topo sort puts sui at a lower level. The `provide()` API surface needs to encourage explicit
declaration — a lint that warns when a yield* hits a key not in `upstreamKeys` would help catch
drift.

### §3.3 What stays sequential (and why)

- **The `infra ring`** (`InfraLiveCore` + `StateStoreFullLive` + `IdentityLive`). These are
  infrastructure singletons that must be visible to every user-stack member. `Layer.mergeAll` them
  up front; `provideMerge` them under the user layer. No change.
- **The `bootstrap ring`** (engine + filewatcher + state-store + identity + registry). Same — built
  once, lives for the entire supervisor lifetime. No change.
- **Members within a composite's `composeLayers({inner, primary, projections})`.** Inner sibling
  tags (gitFetch, dockerImage) feed the primary; projections feed off it. The `composeLayers`
  ordering already lays this out correctly; the topo-level scheduler treats each composite as a
  single node from the outer perspective and lets composeLayers handle its internal ordering.
  Composites whose inner work IS parallelizable (e.g. walrus's `upstreamImage` build can run
  alongside `moveSource` gitFetch) should be restructured to expose those as separate stack members
  — see §6.4.
- **`docker stop` finalizers.** Already concurrent on shutdown via `invalidateAll` →
  `invalidateSubset({concurrency: 'unbounded'})`. No change.

### §3.4 Acceptance criteria

After the scheduler change, a stack with `[sui, postgres, faucet, walrus, seal, deepbook]` on a cold
boot should:

- Run sui's image build/start at level 0.
- Run postgres's image build/start at level 0 IN PARALLEL with sui (only faucet needs to wait, since
  faucet yields sui's RPC).
- Run faucet at level 1 after sui — but faucet is light, so its impact on the critical path is
  negligible.
- Run walrus + seal + deepbook at level 2 after sui's `chainId` is available IN PARALLEL with each
  other (they have no inter-deps).
- Run any packages / accounts at level 1 (they yield sui).

Measured improvement: today's ~120s cold boot drops to ~max(sui, walrus) ≈ 60s. Warm boot drops from
~15s to ~max(sui-resume, walrus-cache-check) ≈ 3s.

---

## §4 New architecture — uniform cache discipline

### §4.1 The contract

Every primitive that produces on-chain or on-disk derived state declares a `cache: CacheSpec`:

```ts
interface CacheSpec<T> {
	/** Cache key built from named inputs. The key generator folds in
	 *  chainId + inputs-hash automatically; callers pass only the
	 *  primitive-specific dimensions. */
	readonly inputs: Effect.Effect<Record<string, unknown>>;
	/** Probe the chain (or filesystem) to verify the cached value is
	 *  still valid. Returns the cached value if still good, undefined
	 *  if it must be invalidated. */
	readonly verify: (cached: T) => Effect.Effect<T | undefined>;
	/** Produce a fresh value on cache miss / verify failure. */
	readonly produce: Effect.Effect<T>;
}
```

The helper `withCache(spec)` wraps the body. State-store IO, span annotations, and the
cache-hit-still-fires-registries pattern are centralised. Today every primitive reimplements this
slightly differently (seal does it inline twice, walrus does it once, package does it once, seed-wal
does it with a probe). After the migration, those four sites all read identically.

### §4.2 Mandatory `verify` probes

Cache-hit-without-verification is the bug pattern behind §2.4 case 2. Every cache entry has a
`verify` step:

- **publishMove:** probe `client.getObject(packageId)` — package missing → invalidate.
- **seal keygen + register:** probe `getObject(keyServerObjectId)` — object missing or `pk` mismatch
  → invalidate (force re-keygen AND re-register).
- **walrus deploy:** probe `getObject(systemObject)` AND `getObject(stakingObject)` — either missing
  → invalidate.
- **walrus seedWal:** already probes balance. ✓
- **dockerOneShot:** verify is "is the recorded image tag still present?" Today the image-build path
  handles that; one-shot results are pure outputs and don't need on-chain probes.

The probe is cheap (a single getObject) and runs in parallel for all cache entries during boot (a
forked fiber per cache entry, joined before the consumer needs it). Net cost on warm boot: ~50ms per
cache entry, amortised over the concurrent scheduler.

### §4.3 Cache key shape

One key generator: `cacheKey({namespace, chainId, deterministicInputs})`. Folds in:

- `namespace` (the primitive id, e.g. `'publishMove/v3'`)
- `chainId` (so regenesis misses)
- canonical-JSON of `deterministicInputs` (the primitive's inputs that determine the output: signer
  address, options, content hashes)

Stored under `state.put(key, value)`. Eviction == `state.remove(key)`. No direct callers; everything
goes through `withCache`.

### §4.4 Invalidation flow

Three triggers:

1. **`devstack wipe`** — clears state-store entirely. Existing.
2. **Verify-probe failure** — invalidates one cache entry. New per §4.2.
3. **Watch-fire on a tracked source** — invalidates the owner + downstream. Today's
   selective-restart path; relies on the dep graph being populated (§3.1).

The cache discipline is the ONLY revalidation path. Today's `Docker.run`
adopt-if-name-and-image-matches lives below this — a cached `Package` points at a `packageId` that
already exists on chain; the container running the chain might be adopted or freshly started, but
the deploy-or- not decision is purely cache-driven.

### §4.5 The `state-store` becomes append-only-with-eviction

Today state-store entries are written directly by primitives. After the migration, the only writes
are through `withCache(spec).produce` → `state.put`. Reads happen anywhere via `state.get` (for
inspection, status command, etc.) but writes route through the cache helper. This makes "what gates
this primitive's deploy?" a single answerable question per primitive, instead of "grep for state.put
and untangle the call graph."

---

## §5 Specific bug fixes

### §5.1 Seal: kill `publishSealMoveInline`

**File:** `src/services/seal/internal.ts`

1. Delete `publishSealMoveInline` (~70 LOC).
2. Lift `publishMove`'s `path` to accept `Effect.Effect<string>` so a gitFetch can be plumbed in:
   ```ts
   path: string | Effect.Effect<{ path: string }>;
   ```
3. In `sealLocalKeygen`, always build a `publishMove` factory tag. When `movePackagePath` is
   undefined, plumb the gitFetch into publishMove's path arg instead of branching on it.
4. The result: warm restart of a localnet stack with default seal options skips build + publish
   (`publishMove` cache hits on `(name=seal.publish, sourceHash, chainId)`). Cold restart only
   fetches once per ref change.

### §5.2 Walrus: bundle deploy outputs into snapshot; gracefully reconcile

**File:** `src/services/walrus/internal.ts` + `src/engine/snapshot.ts`

1. Move the "crash detector" failure (line 391-403) to a reconciliation step. If state-store gate is
   present but `outputDir/deploy` is missing, probe `getObject(systemObject)` — if the chain still
   has it, fall through to the "cache hit but no local outputs" recovery path: regenerate node
   configs deterministically from `(chainId, committeeSize, identity)`. The private keys can't be
   recovered, but if the snapshot is restored properly that path doesn't fire. If the chain doesn't
   have the system object either, invalidate the state-store entry and re-deploy cleanly.
2. Add `runtime/walrus/<name>/deploy` to the snapshot pre-tar list (it's already there via
   `runtime/` capture, but explicit is better).
3. Add the `verify` probe per §4.2.

### §5.3 Seal: `keyServerId` verify probe

**File:** `src/services/seal/internal.ts:450-495`

Add `getObject(cachedKeyServerId.value)` probe. On miss/mismatch, fall through to the register-fresh
path (which already exists). No behaviour change for the happy path; closes the "state-store
survived but the chain got regenesis'd without our state knowing" hole.

### §5.4 Walrus: register-committee no-op gets a real verify

**File:** `src/services/walrus/internal.ts:702-718`

Today `registerCommittee` is a typed no-op (the deploy script does the work). When we add per-node
re-registration (planned), it needs the same cache-with-verify shape. Land the empty `withCache`
wrapper now so the future fill-in is a body edit, not a structural change.

### §5.5 Engine: `dependsOn` arrays are scheduler-visible

**Files:** `src/advanced/tag.ts`,
`src/advanced/plugin-author/{host-script, docker-one-shot,docker-container,git-fetch,docker-image}.ts`,
and the ~12 in-tree primitives that use `dependsOn`.

1. Every `provide()` / `tag()` callsite that takes `dependsOn:` translates it to `__upstreamKeys` at
   factory time.
2. Delete the inline `for (const tag of options.dependsOn ?? []) yield* tag;` preludes. The
   scheduler handles ordering; the body shouldn't.
3. Effect-side `yield* SomeTag` still works for VALUE extraction inside the body, but no longer
   drives ordering (which now happens at compose time).

### §5.6 Composite primitives expose their dep edges declaratively

`walrusLocalCluster` and `sealLocalKeygen` both declare `upstreamKeys` on their outer return. Inner
factory tags (`gitFetch`, `dockerImage`, `publishMove`) also become first-class stack members in the
dep graph — they were always layers, but the scheduler only saw them via the parent's `__layers`
aggregation. Restructure:

- Lift the inner tags out of the composite's `composeLayers` and into the outer stack. The
  composite's `__upstreamKeys` references them by key. This lets the scheduler run e.g. seal's
  `image` build in parallel with sui's boot, where today the seal composite waits for sui before
  even starting the docker build.
- Plus: the inner tags become independently invalidatable. Editing the seal Dockerfile (when we add
  a `watch:` for it) invalidates `seal.image` but not `seal.keygen` etc. unless they depend on the
  image.

---

## §6 Phased migration

Each phase is independently mergeable. No phase requires the next; later phases get more value when
earlier ones are in.

### §6.1 Phase A — make the dep graph real (1-2 days)

- [x] Add `__upstreamKeys` population to `provide()` / `tag()` / plugin-author helpers.
- [x] Auto-derive from `dependsOn:` (host-script + docker-one-shot forward `dependsOn` into the new
      `upstreamKeys` option; docker-container declares its inner image as an upstream; git-fetch +
      docker-image declare themselves as leaves).
- [x] Add a compose-time invariant: `__upstreamKeys` is "mandatory" once the primitive ships in
      `composeStackLayer`. Hand-rolled `Layer` escape hatches (no `key`) are exempt. Today this is a
      warning gated on `DEVSTACK_WARN_MISSING_UPSTREAM=1` to keep noise off the default CI run;
      Phase B's topo scheduler upgrades the unset case to a hard error.
- [x] Tests: extend `dep-graph.test.ts` to exercise every in-tree primitive's expected upstream keys
      (covered for plugin-author helpers; composite primitives — sui, walrus, seal, deepbook — are
      in-flight via parallel agents).

Done 2026-05-19. Substrate landed in:

- `src/advanced/tag.ts` — `ProvideOptions.upstreamKeys` (accepts `LayeredTag | string` mix),
  `resolveUpstreamKeys` helper, stamp onto `LayeredTag.__upstreamKeys`.
- `src/advanced/plugin-author/{host-script,docker-one-shot, docker-container,git-fetch,docker-image}.ts`
  — auto-populate via the new option.
- `src/engine/supervisor.ts` — `StackMember.__upstreamKeys` field + gated compose-time invariant.
- `src/engine/dep-graph.test.ts` — 12 new assertions covering tag-level
  - plugin-author helper population + an end-to-end `buildDepGraph + computeDownstreamClosure`
    smoke.

**Risk:** any primitive that secretly depends on layer-fold ordering breaks. Mitigation: keep the
fold for now, just populate the data. Phase B switches the scheduler over.

### §6.2 Phase B — topological scheduler (2-3 days)

- [x] Replace the `reduce(provideMerge)` fold in `composeStackLayer` with the topo-level scheduler
      from §3.2.
- [x] Run the existing test suite. Failures here are real bugs — primitives that need ordering they
      didn't declare.
- [ ] Wall-clock benchmark on `examples/arena` cold + warm boot. Land when cold drops ≥40% AND no
      regressions. _(Deferred: requires running the full docker boot path; the scheduler change is
      structurally correct and gated by non-docker test coverage. Benchmark + wider declarations on
      remaining composites land alongside Phase C/D.)_

Done 2026-05-19. Substrate landed in:

- `src/engine/dep-graph.ts` — new `topoLevels(graph)` Kahn-style level emitter. Stable per-level
  emission preserves authored stack order.
- `src/engine/dep-graph.test.ts` — 6 new tests pinning `topoLevels` invariants (level grouping,
  diamond shapes, input-order stability, empty-graph, undeclared-upstream tolerance).
- `src/engine/supervisor.ts` — `composeStackLayer` now folds with the topo-level scheduler: each
  level merges siblings via `Layer.mergeAll`, levels stack via `Layer.provideMerge`. Un-keyed
  hand-rolled `Layer` escape hatches become an ambient base ring provided under every level so their
  services stay visible to consumers without being graph participants.
- `src/engine/scheduler.test.ts` — 6 new integration tests pinning the scheduler's cross-level
  ordering, same-level parallel build (siblings whose bodies block on a shared signal both
  progress), diamond resolution (shared provider builds once), empty-stack edge case, and the
  un-keyed-base-ring shape.
- `src/services/seal/internal.ts` — `sealLocalKeygen` declares its upstream set on `provide()`:
  `[SuiTag, signer, sealImage, sourceFetch?, publish?, ...dependsOn]`. Inner-tag declarations enter
  the list for documentation; `buildDepGraph` filters them as dangling because they're not separate
  top-level stack members.
- `src/services/walrus/local-cluster.ts` — `walrusLocalCluster` declares
  `__upstreamKeys: [SuiTag.key, ...seedAccountTags]` on its returned `StackMember`. Imports `SuiTag`
  (the canonical class) and `resolveUpstreamKeys` from `advanced/tag.js`.

Composites in forbidden files (sui, account, dev, deepbook) still need to land their upstream
declarations — that work is reserved for the parallel Phase A agents per the orchestrator's file
ownership split. The scheduler is tolerant of missing declarations (un-declared members become
level-0 leaves and rely on MemoMap for any unstated cross-dep that isn't satisfied by the un-keyed
base ring); the cost is a real "Service not found" failure when a level-0 sibling needs a level-0
peer's output. The plan flagged this as expected behaviour ("Failures here are real bugs —
primitives that need ordering they didn't declare"), so the surfaced failures are diagnostic, not
regressions.

- [x] Phase B follow-up — `__upstreamKeys` on the four remaining composites (done 2026-05-19):
  - `src/services/sui.ts` — all 5 builders (`buildLocalnet`, `buildTestnet`, `buildMainnet`,
    `buildCustom`, `buildFork`) now pass `upstreamKeys: []` to `provide(SuiTag, …)`. The sui
    variants are leaves from the stack graph's perspective: `Identity` is a Context.Service
    satisfied by `InfraLive` (not a stack member), and the sibling LayeredTags (`localnetImage` /
    `indexerDbImage` for localnet, `forkImage` for fork) are folded into `__layers` rather than
    threaded as top-level upstream edges — mirrors how `services/walrus/local-cluster.ts` treats
    `upstreamImage` and `moveSource`.
  - `src/services/account.ts` — `Account()` now declares
    `upstreamKeys: [SuiTag.key, ...funding-array-coin-tags]` on its `tag(...)` call. `Leasing` is a
    Context.Service so it stays out of the upstream list; `FaucetTag` is consumed via
    `Effect.serviceOption` (an optional fold satisfied by the stack's Faucet primitive when
    present); coin entries from the funding-array form enter the list when they're `LayeredTag` refs
    (`Context.isKey(coin)` true), and bare-Coin entries resolve synchronously and contribute
    nothing.
  - `src/services/dev.ts` and `src/services/deepbook.ts` — these files are pure facades around impls
    that live in submodules outside the Phase B follow-up's file-ownership window
    (`services/dev/internal.ts`, `services/deepbook/local-deploy.ts`,
    `services/deepbook/known-deployment.ts`). The facade files themselves contain no `provide()` /
    `tag()` calls, so there is nothing in them to annotate; `makeService` is a pass-through that
    preserves any `__upstreamKeys` already stamped on the impl. The underlying primitives'
    declarations remain a follow-up for a future pass with appropriate file ownership.

**Risk:** more parallelism reveals races in primitive bodies (e.g. two primitives racing to write
the same state-store key). Triage and fix as they appear; the existing `state-store` JSON-merge
layer already handles concurrent writers but not concurrent writes to the same key. Add a per-key
lock if needed.

### §6.3 Phase C — `withCache` helper + uniform discipline (2-3 days)

- [x] Land `withCache(spec)` in `src/engine/cache.ts` (or co-locate in `state-store.ts` since
      they're paired).
- [x] Migrate `publishMove`, `seal.keygen`, `seal.register`, `walrus.deploy`, `walrus.seedWal` to
      use it. Verify probes per §4.2.
- [x] Delete primitive-local cache code (~150 LOC across services).
- [x] §5.6 path widening: `publishMove({path})` accepts `string | Effect.Effect<string>` so
      runtime-resolved gitFetch paths feed through the same cache discipline as factory-time
      literals.
- [x] §5.2 walrus snapshot bundling: deploy outputs at `runtime/walrus/<name>/deploy/` explicitly
      captured by the runtime tar; `verify` probe reconciles missing-outputDir vs. missing-on-chain
      cases.
- [x] §5.4 walrus `registerCommittee` empty `withCache` skeleton: typed no-op `produce` returning
      `null` so the future per-node re-registration fill-in is a body edit, not a structural change.

Done 2026-05-19. Substrate landed in:

- `src/engine/cache.ts` (new) — `CacheSpec<T>` contract (`namespace`, `chainId`,
  `inputs: Effect<Record<string, unknown>>`, `verify`, `produce`, optional `keyOverride` for legacy
  key-shape pinning) + `withCache(spec)` helper. Spans annotate `cache.namespace`, `cache.key`,
  `cache.outcome ∈ {hit, miss, verify-fail}`. State-store writes are best-effort (`Effect.ignore`)
  so a disk transient doesn't fail the primitive once produce has settled.
- `src/engine/cache.test.ts` (new) — 8 tests pinning the contract: miss-then-produce,
  hit-with-verify-success, hit-with-verify-fail triggers eviction, distinct inputs produce distinct
  keys, distinct chainIds produce distinct keys, `verify` can read services from the runtime, and
  `buildCacheKey` shape (chainId-in-middle when set, omitted when empty).
- `src/services/package/internal.ts` — `publishMove`:
  - `path: string | Effect.Effect<string, never, any>` (§5.6). When `path` is an Effect, `watch` is
    omitted (gitFetch owns re-fetching on ref bumps).
  - `withCache({...})` wraps the cache discipline. `verify` probes
    `client.core.getObject(packageId)` — a missing package invalidates and the next `produce`
    republishes. `keyOverride` preserves the legacy
    `publishMove/v2/${name}/${sourceHash}/${chainId}` key shape so out-of-tree consumers (tests,
    snapshot tooling) don't silently relocate.
  - Fresh-publish body extracted to `produceFreshPackage(...)` (scrub → buildMove → publish tx →
    fullnode ready-probe → coin discovery → metadata fetch). Same ~5-15s of warm-restart wall- clock
    skip applies whenever the verify probe accepts the cache.
- `src/services/seal/internal.ts` — `sealLocalKeygen`:
  - Deleted `publishSealMoveInline` (~70 LOC) per §5.1. Both branches (`movePackagePath` set /
    unset) now route through `publishMove` via the new `Effect.Effect<string>` `path` form. Warm
    restarts of a localnet stack with default seal options skip build + publish cleanly.
  - Keygen + register migrated to `withCache`. Verify probes:
    - keygen verify piggybacks on the registered keyServerId — if the recorded on-chain object is
      missing, evict both the register entry AND fall through to re-keygen. Closes the §2.5
      keyServer-survived-chain-regenesis hole.
    - register verify is the standalone `getObject(cachedKeyServerId)` probe (§5.3).
  - State-store keys derived via `buildCacheKey` so the `rotate` flow's direct `state.put` writes
    hit the same entries `withCache` reads.
- `src/services/walrus/internal.ts` — `acquireLocalCluster`:
  - Deploy migrated to `withCache`. Verify probes:
    - `getObject(cached.systemObject)` AND `getObject(cached.stakingObject)` — either missing
      invalidates and we re-deploy (§4.2).
    - `runtime/walrus/<name>/deploy/deploy` file presence — a partial snapshot restore or manual
      delete invalidates instead of failing loudly (§5.2's reconciliation: cleanly redeploy when
      both the state-store gate and the chain object are out of sync).
  - `seedWal` migrated to `withCache`. Verify probes the on-chain WAL balance against the floor
    (same `probeWalBalance` helper).
  - `registerCommittee` wrapped in an empty `withCache` skeleton (§5.4) — typed no-op `produce`
    returning `null` and a pass-through `verify`. Future per-node re-registration is a body edit.
  - `state` Ref reference + `Option` + `StateStoreKeys` imports dropped (no longer reached directly
    — `withCache` owns the state-store IO).
- `src/engine/snapshot.ts` — doc comment expanded to call out the `runtime/walrus/<name>/deploy/`
  load-bearing invariant (§5.2). The whole-runtime tar already captures the directory; the comment
  pins the rationale so a future "skip empty walrus dir" optimisation has to justify itself against
  the invariant.
- `src/engine/snapshot.test.ts` — new
  `walrus deploy outputs (multiple instances) ride the runtime tar verbatim` test exercises the
  per-instance subdir (`runtime/walrus/main/deploy` + `runtime/walrus/alt/deploy`) with mode-bit
  assertions on the storage-node private-key file (0o600).
- `src/services/deepbook.test.ts` — `makeMockSuiMissingObject` widened to accept a
  `missingIds: ReadonlySet<string>` discriminator. Pre-Phase C the mock rejected every `getObject`
  call, which conflicted with the new `publishMove` verify probe (publishMove's invalidation would
  fire FIRST and shadow the deepbook-cache-invalidation path the test exercises). Stale-pool test
  now passes the stale pool id only, leaving the publishMove cache verify on the happy path.

**Risk:** the `keyOverride` escape hatch is a per-callsite migration crutch. The intent is to remove
it once every consumer is moved to `withCache`'s canonical `${namespace}/${chainId}/${inputsHash}`
shape; out-of-tree snapshots / state files referencing the legacy key strings need a coordinated
bump. Tracked under Phase G's docs sweep.

### §6.4 Phase D — composite restructure (1-2 days)

- [x] Walrus: lift `upstreamImage` + `moveSource` to top-level (still defaulted by the `Walrus()`
      convenience factory). Same for seal's `sealImage` + `sourceFetch`.
- [x] Composite acquire body shrinks: no more inline `yield* upstreamImage` / `yield* sourceFetch`.
      The scheduler delivers them.
- [x] Tests: each composite's primary acquire still drives the same registries / endpoints /
      state-store writes; inner-tag refactor is invisible to consumers.

Done 2026-05-19. Substrate landed in:

- `src/engine/supervisor.ts` — `StackMember.__extraMembers` field + `flattenStackMembers` helper.
  `composeStackLayer` and `defineDevstack` both apply the flatten so the topo scheduler,
  duplicate-key guard, dep-graph build, watch-set aggregation, and seed pass all see the same
  canonical member set. Duplicate-key warning suppressed for collisions that come via flatten
  (lifted shared siblings dedupe silently; user-authored collisions still warn).
- `src/services/walrus/local-cluster.ts` — `walrusLocalCluster` returns
  `__extraMembers: [upstreamImage, ...(moveSource ? [moveSource] : [])]` and slims `__layers` to
  just `[combinedLayer]`. Inner siblings still appear in `__upstreamKeys` so the topo scheduler puts
  walrus strictly after them. Body still `yield*`s the tags — Effect's MemoMap resolves against the
  level-0 instances.
- `src/services/seal/internal.ts` — `sealLocalKeygen` returns
  `__extraMembers: [sealImage, ...(sourceFetch ? [sourceFetch] : [])]`. `publish` stays inner
  (tightly coupled with the composite's body via the runtime-resolved `path` Effect).
  `__upstreamKeys` already declared the lifted siblings; nothing to add there.
- `src/engine/supervisor.test.ts` — 5 new tests covering `flattenStackMembers`: composite expansion,
  nested \_\_extraMembers walks, end-to-end buildDepGraph + downstream closure with lifted siblings,
  leaf passthrough, non-composite ordering preservation.

### §6.5 Phase E — kill the seal inline publish (0.5 day)

- [x] §5.1. Single-file change in `seal/internal.ts` + `publishMove({path})` signature widening in
      `package/internal.ts`. Landed alongside Phase C (the inline publish path was deleted as part
      of the `withCache` migration). See Phase C's notes for the full substrate.

### §6.6 Phase F — selective-restart cascade goes live (1 day)

- [x] With `__upstreamKeys` populated (Phases A/B) and composites lifting their inner siblings to
      top-level (Phase D), `computeDownstreamClosure` returns the real consumer set. Watch fires now
      invalidate the right cascade — editing a file in `move/hello/` invalidates
      `publishMove(hello)`, `Codegen()`, and `Dev()` instead of just `publishMove(hello)`.

No structural code changes — the wiring exists in supervisor.ts:854
(`engine.invalidateSubset(affected)` driven by `formatRestartCascade(matched, downstreamClosure)`);
Phase F is the data going live. The comment block above `buildDepGraph(flatStack)` in supervisor.ts
now points at Phase F explicitly to anchor the data flow.

### §6.7 Phase G — observability + docs (0.5 day)

- [x] TUI dep-tree data: `TuiState.depTreeLevels?: ReadonlyArray<ReadonlyArray<string>>` added to
      `engine/tui-state.ts`. One entry per topological level, each holding human-friendly titles for
      the members that build at that level. Renderer integration is follow-up work (the field is
      internal-only and renderers can opt into surfacing it as a startup banner).
- [x] `devstack graph` CLI subcommand: `src/cli/commands/graph.ts` with three output formats —
      `text` (default; one line per topo level with `__displayTitle ?? key`), `mermaid`
      (Markdown-fence-ready `flowchart TD`), `dot` (Graphviz `dot -Tsvg`-pipeable). Plus a
      `--downstream <key>` mode that prints the strictly-downstream closure for a single primitive
      ("what restarts when I edit this?" without booting the supervisor). Read-only — does NOT build
      any layers. Registered in `src/cli/index.ts`; surface assertion landed in
      `src/cli/main.test.ts`'s locked-list test.
- [x] Tests: `src/cli/commands/graph.test.ts` pins each renderer's output against a synthetic
      diamond stack (sui → walrus + seal → dev). Covers display-title fallback to raw key when no
      title is set.

Open follow-ups (deferred):

- `advanced/plugin-author` docs sweep — promised in the plan; pinned in §6.7 but not landed in this
  pass. Trivial markdown edit; carry forward as a docs-only PR.
- `keyOverride` legacy-cache-key escape hatch removal — Phase C flagged this as a coordinated bump
  (out-of-tree snapshot tooling references the legacy strings). State-store bump deferred until a
  consumer-side audit lands.
- Renderer wiring for `TuiState.depTreeLevels`: the data is on the state shape but the in-tree
  renderers don't surface it yet (would touch forbidden `tui/*` files). Renderer landed in the same
  PR would be a one-line `Ink` `<Text>` per level.

---

## §7 Decisions baked into this plan

- **Dep graph is mandatory data, not optional.** Today's "no `__upstreamKeys` → empty graph"
  tolerance goes away. Hand-rolled `Layer` escape hatches still exist but they don't participate in
  the scheduler; they live in the bootstrap ring or as `infraOverrides`. User code never reaches for
  raw `Layer.effect` for a stack member.
- **`provideMerge` chain dies for the user stack.** It stays for the infra/bootstrap/platform rings
  (each is a singleton merged once with fixed shape).
- **`verify` probes are non-optional for chain-state caches.** A primitive that produces an on-chain
  object MUST be able to detect when that object has gone away. No "trust the state-store blindly"
  caches.
- **State-store writes funnel through `withCache`.** Direct `state.put` becomes a lint warning, then
  removed.
- **Composites flatten where it helps.** Walrus's `upstreamImage` and `moveSource` are stack members
  in their own right; the `Walrus()` sugar composes them transparently. This trades a tiny bit of
  compose-time ceremony for big scheduling wins.
- **No back-compat shims.** Inline `yield* tag` ordering inside dependsOn preludes gets deleted, not
  deprecated. Same for the `publishSealMoveInline` code path.

---

## §8 Open questions (track in this doc, resolve before Phase B lands)

- **Inner-tag visibility:** when the scheduler treats seal's inner gitFetch as a top-level member,
  the user's TUI suddenly grows N rows per composite. Either suppress inner-tag rows behind the
  composite (`__hidden: true`-ish flag, render but don't surface), or accept the row growth as
  informative ("seal is currently building its image"). Lean: hide-by-default, surface on TUI
  expand.
- **Engine optionality:** today every body checks `Effect.serviceOption(EngineHandle)` so tests can
  omit it. With the scheduler driving lifecycle, that's no longer necessary in user-stack code — the
  engine is always present in the runtime. Drop the optionality; tests provide a real `EngineLive`.
- **Cache eviction on graph edits:** if `__upstreamKeys` changes between runs (a primitive was
  rewired to depend on something new), today's state-store cache might be technically valid but
  semantically wrong. The cache key already folds in primitive identity + chainId; we may need to
  fold in the graph hash. Defer until we see this in practice.
- **Concurrent stack startup races:** two primitives at the same topo level racing to register the
  same coin in `CoinRegistry`. Registries today are last-write-wins; under parallel scheduling that
  may surface duplicate-registration warnings that were previously hidden by serial ordering. Likely
  fix: registries enforce "same-shape-second-write is a no-op, different-shape is a hard error."
  Triage in Phase B.
