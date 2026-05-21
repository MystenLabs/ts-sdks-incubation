# runtime-docker

## Purpose

`runtime-docker` is the layer that turns devstack's primitive-graph intent into actual containers,
images, networks, and traefik routes by shelling out to the host's `docker` CLI. Everything else in
the codebase that wants a long-lived container, a one-shot exec, an image build/pull, a docker
network, a host-port→container-port publication, or a Host()-routed entrypoint goes through one of
three entry points in this layer: `Docker.run` (long-lived, scope-managed), `Docker.runOneShot`
(run-to-completion with timeout escalation), or `Docker.exec` (one-shot exec in a running
container). The layer wraps Effect v4's `ChildProcessSpawner` so every docker invocation flows
through a single error envelope (`DockerError`), so spans / logs / pretty-error formatting see
uniform shapes; it owns the per-container race-safety story (per-name semaphore,
adopt/resume/recreate/fresh state machine, name-collision recovery), the cross-process labelling
contract (`devstack.app=…` / `devstack.stack=…` / `devstack.action=…` plus the docker-compose label
quintet), the shared traefik router lifecycle (singleton container, file-provider YAMLs, dynamic-dir
watch), the orphan-sweep mechanism that culls containers belonging to primitives the user removed
from the config since the last run, and the cross-stack `Inventory` primitives that `doctor` /
`prune` / `wipe` enumerate label-stamped resources through. The component is conceptually an adapter
behind a generic `ContainerRuntime` interface — today there is exactly one implementation (Docker /
docker-compatible CLI), but every callsite shells out via the same wrapper surface and could be
retargeted at a different runtime (podman, nerdctl, Kubernetes-via-CLI) by swapping the
`ChildProcessSpawner` recipient.

## Current implementation

In-scope files. LOC counts via `wc -l`. Source LOC total: **5594** (excluding tests). Test LOC
total: **1851**.

### Public surface (barrel + back-compat shim)

