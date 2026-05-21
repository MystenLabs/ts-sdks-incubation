# 10 Postgres (distilled)

## Purpose

The Postgres service is devstack's generic, long-lived relational-store primitive. It exists so
consumer services that need a real SQL database (today: the DeepBook indexer and DeepBook REST
server) can declare a database dependency, get a per-stack container with one or more ensured
logical databases, and dial it from sibling containers using an in-stack docker network alias.

It is intentionally chain-unaware: no migrations, no init SQL, no schema management. It owns the
_container lifecycle_ of a Postgres instance and the _handoff contract_ (URL shape, credentials,
network reachability) consumed by downstream services. Schema and rows are the consumer's problem.

It also forms one half of the snapshot story: the container's writable layer carries all schema +
WAL + rows, captured by image-commit at snapshot time, paused around the commit so WAL is quiescent.

## Responsibilities

- Provision a per-stack docker network for postgres traffic and ensure the container joins it under
  a deterministic in-network DNS alias.
- Build (or reuse) a vendored postgres image whose data directory lives in the container's writable
  layer rather than in a docker volume.
- Spawn (or adopt) one postgres container per `(stack, name)` pair, wired with deterministic user /
  password / first-database env.
- Gate readiness on a real Postgres-aware probe (not just TCP listen) before declaring the handle
  ready.
- Idempotently ensure each requested logical database exists in the booted instance.
- Publish two endpoint shapes for consumers: a credentialed URL for in-process / in-stack dialers
  and a plain URL (no creds) for the on-disk manifest.
- Surface the handle to dependents so they can compose `DATABASE_URL` strings without re-deriving
  creds.
- Participate in the standard snapshot, wipe, prune, and warm-resume flows via labels — without
  owning any of those mechanisms.
- Optionally bind a host port so the container is reachable from outside the docker network
  (TUI-visible RPC kind) — otherwise stay internal-only.
- Optionally attach to additional docker networks for cross-service reachability.

## Generic database-service requirements

These apply to any database-service plugin (postgres today, possibly mysql / mongo / clickhouse /
sqlite-server tomorrow). They describe the _shape_ every DB plugin must satisfy:

- **Credentialed connection URL capability.** Two URL shapes must exit the plugin: one with embedded
  credentials (for in-process dialers that need them) and one stripped down for manifest
  persistence. The stripped form must never carry the password.
- **Per-database URL composition.** Most relational stores have a notion of "the cluster" vs "a
  database inside it". The plugin must let consumers ask for a URL pointing at a _specific_ logical
  database, not just the cluster root.
- **In-network DNS alias.** Consumers in sibling containers must reach the DB by a stable DNS name
  independent of host networking. The plugin owns the alias and the docker network it lives on.
- **Optional host-port publication.** A development affordance: when set, host tooling (clients,
  IDEs, repls) can reach the DB. When unset, the DB stays in-network only.
- **Server-aware readiness probe.** A TCP-port listener is not enough — postgres begins accepting
  TCP early but rejects queries until startup completes. The plugin must perform a protocol-aware
  probe (e.g. `pg_isready`, equivalent client-handshake) before declaring ready, with bounded
  retries and an overall timeout.
- **Idempotent logical-database creation.** Many real apps want >1 logical database in the same
  instance. The plugin must support a list of database names, ensure each exists, and short-circuit
  on warm resumes.
- **Persistent writable state across cycles.** Data must survive supervisor restarts and image
  rebuilds (within the bounds of `wipe` / `prune`). On warm resume the existing data must be adopted
  rather than reinitialised.
- **Snapshot-friendly storage layout.** Whatever mechanism the engine uses to capture state (image
  commit, volume snapshot) must reliably capture _all_ the DB's state. The plugin is responsible for
  ensuring its image / volume layout cooperates with that mechanism, not the engine.
- **Clean shutdown grace.** Stateful DBs need time to flush WAL / journal on stop. The plugin must
  request enough stop-grace from the container runtime; otherwise the next boot enters recovery mode
  (or worse).
- **No host-side files.** All DB state lives inside the container's writable layer or named volumes.
  The plugin must not scatter files into the host runtime tree — that complicates wipe, prune, and
  snapshot.
- **Credentials never persisted to disk.** Passwords flow through the in-memory state registry to
  consumers, never into the on-disk manifest. The plugin must split its state record into "in-memory
  only" (creds) and "projected to manifest" (endpoint, alias, db list).
- **Topological leaf.** A DB has no chain or sibling-service dependencies; it should be schedulable
  in parallel with other leaves.
