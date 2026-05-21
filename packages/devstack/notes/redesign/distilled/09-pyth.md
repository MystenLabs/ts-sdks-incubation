# 09 Pyth (distilled)

## Purpose

Devstack's Pyth-Network price-feed integration. Pyth is the on-chain oracle that publishes off-chain
market prices into Sui Move `PriceInfoObject`s; downstream Move consumers (Deepbook's margin /
liquidation modules in particular) read those objects when valuing positions. Devstack does three
things depending on the active Sui network:

- **localnet**: publish a vendored Pyth Move package, materialise one `PriceInfoObject` per
  requested feed, optionally run a long-lived pusher that fetches prices from the public Pyth
  Benchmarks API and re-pushes them on a cadence so on-chain prices stay non-stale.
- **testnet / mainnet / `<network>-fork`**: project the canonical mainnet/testnet Pyth deployment
  from devstack's pinned snapshot of well-known state ids + per-coin `PriceInfoObject` ids. No
  publish, no pusher.
- **devnet / devnet-fork**: not supported — fail at construction.

The primary consumer is Deepbook-margin, which dereferences a per-asset price-info-object id when
constructing its Move-side oracle config.

## Responsibilities

- Resolve the current network and pick the right backend (local deploy, known-package projection, or
  hard error for devnet).
- On localnet: publish the Move package, create one `PriceInfoObject` per configured feed, persist
  their object ids, and refresh on-chain prices via a long-lived pusher so they don't go stale
  during a long dev session.
- On testnet/mainnet: surface the canonical Pyth's package id + state ids + per-feed object ids as a
  uniform read-side projection.
- Provide a registry entry so downstream services (Deepbook margin) and consumers (manifest
  projector, codegen) can resolve `PriceInfoObject` ids by feed id or human label.
- Provide a small in-process polled mid-price helper for makers that want a live `bigint` quote
  sourced from a `PriceInfoObject`.

## In-process-runtime characteristics

Pyth is the canonical example of a service that lives entirely inside the devstack supervisor
process — no container, no Docker image, no host binary, no port allocation, no readiness HTTP
probe. Everything is either a Sui transaction, a registry write, or a scoped fiber. This makes its
runtime contract qualitatively different from containerised services:

- **Lifecycle is supervisor-scoped, not process-scoped.** The pusher loop and the mid-price poller
  are scoped fibers; they're acquired when the supervisor cycle resolves them and interrupted when
  the supervisor scope closes. There is no PID, no graceful-shutdown signal handshake, no restart
  policy at the container level — the supervisor's fiber lifecycle IS the lifecycle.
- **No isolation boundary.** Failures inside Pyth raise into the supervisor's error channel
  directly. No log-streaming adapter, no exit-code translation, no container-died → restart loop. A
  panic in the pusher would surface as an Effect defect in the same process.
- **No port allocation.** Pyth doesn't bind any socket, so the port-allocator / port-file-lock
  subsystem is irrelevant. The redesign's "container service" abstraction should not be assumed to
  apply.
- **Outbound network only.** Pyth makes outbound HTTP to the Pyth Benchmarks API and outbound RPC to
  Sui. There is no inbound surface to expose.
- **Cache + verify on supervisor cycles, not container restarts.** The on-chain-artifact cache
  discipline (verify cached object id with a `getObject` probe) replaces what container services get
  from a healthcheck probe.
- **State is split between in-memory closures and the StateStore.** The published `Pyth` shape is
  JSON-roundtripped (cache value carries no closures); lookup methods are re-attached on every
  supervisor cycle. This is an in-process artifact: persistence has to encode-decode through the
  StateStore boundary even though no IPC is involved.
- **Snapshot / resume rides on StateStore + Sui chain db.** Pyth has no container volumes; what
  survives a snapshot is whatever lives under the StateStore root.
- **Teardown semantics are interrupt-immediate.** Scope close means in-flight benchmarks fetches and
  in-flight signed transactions are interrupted; there is no grace window, no in-flight-tx
  finalisation. Containerised services typically get SIGTERM + grace; in-process fibers do not.

