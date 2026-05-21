# 13 Coin (distilled)

## Purpose

The Coin component is devstack's name-resolution + minting layer over user-published custom Move
coin types. It does NOT publish Move modules itself — coin Move packages are published by the
Package component, whose publish pipeline runs a coin auto-discovery pass over every publish receipt
and folds the results into an in-process CoinRegistry. Coin's own job is to be the
_registry-projection + name-resolution + generic-mint layer_ on top of that registry, plus a tiny
"well-known builtin" surface for SUI.

In practice users interact with Coin in four ways:

- Address a custom coin by its CoinMetadata symbol (e.g. `mUSDC`), letting the registry resolve it
  to a full on-chain type.
- Address a coin scoped to a specific publishing package by its witness / module-key / symbol — the
  unambiguous form, and the only form that forces a dependency edge on the publisher.
- Address a coin by its bare on-chain type string (`0xPKG::module::Witness`) — escape hatch for
  live-net / fork-inherited coins that no Package in this stack published.
- Address a builtin coin (SUI) by a fixed name, with no upstream.

On top of these read paths, Coin exposes a single generic minting action that wraps
`0x2::coin::mint_and_transfer<T>`, idempotent over `(chainId, treasuryCapId, recipient, amount)` via
the state-store. This mint primitive is the building block faucet's `treasuryCapMintStrategy` and
DeepBook's mint helpers reuse for "fund this account with N units of this custom coin."

## Responsibilities

- **Project the CoinRegistry into yieldable handles.** Lookup by symbol (case-insensitive against
  both symbol and name), by witness/module key (also case-insensitive), and by bare on-chain
  coin-type string, each returning a uniform coin-value shape suitable for downstream consumers
  (wallet UI, deepbook config, faucet, codegen).
- **Read CoinMetadata on demand from chain.** For the bare-coin-type branch (no registry entry
  exists), fetch CoinMetadata directly via the Sui RPC, with a bounded timeout and exactly one
  retry, and degrade gracefully when the RPC has no metadata (return a coin-value with `decimals: 0`
  and no symbol/displayName/iconUrl rather than failing).
- **Provide a builtin SUI handle.** A constant, no-upstream, no-RPC handle that always resolves to
  the canonical `0x2::sui::SUI` with `decimals: 9`. Used by every consumer that compares against the
  canonical SUI string.
- **Mint custom coins idempotently.** Wrap `0x2::coin::mint_and_transfer<T>` such that re-running
  the same logical mint inside the same stack lifecycle is a no-op: cache the digest + minted-coin
  id keyed by `(chainId, treasuryCapId, recipient, amount)`, and on cache hit re-verify the on-chain
  object still exists before returning the cached result.
- **Compose with Account and Package.**
  - The mint primitive consumes an Account signer (the signer must hold the cap) and a chain client.
  - The treasury-cap-id and the coin-type can EITHER be supplied as literal strings OR as a ref to a
    published Package plus a captured field name (or module + struct name). When the ref form is
    used, the mint primitive forces the dependency edge on the publishing Package and reads the
    resolved value at acquire time.
- **Surface clear errors when resolution can't proceed.** Distinguish "no record matches this
  symbol/witness" from "multiple distinct coin types match this symbol" — the former is a
  missing-publisher / wrong-name problem, the latter is a disambiguation problem solved by switching
  to the package-scoped form.
