# 14 Package (distilled)

## Purpose

The Package component is devstack's Move-package publishing service. A user declares either a local
Move source tree (Package) that should be built and published, or a fixed on-chain package id
(KnownPackage) that should thread through the same registries as a freshly published one. The
component resolves a stable handle —
`{packageId, upgradeCapId, coins, captured, sourcePath, mvrPlaceholder}` — that downstream services
(codegen, actions, coin factories, bindings emitters, manifest emitter, deepbook/seal/walrus
composites, faucet mint strategies) consume.

It is foundational: every composite service that publishes Move code or references on-chain packages
depends on either Package or its generalized substrate pattern.

## Responsibilities

- Hash a Move source tree deterministically so that semantically equivalent trees produce equal
  digests.
- Resolve the source path lazily (either a literal path, or an Effect that produces a path at
  acquire-time — e.g. a git-fetched vendored tree).
- Cache the publish outcome keyed by content hash + chain id + signer identity, surviving stack
  restarts and snapshot save/restore.
- Verify a cache hit by probing the chain (lenient: transient RPC failure must not invalidate).
- On miss or verify-fail: scrub vendored Move-lock environment sections, build the package, sign and
  submit the publish transaction, wait for the fullnode/indexer to ingest the package, parse the
  receipt, capture user-declared object ids, discover coins, fetch coin metadata, register faucet
  mint strategies for coins whose TreasuryCap the publisher holds.
- Surface the resolved handle into the in-memory PackageRegistry and per-coin entries into the
  CoinRegistry on every cycle (hit AND miss).
- Distinguish locally-published packages (have a source tree, can be bound by code-generation) from
  known packages (no source, registry entry only) in the type system so misuse fails at compose
  time.
- For fork stacks: accumulate seed-object ids declared by KnownPackages so the Sui fork primitive
  can pre-fetch them on first boot.
- Narrate lifecycle phases to the TUI dashboard.
- Participate in the file-watcher so a source-tree edit triggers rebuild/republish.

## Generic on-chain-artifact-publish pattern

Move-package publishing is one instance of a broader pattern: derive a stable identifier for an
on-chain artifact from a content-addressed input set, then either reuse it (cache hit + verified) or
re-derive it (cache miss / verify-fail). The same shape applies to coin mints, Walrus blob deploys,
Deepbook pool creations, Seal key-server registrations, and any future "publish-once,
reference-many" primitive.

The pattern decomposes into five phases:

1. **Inputs** — collect everything that determines artifact identity into a hashable value. For Move
   that is `{sourceHash, signerAddress}`. For other artifacts: `{coinTypeArgs, treasuryCapId}`,
   `{blobBytes, epochs}`, `{base, quote, params}`, etc. Inputs must be order- independent and
   exclude build/runtime artifacts that don't affect semantics.

2. **Cache key** — `<namespace>/<chainId>/<contentHash(inputs)>`. The chainId fold is mandatory:
   regenesis must miss; different live nets must not share a slot. The namespace identifies the
   artifact kind (`publishMove`, `mintCoin`, etc.). The cached value persists across process
   restarts and survives snapshot save/restore; it is wiped by `devstack wipe`.

3. **Verify** — on cache hit, probe the chain for the cached identifier (`getObject(packageId)` for
   Move). The probe must be lenient: transient RPC failure maps to "unknown", not "missing", so the
   produce body re-runs (cheap over-derive) rather than declaring the cache invalid. The probe must
   consume a stable identifier produced by the previous run, not a derived hash.

4. **Produce** — on miss or verify-fail, run the side-effecting build
   - submit. Narrate lifecycle phases. Wait for the chain/indexer to actually serve the new artifact
     before declaring ready (publish-tx commit precedes index visibility; downstream consumers fail
     spuriously without this wait).

5. **Register** — on EVERY cycle (hit and miss), surface the resolved handle into in-memory
   registries. Registries are per-supervisor-invocation; downstream consumers depending on a
   registry entry must see it whether the artifact was rebuilt or reused.

Constraints that bind the pattern:

- The substrate must order dependent primitives via an explicit upstream graph (e.g. signer,
  treasury cap). Implicit ordering via Effect's service resolution alone leaves all artifacts in the
  same scheduler level and resolved-upstream lookups fail.
