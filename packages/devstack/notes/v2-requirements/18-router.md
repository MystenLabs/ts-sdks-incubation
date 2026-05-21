# router

## Purpose

The router is the **localhost HTTP routing layer** that lets every devstack-launched service be
reachable at a stable browser-friendly URL (e.g. `sui.arena.localhost:9000`,
`walrus-node-2.private-content.localhost:9185`, `wallet.arena.localhost:5180`). One **singleton
Traefik v3 reverse-proxy container** (image `traefik:v3.6`, name `devstack-traefik`) lives across
every `<app, stack>` on the host, attached to a single shared docker network `devstack-router`.
Service primitives — both docker containers and Node host processes — opt in by registering a
backend on a well-known **entrypoint** (a fixed host port like 9000 for `sui-rpc`, 5175 for `vite`);
the supervisor materializes one YAML file per backend into Traefik's **file-provider** directory
(`~/.devstack/traefik/dynamic/`); Traefik dispatches incoming requests on each entrypoint port by
`Host:` header to the right upstream container/process IP. The `*.localhost` convention exploits RFC
6761 — every modern browser and Node's DNS resolver auto-resolve `*.localhost` to 127.0.0.1, so no
`/etc/hosts` edits or TLS certificates are needed. Parallel stacks of the same app coexist on
identical entrypoint ports because their Host headers differ (`<stack>.<service>.<app>.localhost`).

**Definitions** (reader-zero-context terms):

- **Stack**: the `--stack` identity dimension (string, defaults to `'main'`) that lets two devstack
  invocations against the same `<app>` run side-by-side. Folded into hostnames, container names,
  file paths, and the file-provider YAML keys.
- **Identity**: the `<app, stack, network>` triple stamped on every container's labels and folded
  into every router hostname / id (`engine/identity.ts:33-39`).
- **Entrypoint**: a Traefik concept — a `(name, host port)` pair. Each entrypoint listens on one
  fixed port; multiple `Host:`-disambiguated routes share it.
- **File provider**: Traefik's static-file-watching configuration provider. Reads YAML / TOML from a
  directory and reloads on change.
- **Router id**: the per-backend unique key used as both the Traefik `routers.<id>` and
  `services.<id>` key in the YAML. Shape: `<app>-<stack>-<service>` (e.g. `arena-main-sui-rpc`).
- **Backend / upstream**: the actual TCP destination Traefik forwards a request to — a container's
  IP on `devstack-router` plus its in-container service port, OR `host.docker.internal:<localPort>`
  for Node host-process backends.

## Current implementation

### In-scope source files

| File                         | LOC | One-liner                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine/router-bootstrap.ts` | 55  | Shared wrapper around `ensureRouter` with 10s timeout + warn-fallback + `DEVSTACK_NO_ROUTER` opt-out. Called from both `devstack up` (supervisor) and `devstack apply` paths so they can't drift.                                                                                                                                                                                                                                                                                                                                                                                      |
| `engine/router-hostname.ts`  | 37  | Two pure helpers: `routerHostname(identity, service)` → `<stack?>.<service>.<app>.localhost`; `routerId(identity, service)` → `<app>-<stack>-<service>` (dots in `service` folded to hyphens).                                                                                                                                                                                                                                                                                                                                                                                         |
| `engine/docker/router.ts`    | 642 | The big one. Pluggable **entrypoint registry** (`defineEntrypoint` / `listEntrypoints` / `routerEntrypoint`), router image+container+network constants, `ensureRouter` boot orchestration (probe → adopt/resume/recreate/fresh), file-provider YAML renderer/writer/remover (`renderFileProvider` / `writeFileProvider` / `removeFileProvider`), singleton CORS middleware writer, in-tree entrypoint defs (sui-rpc, sui-faucet, sui-graphql, sui-grpc, walrus, seal, wallet, vite, deepbook-{indexer,server}-metrics, deepbook-server), and the memoized `getTraefikRouterIp` helper. |

**Src total**: 734 LOC across the three files.

### In-scope test files

| File                             | LOC | One-liner                                                                                                                                            |
| -------------------------------- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine/router-hostname.test.ts` | 36  | Pure-function tests for `routerHostname` and `routerId` (main vs non-main stacks; dot-folding in service segment).                                   |
| `engine/docker/router.test.ts`   | 141 | YAML render shape; file-provider write/remove lifecycle (real fs, env-var-overridden tmp dir); entrypoint registry idempotency + conflict rejection. |

**Test total**: 177 LOC.

### Adjacent files that participate (NOT in scope but heavily intertwined)

These are where the router's outputs land and where its YAML writes are driven from. Documented here
because the router's behavior can't be understood in isolation:

- `engine/docker/core.ts:163-185` — `DockerRunOptions.traefik?: ReadonlyArray<RouterLabel>` field
  declaration; the per-container opt-in to router exposure.
- `engine/docker/core.ts:694-706` — `Docker.run` calls `materializeRouterEntries` (defined at
  `core.ts:1125-1212`) after the container is up; this is where
  `docker network connect devstack-router`, `inspectContainerIp`, and per-`RouterLabel`
  `writeFileProvider` happen for docker-backend services.
- `engine/docker/core.ts:1051-1100` — `inspectContainerIp` (the `docker inspect`-with-retry helper
  used by `materializeRouterEntries`).
- `engine/docker/core.ts:1102-1212` — `materializeRouterEntries` (the docker-side YAML-write driver,
  called by `Docker.run`).
- `engine/docker/inventory.ts:794-873` — `RouterInfo` / `collectRouterInfo` / `renderRouterRow` for
  the `devstack doctor` / `devstack prune --list` top-line "router status" row.
- `engine/router-bootstrap.ts` is imported by `engine/supervisor.ts:2012` (`up` path) and
  `cli/commands/apply.ts:131` (`apply` path).
- `services/wallet/internal.ts:213-245` and `services/dev/internal.ts:316-356` directly call
  `writeFileProvider` / `removeFileProvider` for Node host-process backends (no `Docker.run`
  involved).
- `advanced/plugin-author/docker-container.ts:677-740` is the public `dockerContainer({routing})`
  primitive that out-of-tree plugin authors use to declare router-fronted backends; it folds each
  `routing[]` entry into a `RouterLabel` and pipes through `Docker.run({traefik})`.

## Configuration

The router exposes a small, almost-flat configuration surface — most knobs are static
module-load-time values, not user-tunable. The two end-user opt-outs are environment variables.

### Environment variables

| Env var                       | Default                                | Read at                                                                                                                               | Purpose                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEVSTACK_NO_ROUTER`          | unset                                  | `engine/router-bootstrap.ts:39`                                                                                                       | When `=== '1'`, **completely skips** `ensureRouter` on both `up` and `apply` paths. Services that pass `traefik:` to `Docker.run` still attempt `docker network connect devstack-router` but fail at "no such network" and get logged as warnings — they fall back to direct-port access. Useful for CI shapes where Traefik adds overhead without test value. |
| `DEVSTACK_ROUTER_DYNAMIC_DIR` | `${homedir}/.devstack/traefik/dynamic` | `engine/docker/router.ts:70-71`                                                                                                       | The host directory mounted into Traefik at `/etc/traefik/dynamic` (read-only). Where every per-backend YAML lives. Overridden by every test (`router.test.ts:55-56`, `docker.test.ts:293-294`, `dev.test.ts:64-66`, `wallet.test.ts:97-100`, etc.) so tests don't smash on `~`.                                                                                |
| `DEVSTACK_DIRECT_PORTS`       | unset                                  | **Documented at `core.ts:182` but NOT actually consumed anywhere in the codebase** (grep confirms — only the JSDoc reference exists). | OPEN QUESTION: stale doc or unimplemented escape hatch? Documented as "force both direct host port and router routing when set," but no code path branches on it.                                                                                                                                                                                              |

### `defineDevstack` config keys

**None.** The router has no `defineDevstack`-surfaced config knobs. The router is configured
exclusively via the env vars above and the per-`Docker.run`-call `traefik:` field.

### CLI flags

| Command          | Flag                    | Behavior                                                                                                                              | Defined at                      |
| ---------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `devstack prune` | `--include-router`      | Boolean. When set, the prune post-pass also `docker rm -f devstack-traefik` and `docker network rm devstack-router`. Default `false`. | `cli/commands/prune.ts:117-122` |
| (none)           | (none for `up`/`apply`) | The router is auto-ensured at boot. The only "don't touch the router" path is the `DEVSTACK_NO_ROUTER` env var.                       | n/a                             |

### Per-`Docker.run` configuration (in-process API)

| Field on `DockerRunOptions` | Type                                           | Behavior                                                                                                                                                                                                                       | Defined at                      |
| --------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| `traefik`                   | `ReadonlyArray<RouterLabel>` (optional)        | When set, after `docker run`: connect to `devstack-router`, inspect the container's IP on that network, write one YAML per entry. Multi-port primitives (sui-localnet exposing rpc/faucet/graphql) pass one entry per service. | `engine/docker/core.ts:163-185` |
| `RouterLabel.id`            | `string`                                       | Unique router+service id — used as the YAML filename (`<id>.yml`) and the `http.routers.<id>` / `http.services.<id>` keys. Convention: `routerId(identity, service)` → `<app>-<stack>-<service>`.                              | `engine/docker/router.ts:399`   |
| `RouterLabel.hostname`      | `string`                                       | The `Host:` header value to match. Convention: `routerHostname(identity, service)` → `<stack?>.<service>.<app>.localhost`.                                                                                                     | `engine/docker/router.ts:401`   |
| `RouterLabel.entrypoint`    | `string`                                       | Must be a name previously registered via `defineEntrypoint`. Selects which entrypoint port the route binds to.                                                                                                                 | `engine/docker/router.ts:404`   |
| `RouterLabel.servicePort`   | `number`                                       | In-container port the upstream binds (e.g. `9000` for sui-localnet's RPC). Traefik dials `http://<router-net-IP>:<servicePort>`.                                                                                               | `engine/docker/router.ts:406`   |
| `RouterLabel.cors`          | `boolean` (optional, default false)            | When true, attach the singleton `devstack-cors@file` middleware to this route. Walrus storage nodes are the canonical user (no CORS headers from upstream).                                                                    | `engine/docker/router.ts:413`   |
| `RouterLabel.protocol`      | `'http' \| 'h2c'` (optional, default `'http'`) | `h2c` = HTTP/2 cleartext — required for gRPC upstreams like `sui-fork`'s combined rpc+forking service.                                                                                                                         | `engine/docker/router.ts:423`   |

