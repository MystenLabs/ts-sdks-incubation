# postgres

## Purpose

`Postgres(opts)` is devstack's generic, long-lived Postgres-container service primitive. It exists so consumer services that need a real relational store — today, the DeepBook indexer and DeepBook REST server (see `packages/devstack/src/services/deepbook/indexer.ts:28` and `…/server.ts:27`) — can declare a `Postgres()` dependency, get a per-stack container with one or more ensured logical databases, and dial it over an in-stack docker network using the in-network DNS alias. The service is intentionally generic — it has no chain awareness, no migrations, no init SQL — and treats Postgres as one half of the snapshot story: the container's writable layer at `/pgdata` is captured by `docker commit` on `devstack snapshot save`, so schemas + rows ride along.

`Postgres()` is **not** the same thing as the sui-localnet's embedded indexer-db. The sui factory in `packages/devstack/src/services/sui.ts:119-137` bundles a *sibling* postgres container (network alias `sui-indexer-db`, db `sui_indexer`, user/password `sui`/`sui`) hard-coded inside its own composite that backs `sui start --with-indexer`. That sibling reuses the same vendored `images/postgres/Dockerfile` (see `services/sui.ts:776`) and the same `pg_isready` probe pattern (`services/sui.ts:515-566`), but it is privately owned by the sui composite — it never participates in `PostgresStateRegistry`, `PostgresTag`, the `EndpointName.POSTGRES` flat endpoint, or the manifest `services.postgres.*` section. This document covers ONLY the generic `Postgres()` factory. The sui-indexer-db sidecar is documented in the sui doc; references here are to call out the duplication.

## Current implementation

### Source files

| File | LOC | Summary |
| --- | --- | --- |
| `packages/devstack/src/services/postgres.ts` | 327 | Public `Postgres(opts)` factory: per-stack network create, `runDockerContainer` invocation, `awaitPostgresReady` gating, `ensureDatabase` loop, two URL shapes (credentialed + plain), `publishEndpoint` + `publishPostgresState`, composite tag wiring (`PostgresTag`, `__layers`, `makeService('postgres', 'service', …)`). |
| `packages/devstack/src/services/postgres/internal.ts` | 118 | Shared internals: `awaitPostgresReady(containerId, user, database, timeoutMs)` — `docker exec pg_isready` with exponential backoff + timeout; `ensureDatabase(containerId, user, dbName)` — idempotent `psql -tAc "SELECT 1 FROM pg_database …"` probe + `createdb` fallback. |
| `packages/devstack/images/postgres/Dockerfile` | 27 | Vendored image: `FROM postgres:${POSTGRES_VERSION}` (default `16-alpine`), sets `ENV PGDATA=/pgdata` to relocate the data directory off the upstream `VOLUME /var/lib/postgresql/data` so `docker commit` captures it. |

Totals: **src LOC = 472** (327 + 118 + 27).

### Test files

| File | LOC | Summary |
| --- | --- | --- |
| `packages/devstack/src/services/postgres.test.ts` | 30 | L1 unit test for `Postgres(opts)`: asserts tag-shape (`__kind === 'service'`, `__layer` defined, `__layers.length ≥ 2`) and the `databases: []` → throw guard. |

Totals: **test LOC = 30**.

### Adjacent (out of scope but referenced)

- `packages/devstack/test-setup/helpers/pg.ts` (52 LOC) — `connectPostgres(url)` test helper wrapping the npm `pg` client, lazily imported so non-L3 tests don't require the dep. Used by *future* L3 docker tests against `Postgres()`; today, no test in this repo imports it (`grep` finds 0 importers in `src/`). Worth listing because it's the only other postgres-relevant file in the workspace and it's clearly intended for this service.
- `packages/devstack/src/services/postgres.ts:51` re-exports `awaitPostgresReady` + `ensureDatabase` from `./postgres/internal.js`.

## Configuration

### `Postgres(opts)` options (`packages/devstack/src/services/postgres.ts:82-101`)

| Option | Type | Default | Effect | File:line |
| --- | --- | --- | --- | --- |
| `name` | `Name extends string` | `'postgres'` | Tag key / display title / docker container name segment / network alias prefix (`<name>-<stack>`). The literal type is preserved as a const generic so downstream LayeredTag inference keeps the name. | `services/postgres.ts:108` |
| `version` | `string` | `'16-alpine'` (`DEFAULT_VERSION`) | Build-arg `POSTGRES_VERSION` passed to the vendored Dockerfile (`FROM postgres:${POSTGRES_VERSION}`). | `services/postgres.ts:53, 109, 127, images/postgres/Dockerfile:21-22` |
| `user` | `string` | `'devstack'` (`DEFAULT_USER`) | `POSTGRES_USER` env var; also used as `-U` for `pg_isready` + `psql` + `createdb`. | `services/postgres.ts:54, 110, 159, internal.ts:22, 76, 94` |
| `password` | `string` | `stackPassword(identity.stack)` → `'pg-' + identity.stack.replace(/[^a-zA-Z0-9]/g, '')` | `POSTGRES_PASSWORD` env var; folded into the credentialed URL. The default makes the password stack-derived (and thus deterministic across resumes) but **not secret** — anyone with the app name + stack name can derive it. | `services/postgres.ts:103, 146, 160, 176` |
| `databases` | `ReadonlyArray<string>` | `['devstack']` (`DEFAULT_DATABASES`) | The first entry is passed as `POSTGRES_DB` so the image's entrypoint creates it. Subsequent entries are created via `ensureDatabase` (psql probe + createdb) once the container is ready. Must be non-empty — throws `TypeError('Postgres: \`databases\` must be non-empty')` if `length === 0`. | `services/postgres.ts:55, 111, 114-116, 161, 238-241` |
| `hostPort` | `number` | `undefined` (no host port) | When set, maps host `hostPort` → container `5432`. When unset, the container is internal-only (other docker containers must join the network to reach it). Also drives the `EndpointRegistry.kind` field (`'rpc'` when host-published, `'internal'` otherwise). | `services/postgres.ts:94, 152-155, 165, 257` |
| `extraNetworks` | `ReadonlyArray<string>` | `undefined` | Secondary docker networks the postgres container joins via `docker network connect` after start. Mirrors sui's per-network attachment. Appended to `containerNetworks` in the resolved value. | `services/postgres.ts:97-98, 166, 252` |
| `readyTimeoutMs` | `number` | `30_000` | Total wall-clock budget for the `pg_isready` retry loop. | `services/postgres.ts:100, 112, 234, internal.ts:19, 49-58` |