| File                     | LOC | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------ | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine/docker.ts`       | 6   | Back-compat re-export: `export * from './docker/index.js'`. Exists so the pre-split `import * as Docker from '../engine/docker.js'` pattern keeps working after the directory split (`docker.ts:1-7`).                                                                                                                                                                                                                                                                                                                |
| `engine/docker/index.ts` | 75  | Barrel re-exporting each slice's public symbols (`run`, `pull`, `build`, `exec`, `commitContainer`, `networkCreate`, `networkConnect`, `awaitContainerReady`, `dockerLogsTail`, `dockerWait`, `followLogs`, `ClaimedContainers`, `dockerOrphanSweep`, `wrapDocker`, `ensureRouter`, router constants, `defineEntrypoint`, file-provider helpers) so internal consumers can `import * as Docker from '../engine/docker.js'` (`index.ts:18-75`). Also re-exports `DockerError` from `engine/errors.ts` (`index.ts:18`). |

### `engine/docker/` slice files

| File                                | LOC  | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine/docker/core.ts`             | 1489 | `Docker.run` (long-running container, scope-managed `docker stop` finalizer, traefik file-provider materialization, log follower attach, host-port readback), the shared spawner/capture helpers (`runCapturing`, `runCapturingOrFail`, `runCapturingStreamingOrFail`, `decodeStream`, `drainLinesWithCallback`), error envelope helpers (`summarize`, `truncate`, `dockerError`, `captureToDockerError`), port-conflict pattern matcher (`isPortConflictStderr`), Rust-tracing line-level normalizer (`normalizeLogLine`), name composition (`composeContainerName` / `composeProjectName`), and IP-resolution retry loop (`inspectContainerIp`). Re-exports the pure `decideRunAction` from `ensure-container.ts`.                                                 |
| `engine/docker/ensure-container.ts` | 569  | `ensureContainer` — single race-safe primitive for adopt/resume/recreate/fresh container lifecycle. Owns the per-name semaphore registry (`ENSURE_LOCKS`), pure `decideRunAction` state machine (returns `adopt` / `resume` / `recreate(reason)` / `fresh`), TOCTOU recovery on missing-container after start, and name-collision recovery on docker-run exit 125. Subsumes the two parallel state machines that `Docker.run` and `sui-build-container::ensureContainer` previously re-implemented in lockstep (audit finding E1 per the header).                                                                                                                                                                                                                    |
| `engine/docker/exec.ts`             | 432  | One-shot helpers: `exec` (run a command inside a running container), `pauseContainer` / `unpauseContainer` (cgroup-freezer for quiescent `docker commit`), `inspectContainerRunning` (boolean state probe), `commitContainer` (snapshot RW layer to image + digest), `restartContainer` (`docker restart`), `removeContainerByName` (best-effort `docker rm -f` for invalidation paths), and `runOneShot` (TERM-then-KILL escalation, `--rm` cleanup, configurable timeout/grace, per-line streaming sink).                                                                                                                                                                                                                                                          |
| `engine/docker/image.ts`            | 391  | Image-layer wrappers: `pull` (with streaming layer-progress parser), `build` (content-addressed; stamps `devstack.image=true` label), `saveImage` / `loadImage` (tar serialization for snapshots), `tagImage` (alias under a new tag — used by snapshot restore), `imageExists` (digest probe; short-circuit for content-addressed builds), `inspectContainerImage` (read the tag string a container was created from). Includes the pure `parseDockerPullLine` state machine for layer-progress narration via `setPhase`.                                                                                                                                                                                                                                           |
| `engine/docker/inventory.ts`        | 963  | Cross-stack inventory primitives: `collectInventory` (per-(app,stack) buckets of containers/networks/volumes + state dirs + registry cross-join), `collectImageInventory` (devstack-built images, in-use flag), `collectRouterInfo` (singleton traefik probe + active backend count), `enumerateStateLocations` (filesystem walk for `.devstack/stacks/<name>/`), `removeDockerByLabel` (best-effort by-label container/network/volume teardown for `wipe`/`prune`), `computeClassification` (running/repo-gone/idle three-way row state), `parseSize` / `formatBytes`, `summarizeContainers`, `shortRepoPath`, `renderInventoryRow`, `totalsFor` / `renderTotals`, `renderRouterRow`. Read-only by construction — mutation lives in `cli/commands/_prune-stack.ts`. |
| `engine/docker/logs.ts`             | 151  | Log helpers: `followLogs` (stream a running container's stdout line-by-line for `log`-pattern ready probes), `dockerLogsTail` (best-effort `--tail N` snapshot for error enrichment), `dockerWait` (block on container exit, parse exit code), `awaitContainerReady` (race a ready probe against `dockerWait` so a crashed container surfaces its log tail).                                                                                                                                                                                                                                                                                                                                                                                                         |
| `engine/docker/network.ts`          | 120  | `networkCreate` (idempotent, labelled, optional `--subnet`/`--gateway`, NO scope finalizer by design — networks survive supervisor shutdown so the next `pnpm dev` can resume containers) and `networkConnect` (idempotent secondary-network attach with "already exists in network" swallowing).                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `engine/docker/router.ts`           | 642  | Shared cross-stack traefik router: `ensureRouter` (idempotent boot — adopt/resume/recreate/fresh probe), entrypoint registry (`defineEntrypoint`/`routerEntrypoint`/`listEntrypoints`), file-provider write/remove (`writeFileProvider`/`removeFileProvider`/`renderFileProvider`), singleton CORS middleware YAML, memoized traefik-router-network IP cache (`getTraefikRouterIp`), and the `RouterLabel` / `FileProviderEntry` / `RouterEntrypoint` types. Pre-registers in-tree entrypoints (`sui-rpc`/`sui-faucet`/`sui-graphql`/`sui-grpc`/`walrus`/`seal`/`wallet`/`vite`/`deepbook-*`) at module load (`router.ts:181-207`).                                                                                                                                  |
| `engine/docker/sweep.ts`            | 152  | Post-`Layer.build` orphan sweep: `ClaimedContainers` (Effect `Context.Reference<Ref<Set<string>>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | undefined>`written by`Docker.run`'s adopt-or-create path and read by `dockerOrphanSweep`), `StopFinalizerScope`(optional scope override for composite primitives that want sibling-container stops to fire in parallel at teardown), and`dockerOrphanSweep` (label-filtered list-and-rm of compose-project-labelled containers + networks NOT in the claim set). |
| `engine/docker/wrap.ts`             | 49   | `wrapDocker(makeError)` — pipe-compatible combinator that swaps a `DockerError` failure for a plugin-specific tagged error via the caller's factory closure. Eliminates ~25 sites of `Effect.catchTag('DockerError', cause => Effect.fail(new XError({ phase, message, cause })))` boilerplate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `engine/container-primitive.ts`     | 243  | `containerPrimitive(spec)` — plugin-author substrate for race-safe long-running container management built on top of `runDockerContainer`. Adds (1) a per-container-name `Semaphore(1)` keyed off `spec.name` so two concurrent `apply` cycles can't TOCTOU on the `docker rm` / `docker run` window, (2) `LayeredTag` wiring with auto-flattened upstream record, and (3) handle projection. Module-scoped `ensureLocks` map; mirrors the lock-registry pattern in `ensure-container.ts`.                                                                                                                                                                                                                                                                           |

### `engine/docker/` test files

| File                                     | LOC | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine/docker.test.ts`                  | 784 | `Docker.run` integration tests with stubbed spawner: reuse-if-healthy adopt, image-mismatch recreate, stopped-container resume, fresh-create on no-match, port-conflict resume-fallback with auto-allocate vs OCI-runtime resume-fallback with port preservation, traefik file-provider materialization (YAML body + network connect + finalizer removal), `inspectContainerIp` retry, `runOneShot` per-line streaming sink (multi-line default-info classification + tracing-prefix WARN/ERROR promotion + accumulated strings preserved). |
| `engine/docker/ensure-container.test.ts` | 530 | Three test groups: pure `decideRunAction` matrix (fresh / adopt / resume / recreate(image-mismatch) / recreate(unclean-shutdown) plus `expectedExitCodes: [137]` opt-out branches), happy paths (adopt, resume, recreate-image-mismatch, recreate-unclean-shutdown, fresh), and race recovery (TOCTOU `start → missing → fresh`, resume → recreate promotion with `resumeFailureStderr`, name-collision via run-callback DockerError exit 125 → start fallback).                                                                            |
| `engine/docker/image.test.ts`            | 166 | Pure-parser coverage for `parseDockerPullLine`: irrelevant-line no-op, single layer 0/1, two layers fold to 0/2, partial complete reads 1/2, all complete reads N/N, terminal Status: line settles counter, "Image is up to date" 1/1, duplicate Pulling/Pull complete are no-ops, out-of-order Pull complete still counts, realistic transcript replay, threading state is functional (no mutation).                                                                                                                                       |
| `engine/docker/inventory.test.ts`        | 269 | Pure-helper coverage: `parseSize` for SI + binary units + nonsense input, `formatBytes` rounding/units, `summarizeContainers` mixed/all-stopped/empty, `shortRepoPath` em-dash/short/deep, `renderInventoryRow` canonical layout + running PID + no-state + repo-gone flag, `totalsFor`/`renderTotals` aggregation + dedup, `volumeBytes` ignoring unknown sizes, `computeClassification` three-way state matrix (idle / running / repo-gone / idle-when-repo-exists).                                                                      |
| `engine/docker/router.test.ts`           | 141 | Pure-helper tests: `renderFileProvider` canonical YAML shape (routers/services blocks, host rule, entrypoints, upstream URL), file-provider lifecycle (`writeFileProvider` → file exists with body → `removeFileProvider` → file gone; remove-missing is a silent no-op), entrypoint registry (pre-registered in-tree entries, idempotent re-registration, conflicting `(name, different port)` throws, `listEntrypoints` includes every entry).                                                                                            |
| `engine/docker/wrap.test.ts`             | 103 | Four `wrapDocker` tests: success passthrough, DockerError→FakeError conversion, `cause` threading for pretty-error chaining, referential parity with open-coded `Effect.catchTag('DockerError', …)`.                                                                                                                                                                                                                                                                                                                                        |
| `engine/container-primitive.test.ts`     | 262 | Tag shape (key, plugin/kind/displayTitle/hidden, default kind=`'service'`, upstream auto-flatten incl. `undefined` filter, image-build sub-layers surfaced in `__layers`, deps-aware run callback constructible) + per-name lock serialisation (Effect Semaphore(1) ordering, same-name primitives share lock, different names don't, `_resetContainerLocksForTest` clears registry) + handle-projection typing flow-through.                                                                                                               |

### Out-of-scope but tightly coupled (referenced, not documented here)

The following files invoke this layer's surface and are documented elsewhere:

- `engine/supervisor.ts` — boot integration of `ClaimedContainers` + `dockerOrphanSweep` (lines 59,
  1593-1726 documented in `01-engine-core.md`).
- `engine/sui-build-container.ts` — uses `ensureContainer` directly (line 57, 142-169) → documented
  in `05-sui.md`.
- `advanced/plugin-author/docker-container.ts` — plugin-author wrapper around `Docker.run`. Surfaces
  `dockerContainer(name, options)` as a `LayeredTag`. Documented in `02-engine-resources.md` /
  plugin-author doc.
- `advanced/plugin-author/docker-image.ts` — plugin-author wrapper around `Docker.pull` +
  `Docker.build` with content-addressed tag generation. Documented in `02-engine-resources.md`.
- `advanced/plugin-author/docker-one-shot.ts` — plugin-author wrapper around `Docker.runOneShot`.
- `engine/errors.ts` — `DockerError` Schema-tagged class definition (lines 189-213).

## Configuration

Knobs callers (`defineDevstack`, primitives, plugin authors, CLI users) can set that affect this
layer.

### Per-call `DockerRunOptions` (long-running containers) — `engine/docker/core.ts:110-273`

| Knob                | Type                               | Default                                 | Notes                                                                                                                                                          |
| ------------------- | ---------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`              | `string`                           | random `devstack-<8hex>`                | Per-call primitive name. Composed with identity into `<app>[-<stack>][-<network>]-<name>`. Periods folded to hyphens (`composeContainerName`, `core.ts:1462`). |
| `image`             | `string`                           | required                                | Image reference (tag or digest).                                                                                                                               |
| `args`              | `ReadonlyArray<string>`            | none                                    | Tail args after image.                                                                                                                                         |
| `env`               | `Record<string, string>`           | none                                    | `-e KEY=value` (visible in `docker inspect`).                                                                                                                  |
| `envFiles`          | `ReadonlyArray<string>`            | none                                    | `--env-file` for secrets (not visible in `docker inspect`). Order honored; later overrides earlier; inline `env` overrides files.                              |
| `ports`             | `Record<number, number>`           | none                                    | `{ [hostPort]: containerPort }` → `-p <bindAddress>:<hostPort>:<containerPort>`.                                                                               |
| `bindAddress`       | `string`                           | `'127.0.0.1'`                           | Host interface for `-p` flags. `'0.0.0.0'` for devcontainers/WSL where loopback isn't reachable.                                                               |
| `mounts`            | `ReadonlyArray<{host, container}>` | none                                    | Bind mounts (host contains `/`) OR named volumes (no `/`). Named volumes are pre-created with labels via `ensureLabeledVolume` (`core.ts:1227-1259`).          |
| `network`           | `string`                           | none (docker default bridge)            | Primary `--network`.                                                                                                                                           |
| `addHosts`          | `ReadonlyArray<string>`            | `['host.docker.internal:host-gateway']` | `--add-host=` entries. Default makes Linux containers dial host loopback. Pass `[]` to opt out.                                                                |
| `ip`                | `string`                           | none                                    | `--ip=<ip>`. Requires `network` to be set; validated up front (`core.ts:372-379`).                                                                             |
| `hostname`          | `string`                           | none                                    | `--hostname` for in-container hostname (walrus storage nodes register peer-known names).                                                                       |
| `networkAlias`      | `string`                           | none                                    | `--network-alias`. Requires `network` (`core.ts:384-391`).                                                                                                     |
| `traefik`           | `ReadonlyArray<RouterLabel>`       | none                                    | Triggers router-network attach + file-provider YAML write per entry.                                                                                           |
| `onOutputLine`      | `(level, line) => Effect<void>`    | none                                    | Per-line sink for `docker logs --follow` (forked into `reuseScope`).                                                                                           |
| `stopGraceSeconds`  | `number`                           | docker default (10s)                    | `docker stop --time <N>`. sui-localnet bumps to 30s to flush RocksDB cleanly.                                                                                  |
| `stopSignal`        | `string`                           | docker default (SIGTERM)                | `docker stop --signal <SIG>`. `sui start`'s tokio-only-SIGINT handler needs `'SIGINT'`.                                                                        |
| `engineTagKey`      | `string`                           | none                                    | Tag key for `engine.markStopping`/`markStopped` row updates during teardown.                                                                                   |
| `expectedExitCodes` | `ReadonlyArray<number>`            | none (137 treated as unclean)           | sui-localnet passes `[137]` to keep warm-resume; `decideRunAction` then skips the unclean-shutdown branch.                                                     |
| `detach`            | `boolean`                          | `true`                                  | `-d` flag.                                                                                                                                                     |

### Per-call `DockerOneShotOptions` — `engine/docker/exec.ts:218-262`

| Knob                       | Type                    | Default            | Notes                                                              |
| -------------------------- | ----------------------- | ------------------ | ------------------------------------------------------------------ |
| `name`                     | `string`                | random             | Same `<app>-<stack>-<name>` composition as `run`.                  |
| `image`                    | `string`                | required           |                                                                    |
| `args`                     | `ReadonlyArray<string>` | none               |                                                                    |
| `env`, `mounts`, `network` | (per-call)              | none               | Same shapes as `run`.                                              |
| `entrypoint`               | `string`                | none               | `--entrypoint` override.                                           |
| `timeoutMs`                | `number`                | `600_000` (10 min) | Wall-clock budget; scope closes → spawner SIGTERMs the docker CLI. |
| `gracePeriodMs`            | `number`                | `5_000`            | SIGTERM-to-SIGKILL window via `forceKillAfter`.                    |
| `onOutputLine`             | callback                | none               | Per-line stdout/stderr sink.                                       |

### `defineDevstack` config (consumed via `Identity`)

The Docker layer reads `Identity` (`engine/identity.ts:33-39`) — the `<app, stack, network>` triple
— to compose container names, project labels, and per-stack DNS suffixes. Configuration enters via
`Layer.succeed(Identity, {...})` in `defineDevstack`; not a per-call option.

### CLI flags (consumed by inventory + prune/wipe)

`cli/commands/prune.ts` and `cli/commands/wipe.ts` invoke `collectInventory`, `removeDockerByLabel`,
`collectRouterInfo`, `collectImageInventory`. The Docker layer doesn't define CLI flags itself but
its inventory shape (`InventoryRow`, `RowClassification`) drives the picker/doctor surfaces.

### Environment variables

| Var                           | Default                       | Read where                          | Effect                                                                                                                                                                                                                                               |
| ----------------------------- | ----------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEVSTACK_ROUTER_DYNAMIC_DIR` | `~/.devstack/traefik/dynamic` | `router.ts:71`                      | Override dynamic-dir for file-provider YAMLs. Set by tests to a temp dir.                                                                                                                                                                            |
| `DEVSTACK_KEEP_ONESHOT`       | `'0'`                         | `exec.ts:301`                       | When `'1'`, skip both `--rm` flag AND the `docker rm -f` finalizer so failed one-shot containers survive for post-mortem `docker logs`.                                                                                                              |
| `DEVSTACK_DIRECT_PORTS`       | —                             | docstring at `core.ts:182-184` only | Documented but NOT IMPLEMENTED in code today — the `core.ts:422-439` portArgsFor/portArgsAuto code unconditionally honors `opts.ports` when set, with traefik exposure NOT gating the publish. OPEN QUESTION: was the env flag dropped or pending?). |

### Inventory roots (`CollectInventoryOptions.roots`)

`collectInventory({ roots })` accepts an optional `ReadonlyArray<string>` of filesystem roots to
probe for `.devstack/stacks/<stack>/` dirs (`inventory.ts:541-544`). Default: `[resolveAppDir()]`
(the appdir as resolved by `engine/resolve-app-dir.ts`, which honors `DEVSTACK_APP_DIR` env).

## Capabilities CONSUMED

### Effect services consumed

- `ChildProcessSpawner.ChildProcessSpawner` from `effect/unstable/process` — every docker
  invocation. Wrapped by `runCapturing` / `runCapturingStreamingOrFail` so spawn-only failures map
  into `DockerError` (`core.ts:1294-1382`).
- `Identity` (`engine/identity.ts:33-39`) — read by `Docker.run` (`core.ts:310`), `runOneShot`
  (`exec.ts:282`), `networkCreate` (`network.ts:23`). Provides the `<app, stack, network>` triple
  for label stamping + container-name composition.
- `Scope` (`effect/Scope`) — `Docker.run` reads the ambient scope (`core.ts:412`) and registers the
  stop finalizer there (or on a `StopFinalizerScope` override). `networkConnect` uses scope for
  finalizers in the materializer.
- `FileSystem.FileSystem` (`effect`) — `inventory.ts` uses for state-dir enumeration
  (`enumerateStateLocations`, `readLockPid`). `image.ts` uses `node:fs/promises` directly via
  `nodeFs.mkdir` for the router dynamic-dir (avoiding the `FileSystem` dep at boot,
  `router.ts:291-300`).
- `ClaimedContainers` (`docker/sweep.ts:18-21`) — read by `Docker.run` (`core.ts:413`) to register
  each adopted-or-created container id. Provided by `engine/supervisor.ts:1658` for each layer
  build, defaulted to `undefined` for standalone callers.
- `StopFinalizerScope` (`docker/sweep.ts:41-44`) — optional `Scope` override read by `Docker.run`
  (`core.ts:466-470`); when provided, the stop finalizer registers there instead of the calling
  primitive's own scope. Used by composite primitives that want parallel stop fan-out (walrus 4-node
  committee).
- `Registry` (`engine/registry.ts`) — `inventory.ts:556` reads via `Registry.read` to cross-join
  (app, stack) buckets with persisted registry entries (`inventory.ts:622-625`).
- `StateStore` is NOT consumed by this layer directly — cache integration is via `withCache` from
  `engine/cache.ts` invoked by callers like `dockerImage` (which doesn't actually go through
  `withCache` — it short-circuits via `Docker.imageExists`).

### Engine resources consumed

- `engine/errors.ts::DockerError` — the only error type this layer raises (`core.ts:9`).
  Schema-tagged with `phase` / `message` / `stdout` / `stderr` / `exitCode` / `cause`
  (`errors.ts:189-213`).
- `engine/identity.ts::DockerLabel` — `APP`, `STACK`, `NETWORK`, `ACTION` constants stamped on every
  container/network/volume (`core.ts:11`, `core.ts:349-358`, `network.ts:65-66`, `inventory.ts:24`,
  `sweep.ts:88-90`).
- `engine/capture-command.ts` — `captureCommand`, `captureCommandStreaming`, `CaptureError`,
  `decodeStream` (`core.ts:21-25`). Unifies subprocess capture across docker / sui-cli / snapshot.
- `engine/atomic-write.ts::writeFileAtomic` — used by `router.ts:563` and `router.ts:583` for
  tmp-and-rename file-provider YAML writes so traefik's watcher never sees half-written content.
- `engine/process-liveness.ts::isPidAlive` — re-exported from `inventory.ts:538` and used by
  `computeClassification` (`inventory.ts:703-708`) to decide whether a
  `.devstack/stacks/<stack>/state.json.lock` pid is still alive.
- `engine/registry.ts::Registry`, `RegistryEntry` (`inventory.ts:26`) — registry cross-join for
  inventory rows.
- `engine/resolve-app-dir.ts::resolveAppDir` — `inventory.ts:606`. Resolves `DEVSTACK_APP_DIR` or
  `cwd`.
- `engine/ready-probe.ts::awaitReady`, `ReadyProbeError`, `ReadyProbe` — `logs.ts:23`
  (`awaitContainerReady` races the probe against `dockerWait`).
- `engine/network.ts::SuiNetwork` — type only, via `Identity` shape (`identity.ts:31`).
- `advanced/tag.ts` — `tag`, `setPhase`, `LayeredTag`, `CurrentTagKey`, `TagKind`, `TuiDisplay` —
  consumed by `container-primitive.ts:21` for tag construction; `setPhase` consumed by `image.ts:14`
  for pull-progress narration.

### Runtime resources consumed

- **Host docker daemon** (`docker` CLI on `PATH`). Every long-running container, every image
  build/pull, every network create/connect, every volume create, every exec, every inspect, every
  commit, every wait, every logs follow, every label-filtered enumeration. Reachability surfaces as
  `DockerError({phase: 'docker run', stderr: 'Cannot connect to the Docker daemon...'})`.
- **Host filesystem**: `~/.devstack/traefik/dynamic/` (file-provider YAMLs),
  `~/.devstack/stacks/<stack>/` (state dirs enumerated by inventory). Defaults from `homedir()`
  (`router.ts:71`) and `resolveAppDir()` (`inventory.ts:606`).
- **Host ports** — `Docker.run` publishes via `-p <bindAddress>:<hostPort>:<containerPort>`.
  Conflicts surface as the `isPortConflictStderr` pattern (`core.ts:91-104`) and trigger
  auto-allocation on the resume-fallback path.
- **Host process signals** — `runOneShot` registers a TERM-then-KILL escalation via
  `ChildProcess.make`'s `killSignal: 'SIGTERM'` + `forceKillAfter: <ms>` (`exec.ts:341-345`).
  Container `docker stop` honors `--signal` + `--time` knobs.

### Surfaces consumed

- `EngineHandle` (`engine/engine.ts`) — `Docker.run` resolves via
  `Effect.serviceOption(EngineHandle)` (`core.ts:450-454`) BEFORE the scope finalizer is registered,
  captures the resolved handle into the finalizer's closure. The finalizer then calls
  `engine.markStopping(tagKey)` / `engine.markStopped(tagKey)` around `docker stop` to drive per-row
  teardown progress in the TUI (`core.ts:483-513`).
- TUI log sink — `onOutputLine` callbacks. `attachLogFollower` (`core.ts:826-887`) parses each line
  via `normalizeLogLine` (text-prefix `INFO|WARN|ERROR` and JSON tracing-subscriber formats) and
  forwards to the caller's sink. Process-global `ATTACHED_FOLLOWERS` set (`core.ts:768`) dedupes
  followers across hot-restart cycles so adopt paths don't spawn duplicates.
- `setPhase` from `advanced/tag.ts` — `image.ts:138-147` parses `docker pull` per-line layer
  progress and emits `pulling K/N layers (<image>)` phases via `setPhase`.

### npm dependencies

- `effect` (`Effect`, `Ref`, `Stream`, `Layer`, `Sink`, `Semaphore`, `Schema`, `Context`, `Option`,
  `FileSystem`) — every file.
- `effect/unstable/process` — `ChildProcess`, `ChildProcessSpawner` (every CLI-shelling file).
- `effect/Scope` — finalizer registration (`core.ts:7`).
- `node:fs/promises` — `router.ts:43` (`nodeFs.mkdir` for dynamic dir, `nodeFs.unlink` for
  removeFileProvider).
- `node:os::homedir` — `router.ts:44`.
- `node:path::{join, isAbsolute, resolve, relative}` — `router.ts:45`, `image.ts:11`,
  `inventory.ts:23`.
- `node:fs::{existsSync, mkdtempSync, rmSync, readFileSync, mkdirSync}` — used in tests + one
  `existsSync` call at `inventory.ts:22` for `repoPath` liveness in `computeClassification`
  (`inventory.ts:706`).

### Cross-file imports inside the layer

- `core.ts ← errors`, `engine.js` (EngineHandle), `identity.js` (DockerLabel, Identity), `sweep.js`
  (ClaimedContainers, StopFinalizerScope), `router.js` (ROUTER_NETWORK, removeFileProvider,
  writeFileProvider), `capture-command.js`, `ensure-container.js`.
- `ensure-container.ts ← errors`, `core.js` (runCapturing, summarize, truncate, Spawner).
- `exec.ts ← errors`, `identity.js`, `core.js` (most helpers).
- `image.ts ← errors`, `advanced/tag.js` (setPhase), `core.js`.
- `inventory.ts ← identity.js`, `process-liveness.js`, `registry.js`, `resolve-app-dir.js`,
  `router.js` (ROUTER_CONTAINER, ROUTER_NETWORK).
- `logs.ts ← errors`, `ready-probe.js`, `core.js`.
- `network.ts ← errors`, `identity.js`, `core.js`.
- `router.ts ← errors`, `atomic-write.js`, `core.js` (inspectContainerIp).
- `sweep.ts ← identity.js`, `core.js` (composeProjectName).
- `wrap.ts ← errors`.
- `container-primitive.ts ← errors`, `ready-probe.js`, `advanced/tag.js`,
  `advanced/plugin-author/docker-container.js`, `on-chain-artifact.js`.

## Capabilities PRODUCED

### Effect surface (the public exports from `index.ts`)

#### Long-lived containers

`run(opts: DockerRunOptions): Effect<DockerRunResult, DockerError, ChildProcessSpawner | Identity | Scope>`
— adopt or create a long-lived container; registers a scope-managed `docker stop` finalizer;
optionally materializes traefik file-provider YAMLs; returns
`{ containerId, name, reused, hostPorts }`. Full lifecycle and recreate-after-resume-failure state
machine documented under _Lifecycle_.

`runOneShot(opts: DockerOneShotOptions): Effect<DockerOneShotResult, DockerError, ChildProcessSpawner | Identity>`
— run-to-completion with TERM-then-KILL escalation, configurable timeout, optional per-line
streaming sink. Belt-and-suspenders `docker rm -f <name>` on `timeoutOrElse` resolution.

`exec(containerId, command, args?): Effect<DockerExecResult, DockerError, ChildProcessSpawner>` —
`docker exec <id> <cmd> <args...>` with captured stdout/stderr/exitCode.

`commitContainer(containerId, imageName): Effect<DockerCommitResult, DockerError, ChildProcessSpawner>`
— `docker commit` followed by `docker image inspect -f {{.Id}}` to surface the digest. Snapshot
path: pause → commit → unpause via `pauseContainer` / `unpauseContainer` for quiescent RW layer.

`pauseContainer(id)` / `unpauseContainer(id): Effect<void, DockerError, ChildProcessSpawner>` —
cgroup-freezer wrapping around `commit` for chain-state daemons.

`restartContainer(name): Effect<void, DockerError, ChildProcessSpawner>` — `docker restart` for
bind-mount config refresh (seal key rotation).

`removeContainerByName(name): Effect<void, never, ChildProcessSpawner>` — best-effort
`docker rm -f`; used by primitives that need to FORCE-recreate.

`inspectContainerRunning(id): Effect<boolean | undefined, never, ChildProcessSpawner>` — boolean
state probe (or `undefined` when no container).

`inspectContainerImage(id): Effect<string | undefined, never, ChildProcessSpawner>` — read the tag
string the container was started with.

#### Images

`pull(image): Effect<DockerPullResult, DockerError, ChildProcessSpawner>` — streaming pull with
layer-progress narration via `setPhase`. Returns `{ digest }`.

`build(opts: DockerBuildOptions): Effect<DockerBuildResult, DockerError, ChildProcessSpawner>` —
content-addressed `docker build`. Always stamps `--label devstack.image=true` (`image.ts:222`).
Returns `{ tag, digest }`.

`imageExists(tag): Effect<{digest} | undefined, never, ChildProcessSpawner>` — sub-millisecond
`image inspect -f {{.Id}}` probe for short-circuiting content-addressed rebuilds.

`saveImage(name, tarPath)` /
`loadImage(tarPath): Effect<DockerLoadResult, DockerError, ChildProcessSpawner>` — tar serialization
for snapshot save/restore.

`tagImage(source, target): Effect<void, DockerError, ChildProcessSpawner>` — `docker tag`. Used by
snapshot.restore so a `docker load`-ed snapshot image carries the supervisor's content-addressed
base tag.

#### Networks

`networkCreate(name, options?: {subnet?, gateway?, composeProject?}): Effect<string, DockerError, ChildProcessSpawner | Identity | Scope>`
— idempotent labelled bridge network. NO finalizer registered (networks persist across supervisor
lifetimes by design — see `network.ts:24-35`).

`networkConnect(network, containerId): Effect<void, DockerError, ChildProcessSpawner>` — idempotent
secondary-network attach.

#### Router

`ensureRouter: Effect<void, DockerError, ChildProcessSpawner>` — singleton traefik boot
(adopt/resume/recreate/fresh probe). Builds router network if absent, ensures dynamic-dir exists,
writes singleton CORS middleware, then probes + adopts/resumes/recreates the container.

`defineEntrypoint(entry: RouterEntrypoint): void`,
`routerEntrypoint(name): RouterEntrypoint | undefined`,
`listEntrypoints(): ReadonlyArray<RouterEntrypoint>` — synchronous entrypoint registry. Idempotent
re-registration; conflicting `(name, different port)` throws.

`renderFileProvider(entry: FileProviderEntry): string` — synchronous YAML body renderer (validates
id / hostname / entrypoint chars + upstream URL).

`writeFileProvider(entry): Effect<string, DockerError>` — atomic tmp-and-rename write. Returns the
absolute path of the written YAML.

`removeFileProvider(id): Effect<void, never>` — `unlink` swallowing failures (best-effort).

`getTraefikRouterIp(spawner): Effect<string, DockerError>` — memoized IP cache on the
`devstack-router` network.

Constants: `ROUTER_NETWORK = 'devstack-router'`, `ROUTER_CONTAINER = 'devstack-traefik'`,
`ROUTER_IMAGE = 'traefik:v3.6'`, `routerDynamicDir()` function.

Types: `RouterLabel`, `RouterEntrypoint`, `FileProviderEntry`.

#### Logs / ready

`followLogs(containerId): Stream<string, never, ChildProcessSpawner>` — line-stream of combined
stdout/stderr. Used by `log`-pattern ready probes.

`dockerLogsTail(name, lines=100): Effect<string, never, ChildProcessSpawner>` — best-effort tail;
swallows all errors to `''`.

`dockerWait(name): Effect<number, DockerError, ChildProcessSpawner>` — block until container exits;
returns exit code.

`awaitContainerReady({containerName, probe, logTailLines?}): Effect<void, ReadyProbeError, ChildProcessSpawner>`
— race ready probe against `dockerWait`. On loss, attaches log tail to the resulting
`ReadyProbeError`.

#### Sweep / claim

`ClaimedContainers: Context.Reference<Ref<Set<string>> | undefined>` — write-once per cycle;
populated by `Docker.run`; consumed by `dockerOrphanSweep`.

`StopFinalizerScope: Context.Reference<Scope | undefined>` — optional override for composite
primitives.

`dockerOrphanSweep(app, stack, network, claimed): Effect<ReadonlyArray<string>, never, ChildProcessSpawner>`
— label-filtered list-and-rm of orphaned containers + networks for the (app, stack, network) triple.
Belt-and-braces ANDs three labels (`compose.project`, `devstack.app`, `devstack.stack`) to avoid
stomping on unrelated host projects (`sweep.ts:74-91`).

#### Error wrapping

`wrapDocker(makeError): <A,R>(eff) => Effect<A, E, R>` — pipe-compatible combinator.

#### Inventory (re-exported from `inventory.ts` but consumed via `docker/index.ts` chain)

`collectInventory(options?): Effect<ReadonlyArray<InventoryRow>, never, FileSystem | ChildProcessSpawner | Registry>`,
`collectImageInventory()`, `collectRouterInfo()`, `enumerateStateLocations`, `removeDockerByLabel`,
plus pure helpers `parseSize`, `formatBytes`, `summarizeContainers`, `shortRepoPath`,
`renderInventoryRow`, `totalsFor`, `renderTotals`, `volumeBytes`, `computeClassification`,
`renderRouterRow`. Types: `InventoryRow`, `ContainerRef`, `NetworkRef`, `VolumeRef`, `ImageRef`,
`ImageInventory`, `RouterInfo`, `RowClassification`, `DockerLabelKind`, `StateLocation`,
`CollectInventoryOptions`, `InventoryTotals`.

Note: `inventory.ts`'s exports are NOT in the `docker/index.ts` barrel today (inventory is consumed
directly by `cli/commands/doctor.ts` and `cli/commands/prune.ts` via direct path import).

#### Container primitive substrate

`containerPrimitive(spec): LayeredTag<Name, Handle, never, DockerError | ReadyProbeError | UpstreamE<U>>`
— plugin-author substrate built on top of `runDockerContainer`. Adds per-container-name
`Semaphore(1)` and `LayeredTag` wiring.

`_resetContainerLocksForTest(): void` — test escape hatch.

### Container labels stamped (the cross-process contract)

Every container `Docker.run` creates carries:

1. `devstack.app=<identity.app>` (`DockerLabel.APP`, `core.ts:350`)
2. `devstack.stack=<identity.stack>` (`DockerLabel.STACK`, `core.ts:351`)
3. `devstack.action=<primitiveName>` (`DockerLabel.ACTION`, `core.ts:352`)
4. `com.docker.compose.project=<composeProjectName>` (`core.ts:353`)
5. `com.docker.compose.service=<primitiveName>` (`core.ts:354`)
6. `com.docker.compose.container-number=1` (`core.ts:355`)
7. `com.docker.compose.version=2.0.0` (`core.ts:356`)
8. `com.docker.compose.oneoff=False` (`core.ts:357`)

These five compose labels (3-7) replicate what `docker compose up` emits so Docker Desktop's UI
groups devstack containers under a single project entry. The first three (`devstack.*`) are
devstack-only; sweep / wipe / prune / inventory all enumerate by ANDing those three (or a subset).

Networks created via `networkCreate` carry:

- `devstack.app=<identity.app>` (`network.ts:65`)
- `devstack.stack=<identity.stack>` (`network.ts:66`)
- `com.docker.compose.project=<composeProject>` (`network.ts:62`)
- `com.docker.compose.network=<name>` (`network.ts:63`)
- `com.docker.compose.version=2.0.0` (`network.ts:64`)

Named volumes (pre-created by `ensureLabeledVolume`) carry:

- `devstack.app=<identity.app>` (`core.ts:1252`)
- `devstack.stack=<identity.stack>` (`core.ts:1253`)

Built images carry:

- `devstack.image=true` (`image.ts:222`) — stamped on every `docker build` so prune/inventory can
  enumerate label-filtered.

The shared router container `devstack-traefik` carries:

- `devstack.router=true` (`router.ts:369`) — distinct from the per-(app,stack) labels because the
  router is a singleton.

The router network `devstack-router` carries:

- `devstack.router=true` (`router.ts:316`).

### Files written

- `<DEVSTACK_ROUTER_DYNAMIC_DIR or ~/.devstack/traefik/dynamic>/<id>.yml` per `RouterLabel` /
  `FileProviderEntry`. Atomic via tmp-and-rename (`router.ts:563`). Each YAML contains a single
  `http:` block with one `routers:<id>:` (host rule, entrypoints array, service, optional
  middlewares) + one `services:<id>:loadBalancer.servers[]` carrying the upstream URL.
- `<DEVSTACK_ROUTER_DYNAMIC_DIR>/_devstack-cors.yml` — singleton CORS middleware written once at
  router boot. Leading underscore sorts ahead of per-route entries (`router.ts:531-552`).

### Process-global mutable state

- `ENSURE_LOCKS: Map<name, Semaphore>` (`ensure-container.ts:64`) — per-name `Semaphore(1)` registry
  for `ensureContainer` invocations.
- `ensureLocks: Map<name, Semaphore>` (`container-primitive.ts:44`) — separate per-name registry for
  `containerPrimitive` invocations. Both maps live until process exit.
- `ATTACHED_FOLLOWERS: Set<containerId>` (`core.ts:768`) — dedupe set for `docker logs -f` follower
  forks across hot-restart cycles.
- `entrypoints: Map<name, RouterEntrypoint>` (`router.ts:130`) — entrypoint registry mutated by
  `defineEntrypoint`.
- `traefikRouterIpCache: string | null` (`router.ts:614`) — memoized router IP. Reset via
  `resetTraefikRouterIpCacheForTesting()` (not exported from barrel).

### CLI commands registered

None directly. The layer surfaces inventory primitives (`collectInventory`, `removeDockerByLabel`,
…) consumed by `cli/commands/doctor.ts`, `cli/commands/prune.ts`, `cli/commands/wipe.ts`, and
`cli/commands/stack.ts`.

### Routes registered

None directly. The layer writes file-provider YAMLs that traefik reads dynamically.

### TypeScript exports consumed elsewhere

- `Docker.run` — `engine/snapshot.ts`, `engine/sui-build-container.ts`, every in-tree service
  primitive via `dockerContainer`, `containerPrimitive`.
- `Docker.pull` / `Docker.build` — `advanced/plugin-author/docker-image.ts::dockerImage`.
- `Docker.exec` — `services/postgres/internal.ts`, `services/walrus`, every primitive that exec's
  inside a running container.
- `Docker.runOneShot` — `advanced/plugin-author/docker-one-shot.ts`, walrus `deploy`, seal `keygen`,
  etc.
- `Docker.commitContainer` / `Docker.saveImage` / `Docker.loadImage` / `Docker.tagImage` —
  `engine/snapshot.ts`.
- `Docker.networkCreate` / `Docker.networkConnect` — service primitives that need explicit subnets
  (walrus storage nodes).
- `Docker.followLogs` — `engine/ready-probe.ts` for `log`-pattern probes.
- `Docker.awaitContainerReady` / `Docker.dockerWait` —
  `advanced/plugin-author/docker-container.ts:796-799`.
- `Docker.ClaimedContainers` / `Docker.dockerOrphanSweep` — `engine/supervisor.ts:59, 1658, 1718`.
- `Docker.ensureRouter` / `Docker.defineEntrypoint` / `Docker.routerEntrypoint` —
  `engine/router-bootstrap.ts`, `engine/router-hostname.ts`, every service that registers an
  entrypoint.
- `Docker.wrapDocker` — ~25 sites in `services/*/internal.ts`.

### Container images / volumes produced

Images produced:

- `devstack-<name>:<treeHash>-<configHash>` per `dockerImage({build})` call
  (`advanced/plugin-author/docker-image.ts:116`). Stamped with `devstack.image=true`.
- `devstack-snap:<id>-<name>` per snapshot save (consumed by `loadImage` in `engine/snapshot.ts`).
- Pulled tags retain their original names (no devstack-built label on pulls).

Volumes produced:

- Named volumes mounted into containers (e.g. `<app>-<stack>-postgres-data`,
  `<app>-<stack>-sui-data`) — created on-demand by `Docker.run` via `ensureLabeledVolume`
  (`core.ts:1227-1259`) BEFORE the `docker run` argv fires. Stamped with `devstack.app` /
  `devstack.stack` labels.

Networks produced:

- Per-stack `<network_name>` bridges via `networkCreate(name, options)` (idempotent, labelled).
- The cross-stack singleton `devstack-router` network (created once by `ensureRouter`).

## Lifecycle

### Startup

The Docker layer has no monolithic "startup" — each public function is independent. The closest
thing to a layer boot is `ensureRouter`, which the supervisor calls once at boot:

1. **`ensureRouter`** (called from `engine/router-bootstrap.ts` during boot, before any container
   that opts into routing):
   1. `ensureRouterNetwork(spawner)` — probes
      `docker network ls -q --filter name=^devstack-router$`; if absent, creates with
      `--label devstack.router=true` (`router.ts:302-321`).
   2. `ensureDynamicDir()` — `nodeFs.mkdir(routerDynamicDir(), {recursive: true})`
      (`router.ts:291-300`).
   3. `writeCorsMiddleware()` — atomic-writes `<dyn>/_devstack-cors.yml` (`router.ts:554-571`).
   4. `inspectRouter(spawner)` —
      `docker inspect --format '{{.State.Running}}|{{.Config.Image}}' devstack-traefik`
      (`router.ts:323-343`). Returns `null` if missing.
   5. Decision tree (`router.ts:248-283`):
      - `null` → `runRouterFresh(spawner)`
      - image mismatch → `docker rm -f` + `runRouterFresh`
      - running → adopt (annotate span)
      - stopped → `docker start`; on failure → `docker rm -f` + `runRouterFresh`
   6. `runRouterFresh` (`router.ts:345-385`) — composes the run argv with one
      `-p 127.0.0.1:<port>:<port>` per registered entrypoint + `-p 127.0.0.1:8080:8080` (traefik
      dashboard) + `-v <dynDir>:/etc/traefik/dynamic:ro` + one
      `--entrypoints.<name>.address=:<port>` flag per entry. NO docker provider; file-provider only.

2. **Each long-lived primitive's `Docker.run` call** (post-router, during `Layer.build`):
   1. Resolve `Identity` + ambient scope (`core.ts:309-412`).
   2. Compose `primitiveName` → `composeContainerName(app, stack, network, primitiveName)` and
      `composeProjectName` (`core.ts:325-336`).
   3. Validate `ip` / `networkAlias` need a `network` (`core.ts:372-391`).
   4. Resolve `EngineHandle` option BEFORE finalizer (closure capture — `core.ts:449-454`).
   5. Resolve `StopFinalizerScope` option (default reuseScope = ambient scope — `core.ts:466-470`).
   6. Pre-create named volumes with labels (`ensureLabeledVolume` per mount, best-effort —
      `core.ts:534-537`).
   7. Delegate adopt/resume/recreate/fresh state machine to `ensureContainer` (`core.ts:545-692`),
      which under per-name semaphore:
      1. `inspectContainerByName(spawner, name)` —
         `docker inspect --format '{{.State.Running}}|{{.Config.Image}}|{{.Id}}|{{.State.ExitCode}}' <name>`
         → `InspectResult | null` (`ensure-container.ts:111-144`).
      2. `decideRunAction(inspected, requestedImage, expectedExitCodes)`
         (`ensure-container.ts:193-215`).
      3. Branch on action:
         - `adopt` → invoke `spec.onAdopt(id)` and return
           `{containerId, reused: true, resumed: false, inspected}`.
         - `resume` → `dockerStart(spawner, id)`; success → `onResume`; missing → TOCTOU promote to
           `fresh`; failure → promote to `recreate(resume-failed)` with `resumeFailureStderr`.
         - `recreate(reason)` → invoke `onRecreate(reason, existingId)`; best-effort
           `removeContainerByNameBestEffort`; invoke
           `spec.run({reason: 'recreate', recreateReason, resumeFailureStderr})` via
           `createWithCollisionFallback`.
         - `fresh` → `createWithCollisionFallback(spec, {reason: 'fresh'})`.
      4. `createWithCollisionFallback` catches `DockerError` exit 125 + "already in use" stderr from
         `spec.run` and falls back to `docker start <name>` + re-inspect for adoption.
   8. Materialize router file-provider YAMLs (`materializeRouterEntries`, `core.ts:1125-1212`):
      1. `docker network connect devstack-router <id>` (idempotent — tolerates "already exists in
         network" stderr).
      2. `inspectContainerIp(spawner, id, ROUTER_NETWORK)` — retry 30× × 100ms = 3s
         (`core.ts:1062-1100`).
      3. For each `RouterLabel`:
         `writeFileProvider({id, hostname, entrypoint, upstreamUrl: '<scheme>://<ip>:<servicePort>', cors, protocol})`
         and register `removeFileProvider(id)` on `reuseScope` finalizer.
   9. `claim(containerId)` — `Ref.update(ClaimedContainers, set => new Set(set).add(id))`
      (`core.ts:413-415, 707`).
   10. Register the `docker stop` finalizer on `stopFinalizerScope` (`core.ts:478-516`).
   11. `attachLogFollower(spawner, id, name, onOutputLine, reuseScope)` — forks
       `docker logs -f --since <epoch>` into reuseScope; dedupes via `ATTACHED_FOLLOWERS`
       (`core.ts:826-887`).
   12. `inspectHostPorts(spawner, id)` — read `.NetworkSettings.Ports` first (runtime view), fall
       back to `.HostConfig.PortBindings` (config view) (`core.ts:996-1049`).
   13. Return `{containerId, name, reused, hostPorts}`.

3. **Post-`Layer.build`** (cycle 1 only, gated on `buildSucceeded`):
   - `dockerOrphanSweep(app, stack, network, claimed)` — list compose-project-labelled containers
     (ANDed with `devstack.app` + `devstack.stack`), `docker rm -f` any not in the claim set; same
     pattern for networks (`sweep.ts:65-152`). Best-effort throughout.

### Ready criteria

- For `Docker.run`: returns success when the container is running AND the host-port readback
  completes. Optional ready probe is the caller's responsibility (typically via
  `awaitContainerReady` in `dockerContainer`'s `ready` option).
- For `Docker.pull`: returns when the docker pull subprocess exits 0 AND `docker image inspect`
  returns a non-empty digest.
- For `Docker.build`: returns when `docker build` exits 0 AND `docker image inspect` returns a
  non-empty digest.
- For `Docker.runOneShot`: returns when the foreground `docker run` subprocess exits (success or
  failure).
- For `ensureRouter`: returns when the router container's `inspectRouter` reports
  adopted/resumed/freshly-created (no inner readiness check; the caller relies on the file-provider
  write completing later when they call `Docker.run({traefik: [...]})`).

### Restart behavior

The layer is heavily oriented around restart idempotence:

- **`Docker.run`**: adopt-if-image-matches via `decideRunAction`. Reuses an existing container if
  `(name, image)` matches; resumes a stopped same-image container via `docker start`; recreates on
  image mismatch or SIGKILL exit (unless `expectedExitCodes` opts out). Volume labels re-stamped on
  every cycle (`core.ts:534-537` — best-effort).
- **`Docker.networkCreate`**: probes via `docker network ls -q --filter name=^<name>$`; reuses on
  hit.
- **`ensureRouter`**: full adopt/resume/recreate/fresh probe.
- **`defineEntrypoint`**: idempotent on identical `(name, port, defaultProtocol)`; conflicting
  registration throws.
- **`writeFileProvider`**: atomic overwrite — re-running produces the same YAML body for the same
  inputs.
- **`ATTACHED_FOLLOWERS`**: process-global dedupe ensures `docker logs -f` followers don't
  accumulate across hot restarts.
- **Named volumes**: never re-created if they exist (`ensureLabeledVolume` checks existence first —
  `core.ts:1234-1239`). Pre-devstack legacy volumes survive unlabeled.

### Teardown

Per-container teardown via the scope-bound `docker stop` finalizer (`core.ts:478-516`):

1. `engine.markStopping(tagKey)` (best-effort; ignored on error).
2. `docker stop [--signal <sig>] [--time <secs>] <containerId>` via `spawner.exitCode` (errors
   swallowed via `Effect.ignore`).
3. `engine.markStopped(tagKey)`.

The finalizer is wrapped in `Effect.uninterruptible` so SIGINT-driven scope close doesn't kill the
`docker stop` subprocess mid-flight.

NO `docker rm` at teardown for long-lived primitives — the writable layer (chain state, RocksDB
stores, deploy outputs) MUST survive. `docker rm -f` is restricted to:

- `ensure-container.ts::removeContainerByNameBestEffort` — name-collision cleanup on recreate.
- `sweep.ts::dockerOrphanSweep` — sweep at the start of `Layer.build`.
- `router.ts:259-260, 277-280` — traefik router image-mismatch / start-failure recreate.
- `engine/sui-build-container.ts` — build container (no state).
- `cli/commands/stack.ts::downCommand` with `--force`.

Documented at `core.ts:1261-1276` as an invariant: long-running stateful containers go through
`docker stop`; chain state lives in the writable layer.

Networks are NOT torn down on supervisor shutdown — `networkCreate` deliberately registers NO
finalizer (`network.ts:24-35`). Cleanup is `devstack wipe` / `prune`.

Router container survives `pnpm dev` cycles — `ensureRouter` adopts/resumes on next boot. Full
teardown is `devstack prune --include-router`.

File-provider YAMLs are removed on `reuseScope` close via `removeFileProvider(id)` finalizer
(`core.ts:1210`).

Grace windows: `stopGraceSeconds` default = docker's own 10s. Stateful primitives bump this
(sui-localnet = 30s for clean RocksDB flush).

### Composite teardown parallelism (`StopFinalizerScope`)

By default each container's stop finalizer registers on the calling primitive's own layer scope,
which closes sequentially through Layer's reverse-dep teardown. For composite primitives that spawn
N sibling containers (canonical case: walrus's 4-node committee), serial close means
`N × grace = O(min)` shutdown. `StopFinalizerScope` lets the composite fork a parallel-strategy
child scope of its own reuseScope, provide it via this reference during the per-container
`Docker.run` loop, and at composite teardown the parallel close fans the `docker stop`s out
concurrently — `~max(grace)` instead of `~sum(grace)` (sweep.ts:23-39).

## Hard requirements / invariants

1. **Per-name semaphore serialisation around the adopt/resume/recreate window.** Two concurrent
   `ensureContainer` (or `containerPrimitive`) invocations with the same `spec.name` MUST serialise.
   Without this, two concurrent `apply` cycles or vitest workers can TOCTOU between the
   `docker inspect`, the `docker rm`, and the `docker run`. Enforced via module-scoped
   `Map<name, Semaphore(1)>` in `ensure-container.ts:64-73` AND `container-primitive.ts:44-53`.
   Cross-process races (two `pnpm dev` instances against the same app) rely on docker's own `--name`
   atomicity (exit 125 + "already in use") and recover via `createWithCollisionFallback`
   (`ensure-container.ts:502-569`).

2. **Container labels stamped on every container.** `Docker.run` MUST stamp `devstack.app` /
   `devstack.stack` / `devstack.action` + the five `com.docker.compose.*` labels
   (`core.ts:349-358`). Sweep / wipe / prune all enumerate via these three devstack-only labels
   ANDed together. Missing any → resource is orphan-by-construction (sweep can't find it). Volumes
   get `devstack.app` + `devstack.stack` via `ensureLabeledVolume` (`core.ts:1252-1253`). Built
   images get `devstack.image=true` via `build` (`image.ts:222`). Networks get five labels via
   `networkCreate` (`network.ts:60-66`).

3. **AND on three labels for orphan sweep filtering** (NOT just compose-project).
   `dockerOrphanSweep` ANDs `com.docker.compose.project` AND `devstack.app` AND `devstack.stack`
   (`sweep.ts:74-91`) so a host project with a coincidentally-matching compose-project name can't
   get nuked. Documented as belt-and-braces; the project label alone would be a false-positive
   vector.

4. **Post-build orphan sweep, NOT pre-build.** Sweeping BEFORE the layer build nukes still-healthy
   sui-localnet containers from a previous process before `Docker.run`'s adoption path can reuse
   them, forcing fresh genesis → new chainId → publishMove cache miss → new packageId every restart
   (`sweep.ts:60-64`). The sweep MUST run AFTER `Layer.build` completes, gated on `buildSucceeded`
   (failed builds leave the claim set incomplete and sweeping would destroy siblings' healthy
   containers — see `engine/supervisor.ts:1707-1716`).

5. **Reuse-if-healthy short-circuit.** When `inspect` reports `running == true` AND image matches,
   `Docker.run` MUST skip `docker rm` AND `docker run`, just adopt the container id, run the stop
   finalizer registration, and return `{reused: true}` (`ensure-container.ts:417-425`). Stops a
   fresh genesis on every restart. Asserted in `docker.test.ts:168-188`.

6. **Resume-if-healthy `docker start`.** When `inspect` reports `running == false` AND image matches
   AND `lastExitCode != 137` (unless opt-in), `Docker.run` MUST resume via `docker start <id>`
   instead of `docker rm + docker run`. ~1s start vs cold genesis. Asserted in
   `docker.test.ts:215-244` and `ensure-container.test.ts:320-338`.

7. **TOCTOU recovery on `start → missing`.** When `docker start <id>` reports "No such container",
   `ensureContainer` MUST promote to `fresh` and invoke `spec.run({reason: 'fresh'})` — a peer's
   finalizer rm'd the container between our inspect and our start (`ensure-container.ts:442-451`).
   Asserted in `ensure-container.test.ts:409-431`.

8. **Resume-fallback port handling.** When `docker start` fails AND stderr matches
   `isPortConflictStderr` (`core.ts:91-104`), the fresh recreate MUST drop `opts.ports` and pass
   `-p <bind>::<container>` so docker auto-allocates. When stderr does NOT match the port-conflict
   patterns (OCI runtime error, image-pull glitch, daemon hiccup), the fresh recreate MUST keep the
   caller's original `opts.ports`. Without this, seal-key-server's `http://localhost:2024` endpoint
   silently moves under a primitive that already published the URL (`core.ts:618-643`, asserted in
   `docker.test.ts:486-606`).

9. **Name-collision recovery via `docker start`.** When the caller's `run` callback fails with
   `DockerError({exitCode: 125, stderr: 'already in use'})`, `createWithCollisionFallback` MUST
   `docker start <name>` and re-inspect to adopt the peer's container
   (`ensure-container.ts:502-569`). Single-shot — a second collision is a typed failure, not an
   infinite loop. Asserted in `ensure-container.test.ts:463-499`.

10. **`expectedExitCodes` opt-out covers ONLY the unclean-shutdown branch.** Image mismatch still
    wins regardless (`ensure-container.ts:206-211`). sui-localnet passes `[137]` to keep warm-resume
    across SIGKILL-by-design. Asserted in `ensure-container.test.ts:164-178`.

11. **No `docker rm` of stateful long-running containers at teardown.** Chain state lives in the
    writable layer. The `docker stop` finalizer is the ONLY teardown for long-lived primitives.
    `docker rm -f` is reserved for: name-collision cleanup on recreate, orphan sweep, router image
    mismatch, sui-build, `wipe`/`prune` explicit flags (`core.ts:1261-1276`).

12. **`docker stop` finalizer uninterruptible.** Wrapped in `Effect.uninterruptible` so
    SIGINT-driven scope close doesn't kill the subprocess mid-flight. Without this, containers can
    be left in indeterminate state (`core.ts:480-481`).

13. **`docker stop --signal` for SIGTERM-deaf binaries.** `sui start --with-faucet` only registers a
    SIGINT handler via `tokio::signal::ctrl_c()` — SIGTERM is ignored and the container hits its
    grace timeout → SIGKILL (exit 137 + "UNCLEAN PRIOR SHUTDOWN" alert on next boot). Primitives
    wrapping such binaries MUST set `stopSignal: 'SIGINT'` (`core.ts:222-234`).

14. **`onOutputLine` follower fork is `Effect.forkIn(scope)`, NOT a manual `Fiber.interrupt`
    finalizer.** Manual interrupt would join on the drainer's natural exit (only when
    `docker logs -f` itself closes), defeating the fork (`core.ts:847-887`). Cancellation happens
    via the scope-bound fork.

15. **`ATTACHED_FOLLOWERS` dedupe.** Process-global `Set<containerId>` prevents accumulating
    orphaned `docker logs -f` children across hot-restart cycles. Synchronous `Set.add` before fork
    is atomic — two near-simultaneous attaches can't both pass the check (`core.ts:768, 836-857`).

16. **Routes use file-provider, NOT docker-provider.** Containers attach to two networks
    (per-stack + `devstack-router`); the docker-provider's container-events listener fires on the
    FIRST event when the container has only its per-stack IP. Traefik would capture the wrong URL
    and never re-fetch → 502s until manual router restart. File-provider works because the
    supervisor knows the router-network IP AFTER `docker network connect` returns and writes the
    resolved YAML synchronously (`router.ts:17-28`).

17. **`writeFileProvider` is atomic via tmp-and-rename.** Traefik's file-provider watcher MUST NEVER
    observe a half-written YAML body. A torn read on startup makes traefik refuse to load any
    subsequent updates from the same file until something else mutates it
    (`router.ts:559-562, 577-582`).

18. **`inspectContainerIp` retries.** `docker network connect` is asynchronous — the new endpoint
    registers with the daemon BEFORE the per-network IP is settled, so a naive single inspect races.
    Retry 30× × 100ms = 3s budget (`core.ts:1062-1100`). Asserted in `docker.test.ts:439-463`.

19. **`docker network connect` returning "already exists in network" must be tolerated as
    idempotent.** Used by adopt-path reattach and by `materializeRouterEntries` to handle
    warm-restart cycles. Detected via stderr substring match (`core.ts:1160-1163`,
    `network.ts:108-110`).

20. **`networkCreate` registers NO scope finalizer.** Networks outlive the supervisor process
    (containers `docker stop`ped instead of removed need to resume into the same network). Removing
    the network on shutdown orphans stopped containers — they can't `docker start` back, and
    recreating a same-named network gives them a different bridge id (`network.ts:24-35`).

21. **`hostPorts` is read back from `docker inspect`, NOT from `opts.ports`.** On resume/reuse
    `docker start` ignores the caller's freshly-allocated `opts.ports` — only `docker run` honors
    them. On auto-allocate (`-p <bind>::<container>`), the actual binding is unknown until inspect.
    The runtime view (`.NetworkSettings.Ports`) is tried first, falling back to the config view
    (`.HostConfig.PortBindings`) for stopped containers (`core.ts:967-1049`).

22. **Content-addressed image build cache short-circuit.** `dockerImage({build})` computes a tag of
    shape `devstack-<name>:<treeHash>-<configHash>`; if `imageExists(tag)` returns a digest, the
    build is SKIPPED. Without this, the warm-cache build path would re-tag the image, destroying a
    `tagImage(snap, originalTag)` from snapshot.restore and silently losing chain state
    (`advanced/plugin-author/docker-image.ts:114-137`, `image.ts:166-188`).

23. **CORS middleware is a singleton YAML written once at router boot.** Loaded BEFORE any backend
    references it (filename prefix `_` sorts ahead of per-stack entries) — walrus storage nodes
    don't emit CORS headers themselves and browser fetches would otherwise be blocked
    (`router.ts:531-571`).

24. **Pre-create labelled volumes BEFORE `docker run -v`.** Docker's lazy-create at
    `-v <name>:<path>` time creates volumes WITHOUT labels, accumulating ~100MB of RocksDB /
    postgres / walrus state per cycle that no label-filter can find. `ensureLabeledVolume` runs
    up-front (`core.ts:518-537`). Bind mounts (host contains `/`) are user-owned and must NOT be
    pre-created.

25. **`runOneShot` belt-and-suspenders `docker rm -f`.** The inner `Effect.scoped` registers a
    `docker rm -f` finalizer that's the PRIMARY teardown. But `timeoutOrElse` is permitted to
    surface its `orElse` failure before the inner scope's finalizer has been observed to complete,
    so on the timeout path a container could outlive the function. An
    `Effect.ensuring(docker rm -f)` AFTER `timeoutOrElse` catches this; on the happy path the
    container is already gone and the rm exits non-zero (ignored) (`exec.ts:403-431`).

26. **`runOneShot` honors `DEVSTACK_KEEP_ONESHOT=1` consistently.** When set, both `--rm` is dropped
    AND the finalizer is skipped — failed one-shot containers survive for `docker logs <name>`
    post-mortem (`exec.ts:299-360`).

27. **CI fast-fail gates AFTER the orphan sweep.** A failed first-cycle build (non-interactive
    renderer) MUST exit non-zero, but the sweep's `cycle === 1 && buildSucceeded` guard runs first
    so a failed cycle is a no-op against docker state — protecting sibling stacks' healthy
    containers (engine/supervisor.ts:1707-1716).

## Failure modes

| Failure                                                       | Trigger                                                                                        | Current behavior                                                                                                                                                                                                                                                                                                   | Recovery path                                                                                              |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Docker daemon unreachable                                     | `docker run` / `inspect` / `ps` exits non-zero with "Cannot connect to the Docker daemon"      | `runCapturing` wraps subprocess exit into `DockerError({phase, exitCode, stderr})`; `runCapturingOrFail` re-fails.                                                                                                                                                                                                 | Caller surfaces via pretty-error; user starts Docker Desktop and retries.                                  |
| Image pull failed (manifest unknown / network)                | `docker pull` exits non-zero                                                                   | `DockerError({phase: 'docker pull', exitCode, stderr})` via `runCapturingStreamingOrFail`. Layer-progress narration via `setPhase` settles at the partial state.                                                                                                                                                   | Caller surfaces; user investigates registry / proxy. No automatic retry.                                   |
| Port conflict on fresh run                                    | `docker run -p <bound>:<inner>` exits non-zero; stderr matches `isPortConflictStderr` patterns | On the `fresh` path: no special handling — the `DockerError` propagates. On the `resume-failed` recreate path: ports are dropped and re-allocated via `-p <bind>::<container>`, then `inspectHostPorts` reads the granted port back.                                                                               | `docker.test.ts:486-545`.                                                                                  |
| Container exited 137 (SIGKILL on cycle teardown)              | `docker stop --time <grace>` expired before workload could clean up                            | `decideRunAction` returns `recreate(unclean-shutdown)` on next cycle. `Docker.run`'s `onRecreate` logs the UNCLEAN_PRIOR_SHUTDOWN banner (`core.ts:587-595`).                                                                                                                                                      | Container is rm'd and recreated. `expectedExitCodes: [137]` opts out (sui-localnet).                       |
| Container exited any code that's in `expectedExitCodes`       | Caller declared the exit code as expected                                                      | `decideRunAction` ignores the exit and adopts/resumes.                                                                                                                                                                                                                                                             | sui-localnet path.                                                                                         |
| Image mismatch (caller bumped image tag)                      | `inspect` reports a different `.Config.Image` than requested                                   | `recreate(image-mismatch)` → `docker rm -f` + fresh `docker run` with caller's ports.                                                                                                                                                                                                                              | Documented at `ensure-container.ts:199-205`.                                                               |
| Name collision (`docker run` exit 125 + "already in use")     | A peer beat us to the create                                                                   | `createWithCollisionFallback` catches the DockerError, runs `docker start <name>`, re-inspects to read the peer's id (`ensure-container.ts:502-569`).                                                                                                                                                              | Single-shot. Second collision returns a typed `DockerError({phase: 'docker start (collision recovery)'})`. |
| `docker start` reports "No such container" (TOCTOU)           | Peer's finalizer rm'd the container between our inspect and start                              | Promotes to `fresh` and invokes `spec.run({reason: 'fresh'})` (`ensure-container.ts:442-451`).                                                                                                                                                                                                                     | Asserted in `ensure-container.test.ts:409-431`.                                                            |
| `docker network connect devstack-router` fails                | Router network missing (caller didn't start traefik) OR daemon error                           | Logs a warning (`core.ts:1169-1173`), skips file-provider write entirely, container keeps direct-port access. EXCEPT — "endpoint already exists in network" treated as idempotent (`core.ts:1160-1163`).                                                                                                           | Failure here is tolerated; the inspect-ip path below promotes failures to `DockerError`.                   |
| `inspectContainerIp` exhausts retry budget                    | Docker network attach didn't settle inside 30 × 100ms                                          | Wrapped as `DockerError({phase: 'docker network connect / inspect ip'})` and promoted to a hard failure of the outer `Docker.run` (`core.ts:1177-1187`). Silent swallow would leave the container live but unreachable through the YAMLs.                                                                          | Caller surfaces; user investigates docker daemon health.                                                   |
| `writeFileProvider` write fails (FS perms)                    | `~/.devstack/traefik/dynamic` unwritable                                                       | Logged as warning via `Effect.catch` (`core.ts:1202-1207`); the per-entry finalizer is NOT registered, so subsequent removeFileProvider on scope-close would unlink a file that was never written (silent no-op via the error-swallowing `removeFileProvider`). Container keeps running with direct-port access.   | User chmod's the dir.                                                                                      |
| `renderFileProvider` validation throws                        | Caller passed a YAML-unsafe id / hostname / entrypoint / upstreamUrl                           | `validateEntry` throws synchronously inside the `tryPromise` `try`; caught by `tryPromise` and wrapped into `DockerError({phase: 'router.file-provider'})` (`router.ts:573-591`).                                                                                                                                  | Programming error; caller fixes the route shape.                                                           |
| `defineEntrypoint` after `ensureRouter` already ran           | Plugin author registered out of order                                                          | The new entrypoint is in the registry but the running traefik container doesn't know about it (no `--entrypoints.<name>.address=...` flag passed). Routes hit 404 until next `pnpm dev` recreate.                                                                                                                  | Documented as programming error at `router.ts:122-128`.                                                    |
| `defineEntrypoint` with conflicting port                      | Two registrations for same name, different port                                                | Throws synchronously (`router.ts:147-153`) — overwriting would let two callers fight over the same name.                                                                                                                                                                                                           | Caller fixes one of the registrations.                                                                     |
| `runOneShot` timeout fires                                    | Wall-clock budget exhausted (default 10 min)                                                   | `Effect.timeoutOrElse` fails with `DockerError({phase: 'docker run (one-shot)', message: '... timed out after Nms'})`. Scope close fires SIGTERM, then SIGKILL after `gracePeriodMs`. The post-timeout `Effect.ensuring(docker rm -f)` catches any container that outlived the foreground CLI (`exec.ts:415-431`). | Caller decides retry/abort.                                                                                |
| `runOneShot` exit non-zero                                    | Workload failed                                                                                | Returns `{exitCode, stdout, stderr}` with the non-zero code — does NOT throw. Caller chooses to inspect (e.g. walrus deploy converts to `WalrusError`).                                                                                                                                                            | Caller responsibility.                                                                                     |
| `commitContainer` returns empty digest                        | `docker image inspect -f {{.Id}}` returned empty                                               | Wrapped as `DockerError({phase: 'docker commit', message: 'docker image inspect returned empty digest...'})` (`exec.ts:179-188`).                                                                                                                                                                                  | Caller surfaces.                                                                                           |
| Snapshot load: no `Loaded image:` line                        | `docker load` succeeded but printed only a digest                                              | `DockerError({phase: 'docker load', message: 'docker load produced no "Loaded image:" line...'})` (`image.ts:322-331`).                                                                                                                                                                                            | Caller chooses fresh genesis.                                                                              |
| Inventory: spawner failure for any docker enum command        | Daemon down                                                                                    | `spawner.string(cmd).pipe(Effect.orElseSucceed(() => ''))` — every enumeration falls back to empty (`inventory.ts:95, 148, 196, 247`). Returns an empty inventory.                                                                                                                                                 | Doctor reports "no resources found"; no false errors.                                                      |
| Inventory: malformed `docker system df` JSON                  | Docker version drift                                                                           | Tries one-shot JSON.parse, falls back to line-delimited; returns empty size map on failure (`inventory.ts:252-274`). Volume sizes show as "size unknown".                                                                                                                                                          | Best-effort by design.                                                                                     |
| `dockerOrphanSweep` `docker rm -f` fails for an individual id | Container stuck in `removing` state                                                            | Per-id error swallowed via `Effect.orElseSucceed`; sweep continues with other ids (`sweep.ts:108-115, 144-150`).                                                                                                                                                                                                   | Returns the partial removed list.                                                                          |
| `removeDockerByLabel` `docker rm` fails for an id             | Volume in use, network has stray endpoint, etc.                                                | Best-effort; the failing id is omitted from the returned `removed` array (`inventory.ts:954-961`).                                                                                                                                                                                                                 | Caller (prune/wipe) surfaces in the summary.                                                               |
| `getTraefikRouterIp` retries exhausted                        | Router never attached to its own network                                                       | `DockerError({phase: 'docker inspect ip', message: 'failed to resolve IP...'})` propagated.                                                                                                                                                                                                                        | Bug upstream — supervisor's `ensureRouter` should have completed before any consumer.                      |

## Persistence model

### What survives restart

- **Containers stopped via `docker stop` finalizer** survive. Their writable layer (chain state,
  RocksDB, deploy outputs, etc.) is preserved. Adopt-resume path on next `pnpm dev`.
- **Named volumes** survive. Pre-created with `devstack.app` / `devstack.stack` labels; never
  auto-removed.
- **Bind mounts** survive (host filesystem state).
- **Networks** survive. `networkCreate` registers NO finalizer.
- **Built images** survive on the docker daemon. Content-addressed tags (`devstack-<name>:<hash>`)
  plus the `devstack.image=true` label.
- **Router container `devstack-traefik`** survives across supervisor invocations. Adopt/resume
  across `pnpm dev` calls.
- **Router network `devstack-router`** survives.
- **File-provider YAMLs** are REMOVED on `reuseScope` close per route (`core.ts:1210`). So on a
  clean Ctrl-C they disappear; on a crashed process they persist (the next `Docker.run` overwrites
  them atomically).
- **CORS middleware YAML `_devstack-cors.yml`** survives — written once at router boot, never
  removed by this layer. `devstack prune --include-router` is the only path that removes it (out of
  scope here).
- **In-memory `ATTACHED_FOLLOWERS`, `ENSURE_LOCKS`, `ensureLocks`, `entrypoints`,
  `traefikRouterIpCache`** — process-local, die with the supervisor.

### What survives snapshot

A subset of "what survives restart" plus an image-commit:

- `snapshot.save` calls `pauseContainer` → `commitContainer(id, imageName)` → `unpauseContainer` →
  `saveImage(name, tarPath)` (out of scope for this doc but consumes this layer's surface).
- Volume mount contents are NOT in the snapshot — snapshots capture only the writable container
  layer (no `docker save -v`). Chain state living in the writable layer survives; named-volume state
  does not.
- Networks, router YAMLs, ClaimedContainers — none persisted.

### What gets wiped on `devstack wipe`

`cli/commands/wipe.ts` invokes `removeDockerByLabel(spawner, 'container', app, stack)` then
`'volume'` then `'network'` (`inventory.ts:933-963`). Three label-filtered `docker ps -aq + rm -f` /
`volume ls -q + rm` / `network ls -q + rm` passes. The router container + network are NOT touched
(different label namespace; `devstack prune --include-router` is the explicit opt-in path).

### What is process-local only

- `ENSURE_LOCKS` map (`ensure-container.ts:64`).
- `ensureLocks` map (`container-primitive.ts:44`).
- `ATTACHED_FOLLOWERS` set (`core.ts:768`).
- `entrypoints` registry map (`router.ts:130`) — but rebuilt at module load by the same
  `defineEntrypoint` calls in every process, so functionally per-process-deterministic.
- `traefikRouterIpCache` (`router.ts:614`) — memoization across one supervisor invocation.

## Modes & variants

This component is effectively single-mode: there is exactly one container-runtime adapter (Docker
CLI). The closest things to "modes" are orthogonal toggles on the _call_ level, not the layer level:

| Dimension                                                | Description                                                                                                                                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`Docker.run` vs `runOneShot` vs `exec`**               | Three distinct lifecycle shapes for the three usage classes (long-lived daemon / run-to-completion / exec-in-running). Not modes of the same operation — separate entry points. |
| **`detach: true` (default for `Docker.run`) vs `false`** | All long-running primitives use detach. `detach: false` is theoretically supported on the type level but unused in-tree (would block the calling fiber until container exit).   |
| **Adopt vs Resume vs Recreate vs Fresh**                 | Branches of the same `ensureContainer` state machine, selected by `decideRunAction` per call. Not modes — runtime decisions.                                                    |
| **`expectedExitCodes` opt-out**                          | Per-primitive flag that changes the unclean-shutdown branch of `decideRunAction` only. sui-localnet uses `[137]`; everyone else uses `[]` (default).                            |
| **`StopFinalizerScope` override**                        | Composite primitives opt in to parallel stop fan-out; single-container primitives use the default (calling primitive's own layer scope).                                        |
| **`onOutputLine` per-line streaming sink**               | Wired by primitives that want supervisor log-tail visibility (walrus deploy, seal keygen). Default: no follower spawned.                                                        |
| **`DEVSTACK_KEEP_ONESHOT=1` env**                        | Per-process opt-in to keep one-shot containers for post-mortem `docker logs`.                                                                                                   |
| **`{pull}` vs `{build}` vs `{tag}` image source**        | `dockerContainer`'s image union. `{tag}` is the internal escape hatch for callers that already materialized via a sibling `dockerImage`.                                        |

There is no docker-vs-podman switch today, no remote-daemon switch, no docker-compose switch. The
Effect service `ChildProcessSpawner.ChildProcessSpawner` provides the only seam — replacing it with
a podman-aware spawner would in principle Just Work for argv-compatible operations, but the layer
makes no commitment about that today (the stderr-pattern matchers for port conflict / name collision
/ "already exists in network" / "No such container" assume Docker's exact wording).

## Test coverage

### `engine/docker.test.ts` (784 LOC)

Top-level setup: a stubbed `ChildProcessSpawner` layer (`makeSpawnerLayer`) that records every
docker invocation and answers per `args[0]` with canned `{stdout, stderr, exitCode}` payloads.
Variants distinguished by `--format` template (name-inspect / port-bindings inspect / router-IP
inspect). `inspectResponse` controls the name-inspect shape; `startStderr`, `portBindingsJson`,
`routerIpSequence`, `startExitCode` cover the resume-fallback and IP-retry scenarios.
`identityLayer` provides `Identity({app:'testapp', stack:'main', network:'localnet'})`.

- **`describe('Docker.run reuse-if-healthy')`**
  - `it.effect('adopts an existing healthy container with the same image (skips docker run)')` —
    name-inspect returns `running:true` + matching image; assert
    `containerId === EXISTING_CONTAINER_ID` AND no `args[0] === 'run'` recorded.
  - `it.effect('recreates when an existing container is running a DIFFERENT image')` — inspect
    returns mismatched image; assert `containerId === FAKE_CONTAINER_ID` AND `ps` runs before `run`
    (the rm-by-name `docker ps` query).
  - `it.effect('resumes a stopped container with matching image via docker start instead of re-running')`
    — inspect `running:false`, image matches; assert no `run`, yes `start <id>`,
    `result.reused === true`.
  - `it.effect('creates a new container when nothing matches the requested name')` — inspect returns
    null; assert a `run` was recorded.

- **`describe('Docker.run traefik file-provider')`** (uses `withTempRouterDir` to pin
  `DEVSTACK_ROUTER_DYNAMIC_DIR`)
  - `it.effect('attaches to the router network and writes one file-provider YAML per RouterLabel with the resolved IP')`
    — `routerIpSequence: ['172.21.0.3']`; inside the scope assert both YAMLs
    (`testapp-main-sui-rpc.yml`, `testapp-main-sui-faucet.yml`) exist with the resolved IP folded
    into upstream URLs; assert no `traefik.*` labels on the run command; assert
    `docker network connect devstack-router <id>` was issued; assert scope close removes the YAMLs.
  - `it.effect('omits the network connect and file-provider work when no traefik entries are supplied')`
    — no `traefik` option; assert no `network connect` AND no router-IP inspect was attempted.

- **`describe('inspectContainerIp')`**
  - `it.live('retries while docker reports an empty IP and returns the first non-empty value')` —
    `routerIpSequence: ['', '', '172.21.0.7']`; assert returned IP is `'172.21.0.7'` AND exactly 3
    IP-inspect calls recorded. `it.live` because the retry sleeps real time.

- **`describe('Docker.run resume-fallback')`**
  - `it.effect('PORT CONFLICT: when docker start fails with "port is already allocated", recreate WITHOUT the caller-supplied host port')`
    — stopped container, `startStderr` matches port-conflict pattern, `portBindingsJson` says docker
    auto-allocated 55512→9000; assert the fresh `docker run` includes `127.0.0.1::9000` (not
    `127.0.0.1:9001:9000`); assert `result.hostPorts === {55512: 9000}` AND
    `result.reused === false`.
  - `it.effect('NON-PORT FAILURE: when docker start fails with an OCI runtime error, recreate WITH the ORIGINAL host port')`
    — same setup but `startStderr` is "OCI runtime create failed"; assert fresh `docker run`
    includes `127.0.0.1:2024:2024` (NOT `127.0.0.1::2024`); assert
    `result.hostPorts === {2024: 2024}`.

- **`describe('Docker.runOneShot onOutputLine')`** (uses `makeOutputSpawnerLayer` that emits known
  stdout/stderr from the `run` invocation)
  - `it.effect('forwards every stdout AND stderr line through the callback in their original order (default level: info)')`
    — every captured line is `'info'`; lines sorted equality check.
  - `it.effect('promotes stderr lines carrying an embedded tracing WARN/ERROR prefix to the matching level')`
    — Rust-tracing-style stderr lines get level upgraded to `warn`/`error` and message body stripped
    of timestamp+level.
  - `it.effect('preserves the accumulated stdout/stderr strings on the result')` —
    `result.stdout === 'line-a\nline-b'`.
  - `it.effect('absent callback preserves the historical decode-to-string behavior')` — no callback
    → `result.stdout` contains the input.

### `engine/docker/ensure-container.test.ts` (530 LOC)

Pure parser group + integration with stubbed spawner.

- **`describe('decideRunAction')`** (pure)
  - `'returns fresh when no container by that name exists'`
  - `'returns adopt for a running container with the matching image'`
  - `'returns resume for a stopped container with the matching image'`
  - `'returns recreate(image-mismatch) for a running container with a DIFFERENT image'`
  - `'returns recreate(image-mismatch) for a stopped container with a DIFFERENT image'`
  - `'returns recreate(unclean-shutdown) for a stopped container with exit 137'`
  - `'returns recreate(unclean-shutdown) for a running container whose prior run exited 137'`
  - `'returns resume for a stopped container that exited cleanly (exit 0)'`
  - `'honors expectedExitCodes: [137] and resumes a stopped container that exited 137'`
  - `'honors expectedExitCodes: [137] and adopts a running container that previously exited 137'`
  - `'still recreates on image mismatch even when 137 is in expectedExitCodes'`

- **`describe('ensureContainer happy paths')`**
  - `'adopts an existing running container with the matching image'` — `run` callback never invoked,
    no `run`/`start`/`rm` in recorder.
  - `'resumes a stopped container with the matching image via docker start'` — `run` never invoked,
    `start <id>` recorded.
  - `'recreates with recreateReason=image-mismatch when the existing container runs a different image'`
    — `run` called once with `{reason:'recreate', recreateReason:'image-mismatch'}`, `ps`-based rm
    sweep before run.
  - `'recreates with recreateReason=unclean-shutdown when the prior run exited 137'` — `run` called
    with `recreateReason:'unclean-shutdown'`.
  - `'runs fresh when no container by that name exists'` — `run` called with `{reason:'fresh'}`.

- **`describe('ensureContainer race recovery')`**
  - `'falls back to fresh create when docker start reports "No such container"'` — TOCTOU; `run`
    called with `{reason:'fresh'}`, `start` was still attempted.
  - `'promotes resume → recreate with resumeFailureStderr when docker start fails for non-TOCTOU reasons'`
    — `run` called with
    `{reason:'recreate', recreateReason:'resume-failed', resumeFailureStderr: '... port is already allocated'}`.
  - `'falls back to docker start when the run callback fails with exit 125 + "already in use"'` —
    peer-collision; `start <NAME>` issued exactly once; the peer's container id returned (read via
    post-start re-inspect).
  - `'propagates non-collision DockerError from the run callback without retrying'` — exit 1 with
    generic stderr; `run` called once; no `start` retried.

### `engine/docker/image.test.ts` (166 LOC)

Pure-parser coverage for `parseDockerPullLine`. Replay helper passes a list of lines through the
parser and collects emitted phase strings.

- `'emits nothing for irrelevant lines'`
- `'counts a single "Pulling fs layer" as 0/1'`
- `'two layer-pull lines fold into 0/2 (numerator stays at 0)'`
- `'a Pull complete on the first layer reads 1/2'`
- `'all layers complete reads N/N'`
- `'terminal Status line bumps the counter to N/N even mid-progress'`
- `'"Image is up to date" emits a 1/1 even with no layer lines'`
- `'a duplicate "Pulling fs layer" is a no-op'`
- `'a duplicate "Pull complete" is a no-op'`
- `'out-of-order Pull complete (cached layer with no prior Pulling fs layer) still counts'`
- `'realistic docker pull transcript replays end-to-end'`
- `'threading state across calls is functional (no in-place mutation)'`

### `engine/docker/inventory.test.ts` (269 LOC)

- **`describe('parseSize')`** — table-driven via `it.each` for SI/binary/nonsense.
- **`describe('formatBytes')`** — table-driven for rounding + unit selection.
- **`describe('summarizeContainers')`** — zero / mixed / all-stopped.
- **`describe('shortRepoPath')`** — em-dash / short / deep cases.
- **`describe('renderInventoryRow')`** — canonical layout / runningPid → "← running" / no state /
  repo-gone → "[repo gone]" + short path.
- **`describe('totalsFor / renderTotals')`** — aggregation + app dedup.
- **`describe('volumeBytes')`** — undefined sizes ignored.
- **`describe('computeClassification')`** — idle / running (process.pid) / repo-gone (nonexistent
  path) / idle when repoPath exists.

### `engine/docker/router.test.ts` (141 LOC)

- **`describe('renderFileProvider')`** — canonical YAML shape for a host-process backend; assert
  presence of `http:` / `routers:` / `services:` blocks, host rule, entrypoints, upstream URL.
- **`describe('file-provider lifecycle')`**
  - `itEffect.effect('write then remove leaves the dir empty')` — write → file exists with body →
    remove → file gone (temp `DEVSTACK_ROUTER_DYNAMIC_DIR`).
  - `itEffect.effect('remove on a missing file is a silent no-op')` — no-op asserted by absence of
    failure.
- **`describe('defineEntrypoint / routerEntrypoint registry')`**
  - `'pre-registers the in-tree entrypoints (sui-rpc, walrus, …)'`
  - `'returns undefined for unknown names'`
  - `'defineEntrypoint is idempotent on identical (name, port, defaultProtocol)'`
  - `'defineEntrypoint rejects a conflicting (name, different port)'`
  - `'listEntrypoints includes every registered entrypoint'`

### `engine/docker/wrap.test.ts` (103 LOC)

- `'passes the success channel through unchanged'`
- `'converts a DockerError failure into the plugin-specific error'`
- `'threads the original DockerError as cause for pretty-error chaining'`
- `'matches the open-coded Effect.catchTag equivalence (referential parity)'`

### `engine/container-primitive.test.ts` (262 LOC)

- **`describe('containerPrimitive (tag shape)')`** — 8 tests
  - `'produces a LayeredTag with the spec.name as the key'`
  - `'stamps plugin / kind / hidden / displayTitle through to the LayeredTag'`
  - `"defaults kind to 'service' when not specified"`
  - `'auto-flattens upstream record values into __upstreamKeys'`
  - `'conditional undefined upstream entries drop from __upstreamKeys'`
  - `'surfaces image-build sub-layers in __layers (static run)'`
  - `'hidden:true sets __hidden on the tag'`
  - `'accepts a deps-aware run callback'`

- **`describe('containerPrimitive (per-name lock serialisation)')`** — 4 tests
  - `it.live('Effect Semaphore(1) serialises concurrent operations')` — the semaphore primitive
    itself.
  - `'two containerPrimitives with the same name share their lock (constructible)'`
  - `'different names produce different tags (no false sharing)'`
  - `'_resetContainerLocksForTest clears the lock registry'`

- **`describe('containerPrimitive (handle projection typing)')`** — 1 test
  - `'typed Handle parameter flows through the tag'` — generic positions exercised at type level.

## Pain points today

1. **Three parallel name-lock registries.** `ensure-container.ts:64` (`ENSURE_LOCKS`),
   `container-primitive.ts:44` (`ensureLocks`), and (out of scope) `engine/file-lock.ts` for
   state-store locks all open-code module-scoped `Map<name, Semaphore(1)>`. The `ensure-container`
   lock already serialises `Docker.run` calls; `container-primitive`'s lock layers ANOTHER semaphore
   on top, calling into `runDockerContainer.effect` which internally calls `Docker.run` which
   internally calls `ensureContainer` which takes the SAME-named lock. Two locks, same name, serial
   acquisition. Not incorrect, just redundant work (`container-primitive.ts:205`
   `lock.withPermits(1)(containerEff)`).

2. **`engine/docker.ts` shim is dead weight.** Six lines exist solely to keep
   `import * as Docker from '../engine/docker.js'` working after the slice split. Every internal
   consumer could be sed-changed to `from '../engine/docker/index.js'` and the file deleted.
   Documented at `docker.ts:1-5` as a compat shim.

3. **DEVSTACK_DIRECT_PORTS documented but not implemented.** `core.ts:182-184` documents an env-var
   gate for "publish host ports AND traefik labels simultaneously", but the code unconditionally
   honors `opts.ports` regardless of `opts.traefik` being set. Either docstring is wrong or the
   implementation regressed.

4. **`router.ts` is 642 LOC and serves five concerns.** Boot logic (`ensureRouter` / network create
   / fresh router run), entrypoint registry (`defineEntrypoint` / `routerEntrypoint`), file-provider
   lifecycle (`writeFileProvider` / `removeFileProvider` / `renderFileProvider`), the singleton CORS
   middleware, AND the memoized router-IP cache. Each is small enough on its own that they couldn't
   be slimmed individually, but the file has the lifetime characteristics of three different
   modules.

5. **`inventory.ts` is 963 LOC and mixes pure helpers with effectful collectors.** `parseSize`,
   `formatBytes`, `summarizeContainers`, `computeClassification`, `renderInventoryRow`, `totalsFor`,
   etc. are unit-testable pure functions in the same file as `collectInventory` /
   `collectImageInventory` / `collectRouterInfo` / `removeDockerByLabel` (every one of which shells
   out to docker). The pure half could live in `inventory/render.ts` independent of
   `ChildProcessSpawner`; the effectful half could live in `inventory/collect.ts`.

6. **`ATTACHED_FOLLOWERS` is a process-global side effect.** `core.ts:768` keeps a
   `Set<containerId>` outside any layer/scope. Tests that spawn multiple `Docker.run` calls with the
   same container id (vitest sequential runs within one worker) leak entries until the next attach
   with the same id checks-and-fails the dedupe. There's no `_resetFollowerSet` test escape hatch.

7. **`entrypoints` registry is a process-global mutable map.** `router.ts:130`. Pre-registered at
   module load via `defineEntrypoint` calls in the same file (`router.ts:181-207`). Tests that need
   a clean slate can only ADD entries; they can't remove. The
   `'defineEntrypoint rejects a conflicting (name, different port)'` test must use a unique
   synthetic name (`'custom-test-conflict'`).

8. **`traefikRouterIpCache` lifetime exceeds the supervisor's by design.** `router.ts:614`.
   Memoization across one process. A `devstack prune --include-router` that recreates the router
   AFTER the cache is populated would serve the stale IP, but the comment at `router.ts:618-627`
   argues this is unreachable because prune requires `pnpm dev` to restart. There's a
   `resetTraefikRouterIpCacheForTesting` but it's not in the barrel.

9. **`Docker.run`'s body is 425 lines (core.ts:300-739).** The bulk is the run-options validation +
   label assembly + finalizer wiring; the actual `ensureContainer` delegation is one call. Hard to
   refactor without re-introducing the duplication that audit E1 collapsed.

10. **`ensure-container` and `Docker.run` BOTH have per-name semaphores.** `Docker.run`'s outer
    scope acquires `ensureContainer`'s semaphore via the helper call; `container-primitive`'s OWN
    semaphore wraps the `runDockerContainer.effect` (which in turn calls `Docker.run`). Three lock
    acquisitions for one container start. The redundancy isn't asserted by any test.

11. **`runOneShot`'s belt-and-suspenders rm is structurally suspicious.** `exec.ts:415-431` admits
    "On the happy path the container is already gone — `docker rm -f` on a missing name exits
    non-zero, which we ignore." Every successful one-shot wastes a docker round-trip on the
    redundant rm. Could be made conditional on `Effect.timeoutOrElse`'s failure case.

12. **`DockerLabel.NETWORK` is exported but never used.** `identity.ts:81`. The label key is defined
    but no `--label devstack.network=…` arg is stamped anywhere in `docker/` today. Either dead or
    pending.

13. **`labels?: Record<string, string>` on `DockerContainerOptions` is documented as "Reserved knob:
    Docker.run does not yet plumb arbitrary caller labels".** Plugin authors can declare custom
    labels but the engine ignores them (`advanced/plugin-author/docker-container.ts:330-340`).

14. **`mounts[].readonly?: boolean` is documented as "Reserved for future use".** Same — public
    surface accepts the flag but `Docker.run` doesn't pass it to docker
    (`advanced/plugin-author/docker-container.ts:114-120`).

15. **Cross-stack singleton router is convenient but couples teardown semantics.** The router lives
    across stacks and across `pnpm dev` invocations; `devstack prune --include-router` is the only
    way to clear it. A bug in `runRouterFresh`'s entrypoint argv assembly (e.g. a plugin defining
    `defineEntrypoint('foo', 9001)` after boot) requires a `prune --include-router` to fix. There's
    no per-process "reset" path.

16. **`fork.e2e.docker.test.ts` and `snapshot.fork.docker.test.ts` and `snapshot.docker.test.ts` in
    the parent directory are e2e tests** that exercise this layer against a real docker daemon.
    They're not enumerated above because the task scope was the unit tests; if they exist for the
    runtime-docker doc, they validate happy paths against the real CLI but aren't part of the
    encoded spec.

17. **Sweep does NOT clean up file-provider YAMLs from prior crashed processes.** If a process is
    SIGKILL'd between `writeFileProvider` and the scope-close `removeFileProvider`, the YAML
    survives on disk; the next `Docker.run` for the same primitive overwrites it correctly, but a
    primitive that was REMOVED from the config leaves an orphan YAML referring to a stopped/removed
    container. Traefik will 502 on requests until the file is manually deleted or `devstack wipe`
    runs.

## Open questions

1. **What's the relationship between `containerPrimitive`'s lock and `ensureContainer`'s lock?**
   Both keyed on `spec.name`. Both `Semaphore(1)`. The outer `containerPrimitive` call wraps
   `runDockerContainer.effect` which calls `Docker.run` which calls `ensureContainer`. Is the
   redundancy intentional defense-in-depth, or vestigial from a refactor?

2. **Is `DEVSTACK_DIRECT_PORTS=1` planned or dropped?** Documented in `core.ts:182-184` but no
   `process.env.DEVSTACK_DIRECT_PORTS` read in the codebase. If dropped, the docstring is
   misleading. If planned, the implementation is missing.

3. **What's the canonical place to register a plugin-author entrypoint?** `router.ts:122-128` says
   "callers must register BEFORE `ensureRouter` runs" and recommends "from their own module
   top-level". But the entrypoint registry is a process-global mutable singleton — a plugin author
   whose code is dynamically imported after boot is silently broken. Should this be enforced at the
   type level / a registry-deadline contract?

4. **Why does `routerHostname`/`routerId` (in `engine/router-hostname.ts`) live outside the
   `docker/` directory?** They're used by `docker-container.ts` and `materializeRouterEntries`;
   their canonical "router" identity feels like docker/ slice's concern.

5. **Is `Docker.tagImage` only ever called by snapshot.restore?** A grep would clarify; the comment
   at `image.ts:336-345` describes one use case explicitly, but the public export suggests broader
   audience.

6. **`engine/docker.ts` (the back-compat shim) — when is it safe to delete?** All internal imports
   would need to be sed'd. The shim has no other purpose per its own comment (`docker.ts:1-5`).

7. **The `pauseContainer` / `unpauseContainer` API is documented as snapshot-only.** Any other
   consumer? If not, should they be co-located with `commitContainer` (already there) and not part
   of the public barrel?

8. **`removeContainerByName` is documented as "NOT for cycle-teardown".** Which call sites use it
   today, and is the "force-recreate before Docker.run" pattern still load-bearing or has it been
   subsumed by the unclean-shutdown branch of `decideRunAction`?

9. **`DockerLabel.NETWORK` (defined at `identity.ts:81`) is never used.** Dead or pending?

10. **`labels?: Record<string, string>` and `mounts[].readonly?: boolean` are public-surface knobs
    that the engine silently ignores.** Are these planned for vNext, or should they be removed?

11. **`docker/index.ts` does NOT re-export `inventory.ts` / `inspectContainerIp` /
    `getTraefikRouterIp` / `pauseContainer`/`unpauseContainer`.** Intentional API surface trimming,
    or oversight?

12. **Cross-process container claim safety.** Per-name semaphore handles in-process; docker `--name`
    atomicity handles cross-process; sweep removes ORPHANED containers on cycle-1 only. But two
    concurrent `pnpm dev` invocations of the SAME app on the same machine will both attempt to adopt
    the same containers. Reuse-if-image-matches means both adopt fine, but the SECOND `pnpm dev`
    will register a `docker stop` finalizer that fires when ITS scope closes — potentially stopping
    containers the first process is still using. OPEN QUESTION: is this scenario protected somehow
    (file-lock?), or relied on the user not doing it?

13. **The `'engine/docker.ts'` 31KB test file scoped me to "lots of requirements encoded here"** —
    I've enumerated every `describe` / `it.effect` block, but the `it.live` retry test depends on
    real wall-clock sleeps which feels load-bearing but is only one assertion. Is there meant to be
    broader coverage of the retry budget exhaustion path?

## Opportunities noticed

1. **Delete `engine/docker.ts` (the 6-line compat shim).** Run
   `find … -exec sed -i 's|from .../engine/docker\.js|from .../engine/docker/index.js|g'` and delete
   the file. The shim's only justification is back-compat with imports inside the package itself;
   there's no external API surface.

2. **Collapse `ensureContainer`'s lock + `containerPrimitive`'s lock into one.** Both are keyed on
   the same name; the redundant `withPermits(1)` in `containerPrimitive` should either be removed
   (delegate to `ensureContainer`) or moved up (and `ensureContainer` should expose a lock-less
   primitive that callers wrap). Three semaphore acquisitions per container start when one suffices.

3. **Split `inventory.ts` into `inventory/collect.ts` (effectful) and `inventory/render.ts`
   (pure).** Pure helpers (~30% of the file) test cleanly without `ChildProcessSpawner`; the
   effectful collectors are an Effect-pure concern. Two files, both <500 LOC, no behavior change.

4. **Split `router.ts` into `router/boot.ts` + `router/entrypoints.ts` + `router/file-provider.ts` +
   `router/cors.ts` + `router/ip-cache.ts`.** Five concerns, each <150 LOC. Each has independent
   test footprint already (`router.test.ts` only covers the file-provider + entrypoint slices today;
   adding tests for boot is awkward because the slice mixes them).

5. **Pure-function-extract `decideRunAction` from `ensure-container.ts` into
   `decide-run-action.ts`.** Currently re-exported through both `ensure-container.ts` and `core.ts`.
   Moving it to its own file makes it the obvious unit-test target (it's already covered
   exhaustively).

6. **Hoist `RouterLabel` / `FileProviderEntry` / `DockerLabel.*` into a `runtime-docker/types.ts` so
   consumers don't have to import from leaf files.** `RouterLabel` is currently imported from
   `engine/docker/router.js` even though `Docker.run` consumes it via the barrel.

7. **Make the `entrypoints` registry per-`defineDevstack` instead of process-global.** Today's
   pattern (pre-register at module load) is fragile to dynamic imports and makes test isolation hard
   (`router.test.ts:118-130` uses synthetic names to avoid pollution). Moving the registry to a
   `Context.Reference` provided by `defineDevstack` would fix both.

8. **`ATTACHED_FOLLOWERS` could move to a `Context.Reference<Ref<Set<string>>>` provided by the
   supervisor**, mirroring the `ClaimedContainers` pattern. Process-global mutable Set is exactly
   the anti-pattern `ClaimedContainers` was introduced to avoid.

9. **`traefikRouterIpCache` could be replaced by a one-shot `Effect.cachedFunction`** rather than a
   hand-rolled `let traefikRouterIpCache: string | null`. The `resetTraefikRouterIpCacheForTesting`
   would then become unnecessary (Layer reconstruction would freshen the cache).

10. **`runOneShot`'s belt-and-suspenders rm could be conditional on `Effect.timeoutOrElse`'s failure
    case.** Today every happy-path one-shot does a wasted `docker rm` round-trip after the `--rm`
    did its job (`exec.ts:415-431`). The cost is small but pervasive.

11. **`removeDockerByLabel` and `dockerOrphanSweep` could share a `removeByQuery` helper.** Both do
    `ls -q --filter` → loop over ids → `rm -f`. The label-set differs but the shape is identical
    (`inventory.ts:933-963`, `sweep.ts:65-152`).

12. **`isPortConflictStderr`, `isNameCollisionStderr`, `isNoSuchContainerStderr` are three sibling
    patterns in `ensure-container.ts:305-326` and `core.ts:91-104`.** They're a coherent "stderr
    classifier" module that could move to a single `stderr-classifiers.ts`. Future error patterns
    (image-pull glitches, daemon timeouts) could attach there.

13. **`parseDockerPullLine` lives in `image.ts` and is exported just for tests.** It belongs in a
    `pull-progress-parser.ts` module — the host file does I/O while this is a pure state machine.

14. **`renderFileProvider` validates synchronously and throws** (`router.ts:497-508`) — every other
    failure in the layer surfaces as `DockerError`. The behavior is correct (programming errors
    should throw, not return a typed error), but the asymmetry is jarring; documenting it as a
    deliberate invariant in the architecture doc would help.

15. **`engine/snapshot.ts` calls `pauseContainer` → `commitContainer` → `unpauseContainer`
    directly.** Could be folded into a `commitContainerQuiescent(id, imageName, runningProbe)`
    helper that handles the running-state check (currently each snapshot callsite has to manually
    gate on `inspectContainerRunning`).

16. **The five compose-\* labels in `Docker.run` could be a helper function**
    `composeDockerLabels(identity, primitiveName): ReadonlyArray<string>` — currently inlined at
    `core.ts:349-358`. Same set is duplicated in `network.ts:60-66` (different fields but same
    compose-version + project shape).

17. **`DockerLabelKind` in `inventory.ts:893` shadows the `DockerLabel` constant exported from
    `identity.ts`** (different value, same name family). Rename to `DockerResourceKind` to avoid
    confusion.

18. **Image inventory's "unlabelled orphan" count** is reported as a doctor hint but never
    auto-cleaned (`inventory.ts:377-409`). Two `docker images` calls per inventory pass. A more
    efficient path: stamp the label on every devstack-built image (already happens), assume any
    `devstack-*` named image without the label is pre-revision-X, and surface the migration as a
    one-shot helper rather than a perpetual count.

19. **No timeout on `Docker.run`'s `docker run` invocation itself.** `runOneShot` has `timeoutMs`;
    `Docker.run` does not. A daemon that hangs during the foreground `docker run -d` will block
    layer build indefinitely. The Docker daemon is supposed to return immediately with the container
    id once it's queued, so this is rare, but worth considering.

20. **Sweep-and-claim could be lifted into a `ContainerRuntime` interface concept.** Today the
    orphan-sweep logic is docker-specific (label filters, compose-project name format). A generic
    runtime interface would expose `enumerateClaimable(identity)` and `purge(id)` and the sweep loop
    would consume those — making the podman/nerdctl substitution actually feasible.

21. **`writeFileProvider` always reads `routerDynamicDir()` afresh per call** instead of caching the
    resolved path. Cheap but unnecessary.

22. **The `DEVSTACK_KEEP_ONESHOT` env is read inside `runOneShot` via `process.env`** rather than
    threaded through Effect's `safeEnv` helper. Inconsistent with the rest of the codebase's env
    handling.

23. **The interface enumeration below makes clear that `ContainerRuntime` has ~25 distinct
    operations.** That's a wide surface — a natural design phase question is whether some of those
    should compose (e.g. `restart = stop + start`, `pauseAndCommit = pause + commit + unpause`) at
    the interface boundary or remain primitive.

## Capabilities PRODUCED — Interface surface for ContainerRuntime

If `runtime-docker` were redesigned as one impl behind a generic `ContainerRuntime` interface, the
call sites today require the following methods. Signatures use Effect types as observed in code; `R`
channels are noted where they apply.

### Image management

```ts
pull(image: string)
  : Effect<{digest: string}, DockerError, ContainerRuntime>
build(opts: { context, dockerfile?, buildArgs?, platform?, tag })
  : Effect<{tag: string, digest: string}, DockerError, ContainerRuntime>
imageExists(tag: string)
  : Effect<{digest: string} | undefined, never, ContainerRuntime>
tagImage(source: string, target: string)
  : Effect<void, DockerError, ContainerRuntime>
saveImage(name: string, tarPath: string)
  : Effect<void, DockerError, ContainerRuntime>
loadImage(tarPath: string)
  : Effect<{tag: string}, DockerError, ContainerRuntime>
inspectContainerImage(containerId: string)
  : Effect<string | undefined, never, ContainerRuntime>
```

### Container lifecycle — long-lived

```ts
run(opts: DockerRunOptions)
  : Effect<DockerRunResult, DockerError, ContainerRuntime | Identity | Scope>
  // Internally: inspectContainerByName → decideRunAction → adopt | resume | recreate | fresh
  // → label stamp + finalizer registration + traefik file-provider + log follower + host-port readback

inspectContainerByName(name: string)
  : Effect<InspectResult | null, never, ContainerRuntime>
inspectContainerRunning(containerId: string)
  : Effect<boolean | undefined, never, ContainerRuntime>

restartContainer(name: string)
  : Effect<void, DockerError, ContainerRuntime>
removeContainerByName(name: string)
  : Effect<void, never, ContainerRuntime>     // best-effort

pauseContainer(containerId: string)
  : Effect<void, DockerError, ContainerRuntime>
unpauseContainer(containerId: string)
  : Effect<void, DockerError, ContainerRuntime>
commitContainer(containerId: string, imageName: string)
  : Effect<{digest: string}, DockerError, ContainerRuntime>
```

### Container lifecycle — one-shot

```ts
exec(containerId: string, command: string, args?: ReadonlyArray<string>)
  : Effect<DockerExecResult, DockerError, ContainerRuntime>

runOneShot(opts: DockerOneShotOptions)
  : Effect<DockerOneShotResult, DockerError, ContainerRuntime | Identity>
  // Internally: timeout escalation + scope-finalizer rm + per-line streaming
```

### Networks

```ts
networkCreate(name: string, opts?: { subnet?, gateway?, composeProject? })
  : Effect<string, DockerError, ContainerRuntime | Identity | Scope>
  // NO finalizer registered by design — caller-managed lifetime

networkConnect(network: string, containerId: string)
  : Effect<void, DockerError, ContainerRuntime>
  // Idempotent on "already exists in network"
```

### Logs / readiness

```ts
followLogs(containerId: string)
  : Stream<string, never, ContainerRuntime>
dockerLogsTail(containerName: string, lines?: number)
  : Effect<string, never, ContainerRuntime>
dockerWait(containerName: string)
  : Effect<number, DockerError, ContainerRuntime>
awaitContainerReady({ containerName, probe, logTailLines? })
  : Effect<void, ReadyProbeError, ContainerRuntime>
```

### Inventory

```ts
collectContainers(filter: LabelFilter)
  : Effect<ReadonlyArray<ContainerRef>, never, ContainerRuntime>
collectNetworks(filter: LabelFilter)
  : Effect<ReadonlyArray<NetworkRef>, never, ContainerRuntime>
collectVolumes(filter: LabelFilter)
  : Effect<ReadonlyArray<VolumeRef>, never, ContainerRuntime>
collectImages(filter: LabelFilter)
  : Effect<ReadonlyArray<ImageRef>, never, ContainerRuntime>
removeByLabel(kind: 'container' | 'network' | 'volume', filter: LabelFilter)
  : Effect<ReadonlyArray<string>, never, ContainerRuntime>  // returns removed ids
```

### Sweep / claim

```ts
ClaimedContainers: Context.Reference<Ref<Set<string>> | undefined>
StopFinalizerScope: Context.Reference<Scope | undefined>

orphanSweep(app: string, stack: string, network: string, claimed: ReadonlySet<string>)
  : Effect<ReadonlyArray<string>, never, ContainerRuntime>
```

### Router (separable concern — feasibly a `ReverseProxy` interface on top of `ContainerRuntime`)

```ts
ensureRouter
  : Effect<void, DockerError, ContainerRuntime>
defineEntrypoint(entry: { name, port, defaultProtocol? }): void
routerEntrypoint(name: string): RouterEntrypoint | undefined
listEntrypoints(): ReadonlyArray<RouterEntrypoint>
writeFileProvider(entry: FileProviderEntry)
  : Effect<string, DockerError>
removeFileProvider(id: string)
  : Effect<void, never>
renderFileProvider(entry: FileProviderEntry): string   // pure
getTraefikRouterIp
  : Effect<string, DockerError, ContainerRuntime>
```

### Error mapping helper

```ts
wrapDocker<E>(makeError: (cause: DockerError) => E)
  : <A, R>(eff: Effect<A, DockerError, R>) => Effect<A, E, R>
```

### Pure / shared helpers (no runtime dependency)

```ts
decideRunAction(inspected: InspectResult | null, requestedImage: string, expectedExitCodes?: ReadonlyArray<number>): RunAction
parseDockerPullLine(state: DockerPullProgress, line: string, image: string): { state, phase? }
composeContainerName(app: string, stack: string, network: string, primitiveName: string): string
composeProjectName(app: string, stack: string, network: string): string
isPortConflictStderr(stderr: string): boolean
normalizeLogLine(defaultLevel: 'info' | 'warn' | 'error', rawLine: string): { level, line }
parseSize(s: string): number | undefined
formatBytes(n: number): string
computeClassification({ entry, runningPid }): 'running' | 'repo-gone' | 'idle'
```

### Container primitive substrate (consumes the interface; not part of it)

```ts
containerPrimitive(spec): LayeredTag<Name, Handle, never, DockerError | ReadyProbeError | UpstreamE<U>>
```

### Cross-cutting capabilities the interface assumes from its environment

- `ChildProcessSpawner.ChildProcessSpawner` (today's implementation seam — provided by
  `NodeChildProcessSpawner` for Node, hypothetically replaceable by a podman/nerdctl spawner if
  argv-compatible).
- `Identity` — read by `run`, `runOneShot`, `networkCreate` to compose names + stamp labels. The
  interface fundamentally assumes a name-composition policy (cross-stack collision avoidance).
- `Scope` — required by long-lived operations (`run`, `networkCreate`) for finalizer registration.
- `EngineHandle` (optional) — for per-row teardown progress markers. The interface should accept
  this as optional so callers without a TUI/engine can drop it.
- `ClaimedContainers` (optional Ref) — for orphan sweep tracking. The interface should accept this
  as optional so standalone callers don't pay the bookkeeping cost.
- File system (`~/.devstack/traefik/dynamic/`) — required by the router subsystem; could be an
  injected `DynamicConfigSink` interface so a different reverse-proxy impl can pick its own delivery
  channel.
- Host stderr (logging) — only for the CI-fast-fail prettyError dump path in supervisor; not a
  runtime-docker concern.

### Implementation-defining label / naming contracts

These are NOT part of the interface signature but ARE part of the contract any impl must honor:

- Container/network/volume label set: `devstack.app=<app>`, `devstack.stack=<stack>`,
  `devstack.action=<name>` (containers only).
- Five `com.docker.compose.*` labels per container/network for IDE grouping.
- `devstack.image=true` on built images.
- `devstack.router=true` on the singleton router container + network.
- Name composition: `<app>[-<stack>][-<network>]-<primitiveName>`, periods folded to hyphens.
- Compose-project name: `<app>` for default `<stack='main', network='localnet'>`, `<app>-<stack>`
  when stack differs, `<app>-<stack>-<network>` when network differs.

If a future impl renames the labels or alters the name composition, every CLI tool that enumerates
by label (`devstack doctor`, `devstack prune`, `devstack wipe`) breaks.