### Entrypoint registry (module-load-time configuration)

All entries register at module-load time via top-level `defineEntrypoint(...)` calls in
`engine/docker/router.ts:181-207`. Out-of-tree plugin authors register their own from their own
module top-level so registration completes before the supervisor reaches `ensureRouter`.

| Name                       | Host port | `defaultProtocol`                               | Defined at    | Used by                                                                   |
| -------------------------- | --------- | ----------------------------------------------- | ------------- | ------------------------------------------------------------------------- |
| `sui-rpc`                  | 9000      | `'http'` (implicit)                             | router.ts:181 | sui-localnet RPC, sui-fork (via shared `sui` hostname)                    |
| `sui-faucet`               | 9123      | `'http'`                                        | router.ts:182 | sui-localnet faucet                                                       |
| `sui-graphql`              | 9125      | `'http'`                                        | router.ts:183 | sui-localnet GraphQL                                                      |
| `sui-grpc`                 | 50051     | `'h2c'`                                         | router.ts:192 | sui-fork (combined `sui.rpc.v2.*` + `sui.forking.v1alpha.ForkingService`) |
| `walrus`                   | 9185      | `'http'`                                        | router.ts:193 | walrus storage nodes (REST)                                               |
| `seal`                     | 2024      | `'http'`                                        | router.ts:194 | seal key-server                                                           |
| `wallet`                   | 5180      | `'http'`                                        | router.ts:195 | dev-only wallet UI host process                                           |
| `vite`                     | 5175      | `'http'`                                        | router.ts:196 | front-end dev server (host process)                                       |
| `deepbook-indexer-metrics` | 9184      | `'http'`                                        | router.ts:199 | DeepBook indexer Prometheus `/metrics`                                    |
| `deepbook-server`          | 9008      | `'http'`                                        | router.ts:206 | DeepBook REST API                                                         |
| `deepbook-server-metrics`  | 9186      | `'http'`                                        | router.ts:207 | DeepBook server Prometheus `/metrics`                                     |
| `8080` (Traefik dashboard) | 8080      | n/a (not a registered entrypoint — direct bind) | router.ts:355 | Traefik's own debug dashboard (`--api.insecure=true`)                     |

Notes on the registry:

- `defineEntrypoint` is **idempotent on identical `(name, port, defaultProtocol)`** — re-registering
  the same value is a no-op so module hot-reload under `pnpm dev` doesn't throw (router.ts:144-157).
- **Conflicting registration** (same name, different port OR different `defaultProtocol`) throws
  synchronously (router.ts:148-153). Tests pin this contract (router.test.ts:126-131).
- The registry is a **process-global `Map`** (router.ts:130) — there is no per-stack or
  per-supervisor isolation. Plugin authors must call `defineEntrypoint` from their module top-level
  so the registration lands before `ensureRouter` reads the snapshot.
- The registry is **read once per `ensureRouter` call** by `runRouterFresh` (router.ts:348). Calling
  `defineEntrypoint` after `ensureRouter` has minted the Traefik container is a programming error —
  Traefik won't know about the new entrypoint, and the route will 404 until the container is
  recreated.

## Capabilities CONSUMED

### Effect / Layer / Context machinery

- `Effect` from `effect` (`router.ts:41`, `router-bootstrap.ts:24`).
- `ChildProcessSpawner` (`ChildProcess.make` + spawner service) from `effect/unstable/process`
  (`router.ts:42`, `router-bootstrap.ts:25`). Every shell-out to `docker` flows through this.
- `Scope` (implicit, via `runCapturing` / `runCapturingOrFail` helpers from `./core.js` —
  `router.ts:48`).
- The `Identity` service (consumed indirectly via callers of `routerHostname` / `routerId` — these
  are pure functions that take an `IdentityShape`, but every caller resolves `Identity` from the
  Effect context first; e.g. `services/sui.ts:857`, `services/wallet/internal.ts:222`,
  `services/seal/internal.ts:487`).

### Engine resources

- **Identity (`IdentityShape`)** from `engine/identity.ts` (imported as `type` at
  `router-hostname.ts:20`). The `(app, stack, network)` triple is the sole input to `routerHostname`
  / `routerId` apart from the service segment.
- **`atomic-write.ts::writeFileAtomic`** (`router.ts:46`). Every YAML write is atomic via tmp +
  rename so Traefik's file-provider watcher never sees a half-written body (router.ts:559-564 for
  CORS middleware; router.ts:577-582 for per-backend entries).
- **`engine/errors.ts::DockerError`** (`router.ts:47`). All failures funnel through this tagged
  class with `phase` strings like `'router.dynamic-dir'`, `'router.file-provider'`.
- **`engine/docker/core.ts` runCapturing / runCapturingOrFail / inspectContainerIp / Spawner**
  (`router.ts:48`). Subprocess helpers shared with the rest of the docker slice.

### Engine resources NOT used (deliberately)

- **No `Identity` reference inside `ensureRouter`** — the router is cross-stack. The
  `Effect.requirements` only include `ChildProcessSpawner`.
- **No `FileSystem.FileSystem`** — `ensureDynamicDir` uses `node:fs/promises` directly
  (`router.ts:291-300`). Per the inline comment: "we don't drag a `FileSystem.FileSystem` dep
  through the router boot which runs before the rest of the layer is built."
- **No `StateStore`** — router state is on-disk (the YAML directory) and in-docker (the container),
  not in the engine state-store.
- **No `PortAllocator`** — entrypoint ports are fixed well-known values; the router intentionally
  does NOT request ports through the allocator (it would defeat the purpose — every stack on the
  host shares the same router and the same entrypoint ports).

### Runtime resources (host)

- **`docker` CLI** — invoked for `docker network ls`, `docker network create`, `docker inspect`,
  `docker start`, `docker rm -f`, `docker run`, `docker network connect` (router.ts:306, 312, 327,
  271, 259/279, 384, plus inventory.ts:824/839 and core.ts:1157).
- **`docker network` named `devstack-router`** — created by `ensureRouterNetwork` if missing
  (router.ts:302-321), labeled `devstack.router=true`.
- **`host.docker.internal`** — DNS alias used in `upstreamUrl` fields for host-process backends so
  the Traefik container (which runs in docker) can dial back to the host (e.g. wallet-app at
  `wallet/internal.ts:237`, vite at `dev/internal.ts:346`).
- **Filesystem under `${homedir}/.devstack/traefik/dynamic/`** — host directory bind-mounted at
  `/etc/traefik/dynamic:ro` (router.ts:373-374). Read-only INSIDE the container; the supervisor
  writes from outside.
- **TCP ports** on the loopback interface — 9000, 9123, 9125, 50051, 9185, 2024, 5180, 5175, 9184,
  9008, 9186, 8080 (all bound `127.0.0.1:<port>:<port>` via `-p` flags at router.ts:351, 355).
- **`process.env.DEVSTACK_NO_ROUTER` / `process.env.DEVSTACK_ROUTER_DYNAMIC_DIR`** — read at
  module/effect runtime (router-bootstrap.ts:39, router.ts:71).
- **`os.homedir()`** — fallback for the dynamic dir (router.ts:71).
- **`process.env`** generally — only the two listed env vars.

### External (network, RPC, system binaries)

- **`traefik:v3.6` docker image** (router.ts:65). Pulled from Docker Hub on first `ensureRouter`
  boot. No HTTP/RPC contracts beyond what Traefik's `--providers.file` watcher and
  `--api.insecure=true` dashboard accept.

### Imports from other workspace packages

- **None** — the router pulls from `effect`, `effect/unstable/process`, and Node built-ins only.

### npm dependencies

- `effect` (`Effect`, `Scope` — though Scope is via core.ts helpers).
- `effect/unstable/process` (`ChildProcess`, `ChildProcessSpawner`).
- Node built-ins: `node:fs/promises`, `node:os` (`homedir`), `node:path` (`join`).