### Environment variables

The factory itself reads NO env vars directly. The container it spawns receives a fixed env block (`services/postgres.ts:158-162`):

- `POSTGRES_USER` — from `opts.user`.
- `POSTGRES_PASSWORD` — from `opts.password` or derived `stackPassword(identity.stack)`.
- `POSTGRES_DB` — from `databases[0]` (the upstream image's entrypoint creates this one on first boot; subsequent entries handled by `ensureDatabase`).

`Identity.stack` and `Identity.app` feed the network name + alias + default-password computation but come through the engine's `Identity` service (`services/postgres.ts:175-189`), not directly from env.

### CLI flags

`Postgres()` exposes no CLI flags of its own. CLI-level options affecting it indirectly:

- `--stack` / `DEVSTACK_STACK` — drives `Identity.stack`, which feeds `networkAlias` (`<name>-<stack>`), `networkName` (`devstack-<app>-<stack>-postgres`), and the default password.
- `devstack wipe` / `devstack prune` — destroys named volumes + containers + networks bearing the stack labels (`cli/commands/wipe.ts:1-26`), which includes the postgres container, the per-stack `devstack-<app>-<stack>-postgres` network, and any named volumes (none for postgres today — see `Persistence model`).

## Capabilities CONSUMED

### Engine services

- `Identity` (`services/postgres.ts:175`, also referenced at `:146-147`, `:177`, `:189`) — supplies `identity.stack` (used in network name, alias, default-password) and `identity.app` (used in network name).
- `EndpointRegistry` indirectly — via `publishEndpoint(...)` (`services/postgres.ts:49, 254-258`); resolves the `kind` ('rpc' vs 'internal') based on `hostPort`.
- `PostgresStateRegistry` indirectly — via `publishPostgresState(...)` (`services/postgres.ts:49, 260-268`). Class defined at `engine/registries.ts:280-283`; Live layer + publish exported at `engine/registries.ts:360-363`; bundled into `RegistriesLive` at `engine/registries.ts:397`.

### Engine resources

- Docker engine (`engine/docker/*` via `import * as Docker from '../engine/docker/index.js'` at `services/postgres.ts:44`): `Docker.networkCreate` (line 193), `Docker.exec` (line 22, 74, 94 of `internal.ts`).
- Plugin-author primitive `runDockerContainer` (`services/postgres.ts:45, 143-170`) — the inline-Effect flavor of `dockerContainer`, which itself wraps `Docker.run` + image build + finalizer + ready probe.
- `setPhase` from `advanced/tag.js` (`services/postgres.ts:41, 205, 233, 238`) — emits phase transitions `'starting postgres'` → `'awaiting ready'` → `'ensuring databases'` for TUI.
- `tag` + `provide` from `advanced/tag.js` (`services/postgres.ts:41, 172, 312`) — composite-tag construction + projection-layer wiring.
- `makeService` from `advanced/make-service.js` (`services/postgres.ts:42, 326`) — stamps the `'postgres'` plugin / `'service'` kind discriminators.
- `Context.Service` from `effect` (`services/postgres.ts:43, 78-80`) — `PostgresTag` class identity.

### Errors

- `PostgresError` (`engine/errors.ts:374-386`) — the typed failure shape. Phases: `'image' | 'port-alloc' | 'container' | 'ready' | 'createdb' | 'postgres'` (`engine/phases.ts:116-124`). The factory wraps every `DockerError` / `ReadyProbeError` from `runDockerContainer` and `Docker.networkCreate` into `PostgresError({phase: 'container', …})` (`services/postgres.ts:194-231`). `internal.ts` wraps every `DockerError` from `Docker.exec` into `PostgresError({phase: 'ready' | 'createdb', database, …})` (`internal.ts:23-31, 81-90, 95-104`). The outermost `Effect.catch` translates any unmatched cause into `PostgresError({phase: 'postgres', …})` (`services/postgres.ts:283-291`).
- `stringifyCause` (`engine/stringify-cause.js`, imported at `services/postgres.ts:48`) — used in the outer catch to render unknown causes into the `message` field.

### Runtime resources

- Vendored Dockerfile context: `packages/devstack/images/postgres/Dockerfile`, resolved at runtime via `new URL('../../images/postgres/', import.meta.url).pathname` (`services/postgres.ts:122`).
- Per-stack docker network `devstack-<app>-<stack>-postgres` (slugified — non-`[a-zA-Z0-9-]` replaced with `-`) (`services/postgres.ts:148-151, 189-192`).
- Postgres container, named per `runDockerContainer`'s naming convention (key = `${name}.container`, e.g. `postgres.container`) (`services/postgres.ts:144`).

### Effect / Layer / Context machinery

- `Effect`, `Effect.gen`, `Effect.fail`, `Effect.catchTag`, `Effect.catch`, `Effect.withSpan`, `Effect.retry`, `Effect.timeoutOrElse` (across `services/postgres.ts` + `internal.ts`).
- `Schedule.exponential` + `Schedule.either` + `Schedule.spaced` (`internal.ts:4, 11-13`) — pg_isready retry schedule.
- `Context.Service` for `PostgresTag` (`services/postgres.ts:78-80`).

### npm dependencies (transitively)

- `effect` — `Effect`, `Schedule`, `Context`.
- `pg` is **NOT** a dependency of the production code path. It is only imported via `test-setup/helpers/pg.ts` (lazy `await import('pg').catch(...)`) for L3 docker tests, none of which exist yet.

### Service-level dependencies declared via `upstreamKeys`

- **None.** `upstreamKeys: []` (`services/postgres.ts:308`). Postgres is declared a topological leaf — its body reads only `Identity`, `Docker`, etc., all satisfied by the engine's `InfraLive`. No sibling service is required.

## Capabilities PRODUCED

### TypeScript exports (from `services/postgres.ts`)

- `Postgres` (named const, line 105) — the factory function with a `const Name extends string` generic.
- `PostgresOptions<Name>` (interface, line 82).
- `PostgresTag` (class, line 78) — `Context.Service<PostgresTag, Postgres>` with identifier `'@devstack/PostgresTag'`.
- `Postgres` (interface, line 62) — the resolved-service shape: `{name, user, password, databases, endpoint, containerNetworks, networkAlias, url(db)}`. Re-exported from `services/index.ts:90-94` as type alias `PostgresShape`.

Re-exported from the package root at `src/index.ts:67-69` (`Postgres`, `PostgresOptions`, `PostgresTag`).

### Endpoints (EndpointRegistry)

- `EndpointName.POSTGRES` (`'postgres'`) — published with URL `postgres://<networkAlias>:5432` (plain, no credentials), kind `'rpc'` when `hostPort` set, else `'internal'` (`services/postgres.ts:254-258`, `runtime/endpoint-names.ts:90-94, 137`).

Manifest projection: `services.postgres.endpoint.url` (`runtime/manifest-schema.ts:130-138`, `runtime/service.ts:145-162`, `runtime/endpoint-names.ts:92`).

### State-store entries (PostgresStateRegistry)

Shape (`engine/registries.ts:101-118`):

```ts
interface PostgresStateRecord {
  name: string;
  user: string;
  password: string;          // in-memory only; manifest never copies
  endpoint: string;          // plain `postgres://<alias>:5432`, no creds
  containerNetwork: string;  // `devstack-<app>-<stack>-postgres` (slugified)
  networkAlias: string;      // `<name>-<stack>` (slugified)
  databases: ReadonlyArray<string>;
}
```

Published via `publishPostgresState(...)` (`services/postgres.ts:260-268`) which appends to the `PostgresStateRegistry` snapshot (each call appends; `runtime/service.ts:299` reads via `postgresProjection.read(projectionCtx)` which uses the LAST record — consistent with other registries' last-wins semantics).

### Manifest projection

`PostgresManifest` shape (`runtime/manifest-schema.ts:130-138`):

```ts
{
  user: string,
  endpoint: EndpointEntry,         // {url: string}
  containerNetwork: string,
  networkAlias: string,
  databases: ReadonlyArray<string>,
}
// `password` deliberately omitted
```

Projected by `postgresProjection` (`runtime/service.ts:145-162`) using `defineServiceProjection`. Surfaces in the on-disk manifest at `services.postgres.*`. The projection is purely a field copy — `state.endpoint` is already plain by the registry shape contract, so no per-call password-stripping step exists.

### Flat endpoint table (read-stack-context)

When the manifest contains `services.postgres`, `runtime/read-stack-context.ts:113-114` adds `flat[EndpointName.POSTGRES] = manifest.services.postgres.endpoint` so callers can dial `EndpointName.POSTGRES` via the flat lookup helper.

### Files written

**None on the host filesystem.** Postgres does not write to the canonical `runtime/<service>/` tree (unlike Sui keystore, Walrus deploy outputs, Seal master-key env). All state is inside the container's writable layer at `/pgdata`.

### Container images / volumes

- Image: built from `packages/devstack/images/postgres/Dockerfile`, tagged by `dockerImage` content-addressing under the `runDockerContainer` plugin primitive (image layer wired into `composite.__layers` via `extraLayers: container.imageLayers` at `services/postgres.ts:294`).
- Container: name `postgres.container` (composed by `runDockerContainer`'s naming convention with the supervisor-stamped `devstack.app` / `devstack.stack` / `devstack.action` labels).
- Volume: **none**. The container writes directly to the writable layer at `/pgdata`, by design — see `Hard requirements / invariants` below.
- Per-stack docker network: `devstack-<app>-<stack>-postgres` (created by `Docker.networkCreate` at `services/postgres.ts:193`, labeled by the engine for `wipe` to find).

### CLI commands registered

**None.** `Postgres()` registers no CLI commands; standard `devstack up` / `apply` / `wipe` / `prune` / `snapshot save` handle it generically via the docker label-filter sweep.

### Routes registered

**None.** Postgres does not join the shared `devstack-router` traefik network. `dockerContainer.routing` is unused for this primitive — Postgres is reached either by in-network DNS (`<networkAlias>:5432`) or via the optional `hostPort` direct mapping; there's no HTTP route to publish.

## Lifecycle

### Startup sequence (`services/postgres.ts:174-279`)

1. **Resolve Identity** (`yield* Identity` — line 175). Pulls `identity.stack` and `identity.app` from the engine.
2. **Compute deterministic strings**: password (line 176), network alias (line 177), network name (line 189) — all slugified to docker's name charset.
3. **`Docker.networkCreate(networkName)`** (line 193) — creates `devstack-<app>-<stack>-postgres` if it doesn't already exist. Idempotent; failure wrapped into `PostgresError({phase: 'container'})`. Runs BEFORE the container starts — must, because `runDockerContainer` passes `network: networkName` to `docker run`.
4. **`setPhase('starting postgres')`** (line 205) — TUI annotation.
5. **`container.effect`** (lines 212-231) — invokes the `runDockerContainer` primitive, which:
   - Builds/tags the image (via the `imageLayers` lifted to `extraLayers`).
   - Spawns the container with `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` env, `network: devstack-…-postgres`, `networkAlias: <name>-<stack>`, optional `ports: {<hostPort>: 5432}`, optional secondary network attachments.
   - Registers the cycle-teardown `docker stop` finalizer.
   - Returns `{containerId, …}`. **No ready probe is run by `runDockerContainer` itself** — Postgres deliberately handles ready out-of-band because the `dockerContainer.ready` channel supports HTTP/TCP/log probes only, and a `docker exec pg_isready` probe doesn't belong on the public primitive surface (`services/postgres.ts:210-215`).
   - Failures: `DockerError` → `PostgresError({phase: 'container'})`; `ReadyProbeError` (from any other ready hook upstream of the `runDockerContainer` call, e.g. image-build readiness) → `PostgresError({phase: 'container'})`.
6. **`setPhase('awaiting ready')`** (line 233).
7. **`awaitPostgresReady(containerId, user, databases[0], readyTimeoutMs)`** (line 234, body in `internal.ts:15-62`):
   - Loop: `docker exec <id> pg_isready -U <user> -d <database>`.
   - Schedule: `Schedule.exponential('100 millis', 1.5)` `Schedule.either` `Schedule.spaced('2 seconds')` — exponential backoff capped at 2-second steady-state retries.
   - Total deadline: `readyTimeoutMs` (default 30_000) via `Effect.timeoutOrElse`.
   - Probes the FIRST database only (the one created by the upstream entrypoint via `POSTGRES_DB`).
   - Failures: `Docker.exec` errors → `PostgresError({phase: 'ready', database})`; non-zero exit → `PostgresError({phase: 'ready', database, exitCode, stdout, stderr})`; total timeout → `PostgresError({phase: 'ready', database, message: 'postgres container never became ready within Nms'})`.
8. **`setPhase('ensuring databases')`** (line 238).
9. **`ensureDatabase` loop** (lines 239-241, body in `internal.ts:68-118`): for `i = 1; i < databases.length; i++`:
   - `docker exec <id> psql -U <user> -tAc "SELECT 1 FROM pg_database WHERE datname = '<dbName>'"`.
   - If exit 0 and stdout.trim() === `'1'`: skip (already exists).
   - Else: `docker exec <id> createdb -U <user> <dbName>`. Non-zero exit → `PostgresError({phase: 'createdb', database, exitCode, stdout, stderr})`.
   - **The first database is NEVER touched here** because the upstream image's entrypoint already created it via `POSTGRES_DB`.
10. **Compose URLs + handle**:
    - `credentialedEndpoint = postgres://<user>:<password>@<networkAlias>:5432` (line 249).
    - `plainEndpoint = postgres://<networkAlias>:5432` (line 250).
    - `url(db) = ${credentialedEndpoint}/${db}` (line 251).
    - `containerNetworks = [networkName, ...(opts.extraNetworks ?? [])]` (line 252).