- **Stay mode-blind.** The Coin component does not branch on local / fork / live; behavior
  differences arise from what the registry contains (only this stack's publishes) and from what the
  underlying RPC supports.

## Lifecycle states

The Coin component itself has **no layer-side startup, no readiness signal, and no teardown
finalizers**. Every handle is constructed at composition time as a yieldable value; nothing runs
until a downstream consumer acquires the handle.

Per-handle lifecycle:

- **Symbol-keyed handle**: at acquire time, snapshot the in-memory CoinRegistry and resolve the
  symbol against it. Ready iff a unique match is found in the snapshot taken at acquire time. There
  is NO automatic dependency edge on the publishing package — the user is responsible for ordering
  the publisher upstream of the consumer (via composition order or an explicit `needs:`
  declaration). Every subsequent acquisition re-reads the snapshot.
- **Package-scoped handle**: at acquire time, force the publishing-package edge (yield the package
  handle), then read the coin entry off the resolved package value with case-insensitive precedence
  across literal key / witness / symbol. Ready iff the resolved package exposes the named coin.
- **Bare-coin-type handle**: at acquire time, force the Sui edge (yield the Sui handle), then call
  CoinMetadata RPC with a bounded timeout and one retry. Always ready — returns either the full coin
  value or a degraded one with `decimals: 0` and no metadata fields.
- **Builtin SUI handle**: synchronous constant; no acquire-time work; always ready.
- **Mint action**: at acquire time, sequentially yield any explicit `dependsOn` upstreams, then
  yield Sui, signer, state-store, and either the literal cap id / coin type or the package refs from
  which those are derived. Compute the idempotency cache key, attempt to short-circuit on cache hit
  (with a verify probe), and on miss build/sign/execute the move call, then write the cache entry
  best-effort. Surfaces a phase transition (`minting`) into the per-handle status surface.

The CoinRegistry itself is in-memory per supervisor cycle. A supervisor restart wipes it and the
publish-discovery pass repopulates it from scratch (the underlying Move-publish step has its own
cross-restart cache, so this is cheap). The mint-action cache survives restart via the disk-backed
state-store. The CoinMetadata fetch cache is process-lifetime — fresh chains naturally miss because
the cache is keyed by full coin type (which folds the package id).

## Inputs / dependencies

- **CoinRegistry** (engine-provided context service). Populated externally — the Coin component is a
  reader, never a writer.
- **Sui handle**. Provides the chain client (for CoinMetadata fetches and the mint verify probe),
  the chain id (folded into the mint cache key), and serves as the topological-dependency anchor
  that pins the registry-populating Package publishes upstream of the registry-reading Coin handles.
- **Account signer**. Consumed by the mint action; must hold the treasury cap on chain.
- **Published Package handle** (optional, depending on form). For the package-scoped read and for
  the ref-form of the mint action's cap-id and coin-type arguments. Forcing this dependency is how
  the user gets a deterministic edge ordering between publish and consume.
- **StateStore**. Consumed by the mint action's idempotency cache.
- **Publish receipts**. Indirect: the discovery projection runs over `objectChanges` from a publish
  transaction and is the sole producer of CoinRegistry entries. The discovery projection is a pure
  function; the Coin component owns its implementation but does not invoke it (the Package component
  does).
- **CoinMetadata RPC**. Indirect: the bare-coin-type branch and the publish-discovery pass both call
  `getCoinMetadata` against the Sui fullnode. Bounded timeout, one retry, degrade to "no metadata"
  on failure.

The Coin component has **no host-process resources**: no locks, no ports, no leases, no
file-watcher, no paths, no container images, no HTTP endpoints, no CLI commands, no event-bus
events.

## Outputs / capabilities provided

### CoinRegistry contents (the registry's value-shape)

Each registry entry represents one coin that was discovered in a publish receipt during this
supervisor cycle. The entry carries:

- The registry key (the discovered CoinMetadata symbol, falling back to the witness type name when
  no metadata is present).
- The full on-chain coin type string (`0xPKG::module::Witness`).
- A decimals value (from on-chain CoinMetadata when available; 0 when metadata is missing).
- An SDK-aligned projection (address / type / scalar) for consumers building SDK calls.
- Optional metadata fields: symbol, displayName, iconUrl.
- Optional on-chain id fields: treasury-cap id, metadata object id, publishing package id.

The registry is append-only within a cycle and discovery is deterministic-ordered (sorted by coin
type) so collisions resolve the same way across re-runs.

### Resolved coin-value shape (what every Coin handle yields)

A superset of the registry shape that:

- Always carries the full coin type, registry key/symbol, decimals, and SDK projection.
- Carries metadata fields when known (degraded to undefined for the bare-coin-type branch hitting a
  metadata-less RPC).
- Carries the treasury-cap id and metadata object id when known (set for in-stack publishes; unset
  for bare-coin-type / builtin SUI).

This is the contract the wallet UI, deepbook config emitter, codegen, and faucet strategies consume.

### Mint capability

A single primitive — the generic treasury-cap mint — that, given a signer holding the cap, a cap id
(or ref), a coin type (or ref), a recipient address, and an amount, executes
`0x2::coin::mint_and_transfer<T>` and returns the resulting tx digest plus the minted coin object
id. Idempotent over `(chainId, treasuryCapId, recipient, amount)` with on-chain verification of the
cached minted coin.

### State-store entries

A single keyspace, scoped under `coin/mint/`, keyed by
`(chainId, treasuryCapId, recipient, amount)`, storing the cached
`(digest, mintedCoinId, recipient, amount)` for the idempotency check. Survives process restart;
wiped on a `devstack wipe`. Becomes inert (cache-miss) on regenesis (new chainId).

### Manifest projection

CoinRegistry entries flow through `gatherManifest()` into `manifest.coins.<name>` and are written to
disk as part of the apply-time manifest. Downstream codegen projects this into a generated
`coins.ts` (typed `as const` map keyed by symbol) and into the DeepBook SDK-aligned `CoinMap`.

### Cross-component side effects (produced externally, but caused by coin discovery)

- Faucet automatically registers a `treasuryCapMintStrategy` for every discovered coin where the
  publisher still owns the cap. This is what makes per-account custom-coin funding declarative (e.g.
  requesting `0xpkg::usdc::USDC: 1_000_000n` on an Account just works).

### What Coin does NOT produce

- No HTTP endpoints, no event-bus events, no CLI commands, no routes, no container images, no
  volumes.
- No first-class `Coin({symbol, decimals, ...})` declaration factory — the way to "declare a new
  custom coin" is to put a Move module containing `coin::create_currency<W>(...)` into a published
  package and let auto-discovery do the rest. This is a deliberate design choice and should be
  preserved.

## Invariants and constraints

1. **Mint cache-hit must re-verify before returning.** A cache entry pointing at a vanished
   minted-coin object (chain wipe, manual deletion) must be invalidated and the mint re-run. The
   verify probe is load-bearing for correctness — without it, a cached digest could be used to claim
   a balance that no longer exists.
2. **Mint cache writes are best-effort.** A state-store IO defect after a successful on-chain mint
   must NOT roll back the mint. The acceptable cost is "next cycle re-mints"; the unacceptable
   outcome is "the chain executed but the engine pretends it didn't."
3. **Bare-coin-type detection must agree with what CoinMetadata RPC accepts.** A string is treated
   as a bare on-chain type iff it has the shape `0xHEX::module::Witness`. The detector and the RPC
   argument validator must accept the same set.
4. **Builtin SUI is protocol-defined.** SUI's coin type is always `0x2::sui::SUI` with
   `decimals: 9`; the builtin handle must never diverge from this. Every downstream consumer that
   branches on "is this SUI" assumes this.
5. **Symbol resolution is case-insensitive, but exact, and tolerates registry-double-registration.**
   A symbol that matches more than one registry entry but where all matches resolve to the same
   on-chain coin type is a single match (not an ambiguity). Two records can legitimately point at
   the same coin (the registry indexes by both symbol and name); a multi-key hit must NOT surface as
   ambiguous.
6. **Symbol resolution that matches DIFFERENT coin types IS ambiguous.** Two distinct coin types
   accidentally sharing a symbol must surface a structured ambiguity error directing the caller at
   the package-scoped form.
7. **Discovery is deterministic-ordered.** Coins discovered from a single publish receipt are sorted
   ascending by coin type. This is load-bearing for the package-level "symbol must be unique within
   a package" collision guard — the same coin must always win on collision across re-runs.
8. **Discovery refuses to guess.** A `TreasuryCap<A<B>>` with nested generics is not a recognized
   coin shape; discovery drops it rather than guessing the inner type.
9. **CoinMetadata RPC failures degrade, do not throw.** A timeout or RPC error after one retry
   returns "no metadata" (logged as a warning); the discovery pipeline and the bare-coin-type branch
   keep going. A flaky RPC blip must not fail the whole supervisor cycle.
10. **Minted-coin lookup matches on the full inner generic.** The mint flow finds its created
    `Coin<T>` in the tx's object changes by matching against `0x2::coin::Coin<{fullCoinType}>` — the
    inner generic carries the full coin type so the substring match is unambiguous.
11. **Symbol-path resolution must have a dependency anchor.** The CoinRegistry is a context service,
    not a topological-graph node, so the scheduler can't see the publisher→consumer edge. The
    symbol-keyed handle must declare an upstream dependency on the Sui handle (which is transitively
    upstream of every Package publish that populates the registry); the package-scoped handle
    declares the edge on the publishing package directly. The bare-coin-type and builtin handles
    don't need this because they don't read the registry.

## Edge cases and known failure modes

- **Symbol not in registry.** Surface a structured "not found" error listing the registered symbols
  and pointing at the three escape hatches: package-scoped form, bare-coin-type form, builtin form,
  plus a hint about composition / `needs:` ordering. Most common cause: the publishing Package isn't
  in the composition or runs downstream of the consumer.
- **Symbol matches multiple distinct coin types.** Surface a structured ambiguity error listing the
  candidate coin types and pointing at the package-scoped form.
- **Bare-coin-type against an unknown coin.** Degrade to a coin value with `decimals: 0` and no
  metadata fields; consumers see the degraded shape but no error path fires. (Open question: should
  this be an explicit error mode for callers who want strictness?)
- **Bare-coin-type against a slow / timing-out RPC.** Same degraded outcome after the bounded
  timeout + one retry.
- **Package-scoped witness not in the published package.** Surface a "not found" error listing the
  available keys on the resolved package.
- **Mint with a cap-ref whose captured field is missing.** Surface a clear error naming the missing
  field; user fixes the captured-field name or supplies a literal cap id.
- **Mint sign+execute failure.** Propagate the cause; typically chain-side (insufficient gas, cap
  not held by signer, etc.).
- **Mint succeeded on chain but the minted `Coin<T>` isn't in the tx's object changes.** Indicates a
  Move-source mismatch (a custom mint path that doesn't actually emit `Coin<T>`) or a chain bug.
  Surface as an error.
- **Mint cache hit but on-chain object vanished.** Remove cache entry, fall through to a fresh mint.
  Automatic.
- **Mint cache write fails after on-chain success.** Ignore the IO defect; the mint return is still
  produced and the next cycle re-mints.
- **Discovery: coin with only a TreasuryCap, no CoinMetadata.** Surface in the registry with
  metadata-id undefined and decimals=0; treasury-cap-id IS populated. Downstream wallet UI degrades;
  faucet still funds it (since the cap is owned).
- **Discovery: coin with only CoinMetadata, no cap.** Surface in the registry with treasury-cap-id
  undefined and `publisherOwnsCap: false`. Faucet skips it (no mint path); reads still work.
- **Discovery: two coins in one package sharing a CoinMetadata symbol.** Collision guard (in the
  publish path, not the Coin component) warns and keeps the first occurrence by deterministic sort.

## Learnings from current implementation

- **The "registry is populated externally; Coin only reads" split is correct.** Coin owning the
  discovery projection (pure function over object changes) but Package owning the actual
  `publishCoin(...)` call is the right separation: it keeps Coin mode-blind and chain-agnostic and
  avoids circular dependencies between Package and Coin.
- **Three lookup forms (symbol / package-scoped / bare-on-chain) earn their keep.** The same
  identifier might be `mUSDC` (symbol from the local stack), `MOCK_USDC` (witness in source), or
  `0x123::usdc::USDC` (the published type); users reach for all three in different scenarios
  (in-stack handle, package-output handle, live-net handle). Folding them into one factory family
  with a clear precedence is what makes this usable.
- **Idempotent mint via a state-store cache is what makes "fund this account with N custom-coins"
  declarative.** The faucet's per-account funding strategy reuses this primitive; without
  idempotency, repeated supervisor cycles would re-mint and inflate balances.
- **The verify-probe on cache hit is non-negotiable.** A devstack regenesis or a manual chain reset
  will leave stale cache entries pointing at non-existent coin objects; without the probe,
  downstream "I have a balance" claims become lies.
- **Best-effort cache writes after successful on-chain side effects.** This is the right tradeoff:
  the chain already executed; failing on the cache write would surface a confusing error and
  re-execute the side effect next cycle anyway.
- **Degrading metadata fetches (return "no metadata" instead of throwing).** Critical for both
  publish-discovery resilience and bare-coin-type lookups against new or experimental coins;
  throwing here would cascade into supervisor failures over a transient RPC hiccup.
- **The discovery function is pure.** It takes the publish receipt's object-changes plus the
  publisher address and returns deterministic-sorted discovered-coin records — no Effect, no RPC.
  This makes it cheap to unit-test against synthesized fixtures and means discovery is reproducible.
- **No `Coin({symbol, decimals, ...})` declaration factory.** Users declare coins by publishing Move
  modules, not by configuring devstack. This is the right shape: it forces the source of truth to be
  the Move source.
- **The mint primitive intentionally lives near Coin, not Package.** Mints are post-publish actions;
  they need a cap, a signer, a recipient, and an amount, but they don't need the publish machinery.
  Keeping them in Coin lets faucet and deepbook share one implementation without depending on
  Package internals.
- **`CoinMetadataLoader` as a context service is exported but currently has no production consumer**
  — both the publish-discovery path and the bare-coin-type path call the pure helper directly.
  Either the service shape gets wired in (so the cache actually warms across calls) or it gets
  dropped; the in-between state is dead weight.
- **State-store key duplication.** The mint flow builds its key inline rather than via the typed
  builder in the keys module; both forms agree by test, but the convention "new keys land in the
  keys module, never at the callsite" was sidestepped.
- **`PublishError` is overloaded for mint failures.** Mint failures currently surface as
  `PublishError` (with a `phase` field set to `'publish-tx'`), which conflates "the publish step
  failed" with "the post-publish mint step failed." Downstream `catchTag` callers can't distinguish
  the two.
- **`mintFromTreasury` isn't part of the public barrel** despite being a useful generic primitive —
  only one internal consumer imports it via relative path. Either promote it (and its
  options/result/ref types) consistently or hide them all consistently.
- **`isBareCoinType` is a loose heuristic.** It checks
  `startsWith('0x') && includes('::') && three-segment`, which doesn't enforce hex-only address
  slots. A shared regex (already present elsewhere for the discovery path) would tighten this.

## Cross-component references

- **Package**: the sole producer of CoinRegistry entries. Package's publish step runs the (pure)
  discovery projection over the publish receipt and registers each discovered coin. Package's
  resolved value also exposes per-package `coins.<key>` entries that the package-scoped Coin handle
  reads from. The package-scoped Coin handle is the ONLY form that auto-forces a dependency edge on
  the publishing Package.
- **Account**: provides the signer for the mint action. The signer must hold the treasury cap on
  chain.
- **Sui**: provides the chain client (CoinMetadata fetches, mint verify probe), the chain id (mint
  cache key), and is the topological anchor that pins the symbol-path Coin handles after the
  registry-populating Package publishes.
- **StateStore**: persists the mint idempotency cache
  (`coin/mint/<chainId>/<treasuryCapId>/<recipient>/<amount>`).
- **Faucet**: every discovered coin where the publisher still owns the cap auto-registers a
  `treasuryCapMintStrategy` (driven from the Package publish path, not from Coin itself). The
  strategy mirrors the mint primitive but without the state-store cache (faucet has its own
  funding-already-satisfied check).
- **DeepBook**: imports the mint primitive directly for its mint helpers (e.g. `DeepbookMintDEEP`,
  `DeepbookMintUSDC`).
- **Codegen**: projects `manifest.coins` into a generated typed `coins.ts` and into the DeepBook
  SDK-aligned `CoinMap`.
- **Wallet UI**: consumes the manifest's coin entries for display.

## Open questions / decisions deferred

- **Fork-mode inherited coins.** Should fork mode auto-register inherited mainnet/testnet coins into
  the CoinRegistry? Today it doesn't — only this stack's publishes populate the registry, and
  inherited coins are addressable only via the bare-coin-type form. The user's intuition is that
  "fork inherits coins"; the registry's intuition is "the registry holds this stack's publishes."
  The redesign should pick one and document it. A "scan fork upstream for known coins and
  pre-populate the registry" pass would be feasible but unbounded; a "fork seeds the registry from a
  curated `KnownCoin` list" might be the right middle ground.
- **Strict vs. degraded for bare-coin-type lookups against missing metadata.** Today the
  bare-coin-type branch silently degrades to `decimals: 0`; callers who need strictness have no
  opt-in. A `Coin('0x…::T', { strict: true })` variant (or a separate strict form) might be
  warranted.
- **Where does the mint primitive live in the new API?** Three options: (a) on the Coin handle
  itself (`coinHandle.mint(...)`), (b) as a top-level action that takes a coin handle, (c) as a
  faucet-only primitive with Coin staying read-only and Faucet owning the mint surface. Today it's
  mixed (a generic primitive in Coin, plus faucet's strategy, plus deepbook's direct import). The
  redesign should pick.
- **Per-mode CoinMetadata fetch timeout.** Today it's a hardcoded 5s — fine for localnet, tight for
  cold-start fork containers and slow live RPCs. Should this be mode-aware (e.g. 5s local / 15s
  fork+live) or user-configurable?
- **Whether to introduce a `CoinError` tagged union.** Today errors are split across
  `CoinNotFoundError`, `CoinAmbiguousError`, and `PublishError` (for mint failures). A single union
  would let callers handle all coin-related failures via one `catchTags` call, and would let mint
  failures stop masquerading as publish failures.
- **Whether to rename the devstack-internal `CoinRegistry`.** The name collides semantically with
  Sui's on-chain `0x2::coin_registry::CoinRegistry` system object (used by DeepBook margin). A name
  like `PublishedCoinRegistry` or `LocalCoinRegistry` would prevent confusion.
- **Whether `BUILTIN_COINS` should grow.** Today it's just SUI. If DEEP / WAL / other "always
  present in our test stacks" coins start getting hardcoded in multiple emitters, the builtin record
  is the natural home. The redesign should either close the door (SUI only, deliberately) or open it
  (a small curated list).
- **Snapshot interaction details.** The mint cache entries are in the state-store, which is included
  in snapshot bundles. On snapshot-restore against a different chainId they're inert (safe). The
  Coin component does nothing snapshot-specific itself, but the redesign should explicitly confirm
  the cache-becomes-inert outcome is fine.

## Opportunities noticed

- **Consolidate the mint-cache key into the typed state-store-keys module.** Today the key is built
  inline with a local prefix constant; a typed builder exists for the identical shape. Switching the
  callsite to the typed builder lets the test-only prefix export be deleted.
- **Decide the fate of `CoinMetadataLoader` (the context-service shape).** As is, its cache never
  warms because production consumers bypass it and use the pure helper directly. Either wire it into
  the runtime and have publish-discovery yield it, or drop the service shape entirely.
- **Promote the mint primitive consistently.** Either expose the mint function alongside its
  option/result/ref types in the public barrel, or keep all of them internal. The current mixed
  state is inconsistent.
- **Replace `PublishError`-for-mint-failures with a `CoinError` (or `MintError`) union.** Failed
  mints should not surface as publish errors.
- **Rename the devstack-internal `CoinRegistry`** to avoid the name collision with Sui's on-chain
  `CoinRegistry` system object.
- **Tighten `isBareCoinType`** to share the existing hex+segment regex used by the discovery path,
  so detection and parser agree on the exact accepted shape.
- **Document the package-scoped lookup precedence** (literal key > registry key > entry symbol >
  entry type) so users know which match wins when multiple matches exist.
- **Coverage: pin all manifest-coin fields end-to-end.** Today the integration test asserts only
  `symbol` and `decimals`; `displayName`, `iconUrl`, `treasuryCapId`, `metadataId`, `packageId`,
  `sdkCoin` are not asserted at the manifest layer.
- **Cleanup target**: the test-only state-store-key-prefix export and any other "test reaches into
  module internals" shims should be replaced by tests against the typed key builder.