## Capabilities PRODUCED

### URL / endpoint shapes

For every backend that opts in via `RouterLabel`, the router exposes a public URL of shape:

```
<protocol>://<hostname>:<entrypointPort>
```

where:

- `<protocol>` = `http` (default) or `h2c` (gRPC cleartext, fork only).
- `<hostname>` = `<service>.<app>.localhost` for the `main` stack,
  `<stack>.<service>.<app>.localhost` for any other stack (router-hostname.ts:22-25).
- `<entrypointPort>` = the fixed host port for the entrypoint name (see Configuration table).

Concrete examples (from in-tree services):

| Service                  | URL (main stack, app=arena)                            | URL (stack=test, app=arena)                                 |
| ------------------------ | ------------------------------------------------------ | ----------------------------------------------------------- |
| sui-localnet RPC         | `http://sui.arena.localhost:9000`                      | `http://test.sui.arena.localhost:9000`                      |
| sui-localnet faucet      | `http://faucet.arena.localhost:9123`                   | `http://test.faucet.arena.localhost:9123`                   |
| sui-localnet GraphQL     | `http://graphql.arena.localhost:9125`                  | `http://test.graphql.arena.localhost:9125`                  |
| sui-fork (gRPC)          | `h2c://sui.arena.localhost:50051`                      | `h2c://test.sui.arena.localhost:50051`                      |
| walrus storage node N    | `http://walrus-node-N.arena.localhost:9185`            | `http://test.walrus-node-N.arena.localhost:9185`            |
| seal key-server          | `http://seal.arena.localhost:2024`                     | `http://test.seal.arena.localhost:2024`                     |
| dev wallet UI            | `http://wallet.arena.localhost:5180`                   | `http://test.wallet.arena.localhost:5180`                   |
| frontend vite dev        | `http://dev.arena.localhost:5175`                      | `http://test.dev.arena.localhost:5175`                      |
| DeepBook server REST     | `http://deepbook-server.arena.localhost:9008`          | `http://test.deepbook-server.arena.localhost:9008`          |
| DeepBook indexer metrics | `http://deepbook-indexer.arena.localhost:9184/metrics` | `http://test.deepbook-indexer.arena.localhost:9184/metrics` |
| Traefik dashboard        | `http://127.0.0.1:8080/`                               | `http://127.0.0.1:8080/` (singleton, no per-stack)          |

### State-store entries

**None.** The router does NOT write to the engine state-store.

### Events emitted

**None directly.** The router participates in Effect spans for tracing:

- `Devstack.bootstrapRouter` (router-bootstrap.ts:53) with attribute `caller: 'apply' | 'up'`.
- `Docker.ensureRouter` (router.ts:284), with `router.action: 'adopt' | 'resume'` annotated when the
  existing container is reused (router.ts:266, 269).

### Files written

| Path                           | Format                                     | When written                                                                                                                                                                                                                              | When deleted                                                                                                                                                                                                                                           |
| ------------------------------ | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `${dynDir}/_devstack-cors.yml` | YAML (Traefik middleware)                  | Once per `ensureRouter` call, atomically via `writeFileAtomic` (router.ts:554-571). Leading `_` sorts before per-stack entries alphabetically so Traefik picks up the middleware before any route referencing it.                         | Never (idempotent rewrite each boot).                                                                                                                                                                                                                  |
| `${dynDir}/<routerId>.yml`     | YAML (Traefik router + service definition) | After `docker network connect` + IP inspect succeed for each `RouterLabel` (engine/docker/core.ts:1194-1208 for docker backends; `services/wallet/internal.ts:233-244` and `services/dev/internal.ts:342-353` for host-process backends). | On scope close — `addFinalizer(reuseScope, removeFileProvider(entry.id))` (core.ts:1210 for docker; explicit `Effect.addFinalizer` calls for host processes). `removeFileProvider` is a best-effort `unlink` that swallows errors (router.ts:594-598). |

The YAML body for a per-backend entry has this exact shape (router.ts:510-529):

```yaml
http:
  routers:
    arena-main-vite:
      rule: 'Host(`dev.arena.localhost`)'
      entrypoints: ['vite']
      service: arena-main-vite
      middlewares: ['devstack-cors@file'] # only when cors: true
  services:
    arena-main-vite:
      loadBalancer:
        servers:
          - url: 'http://host.docker.internal:5175'
```

The CORS middleware body (router.ts:535-552):

```yaml
http:
  middlewares:
    devstack-cors:
      headers:
        accessControlAllowOriginList: ['*']
        accessControlAllowMethods: [GET, POST, PUT, DELETE, OPTIONS]
        accessControlAllowHeaders: ['*']
        accessControlExposeHeaders: ['*']
        accessControlMaxAge: 86400
```

### CLI commands registered

**None directly.** The router contributes:

- The `--include-router` flag on `devstack prune` (defined in `cli/commands/prune.ts:117-122`, not
  in router.ts itself).
- A status row on `devstack prune --list` (and any other surface that calls `printInventory`) via
  `collectRouterInfo` + `renderRouterRow` (`engine/docker/inventory.ts:801-873`).

### Routes registered

The router is the registrar of routes (not the consumer). Every callable opt-in via
`Docker.run({traefik})`, direct `writeFileProvider` (host processes), or the public
`dockerContainer({routing})` API ends up writing a route YAML.

### TypeScript exports consumed elsewhere

Re-exported from `engine/docker/index.ts:59-75` (the docker barrel):