- The verify probe MUST be lenient (transient failure → re-run, not abort).
- A host-wide advisory lock may be needed when the build/produce step touches a shared cache (e.g.
  `~/.move/git`); concurrent publishes must serialize at the lock, not race.
- Inputs that the build step itself mutates (e.g. `Move.lock` pinned sections rewritten by
  `sui move build`) must be normalized out of the hash, otherwise the first warm restart misses
  spuriously.

## Move-specific concerns

- **Source-tree hashing**: walk `.move`, `Move.toml`, `Move.lock`. Exclude `build/`, hidden
  directories, `node_modules`. Order- independent (sort siblings). Normalize `Move.lock` by
  stripping `[pinned.<env>.*]` / `[env.<env>.*]` before hashing — those are rewritten by the build
  but don't affect semantics.
- **Vendored-dep lock scrub**: before each build, strip pinned-env sections from
  `~/.move/git/**/Move.lock` so vendored deps don't bake testnet/mainnet ids into bytecode.
- **Concurrent-build lock**: a host-wide advisory lock under `~/.move` must serialize concurrent
  `sui move build` invocations across the host CLI, fresh container, and exec-in-container paths.
- **Build dispatch**: shells out to `sui move build`. Prefers a long-lived per-stack build container
  when one is in scope; else a fresh `docker run --rm`; else the host CLI. The RPC URL of the
  current chain is passed in so the build's dep resolver targets the correct chain id.
- **Publish receipt parsing**: pick the `'published'` change for the package id; pick the
  `UpgradeCap`-typed `'created'` change for the upgrade cap.
- **Coin auto-discovery**: walk the publish receipt for `TreasuryCap<T>` + `CoinMetadata<T>` pairs,
  cross-reference by inner coin type, key by symbol (with witness-name fallback), populate
  decimals/displayName/iconUrl via a batched metadata RPC. Surface every discovered coin in
  `pkg.coins`. KnownPackage cannot auto-discover (no receipt).
- **Treasury-cap mint strategy registration**: for each discovered coin whose cap the publisher
  still holds, register a mint strategy against the in-scope faucet so funding flows can mint from
  the cap. Coins with a non-publisher cap owner are recorded but skipped.
- **MVR placeholder**: a per-package symbolic identifier substituted by codegen emitters in place of
  the post-publish `packageId`, so emitted bindings stay portable. Default sanitizes the package
  name to `[a-z0-9-]+`; user override allowed.
- **Capture spec**: optional user-declared projection from publish receipt to typed record (e.g.
  AdminCap id, registry id). Two accepted forms: declarative type-substring record, or callback.
- **Fullnode ready-probe**: after publish-tx commit, poll `getObject(packageId)` until success or a
  10s ceiling at ~200ms cadence. Downstream tx builders fail with "Dependent package not found
  on-chain" if they fire before the indexer has ingested.

## Lifecycle states

### Package (local publish)

- **declared** — factory called; tag exists; build body not yet run.
- **acquiring/upstream** — waiting on signer account, sui chain handle, chain probe.
- **hashing** — walking and digesting the source tree.
- **cache-lookup** — reading the cache entry.
- **verifying** — probing the chain for the cached `packageId`.
- **building move** — invoking the Move compiler.
- **publishing** — submitting and waiting for the publish tx.
- **waiting-for-index** — polling fullnode until the package is queryable.
- **capturing** — parsing receipt, running capture spec, discovering coins, fetching coin metadata.
- **registering** — writing PackageRegistry + CoinRegistry entries; registering faucet mint
  strategies. Runs on hit AND miss.
- **ready** — resolved value available to downstream consumers.
- **failed** — `PublishError` with a phase identifying which step threw.

### KnownPackage

- **declared** — factory called; seed-object ids eagerly accumulated into the per-compose set.
- **registering** — registry write for the declared id.
- **ready** — immediate after the registry write.

### Restart / hot-reload

- A watched source file edit triggers a stack restart cascade. Selective per-primitive teardown is a
  future improvement; today the whole stack restarts even for a single `.move` edit.
- A restart against unchanged inputs hits the cache and skips build+publish.
- Regenesis flips chain id → cache miss → fresh publish → new package id; downstream caches keyed by
  package id naturally invalidate.

### Teardown

- No acquired resources. The on-chain object lives until the chain is wiped (container removal). The
  per-compose seed-object accumulator must be cleared between two composes in the same process.

## Inputs / dependencies

### Component-level inputs

