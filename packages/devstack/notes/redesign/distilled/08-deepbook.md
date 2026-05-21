# 08 Deepbook (distilled)

## Purpose

Deepbook is devstack's facade over the Mysten Labs DeepBook v3 protocol — an on-chain central-limit
order book that lives entirely as a set of Move packages plus two sidecar Rust containers (an
indexer and a REST server). Unlike Sui, Walrus, or Seal, DeepBook is not a network primitive; it is
a _compound_ surface that must publish multiple Move packages, create whitelisted trading pools,
optionally publish a margin/liquidation extension, optionally run two long-lived Postgres-backed
sidecars, optionally mint test tokens, and optionally run a long-lived market-maker fiber that keeps
the books non-empty.

The service is responsible for making the entire `pnpm dev → snapshot → wipe → restore` loop
idempotent across this fan-out: on-chain identities (package ids, pool ids, registry ids, cap ids,
balance-manager ids, margin-pool ids, supplier-cap ids) must survive resume; REST and indexer
endpoints must come back at the same URLs; and the market-maker's grid must continue posting where
it left off. It is the most demanding composite primitive in the codebase — multi-dependency,
multi-publish, multi-cache, multi-container, multi-state-registry. Whatever pattern absorbs Deepbook
generalises to every other composite.

## Modes

### localnet (local-deploy)

- Vendors (or accepts a path to) the DeepBook Move source, publishes the protocol package, creates
  whitelisted trading pools, optionally publishes the margin + liquidation packages, optionally
  seeds margin liquidity, optionally runs the indexer + server sidecars against the local Postgres,
  optionally runs a market-maker fiber.
- The full stack: all four state registries are populated, all four cache namespaces are live, and
  snapshot/restore must round-trip every on-chain id plus all Postgres rows the indexer produced.
- What's hard: every publish + create-pools step must be idempotent on resume, because
  `pool::create_pool_admin` aborts if `(base, quote)` is already registered. The market-maker must
  be resilient to stale balance-manager state from previous boots. The indexer's checkpoint cursor
  must survive container restarts without losing in-memory event buffers.

### testnet / mainnet (known-package, live)

- Resolves canonical package id, registry id, treasury cap id, margin package ids etc. from an
  inlined `knownDeployments.deepbook[network]` table. No publish, no tx, no create-pools. Caller
  enumerates pool entries; the registry's pool table is not consumed automatically.
- Indexer + server CAN theoretically be wired against a live chain, but the indexer/server image
  versions are pinned to a specific Move source version and may not match the live deployment's
  events.
- What's hard: ids must be lookup-able synchronously at factory time (failure is a factory-time
  throw, not a runtime error). Only the read-side core capability is provided — no admin capability,
  no market-maker capability.

### \*-fork (known-package, against forked upstream)

- `*-fork` network names collapse to the wrapped upstream's `knownDeployments` snapshot; the fork
  sui-binary serves the upstream's real on-chain DeepBook state.
- What's hard: the indexer's checkpoint volume is not yet wired against sui-fork, so the indexer is
  functionally inert on forks today.

### Sub-component dimensions (additive on any network mode)

Each is independently present or absent:

- Core (publish + pools, OR known-package lookup) — always present when Deepbook is in the stack.
- Indexer (Rust sidecar). Requires Postgres.
- Server (Rust sidecar). Requires Postgres. Reads from the same database the indexer writes to.
- Margin extension (publishes two more Move packages, registers `MarginPool<T>` per asset). Requires
  Pyth, type-enforced.
- Margin-seed (mints supplier cap, supplies liquidity). Requires margin.
- Market-maker (long-lived Effect fiber, grid-style maker). Requires only core.
- Vendor (clones DeepBook source repos). Pure prerequisite for local-deploy publish.
- Mint sugar (`DEEP` / `USDC` mint actions). Pure helpers.

## Responsibilities

- Dispatch on resolved network to local-deploy vs known-package branches.
- Vendor the upstream Move source (two git repos, six packages, patched `Move.toml` files) when
  local-deploy is in use without an explicit path.
