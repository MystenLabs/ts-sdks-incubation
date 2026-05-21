# 07 Seal (distilled)

## Purpose

Seal is devstack's integration glue around Mysten Labs' Seal — a BLS12-381 identity-based-encryption
key server fronted by an on-chain `KeyServer` Move object. The service stands up, on localnet, a
complete encryption-side capability:

- Generate a fresh BLS12-381 master keypair (one-shot container).
- Publish the Seal Move package.
- Register an on-chain `KeyServer` object pointing at the per-stack routed URL.
- Run the long-lived `key-server` HTTP daemon container, fed the master key via a 0o600 env-file.
- Surface two complementary tags to consumers: a network-side handle (SDK-ready `serverConfigs` plus
  URL + object id) and a local-only admin handle (master-key env-file path plus a rotation effect).

On testnet / mainnet / `*-fork`, it instead routes to a read-only handle pointing at the upstream's
known public key server. Seal is structurally incompatible with `sui-fork` (its chain client is
JSON-RPC, sui-fork only speaks gRPC) and the local-keygen variant refuses fork networks at factory
time.

Seal is one of three composite primitives (alongside Walrus and Deepbook): a public factory yields a
single supervisor entry while internally composing several inner cache-backed artifact tags, an
image build, an optional source fetch, a Move publish, and a long-running container — fanned out to
the topo scheduler.

## Modes

Four operative modes, dispatched purely from the resolved network.

### local-keygen (localnet)

- Full local stack: image build → keygen → publish → register → config render → master-key staging →
  long-running container → register endpoints.
- Owns the BLS master key, an on-chain `KeyServer` object, the rendered config yaml, and the
  env-file.
- Supports rotation (regen keypair + register new on-chain object + restart container + re-probe
  `/health`).
- Surfaces both the network-side tag AND the admin tag.

### live (testnet / mainnet)

- Read-only handle to the upstream's hardcoded `(keyServerObjectId, keyServerUrl)`.
- No container, no chain interaction, no on-disk file, no docker.
- Publishes the endpoint + state record and returns. No ready probe.
- Surfaces only the network-side tag.

### fork-known (`mainnet-fork` / `testnet-fork` / `devnet-fork`)

- Same shape as live, with the network strip-suffixed (`*-fork` → upstream) and the upstream's known
  deployment looked up.
- The fork's gRPC port can serve `getObject(keyServerObjectId)` reads of the upstream key server, so
  SDK consumers see the same object on-chain that they'd see live.
- Mainnet has no entry today (no public key server on mainnet).

### fork-localkeygen-refused

- Composing the local-keygen factory directly on any `*-fork` network throws a typed
  fork-incompatibility error at factory call time, with an actionable hint pointing at the canonical
  factory's auto-routing behaviour.

## Responsibilities

- Resolve mode from explicit options + network env; dispatch to the right inner factory.
- Generate, persist, and securely stage a BLS12-381 master keypair (one-shot container output →
  state-store cache + 0o600 env-file).
- Build (or pull) the seal `key-server` + `seal-cli` image, content-hashed with the pinned upstream
  version.
- Optionally fetch the upstream `move/seal` source at the same pinned version (unless the caller
  vendored a path).
- Publish the Seal Move package via the universal Move-publish substrate.
- Register an on-chain `KeyServer` Move object via the supplied signer, pointing at the per-stack
  routed URL.
- Render the daemon's CONFIG_PATH yaml, mount it into the container, mount the env-file.
- Run the long-lived `key-server` container, with a `/health` ready probe raced against
  `docker wait`, and a 15s SIGINT-forwarding stop grace.
- Publish the endpoint into the engine endpoint registry and the on-chain object id into the seal
  state registry.
- Expose an admin `rotate` effect that bounces all key-side state (keypair + on-chain object +
  yaml + env-file + container restart + re-probe + state-store update) under a single supervised
  flow.
- Refuse fork networks at compose time for the local-keygen variant; refuse missing signer at
  compose time on localnet.
- Redact the master key from every error-surfacing site that touches keygen stdout/stderr.

## Composite-primitive characteristics

Seal is the canonical example of devstack's "composite primitive" shape.