11. **Publish endpoint** (lines 254-258): `EndpointName.POSTGRES` → plain URL, kind `'rpc'` or `'internal'`.
12. **Publish state record** (lines 260-268): full record including password into `PostgresStateRegistry`.
13. **Return** the resolved `Postgres` shape (lines 270-279).

After return, the composite's outer wrapper (`provide(PostgresTag, …)` at line 312) makes the resolved `Postgres` available to anyone yielding `PostgresTag` or yielding the `Postgres()` factory return value directly.

### Concurrency / parallelism

- `Postgres` has `upstreamKeys: []`, so the topo scheduler treats it as a leaf — it can start in parallel with any other independent leaf in the same compose graph (e.g. Walrus, Seal). DeepbookIndexer + DeepbookServer wait for it because they declare `opts.postgres` in their `upstreamKeys` (`services/deepbook/indexer.ts:241-246`, `services/deepbook/server.ts:293-299`).
- The `ensureDatabase` loop is sequential by `for`-loop (line 239) — there's no `Effect.all`-style parallel fan-out. Acceptable because each step is a one-shot exec.

### Ready criteria

A Postgres tag resolves once **all** of:

1. `Docker.networkCreate` returned successfully.
2. `runDockerContainer` returned a `containerHandle` (container running by `docker inspect`).
3. `pg_isready -U <user> -d <databases[0]>` returned exit 0 inside the container.
4. Every `databases[i]` for `i ≥ 1` either already exists or was created by `createdb`.
5. `publishEndpoint` + `publishPostgresState` completed.

