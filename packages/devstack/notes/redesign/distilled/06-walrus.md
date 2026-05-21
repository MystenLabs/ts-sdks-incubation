# 06 Walrus (distilled)

## Purpose

Walrus is a decentralised blob-storage protocol that runs on Sui. The devstack `walrus` component
lets a developer stand up — or point at — a Walrus deployment from a single declarative entry. The
component has two operating shapes that are selected automatically from the resolved network
(localnet vs testnet/mainnet/fork), plus a refused variant for an incompatible composition.

Walrus is the _first_ fully-realised "composite primitive": it presents as a single named service in
the stack but it is actually a Move-package deploy + a multi-container committee + a
registry-publishing layer + optional faucet-strategy registration, all sharing one engine row and
one lifecycle. The redesign must support this composite pattern as a first-class concept (the same
pattern recurs in seal and deepbook).

## Modes

### Local cluster (localnet)

Build a wrapper docker image, run a one-shot deploy against the local sui chain that publishes the
Walrus Move package, mints a WAL exchange, and emits per-node configs; then start an N-storage-node
committee on a pinned per-stack docker network; expose the cluster via the global Traefik router and
an in-cluster WAL faucet strategy; seed declared accounts with WAL by swapping SUI→WAL via the
exchange.

### Known deployment (testnet, mainnet)

Pure-config surface that resolves a frozen registry record into the on-chain identifiers and the
live aggregator/publisher/proxy URLs. No containers, no docker network, no admin capabilities.
Synchronous: either resolves immediately at composition time or throws on missing required fields.

### Fork (`*-fork`)

Auto-routes to the known-deployment branch of the _upstream_ live net (mainnet-fork → mainnet
record, testnet-fork → testnet record). The local cluster path is explicitly **refused** under fork
at factory time because sui-fork does not expose JSON-RPC and the storage nodes need it. The refusal
must be synchronous with an actionable hint, not a deferred runtime failure.

## Responsibilities

- Build (and content-cache) two images: an upstream cargo-built image and a thin wrapper that layers
  in a matching sui binary plus the deploy/run shell scripts.
- Create a per-stack `/24` docker network with deterministically-hashed third octet, in a range
  chosen to avoid colliding with `docker0` defaults, common corp VPN ranges, and broadcast.
- Run the deploy one-shot inside that network, parse its summary artefacts, and cache the deploy
  state keyed by `chainId`.
- Start N storage-node containers with pinned IPs, dual-homed onto the per-stack sui docker network
  so the WAL faucet hostname resolves.
- Wait until each node's router-fronted TCP endpoint is reachable.
- Resolve the WAL exchange object on chain, register a WAL faucet strategy with the seed-account
  signer, and swap SUI→WAL for declared seed accounts (idempotent, per-account cached).
- Publish package, endpoint, and walrus-state registry entries; expose the cluster on the engine row
  with phase narration.
- For known deployments: synchronously assemble the four (or three) tag shapes from a frozen
  registry record + per-field overrides, and publish the walrus-state registry entry.
- On teardown, parallel-stop all storage-node containers (their grace windows must run concurrently,
  not serially) and collapse their TUI events back onto the single composite row.

## Composite-primitive characteristics

Walrus is the canonical example of _one composite primitive that is actually N nodes + a deploy
one-shot + a registry surface_. The redesign needs to absorb these characteristics:

- **One engine row, many containers.** The composite owns a single key ("walrus cluster"). Every
  inner container's lifecycle event (acquiring, ready, stopping, stopped) MUST route to that single
  row. Without explicit pass-through, the inner containers create phantom rows AND leave the
  composite row stuck in a wrong state. The "last child wins" rule for final state is acceptable.

- **Phase narration is per-composite, not per-container.** The composite publishes a sequence of
  phase labels ("building image", "deploying contracts", "registering nodes", "starting nodes",
  etc.) to the row as it advances. Container-internal phases (image build, container start, ready
  probe) are sub-steps of a single composite phase.