- **Public factory yields one supervisor entry**, but internally composes:
  - An image build (lifted to top-level as a sibling so the topo scheduler parallelises it with the
    Sui boot).
  - An optional source fetch (also lifted; only present when the caller did not vendor a path).
  - A Move package publish (kept inner because it consumes the source-fetch path at runtime).
  - Two cache-backed on-chain artifact tags (keypair, key-server object id) with verify probes.
  - A long-running container.
- **A private internal tag** is closure-bound inside the factory, keyed per-instance name. Its
  resolved value carries the aggregate shape (network-side data + admin data + package id).
- **Two narrow projection layers** read the private tag and expose the network-side and admin tags.
  The projection layers do not get their own supervisor lifecycle entries — they are trivial value
  extractions.
- **Live / fork-known mode collapses the composite shape** to a single bare effect that publishes
  registries and returns. No inner tags, no projection layers, no container.
- **The fanned-out inner siblings** are first-class topo nodes so unrelated parts of the stack (Sui
  boot, Walrus boot, etc.) can run concurrently with the image build and the source fetch. The
  primary acquire still rendezvouses on all inner tags before it fires.
- **The capability split (network-side vs admin)** is by design: consumer code that depends on
  rotation is type-checked away from running on networks where no master key is owned. Future
  remote-only factories produce a strict subset of the network-side surface.

## Lifecycle states

### Pre-start (factory call)

- Resolve network. Route to local-keygen, live-known, or fork-known.
- Throw synchronously: signer required on localnet; fork incompatible for direct local-keygen on
  `*-fork`; missing inputs on known-key-server when neither network nor explicit `(objectId, url)`
  resolves.
- Default unset options (version pin, ready timeout, in-stack name, ports).

### Image resolution

- For local-keygen: build or pull the seal image, content-hashed with the pinned upstream version.
  Skipped when caller supplies a pre-built tag.
- For live / fork-known: not present.

### Source resolution

- For local-keygen with no vendored Move path: clone the upstream repo at the pinned ref, subdir
  `move/seal`.
- For local-keygen with a vendored path: skipped.
- For live / fork-known: not present.

### Keypair acquisition (local-keygen only)

- State-store cache miss OR verify-fail (B8 cascade: cached structure + sibling on-chain object
  cache + chain-side object liveness + master-key file presence) → run a one-shot container with
  `seal-cli genkey`, parse `Master key:` / `Public key:` from stdout, persist to state-store.
- Cache hit: short-circuit with cached blob.

### Move publish (local-keygen only)

- Publish via the universal substrate; cache discipline keyed by `(name, sourceHash, chainId)`. Warm
  restart short-circuits.

### On-chain register (local-keygen only)

- State-store cache miss OR verify-fail (chain-side `getObject` probe) → call
  `KeyServer::create_and_transfer_v2_independent_server` with the supplied signer; extract the
  created object id from `objectChanges`.
- Cache hit: returns cached id.

### Config render + master-key staging (local-keygen only)

- Ensure the per-stack service dir exists with 0o700 (best-effort chmod fallback).
- Write the daemon's config yaml (bind-mounted into the container; persisted, NOT scoped-temp).
- Write the env-file with `MASTER_KEY=<hex>`, 0o600 (best-effort chmod fallback).
- Neither file is unlinked on scope close.

### Container start + ready (local-keygen only)

- Compose container name from `(app, stack, network?, instance-name, role)`.
- Attach to Sui's inner docker network so the daemon can resolve `sui-localnet` via docker DNS.
- Mount the rendered yaml; load the env-file via `--env-file` (NEVER inline `-e MASTER_KEY=…`, which
  would surface the secret in host process env and `docker inspect`).
- Run with the well-known seal port behind the shared Traefik `seal` entrypoint — NO host-port
  publish (two stacks share port 2024 via Host: header dispatch).
- Ready probe: HTTP `GET /health` against the routed URL, raced against `docker wait`; default 60s
  timeout. Crash-during-boot surfaces the log tail.
- Stop grace: 15s. The container's entrypoint shell forwards SIGTERM as SIGINT to the child binary
  (the daemon installs no signal handler; running as PID 1 would always SIGKILL).

### Registries (all modes)

