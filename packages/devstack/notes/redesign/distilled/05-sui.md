# 05 Sui Service (distilled)

## Purpose

The Sui service is devstack's facade over the Sui blockchain. It is the foundational primitive that
every other on-chain component (Account, Coin, Wallet, Package, Codegen, Faucet, and the fork
variants of Walrus/Seal/Deepbook) depends on. It must:

- Surface a single conceptual handle that resolves to a working gRPC client plus its derived
  endpoints (RPC, faucet where applicable, GraphQL where applicable).
- Surface a stable chain identifier that downstream cache primitives fold into their state-store
  keys, so on-chain artifacts auto-re-derive when the chain underneath them is wiped or
  re-genesised.
- Provide a "funds-transferable" readiness gate that is strictly stronger than the supervisor's
  socket-level "RPC up" gate.
- Expose a fork-mode admin surface (status, clock advancement, checkpoint advancement,
  empty-signature impersonation, auto-tick clock).
- Expose a schema-validated chain probe surface (read-only `getObject` / `getTransaction` with
  consistent lenient/strict variants) so verify pipelines don't silently drift on renamed SDK
  fields.
- Drive a Move-package build pipeline that targets either a host `sui` CLI binary or a per-stack
  long-lived in-container worker, scrubbing pinned-lockfile sections that would otherwise break
  cross-network builds.

This service is the _most entangled_ primitive in the codebase. It provisions docker networks,
postgres sidecars, sui-localnet validators, sui-fork containers, router entries, host file-locks,
on-disk meta gates, and image build pipelines, AND drives the Move build pipeline that other
primitives consume.

## Modes

The service folds three first-class modes behind one factory, plus one degenerate sub-mode of local.

### local (container)

- An in-stack Sui validator + faucet + GraphQL endpoint, plus a postgres indexer sidecar, all
  running in the supervised docker stack on a per-stack network.
- Used during normal dev loops when the developer wants fresh, fast, throwaway chain state with a
  working faucet.
- What's hard: the Sui validator binary's faucet sub-process blocks PID-1's SIGINT registration, so
  the container always exits 137 on teardown — the lifecycle must explicitly treat 137 as a clean
  exit to enable warm resume. The faucet's socket-level readiness does NOT imply
  funds-transferability — there is a window after RPC becomes responsive where actual gas transfers
  still fail. Three concurrent ready probes (RPC, faucet, GraphQL) must be coordinated with
  per-fetch and outer deadlines. The postgres indexer sidecar's default volume layout would exclude
  state from snapshot capture, so it must be relocated off the inherited VOLUME path.

### local (external RPC) — degenerate sub-mode

- Caller already has a Sui process running and supplies the RPC (and optionally faucet/GraphQL) URL.
- Used in CI, custom-runtime experiments, and "wrap my own sui localnet" scenarios.
- What's hard: the entire container + sidecar + build-container pipeline must be skipped cleanly. No
  image build, no docker network, no SuiBuildImage wired in — but downstream consumers must still
  get the same endpoint shape, the same chain id, and a working
  `waitForTransactionsReady`-equivalent when a faucet URL is supplied.

### live (testnet / mainnet / custom)

- Wraps a public or caller-provided Sui RPC. Testnet has a faucet; mainnet has none; custom may or
  may not.
- Used when the developer wants to develop against the real chain, OR run codegen / verify against
  published artifacts.
- What's hard: no ready probe is meaningful (the public chain is always up); chain-id fetch IS the
  only sentinel, and it must have a bounded timeout. Faucet-less networks (mainnet) need a "no-op"
  funds-ready gate so downstream callers don't have to branch.

### fork

- An in-stack sui-fork binary running against a captured snapshot of an upstream live network
  (mainnet / testnet / devnet), at a frozen checkpoint, advancing only via explicit admin RPCs.
- Used to develop against real on-chain state (real Walrus, real Seal, real Deepbook deployments,
  real published packages) without paying gas and without waiting on real consensus.