- **Source path** — literal filesystem path OR an Effect that resolves to a path at acquire time.
  Runtime-resolved paths do not auto-attach to the file watcher.
- **Signer account** — required; signs the publish tx, ends up holding the UpgradeCap, and is part
  of the cache key (so reusing the same source under a different signer correctly misses).
- **MVR override** — optional symbolic name for codegen.
- **Codegen exclusion flag** — opt out of bindings emission.
- **Capture spec** — optional, for non-coin object captures.

KnownPackage-only:

- **packageId** — required on-chain id.
- **upgradeCapId** — optional.
- **mvrPlaceholder** — optional.
- **seedObjects** — optional list of object ids for fork pre-seeding.

### Substrate / environment dependencies

- **Sui chain handle and chain id** — chain id is folded into the cache key; chain handle is used
  for the publish tx and the verify probe.
- **Chain probe** — lenient `getObject(id)` for verify.
- **State store** — cache backend.
- **Build dispatch context** — optional per-stack build container, build image; falls back to host
  CLI.
- **Faucet registry** — optional; mint-strategy registration is a no-op if absent.
- **PackageRegistry / CoinRegistry** — in-memory, per-supervisor cycle.
- **File watcher** — for hot-reload on source edits.
- **Host filesystem and child-process spawner** — for hashing, scrubbing, and shelling out to the
  Move toolchain.
- **`~/.move/git` cache** — content-addressed vendored deps; written by the Move build,
  read+scrubbed by the publish flow.
- **Host advisory lock under `~/.move`** — serialization of concurrent builds.

## Outputs / capabilities provided

- **Resolved Package handle** —
  `{name, packageId, upgradeCapId?, coins, captured, sourcePath, mvrPlaceholder}` for local Package;
  minimal `{name, packageId, upgradeCapId?}` for KnownPackage.
- **PackageRegistry entry** — one record per declared package.
- **CoinRegistry entries** — one per discovered coin (local Package only).
- **Faucet mint strategies** — one per coin whose cap the publisher holds (when a faucet is in
  scope).
- **Manifest fields** — `packages[<name>] = {id, captured, upgradeCapId?, mvr?}` projection consumed
  by the manifest emitter; coins surface under a sibling `coins` map.
- **Bindings input** — the source path of every local Package is read by the bindings emitter
  (KnownPackages filtered out).
- **State-store cache entry** — persisted under `<namespace>/<chainId>/<inputsHash>`, survives
  snapshot.
- **TUI lifecycle attribution** — phase narration ("building move", "publishing", "capturing"), row
  identity, primary line, extras ("N coin(s)", "known").
- **File-watcher participation** — literal-path Packages contribute watch roots that trigger restart
  on `.move`/`Move.toml` edits.
- **Dep-graph upstream attribution** — the resolved tag carries its signer's identity in its
  upstream-keys so the topological scheduler orders correctly.
- **Fork seed-object accumulator** — KnownPackage's `seedObjects` ids are exposed to the Sui fork
  builder via a compose-scoped collector
  - clear-between-composes helper.

## Invariants and constraints

1. Source-tree hash must be stable across order, runs, and irrelevant filesystem details:
   order-independent at every directory level; excludes `build/`, hidden dirs, `node_modules`;
   ignores non-Move files.
2. `Move.lock`'s `[pinned.<env>.*]` and `[env.<env>.*]` sections MUST be normalized out of the hash
   — they are rewritten by the build, so otherwise the first warm restart after a cold publish
   misses spuriously.
3. Cache key MUST fold chain id. Regenesis must miss.
4. Signer MUST be an explicit upstream so the scheduler orders the account before the publish.
5. After publish-tx commit, the fullnode/indexer ready-probe MUST complete before declaring ready.
6. The register step MUST run on EVERY cycle (hit AND miss); registries are per-supervisor and must
   reflect resolved state on every boot.
7. The verify probe MUST be lenient: transient RPC failure does not evict the cache; only an
   authoritative "object not present" response evicts.
8. The verify probe MUST consume a stable identifier produced by the previous run, not a derived
   hash.
9. KnownPackage must be type-distinguishable from local Package so bindings emission rejects
   KnownPackages at compose time (no source tree to bind).
10. Fork seed-object accumulation MUST happen eagerly at factory invocation, before the Sui factory
    closes over its seed list, and MUST be cleared between two composes in the same process.