- **Lifted siblings.** Some of the composite's inputs are _better built in parallel with the
  composite's level-0 dependencies_ than serially inside the composite's own acquire. Two examples
  here: the cargo-built upstream docker image, and the optional git-fetched Move source. These
  siblings:
  - are declared at factory time so the topo scheduler sees them as level-0 leaves alongside
    foundations like sui;
  - are referenced as upstream-key edges so the scheduler knows they must finish before the
    composite's own acquire body runs;
  - must NOT be included in the composite's own primary layer slice (would double-build,
    double-account in topo levels);
  - must dedupe across composites — two walrus instances sharing the same git-fetched source must
    collapse first-wins.

  This pattern is generic; the redesign substrate should make lifted-siblings first-class (declared
  sites, dedupe protocol, scheduler contract) rather than something each composite hand-rolls.

- **State owned vs delegated.** The composite owns its deploy cache (state-store entries keyed by
  chainId), its on-disk runtime directory (per-node configs and keystores), its docker network, and
  the inner container set. It _delegates_ the chain to the sui foundation, the WAL faucet strategy
  to the faucet service, accounts to the account service, and the on-chain object existence probes
  to chain-probe.

- **Tag fan-out.** The composite publishes its capabilities as several narrow service tags (network,
  nodes, proxy, admin) rather than a single fat tag. Downstream code type-depends on only the slice
  it needs. The _asymmetric_ publishing — admin-tag only on local mode — is a load-bearing
  type-system safety net: code that needs admin power on walrus is type-checked away from compiling
  against testnet/mainnet.

- **Composite refusal.** Some compositions are illegal at certain network settings (here: local
  cluster on `*-fork`). The refusal must be synchronous and carry a redirect hint.

## Lifecycle states

The local cluster's acquire is ordered phases. Each pushes a phase label to the row before its work
begins.

1. **Yield dependencies** — sui foundation, identity, chain-probe, the declared seed-account tags. A
   missing dependency surfaces here, not later.
2. **Image** — yield the lifted upstream image; build the wrapper image with the upstream tag as a
   runtime-resolved build arg.
3. **Network** — create the per-stack docker network with a pinned `/24`. The network name MUST
   include the stack dimension when non-main, else parallel stacks collide.
4. **Deploy** — `withCache` keyed by `chainId`. Verify checks both the on-disk summary file AND
   on-chain existence of system+staking. On miss, `docker rm -f` the predicted node container names
   (drops stale RocksDB from a previous chain) before running the deploy one-shot.
5. **Register committee** — placeholder phase reserved for per-node re-registration. Currently a
   typed no-op.
6. **Start nodes** — parallel start of all N storage nodes; per-node container, dual-network attach,
   TCP ready probe at the router-fronted public endpoint.
7. **Exchange resolve** — read the exchange object on chain to extract its package id. Gracefully
   degrades to "no exchange" on OBJECT_NOT_FOUND (regenesis without state-store wipe).
8. **Faucet strategy register** — if exchange present and at least one seed account exists, register
   a WAL faucet strategy on the optional faucet service.
9. **Seed accounts** — per-account SUI→WAL swap, per-account cached on
   `(chainId, exchangeObjectId, address)`.
10. **Registries publish** — package, endpoint × (2 + N), walrus-state.
11. **Mark ready** — row transitions to ready with primary URL and a "N nodes" extra.

The known-deployment path has no ordered phases; it is a synchronous factory body that either
resolves and emits eager `succeed`-style layers, or throws.

**Teardown** runs node finalizers concurrently inside a forked parallel-strategy scope (serial would
be N × grace seconds). The deploy one-shot is auto-removed, the runtime directory survives, the
network is torn down by its create-time finalizer.

**Restart** semantics: a watch-fire restart should log a heavy-infra warning (boot takes ~60s in
practice). The lifted siblings' watch closures are independent — a Move-source change rebuilds the
wrapper image without re-cargo-building the upstream image.

## Inputs / dependencies

- **Sui foundation.** Required at acquire (RPC, faucet, chain id, client) AND as an upstream-key
  edge so the topo scheduler sees the walrus-after-sui ordering. Storage nodes additionally need the
  per-stack sui docker network for faucet DNS — dual-home via `networkConnect` after container
  start, with a getent-loop in the run script to absorb the attach race.
- **Identity.** Drives the per-stack subnet hash, the per-stack network name, the public router
  hostnames, and the container names. Two parallel stacks of the same app MUST produce disjoint
  hostnames and disjoint network names.