- Publish the seal-key-server endpoint into the endpoint registry.
- Publish the on-chain key-server object id into the seal state registry (last-write-wins per name).
- Live / fork-known: this is the entirety of the build effect.

### Rotation (local-keygen only, admin-triggered)

- Re-run keygen one-shot under a rotate-named instance.
- Re-register a new on-chain `KeyServer` (upstream contract has no in-place public-key mutation —
  each rotation orphans the previous object).
- Re-render yaml + env-file in place.
- Restart the container; re-probe `/health`.
- Update both state-store entries on success. Caller retries on per-phase failure.
- NOT a hot-swap: callers that already captured the network-side tag's shape hold pre-rotation
  values until a hot restart.

### Teardown

- Scope close fires the container's stop finalizer with the 15s grace.
- All container finalizers across the stack fire in parallel, so total teardown is `max(grace)`, not
  sum.
- Master-key env-file and rendered yaml persist (snapshot round-trip requirement).
- State-store entries persist (chain regenesis is what invalidates them via the chain-id fold).
- Image is not removed; docker network detaches when container is removed.

### Wipe

- The entire devstack state dir is wiped, removing both state-store entries, both files, and any
  container/network artifacts.
- Image is not removed (content-addressed image cache survives wipe).

## Inputs / dependencies

### Configuration

- Network (env or explicit). Drives the mode branch.
- Signer (Account-like ref). Required on localnet; ignored on testnet/mainnet.
- Pinned upstream version (default chosen at factory release time). Used as BOTH the image build arg
  AND the Move source ref — the two MUST move in lockstep.
- Optional pre-built image tag override (skips the build).
- Optional vendored Move path (skips the fetch).
- Ready-probe timeout override.
- On-chain `KeyServer.name` override.
- Per-instance name override (folds into tag key, state-store cache key inputs hash, container name,
  display title).
- Explicit `dependsOn` ordering edges.
- For known-key-server: explicit network OR explicit `(objectId, keyServerUrl)` override pair.

### Engine substrate

- Identity (per-stack identity drives the routed hostname).
- State store (keypair + key-server-id cache entries).
- Endpoint registry + seal state registry.
- Engine handle (optional TUI log sink with min-level filter).
- File-system + path services (for env-file + yaml).
- Content-hash + cache-key builder (folds chain id + name inputs hash into namespaced slots).
- Phase set (closed catalog of error-phase strings).

### Cross-service inputs

- Sui handle: needed for chain id (fold into cache keys), for the docker network name to attach the
  container, and for chain-side verify probes.
- Account ref (the supplied signer): signs the Move publish and the on-chain register.
- Move-publish substrate.
- Source-fetch substrate (when no vendored path).
- Docker image-build substrate, run-one-shot substrate, run-long-running substrate, restart
  substrate, await-ready substrate.
- On-chain artifact substrate (for the keypair and key-server tags, each with their own cache +
  verify + produce).
- Router entrypoint registration (the well-known `seal` entrypoint at the well-known port).
- Routed hostname allocator (folds identity into per-stack hostnames).

### External / runtime

- Docker daemon.
- Host filesystem (per-stack service dir under devstack state).
- Upstream GitHub release archive for the image's pinned binaries (one per host arch).
- Upstream Git repo for the Move source (when not vendored).
- The Seal SDK's `KeyServerConfig` shape (peer dep; structure mirrored hand-in-hand, with a
  compile-time drift guard).

### Environment toggles

- Network resolution env.
- Log-level env (filters the container's stdout/stderr forwarded to the TUI; does not silence the
  docker logs themselves).
- Stack name env.
- State dir override.
- Docker-test gate envs (for the docker-bound test suites).

## Outputs / capabilities provided

### Tags surfaced

- A **network-side** tag carrying the SDK-ready `serverConfigs` array (one entry today; designed for
  future t-of-n committees), the routed URL, and the on-chain object id.
- A **local-admin** tag carrying the master-key env-file path and a `rotate` effect whose
  effect-channel resources have all been pre-provided at acquire time (so the surface is
  environment-free for consumers).
- The admin tag is produced ONLY by the local-keygen variant — known-key-server variants
  intentionally cannot supply it.

### Endpoints