The downstream `DeepbookIndexer` / `DeepbookServer` yields `opts.postgres` to get the resolved `Postgres` value, then reads `.containerNetworks[0]` (the primary per-stack postgres network) and uses `.url(db)` to build their `DATABASE_URL` (`services/deepbook/indexer.ts:103-107`, `services/deepbook/server.ts:128-133`). The handoff happens after step 5.

### Restart behavior (warm resume)

- **Network create** is idempotent — `Docker.networkCreate` swallows "network exists" failures.
- **Container reuse**: `runDockerContainer` (via `Docker.run`) performs the standard reuse-if-image-matches probe — a container that already exists with the right image and labels is adopted without re-spawning. Writable layer at `/pgdata` (schema + rows + WAL) is preserved across `docker rm`-less cycles because cycle teardown via `docker stop` (not `rm`) keeps the writable layer (`services/postgres.ts:31`-style comments and `images/postgres/Dockerfile:18-19`).
- **Ready probe** runs every cycle — there's no state-store cache shortcut around `awaitPostgresReady`.
- **`ensureDatabase` short-circuit**: each cycle re-runs the `psql -tAc 'SELECT 1 FROM pg_database …'` probe per non-first database; on warm resume the probe sees the existing rows and skips `createdb`. The header comment at `services/postgres.ts:11-13` references a state-store cache at `postgres/databases/v1/<stack>/<name>/<dbHash>` recording the ensured list to short-circuit the probe entirely — **but no such cache write is implemented in the current code**. See `Open questions` below.

### Teardown