- Publish the protocol package; capture registry id, admin cap id, and DEEP treasury cap id from
  object changes; create whitelisted trading pools; cache every result with a verify probe that
  re-validates against the chain.
- Provide three read/write capability tags (a core read-side view, an admin capability that today is
  an empty placeholder for forward-compat, and a market-maker capability that mints and lazily
  provides a balance manager).
- Publish the margin + liquidation packages; mint the maintainer cap; create one `MarginPool<T>` per
  configured asset (validating each against a configured Pyth feed); register every core pool
  against the margin registry. Each step verify-probed and cached.
- Seed margin pools by minting a supplier cap and supplying caller-specified amounts per asset.
- Run the indexer sidecar joined to the Postgres network, with arch-specific image selection, and
  publish its metrics URL into its own state registry.
- Run the server sidecar with the same arch-specific images, two router entrypoints (REST +
  metrics), and the appropriate Linux/Desktop dance for `host.docker.internal:9000` Sui RPC
  resolution.
- Run a market-maker fiber that pre-loads cached balance managers, executes a startup-gate first
  tick synchronously, then forks `Effect.repeat(Schedule.spaced)` into scope. Recover from
  balance-too-low aborts by recreating balance managers. Split cancel and place into separate
  transactions per tick.
- Surface all four sub-component state shapes into the runtime manifest as one nested object
  (`services.deepbook`).
- Provide codegen input: the manifest is consumed by a codegen emitter that produces a
  deepbook-config module the SDK plugin consumes.

## Composite-primitive characteristics

Deepbook is the canonical multi-dependency composite. Two structural patterns dominate:

### Four state registries cohere as one logical service

Four logically independent on-chain artifacts each have their own state shape: the core protocol
package and pools; the indexer sidecar; the server sidecar; the margin extension. Each can be
present or absent independently in any stack, so they cannot be folded into a single record at the
registry layer without losing optionality. The runtime manifest projection reads all four and
composes them into one nested object only when each piece is present.

This means the engine's "one service → one registry projection" pattern does not fit Deepbook. The
pattern that does fit is a multi-registry projection or a single registry-of-records with optional
slots per sub-component. A future fifth registry (for example for the supplier cap) would compound
the awkwardness — this is the canary that motivates a multi-slot composite-state shape in the
redesign.

### Sugar factories layer optional capabilities on top of the core

The top-level facade is a single conceptual `Deepbook(...)` factory that returns the core
capability. Optional capabilities (indexer, server, margin, margin-seed, market-maker, vendor, mint
helpers) are exposed as sibling factories that each consume one or more upstream tags, run their own
publish/container/fiber lifecycles, and publish into their own state registries. The composite is
not a god-factory that takes 30 options — it is a co-operating family of factories that compose
through interface tags.

Two conceptual roles for sugar factories:

- _Capability-expanders_: indexer, server, margin add new sub-system state. Each owns a container or
  a publish, has its own ready criterion, its own snapshot footprint, its own failure mode.
- _Action sugar_: margin-seed, mint-DEEP, mint-USDC, market-maker (despite running a fiber) are
  caller-driven actions / runtime helpers that consume an upstream tag and either fire one tx (mint,
  seed) or maintain ongoing state (market-maker).

The kind classification of "service vs action" is currently inconsistent (the market-maker is
classified as action but is behaviorally a service); the redesign should let the runtime behaviour
drive the classification.

### Composites build inner tags at factory time

The local-deploy composite, the vendor composite, and the margin composite each construct one or
more inner sibling tags at factory time (`publishMove` siblings for local-deploy and margin; two
`gitFetch` siblings for vendor) and yield them via the topo scheduler as first-class graph nodes.
The user does not see these in the public stack array. The substrate auto-flattens upstream records
so the topo scheduler places composites strictly after their providers. This pattern recurs for
Walrus and Seal — the redesign should formalise inner-tag lifting as a first-class
composite-construction primitive rather than relying on ad-hoc `__extraMembers` lifting.

### Inner-tag lifting must survive snapshot/restore