The redesign should treat in-process services as a distinct _runtime_ alongside dockerised and
host-binary runtimes, not as a degenerate special case of a container.

## Lifecycle states

- **Configured** — factory called with stack-file opts. Synchronous validation runs at construction
  (feeds non-empty, mode-specific args).
- **Resolving** — supervisor scheduled the service; upstream tags (signer, Sui, vendor, package
  publish) being awaited.
- **Acquiring** — local-deploy is computing `inputs`, looking up the cache key, and either verifying
  a cached entry against chain or running `produce` (publish + create-feeds). Known-package is
  reading static deployment data.
- **Registering** — registry writes for `PackageRegistry` and `PythStateRegistry`, plus
  re-attachment of lookup methods on the cached shape. This runs on every supervisor cycle
  regardless of cache outcome.
- **Ready** — `PythTag` is provided; downstream consumers can resolve it. On localnet additionally
  implies a pusher boot-tick decision has completed if a pusher is composed.
- **Steady-state** — pusher and mid fibers loop on a spaced schedule; transient errors are logged
  and the loop continues.
- **Interrupted** — supervisor scope closing causes all fibers to be cancelled; no async cleanup
  required.
- **Failed** — synchronous construction error (bad config), acquisition error (missing inputs /
  publish fail / create-feeds fail), or boot pusher tick error (benchmarks fetch / tx fail before
  steady-state).

## Inputs / dependencies

- **Active network** — drives backend selection. Localnet → publish path. Testnet/mainnet/fork →
  projection path. Devnet → unsupported.
- **Signer account** — required for localnet publish + create-feeds tx, and for the pusher's update
  tx. The pusher's signer must be distinct from any market-maker signer to avoid gas-coin
  contention.
- **Sui chain probe + client** — for tx submission, on-chain verify probes, and object reads.
- **Vendor source or filesystem path** — vendored Pyth Move source; either a path or a vendor-tag
  handle. Mutually exclusive.
- **Move-publish sibling** — the on-chain-artifact publish primitive that handles the Move publish
  itself, including its own cache.
- **Per-feed specs** — feed hex id + human label + initial price seed for `create_price_feeds`.
- **Known-deployment snapshot** — pinned state ids and per-coin `PriceInfoObject` ids for
  testnet/mainnet.
- **StateStore + ChainProbe substrates** — used via the on-chain-artifact and cache primitives.
- **PackageRegistry + PythStateRegistry** — written to on every cycle.
- **Benchmarks API (outbound HTTP)** — pusher fetches updates from a public Pyth REST endpoint, or a
  caller-supplied fixture function for hermetic tests.
- **Manifest projector + codegen emitter** — consume `PythStateRegistry` to project Pyth state into
  the manifest and into the generated Deepbook config; not dependencies of Pyth's acquisition, but
  tightly coupled to Pyth's output shape.

## Outputs / capabilities provided

- **Read-side projection** — a uniform
  `{packageId, pythStateId?, wormholeStateId?, priceInfos[], findPriceInfo(feed), findPriceInfoByLabel(label)}`
  shape. Both backends produce the same shape; this is the contract Deepbook-margin codes against.
- **Registry entries** —
  - PackageRegistry entry (local-deploy only) with the published `packageId` plus captured
    Pyth/Wormhole state ids.
  - PythStateRegistry entry (both backends) carrying the package id, state ids, label→feedId map,
    and feedId→objectId map. The manifest projector and the Deepbook config codegen emitter both
    read this.
- **Cache entries (local-deploy only)** —
  - One package-scoped entry keyed by chain id + a content hash of the publish inputs.
  - One per-feed pusher entry keyed by chain id + content hash of publish + signer + feed + object
    id, carrying last-applied digest + timestamp + object id.
- **Pusher handle** — opaque service tag for composition; the actual fiber runs in the supervisor.
- **Mid-price polled value** — synchronous-readable `bigint` plus an Effect-readable variant for
  makers; supports cross-rate via a quote feed.

No container images, no host files outside the StateStore, no HTTP endpoints, no event-bus events,
no CLI commands.

## Invariants and constraints