- `docker stop` finalizer is attached by `runDockerContainer` to the layer scope. On supervisor shutdown (or `r` rebuild), the finalizer fires.
- `stopGraceSeconds` is **not** configured by `Postgres()` (no override is passed to `runDockerContainer`). The sui-indexer-db sidecar by contrast sets `stopGraceSeconds: 20` (`services/sui.ts:924`) because "Postgres needs a clean shutdown to avoid `recovery mode` on next start. 20s lets it finalize any open WAL segment." See `Pain points today` for this discrepancy.
- Container is left in place after `docker stop`; its writable layer is recoverable on the next `docker start` (handled by `Docker.run`'s reuse probe). A subsequent `devstack wipe` removes the container outright via label-filter sweep (`cli/commands/wipe.ts:1-26`).

## Hard requirements / invariants

1. **Vendored Dockerfile must relocate PGDATA off the upstream VOLUME**, or snapshots are silently empty.
   - The upstream `postgres:*` image declares `VOLUME /var/lib/postgresql/data`. Docker excludes VOLUME paths from `docker commit`'s captured layer.
   - `images/postgres/Dockerfile:27` sets `ENV PGDATA=/pgdata`; postgres's entrypoint reads PGDATA at startup and creates/chowns the dir, landing all writes in the container's writable layer.
   - This is the load-bearing reason a vendored image exists at all (image header `images/postgres/Dockerfile:3-19`).
   - **No test asserts this directly today** — the closest assertion is the L3 docker test header for snapshot/restore (`engine/snapshot-deepbook.docker.test.ts:31, 47` — both `.todo`), and the snapshot-pause behavior asserted at `engine/snapshot.test.ts:505-525`.

2. **`databases` must be non-empty** (`services/postgres.ts:114-116`). Asserted at `postgres.test.ts:27-29`.

3. **Container is paused around `docker commit` during snapshot save** (`engine/snapshot.ts:510-533`). Without this, the writable layer captures postgres mid-WAL-fsync, producing snapshots that need recovery on next boot or fail to open entirely (`engine/snapshot.ts:512-515` comment). Pause/unpause is handled in the snapshot engine, not in `Postgres()` itself — but `Postgres()` participates by virtue of being included in `opts.containers`. **OPEN QUESTION**: nothing in `services/postgres.ts` or `services/postgres/internal.ts` registers the container into the snapshot opts; the supervisor enumerates containers via docker labels.

4. **`endpoint` field on `PostgresStateRecord` must be the PLAIN URL** (no `<user>:<password>@`). Enforced at registry-shape level by the comments at `engine/registries.ts:104-114`. Asserted at `runtime/service.test.ts:181-199` ("manifest postgres endpoint URL never contains credentials"): the test publishes a record with `password: 'pgcred-secret'` and asserts the projected manifest's `services.postgres.endpoint.url` contains neither `@` nor `pgcred-secret`.

5. **Password field on `PostgresStateRecord` must NOT be copied into the manifest projection**. Asserted by the same Wave-2 test (`runtime/service.test.ts:181-199`). Structurally enforced by `runtime/manifest-schema.ts:136`'s comment "`password` deliberately omitted" and `runtime/service.ts:148-161` (the projection does not read `state.password`).

6. **Per-stack network name MUST agree across the two callsites** that compute it (`services/postgres.ts:148-151` inside the `runDockerContainer` builder, and `:189-192` in the outer `Effect.gen`). Both use `devstack-<app>-<stack>-postgres` with the same slugification. If they ever diverge, the network would be created with one name but the container would attempt to join a different name. There's no test asserting this beyond the L1 factory-shape test; a divergence would surface as a docker error at run time.

7. **`runDockerContainer` failure must be translated to `PostgresError` at the SURROUNDING tag body**, not at the primitive's E channel, because the tag form's E channel surfaces only at Layer construction time where the outer `catchTag` can't observe it (`services/postgres.ts:131-138` comment + `:213-231` for the actual `catchTag('DockerError')` / `catchTag('ReadyProbeError')` calls).

8. **`Effect.catchTag('PostgresError', Effect.fail)` MUST precede `Effect.catch(unknown → PostgresError)`** in the outer pipe (`services/postgres.ts:282-291`). Without the explicit `catchTag` re-fail, the generic `Effect.catch` would re-wrap an already-typed `PostgresError`, producing nested `cause: PostgresError({cause: PostgresError(...)})` in error reports.

9. **First database is NEVER passed to `ensureDatabase`**. The `for` loop starts at `i = 1` (`services/postgres.ts:239`) because the upstream image's entrypoint already created `databases[0]` via the `POSTGRES_DB` env. If the loop ran from `0`, the probe would harmlessly find the row but emit unnecessary docker execs.

10. **`upstreamKeys: []` declaration is load-bearing** (`services/postgres.ts:303-308`). Without it, the topo scheduler infers upstreams from yields and might mis-schedule. Postgres's body reads `Identity` + `Docker` (engine-level Context.Services satisfied by `InfraLive`) — not any stack member tag. The comment block (`:303-307`) explicitly justifies the empty array.

11. **`PostgresStateRegistryLive` MUST be in the supervisor's `RegistriesLive` merge** (`engine/supervisor.ts:82, 360`; also `engine/registries.ts:397`). Without it, `runtime/service.ts::gatherManifest` (which requires `PostgresStateRegistry` via its `Effect`-channel type at `runtime/service.ts:246`) fails with `Service not found: @devstack/PostgresStateRegistry` at finalization — even when no `Postgres()` factory is in the user's stack. The comment at `engine/supervisor.ts:355-358` explicitly calls this out.

12. **Image layer must be lifted into `extraLayers`** (`services/postgres.ts:294`: `extraLayers: container.imageLayers`). Without this the supervisor schedules the image build at the wrong time and the container start races the image existence.

## Failure modes

| Trigger | Current behavior | Recovery |
| --- | --- | --- |
| `Docker.networkCreate` fails (e.g. IPAM pool exhausted) | Wrapped into `PostgresError({phase: 'container', message: 'failed to create postgres docker network ...'})` and the tag's effect fails (`services/postgres.ts:193-203`). | User must clean up stale networks: `docker network prune` or `devstack prune`. No automatic retry. |
| Image build fails | `runDockerContainer.imageLayers` produces a `DockerError` at layer-build time, surfacing in the tag's E channel as a `PostgresError({phase: 'container', message: 'failed to start postgres container', cause})` because the layer build is part of `container.effect`. | Re-run; if persistent, requires user to inspect the build log. |
| `Docker.run` (container start) fails | Wrapped into `PostgresError({phase: 'container', message: 'failed to start postgres container'})` (`services/postgres.ts:213-220`). | Same as image build. |
| `ReadyProbeError` from `runDockerContainer` (e.g. image-build readiness) | Wrapped into `PostgresError({phase: 'container', message: 'postgres container failed during ready probe'})` (`services/postgres.ts:222-230`). | Re-run; surface log tail. |
| `pg_isready` returns non-zero exit | Each iteration fails with `PostgresError({phase: 'ready', database, exitCode, stdout, stderr})`. Retried by `Effect.retry(readyRetry)` until the total `timeoutMs` deadline (`internal.ts:34-46`). | Retry loop is automatic; total timeout default 30s. |
| `pg_isready` total timeout (30s default) | Final fail: `PostgresError({phase: 'ready', database, message: 'postgres container never became ready within Nms'})` (`internal.ts:49-58`). | User must inspect container logs (`docker logs <id>`) — typical causes: image init still in progress on slow disk, PGDATA permission issue, or postgres bound to an unexpected port. |
| `Docker.exec` of `psql` existence-check fails | `PostgresError({phase: 'createdb', database, message: 'psql exec (existence check) failed'})` (`internal.ts:80-89`). | No automatic retry; tag fails. |
| `createdb` returns non-zero exit | `PostgresError({phase: 'createdb', database, exitCode, stdout, stderr})` (`internal.ts:105-116`). | Tag fails; user must inspect. Typical cause: collision with an existing-but-different-case database name (postgres is case-insensitive at the SQL identifier layer). |
| Unknown / unmatched failure | Outer `Effect.catch` (`services/postgres.ts:283-291`) translates the cause into `PostgresError({phase: 'postgres', message: stringifyCause(cause), cause})`. | Phase `'postgres'` is the catch-all sentinel — investigating these requires reading the underlying cause. |

## Persistence model

| Class | What survives |
| --- | --- |
| **State-store entries** (in `state.json` under `.devstack/`) | **None directly.** `Postgres()` calls `publishPostgresState` which appends to the in-memory `PostgresStateRegistry`. The registry is consumed by `gatherManifest` → `runtime/manifest-emit.ts` to write the on-disk manifest, but the registry contents themselves don't persist between supervisor runs — they're rebuilt each cycle by re-running the `Postgres()` tag body. The factory header comment at `services/postgres.ts:11-13` describes a planned cache at `postgres/databases/v1/<stack>/<name>/<dbHash>` recording the ensured-databases set; this cache is **NOT** implemented. |
| **On-disk paths** | **None.** No bind mounts, no host-side runtime tree, no `runtime/<service>/` directory. |
| **Container writable layer at `/pgdata`** | Schema, rows, roles, on-disk WAL. Preserved across `docker stop` / `docker start` cycles by the cycle-teardown convention (no `docker rm` between cycles). Vendored Dockerfile's `ENV PGDATA=/pgdata` is what makes this work — the upstream `VOLUME /var/lib/postgresql/data` would shunt writes to an anonymous volume that `docker commit` ignores. |
| **Snapshot capture** | The entire `/pgdata` writable layer is captured by `docker commit` at `snapshot save` time, paused around the commit to ensure WAL quiescence (`engine/snapshot.ts:510-533`). On restore, the loaded snapshot image is retagged to the supervisor's content-addressed base tag (`engine/snapshot.ts:88-93`) so the next `Docker.run` reuse probe adopts it. The on-disk manifest also rides via `runtime.tar` even though Postgres doesn't write to `runtime/`, because the runtime tar is a single capture of the whole `runtime/` dir. |
| **`devstack wipe`** | Removes the container outright (label filter on `devstack.app` + `devstack.stack`). Removes the per-stack network `devstack-<app>-<stack>-postgres`. Removes any named volumes (none for Postgres today). All schema + rows in `/pgdata` are lost — the next `up` boots from a fresh `POSTGRES_DB`-initialized container. |
| **`devstack prune`** | Same as wipe but cross-stack via the shared label filter. |
| **Process-local only** | The `password` field on the resolved `Postgres` value. While the password is also stored in `PostgresStateRecord.password`, that registry's snapshot is in-memory only — never written to disk, never copied to the manifest, never serialized into state.json. The credentialed `endpoint` field on the resolved value is likewise process-local; only the plain URL escapes to the manifest. |

## Modes & variants

Postgres is **single-mode** today.

There is no live mode (connect to a managed Postgres), no fork mode (replicate from a remote db), no cluster mode (replicas), no per-environment branching. The only mode-like axis is the `hostPort` option, which toggles `EndpointRegistry.kind` between `'rpc'` (host-published) and `'internal'` (in-network only) — but that's a single knob inside one mode, not a mode in the substantive sense.

The factory itself has no `mode` parameter. Compare with `Sui()`, which branches on `localnet` vs `fork` vs `live` (external RPC wrapper). For Postgres, every invocation runs the same docker-container path against the vendored image.

**OPEN QUESTION**: A live mode (wrap a managed Cloud SQL / Neon / RDS instance and surface its URL into the manifest without spawning a container) seems plausible given the deepbook indexer + server already factor out the `DATABASE_URL` env from the `Postgres` ref. The Wave-2 plain-endpoint split (PostgresStateRecord.endpoint without credentials, password held separately) anticipates a future where consumers don't need a container at all — but nothing in current code branches on it.

## Test coverage

### `packages/devstack/src/services/postgres.test.ts` (30 LOC)

L1 unit test, factory shape only — no container starts, no docker, no Effect runtime.

| `describe` | `it` | Asserts | Cite |
| --- | --- | --- | --- |
| `Postgres factory shape (P2.T1)` | `returns a tag-shaped value with __layer + __kind=service` | `typeof pg === 'function'`; `pg.__kind === 'service'`; `pg.__layer` defined; `pg.__layers.length ≥ 2` (the second layer is the image-build layer threaded via `composite.extraLayers`). | `postgres.test.ts:11-25` |
| `Postgres factory shape (P2.T1)` | `throws when databases array is empty` | `Postgres({databases: []})` throws with message matching `/non-empty/`. | `postgres.test.ts:27-29` |

### Indirect coverage (other test files)

| File | What it asserts about Postgres |
| --- | --- |
| `packages/devstack/src/runtime/service.test.ts:181-199` | "Wave-2 invariant: manifest postgres endpoint URL never contains credentials." Publishes a fake `PostgresStateRecord` with `password: 'pgcred-secret'`, gathers manifest, asserts `services.postgres?.endpoint.url` is defined and contains neither `@` nor the password literal. Pinned at the registry-shape level by the projection. |
| `packages/devstack/src/index.test.ts:35-36` | Asserts `Postgres` and `PostgresTag` are exported from the package root. |
| `packages/devstack/src/engine/errors.test.ts:32, 88` | `PostgresError` is in the tagged-error class list and round-trips through the standard error class smoke test. |
| `packages/devstack/src/engine/supervisor.test.ts:296-299` | `flattenStackMembers` orders a fake stack with members `['sui', 'postgres', 'walrus']` deterministically — confirms postgres slots into the topo order alongside other leaves. |
| `packages/devstack/src/engine/supervisor.test.ts:374, 382` | TUI entry test referencing `postgres` as a `stopped` row. |
| `packages/devstack/src/engine/docker/wrap.test.ts:5` | Header comment cites `PostgresError` as the canonical example of a tagged error a service promises. |
| `packages/devstack/src/runtime/manifest-emit.test.ts:29, 58` | Imports `PostgresStateRegistryLive` to provide the registry layer for manifest-emit tests; doesn't assert postgres-specific behavior. |
| `packages/devstack/src/runtime/extras-consistency.test.ts:29, 55` | Same — provides the registry layer. |
| `packages/devstack/src/codegen/emitters/integration.test.ts:35, 66` | Same — provides the registry layer for codegen integration. |
| `packages/devstack/src/codegen/emitters/dapp-kit-config.test.ts:26, 53` + `.fork.test.ts:30, 51` | Same. |
| `packages/devstack/src/codegen/emitters/deepbook-config.test.ts:31, 60` | Same. |
| `packages/devstack/src/codegen/emitters/stack-handle.test.ts:27, 53` | Same. |
| `packages/devstack/src/engine/snapshot.test.ts:505-525` | Asserts the `snapshot()` engine pauses containers around `docker commit` — header comment cites "no RocksDB / postgres mid-WAL-fsync corruption" as the invariant. |
| `packages/devstack/src/engine/snapshot-deepbook.docker.test.ts:31, 47` | `it.todo('indexer last-checkpoint cursor preserved in Postgres after restore')` — Phase-5 deferred. |
| `packages/devstack/src/engine/snapshot.docker.test.ts:182-185` | Comment notes the custom postgres image first-time build is ~30s; subsequent runs hit cache. The test itself exercises a full apply → snapshot → wipe → restore cycle that includes Postgres as one of the containers. |
| `packages/devstack/src/services/deepbook/server.test.ts:13-51` | Uses a `stubTag()` standing in for `Postgres` to typecheck `DeepbookServer(opts)`'s shape. Doesn't test Postgres itself, but locks in the consumer-side shape. |
| `packages/devstack/src/advanced/plugin-author/docker-container.test.ts:6, 54` | Asserts the bare-string `'postgres:15'` is NOT assignable to `DockerContainerImage` (intentional type-narrow). |

### Missing tests (OPEN QUESTIONS)

- **No L3 docker test for `Postgres()` itself** exists. The factory's header comment (`services/postgres.ts:1-5`) explicitly references `postgres.docker.test.ts` for "full lifecycle (container boot, pg_isready probe, CREATE DATABASE idempotency) is covered at L3" — `find` confirms no such file. The L1 test cites "P2.T1" suggesting a test-plan numbering, but `grep -rn "P2.T" packages/devstack/src` shows P2.T8 referenced at `engine/snapshot-deepbook.docker.test.ts:31` ("snapshot/restore preserves rows in Postgres") as `.todo` — the L3 plan was deferred to Phase 5.
- **No test asserts the PGDATA-relocation invariant**. A regression that reverted `images/postgres/Dockerfile:27` would silently produce empty snapshots without flagging in CI. The only proxy is the snapshot-pause assertion at `engine/snapshot.test.ts:505` which is about WAL quiescence, not about VOLUME exclusion.
- **No test asserts the `ensureDatabase` idempotency cycle**. The factory comment claims a state-store cache short-circuits the probe — no test would catch the absence of that cache.

## Pain points today

1. **`postgres.docker.test.ts` is referenced but doesn't exist.** Header comment at `services/postgres.ts:3-5`: "Full lifecycle (container boot, pg_isready probe, CREATE DATABASE idempotency) is covered at L3 by `postgres.docker.test.ts`." `find` confirms no such file. The L3 coverage was deferred to the Phase-5 integration sweep (`engine/snapshot-deepbook.docker.test.ts:14-16`).
2. **`stopGraceSeconds` is not set.** The sui-indexer-db sidecar explicitly passes `stopGraceSeconds: 20` (`services/sui.ts:924`) with the rationale "Postgres needs a clean shutdown to avoid `recovery mode` on next start." `Postgres()` does NOT pass it — so the default 10s applies. With the docker default, a stateful postgres can be SIGKILL'd (exit 137) on cycle teardown, leaving the writable layer in an unclean state that the next boot must recover. The two callsites disagree.
3. **The factory's header comment describes a state-store cache that does not exist.** `services/postgres.ts:11-13` cites "State-store cache at `postgres/databases/v1/<stack>/<name>/<dbHash>` records the ensured list so a no-op cycle short-circuits the probe entirely." No such cache is written or read in the current code — every cycle re-runs `psql -tAc 'SELECT 1 FROM pg_database …'` per non-first database.
4. **Network name is computed twice with identical logic.** `services/postgres.ts:148-151` (inside the `runDockerContainer` builder) and `:189-192` (in the outer `Effect.gen`) both recompute `devstack-<app>-<stack>-postgres` with the same slugification. The comment at `:184-188` acknowledges "Both call sites agree on the `devstack-<app>-<stack>-postgres` shape" — but agreement is enforced by convention only, not by a shared helper.
5. **Sui's embedded indexer-db duplicates Postgres()'s machinery.** `services/sui.ts:119-137, 515-566, 776-784, 899-945` reproduces in-line:
   - The vendored-Dockerfile build (`indexerDbImage` at `services/sui.ts:776-784` reuses the SAME `images/postgres/Dockerfile`).
   - The `pg_isready` probe with the SAME schedule + 30s timeout (`services/sui.ts:515-566` vs `services/postgres/internal.ts:11-62`).
   - The `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` env wiring.
   - Yet it never participates in `PostgresStateRegistry` or the `services.postgres.*` manifest section, because the sui composite owns it privately.
   This is the largest internal duplication in the package today. See `Opportunities noticed`.
6. **`pg` is referenced as a test helper dep but not in `package.json`.** `test-setup/helpers/pg.ts:31-39` lazily imports `pg` with a `catch(() => undefined)` fallback and a friendly error pointing the test author at `pnpm add -D pg`. No test currently imports the helper, so the dep gap has no observable effect — but the helper is dead code until the L3 test lands.
7. **No connection-pooling story.** Consumers build `postgres://<u>:<p>@<alias>:5432/<db>` URLs and dial them with whatever client driver they bring (in-container `pg` for the deepbook indexer, Rust for the server). There's no PgBouncer, no shared pool, no max-connection guidance — fine for two consumers, but a footgun if Postgres becomes a hub for more services.
8. **No init SQL hook on the factory surface.** The header comment (`services/postgres.ts:11`) says "the service registers each requested database via `CREATE DATABASE` on every cycle; existing databases are skipped" — but there's no way to run a one-shot DDL script (e.g. `CREATE EXTENSION pg_trgm`, role grants beyond the default `POSTGRES_USER`). Today, consumer services (deepbook indexer's Rust binary) own their own schema migrations.
9. **`password` field is on the public `Postgres` shape.** `services/postgres.ts:65-68`: "Password is exposed on the service shape for in-process consumers (the indexer container reads it to build its `DATABASE_URL`)." This is a deliberate choice but means any debug log of the resolved `Postgres` value leaks the password into stdout. The `display:` projection (`services/postgres.ts:298-302`) hides it, but `console.log(resolved)` would not.
10. **Layer-extension dance is stamped twice.** `services/postgres.ts:319-326`: "Stamp the projection-layer-extended `__layers` array onto the composite first, then re-assert the plugin/kind discriminators via `makeService`. The inner `tag(...)` call already set both fields via its `kind` / `plugin` options; the second stamp keeps parity with the other migrated services and stays idempotent." Acknowledged by the comment to be a stylistic alignment, not a load-bearing step.