| Export                                                                        | Kind                                                          | Consumers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ensureRouter`                                                                | `Effect.Effect<void, DockerError, ChildProcessSpawner>`       | `engine/router-bootstrap.ts:26` only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `bootstrapRouterFor(caller)`                                                  | function returning `Effect<void, never, ChildProcessSpawner>` | `engine/supervisor.ts:2012` (`up`), `cli/commands/apply.ts:131` (`apply`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `ROUTER_NETWORK` (`'devstack-router'`)                                        | string const                                                  | `cli/commands/prune.ts:45/384/396` (`--include-router` post-pass), `engine/docker/inventory.ts:28/865` (status row), `engine/docker/core.ts:14/1157/1177/1192` (network-connect + IP-inspect for materialization).                                                                                                                                                                                                                                                                                                                                                    |
| `ROUTER_CONTAINER` (`'devstack-traefik'`)                                     | string const                                                  | `cli/commands/prune.ts:45/384/390` (`docker rm -f`), `engine/docker/inventory.ts:28/828/872` (probe + render).                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `ROUTER_IMAGE` (`'traefik:v3.6'`)                                             | string const                                                  | Internal only (router.ts:65/253/255).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `defineEntrypoint`, `listEntrypoints`, `routerEntrypoint`, `RouterEntrypoint` | registry surface                                              | Re-exported via `advanced/plugin-author/index.ts:83-88` for out-of-tree plugins. Internal consumers: `services/sui.ts:861-863/1637`, `services/seal/internal.ts:489`, `services/wallet/internal.ts:223`, `services/dev/internal.ts:332/158`, `services/deepbook/indexer.ts:140`, `advanced/plugin-author/docker-container.ts:48/688`.                                                                                                                                                                                                                                 |
| `routerDynamicDir`                                                            | function                                                      | Re-exported via barrel; no direct consumers outside `router.ts` (tests poke `process.env.DEVSTACK_ROUTER_DYNAMIC_DIR` instead).                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `renderFileProvider`, `writeFileProvider`, `removeFileProvider`               | functions                                                     | `services/wallet/internal.ts:20-21/233/245` and `services/dev/internal.ts:16-17/342/354` (host-process backends). `engine/docker/core.ts:15-16/1194/1210` (docker backends via `materializeRouterEntries`).                                                                                                                                                                                                                                                                                                                                                           |
| `getTraefikRouterIp(spawner)`                                                 | function                                                      | Exported but **no current consumers** in-tree (grep finds only the definition and the `resetTraefikRouterIpCacheForTesting` reset hook). Documented as a "host-side diagnostics / debug surfaces" helper.                                                                                                                                                                                                                                                                                                                                                             |
| `RouterLabel`, `FileProviderEntry`                                            | types                                                         | `RouterLabel` consumed via `Docker.run({traefik})` type. `FileProviderEntry` is the shape `writeFileProvider` takes.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `routerHostname`, `routerId`                                                  | functions                                                     | Imported directly from `engine/router-hostname.ts` (NOT re-exported through the docker barrel). Consumers: every service that publishes a router-fronted URL — `services/sui.ts:48/858-860/1636/1763`, `services/seal/internal.ts:68/488/641`, `services/walrus/{deploy,nodes}.ts`, `services/wallet/internal.ts:23/157/222/232`, `services/dev/internal.ts:20/331/341`, `services/deepbook/{indexer,server}.ts`, `advanced/plugin-author/docker-container.ts:51/144/150/701/704`, and tests under `services/seal/parallel-stack.test.ts`, `services/walrus.test.ts`. |

### Container images / volumes produced

- **Container**: `devstack-traefik`, image `traefik:v3.6`, restart policy `unless-stopped`, attached
  to network `devstack-router`, labeled `devstack.router=true`, bind-mount of
  `${dynDir} → /etc/traefik/dynamic:ro` (router.ts:362-378).
- **Network**: `devstack-router`, labeled `devstack.router=true`, default bridge driver
  (router.ts:310-320).
- **Volumes**: **none** — Traefik's state is the file-provider YAMLs on the host bind-mount; nothing
  inside the container needs to survive a restart.

## Lifecycle

### Startup

The router has **two boot paths**:

#### A. Supervisor (`devstack up` / `runDevstack`)

1. `supervisor.ts:2012` calls `bootstrapRouterFor('up').pipe(Effect.provide(bootstrapCtx))` **once
   per supervisor lifetime**, on the long-lived outer scope. This is intentionally ABOVE the
   per-cycle scope: the router survives `r` hot-restarts and watch-fires, so re-running
   `ensureRouter` per cycle was wasteful churn (per the comment at supervisor.ts:2004-2011).
2. `bootstrapRouterFor` wraps `ensureRouter` with:
   - `DEVSTACK_NO_ROUTER === '1'` short-circuit → `Effect.void` (router-bootstrap.ts:39).
   - `Effect.timeoutOrElse` 10s → logs warning, continues (router-bootstrap.ts:41-46). Guards
     against a stuck docker daemon.
   - `Effect.catch` → logs warning, falls back to "direct ports for any traefik-aware primitives"
     (router-bootstrap.ts:48-52).
3. `ensureRouter` itself (router.ts:226-284):
   - **Step 1** — `ensureRouterNetwork`: `docker network ls -q --filter name=^devstack-router$`; if
     missing, `docker network create --label devstack.router=true devstack-router`
     (router.ts:302-321).
   - **Step 2** — `ensureDynamicDir`: `mkdir -p` on `${dynDir}` via
     `node:fs/promises.mkdir({recursive: true})` (router.ts:291-300).
   - **Step 2a** — `writeCorsMiddleware`: atomically write `${dynDir}/_devstack-cors.yml`
     (router.ts:554-571). Done BEFORE any container so the middleware is loaded before any route
     references it.
   - **Step 3** — `inspectRouter`:
     `docker inspect --format '{{.State.Running}}|{{.Config.Image}}' devstack-traefik`
     (router.ts:323-343). Returns `null` if missing; `{running, image}` otherwise.
     - **null (missing)** → `runRouterFresh` (router.ts:249-252).
     - **image mismatch** → `docker rm -f` (ignored), then `runRouterFresh` (router.ts:253-264).
       Span annotated implicitly.
     - **running && image match** → no-op, span annotated `router.action: 'adopt'`
       (router.ts:265-268).
     - **stopped && image match** → `docker start devstack-traefik`, span annotated
       `router.action: 'resume'`. If `docker start` fails, `docker rm -f` (ignored) and
       `runRouterFresh` as fallback (router.ts:269-283).
   - `runRouterFresh` (router.ts:345-385): reads `listEntrypoints()` snapshot, builds
     `-p 127.0.0.1:<port>:<port>` flags for each + the dashboard `-p 127.0.0.1:8080:8080`, then
     `docker run -d --name devstack-traefik --restart unless-stopped --label devstack.router=true --network devstack-router ... -v ${dynDir}:/etc/traefik/dynamic:ro traefik:v3.6 --api.insecure=true --providers.file.directory=/etc/traefik/dynamic --providers.file.watch=true --entrypoints.<name>.address=:<port>...`.
     Traefik's file-provider watcher takes over from there.
4. Subsequent service primitives that need router exposure (`Docker.run({traefik: [...]})` or
   host-process backends with `writeFileProvider`) write their per-backend YAML, which Traefik picks
   up via the watcher within ~1s.

#### B. Apply (`devstack apply`)

1. `cli/commands/apply.ts:131` calls
   `bootstrapRouterFor('apply').pipe(Effect.provide(NodeServicesLayer))`. Same code path as `up` but
   with a different Effect span attribute (`caller: 'apply'`).
2. **Why apply has to ensure the router**: a fresh CI runner has no `devstack-router` network from a
   prior `up`; without this step, per-primitive `docker network connect devstack-router` calls
   inside `Docker.run`'s traefik wiring fail silently as warnings, then ready-probes time out at 60s
   because manifest URLs aren't reachable through Traefik (router-bootstrap.ts:4-19,
   apply.ts:112-131).

### Per-backend startup (driven by `Docker.run({traefik})` or host-process equivalents)

This happens AFTER `ensureRouter` has run, in the per-primitive layer scope:

1. **Docker backends** (driven by `materializeRouterEntries` at `core.ts:1125-1212`):
   - `docker network connect devstack-router <containerId>` (core.ts:1155-1158).
     - Exit 0 → freshly attached.
     - stderr matches `/already exists in network/i` → already attached (adopt path), continue
       (core.ts:1160-1163).
     - "network not found" or any other non-zero → log warning, **skip the YAML**, container keeps
       direct-port access (core.ts:1164-1173).
   - `inspectContainerIp(spawner, containerId, ROUTER_NETWORK)` —
     `docker inspect --format '{{(index .NetworkSettings.Networks "devstack-router").IPAddress}}'`
     with **30 retries × 100ms = 3s budget** (core.ts:1062-1100). Empty IP and the literal
     `<no value>` (network not attached yet) both trigger retry. Failure after budget →
     `DockerError`, which is promoted to a hard failure on `Docker.run` since the router promise
     can't be honored (core.ts:1177-1187).
   - For each `RouterLabel`:
     `writeFileProvider({id, hostname, entrypoint, upstreamUrl: '<scheme>://<ip>:<servicePort>', cors, protocol})`
     (core.ts:1188-1210). YAML write failure is best-effort with a warning log; if it fails, the
     finalizer is NOT registered.
   - Finalizer on `reuseScope`: `removeFileProvider(entry.id)` (core.ts:1210).
2. **Host-process backends** (wallet at `services/wallet/internal.ts:213-245`, hostProcess at
   `services/dev/internal.ts:316-356`):
   - Directly call
     `writeFileProvider({id, hostname, entrypoint, upstreamUrl: 'http://host.docker.internal:<localPort>'})`
     after the local TCP port binds.
   - YAML write failure → log warning, continue on direct port.
   - Finalizer: `Effect.addFinalizer(() => removeFileProvider(id))`.

### Ready criteria

- **Router itself**: `ensureRouter` returns successfully (whether via adopt, resume, recreate, or
  fresh). There is **no explicit health probe** of Traefik beyond `docker inspect`'s
  `.State.Running` field. Per the comment at router-bootstrap.ts:12-19, `ensureRouter` failures are
  tolerated and downgraded to "continue without traefik."
- **Per backend**: a YAML file exists at `${dynDir}/<routerId>.yml` AND the route's upstream is
  dial-able. Backends rely on **Traefik's file watcher** picking up the YAML, which is asynchronous
  (typically <1s, no formal SLO). No code currently waits on Traefik having actually loaded a route
  before proceeding — service ready-probes that hit the routed hostname are the effective gate.

### Restart behavior

- `ensureRouter` is **fully idempotent** (router.ts:209-228 inline-comment "Idempotency model
  mirrors `Docker.run`'s reuse-if-healthy").
- The four-way decision (existing running + same image → adopt; stopped + same image → start;
  missing → fresh; existing + different image → rm + fresh) means the same call works on:
  - Cold host (no container, no network) → creates both.
  - Warm host (container running from prior `pnpm dev`) → no-op (adopt).
  - Stopped container (prior `pnpm dev` exited cleanly via SIGINT) → `docker start` (resume in ~1s).
  - Image upgrade (devstack version bump bumps `ROUTER_IMAGE`) → `docker rm -f` + fresh.
- Per-backend YAML writes are also idempotent — `writeFileAtomic` overwrites in place, picking up
  any IP changes from a docker daemon restart (core.ts:703-705 "Idempotent on already-attached …
  overwrite picks up current IP if daemon assigned a different one").
- The `traefikRouterIpCache` (router.ts:614) is process-local and dies with the supervisor; the IP
  is stable for the container's lifetime so cache invalidation is implicit (router.ts:602-613).

### Teardown

- **Cycle teardown** (`r` hot-restart): **NOT torn down**. The router lives on the long-lived outer
  scope. Per-cycle work that touched the router (file-provider YAMLs for per-primitive containers)
  is torn down via per-primitive `reuseScope` finalizers calling `removeFileProvider`.
- **Supervisor teardown** (Ctrl-C, SIGTERM): the per-cycle YAMLs are removed via their finalizers;
  the **router container is left running**. Per the comment at router.ts:35-39: "the finalizer is a
  `docker stop` (NOT rm) so the next `pnpm dev` resumes it in ~1s."
  - HOWEVER: I see no `addFinalizer` for `docker stop devstack-traefik` in the `ensureRouter` body
    or in `bootstrapRouterFor`. OPEN QUESTION: the comment claims a `docker stop` finalizer exists,
    but reading the code I cannot find one — `ensureRouter` returns
    `Effect.Effect<void, DockerError, ChildProcessSpawner>` with no `Scope` requirement. This either
    is dead documentation OR I'm missing where the finalizer lives.
- **Full teardown** (`devstack prune --include-router`): `cli/commands/prune.ts:379-404` runs
  `docker rm -f devstack-traefik` then `docker network rm devstack-router` (both best-effort, exit
  codes mapped to true/false but not failures). Dry-run prints what would happen.
- **`devstack wipe`**: does NOT touch the router (the wipe-by-label paths filter on
  `devstack.app`/`devstack.stack`, not `devstack.router=true`). The router is cross-stack
  infrastructure, intentionally out of `wipe`'s scope. This makes `wipe` parallel-stack safe —
  wiping stack A's resources never disturbs stack B's routes.

## Hard requirements / invariants

These are load-bearing constraints. Many are documented inline as historical-bug regression gates.

1. **File-provider only — NO docker provider.** Traefik must NOT be configured with
   `--providers.docker`. The docker-provider listens on container-events and captures the upstream
   IP on the FIRST event; at that moment, our containers have only their per-stack network IP, not
   the `devstack-router` IP (which is added asynchronously via `docker network connect` after
   `docker run`). The docker-provider would capture the wrong IP and never re-fetch, so every
   request would hang/404 until a manual `docker restart` of the router (router.ts:20-27, also
   pinned at docker.test.ts:266-269 + 369). The supervisor's file-provider write is deterministic:
   it runs AFTER `docker network connect` returns and the IP has settled (verified via
   `inspectContainerIp` retry).

2. **Two-network attach.** Every container that wants router routing joins TWO networks: its
   per-stack network (set at `docker run --network <perStack>`) AND `devstack-router` (added via
   `docker network connect` AFTER `docker run` completes). The IP we write into the YAML is the
   `devstack-router` IP, not the per-stack IP (core.ts:1051-1056, 1177).

3. **IP-inspect retry budget is non-negotiable.** The router-network IP is NOT settled immediately
   when `docker network connect` returns — the daemon registers the endpoint before the IPAM assigns
   a per-network IP. Without the 30×100ms retry (`inspectContainerIp` at core.ts:1062-1100), naive
   single-inspects race and either get an empty string or the literal `<no value>`, which then
   become bogus YAML upstream URLs and surface as 502 Bad Gateway. Test:
   `engine/docker.test.ts:439-464` (`inspectContainerIp retries while docker reports an empty IP`).

4. **Atomic YAML writes.** Every YAML write is `writeFileAtomic` (tmp + rename). Per the inline
   comment at router.ts:560-562 and 580-582: "Traefik's file-provider watcher never observes a
   half-written YAML body. A torn read on startup makes Traefik refuse to load any subsequent
   updates from the same file until something else mutates it." This is a Traefik bug devstack works
   around — non-atomic writes silently disable that route until the supervisor restarts.

5. **Adopt path MUST rewrite the YAML, not skip it.** When an existing container is adopted (warm
   reuse), `materializeRouterEntries` runs anyway and `docker network connect` returns "endpoint
   already exists" — that case must be detected via stderr regex (`/already exists in network/i`,
   core.ts:1160-1163) and treated as success, not a skip. Pre-fix: previous code dropped the rewrite
   on every non-zero exit; adopted containers kept whatever IP was in the YAML from their first run,
   surfacing as 502 after a docker daemon restart re-IPed the container (core.ts:1148-1154).

6. **Entrypoint registry must be populated BEFORE `ensureRouter` runs.** The registry is read once
   at boot (router.ts:122-128). Plugin authors call `defineEntrypoint` from their module top-level.
   A `defineEntrypoint` AFTER `ensureRouter` is a programming error — the route will 404 until
   container recreate.

7. **Hostname → stack mapping is one-to-one.** `routerHostname(identity, service)` MUST embed the
   stack dimension for non-main stacks (router-hostname.ts:22-25). The test at
   `services/seal/parallel-stack.test.ts:45-56` pins this — without the stack prefix, two parallel
   stacks would mint identical hostnames and Traefik would route both stacks' traffic to whichever
   container matched first. Likewise `routerId` (router-hostname.ts:34-37) must embed the stack so
   per-stack file-provider YAML keys don't collide (parallel-stack.test.ts:58-68).

8. **`main` stack omits the `<stack>` segment.** This is intentional UX — the "default stack" feels
   like the only stack. `routerHostname(id('arena','main'),'sui')` = `'sui.arena.localhost'`, NOT
   `'main.sui.arena.localhost'`. Pinned at router-hostname.test.ts:18-23 and 25-30, plus
   walrus.test.ts:56-86 and seal/parallel-stack.test.ts:45-56.

9. **`routerId` folds dots in service segment.** Docker label-value constraints reject `.` in some
   positions; `routerId` replaces `.` with `-` (router-hostname.ts:35-37) so callers can pass
   through `'sui.localnet'` and get `'arena-main-sui-localnet'`. Pinned at
   router-hostname.test.ts:32-35.

10. **`defineEntrypoint` is idempotent on identical re-registration; throws on conflict.**
    Re-registering `(name, port, defaultProtocol)` is a no-op (supports module hot-reload in
    `pnpm dev`). Re-registering same name with a different port OR different `defaultProtocol`
    throws synchronously — the registry is single source of truth. Pinned at router.test.ts:118-131.

11. **CORS middleware must load before any route that references it.** The middleware YAML filename
    starts with `_` so it sorts before per-stack entries alphabetically; Traefik picks it up first
    (router.ts:531-534).

12. **YAML field validation.** `id`, `hostname`, `entrypoint`, and `upstreamUrl` are spliced into
    YAML inside backtick-quoted `Host()` rules and double-quoted scalars. The validators
    (router.ts:478-508) reject any chars that could break out of quoting. Failure throws
    synchronously — these fields are always upstream-controlled, so a failure here is a programming
    error in the caller, not a transient.

13. **Router survives `r` hot-restart.** The bootstrap runs ONCE per supervisor lifetime on the
    long-lived outer scope, NOT per cycle (supervisor.ts:2004-2012). Removing this property would
    re-pay a `docker inspect` cost per cycle.

14. **`getTraefikRouterIp` memoizes for the process lifetime.** The router container's IP on
    `devstack-router` is stable while the container exists; recreate requires `--include-router` +
    `pnpm dev` restart, which kills the process and invalidates the cache implicitly
    (router.ts:600-613).

15. **No `Identity` reference inside `ensureRouter`.** The router is cross-stack — pulling
    `Identity` would couple the router-boot path to the per-stack supervisor wiring, defeating the
    singleton property. The signature `Effect.Effect<void, DockerError, ChildProcessSpawner>` is the
    wire-level contract.

## Failure modes

| Trigger                                                                                     | Current behavior                                                                                                                                                                                                                                                                                                                                                    | Recovery path                                                                                                                         |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `DEVSTACK_NO_ROUTER === '1'`                                                                | `bootstrapRouterFor` short-circuits to `Effect.void`. Service primitives that pass `traefik:` to `Docker.run` later fail at `docker network connect devstack-router` (network missing); the materializer logs a warning and continues without writing a YAML. Containers remain reachable on direct ports (any `ports:` field) but unreachable via `*.localhost`.   | Unset `DEVSTACK_NO_ROUTER` and re-run `devstack up`.                                                                                  |
| Docker daemon hung — `ensureRouter` times out                                               | `bootstrapRouterFor` 10s `timeoutOrElse` logs `devstack: traefik router boot timed out after 10s (<caller>) — continuing without it` and returns void. Same outcome as `DEVSTACK_NO_ROUTER`.                                                                                                                                                                        | Restart docker daemon, re-run `devstack up`.                                                                                          |
| `docker network create devstack-router` fails (non-existence test passed but create failed) | `runCapturingOrFail` raises `DockerError(phase: 'docker network create router')`. `ensureRouter` propagates the error → `bootstrapRouterFor`'s `catch` logs the warning and continues.                                                                                                                                                                              | Investigate docker daemon state; re-run.                                                                                              |
| Existing `devstack-traefik` container has a different image                                 | Logs `traefik router image mismatch (have=X, want=Y); recreating`; `docker rm -f` (ignored); `runRouterFresh` (router.ts:253-264).                                                                                                                                                                                                                                  | Automatic.                                                                                                                            |
| `docker start devstack-traefik` fails (e.g. port now bound by another process)              | Logs `router 'docker start' failed; recreating from scratch`; `docker rm -f` (ignored); `runRouterFresh` (router.ts:275-282).                                                                                                                                                                                                                                       | The recreate will likely also fail at `docker run -p` if the port conflict is real; surfaces as `DockerError`.                        |
| YAML write fails (perms on `~/.devstack/traefik/dynamic/`)                                  | `writeFileProvider` fails with `DockerError(phase: 'router.file-provider')`. `materializeRouterEntries` catches it and logs `devstack: router file-provider write failed for <id> — <msg>`; finalizer is NOT registered (no `removeFileProvider` later); container stays up. The route is silently absent — `<hostname>:<port>` returns Traefik's default 404 page. | Fix perms; re-run. Note: warning is easy to miss in noisy supervisor output.                                                          |
| `docker network connect devstack-router <id>` returns "network not found"                   | The router boot was skipped (e.g. `DEVSTACK_NO_ROUTER`) or failed. Logs `router file-provider skipped for <id> — 'docker network connect devstack-router' exited 1 (...)`; no YAML write. Container is up but unreachable via router.                                                                                                                               | Re-run `devstack up` with the router enabled.                                                                                         |
| `inspectContainerIp` exhausts retries (3s) AFTER successful network connect                 | Promoted to `DockerError(phase: 'docker network connect / inspect ip', message: 'traefik routing for <id> failed: network attach succeeded but IP did not settle')`. **Fails the outer `Docker.run`** — entire primitive fails.                                                                                                                                     | Re-run; transient network-attach race. If persistent, suspect docker daemon health.                                                   |
| File-provider YAML body is truncated (e.g. supervisor SIGKILLed mid-write)                  | `writeFileAtomic` prevents this — the rename is atomic. A SIGKILL between writeFile and rename leaves a `.tmp.<rand>` orphan in the dir which Traefik ignores (doesn't match `*.yml`).                                                                                                                                                                              | Next supervisor boot's `writeFileProvider` overwrites the canonical name; tmp orphans accumulate but are harmless.                    |
| `defineEntrypoint` after `ensureRouter` ran                                                 | Synchronously throws if there's a conflict; silently adds to the in-memory registry otherwise. Traefik never sees the new entrypoint (it was launched with the snapshot from boot). Routes for the new entrypoint return 404 until the router is recreated.                                                                                                         | Add the `defineEntrypoint` to a module that loads before `defineDevstack`; recreate router via `prune --include-router` + `up`.       |
| Two stacks of the same app mint identical hostnames                                         | (Should be impossible due to invariant #7, but historically a refactor could regress it.) Traefik routes both stacks' traffic to whichever container matched first; the loser sees `Host:` matches against the wrong upstream.                                                                                                                                      | Caught by `services/seal/parallel-stack.test.ts` and `services/walrus.test.ts` — should be fixed at the source (the hostname helper). |
| User dials `https://*.localhost` instead of `http://`                                       | Connection refused — Traefik only binds plain HTTP entrypoints. There is no TLS configuration.                                                                                                                                                                                                                                                                      | Use `http://`.                                                                                                                        |
| `*.localhost` doesn't resolve (very old browser / non-RFC-6761 resolver)                    | Connection failed (no DNS).                                                                                                                                                                                                                                                                                                                                         | Add to `/etc/hosts` manually OR use a modern browser.                                                                                 |
| Traefik file-provider watcher misses a YAML change                                          | Should not happen — `--providers.file.watch=true` is set and uses fs notifications. If it does miss one, the route is stale; a manual `docker restart devstack-traefik` reloads the directory.                                                                                                                                                                      | Restart router via `prune --include-router` + `up`.                                                                                   |