- **Typed failure shape with phase tags.** Failures from image build, network create, container
  start, readiness probe, logical-db creation, and catch-all unknowns must each carry a distinct
  phase label so error reports and tests can pin behaviour.
- **Future "live" mode posture.** The plugin shape should not assume a container; future live modes
  (managed Cloud SQL, Neon, RDS) should slot in by emitting the same endpoint shape without spawning
  anything.

## Postgres-specific concerns

- **Upstream image declares `VOLUME /var/lib/postgresql/data`.** `docker commit` excludes VOLUME
  paths from the captured layer; if postgres writes there, snapshots are silently empty. The
  vendored image must relocate `PGDATA` off the upstream VOLUME (e.g. to `/pgdata`) so the writable
  layer captures everything. This is load-bearing and currently has no direct regression test.
- **`POSTGRES_DB` env var bootstraps exactly one database.** The official image's entrypoint creates
  whatever is in `POSTGRES_DB` on first boot, but only the first one — additional databases need
  out-of-band `createdb` / `psql` calls after the container is ready. The plugin must distinguish
  "first database" (env-bootstrapped) from "subsequent databases" (factory-managed) and never
  double-create.
- **`pg_isready` is the canonical readiness probe.** Available inside the image, exits 0 once the
  server accepts queries for a given user+database. Exponential backoff with a 2-second steady-state
  cap is the established pattern.
- **`docker exec` is the side-channel.** All out-of-band DB operations (existence check, createdb,
  pg_isready) happen via `docker exec`, not via a TCP client driver — this avoids carrying a TS `pg`
  runtime dependency in the production path.
- **Default `POSTGRES_USER` and image tag** should be sensible defaults but overridable. Postgres
  major version should be pinned by default.
- **Password derivation** in dev is acceptable when deterministic from `(app, stack)` so warm
  resumes don't need a state-store dance for credentials. The tradeoff: anyone with `(app, stack)`
  can compute the password — fine for a dev tool, footgun if a host port is exposed in a multi-user
  environment.
- **Snapshot pause/unpause** must happen around `docker commit` to avoid capturing mid-WAL-fsync
  state. This lives in the snapshot engine, not in the plugin, but the plugin's container must be
  discoverable by the engine's label-based enumeration.
- **`stopGraceSeconds`** should be long enough to flush WAL (sui-indexer-db uses 20s for this same
  reason). The generic factory currently does not set it; the docker default of 10s risks SIGKILL on
  busy DBs.

## Lifecycle states

- **Pre-start.** Identity (app + stack) resolved; deterministic strings (network name, alias,
  default password) computed.
- **Network created.** Per-stack docker network exists. Idempotent; survives the supervisor cycle
  that creates it.
- **Container started.** Image built (or cache-hit), container running with `POSTGRES_USER` /
  `POSTGRES_PASSWORD` / `POSTGRES_DB` env, joined to the per-stack network under the alias,
  optionally host-port-published, optionally joined to extra networks.
- **Awaiting ready.** `pg_isready` retry loop running against the bootstrap database, bounded by an
  overall deadline.
- **Ensuring databases.** Sequential existence-check + createdb for each non-first database name.
  Idempotent.
- **Ready.** Endpoint published (plain URL into endpoint registry, with `kind: 'rpc' | 'internal'`).
  State record published (with credentialed URL + password) into the in-memory state registry.
  Handle returned to dependents.
- **Resumed.** On warm restart, the network is rejoined idempotently, the container is adopted if
  its image still matches, readiness re-probed, existence-checks short-circuit createdb. Writable
  layer (`/pgdata`) carries over.
- **Paused (snapshot).** Container paused around `docker commit` so the captured image carries
  quiesced state.
- **Stopped.** Cycle finalizer calls `docker stop` (with stop-grace), container remains for next
  boot. Writable layer preserved.
- **Wiped.** Label-driven sweep removes container + per-stack network. All schema + rows gone.

## Inputs / dependencies

- **Engine identity service** for `(app, stack)` — feeds deterministic network name, alias, and
  default password.
- **Docker engine resource** for network create, container run, exec, label-driven sweep, stop,
  commit.
- **Container primitive** for image build + run + finalizer wiring + label stamping.
- **Endpoint registry** to publish the plain URL and its kind.
- **DB-specific state registry** to publish the credentialed record (in-memory only).
- **Tagged-error infrastructure** for typed phase-aware failures.
- **Vendored image build context.** The plugin owns its Dockerfile; the engine resolves it at
  runtime.