Each inner tag has its own cache slot (the publishMove substrate's own cache; the `onChainArtifact`
cache for the composite that wraps it). On resume, both must hit cache and both must verify against
chain. A regression that makes one miss while the other hits silently re-publishes or re-creates
pools and aborts in Move. The verify-probe contract must be uniformly schema-validated (never
`as { objectType? }`-style raw SDK accessors) because raw access silently masked B1/B3/B5-class bugs
in the prior implementation.

### Multiple cache namespaces

Local-deploy uses one namespace for the pools cache. Margin uses a second for margin pools.
Margin-seed uses a third. The market-maker uses a fourth, directly (without going through the
on-chain-artifact substrate). None share a unifying prefix or tombstone mechanism. Adding a fifth
cache (for example the local-deploy `marketMakerLayer`'s up-front balance manager) is the obvious
next pressure. The redesign should let composites declare cache namespaces declaratively.

## Lifecycle states

### Pre-start (factory call)

Read network, mode-specific option records, vendor/path choice, pool specs, asset configs, margin
pool registrations, market-maker strategy, image overrides, version pins. Resolve network mode.
Dispatch. Validate factory-time invariants (mutual exclusions, non-empty/unique pool names, positive
tick/lot/min, duplicate-label rejection, non-positive seed amounts). Type-enforce Pyth-margin
coupling at the language level.

### Vendor (optional, parallel with sui boot)

Two `gitFetch` siblings clone the DeepBook + sandbox repos. The composite waits on both,
materialises six package directories, patches each `Move.toml` to rewrite git deps to local sibling
paths. Result is a filesystem tree the publish step consumes.

### Publish (local-deploy only)

`publishMove` runs the protocol package; capture registry id, admin cap id, and (best-effort) DEEP
treasury cap id from object changes via Move-type-suffix matching. PublishMove caches the receipt.
The composite then verifies cached pool object types against chain via the schema-validated
chain-probe accessor. On verify miss, runs a batched setup transaction: one
`init_balance_manager_map` plus N `create_pool_admin` calls. On verify hit, skip the tx entirely.
Register results into the package registry and the core state registry.

### Margin publish + setup (optional)

Publish two more Move packages (margin + liquidation), mint the maintainer cap, create the margin
registry's `PythConfig` via the well-known `0x2::coin_registry` shared object, create one
`MarginPool<T>` per asset, then per pool call `register_deepbook_pool` + `enable_deepbook_pool`.
Each `MarginPool<T>` verify-probed by object-type matching the parametric type prefix. Cached.

### Margin-seed (optional)

Mint supplier cap, call supply per asset, transfer cap to signer. Verify probes the supplier cap by
existence + object-type suffix.

### Sidecar containers (optional, depend on Postgres)

Each sidecar joins the Postgres docker network so it can dial via the network alias without a host
port mapping. Indexer reads checkpoints, writes events to Postgres. Server reads from the same
Postgres database the indexer writes to, plus reads chain RPC via `host.docker.internal:9000` (with
explicit `--add-host` flag on Linux). Two router entrypoints for the server (REST + metrics), one
for the indexer (metrics). The server takes a CLI arg for the database-statement timeout.

### Market-maker (optional)

Yield each pool's coin tags up-front. Pre-load cached balance managers from state-store. Run the
first tick synchronously inside the producer body as a startup gate so misconfigured stacks fail
loudly rather than silently looping. Then fork an `Effect.repeat(Schedule.spaced)` fiber into the
surrounding scope.

### Ready criteria

- Core local-deploy / known-package: ready when the composite's effect resolves (cache hit or
  successful publish + create-pools).
- Margin: ready when the batched setup tx returns and all expected margin-pool ids are present in
  object changes.
- Margin-seed: ready when supply tx returns and supplier cap is captured.
- Indexer / server: container ready per the docker runtime's ready probe (the explicit probe
  configuration is currently implicit — an open question).
- Market-maker: ready after the first synchronous tick completes.

### Steady state

Indexer ingests checkpoints, writes to Postgres. Server serves REST + metrics from Postgres.
Market-maker ticks on schedule, cancelling and replacing orders. Cache entries are immutable until
invalidated by failed verify.

### Resume (warm restart)