## Persistence model

| What                                  | Survives `r` hot-restart                                       | Survives supervisor exit (Ctrl-C)                    | Survives `devstack wipe`                                           | Survives `devstack prune --include-router`                              |
| ------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `devstack-traefik` container          | Yes                                                            | Yes (left running — restart policy `unless-stopped`) | Yes                                                                | No (`docker rm -f`)                                                     |
| `devstack-router` network             | Yes                                                            | Yes                                                  | Yes                                                                | No (`docker network rm`)                                                |
| `${dynDir}/_devstack-cors.yml`        | Yes (overwritten next boot, idempotent)                        | Yes                                                  | Yes                                                                | Yes (only the docker resources are pruned; the YAML dir is not touched) |
| Per-backend `${dynDir}/<id>.yml`      | No — torn down with per-primitive scope, re-created next cycle | No — finalizers fire on scope close                  | Yes (same as above; wipe is by docker labels, not the dynamic dir) | Yes                                                                     |
| `traefikRouterIpCache` (in-memory)    | Yes (process-local, lives with supervisor)                     | No                                                   | n/a                                                                | n/a                                                                     |
| Entrypoint registry (in-memory `Map`) | Yes (process-global, JS module state)                          | No                                                   | n/a                                                                | n/a                                                                     |

The router is **not snapshot-aware** — there is no save/restore participation. The router is treated
as host infrastructure; snapshots capture per-stack state only.