- **Snapshot engine** (indirectly) — enumerates containers via labels for pause + commit. The plugin
  must stamp the right labels via the container primitive.
- **No sibling service dependencies.** Topological leaf.

## Outputs / capabilities provided

- **Resolved handle** for in-process consumers, carrying: name, user, password, list of databases,
  credentialed endpoint, plain endpoint, in-network alias, container networks joined, and a
  `url(db)` composer.
- **Endpoint registry entry** under a well-known endpoint name (`postgres`) — plain URL, kind
  reflects host-publication.
- **State registry entry** — credentialed shape, never crosses to disk.
- **Manifest projection** — plain URL + alias + network + db list. Password explicitly omitted.
- **Flat endpoint lookup entry** so consumers can dial `postgres` by name when reading the manifest.
- **Per-stack docker network** under a deterministic name, label-discoverable for wipe/prune.
- **Snapshot participation** by virtue of label-stamping; image-commit captures the writable layer.

## Invariants and constraints

- `databases` must be non-empty; the bootstrap-via-env contract requires at least one name.
- The first database is created by the image entrypoint via `POSTGRES_DB` and must never be
  re-`createdb`'d.
- Vendored image must relocate `PGDATA` off the upstream `VOLUME` path — otherwise snapshot is
  silently empty.
- Container must be paused around `docker commit` during snapshot save (engine-level, but the plugin
  must label-cooperate).
- Plain endpoint URL must contain no credentials — enforced at the state-registry shape boundary.
- Password must never appear in the manifest projection.
- Per-stack network name must agree across all callsites that compute it.
- Container start, image build, ready-probe, and createdb failures must all surface as the plugin's
  typed error with a phase tag — not as generic docker errors.
- Already-typed errors must not be re-wrapped by the catch-all unknown-cause handler.
- The plugin is a topological leaf (no upstream service tag references); the state registry layer
  must be in the supervisor's base merge even when no consumer instantiates the plugin (so manifest
  gather doesn't fail).

## Edge cases and known failure modes

- **Docker network create fails** (IPAM pool exhausted, stale leftover): typed error, no auto-retry,
  user-resolved via prune / `docker network prune`.
- **Image build fails** or registry pull fails: typed error in the container phase.
- **Container start fails** (port conflict on `hostPort`, image mismatch, name collision): typed
  error in the container phase.
- **`pg_isready` returns non-zero past the deadline**: typed error with the database name + exit
  code + stdout/stderr. Common causes: slow disk initialising PGDATA, postgres binding to an
  unexpected port, permission issue on the data directory after image change.
- **`psql` existence-check fails** before createdb: typed error in the createdb phase.
- **`createdb` returns non-zero**: typed error with exit code + stdout/stderr. Common cause:
  case-sensitivity collision (postgres folds unquoted identifiers).
- **Unknown / unmatched cause**: catch-all phase tag (`postgres`) renders the cause into a message
  for investigation.
- **Unclean shutdown (no stop-grace)**: next boot enters recovery mode, slowing startup or in
  pathological cases failing to open the data directory.
- **Snapshot save captures mid-WAL-fsync**: corrupts snapshot, requires recovery on restore.
  Prevented by engine-level pause/unpause.
- **Multiple `Postgres()` instances on the same stack with the same `name`**: would collide on
  container name, network alias, and state registry key. Currently undocumented; relies on caller
  discipline.
- **Host-port collision** across stacks when `hostPort` is set: docker run fails — same surface as
  other host-bound services.

## Learnings from current implementation

- The vendored image's PGDATA relocation is the single most important and least-tested invariant; a
  regression silently kills snapshot integrity. The redesign should treat the
  image-layout-vs-snapshot-mechanism contract as a first-class invariant with a regression test.
- An L1 factory-shape test alone is insufficient. The redesign should include an L3
  container-lifecycle test covering boot, ready, createdb idempotency, warm resume, and
  snapshot/restore.
- A side comment claimed a state-store cache short-circuited the ensure-databases probe — no such
  cache existed. The redesign should either implement the cache or strip the comment; "documented
  but not implemented" is worse than either.
- `stopGraceSeconds` is unset on the generic factory but explicitly set on a sibling embedded copy
  (sui-indexer-db, 20s). The two callsites disagree. The generic plugin should bake in a safe
  default or accept an override.
- The network name was computed twice with identical logic in two callsites tied by convention. A
  shared helper would prevent silent divergence.
- The sui-localnet sidecar duplicates ~70 lines of postgres machinery (image build, ready probe, env
  wiring) outside the generic factory. The redesign should collapse the sidecar through the generic
  plugin.