- The seal key-server endpoint (well-known service name, conventional port). Routed by Traefik
  per-stack via Host: header dispatch on a shared host port — NEVER host-published.

### State-store records

- The persisted BLS keypair (two hex blobs), keyed by namespace + chain id + factory-name inputs
  hash.
- The on-chain `KeyServer` object id, keyed similarly.

### Files on disk (under per-stack service dir)

- The master-key env-file at 0o600 within a 0o700 parent dir.
- The rendered config yaml.
- Both persist across scope close — required for snapshot round-trip and for the bind-mount to
  survive between dev cycles.

### Manifest contribution

- Both the routed key-server URL and the on-chain object id surface under the seal slot of the
  services manifest.

### Routes

- One Traefik router stamped per-container, scoped by stack identity (router id folds in identity to
  avoid cross-stack rule-stealing).

### TUI / observability

- Phase updates surface as the supervisor entry's right-column phase indicator across the lifecycle
  (`building image`, `generating master key`, `publishing contracts`,
  `registering on-chain key-server`, `starting key server`; rotation reuses the same phases under a
  rotate-named branch).
- Container stdout/stderr forwards to the engine log sink, min-level filtered. Falls back to no-op
  when no sink is present.
- Trace spans named per phase (image build, publish, rotate).

### Errors surfaced

- A tagged `SealError` with closed phase set, carrying optional stdout / stderr / exit-code /
  key-server-instance-name / cause. Master-key redaction applies at every error-surfacing site that
  captures keygen output.
- A shared fork-incompatibility error type (also used by Walrus) for the compose-time refusal.

## Invariants and constraints

### On-chain ↔ runtime alignment

- The URL registered on chain for the `KeyServer.url` field MUST equal the routed hostname the
  container is reachable at. The SDK reads the on-chain object to discover the endpoint; mismatch
  silently breaks SDK clients. A single mint of the URL is reused in both the Move call and the
  container's routing entry.
- The Move package version and the image binary version MUST stay in lockstep — one pinned upstream
  version drives both the build arg and the source ref. Out-of-sync versions cause silent runtime
  ABI mismatch.

### Secret handling

- The master key MUST be staged via env-file, never inline env var — the latter would leak it into
  host process env and `docker inspect`.
- The env-file MUST be 0o600 inside a 0o700 parent (best-effort with platform fallback).
- The env-file MUST NOT be unlinked on scope close — required for snapshot resume to retain the key
  that the on-chain object's public-key half points at.
- Keygen stdout/stderr MUST be redacted at every error-propagation site (typed errors, span attrs,
  log lines). Redaction is a line-level case-insensitive match for any `master_key` mention.
- The keygen container itself MUST surface its output only through the redacted error path.

### Parallel-stack composition

- Per-stack container name MUST fold stack identity (and network, where present).
- Per-stack router id MUST fold stack identity.
- Per-stack routed hostname MUST fold stack identity (main stack and non-main stack mint different
  hostnames).
- State-store cache keys MUST fold chain id (chain regenesis invalidates the cache) AND the factory
  name inputs hash (multi-instance composition).
- The seal port MUST NOT be host-published — Traefik dispatches by Host: header so two stacks share
  the well-known port. The redesign should make this property structural rather than guarded by a
  source-text grep.

### Mode gating

- Local-keygen MUST refuse `*-fork` networks at factory call time (synchronous typed throw) because
  the daemon's chain client is JSON-RPC-only and sui-fork is gRPC-only.
- Local-keygen MUST require a signer on localnet at factory call time.
- Known-key-server MUST require either a known network or both override fields.
- Known-key-server MUST NOT surface the admin tag — there is no master key to rotate.

### Cache verify semantics

- The keypair's verify probe is a cascade: (1) cached structure shape, (2) the sibling key-server
  cache entry exists and the chain still holds that object, (3) the env-file is present on disk.
  Failure of any step returns absence so the next acquire re-derives the whole aligned (keypair,
  on-chain object, env-file) triple.
- Cross-primitive invalidation flows through verify-time dependencies, NOT through eviction side
  effects on sibling caches. The keypair reads the sibling cache; the sibling is responsible for its
  own eviction on its next acquire.

### Container hygiene