What is process-local only:

- The entrypoint registry `entrypoints: Map<string, RouterEntrypoint>` (router.ts:130).
- The `traefikRouterIpCache: string | null` (router.ts:614).
- Both are reset by `resetTraefikRouterIpCacheForTesting()` (router.ts:640-642) — test-only escape
  hatch, not exported from the docker barrel.

What gets wiped on `devstack wipe`:

- **Nothing router-related**, intentionally. Per `engine/identity.ts:73-77`: "`devstack.router=true`
  is a separate router-only label … deliberately NOT a member of `DockerLabel` — `DockerLabel`
  covers the per-`<app,stack>` resource labels; ROUTER is a singleton flag on a single shared
  container with a different lifecycle." Wipe filters on `devstack.app=<app>,devstack.stack=<stack>`
  and never matches the router.

## Modes & variants

The router has effectively one mode at runtime — it's a singleton. But there are several call-time
variants of the bootstrap path and one boot-decision matrix. Tabling both for completeness.

### Bootstrap caller variants

| Dimension               | `caller: 'up'` (supervisor)                        | `caller: 'apply'` (one-shot)                                      |
| ----------------------- | -------------------------------------------------- | ----------------------------------------------------------------- |
| Entry point             | `engine/supervisor.ts:2012`                        | `cli/commands/apply.ts:131`                                       |
| Scope                   | Long-lived outer scope (survives `r`)              | The `apply` command's own scope (process exits after)             |
| Layer context           | `bootstrapCtx` (full supervisor bootstrap layer)   | `NodeServicesLayer` (just `ChildProcessSpawner`)                  |
| When invoked            | Once per supervisor lifetime, before any primitive | Once per `apply` invocation, before `Layer.build(devstack.layer)` |
| Timeout                 | 10s                                                | 10s                                                               |
| Fallback on failure     | Log warning, continue                              | Log warning, continue                                             |
| Opt-out                 | `DEVSTACK_NO_ROUTER=1`                             | `DEVSTACK_NO_ROUTER=1`                                            |
| Span attribute `caller` | `'up'`                                             | `'apply'`                                                         |
| All other behavior      | Identical                                          | Identical                                                         |

### `ensureRouter` boot-decision matrix

| State of `devstack-traefik` container | Image matches `traefik:v3.6`? | Action                                                        | Network creation | Span annotation           |
| ------------------------------------- | ----------------------------- | ------------------------------------------------------------- | ---------------- | ------------------------- |
| Absent                                | n/a                           | `runRouterFresh` (ensure network + `docker run`)              | Yes (if absent)  | (none — fresh)            |
| Running                               | Yes                           | No-op (adopt)                                                 | Idempotent check | `router.action: 'adopt'`  |
| Running                               | No                            | `docker rm -f` (ignored) + `runRouterFresh`                   | Idempotent check | (none — recreate path)    |
| Stopped                               | Yes                           | `docker start`. On failure: `docker rm -f` + `runRouterFresh` | Idempotent check | `router.action: 'resume'` |
| Stopped                               | No                            | `docker rm -f` (ignored) + `runRouterFresh`                   | Idempotent check | (none — recreate path)    |

### Per-route variants

| Dimension         | Docker container backend                                                                                                     | Host process backend                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Opt-in API        | `Docker.run({traefik: [RouterLabel,...]})` (low-level) OR `dockerContainer({routing: [...]})` (high-level plugin-author API) | Direct `writeFileProvider({...})` calls in service code (no abstraction yet — wallet + hostProcess each have their own) |
| Network attach    | `docker network connect devstack-router <id>` AFTER `docker run`                                                             | n/a (host process)                                                                                                      |
| Upstream URL      | `<protocol>://<containerIp-on-router-net>:<servicePort>`                                                                     | `http://host.docker.internal:<localPort>`                                                                               |
| YAML write site   | `engine/docker/core.ts:1188-1210` (`materializeRouterEntries`)                                                               | `services/wallet/internal.ts:233-244`, `services/dev/internal.ts:342-353`                                               |
| Finalizer site    | `addFinalizer(reuseScope, removeFileProvider(entry.id))` in materializer                                                     | `Effect.addFinalizer(() => removeFileProvider(id))` in each service body                                                |
| IP-retry budget   | 30 × 100ms = 3s                                                                                                              | n/a (host process port is known synchronously)                                                                          |
| `cors` middleware | Supported via `RouterLabel.cors` (walrus storage nodes)                                                                      | NOT used by current host-process callers (wallet/dev/hostProcess all pass `cors=false` implicitly)                      |
| `protocol: 'h2c'` | Supported via `RouterLabel.protocol` (sui-fork gRPC)                                                                         | Not used by current host-process callers                                                                                |

### Protocol variants per entrypoint

| Entrypoint | Default             | Override route can request?                                   |
| ---------- | ------------------- | ------------------------------------------------------------- |
| `sui-grpc` | `'h2c'`             | Yes via `RouterLabel.protocol` / `FileProviderEntry.protocol` |
| All others | `'http'` (implicit) | Yes via `RouterLabel.protocol` / `FileProviderEntry.protocol` |

### TLS

**There is no TLS mode.** Every entrypoint is plain HTTP (`--entrypoints.<name>.address=:<port>`, no
`--certificatesResolvers`). There is no `https://` support. Users that need TLS for parity with
production must terminate it elsewhere (e.g. a separate `mkcert`-driven nginx) — devstack does not
provide it.