11. Coin-key collisions within a single package must be handled deterministically (sort + drop
    second with warning).
12. Coins whose TreasuryCap is not held by the publisher must be recorded but skipped in
    mint-strategy registration.
13. MVR placeholder default must sanitize to `[a-z0-9-]+` (downstream validators reject
    underscores).
14. Host-wide advisory lock under `~/.move` must cover the entire build spawn across host,
    container-exec, and fresh-container paths.
15. Source path MAY be Effect-resolved (for vendored-fetch round trips); such paths participate in
    the same cache-key derivation but do not auto-attach to the file watcher.

## Edge cases and known failure modes

The publish error is a single tagged error with a closed phase set:

- **hash** — filesystem read of the source tree failed (permissions, bad symlink, disk).
- **scrub** — vendored-lock scrub failed.
- **build** — Move compiler exit, parse failure, or container/network failure. Cause-chain carries
  verbatim stdout/stderr.
- **publish-tx** — sign-and-execute failed: insufficient gas, bytecode verification failure, RPC
  connection failure.
- **parse** — no `'published'` change in the receipt (implies SDK drift), or the post-publish
  fullnode ready-probe timed out (stuck indexer).
- (a `register-coins` phase is reserved but currently never thrown.)

Non-fatal degradations:

- Coin metadata RPC flake → coin entries degrade with placeholder symbol/decimals; next cycle picks
  them up.
- Faucet not in scope → mint-strategy registration is a silent no-op; downstream funding requests
  for affected coins surface a clean "no strategy registered" error.
- Concurrent `sui move build` invocations serialize at the `~/.move` advisory lock instead of racing
  the git index.
- Verify probe transient failure → over-derive on next cycle.
- State-store tampering (writing a stale `packageId` for an unrelated chain) → verify probe fails →
  re-publish.

Other observed issues:

- Symlink-cycle inside the source tree would loop the walker indefinitely (no depth limit / cycle
  detection).
- The MVR validator's `[a-z0-9-]+` restriction is load-bearing — any default that introduces
  underscores breaks dapp-kit consumers.

## Learnings from current implementation

- **Generalize the publish substrate.** The current implementation factored
  `inputs → verify → produce → register` into a reusable substrate covering all on-chain artifacts.
  That generalization is load-bearing: coin mints, Walrus deploys, Deepbook pools, Seal key servers
  all reuse it. The redesign should keep this as a first-class primitive.
- **Don't let the build mutate the cache-key inputs.** `sui move build` rewrites `Move.lock`.
  Normalize the lockfile before hashing.
- **Wait for index visibility, not just tx commit.** This is surprising the first time; downstream
  `tx` failures with "dependent package not found" trace back to firing too soon.
- **Lenient verify is cheaper than aggressive eviction.** Transient RPC failures during verify are
  common; over-deriving once is cheaper than wiping the cache and rebuilding for no reason.
- **Register on every cycle.** In-memory registries cannot be populated only on cache miss;
  downstream consumers cannot tell whether their tag was rebuilt or reused.
- **Coin auto-discovery is high-value UX.** Walking the receipt for cap+metadata pairs lets the user
  omit any coin declaration; this is materially easier than spelling coins out.
- **Type-distinguish local vs known packages.** A single Package type that conflates the two leaks
  at compose time inside the bindings emitter, which needs the source path. The split surfaces the
  constraint at the type level.