- The `key-server` binary installs no signal handler; running it as PID 1 means `docker stop` always
  SIGKILLs. The image MUST run the binary as a non-PID-1 child of a signal-forwarding shell wrapper.
- The container's daemon config MUST use the local-cluster discriminator with explicit node URL —
  env-only mode silently routes at the upstream public fullnode regardless of `NODE_URL`.

### Daemon config persistence

- The rendered config yaml MUST live on a persistent path under the state dir, NOT a scoped temp
  dir. Otherwise the bind-mount source vanishes between dev cycles and `docker start` of the prior
  container errors on mount.

### SDK structural compat

- The hand-mirrored network-side entry shape MUST remain structurally assignable to the upstream
  SDK's `KeyServerConfig`. A compile-time check is the only guard against peer-dep drift.

### Rotation effect environment

- The admin `rotate` effect's environment channel MUST be `never` — consumers don't expect to supply
  spawner / identity / etc. Required services are captured at acquire time and pre-provided.

## Edge cases and known failure modes

### Compose-time refusals

- Signer missing on localnet → synchronous typed error at factory call.
- Direct local-keygen on `*-fork` → synchronous fork-incompatibility error with actionable hint
  pointing at the auto-routing factory or the known-key-server alternative.
- Known-key-server without network and without both override fields → synchronous typed error.
- Router seal entrypoint not registered → typed error from the local-keygen acquire (should not
  occur in production: module-load-time registration).

### Keygen path

- Keygen container fails to run → typed error wrapping the docker error.
- Keygen exits non-zero → typed error with redacted stdout/stderr + exit code.
- Keygen stdout cannot be parsed → typed error with redacted tail (upstream output format drift).

### Publish + register path

- Move publish fails → propagated through the universal substrate, rewrapped as a seal error with
  publish-phase tag.
- On-chain register Move call fails → typed error with register-phase tag.
- The created `KeyServer` object is missing from the transaction's object changes (Move ABI shift) →
  typed error with the digest in the message.

### Config / staging

- Config-render write fails → typed error with config-phase tag.
- Env-file write fails → same.
- 0o600 chmod fails (cross-platform filesystem quirks) → fallback path runs, result ignored. Open
  question whether to warn.

### Container path

- Container run fails → typed error with container-phase tag.
- Ready probe times out (60s default) → typed error with ready-phase tag, container log tail
  attached.
- Container crashes during boot → ready/wait race surfaces the crash earlier than the timeout with
  logs attached.

### Verify-fail cascades (self-healing)

- Chain regenesis (chain id changes) flips both state-store cache keys → both artifacts re-derive.
- On-chain object disappears (selective regenesis, manual deletion) → key-server verify returns
  absence → re-register; the keypair's verify also catches the sibling miss → re-derive in lockstep.
- Env-file missing on resume (partial snapshot, manual wipe) → keypair verify catches it →
  re-derive.
- Image content hash changes (version bump) → container reuse probe forces recreate.

### Rotation

- Any phase failure during rotate → typed error with rotate-phase tag; state-store NOT updated; the
  daemon continues serving the pre-rotation keypair.

### Multi-instance composition

- Today: keys, files, container names, and state slots fold per-instance name — but the long-running
  container's routing entry uses the well-known service name, so two local-keygen instances in one
  stack would collide at the Traefik router level. Currently untested; structural-level open
  question.

### Live / fork-known runtime failures

- The remote endpoint being down is not surfaced through devstack — callers get a network error at
  SDK call time. No liveness check is performed.

## Learnings from current implementation

- The two-factory split (local-keygen vs known-key-server) lives behind one canonical factory whose
  only job is mode dispatch, missing-signer enforcement, and `*-fork → known` routing. Keep this
  seam.
- The composite primitive's inner topology — private internal tag closure-bound, two projection
  layers, several lifted sibling tags, two inner cache-backed artifact tags, an inner Move publish —
  is the canonical example of devstack's composite shape and the redesign should generalise it.
- The B8 cascade in the keypair verify probe (cached-shape → sibling-cache-and-chain probe →
  file-existence probe) is load-bearing and lives only as inline code today. The redesign should
  formalise it as a reusable substrate for any composite primitive whose artifacts must stay aligned
  with one another and with on-disk state.