## Test coverage

### `engine/router-hostname.test.ts` (36 LOC, pure unit)

| Block                                                                                                      | Asserts                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `describe('routerHostname')` → `it('omits the <stack> segment when stack is "main"')`                      | `routerHostname(id('arena','main'),'sui')` = `'sui.arena.localhost'`. `routerHostname(id('private-content','main'),'walrus-node-0')` = `'walrus-node-0.private-content.localhost'`. Verifies main-stack-special-casing. |
| `describe('routerHostname')` → `it('prepends the <stack> segment for non-main stacks')`                    | `routerHostname(id('arena','test'),'sui')` = `'test.sui.arena.localhost'`. `routerHostname(id('arena','worker-3'),'wallet')` = `'worker-3.wallet.arena.localhost'`. Verifies parallel-stack hostname isolation.         |
| `describe('routerHostname')` → `it('routerId composes <app>-<stack>-<service> and folds dots in service')` | `routerId(id('arena','main'),'sui.localnet')` = `'arena-main-sui-localnet'`. Verifies dot-folding (`.` → `-`) so docker labels are happy.                                                                               |

### `engine/docker/router.test.ts` (141 LOC, mostly pure; one fs-touching effect)

| Block                                                                                                                                          | Asserts                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `describe('renderFileProvider')` → `it('renders the canonical YAML shape for a host-process backend')`                                         | YAML body contains: `http:`, `routers:`, `arena-main-vite:`, `rule: "Host(\`dev.arena.localhost\`)"`, `entrypoints: ["vite"]`, `service: arena-main-vite`, `services:`, `url: "http://host.docker.internal:5175"`. Pins the wire format Traefik expects.           |
| `describe('file-provider lifecycle')` → `itEffect.effect('write then remove leaves the dir empty')`                                            | With `DEVSTACK_ROUTER_DYNAMIC_DIR` pointed at a tmpdir: `writeFileProvider({...})` returns a path that exists; the body contains the id and hostname; `removeFileProvider(id)` makes the file disappear. Verifies the round-trip on real fs.                       |
| `describe('file-provider lifecycle')` → `itEffect.effect('remove on a missing file is a silent no-op')`                                        | `removeFileProvider('never-existed')` does not throw. Verifies the best-effort unlink doesn't propagate `ENOENT`.                                                                                                                                                  |
| `describe('defineEntrypoint / routerEntrypoint registry')` → `it('pre-registers the in-tree entrypoints (sui-rpc, walrus, …)')`                | `routerEntrypoint('sui-rpc')` = `{name:'sui-rpc',port:9000}`; `routerEntrypoint('walrus')` = `{name:'walrus',port:9185}`; `routerEntrypoint('sui-grpc')` = `{name:'sui-grpc',port:50051,defaultProtocol:'h2c'}`. Verifies the module-load-time registrations land. |
| `describe('defineEntrypoint / routerEntrypoint registry')` → `it('returns undefined for unknown names')`                                       | `routerEntrypoint('this-name-does-not-exist-anywhere')` = `undefined`.                                                                                                                                                                                             |
| `describe('defineEntrypoint / routerEntrypoint registry')` → `it('defineEntrypoint is idempotent on identical (name, port, defaultProtocol)')` | Calling `defineEntrypoint({name:'custom-test-idempotent',port:18001})` twice doesn't throw. Verifies module hot-reload safety.                                                                                                                                     |
| `describe('defineEntrypoint / routerEntrypoint registry')` → `it('defineEntrypoint rejects a conflicting (name, different port)')`             | Re-registering with a different port throws `/conflicts with prior registration/`.                                                                                                                                                                                 |
| `describe('defineEntrypoint / routerEntrypoint registry')` → `it('listEntrypoints includes every registered entrypoint')`                      | `listEntrypoints().map(e => e.name)` contains `sui-rpc`, `walrus`, `seal`, `vite`, `deepbook-server`. Verifies snapshot surface.                                                                                                                                   |

### Related coverage outside the in-scope test files (relevant context)

These tests live in other components but cover router behavior the in-scope tests don't:

- **`engine/docker.test.ts:309-430`** — `Docker.run traefik file-provider` describe block. Verifies:
  - The container's `--label` flags do NOT contain any `traefik.*` labels (no docker-provider
    regression).
  - `docker network connect devstack-router <id>` is issued.
  - The materialized YAML body contains `http://<resolved-IP>:<port>`, the correct `Host:`, and the
    correct entrypoint.
  - Scope-close finalizers remove both YAMLs.
  - When no `traefik:` is supplied, NO network connect and NO router-IP inspect happen.
- **`engine/docker.test.ts:439-464`** — `inspectContainerIp` retry semantics. Three IP probes with
  `['','', '172.21.0.7']` returns `'172.21.0.7'` after retrying.
- **`services/seal/parallel-stack.test.ts:43-69`** — parallel-stack hostname + router-id invariants.
  Two stacks of `arena` mint distinct `routerHostname` values and distinct `routerId` values.
- **`services/walrus.test.ts:52-87`** — walrus storage-node hostnames per stack (one entry per node,
  stack-prefixed correctly).
- **`services/dev.test.ts:81-176`** — `hostProcess({traefik})` YAML lifecycle and URL surfaces.
- **`services/wallet.test.ts:127-163`** — `walletApp` endpoint URL is the router-fronted hostname
  (not the local port).
- **`services/wallet/protocol.integration.test.ts:118-140`** — integration test setup points
  `DEVSTACK_ROUTER_DYNAMIC_DIR` at a tmpdir so the protocol test doesn't trash `~`.
- **`services/seal/parallel-stack.docker.test.ts:40-63`** — (skipped placeholder) docker-side
  parallel-stack verification.

## Pain points today

1. **`getTraefikRouterIp` has no in-tree consumers** (router.ts:614-634). Exported through the
   docker barrel and documented as a "host-side diagnostics / debug surfaces" helper, but grep finds
   zero callers. Dead code OR speculative API. The memoization cell and
   `resetTraefikRouterIpCacheForTesting` reset hook exist only to support… nothing currently.

2. **`DEVSTACK_DIRECT_PORTS` is documented but not implemented** (`engine/docker/core.ts:182`). The
   comment claims the env var forces both direct host port AND router routing simultaneously, but no
   code path reads it. Either delete the comment or implement the toggle.

3. **The `docker stop` finalizer claimed in `router.ts:35-39` is missing.** The comment promises:
   "The finalizer is a `docker stop` (NOT rm) so the next `pnpm dev` resumes it in ~1s.
   `docker stop` runs only when the outer launch scope tears down (Ctrl-C / signal)…" But
   `ensureRouter` does not take a `Scope` requirement (router.ts:226-230) and `bootstrapRouterFor`
   doesn't register one either. **OPEN QUESTION**: is the doc stale (the finalizer was removed) or
   is there a finalizer I'm missing? In practice the container has `--restart unless-stopped` so a
   host reboot resurrects it, and the supervisor explicitly leaves it running — so behavior may be
   fine, but the documentation lies.

4. **Per-backend YAML write API split across three call sites with no shared abstraction.** Docker
   backends go through `materializeRouterEntries` (private to `engine/docker/core.ts`). Host-process
   backends each open-code the `writeFileProvider` + `addFinalizer` + `routerHostname` +
   `routerEntrypoint`-lookup dance — wallet (`services/wallet/internal.ts:213-245`) and hostProcess
   (`services/dev/internal.ts:316-356`) have visually-identical 30-line blocks. A shared helper
   `publishRouterRoute({id, hostname, entrypoint, upstreamUrl})` that handles the YAML + finalizer +
   lookup + error mapping would dedupe ~60 LOC.

5. **`RouterLabel` name is historically loaded.** Per the inline comment at router.ts:387-395:
   "Naming kept as `RouterLabel` for API stability — the type predates the file-provider pivot when
   these used to be stamped as `traefik.*` labels on the container." The shape now describes a
   file-provider entry; calling it "Label" is misleading. Renaming would break the
   `Docker.run({traefik})` and `dockerContainer({routing})` public API.