## Open questions

- **Does `Postgres()` need a state-store cache for the ensured-databases probe?** The factory header comment claims one (`services/postgres.ts:11-13`) but no code implements it. Either the comment is stale (the probe is cheap enough to not bother) or the implementation was dropped.
- **Is there a fork mode planned for Postgres?** No code, no notes, no flag — but the Wave-2 plain-endpoint split (record holds plain URL + password separately) anticipates a future where consumers could dial an externally-managed Postgres without spawning a container. **Verified single-mode today.**
- **Who owns the indexer's schema migration?** The DeepBook indexer Rust binary creates its own schema in the postgres it's given. Today, that's an implicit contract — `Postgres()` ensures the database exists but never the schema. If the indexer changes its schema, `Postgres()` is unaware.
- **Why is the password derivation `pg-${stackId.replace(/[^a-zA-Z0-9]/g, '')}` instead of a random+stored value?** Trade-off: deterministic across resumes (no state-store dance) vs anyone with `app + stack` can compute it. Acceptable for a dev tool, but if Postgres ever exposes a host port in a multi-user dev environment, this is a footgun.
- **Should the L1 test add an assertion for the `password` field on the resolved value?** Currently no test exercises the resolved-handle shape (no `Effect.runPromise(pg)` in tests). The shape is documented in the `Postgres` interface but the runtime behavior is untested.
- **Why is the `Postgres` interface's `password` field on the public shape but stripped from the manifest?** See pain point #9. The split is justified for in-container consumers building `DATABASE_URL` but creates a leak surface.
- **Does the snapshot engine include the postgres container automatically?** The factory does not register itself with snapshot opts; the supervisor enumerates containers via docker labels. Worth verifying this enumeration captures the Postgres container reliably.
- **Why does the sui-indexer-db sidecar not flow through `Postgres()`?** Pure historical sequencing? Or is there a load-bearing reason? See `Opportunities noticed` below.
- **Is the `addHosts` default applied?** `runDockerContainer` defaults `addHosts: ['host.docker.internal:host-gateway']` (`advanced/plugin-author/docker-container.ts:267-272`). `Postgres()` doesn't override. Probably benign — postgres workloads don't typically need to reach the host — but worth noting.
- **Is `Postgres()` ever invoked in an actual examples app?** A `grep` of `examples/` was not run; the only documented consumer pattern is via `DeepbookIndexer(opts)` / `DeepbookServer(opts)`. Need to confirm a real apply path exercises this primitive.