- **Chain-probe.** Used in cache verify probes (object existence, transaction existence).
- **State-store + cache wrapper.** Three caches: deploy output, register-committee (currently
  no-op), per-account seed-WAL swap.
- **Engine handle (optional).** Phase narration, log streaming, row state transitions.
  Composite-primitive characteristic: every inner container must opt into the composite's row key,
  not its own.
- **Docker / container runtime.** Build, network create, run one-shot, run container,
  networkConnect, awaitContainerReady, networkConnect, parallel stop scope.
- **File system.** Output directory mkdir, deploy summary readback.
- **Process spawner.** Required by docker build/run.
- **Faucet service (optional).** When present, walrus registers a WAL faucet strategy after exchange
  resolves.
- **Seed account tags.** Each declared seed account resolves upfront; the first doubles as the
  deploy-paying admin and the faucet-strategy signer.

**External dependencies:** docker daemon; git/github for the source fetch; github releases for the
matching sui tarball; on `*-fork` and known modes, a frozen registry record of system / staking /
exchange / URLs for testnet and mainnet. The frozen records must be reviewable and verifiable
out-of-band (currently via in-tree comment markers).

**Image pinning:** upstream walrus ref, Move-source subdir within that ref, and a matching sui
release version MUST be pinned together — they each contribute to the same on-chain types and must
agree. The wrapper base image must use ubuntu:24.04 (or newer glibc), not bookworm-slim; glibc 2.36
vs 2.38 is the load-bearing distinction.

## Outputs / capabilities provided

- **Service tags (narrow fan-out).** Network identifiers and SDK-ready package config; per-node
  committee descriptors; aggregator/publisher/ proxy URLs (local collapses all three onto a single
  router vhost); admin operations (seed-wal, wait-for-committee). Admin tag is local-mode-only;
  proxy tag in known mode requires all three URLs.
- **Endpoint registry entries.** A "walrus-aggregator" and a "walrus-publisher" endpoint, plus one
  "walrus-node-<i>" per storage node. Known mode publishes none — its URLs ride on the proxy tag.
- **Walrus-state registry entry.** A small record carrying name + systemObjectId for downstream
  codegen and manifest projection.
- **Package registry entry (local only).** The deployed `walrus` package id plus captured
  system/staking/exchange object ids.
- **Faucet strategy (local only).** WAL strategy registered on the optional faucet service so
  `Account({funding: {WAL}})` works.
- **Manifest projection.** Walrus contributes to the runtime manifest's `services.walrus` slice
  (aggregator URL, publisher URL).
- **Engine row.** One composite row with phase narration, primary URL, and an N-nodes extra. All
  inner-container events route to this row.
- **Docker artefacts.** One upstream image tag, one wrapper image tag (both content-addressed), one
  per-stack network, N persistent node containers, one short-lived deploy one-shot.
- **On-disk runtime dir.** Per-node configs, per-node sui keystore, admin sui wallet — under a
  stable per-instance path. This directory MUST ride the snapshot tar; without it, the deploy state
  cannot be honoured on resume.

## Invariants and constraints

**Topology / network.**

- N storage nodes share a per-stack `/24` with pinned IPs starting at a fixed offset; the listening
  IPs the deploy script writes into the on-chain committee MUST match the container `--ip` pins.
- The per-stack docker network name MUST include the stack dimension on non-main stacks; otherwise
  parallel stacks adopt each other's network and fail with subnet-mismatch errors.
- The pinned `/24` third octet is hashed from `(app, stack, "walrus")` in a range chosen to avoid
  `docker0` and common VPN/broadcast ranges. The hash is collision-tolerant but not a leased
  resource — collisions are rare-but-possible.
- Storage nodes MUST dual-home onto the per-stack sui network for faucet DNS; the script absorbs the
  attach race with a 30s getent loop.
- The router entrypoint binds host port 9185 once globally; per-stack isolation is by `Host:`
  header. All stacks share the same on-chain `public_port` (9185) and dispatch by hostname.

**Deploy / cache.**

- Deploy cache key folds `chainId` so regenesis cleanly invalidates.
- Cache verify checks BOTH on-disk summary AND on-chain object existence; either failure forces
  re-deploy.