- Configured feeds must be non-empty.
- Path source must be exactly one of: filesystem path OR vendor-tag handle (XOR; both empty fails at
  acquire, not construction).
- Devnet without an explicit local-deploy config is unsupported and fails at construction.
- Localnet without an explicit local-deploy config fails at construction.
- Pyth is typecheck-coupled to Deepbook-margin: margin's price-info lookup demands the projected
  shape. This is a hard cross-component invariant.
- Pusher signer must differ from any market-maker signer. Convention-enforced, not runtime-checked.
- Mid-price helper requires a caller-supplied initial value; no auto-poll fallback before the first
  tick.
- Verify probes must operate on stable identifiers (chain object ids and Move type strings), never
  reconstructed shapes.
- Per-feed cache key must fold the package id, signer address, feed id, and object id so chain
  regenesis, signer rotation, or object recreation invalidate cleanly.
- The pusher's per-tick semantic is one batched transaction across all fed feeds, not one tx per
  feed.
- The cached shape is data-only (no closures); lookup methods are re-attached on every cycle.
- Registry writes must run on every supervisor cycle, including cache hits, so consumers always see
  fresh registry entries.

## Edge cases and known failure modes

- Publish runs but doesn't initialize the state object — surfaces as a "state id not captured"
  failure.
- Create-feeds tx returns fewer `PriceInfoObject`s than feeds requested — encoding bug; surfaces as
  a typed feed-creation failure.
- Cached `PriceInfoObject` id no longer exists on chain (devnet wipe, chain regenesis) — verify
  returns empty, cache invalidates, produce re-runs.
- Pusher boot finds all per-feed caches valid → zero-tx no-op, ready immediately.
- Pusher boot finds any feed cache missing or unverifiable → fires the first update synchronously; a
  bad feed id or unreachable benchmarks API surfaces here as a startup failure rather than as silent
  ticking.
- Benchmarks API returns non-2xx or times out (hard 15s timeout per request) → boot fails fast;
  steady-state logs and retries.
- Pusher update for a feed with no `PriceInfoObject` known → warning + skip.
- Steady-state errors (fetch, sign, execute) are swallowed as warnings; the schedule keeps ticking.
  Per-feed cache is consulted at boot only, not per-tick.
- Known-package fallback to empty `packageId` when caller doesn't supply it and the snapshot doesn't
  carry one → silent footgun; downstream Move calls will fail.
- Known-package on devnet (no snapshot block) yields an empty feeds array silently; surfaces
  downstream as "no `PriceInfoObject`s to update" in the pusher or as a margin lookup miss.
- Snapshot/resume can race the cache: a restored Sui chain might lack the expected
  `PriceInfoObject`s. The verify probe is the safety net.

## Learnings from current implementation

- In-process services need a "cache + verify + register on every cycle" discipline that mirrors what
  containerised services get from healthchecks plus volume persistence — the substrate must cover
  both.
- Cached shapes carry no closures; re-attaching method-shaped lookups on every cycle is workable but
  reads as a workaround for not having closure-aware persistence. The redesign should make read-side
  projections first-class so the cache value can carry behaviour by construction.
- One-batched-tx-per-tick across N feeds doesn't fit a "one cache entry per primitive" substrate
  cleanly. The current code uses the cache primitive with a stubbed verify + a forced re-put after
  the batched tx. The redesign needs a substrate that natively supports "N cache entries written
  from one effectful action".
- Discriminated-union returns from the top-level factory (local-deploy vs known-package) defeat type
  narrowing downstream; consumers fall back to unsafe casts. Either both backends must produce
  structurally identical handles, or the factory must constrain via a single shape known at the type
  level.
- A long-running poller that exposes a synchronously-readable value (the mid helper) forces a sync
  escape hatch. This pattern recurs (TUI gauges, maker price reads, etc.) and deserves a first-class
  substrate for "scoped poller with synchronous read".
- `dependsOn` is implemented three different ways across local-deploy, pusher, and mid — there is no
  canonical pattern for "extra topo deps" yet.
- Tag-projection layers (a uniform consumer-facing tag projected from a per-name composite tag) are
  repeated boilerplate; the substrate should grow a helper.