- What's hard:
  - The fork binary has a write-once seed-manifest contract; config drift between boots panics it
    with a non-actionable error. Devstack must mirror the gate at the supervisor layer with an
    actionable error BEFORE the binary starts.
  - Two fork processes against the same data dir silently trample each other's RocksDB; a
    cross-process file lock on the data dir is mandatory.
  - The SDK's auto-gas-budget path calls `simulate_transaction`, which the fork binary doesn't
    implement; impersonated tx flows must stamp a default gas budget.
  - The SDK exposes `client.core` methods (`getBalance`, `listBalances`, `getCoinInfo`) that the
    fork binary explicitly panics on; these surfaces must be intercepted at the
    language-property-access level and rejected synchronously before the wire call.
  - Cold start serially fetches upstream state via GraphQL, so readiness has a much longer deadline
    than local mode.
  - The fork's chain id IS the upstream's real chain id (wallet-standard validation and MVR think
    they're on the real chain).
  - Auto-tick clock advancement is a supervisor-side knob, not part of the seed-manifest contract;
    its failure policy must be log-and-continue, not propagate.
  - Seed objects from `KnownPackage` declarations elsewhere in the stack must be auto-merged into
    the fork's seed flags at acquire time.
  - Walrus / Seal / Deepbook "local cluster" variants are incompatible with fork mode and must raise
    a typed error at factory composition time.
  - The shared upstream cache directory (keyed by chain id) is NOT refcounted; GC is explicitly
    manual.

## Responsibilities

- Resolve mode from explicit option or environment, dispatching to the correct builder.
- Provision the network(s), sidecars, container, and routing for the chosen mode.
- Run mode-appropriate ready probes with bounded deadlines and surface diagnostic context on
  timeout.
- Resolve and cache the chain id, with a bounded timeout.
- Publish endpoints (both host-visible and in-network-DNS-visible shapes) and the chain-id record to
  the engine's registries.
- Build, cache (memoised), and expose a funds-transferable readiness gate that probes a real funding
  transaction against the live faucet.
- Wrap the SDK client with a synchronous guard for fork-mode-unsupported surfaces.
- Run the auto-tick clock fiber under the service's scope when fork-mode auto-tick is enabled.
- Provide an admin surface for fork operations (status, advance clock, advance checkpoint,
  impersonated execute).
- Provide a chain-probe service (schema-validated, lenient and strict variants) folded into every
  Sui service's layer ring.
- Provide a Move-build capability that works against either a host CLI or a per-stack in-container
  worker, choosing path based on availability and path-bind-mountability.
- Hold and release: the data-dir lock (fork), the move-build lock (build), and the per-stack docker
  network + container scopes (everything).
- Sweep stale git lockfiles in the host's Move dep cache as a self-healing step during
  build-container acquire.
- Strip pinned-environment sections from Move.lock files (both package-local and cached) before
  invoking `sui move build`.
- Stamp a default gas budget on impersonated transactions in fork mode.
- Accumulate seed objects declared by `KnownPackage` composition and union them into fork seed
  flags.

## Lifecycle states

### Pre-start (factory call)

Read all factory options (network, per-mode option records, image overrides, version pins, fork seed
config, auto-tick option, ready-timeout overrides). Resolve mode from explicit option or
`DEVSTACK_NETWORK` env. Dispatch to mode-specific builder. Default-fill all unset options. No I/O
yet.

### Image resolution

For container-bearing modes: build or pull the validator image, the postgres sidecar image (localnet
only), and/or the fork image. Caller-supplied `{pull}` images skip the build step. The build is
content-addressed and the image tag includes a content hash so caller overrides invalidate cleanly.

### SuiBuildImage provision

For modes that have an in-container Move build container (localnet container path, fork path), bind
the resolved image tag into a reference so the build container layer can dispatch into it. Skipped
when no in-stack image exists (external RPC, live).

### Network + sidecar acquisition

For localnet container / fork: create the per-stack docker network; for localnet additionally start
the postgres indexer sidecar and wait on `pg_isready`. For fork: acquire the data-dir file lock and
run the meta-consistency gate BEFORE starting the container.

### Container starting

Start the main validator container with mode-appropriate args, env, mounts, routing entries, and
exit-code expectations. Localnet's expected-exit set must include 137. For fork, env carries the
upstream pointer, checkpoint anchor, seed addresses, and seed objects.

### RPC healthy (mode-specific)

- localnet: all three of RPC / faucet / GraphQL probes succeed concurrently within one iteration,
  with per-fetch timeout and outer deadline; diagnostic tracker records which probe never succeeded.
- localnet external-rpc and live: chain-id fetch succeeds (single sentinel, bounded timeout).
- fork: `ForkingService.GetStatus` round-trip succeeds within the (longer) fork ready deadline.

### Chain id resolved

Fetch chain id from the now-responsive client with a bounded timeout. For fork, this is the
upstream's real chain id (not a fork-local digest).

### Ready (registries populated)

Publish endpoints (RPC + optional faucet + optional GraphQL + optional indexer DB) with both host
and container-DNS URLs. Publish chain-id state record under the network-keyed name. Memoise the
funds-transferable readiness gate.

### Fork sync / auto-tick (fork-only, conditional)

If fork-mode auto-tick is enabled, fork a scoped fiber that advances the clock on the configured
cadence; failure policy is log-warn-and-continue.

### Funds-transferable

Localnet only. The first call to the memoised gate POSTs a real funding tx against the faucet,
retrying on body-level `{Failure}` responses (the validator can return HTTP 200 with a body-level
failure during the post-RPC-up / pre-fund-ready window). Subsequent calls hit the cache.

### Draining

Auto-tick fiber dies on scope close. Build-container scope finalizer rms the per-app sleeper.
Move-build lock and fork data-dir lock finalizers release. Main containers stop (NOT rm) with
mode-appropriate grace periods (localnet expects forced 137; fork registers SIGINT cleanly; postgres
needs the longer grace for clean WAL close).

### Stopped (writable layer kept)

Containers are stopped but not removed, preserving the writable layer for resume. Per-stack network
is torn down idempotently. Build container IS removed (the sleeper holds no state).

### Wiped (separate operation)

Per-stack fork artifacts (data dir, lock, meta) are removed. All containers fully removed. Shared
upstream cache survives plain wipe; only the explicit "also-upstream-cache" wipe nukes it. Host-wide
Move dep cache (`~/.move/git`) survives all wipes.

## Inputs / dependencies

### Configuration

- Mode selector (explicit literal, custom-RPC object, or `DEVSTACK_NETWORK` env).
- Per-mode option records: image overrides (pull or build spec), version pins, optional pre-existing
  URLs (RPC / faucet / GraphQL), optional direct port mappings, ready-timeout override.
- Fork-specific: image override, version pin (commit SHA), checkpoint anchor, seed addresses, seed
  objects, default gas budget, auto-tick option (boolean or interval).
- Environment toggles: network resolution env, fork-docker-test gate, fork-cache-dir override.

### Engine substrate

- Identity (app + stack + network) — drives every per-stack name and path.
- Docker primitives (run, network create, exec, build, image existence, log tail).
- Generic `ensureContainer` state machine for adopt-or-create on the build container.
- Router entrypoint + hostname allocation (entrypoints: `sui-rpc`, `sui-faucet`, `sui-graphql`,
  `sui-grpc` with h2c protocol for fork).
- Endpoint registry + Sui state registry + endpoint name catalog.
- App-dir resolver (for bind-mount roots and fork state paths).
- File-lock primitive (try-claim, ownership probe, parse, release, holder-liveness check).
- Atomic file write + content-hash + capture-command + child-process-spawner + filesystem services.
- Cache primitive (`withCache`) for the on-chain-artifact substrate.
- Phase catalogs (closed sets of error-phase strings).
- Layered-tag composition primitives (provide, tag, setPhase) for surfacing into the supervisor +
  TUI.

### External / runtime

- Sui CLI binary on PATH OR a per-app in-container worker with the same binary.
- Docker daemon.
- Host filesystem: `~/.move/git/` (Move dep cache, host-wide, never wiped); `~/.devstack/locks/`
  (host-wide move-build lock); per-stack `<appDir>/.devstack/stacks/<stack>/sui-fork/` (data dir,
  data lock, meta); shared `<appDir>/.devstack/sui-fork-cache/<chainId>/`.
- Upstream Sui RPC + faucet + GraphQL endpoints for live networks and fork bootstrap.
- `@mysten/sui` gRPC client, transaction builder, struct-tag normalizer.

### Cross-component inputs

- `KnownPackage` declarations elsewhere in the stack contribute seed objects via a process-scope
  accumulator that fork's acquire reads.

## Outputs / capabilities provided

### Endpoints (published into the engine endpoint registry)

- RPC endpoint, with both host-routed URL and in-network-DNS URL (where a network exists).
- Faucet endpoint (localnet container, localnet external-rpc with faucet, testnet, custom with
  faucet). Absent for mainnet and fork.
- GraphQL endpoint (localnet container, optional for external-rpc and custom, present for testnet
  and mainnet). Absent for fork.
- Indexer DB endpoint (localnet container only; internal-kind, container-DNS only).

### Chain identity (published into the Sui state registry)

- A per-mode-keyed state record carrying the chain id. Multiple modes can be active in the same
  compose (rare, but supported). Last-write-wins.

### Service surface

- The SDK gRPC client (wrapped with the fork guard in fork mode).
- The chain id.
- A memoised funds-transferable readiness gate; no-op when no faucet exists.
- A fork admin sub-surface: status query, advance-clock, advance-checkpoint, empty-signature
  impersonation, and the auto-tick cadence knob (read-only on the in-memory handle; the resolved
  cadence is persisted to meta).
- A chain-probe service (schema-validated lenient + strict variants of `getObject` /
  `getObjectStrict` / `getTransaction` / `objectsMatchTypes`).
- An on-chain artifact substrate (composes cache + verify + produce + register over the chain
  probe + Sui handle, used by Package/Coin/etc).

### Move-build capability

- A "build this Move package" call that picks the right path (host CLI / fresh `docker run --rm` /
  `docker exec` into per-app sleeper) given the package's host path and the presence of a build
  image.
- A summary build (used by codegen) that also runs inside the same container.
- Strict serialisation of all concurrent build invocations on a single host, via a host-wide
  advisory lock.
- Self-healing of stale git lockfiles in the Move dep cache, gated by a safety mtime window.
- Inline scrubbing of pinned-environment sections from package-local Move.lock files and from every
  cached dep's `~/.move/git/<repo>/.../Move.lock`.

### Container / image / network artifacts

- Vendored validator image (localnet), vendored indexer postgres image (localnet, PGDATA relocated),
  vendored fork image (fork — Dockerfile cargo-builds from a pinned commit and ships matching `sui`
  CLI). All content-hash-tagged.
- Per-stack docker networks (localnet net, fork net — names include app, stack, and where
  appropriate the network suffix to prevent cross-chain collision).
- Routes (RPC / faucet / GraphQL for localnet; gRPC with h2c for fork).
- A per-app sleeper container (`<app>` build container) — intentionally stack- and network-agnostic;
  shared across stacks of the same app.

## Invariants and constraints

### Cross-process safety

- The Move-build operation MUST serialise across processes on the same host (multiple `pnpm dev`
  processes, multiple test workers) via the host-wide advisory lock. The lock must be held inside
  the build call, not at any one path's container layer, because three distinct paths (host CLI,
  fresh `docker run`, container exec) all need protection.