- The runtime deploy dir MUST ride the snapshot tar; it holds per-node keystores that cannot be
  regenerated from cache alone.
- The deploy summary must yield package id, system object, and staking object; missing any fails the
  parse.
- Public hostnames (what each node registers as its on-chain network address) MUST be the per-stack
  router hostnames; two parallel stacks of the same app advertise disjoint hostnames.
- `shards >= nodeCount` (asserted both in the TS factory and in the deploy script).

**Fork.**

- Local cluster MUST refuse `*-fork` synchronously at factory time, with an actionable hint pointing
  at the auto-routing entry or the known-deployment factory.
- The auto-routing entry on `*-fork` MUST resolve to the upstream live net's known-deployment
  record.

**Tag layering.**

- Known-deployment MUST NOT publish admin tag.
- Known-deployment MUST publish proxy tag only when ALL three URLs are present.
- Known-deployment MUST throw synchronously when `nodes` is missing for a registered network — the
  SDK doesn't accept an empty committee, and testnet's committee is fetched dynamically (not
  statically pinnable).

**Lifted-sibling protocol.**

- The composite MUST declare its lifted siblings AND its upstream-key edges so the scheduler builds
  them at level 0, parallel with sui.
- The composite's primary layer slice MUST NOT include the lifted siblings (would double-build /
  double-account).
- Two composites sharing a lifted sibling by key MUST dedupe first-wins silently (collision warnings
  reserved for user-authored top-level collisions).

**Engine lifecycle.**

- All inner containers' TUI events MUST route to the composite row key, not their own derived keys.
- The per-node stop finalizers MUST run inside a forked parallel-strategy scope (else teardown is N
  × grace).
- Storage-node stop-grace MUST be ≥ ~20s to allow RocksDB flush; below that the next start runs
  log-replay before serving.

**Image / version pinning.**

- Walrus ref, Move subdir, and matching sui binary version MUST be bumped together.
- Wrapper image base MUST be glibc-≥2.38 (ubuntu:24.04), not bookworm.

**Container scripting (script-side invariants the TS side relies on).**

- Per-node sui keystore MUST be relocated off the host-mounted volume on macOS (osxfs/gRPC-fuse
  returns ENOTSUP for keystore lock ops).
- Faucet DNS lookup MUST tolerate the post-run network-attach race.
- Deploy must disable TLS between nodes (axum-server arm64-darwin panic); host-facing TLS is
  terminated at the router.
- Bind addresses MUST be `0.0.0.0:` (every interface), since each node is reached via three networks
  (walrus net, router, sui per-stack).

## Edge cases and known failure modes

- **Image build failure** → composite-tagged error with the docker build cause; supervisor surfaces
  the build output.
- **Network create failure** → most commonly a parallel-stack collision when the stack dimension is
  missing from the name.
- **Deploy script non-zero exit** → captured stderr/stdout; an opt-in env keeps the one-shot
  container around for post-mortem.
- **Deploy summary missing required field** → parse failure with the enumerated required keys.
- **Cached system/staking object missing on chain** → cache invalidates and re-deploys cleanly.
- **Cached exchange object missing on chain** → degrades to "no exchange"; WAL faucet + seed-account
  funding silently skip; first funding request surfaces "no strategy registered for WAL".
- **Storage node start / ready / network-attach failure** → composite- tagged error with the
  per-node detail.
- **Exchange object has unexpected type** → indicates upstream walrus changed shape; bump the pinned
  ref.
- **Seed WAL swap failure** → typically signer SUI balance.
- **Cached seed-wal swap whose digest no longer resolves** → cache invalidates and re-swaps.
- **Manually-drained WAL balance** → NOT detected (cache verifies the swap digest, not the current
  balance). Documented tradeoff.
- **Re-deploy on a chain that already has registered nodes from a previous deploy whose host outputs
  were lost** → mints NEW node keys and breaks the committee. Verify probe doesn't catch this case
  (on-chain objects still exist).
- **Local cluster on `*-fork`** → synchronous refusal with hint.
- **Known deployment without required fields / without nodes** → synchronous error at factory call
  site.