- The lift-to-top-level pattern via `__extraMembers` is what makes the image build and the source
  fetch parallelisable with other slow primitives' boot. Without it the composite's acquire would
  serialise them. The redesign must keep this seam first-class.
- The Move publish is deliberately kept inner (not lifted) because it consumes the source-fetch path
  at runtime AND because its cache discipline + state-store writes are tightly coupled to the
  composite's acquire. Re-examine whether this is still true after the substrate redesign.
- The closure-bound internal tag class plus an object-assign-with-cast pattern is awkward and
  load-bearing — a typed `makeComposite(...)` helper that handles the layers + extra-members + kind
  wiring once would remove the casts.
- Two state-store-key derivation paths exist today: a centralised builder catalog and inline
  cache-key calls inside the service. They produce DIFFERENT slot shapes (the inline form adds an
  inputs-hash segment). One is dead or wrong — the redesign should pick one.
- The log-level parsing logic is duplicated between seal and walrus. Lift to a shared engine helper.
- The secret-redaction pattern (line-level case-insensitive regex over keygen output) is bespoke
  today but other primitives (walrus, postgres) likely need equivalents. Consider a
  `redactSecrets(stdout, patterns)` substrate.
- The signal-forwarding entrypoint shell pattern is identical in shape between seal and sui images
  (and likely deepbook/walrus). Lift to a shared template for upstream-binary-without-signal-handler
  containers.
- The known-deployments map is hardcoded with an integrity-warning comment but no signed manifest or
  checksum verification.
- The closed phase set is duplicated structurally across composite primitives — phases like `image`
  / `publish` / `register` / `config-render` / `container` / `ready` recur. Consider DSL-style
  composition.
- The unused `keyServer` slot on the typed error is dead today (designed for multi-instance
  configurations); decide whether to populate it or drop it.
- A schema drift between the state record's required object-id field and the manifest's optional
  object-id field exists; both should agree.
- A stale comment in the canonical factory points at an `/advanced`-exported helper that does not
  actually exist on that surface. Either export it or drop the comment.
- The `EXPOSE` declaration in the image references a port that devstack never connects to (likely an
  upstream metrics port). Document or drop.
- The TS-SDK-version-requirement field of the config yaml has a hardcoded default with no
  configuration knob; downstream SDK clients below that floor would be silently rejected.
- The rotate effect captures the signer at acquire time. If the signer is rotated externally between
  acquire and rotate, the rotation still operates against the originally captured value. Open
  question whether this matters in practice.
- The peer-dep structural-assignability guard between the local entry shape and the upstream SDK's
  config shape is a compile-time-only check; runtime drift would surface only at consumer call time.
- The placeholder docker-bound test files exist but assert only their gate flag; they're noise until
  wired. Either wire or drop them in the redesign.

## Cross-component references

### Direct consumers (acquire-time dependents)

- Application code that needs to encrypt via the Seal SDK consumes the network-side tag to construct
  the SDK client.
- Application code that needs rotation as an admin operation consumes the local-admin tag.
- Example apps under `examples/private-content` (or equivalent) exercise the localnet path
  end-to-end.

### Acquire-time dependencies

- **Sui** — supplies the chain id, the container-side docker network for daemon DNS, and the
  chain-side verify probes for both cache layers.
- **Account** — the signer that pays gas for the Move publish + on-chain register.
- **Move publish substrate** — used inline by the local-keygen acquire.
- **Source fetch substrate** — used when no Move path is vendored.
- **Docker image / run / one-shot / restart / await-ready substrates** — used across the keygen,
  container, and rotate paths.
- **On-chain artifact substrate** — used to construct the keypair and key-server tags with cache +
  verify + produce.
- **Router entrypoint registration** — the well-known seal entrypoint must be registered at module
  load.
- **Hostname allocator + router id allocator** — both fold stack identity.

### Composition-time consumers / cross-mode

- **Fork-known mode** depends on the Sui-fork's gRPC port to serve known `getObject` reads of the
  upstream's `KeyServer`. Future flow (seed-objects via a `KnownPackage` declaration) would seed the
  fork with the upstream's key-server object id at fork acquire time.