- Fork data-dir access MUST be single-writer enforced via a file lock that records holder pid +
  host + instance id + start time; second acquire fails with an actionable error naming the holder;
  dead-PID holders are reclaimable on the same host.
- Stale-git-lock sweep MUST run AFTER lock acquire but BEFORE the build body, so the sweep cannot
  race a peer mid-git-op. A 60-second mtime safety window protects in-flight legitimate operations.

### Fork-sync ordering

- Data-dir lock acquired before meta-consistency gate runs before container starts. Reversing any
  pair is unsafe.
- The on-disk meta gate MUST fire before the binary starts, so config drift surfaces as an
  actionable error rather than the binary's non-actionable Rust panic.
- `configHash` MUST be stable across orderings of seed addresses / seed objects (sorted + lowercased
  before digesting) and case-insensitive.
- `configHash` MUST NOT depend on auto-tick cadence (which is a supervisor knob, not a seed contract
  field).
- The seed-objects accumulator MUST be cleared between independent composes in the same process
  (else stacks leak seeds across tests).

### Chain-probe rate limits / liveness

- Per-fetch timeout on every probe (RPC / faucet / GraphQL) so a hung fetch can't consume the outer
  deadline.
- Ready probes use `Schedule.spaced` (no exponential backoff) so the outer deadline is predictable.
- The lenient chain-probe accessors return absence for both "not found" and "transient RPC failure"
  — this lets the verify pipeline re-derive on the next cycle rather than fail boot.