- **`nodeCount < 1` or `shards < nodeCount`** → synchronous factory- time error.
- **Move source git fetch failure** → surfaces via the lifted sibling's own failure path, not the
  composite's error type.

## Learnings from current implementation

- **Phase vocabulary drift.** The orchestrator pushes free-form phase strings to the engine row
  while the typed error carries a closed enum. Two parallel vocabularies for the same lifecycle.
  Substrate redesign should unify.
- **The per-line docker log sink is duplicated.** The deploy one-shot sink and the per-node sink are
  byte-identical modulo label. Lift to a shared docker-logging helper.
- **The router-fronted port number is referenced from three places.** One central constant would
  reduce update footprint.
- **The composite return shape leaks implementation.** Hand-rolling `__layer` / `__layers` /
  `__extraMembers` / `__upstreamKeys` to express "I'm a composite with lifted siblings" is the right
  _semantics_ but a hostile _form_. The substrate redesign should let a composite declare these
  intentions without spelling out the internal mechanics.
- **The composite engine-row key is a magic string referenced in many files.** A typed key tied to
  the composite identity would tie this together.
- **`registerCommittee` is structural plumbing for a body that returns null.** Cargo-culted
  future-proofing; strip until the work lands.
- **`waitForCommittee` on the admin tag is `void`.** The per-node readiness probes already happened;
  nothing to wait for. Either drop from the contract or tighten to a quorum-status check.
- **The bash deploy/run scripts are load-bearing.** Bash is opaque to type-checking; the env-var
  contract between TS and bash is enforced only by comments. A typed serde layer between the deploy
  binary and the rest of devstack would catch format drift at schema time, not at a missing-field
  parse error.
- **The wrapper image's hand-rolled content hash bypasses the standard image-helper.** A standard
  helper that accepts a runtime-resolved build arg would unify.
- **`Walrus()` silently ignores `local` options on non-localnet.** No warning, no compile-time hint.
  A discriminated config that only surfaces `local` on the localnet branch would catch the misconfig
  at the call site.
- **The known-deployment "throw if nodes missing" is sensible but inconsistent with the SDK's
  dynamic-fetch design.** Architecture decision deferred: model the live committee as a dynamic
  effect, or keep the throw.
- **The exchange resolution probes by raw `getObject` and parses the type manually** despite the
  rest of the deploy/seed flow using chain-probe. Unify when chain-probe gains a typed accessor for
  this shape.
- **The per-node BLS public keys aren't surfaced.** The current shape fills them with empty strings;
  reading the staking_pool object would give the real values.
- **The WAL coin type isn't reconstructable from the deploy output.** Forced the seed-wal cache to
  "probe digest, not balance". Capturing the `wal` package id in the summary would unstick this.
- **The asymmetric admin tag is "presence on the type system without a presence flag".** Consumers
  use service-option to graceful-degrade, but the asymmetry lives in comments not types.
- **The split between the outer file (tag classes + factory) and the inner directory
  (implementations) is transitional.** Pick one.

## Cross-component references

- **Sui** — foundation: chain client, RPC, faucet, chainId, per-stack sui docker network, upstream
  image edge.
- **Account** — declared seed-account tags; first doubles as deploy admin and faucet signer.
- **Faucet** — optional consumer for WAL strategy registration; depends on faucet's
  strategy-registration surface.
- **Identity** — per-stack subnet hash, network name, router hostname, container name.
- **Engine handle** — composite-row narration, log appending, ready/ failed transitions.
- **Chain-probe** — cache verify probes (object existence, tx existence).
- **State-store + cache** — three cache lanes (deploy, register- committee placeholder, seed-wal).
- **Snapshot** — runtime dir under per-instance path MUST ride the tar; state-store entries ride
  state.json. Snapshot integrity test enforces multi-instance preservation.
- **Router (Traefik)** — single host-port entrypoint (9185), per-node Host-header dispatch.
- **Docker runtime** — build, networkCreate, runOneShot, runContainer, networkConnect, awaitReady,
  parallel stop scope.
- **Codegen / manifest** — walrus-state registry feeds manifest projection; manifest schema declares
  the walrus slice.
- **Seal, deepbook** — sibling composite primitives sharing the same pattern (composite row, lifted
  siblings, narrow tag fan-out, mode- based capability omission).