Every cache entry is verify-probed against chain. Trusted entries skip their produce bodies. Stale
entries are invalidated and rebuilt. Indexer re-derives its checkpoint cursor from Postgres
bookkeeping tables — its writable layer is intentionally stateless. Server is stateless against its
writable layer. Market-maker on resume cancels stale orders best-effort (cancel may abort with
balance-too-low; the split-cancel-place tx structure ensures the place still proceeds). On a
subsequent place-tx abort with the same code, balance managers are dropped from cache, recreated
with pre-deposits, and place is retried.

### Teardown

Containers torn down with the surrounding scope. Market-maker fiber interrupted with the scope. No
grace-period coordination — the maker may submit one final tx mid-shutdown if a tick fires as the
scope closes; tx errors during teardown are caught as warnings.

## Inputs / dependencies

### Sui

Provides the RPC client, the chain id (folded into every cache key), and the schema-validated chain
probe used by every verify pipeline. Sidecars hold the Sui ref purely for layer-build ordering today
(the server actually reads RPC via `host.docker.internal:9000`, the indexer expects future
checkpoint-volume wiring against sui-fork).

### Postgres

The indexer joins Postgres's container network and writes events to a logical database named
`deepbook` by default. The server joins the same network and reads from the same database. Both must
reference the same database name (no runtime guard exists — convention only).

### Pyth

Margin extension consumes Pyth non-optionally and type-enforces the coupling at the language layer
(a margin config that omits Pyth fails `tsc --noEmit`). Used to validate each asset's feed is known
and to construct the on-chain `PythConfig` Move object that the margin registry consumes for
liquidation pricing.

### Move source images

The indexer and server share a single Move-source-version-keyed image pair table, arch-keyed (amd64
/ arm64). Pinned to the same Move version that the local-deploy publishes. Mismatching the image
version with the deployed Move version silently corrupts indexed data — this pairing is the most
consequential invariant in the sidecar surface.

### Fork upstream

On `*-fork` networks, the wrapped upstream's `knownDeployments` snapshot supplies all ids. The fork
sui-binary serves the upstream's real DeepBook state. The indexer's checkpoint volume against
sui-fork is not yet wired.

### External resources