### Build-container reuse

- One build sleeper container per app, shared across all stacks of that app and all networks of
  those stacks. Two parallel stacks' Move builds serialise via container exec queueing. This is an
  intentional accepted trade-off, not a bug.
- The build container's adopt-or-recreate state machine MUST reject the helper's
  auto-recreate-on-resume-failed path, so docker daemon outages fail loudly rather than silently
  churn.
- Build container path translation MUST refuse paths outside the bind-mounted app dir, and callers
  MUST auto-fall-back to a fresh `docker run --rm` for those paths.

### Shell / scrub safety

- Container-side scrub uses `gawk -i inplace` (NOT default `awk`, which is mawk on Ubuntu and lacks
  the inplace flag).
- Scrub MUST use `-type f` to reject symlinks (bind-mount + symlinked Move.lock +
  scrub-inside-container would otherwise be a path-traversal attack vector).
- Shell quoting MUST be applied to any host-supplied string interpolated into a container `sh -c`
  script.
- A failed build's exit-code check MUST fire BEFORE the trailing-JSON parse, else empty stdout would
  crash the parser and hide the real error.

### Ready ≠ funds-transferable

- The socket-level ready gate that the supervisor uses MUST NOT be relied on by primitives that need
  to submit a funding transaction. The funds-transferable gate is a separate, memoised, mode-aware
  capability that no-ops on faucet-less networks.