- **Source-path Effects let other components round-trip through publish.** Vendored-fetch flows
  (e.g. Seal's reference key-server) shouldn't duplicate the publish pipeline; an Effect-form path
  lets them route through the same primitive.
- **Module-level globals for compose-time information flow are a smell.** The seed-object
  accumulator works but fights the everything-is-an-Effect architecture; a scoped reference would
  remove the user-visible "declare KnownPackage before Sui()" ordering constraint.
- **PackageWithCapture-as-separate-factory is over-segmentation.** The capture option is
  structurally a small add-on; gating it behind a separate factory at `/advanced` doesn't add
  safety, only friction.
- **`PublishError.sourcePath` is declared but inconsistently populated.** Several throw sites don't
  pass it; pretty-error rendering loses context.
- **Whole-stack restart on `.move` edit is too coarse.** Selective per-primitive teardown is a known
  follow-up; the publish primitive already declares its watch root.
- **Coin discovery and metadata enrichment don't belong inside the publish module.** They are pure
  projections over the receipt and belong in a coin module.
- **Triple bookkeeping (TS interface + Schema mirror + structural guard) for the LocalPackage shape
  is fragile.** One declaration with derived types/schemas is more maintainable.
- **`Coin` type and tag living in the package module fights discoverability.** Users look for it
  under coin.
- **A dead `register-coins` phase enum and a dead state-store key builder both lingered.** Closed
  sets should be tested against callers, not just shape.

## Cross-component references

- **engine-core / engine-resources** (01, 02): provides the `onChainArtifact`, `withCache`, `tag`,
  `provide`, registry, state store, content-hash, and chain-probe primitives that Package builds on.
- **runtime-docker / sui** (04, 05): provides the build dispatch context (build image, long-lived
  build container) and the chain handle. Sui's fork mode consumes Package's seed-object accumulator.
- **walrus / seal / deepbook / pyth** (06–09): each defines its own on-chain artifacts that follow
  the same publish pattern (cache key, verify, register), and several declare KnownPackages with
  seed-object lists for fork mode.
- **faucet** (11): consumes Package's auto-registered treasury-cap mint strategies.
- **account** (12): Package's signer comes from an Account; the upstream link orders the scheduler.
- **coin** (13): the user-facing `Coin('SYMBOL')` factory resolves against the CoinRegistry entries
  Package writes; coin auto-discovery and metadata enrichment logically belong to coin, not package.
- **action** (16): an Action declaring `needs: [pkg]` consumes the resolved Package handle and is
  ordered after publish.
- **snapshot** (17): persisted Package cache entries survive snapshot save/restore; the chain
  containers are tarred separately and on restore the verify probe re-confirms.
- **codegen** (19): consumes local Package source paths to emit bindings; respects the per-package
  codegen-exclude flag; uses MVR placeholders so emitted code stays portable.

## Open questions / decisions deferred

- Should `KnownPackage` accept a literal `captured` record (the user knows the on-chain ids — admin
  cap, registry id — without a publish receipt)?
- What is the contract for a capture-spec change between boots when source and signer are unchanged?
  Today the cache holds the old captured record; should the capture function identity be folded into
  the cache key?
- Should the per-package codegen emitter override be supported (the current option shape allows it
  but only the boolean exclusion is wired)?
- Is there a meaningful "test-only / no-chain" path for the publish flow, or do tests always need a
  real or simulated Sui in scope?
- Should the seed-object accumulator move from a module-level global to a compose-scoped reference?
- How should `devnet` be treated in the known-network type — keep as future-proofing or remove until
  a canonical deployment exists?
- Does the source-tree walker need symlink-cycle protection and a depth limit?
- Should hot-restart on source edit become selective (republish only the affected package +
  downstream) rather than whole-stack?

## Opportunities noticed

- Delete the dead `StateStoreKeys.publishMove` builder and its test — it disagrees with the actual
  key shape and has no production callers.
- Remove the unused `register-coins` phase from the closed phase enum.
- Merge the with-capture factory back into the main factory; the capture option is structurally
  minor.
- Lift coin discovery + metadata enrichment out of the publish module into the coin module (one
  place to look for coin logic).
- Replace the triple LocalPackage declaration (TS interface + Schema mirror + structural guard) with
  one source of truth.
- Move the `Coin` type and tag from the package module to the coin module (re-export from package
  only if a cycle requires it).
- Replace the module-level seed-object accumulator with a scoped reference set into the compose;
  removes the user-visible "declare KnownPackages before Sui()" ordering rule.
- Split the register step into "cheap dict writes (every cycle)" and "faucet mint-strategy
  registration (after fresh publish only)" so the cache-hit path stays cheap.
- Add a smoke test for KnownPackage's registry write path (currently covered only indirectly).
- Make every publish-error throw site pass through `sourcePath` so pretty-error rendering has full
  context.
- Lift `mvrSlugify` (and any future slugify needs) into a shared util with direct tests; it encodes
  a project-wide convention.
- Add symlink-cycle protection and an explicit depth limit to the source-tree walk.
- Make the user-facing requirement that `Sui()` must be composed before any Package explicit (today
  it is buried in substrate comments).
- Consider routing `pkg.coins` as a registry slice-by-package-name view rather than
  double-bookkeeping coin records on both the resolved Package value and the CoinRegistry.