## Opportunities noticed

1. **Collapse sui's embedded indexer-db into `Postgres()`.** The sui composite at `services/sui.ts:119-137, 515-566, 776-784, 899-945` reproduces ~70 lines of postgres machinery (image build, ready probe, env wiring, stop-grace) that already exists in the generic `Postgres()`. A refactor would have `Sui({localnet})` internally instantiate `Postgres({name: 'sui-indexer-db', user: 'sui', password: 'sui', databases: ['sui_indexer']})` and consume the resolved handle. Net effect: single source of truth for postgres lifecycle, automatic snapshot participation via the standard registry, automatic manifest surfacing (or explicit opt-out). The main blocker is that the sui sidecar's stop-grace is 20s vs `Postgres()`'s docker-default; the refactor needs to surface `stopGraceSeconds` as a `Postgres()` option (it isn't today).

2. **Set `stopGraceSeconds: 20` (or expose as option) on `Postgres()`.** The sui rationale ("Postgres needs a clean shutdown to avoid `recovery mode` on next start") applies to every postgres container — the generic factory should bake it in or accept an override. Today `Postgres()` users get the docker default 10s without warning.

3. **Either implement or strip the "state-store cache short-circuits the probe" comment** at `services/postgres.ts:11-13`. As-is the comment misleads — it describes behavior the code doesn't implement.