- **Known-deployments registry** — frozen testnet/mainnet records (must be reviewable / verifiable
  out-of-band).

## Open questions / decisions deferred

- What invalidates the wrapper-image content hash on Move-source changes? The current hash inputs
  don't include the Move source path or the upstream Move source; the path works by accident because
  the upstream Move dir is baked from the upstream image which DOES vary on walrus version.
  Substrate redesign should make this explicit.
- What does `devstack wipe` do to the per-instance walrus runtime dir and the walrus state-store
  entries? Owned by snapshot/lifecycle component; not pinned by a walrus test.
- Are the deploy script's extra env vars (`WALRUS_GC`, `WALRUS_CONTRACT_DIR`, `WALRUS_DEPLOY_BIN`,
  `WORKING_DIR`) reachable from the TypeScript side? Today no factory option exposes them.
- How should the contract behave when the deploy outputs are lost on the host but the chain still
  has the previously-registered nodes? Re-deploy mints NEW keys and breaks the committee; today's
  verify probe doesn't detect this asymmetry.
- The seed-payment default produces an unspecified amount of WAL; the exchange rate isn't captured.
  "Fund my account with N WAL" requires pre-computing MIST. Decide: surface rate, or change the API
  to WAL-denominated requests.
- The fork-known docker test is pending. Wire-up or scope decision.
- Two `Walrus()` instances in the same stack work per the snapshot test but the user story isn't
  documented. Is multi-instance supported, encouraged, or accidental?
- The `movePackagePath` option is consumed only via a span annotation; the deploy doesn't read it
  (wrapper image embeds its own copy). Drop or wire through.
- Decide: model the live testnet/mainnet committee as a dynamic effect (cached function over the
  staking pool) or keep the synchronous "throw if not pre-fetched" contract.

## Opportunities noticed

- **Generic "composite primitive" abstraction.** Walrus, seal, and deepbook all share: one engine
  row, many containers; phase narration; lifted siblings; narrow tag fan-out; mode-based capability
  omission; composite-refusal under incompatible modes; multi-cache with chain-id-folded keys. Make
  this a first-class redesign concept rather than each composite reinventing the return shape.
- **Lifted-sibling protocol as substrate.** Today every composite hand- rolls the lift (declare
  upstream-keys, slim primary slice, dedupe rule). Substrate the lift so a composite _declares_ its
  lifted inputs and the scheduler + dedupe protocol handle the rest.
- **Composite engine-row identity.** Make the composite-row key a typed property of the composite
  identity, not a magic string referenced from multiple files.
- **Per-line docker log sink.** Lift from per-service files into the docker runtime / engine,
  parameterised by label.
- **Phase vocabulary unification.** One closed enum used by both the row narration and the typed
  error tags.
- **Typed deploy-summary boundary.** A schema-checked interface to the deploy binary's output
  replaces the current key-value parse and turns "missing field" from a runtime error into a schema
  check.
- **Snapshot path declarations as types.** The "this dir MUST ride the tar" invariant lives in
  tests; substrate redesign should let the composite declare its snapshot-relevant paths so the
  snapshot tar composition is type-checked.
- **WAL coin-type capture in the deploy summary.** Sidesteps the entire "probe by digest, not
  balance" cache workaround. Negotiate with upstream walrus-deploy.
- **Per-node BLS public-key surfacing.** Read staking-pool object after deploy to populate the
  per-node descriptors with real keys.
- **Discriminated-union options shape.** Configuration like `local` that only applies on one network
  branch should be visible to the type system as such, not a silently-ignored field.
- **Drop typed no-ops** like the register-committee cache wrapper and the wait-for-committee admin
  op until the underlying work actually lands.
- **Frozen registry records with type-level integrity attestation.** Today the testnet/mainnet
  records are reviewed via in-tree comment markers; lift to a schema with an explicit integrity
  field so reviewers see the contract.
- **The factory's option-pass-through (`opts.local` on testnet) silently no-ops.** Either warn or
  model with a discriminated config.
- **The `/advanced` escape hatch's field-merge logic and the auto-route factory's field-merge logic
  are structurally similar.** Unify.
- **A central `WALRUS_ROUTER_PORT` constant** to replace the three duplicated `9185` references.