- Many state-store key builders defined centrally don't match the actual on-disk keys used by the
  cache substrate. Single source of truth for namespace strings is missing.
- "First tick synchronous on cache miss, zero-tx on cache hit" is a useful UX pattern (fail fast at
  boot, no spurious chain writes on warm starts) and should be a substrate-level affordance, not
  per-service bespoke logic.
- The pusher's boot loop is sequential over feeds — fine for 3 feeds, wouldn't scale to many.
  Concurrency budget is a substrate concern.
- Two layers of Effect catch with overlapping semantics indicates the error-mapping discipline needs
  a clearer convention.

## Cross-component references

- **Sui** — chain client, signer, chain probe, chain id; the publish + create-feeds + update
  transactions all submit via Sui.
- **Deepbook (margin in particular)** — primary downstream consumer of the projected shape and
  per-feed price-info-object ids. Move-side codegen consumes the registry record.
- **Deepbook vendor** — provides the vendored Pyth Move source tree under the deepbook vendor
  checkout.
- **Move-publish primitive** — composed inside the local-deploy path to do the actual Move publish
  with its own cache discipline.
- **On-chain-artifact substrate** — provides cache key derivation, verify-then-produce pipeline, and
  atomic state-store IO; the local-deploy path is a canonical user.
- **Cache substrate** — the pusher's per-feed entries.
- **State store** — both substrates persist through it.
- **PackageRegistry + PythStateRegistry** — registry entries written every cycle.
- **Manifest projector + Deepbook config codegen emitter** — read PythStateRegistry to project
  on-disk artifacts.
- **Account signer abstraction** — both the publish signer and the (distinct) pusher signer are
  accounts produced by another component.
- **Errors + phases** — Pyth defines its own typed error with a closed set of phases (publish,
  create-feeds, pusher-fetch, pusher-update, generic) plus an optional feed scope.

## Open questions / decisions deferred

- Is the polled-mid helper still consumed by anything in tree? If not, drop it or relocate to an
  example-only helper.
- Should the known-deployment snapshot carry the canonical Pyth package id per network so the
  empty-string footgun goes away?
- Should the fixture-source path on the pusher be a stable public API or be marked test-only?
- Are the snapshotted per-coin `PriceInfoObject` ids subject to upstream rotation, and if so should
  the known-package path do a chain-verify probe?
- Should `Pyth()` expose a plugin-author override for custom package ids on testnet, or is "use the
  lower-level primitive directly" the right answer?
- What's the right substrate API for "one batched tx writes N cache entries" so the pusher doesn't
  have to use the single-entry cache primitive with a stubbed verify?
- What's the right substrate API for "tag-projection layer" so services don't manually concat layer
  arrays?
- How should the redesign model "in-process runtime" alongside "container runtime" — as orthogonal
  runtime kinds with shared lifecycle/ready/teardown contracts, or as different substrates entirely?
- Should pusher boot probe feeds in parallel, and what concurrency budget belongs at the substrate
  level?

## Opportunities noticed

- Dead per-feed pusher cache namespace constant exported but with no callers; same for stale central
  key-builder functions whose shapes diverge from what the cache substrate actually writes.
- Three different `dependsOn` implementations across the three Pyth primitives; unify into one
  helper.
- Feed-id constants duplicated between production and test fixtures.
- Historical-context comment block at the top of the pusher describing a now-completed migration
  could collapse to one line.
- Manual `__layers` array splicing in the local-deploy projection layer indicates a missing
  substrate helper for "compose with a tag projection".
- Empty-string `packageId` fallback on the known-package path should at minimum log a warning,
  probably error.
- Typed errors on the "publish didn't capture state id" path could carry structured payload
  (expected Move type, etc.) instead of a string blob.
- No hermetic unit test for the pusher despite its size — fixture-source path makes one feasible.
- Central namespace constants (e.g. `pyth/package`, `pyth/pusher`) should live in one place and be
  consumed from there.
- No metrics surface for pusher health (last-update delta per feed) even though the data is already
  in span annotations.
- The "first tick synchronous on cache miss, zero-tx on cache hit" UX pattern is reusable across
  other in-process services and deserves a substrate.