GitHub HTTPS for vendor (two repos). Docker registry for sidecar images (two images per version, two
arches). Host filesystem for the vendor tree (under devstack's state directory). Local sui-localnet
RPC via `host.docker.internal:9000` for the server.

## Outputs / capabilities provided

### Capability tags

- Core read-side view: package id, registry id, captured ids, pool lookup table, SDK-shape
  `packageIds` projection that consumer code can spread into the SDK plugin.
- Admin capability: empty contract placeholder. The point is the typecheck-axis split —
  known-package consumers must not be able to type-depend on admin operations the layer cannot
  provide.
- Market-maker interface tag: a lazily-minted balance manager and a per-pool tick action.
- Indexer state tag, server state tag, margin state tag.

### State registry records

Four logically independent records: core protocol state (package id, registry id, pool table),
indexer state (metrics URL, database URL, network alias), server state (REST URL, metrics URL,
database URL, network alias), margin state (package + liquidation package ids, registry id,
maintainer cap id, margin pools, registered pool list).

### Package registry entries

Multiple entries: the core publish, its sugar wrapper, the margin publish, the liquidation publish.
Each carries the captured shape consumers need.

### Manifest output

`services.deepbook` as a single nested object combining whichever of the four registries are present
in the stack.

### Codegen input

The manifest is consumed by a codegen emitter that produces a deepbook-config module. The emitter
reaches into both `services.deepbook.packageId` and `packages.deepbook.captured.deepTreasuryId` —
the duplication is a known footgun.

### Endpoints

Indexer and server metrics + REST URLs are deliberately NOT published into the flat endpoint
registry; they are surfaced only through the per-service state registries and the projected
manifest. This was a deliberate Wave-2 dual-write fix.

### Router entrypoints

Three traefik entrypoints registered at module load: indexer-metrics, server-REST, server-metrics.
The metrics port choice avoided a collision with Walrus's port.

### Cache namespaces

Four state-store namespaces, plus implicit publishMove-substrate cache slots for each publish.

## Invariants and constraints

- The pool-create step must be idempotent on resume. Without cache + verify,
  `pool::create_pool_admin` aborts in `registry::register_pool` because `(base, quote)` was already
  registered. This is the headline invariant — every other resume failure mode is a variant of it.
- Every verify probe must route through the typed schema-validated chain-probe accessor. Raw SDK
  property access silently returns undefined for renamed fields, and every cache entry was falsely
  invalidated on every resume before this was tightened.
- Image selection must be arch-aware (amd64 vs arm64). The Rust sidecars are not cross-compiled in
  the published registry.
- The market-maker per-tick transaction must be split: cancel and place are two distinct
  transactions. A cancel abort on resume must not kill the place. A place abort with the
  balance-too-low code must trigger balance-manager recreation, not a generic retry.
- A cached balance manager id is trusted only if the chain probe returns both existence and
  owner-matches-signer.
- The indexer and server must reference the same Postgres logical database name. No runtime guard
  exists; convention is the only defence.
- The indexer + server image versions must match the deployed Move source version. Mismatches
  silently corrupt indexed data.
- Router entrypoints must be registered at module load. A registration miss surfaces as a typed
  port-allocation error.
- Sidecars must join the Postgres docker network. Otherwise they cannot dial via the network alias.
- On Linux, the server requires `--add-host host.docker.internal:host-gateway` to dial the host Sui
  RPC.
- Pyth + margin coupling must be type-enforced at the language layer (compile-time, not runtime).
- Margin uses the well-known coin registry shared object (id `0xc`); this is stable across networks.
- The cache key hash algorithm must be stable across releases; tests mirror it and assert equality.
- DEEP treasury cap capture is best-effort (a heuristic match on object-type prefix + suffix around
  the publish-time-unknown package id). Consumers that depend on DEEP minting must check for the
  empty-string fallback.

## Edge cases and known failure modes

- Local-deploy called with neither `movePackagePath` nor `vendor`: typed error from inputs body.
- Both supplied: factory-time throw.
- Pool spec validation (empty name, duplicate name, non-positive tick/lot/min, min < lot):
  factory-time throw.
- Publish receipt missing the expected captured ids: typed publish-phase error.
- Create-pools tx fails (gas, abort): typed create-pools-phase error.
- Pool missing from object changes after a successful tx: typed error with expected type in message.
- Cache hit but pool object missing on chain: verify returns miss, substrate invalidates the entry,
  produce re-runs.
- Known-package unable to resolve ids: factory-time throw.
- Router entrypoint missing for indexer/server: typed port-alloc error per sidecar.
- Sidecar container fails to start: typed container-phase error wrapping the docker error.
- Sidecar ready probe fails: same shape.
- Margin asset's Pyth feed unknown: typed margin-setup error with both asset label and feed id.
- Margin's referenced DeepBook pool not declared: typed margin-setup error.
- Margin's referenced pool object can't be fetched: typed margin-setup error.
- Pool type doesn't match expected regex: typed margin-setup error.
- Margin batched setup tx fails: typed margin-pools-phase error.
- Margin pool missing from object changes: typed error.
- Margin-seed dup labels / non-positive amounts: factory-time throws.
- Margin-seed referenced pool not in margin: typed margin-seed-phase error.
- Market-maker empty pools: startup gate fails with typed error.
- Market-maker unknown pool ref in spec: typed error from the pool-lookup closure.
- Market-maker initial tick fails (any cause): typed startup-gate error surfaces as supervisor
  abort.
- Market-maker steady-state tick failure: logged warning, loop continues, next tick retries.
- Market-maker cancel aborts on resume (balance-too-low): logged warning, place tx still attempted.
- Market-maker place aborts on resume (balance-too-low after cancel succeeded): balance managers
  dropped from cache, recreated with pre-deposits, place retried with fresh managers.
- Vendor source dir not found post-clone: typed deepbook-phase error.

## Learnings from current implementation

- Composite primitives need the topo scheduler to see inner tags as first-class. The
  `__extraMembers` lifting pattern was the workaround; a formal inner-tag lifting primitive should
  be designed in.
- The verify probe contract is load-bearing: every cache hit depends on the chain probe returning a
  schema-validated shape with a stable field. Past raw-cast access silently returned undefined and
  broke every resume; closing that hole structurally (rather than per call site) is the
  higher-leverage fix.
- The four-registry shape is not Deepbook's fault — it reflects the actual independence of the four
  on-chain artifacts. The right redesign is a multi-slot composite-state primitive at the engine,
  not collapsing the four into one at the service.
- Caches must declare a tombstone mechanism. Today a verify miss is indistinguishable from "no cache
  entry yet"; diagnostic readability suffers. A "tried, was stale" marker would help.
- The split-cancel-place tx structure is a generalisable pattern for any composite that has a
  "best-effort cleanup then real work" tick: cleanup must not be allowed to fail the real work.
- The startup-gate first-tick pattern (run once synchronously inside the producer body, then fork)
  is the right resilience knob for long-lived fibers — misconfigs surface at boot, not in a silent
  log line.
- The lazy capability mint (the local-deploy `marketMakerLayer`'s up-front balance manager)
  currently fires a tx every supervisor cycle whether the consumer uses it or not. A cached-id
  mirror is the obvious fix and demonstrates that "lazy mint" needs the same cache shape as "eager
  publish".
- Cross-cutting Sui dependency in sidecars purely for ordering (the `void sui` pattern) recurs and
  should be a first-class "depend for ordering only" declaration.
- The Sui RPC dial-from-container dance (`host.docker.internal:9000` + Linux host-gateway flag) is a
  magic constant that should be derived from the live Sui entrypoint config.
- The `Object.assign(fn, {seed: fn})` sugar (a function with an attached namespace) is awkward in
  TypeScript and confuses IDE navigation. A separate top-level export is clearer.
- The kind classification (service vs action) should reflect runtime behaviour (long-lived fiber vs
  one-shot tx), not setup-vs-runtime distinction.
- `findPool` closures inside the core capability are not testable in isolation; pulling them out as
  free functions with their own tests is a small but high-leverage cleanup.
- Test-fixture cache-key derivations are duplicated in multiple test files because the production
  cache-key algorithm is not exported as a test helper. A test-only export from the cache module
  avoids drift.
- The `local: Record<string, unknown>` pass-through on the top-level facade loses autocomplete and
  typecheck for the most common knob (`pools`). The pass-through is convenient but defeats the type
  system.

## Cross-component references

- **Sui**: chain id, RPC client, chain-probe accessor, sui-fork chain id propagation, future indexer
  checkpoint volume.
- **Postgres**: container network, database URL helper, logical database naming.
- **Pyth**: feed lookup, feed config consumption, type-enforced coupling with margin.
- **Account / signer**: every publish, every tx, every market-maker tick, every margin-seed call.
- **Package registry / publishMove substrate**: every publish flows through it; siblings register
  under named entries the codegen emitter reads.
- **`onChainArtifact` substrate**: local-deploy, margin, margin-seed all use it; centralises
  cache-key derivation, verify, produce, register.
- **Chain probe**: schema-validated SDK accessor; every verify pipeline routes through it.
- **Sui-helpers**: Move-type matching for object-changes-by-type extraction; well-known shared
  object ids; Move type suffix constants.
- **Docker container runtime**: both sidecars consume the run-container primitive.
- **Router**: three traefik entrypoints registered at module load.
- **`gitFetch`**: vendor consumes two siblings.
- **`publishMove`**: local-deploy and margin both use it (twice for margin: protocol + liquidation).
- **Codegen**: the deepbook-config emitter consumes the manifest; the emitter is itself owned by the
  codegen component, not by Deepbook.
- **Runtime / manifest**: the manifest projection function reads all four registries and folds them.
- **State store**: four cache namespaces.

## Open questions / decisions deferred

- What's the default ready criterion for the sidecar containers? The container-runtime call declares
  routing but no explicit ready probe. Affects snapshot/restore stability.
- What does `devstack wipe` do to the vendor tree and the gitFetch cache under the devstack state
  directory? Both survive a normal restart; behaviour under wipe is unclear.
- Is the `host.docker.internal:9000` Sui RPC address derived from the live Sui entrypoint or
  hardcoded? Today it is hardcoded; a non-default RPC port would silently break the server.
- Are the sidecar image versions correctly paired when running against testnet/mainnet? The default
  image pair points to a specific Move version; a chain-side package version that doesn't match
  would silently corrupt indexed data.
- Should the margin `vendor` flow be removed from the type until the publish path is wired through
  (it currently accepts the option but throws at runtime)?
- What does multi-instance look like? Both sidecar factories accept a `name` override, but the
  registries are array-shaped with last-wins-by-name semantics. Two indexers in one stack are an
  unspecified case.
- Should known-package's `pools` argument be derived automatically from the registry's snapshot, or
  stay caller-supplied? Today it's caller-supplied; the asymmetry with local-deploy is jarring.
- Should the four registries become one multi-slot composite-state record at the engine layer? The
  runtime projection's hand-folding currently signals "yes" but the timing is the redesign's call.
- Should the market-maker be lifted out of Deepbook entirely? It consumes the core capability tag
  like any other consumer; it doesn't structurally belong inside the Deepbook component.
- Should the publishMove cache for margin's protocol + liquidation publish be bundled under a single
  multi-package publish helper? They're independent siblings today.
- Should the codegen emitter read only from `services.deepbook` (not from
  `packages.deepbook.captured.deepTreasuryId`)? The dual-path read is a known footgun.

## Opportunities noticed

- A multi-slot composite-state primitive would let Deepbook (and Seal, Walrus) declare "I produce N
  optional sub-component records" without four hand-folded registries.
- A formal inner-tag lifting primitive would replace the `__extraMembers` pattern and make composite
  construction discoverable.
- A "depend on X for ordering only" declaration would eliminate the recurring `void sui` lines
  across sidecars.
- A cache-key constants module per service would replace the scatter of string-literal namespace
  prefixes (`deepbook/pools`, `deepbook/margin-pools`, etc.).
- A tombstone-on-verify-miss mechanism in the cache substrate would distinguish "haven't tried" from
  "tried, was stale".
- A shared `Move.toml` git-dep rewriter helper would let vendor (and any other package that vendors
  Move sources from git) consume one implementation.
- A lazy-cap mint pattern with cache (mirroring market-maker's per-pool BM cache) would eliminate
  the per-supervisor-cycle tx the local-deploy market-maker layer currently fires.
- The runtime kind classification should be driven by runtime behaviour (fiber vs one-shot), not by
  setup-vs-runtime distinction.
- Sharing publishMove cache derivation through a test-only export would let test fixtures stop
  re-deriving the hash algorithm.
- The top-level facade's pass-through option should be typed (a `Partial<Omit<...>>` would preserve
  autocomplete without breaking compat) rather than `Record<string, unknown>`.
- The `findPool` closure should be a free function with its own test.
- The `Object.assign(fn, {seed: fn})` sugar should be replaced with a separate top-level export for
  discoverability.
- A clearer distinction between "service" (long-lived fiber, container) and "action" (one-shot tx)
  classification axes; the market-maker is mis-classified today.
- The deepbook-config emitter's dual-source read (manifest + package registry) should collapse to a
  single canonical source.
- The Sui RPC `host.docker.internal:9000` magic constant should be derived from the live Sui
  entrypoint.
- The default predeposit multiplier (`100n`) is documented but the derivation ("~16 refresh ticks of
  the full grid") is opaque from the constant; a derivation comment helps future maintainers.
- The default db-statement timeout (`60_000`) reads as a generic Rust binary timeout but actually
  drives Postgres query timeouts; clearer naming + grouping with related sidecar constants would
  help.
- `vendorDeepbook` defaults to HTTPS git clone with no auth-token support; private mirrors / offline
  CI would benefit from an `auth:` option.
- The market-maker's state-key constant is exported as a "test-only" symbol via an internal-suffix
  name; a general convention for cache-key constants (grouped in a per-service cache-keys module)
  would be cleaner.