### Endpoint / network composition

- Per-stack docker network names MUST fold app, stack (where present), and network suffix (where
  present) so two stacks of the same app on different chains do not collide.
- Endpoint records MUST carry both host and container-DNS URLs where a network exists.
- Routes for fork's RPC MUST use h2c (gRPC over plaintext h2 through the router).

### Pinned-section scrubbing

- The pre-build scrub MUST strip both the package's own `Move.lock` pinned sections AND every cached
  dep's lockfile, else cross-network builds fail with a non-actionable env-mismatch error from the
  CLI.
- The CLI invocation MUST pass `-e testnet --no-tree-shaking` for in-container builds,
  unconditionally and regardless of target network (because the build's output uses symbolic
  addresses resolved at publish time, AND because tree-shaking would dial the configured env's
  fullnode, which has no network from the build container).

### Fork-mode SDK guards

- The fork client wrapper MUST intercept and reject (synchronously, before the wire call) every SDK
  surface that panics the fork binary. Surfaces are currently `getBalance`, `listBalances`,
  `getCoinInfo`, but the set may grow with upstream sui-fork.
- Empty-signature impersonation MUST stamp a default gas budget when the user has not set one.

### Snapshot capture

- Chain state (localnet validator) MUST live in the writable container layer, not in a named volume,
  so `docker commit` captures it. Same for postgres indexer state (which requires relocating PGDATA
  off the inherited VOLUME path).
- Fork data dir is a bind-mount; snapshot capture is handled separately by the snapshot
  orchestrator.

## Edge cases and known failure modes

### Build / publish

- Sui binary missing from PATH and no in-stack build image available: surface an actionable error
  pointing at the release page.
- Build-container `docker start` returns "no such container" (TOCTOU between finalizer rm and
  adopt): fall back to fresh `docker run -d`.
- Build-container `docker start` fails for other reasons (daemon outage): surface typed error, do
  NOT silently recreate.
- Build-container `docker run -d` name collision: helper adopts via `docker start` (peer beat us).
- Move-build lock timeout (5-minute default): surface error naming the lock holder pid + host plus
  manual-recovery recipe.
- Stale `.git/index.lock` in dep cache: sweep at acquire time; if a fresh in-flight lock survives
  the safety window, the build fails with a stderr that gets a recovery-recipe hint appended.
- Host path outside the bind-mounted app dir: build-container path returns typed error; caller
  auto-falls-back to `docker run --rm`.
- Build exits non-zero: route full stderr + stdout to error log, then surface typed error with exit
  code.