- `pg_isready` + idempotent createdb + exponential-backoff schedule are reusable across any
  postgres-shaped service. They should live somewhere reusable, not buried in the plugin module.
- The credentialed URL was on the public handle and could leak via `console.log`. The redesign
  should consider gating credential access behind a capability or accessor rather than a plain
  field.
- The `password` was derived deterministically from `(app, stack)` — fine for dev, dangerous if a
  host port is exposed in a multi-user setting. The redesign should make this tradeoff explicit and
  configurable.
- The container-runtime defaults applied to the postgres container (e.g. `addHosts` for
  `host.docker.internal`) were inherited without conscious choice. The redesign should audit
  defaults relevant to a DB.
- The test helper that wraps a TS `pg` client existed but had zero importers; it was dead code
  waiting for the L3 test that never landed. Either land the test or delete the helper.
- The plugin's typed error needed an explicit `catchTag(self, fail)` step before the catch-all
  unknown handler to avoid double-wrapping. The redesign's error model should make this idiomatic,
  not a tripwire.

## Cross-component references

- **Runtime / docker primitive** — owns image build, container run, finalizer, label stamping; the
  DB plugin builds on it.
- **Sui service** — embeds a private postgres sidecar for the indexer that duplicates this plugin's
  machinery; should consolidate.
- **DeepBook indexer and DeepBook server** — the only current consumers; declare the DB as an
  upstream and read the handle to build `DATABASE_URL`.
- **Snapshot engine** — pauses the container around `docker commit`; the plugin must
  label-cooperate.
- **Endpoint registry, state registry, manifest projection, flat-endpoint table** — the four publish
  surfaces the plugin populates.
- **Wipe / prune CLI** — sweeps containers + networks by label; the plugin contributes both.
- **Identity service** — the deterministic source of `(app, stack)` used in network name, alias, and
  default password.

## Open questions / decisions deferred

- Should the redesign support a "live" mode (managed Cloud SQL / Neon / RDS) that emits the same
  endpoint shape without spawning a container? Today's plain-endpoint split anticipates it; nothing
  branches on it.
- Should the plugin own schema migrations or remain schema-blind? Consumers currently own their own
  migrations; this is the simpler contract and probably correct.
- Should the password be random + state-stored rather than derived? Tradeoff: cleaner secret posture
  vs. simpler warm-resume.
- Should the resolved handle expose the password as a field or behind an accessor / capability?
- Should `stopGraceSeconds` be an option or a fixed-by-default value with no knob?
- Should `awaitReady` and `ensureDatabase` live in the plugin module, in a shared db-helpers module,
  or be promoted to engine-level reusable primitives?
- Should the redesign provide an "init SQL" or "post-ready hook" extension point for consumers that
  need `CREATE EXTENSION`, role grants, or one-shot DDL?
- How should the redesign express "this database is shared between services" vs "each service gets
  its own logical db inside the cluster"? Today the contract is informal.
- Should the plugin offer connection-pool guidance (max connections, PgBouncer sidecar) for
  high-fanout consumers, or remain a single-instance no-pooling primitive?
- Should the redesign make the snapshot label contract explicit on the DB plugin's surface, rather
  than an implicit consequence of using the container primitive?
- Should the plugin's display surface (TUI extras) include host-port status when published?

## Opportunities noticed

- The "DB service" shape generalises beyond postgres. A redesign that articulates the generic shape
  (ready probe + idempotent logical-resource ensure + plain/credentialed URL split + writable-layer
  cooperation with snapshot + clean-shutdown grace) creates a template that future stores (mysql,
  clickhouse, mongo) can slot into without re-deriving the contract.
- Sui's embedded postgres sidecar is the largest internal duplication in the package. The redesign
  should either compose it through the generic plugin or document why it can't.
- Readiness probes for DB-shaped containers belong in a shared infra layer — multiple services
  already need "exec a probe binary inside the container until it exits 0 or the deadline elapses".
- The vendored-image + writable-layer + snapshot-pause chain is a single concept; documenting it as
  one invariant (rather than spread across image, container, and snapshot modules) would prevent
  regressions.
- Credentials posture deserves first-class treatment: a typed "credentialed URL" that the manifest
  projection refuses to accept, and a logging convention that elides it from debug output, would
  make the leak surface structurally impossible rather than convention-bound.
- The flat-endpoint lookup is undefined when the plugin is not in the stack — every consumer must
  guard. A typed presence-or-absence shape (rather than a possibly-undefined dictionary) would push
  the guard into the type system.