4. **Hoist the network-name computation into a single helper.** Two callsites with identical logic (`services/postgres.ts:148-151` and `:189-192`) connected by a brittle "both agree" convention. A `postgresNetworkName(identity, name)` helper would eliminate the divergence risk.

5. **Drop the `pg` test helper at `test-setup/helpers/pg.ts`** until an actual L3 test imports it. `grep` of `src/` shows zero importers; the file has been sitting since the factory was migrated. Either land `postgres.docker.test.ts` and exercise the helper, or delete the helper (per the user's "no compat for never-cases" memory).

6. **Promote `awaitPostgresReady` + `ensureDatabase` to engine-level helpers.** Both are reusable: any future postgres-shaped service (Mongo? MySQL? — unlikely, but the pattern is) would need the same exec-via-docker-and-retry shape. Today they live in `services/postgres/internal.ts` but are only consumed by `services/postgres.ts` (the sui-indexer-db has its OWN inline copy). Either inline them back into the factory (one file) or pull them up to `engine/docker/db-helpers.ts` and let sui's indexer-db consume them too.

7. **Add a `services.postgres.password` opt-in for in-network consumers.** Right now the in-process `Postgres` handle leaks the password to anyone who reads the resolved value. A cleaner shape would expose a `url(db, {creds: true | false})` method or hide the password behind a `getCredentialedUrl(db)` Effect that requires a capability (so a deep code path can't accidentally log it).

8. **Document or formalize the snapshot-container enumeration.** `Postgres()` produces a container with `devstack.app` / `devstack.stack` labels, and the snapshot engine enumerates by those labels. This contract is invisible from `services/postgres.ts` — the comment header references "snapshot participation" but doesn't say HOW the container ends up in `opts.containers`. A doc comment on `engine/snapshot.ts`'s container enumeration pointing to the label scheme would help.

9. **Tighten the `Effect.Effect<…, any, any>` return types in `internal.ts`** (`awaitPostgresReady` and `ensureDatabase` both type their R channel as `any`, see `internal.ts:20, 72`). The actual R is `Docker` (the engine docker service), and the E is `PostgresError`. The `any` is suppressed by the `/* eslint-disable @typescript-eslint/no-explicit-any */` at `services/postgres.ts:38` — a typed return would surface the `Docker` requirement at compile time.

10. **The deepbook indexer + server both pull `postgres.containerNetworks[0]!` with non-null assertion** (`services/deepbook/indexer.ts:107`, `services/deepbook/server.ts:133`). If a future `Postgres()` were to start with zero networks (e.g. live mode), this would crash. Either guard at the consumer or guarantee `containerNetworks.length ≥ 1` in the type.

11. **The `display:` projection's `extras: ['N dbs']`** (`services/postgres.ts:301`) doesn't include the host-port mapping. When `hostPort` is set, the TUI shows no indication the container is host-published vs internal-only. A small UX win for `extras: [...(hostPort ? [\`host:${hostPort}\`] : []), \`${databases.length} db…\`]`.

12. **`runtime/read-stack-context.ts:113-115` adds `EndpointName.POSTGRES` to the flat lookup only when `manifest.services.postgres !== undefined`.** This is correct, but consistent with the other guarded reads — worth confirming that all flat-endpoint reads of `EndpointName.POSTGRES` (e.g. from codegen emitters) handle the `undefined` case rather than asserting present.