### Localnet

- Image build failure: surface mapped DockerError.
- Postgres sidecar fails ready probe: typed error with `postgres-up` phase; `pg_isready` failure
  separately phased.
- Validator ready probe times out (default 60s): typed error naming which probe (RPC / faucet /
  GraphQL) never succeeded, plus a tail of the container's docker logs.
- Chain-id fetch times out (default 30s): typed error.
- Faucet returns HTTP 200 with body-level `{Failure}` during the post-RPC / pre-fund window:
  `waitForTransactionsReady` retries (90s default budget); on exhaustion surface explicit recovery
  recipe and root-cause hints (mid-genesis cold start vs unclean prior shutdown).

### Fork

- Data-dir lock contention: typed error naming holder identity.
- Stale-PID holder: acquire reclaims on the same host.
- Meta-config drift: typed mismatch error with previous + current snapshots and actionable recipe
  (`wipe --keep-upstream-cache && apply`).
- Corrupt meta.json: treated as first boot; rewritten cleanly.
- Fork ready-probe timeout (default 180s): typed error with cold-start GraphQL warming hint.
- Caller invokes a fork-unsupported SDK surface: typed error raised synchronously at property
  access; binary stays up.
- Impersonated tx execution failure: typed error carrying the wire response's error string.
- Auto-tick advance-clock failure: log warn; next tick continues.
- Subscription stream errors: fall back to polling indefinitely.
- Variant composed against incompatible mode (e.g. local-cluster service against a `*-fork`
  network): typed error raised at factory time.

### Chain probe

- `getObject` "not found" pattern in error message: lenient returns absence; strict raises typed
  probe error.
- Schema validation failure on SDK response: strict raises typed probe error.
- Partial-mock SDK without `core.getTransaction`: defensive absence return.

## Learnings from current implementation

These are the entanglement points the redesign should be aware of and ideally disentangle.

- **The factory + builder file is ~2000 LOC** because the four per-network builders share
  boilerplate (publish endpoints + fetch chain id + publish state) but their bodies diverge in
  mode-specific ways (which probes, what container/sidecars, what router entries). Extracting a
  "common live-mode shape" helper without losing mode-specific guards is the natural refactor; the
  redesign should bake this seam in.

- **Three error-surface boundaries live in the same scope but serve different consumers:**
  `ForkUnsupportedError` (consumed inside the fork guard), `SeedManifestMismatchError` +
  `ForkIncompatibleError` (consumed by other services at compose time, not by Sui itself), and
  `SuiError` / `SuiCliError` / `HostProcessError` / `PublishError` (consumed by Sui and Package).
  The current implementation centralises all tagged errors in one engine file because the schema
  framework wants centralisation, but the consumer boundaries cross service lines. The redesign
  should decide whether to keep the centralised registry OR distribute errors to the services that
  raise them.

- **The `KnownPackage` seed-object accumulator is module-scope mutable state** with an explicit
  clear-between-composes contract. Tests that compose more than once must remember to clear; the
  responsibility sits with the user, not the framework. A scoped registry (read at fork acquire via
  `serviceOption`) would eliminate the foot-gun.

- **The chain probe service is folded into every Sui member's layer ring** so downstream callers
  don't have to rewire it. This is correct but means the chain probe and the Sui service share a
  circular-feeling composition (chain probe needs the Sui client; Sui's layer ring includes the
  chain probe layer). The redesign should make the dependency direction explicit.