- **Walrus** and **Deepbook** are sibling composite primitives that share the fork-incompatibility
  error and several structural patterns (lifted image sibling, log-level env, etc.).

### Capabilities offered to surfaces

- **TUI / supervisor** — single lifecycle entry per local-keygen instance; the projection layers do
  not get their own entries. Heavy-infra cost tag (~30s reboot expected) flags the entry to the
  watch-fire log when a selective restart includes it.
- **Manifest grouper** — both the routed URL and the object id surface under the seal manifest slot.
- **Snapshot orchestrator** — depends on the state-store entries and on the per-stack service dir's
  files surviving capture (env-file is explicitly captured under the runtime tar).
- **CLI** — `status` and `manifest` commands print the seal endpoint when present. No seal-specific
  subcommands.

## Open questions / decisions deferred

- Which of the two state-store-key derivation paths is canonical? The centralised builder and the
  inline cache-key form produce different slot shapes today. Pick one.
- Should multi-instance local-keygen in one stack be supported (multiple instance names colliding at
  the well-known Traefik router level)? Today's per-instance name fold covers state and container
  naming but not routing.
- Should the synchronous compose-time throws (missing signer, missing fields) be typed errors
  (consistent with the fork-incompatibility throw) rather than bare errors?
- Should the SDK-version-requirement field of the daemon config be a first-class configuration knob?
- Should the chmod fallback for the env-file's 0o600 mode log a warning when it falls back?
  Currently silent.
- Should a known-key-server variant be exposed on the `/advanced` plugin-author surface, as the
  stale comment implies? The canonical factory is currently the only public surface.
- Should the rotate effect take a fresh signer rather than reusing the acquire-time captured one?
  Open until we have a real signer-rotation contract.
- Should the daemon's metrics port be wired through devstack (routed, scraped, etc.) or removed from
  the image?
- Should the unused multi-instance error field be populated when multi-instance support lands, or
  removed now?
- Is the fork-known mode's lack of remote-endpoint liveness check a problem in practice? The
  supervisor reports "ready" while the upstream may be down.
- Should the projection layers gain their own lifecycle entries to surface the network-side /
  admin-side capabilities separately in the TUI, or is collapsing both behind the internal tag's
  entry preferred?
- Should the inner Move publish be lifted to `__extraMembers` alongside the image build and source
  fetch, after the substrate redesign? Today it's kept inner because of runtime path coupling and
  acquire-tight caching.

## Opportunities noticed

- Generalise the composite-primitive shape (closure-bound internal tag + projection layers + lifted
  siblings + inner cache-backed artifacts) into a reusable substrate. Seal, Walrus, and Deepbook all
  instantiate the same pattern by hand today.
- Generalise the B8 cascade (cached-shape → sibling-cache-and-chain probe → file-existence probe) as
  a substrate-level helper for composite primitives whose artifacts must stay aligned.
- Lift the secret-redaction helper to a substrate (`redactSecrets(stdout, patterns)`), shared by any
  primitive that captures binary output containing secrets.
- Lift the log-level env parsing to a shared engine helper; seal and walrus duplicate it today.
- Lift the signal-forwarding entrypoint shell pattern to a shared image template for
  upstream-binary-without-signal-handler containers.
- Replace the closure-bound class with object-assign-and-cast pattern with a typed
  `makeComposite(...)` helper.
- Standardise on a single state-store-key derivation path (centralised builder OR inline cache-key,
  not both with divergent shapes).
- Move the daemon-config yaml renderer to a templates dir or a shared composition helper.
- Make the docker-bound placeholder tests either real or removed.
- Decide the canonical-vs-private factory boundary explicitly (which factories surface on
  `/advanced`, which are factory-internal) and align the comments with the actual exports.
- Make the manifest's object-id field's required-ness agree with the state record's.
- Reconsider whether the inner Move publish can be lifted alongside the image / source fetch after
  the substrate redesign — would let the topo scheduler parallelise more.
- Surface a warning when a known-key-server-bound factory receives an unused signer option (today
  silently ignored).
- Make the secret env-file's chmod failure path emit a warning rather than silently fall through.
- Add CI / integrity gates: known-deployments map content-hash or signed-manifest verification;
  upstream-version-bump lockstep verification; periodic SDK structural-assignability check.