6. **`routerHostname` and `routerId` are duplicate-tested in `services/walrus.test.ts` and
   `services/seal/parallel-stack.test.ts`** — the same shape assertions are repeated. The
   duplication is intentional (catches regressions at each service's boundary), but the per-stack
   hostname-isolation invariant could live in a single named test that every service-level test
   depends on, rather than each service re-asserting the rules.

7. **`writeCorsMiddleware` is called inside `ensureRouter`, but it depends on `ensureDynamicDir`** —
   which itself is called inside `ensureRouter`. The middleware writer calls `ensureDynamicDir`
   again at router.ts:556. The second call is a redundant `mkdir -p` (harmless but wasted),
   suggesting the ordering coupling could be cleaner.

8. **The CORS middleware is permissive (`*` everywhere, 86400s max-age)** (router.ts:535-552). Fine
   for dev, but if anyone copies the YAML into a more-than-dev context, the wide-open policy is a
   footgun. Worth a comment.

9. **Validation regexes are loosely informed by docker/YAML constraints.** `SAFE_ID_RE`
   (`[A-Za-z0-9._-]+`), `SAFE_HOSTNAME_RE` (`[A-Za-z0-9.-]+`), `SAFE_ENTRYPOINT_RE`
   (`[A-Za-z0-9_-]+`) at router.ts:478-480. These are stricter than necessary in some cases (no
   Unicode in hostnames, but DNS allows it via IDN) and looser in others (no length cap — a 64KB
   hostname would pass). Currently fine because callers are all in-tree, but the public
   `dockerContainer({routing})` surface widens the attack surface to plugin authors.

10. **`runRouterFresh` rebinds all configured entrypoints at once.** The list comes from
    `listEntrypoints()` (router.ts:348). If a plugin author registers a NEW entrypoint after
    `ensureRouter` ran, the only way to pick it up is to recreate the router
    (`prune --include-router` + `up`). A future "hot reload of entrypoint set" would require
    rewriting `runRouterFresh` to be diff-aware.

11. **Traefik dashboard on 8080 is exposed unauthenticated.** `--api.insecure=true` (router.ts:376).
    Bound to `127.0.0.1` only, so not network-accessible, but any process on the host can poke it.
    Fine for solo dev; questionable for shared CI runners.

12. **Image pin is at `traefik:v3.6` — not pinned by digest.** A `traefik:v3.6` tag move would
    silently change Traefik's behavior on next pull. Reproducibility could be improved by
    sha256-pinning, at the cost of friendly upgrades.

## Open questions

1. **Where is the promised `docker stop` finalizer for `devstack-traefik`?** The header comment at
   router.ts:35-39 describes one, but I cannot find an `addFinalizer` for the router container in
   the codebase. Either (a) the comment is stale and there is no finalizer (container survives until
   OS shutdown or `prune --include-router`), (b) the finalizer lives elsewhere I haven't found, or
   (c) the `--restart unless-stopped` plus `docker stop` would be redundant and was removed
   deliberately. Need to clarify.

2. **Is `DEVSTACK_DIRECT_PORTS` meant to be a feature?** The JSDoc at `engine/docker/core.ts:182`
   documents it but no code reads it. Delete the documentation or implement.

3. **Should `getTraefikRouterIp` be removed?** Zero in-tree consumers. The memoization machinery and
   test-reset hook (router.ts:614-642) exist solely to support this exported function.

4. **What is the migration path for `RouterLabel` → file-provider naming?** The comment at
   router.ts:387-395 explicitly says the name is stable for API reasons. If devstack is pre-release,
   this is artificial stability — should it be renamed (e.g. `RouteEntry` / `BackendRoute`)?

5. **Does Traefik's file-provider watcher actually fire reliably on the bind-mounted
   `~/.devstack/traefik/dynamic/`?** The implementation depends on it (atomic writes +
   `--providers.file.watch=true`), and there are no test scenarios that verify a route added
   mid-supervisor-life is picked up. The implicit assumption is that since service ready-probes hit
   the routed hostname and pass in production, the watcher works — but this is end-to-end coverage,
   not a direct verification.

6. **Why is `defineEntrypoint('vite', 5175)`** chosen as a generic entrypoint name when only `dev`
   host-processes use it today? The naming binds Traefik's entrypoint registry to a specific
   frontend framework. A future Webpack/Rsbuild dev server would also reuse the `vite` entrypoint
   name — confusing nomenclature.

7. **No TLS — is HTTPS off the table forever?** Some production-parity tests (e.g. SDKs that gate
   behavior on `https:`) would benefit from a TLS-enabled mode. Adding it would require `mkcert` or
   a similar local CA flow, which is a meaningful UX cost. Worth a design conversation in the
   v2-architecture phase.

8. **Health probing of the router itself.** There's no probe of `Traefik`-as-a-process beyond
   `docker inspect`'s `.State.Running` — a Traefik that's running but crashed mid-boot would look
   healthy. Should the bootstrap GET `http://127.0.0.1:8080/ping` or similar?

9. **What happens if two `DEVSTACK_ROUTER_DYNAMIC_DIR` values point at the same dir from two
   different supervisor processes on the same host?** The atomic writes prevent torn reads, but each
   supervisor's per-cycle finalizer calls `removeFileProvider(id)` — if both supervisors mint the
   same `<app>-<stack>-<service>.yml` (impossible if their identities differ, but possible if they
   don't), one supervisor's cleanup would remove the other's live route. The convention is each
   `pnpm dev` uses a different `<app, stack>` so YAML filenames don't collide; pinning this as an
   invariant somewhere would be useful.

10. **Does the supervisor's `ensureRouter`-once-per-lifetime conflict with the case where a
    `prune --include-router` runs while a supervisor is alive?** A user could
    `devstack prune --include-router` from another shell while `pnpm dev` is running, removing the
    router container; subsequent per-primitive routes would fail at `docker network connect` and
    silently degrade. The supervisor never re-runs `ensureRouter` post-boot, so it can't self-heal.
    Re-running `r` does NOT re-run `ensureRouter` either (it's on the outer scope).

## Opportunities noticed

1. **Extract a shared `publishRouterRoute(...)` helper.** The wallet and hostProcess services each
   open-code the same ~30-line YAML write + finalizer + entrypoint lookup + error mapping block. A
   shared helper would:
   - Dedupe ~60 LOC.
   - Centralize the "log warning, continue on direct port" pattern.
   - Make adding a new host-process backend mechanically uniform with how `Docker.run({traefik})`
     works for docker backends.

2. **Remove `getTraefikRouterIp` and its memo cache** unless a consumer materializes. It's a small
   surface (4 entities including the test reset) but it carries a process-global mutable cell.

3. **Strip the `DEVSTACK_DIRECT_PORTS` mention from `core.ts:182`** since it's unimplemented.
   Currently mid-sentence in a JSDoc, which makes it look intentional.

4. **Tighten the `router.ts:35-39` lifecycle comment** to match reality (no `docker stop` finalizer;
   rely on `--restart unless-stopped` and `prune --include-router` for teardown).

5. **Consolidate parallel-stack hostname invariant assertions.** Today the contract is tested in
   three places (`router-hostname.test.ts`, `services/walrus.test.ts`,
   `services/seal/parallel-stack.test.ts`). The hostname helper is pure; one canonical "two stacks
   of same app produce distinct routes" test could replace the duplication.

6. **Rename `RouterLabel` → `RouterRoute` / `RouterEntry`.** Devstack is unreleased; the "API
   stability" justification at router.ts:387-395 doesn't apply ("No compat for never-cases" per the
   user memory).

7. **Make `defineEntrypoint` register the URL scheme alongside protocol.** Currently
   `defaultProtocol` is `'http' | 'h2c'`; if HTTPS support is ever added, every entrypoint would
   also need a `defaultScheme` (`'http' | 'https'`). Decoupling these now would save churn later. Or
   pre-decide HTTPS is out of scope and delete the question.

8. **Move CORS-middleware writing to a separate "router common config" phase.** Currently
   `writeCorsMiddleware` runs inside `ensureRouter`, but it doesn't conceptually depend on the
   container existing — it's a static configuration the file-provider would load even if Traefik was
   started later. Splitting it out would let other static configurations (e.g. logging, dashboard
   auth) live alongside.

9. **`engine/router-bootstrap.ts` could move into `engine/docker/router.ts`** — 55 LOC of glue that
   exists only to satisfy two callers. It's not large enough to warrant its own file, and "shared
   envelope for ensureRouter" is exactly what `engine/docker/router.ts` already does.

10. **Pin the Traefik image by digest** to fully decouple devstack reproducibility from upstream tag
    mutations. Currently `'traefik:v3.6'` (router.ts:65) is a moving target.

11. **`defineDevstack` could expose a `router: {enabled?: boolean, dynamicDir?: string}` config
    field** rather than relying on env vars. Env vars are fine for ops escape hatches but feel wrong
    for "I never want Traefik on this stack" as a design decision encoded in `devstack.config.ts`.

12. **Cross-reference the README/docs for `*.localhost` browser support.** Safari (some old
    versions), older mobile browsers, and corporate proxy environments sometimes DON'T auto-resolve
    `*.localhost`. A diagnostic in `devstack doctor` that checks "can DNS-resolve `foo.localhost`
    from this Node process" would catch the case where a user's environment is broken before they
    hit confusing 404s.

13. **`engine/docker/router.ts` is 642 LOC and mixes four concerns** (entrypoint registry, container
    boot, file-provider rendering, IP memoization). A split into `router/registry.ts`,
    `router/boot.ts`, `router/file-provider.ts`, `router/ip-cache.ts` would make each piece
    independently testable. (Note: doing this purely for size is a style call; the file is
    internally cohesive.)

14. **The validation regexes at router.ts:478-480 have no length cap.** A pathologically long
    upstream URL or hostname would render an enormous YAML file. Adding a max-length check would
    harden the public `dockerContainer({routing})` surface.

15. **The "two router-related modules" the assignment mentions are actually three**
    (`router-bootstrap.ts`, `router-hostname.ts`, `docker/router.ts`). All three are small,
    conceptually related, and could potentially live in a single `router/` directory under `engine/`
    — consolidating would make "the router subsystem" findable by directory rather than scattered
    across `engine/` and `engine/docker/`.