- **The on-chain-artifact substrate lives in this scope** (defined in Sui's engine layer) but is
  consumed by Package, Coin, and other downstream artifact primitives. It lives here because it
  needs the Sui client and chain probe at acquire time. The substrate IS a cross-cutting capability;
  whether it belongs in Sui's scope or in its own substrate scope is an open architecture question.

- **The build container's per-app sleeper** is intentionally stack-and-network-agnostic to share dep
  caches across stacks of the same app — but its lifecycle is owned by the Sui service, even though
  it serves Package/Coin/Codegen. The redesign could either: keep build as a Sui-owned capability;
  or split the build container into its own substrate service that Sui simply consumes.

- **Move.lock pinned-section stripping is duplicated** between the host-build path (in the CLI
  wrapper) and the in-container path (in the build container). Both emit nearly the same awk script.
  One shared "compose-build-inner-script" helper would eliminate the duplication and centralise the
  security-hardening invariants.

- **Test-side and production-side fork commit SHAs are duplicated** with a "bump in lockstep"
  comment but no CI enforcement of the lockstep.

- **The known-deployments map is hardcoded** with an integrity warning comment but no signed
  manifest or checksum verification.

- **The fork guard's unsupported-surface set is closed and manually curated** with no automated
  drift detection against upstream sui-fork. A future sui-fork addition that introduces a new
  `todo!()` surface would only surface when a user hits it at runtime.

- **The fork guard does not cover the auto-gas-budget path of `client.core.executeTransaction`**. A
  direct caller bypassing the impersonation helper and not setting a gas budget would still trip
  `simulate_transaction`'s "unsupported".

- **`Effect.cached` is used to memoise `waitForTransactionsReady`** including its 90s timeout — a
  first-call failure caches the failure for the whole scope with no manual invalidation surface.

- **`buildWaitForTransactionsReady`'s "no faucet means no-op"** is a mode-aware behaviour expressed
  by branching in the factory. The redesign should make the "no-faucet network has a
  trivially-succeeding funds-ready gate" property a first-class shape, not a built-in branch.

- **Docker network naming rules differ between localnet and fork** (localnet only adds the network
  suffix for non-localnet; fork always adds it). The redesign should standardise.

- **`SuiCliPhases` carries 11 docker-CLI-shaped phase strings** several of which are mechanical
  compositions of verb + subject. Many could be programmatically derived.

- **The build container path and the host CLI path have different `sui` versions in practice** (one
  is pinned by the localnet image; the other is whatever's on the host PATH). `--no-tree-shaking`
  keeps the build offline, so the output bytecode should be identical, but the version drift is a
  foot-gun.

- **The `runtime/endpoint-names.ts::SUI_CHECKPOINT_VOLUME`** identifier is tested but has no clear
  consumer in the current scope. Either a leftover or a forward-declared seam.

- **An auto-tick fiber's returned `Fiber` handle is discarded at the call site**, suggesting a
  designed-for-but-not-yet-landed re-config path.

## Cross-component references

### Direct consumers (acquire-time dependents)

- **Account** — depends on the Sui client to derive on-chain account state and to use the
  funds-ready gate before submitting funded txs.
- **Coin** — depends on Sui client + chain probe to manage faucet-minted and impersonated coin
  balances; consumes the on-chain artifact substrate.
- **Wallet** — depends on the Sui client + chain probe; consumes the chain id to scope wallet-side
  state.
- **Faucet** — depends on the Sui faucet endpoint (when present) and the funds-ready gate;
  mode-aware (no-op on faucet-less networks).
- **Package** — depends on the Move-build capability, the Sui client (for publish), and the on-chain
  artifact substrate.
- **Codegen** — depends on the Move build container's "summary build" capability and on the chain id
  (to scope generated bindings to the active chain).

### Mode-coupled consumers

- **Walrus / Seal / Deepbook** — each has a local-cluster variant (incompatible with fork mode; must
  raise typed error at compose time) AND a fork variant (depends on the Sui fork acquire to seed the
  upstream's real on-chain addresses via `KnownPackage` accumulator + the known-deployments map
  keyed by the upstream network).

### Composition-time consumers

- **`KnownPackage`** — registers seed objects into a process-scope accumulator that fork acquire
  reads.

### Capabilities offered to surfaces

- **TUI / supervisor** — every builder surfaces phase narration; the supervisor reads layered-tag
  metadata for display.
- **OTLP / observability** — every probe, advance, and build is instrumented with a typed span.
- **Snapshot orchestrator** — depends on the writable-layer placement of localnet chain state +
  indexer state; depends on the bind-mount placement of fork data dir + meta.
- **CLI** — `doctor`, `wipe`, `fork cache list/prune` commands consume the stale-lock sweep helper
  and the cache inventory helper exported from this scope.

## Open questions / decisions deferred

- Is the test-side fork commit SHA always required to match the production commit SHA? The lockstep
  is documented but not enforced; the redesign should decide whether to: (a) collapse to a single
  source; (b) keep two with CI enforcement; or (c) accept drift with content-hashed image isolation.
- How is the test-pinned testnet checkpoint refreshed? Documented as "quarterly" but with no
  calendar or CI alert. Needs an owner or an automated probe.
- Should `HostProcessError` belong in this service's scope or in plugin-author's? Current placement
  is purely error-registry-centralisation; the consumer is plugin-author.
- Is the `fork.e2e.docker.test.ts` placeholder intentionally deferred, or is the orchestration code
  in a separate file?
- Is `ChainProbe.getTransaction`'s defensive partial-mock fallback a real production need or a
  test-only artefact?
- Does any caller use the build container for Move sources outside `appDir`, or is the
  `docker run --rm` fallback the dominant path for vendored deps under `.devstack/imports/`?
- For testnet/mainnet/custom modes, the Move build is forced through the host `sui` CLI (no
  SuiBuildImage is wired). Is this desired, or should those modes ALSO compose a build-container
  layer using a pinned image?
- Snapshot capture of fork data dir + meta lives in the snapshot orchestrator, not here. The seam
  exists but the contract is implicit; the redesign should make the snapshot-capture contract for
  fork mode explicit.
- `forkUpstream(network)` throws for non-fork variants and is defensively unreachable — is it dead
  code or a forward seam?
- `SUI_CHECKPOINT_VOLUME` — what consumes it?
- Should the auto-tick fiber's returned handle be retained for a re-config path? If yes, the
  cadence-change surface should become first-class.
- Should the fork's chain id be the upstream's REAL chain id (current behaviour, lets
  wallet-standard and MVR work) or a fork-derived id (would prevent accidental cross-environment
  leakage)?
- Is the manual GC policy for the shared upstream cache the long-term answer, or should it grow
  refcounting?

## Opportunities noticed

- Collapse the four live-mode builders behind a single common-shape helper that takes a URL bundle,
  a faucet-presence flag, and the mode discriminator.
- Extract one shared "compose build inner script" helper instead of duplicating the awk staging +
  scrub script between the host build path and the container build path.
- Replace the module-scope seed-object accumulator with a scoped registry service that fork acquire
  reads via service option.
- Decide whether the on-chain artifact substrate, the chain probe service, and the build-container
  service are Sui-internal or are their own substrate services; the current "all-in-Sui" placement
  is convenient but blurs the consumer boundary.
- Standardise per-stack docker network naming across localnet and fork (always-suffix or
  never-suffix).
- Make the "no-faucet network has a trivially-succeeding funds-ready gate" a first-class property of
  the mode rather than a factory-side branch.
- Make the fork guard a typed delegate (explicit supported surfaces) rather than a closed-set
  blocklist; new upstream additions should fail closed by default.
- Add a manual-invalidation surface to the funds-ready gate so a fork restart can re-probe.
- Drop the fork-guard's reliance on `as`-casts to satisfy the typed SDK client; build a typed
  wrapper that explicitly delegates only supported surfaces.
- Surface the `SuiBuildContainer.runSummary` contract in the codegen doc so the cross-service seam
  is documented from both sides.
- Move `ForkIncompatibleError` into the Walrus / Seal / Deepbook docs (those services raise it; Sui
  only hosts the definition).
- Move `HostProcessError` into the plugin-author doc for the same reason.
- The seed-manifest contract is mirrored twice (sui-fork's own on-disk manifest + devstack's
  meta.json). Document the layered-defence rationale in one place rather than as scattered comments.
- Audit which other tools the codegen path shells out to on the host vs in-container; the
  `runSummary` migration to in-container should be the template.
- Add CI gates: lockstep enforcement for the fork commit SHA; staleness probe for the test-pinned
  checkpoint; drift detection against upstream sui-fork's unsupported-surface set.
- Consider whether the build-container should be a substrate-level service (sharable across multiple
  consumer services), not Sui-owned.
- The chain-probe schema validates the SDK's `version` field as a string, but it's semantically a
  bigint. Consider a branded type so a future SDK change to expose typed version doesn't break the
  schema.
- The error-phase catalogs are closed sets but many phases are mechanical compositions; consider a
  small DSL for phase composition rather than enumerating 11+ literals.
