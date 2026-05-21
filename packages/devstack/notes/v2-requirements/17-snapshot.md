# snapshot

## Purpose

The **snapshot** component captures a point-in-time, fully-replayable image of a running devstack
stack — its state-store record, the per-stack `runtime/` directory tree (where every service's
host-side persisted state lives), and a `docker commit`-ed tar of every container's writable layer —
so that a `wipe` + `restore` cycle returns the stack to byte-identical chain state, package IDs,
account keys, walrus deploy outputs, seal master-keys, and indexer-DB cursors. Snapshot is the
load-bearing primitive behind "rewind to a known-good world" in devstack workflows: integration
tests, demo resets, fork-mode rollbacks, and `apply → save → wipe → restore → apply` regressions.
Today the snapshot pipeline embeds first-class knowledge of which on-disk paths each in-tree service
owns (walrus deploy/, seal master-key.env, accounts/, wallet/token, sui-fork/data, …); that
hard-coded service awareness is a primary pain point captured below.

## Current implementation

Total in-scope source LOC: **1614** across 4 source files (engine snapshot, engine stage-and-swap,
CLI snapshot subcommands, CLI wipe). Total in-scope test LOC: **1223** across 5 test files.

Engine sub-component — the snapshot save/restore pipeline:

- **`engine/snapshot.ts` — 962 LOC** — defines `snapshot()`, `restore()`, `list()`, `SnapshotError`,
  `SnapshotMeta` (Schema), `SnapshotMetaServices` (declaration-mergeable typed bucket),
  `buildServicesBucket`, `readServiceMeta`, `readMeta`, `tarCreate`, `tarExtract`, `runTar`,
  `truncateStderr`, `preCleanupApp`, `resolveStackPaths`, `snapshotError`. Snapshot meta.json schema
  lives here. Hardcoded knowledge: imports `RUNTIME_DIR_NAME` from `service-paths.ts` and references
  `runtime/walrus/<name>/deploy/`, `runtime/seal/master-key.env`, `runtime/accounts/<name>.key`,
  `runtime/wallet/token` in JSDoc as load-bearing invariants (`engine/snapshot.ts:9-23,487`). (Note:
  spec said 891 LOC; actual is 962.)
- **`engine/stage-and-swap.ts` — 243 LOC** — `stageAndSwap()` atomic-directory-replace primitive:
  creates `<target>.staging-<pid>-<rand>/`, lets the caller fill it, renames the existing `target`
  aside to `<target>.backup-<pid>-<rand>`, renames staging → target, drops the backup (or keeps it).
  Rollback path on failure restores the backup. Used by **codegen**, NOT used by snapshot.ts today.

CLI sub-component — wraps the engine for users:

- **`cli/commands/snapshot.ts` — 655 LOC** — `devstack snapshot <save|restore|list|delete>`
  subcommands. Enumerates containers via
  `docker ps -a --filter label=devstack.app=<app>,devstack.stack=<stack>`, derives timestamp-based
  snapshot ids, resolves opt-in `sui-fork-data` extras with a 1 GB auto-include threshold, and emits
  canonical JSON envelopes under `--json`. Implements label/prefix/exact-id matching in
  `findMatch()`.
- **`cli/commands/wipe.ts` — 405 LOC** — `devstack wipe` tears down (app, stack): kill labeled
  containers, remove labeled networks + volumes, remove `.devstack/stacks/<stack>/`, optionally also
  remove the shared `.devstack/sui-fork-cache/`. Snapshot dirs survive by default
  (`--keep-snapshots` is the explicit form). Sweeps stale `~/.move/git/<repo>/.git/*.lock` files.
  Delegates to `_prune-stack.ts::pruneStack`.

Test files (in scope):

- **`engine/snapshot.test.ts` — 666 LOC** — state-only round-trip, runtime/ tar round-trip (with
  mode bits), extras round-trip, list/meta surface, missing-snapshot error, services-bucket
  round-trip + cross-chain refusal, pause/commit/unpause ordering via stub spawner.
- **`engine/snapshot.docker.test.ts` — 272 LOC** — end-to-end against real Docker +
  `examples/arena`. Single `it()` block: `apply → save → wipe → restore → apply` preserves chain
  identity (asserts `publishMove/<chainId>/<inputsHash>` cache hit, packageId equality).
- **`engine/snapshot.fork.docker.test.ts` — 30 LOC** — gated stub for `RUN_FORK_DOCKER_TESTS=1`.
  Body is a placeholder (`expect(SHOULD_RUN).toBe(true)`) describing what a save→wipe→restore on a
  fork stack must validate (chainId + forkedAtCheckpoint round trip).
- **`engine/snapshot-deepbook.docker.test.ts` — 50 LOC** — L4 deepbook regression. All 6 `it.todo`
  cases are scaffolded — body lands in a future integration sweep.
- **`engine/stage-and-swap.test.ts` — 205 LOC** — happy path, `keepBackup`, stage failure,
  promote-rename rollback, error-tag-preservation, absent-pre-existing-target, `StageAndSwapError`
  shape.

## Configuration

| Knob                                                    | Source   | Default                                                                                                                                                         | Read at                                                                                                                               |
| ------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `DEVSTACK_STATE_DIR` env                                | env var  | `.devstack`                                                                                                                                                     | `engine/snapshot.ts:62` (module load, sets `STATE_DIR`); re-read action-time at `engine/snapshot.ts:263` (per save/restore)           |
| `--label <str>` (snapshot save)                         | CLI flag | unset → id ends `<ts>-<rand>`                                                                                                                                   | `cli/commands/snapshot.ts:174`                                                                                                        |
| `--stack <name>` (snapshot save/restore)                | CLI flag | active stack from `.devstack/active` or `'main'`                                                                                                                | `cli/commands/snapshot.ts:147,214,404`                                                                                                |
| `--app <name>` (snapshot save)                          | CLI flag | derived from `<appDir>/package.json#name`                                                                                                                       | `cli/commands/snapshot.ts:156,215`                                                                                                    |
| `--include-images` / `--no-include-images` (save)       | CLI flag | true                                                                                                                                                            | `cli/commands/snapshot.ts:177-184,218`                                                                                                |
| `--include-fork-data` / `--no-include-fork-data` (save) | CLI flag | auto: true if `.devstack/stacks/<stack>/sui-fork/data/` < 1 GiB, else false with printed hint                                                                   | `cli/commands/snapshot.ts:190-197,228-249`                                                                                            |
| `--dry-run` (save/restore/delete)                       | CLI flag | false                                                                                                                                                           | `cli/commands/snapshot.ts:202,339,531`                                                                                                |
| `--json` (save/restore/list/delete)                     | CLI flag | false                                                                                                                                                           | `cli/commands/snapshot.ts:198,335,472,527`                                                                                            |
| `--yes` (delete)                                        | CLI flag | false                                                                                                                                                           | `cli/commands/snapshot.ts:523`                                                                                                        |
| `--no-input` (delete)                                   | CLI flag | false                                                                                                                                                           | `cli/commands/snapshot.ts:535`                                                                                                        |
| `--keep-snapshots` (wipe)                               | CLI flag | false → on a default wipe `.devstack/stacks/<stack>/snapshots/` does NOT survive because the WHOLE per-stack dir is removed UNLESS `--keep-snapshots` is passed | `cli/commands/wipe.ts:78,162` and `cli/commands/_prune-stack.ts:235`                                                                  |
| `--no-stop` (wipe)                                      | CLI flag | false                                                                                                                                                           | `cli/commands/wipe.ts:83`                                                                                                             |
| `--also-upstream-cache` (wipe)                          | CLI flag | false                                                                                                                                                           | `cli/commands/wipe.ts:103-110,325-335`                                                                                                |
| `--keep-upstream-cache` (wipe)                          | CLI flag | false (cache survives by default anyway; this flag is explicit-affirm)                                                                                          | `cli/commands/wipe.ts:112`                                                                                                            |
| `--images` (wipe)                                       | CLI flag | false                                                                                                                                                           | `cli/commands/wipe.ts:88`                                                                                                             |
| `dir` (engine `snapshot()/restore()/list()`)            | API arg  | `${STATE_DIR}/snapshots` (= `.devstack/snapshots`)                                                                                                              | `engine/snapshot.ts:68,473,678,928`; CLI passes `${stateDir()}/snapshots` (`cli/commands/snapshot.ts:49`)                             |
| `opts.skipRuntime` (engine `snapshot()`)                | API arg  | false                                                                                                                                                           | `engine/snapshot.ts:444,508` — not surfaced as a CLI flag today                                                                       |
| `opts.expectedChainId` (engine `restore()`)             | API arg  | undefined → cross-chain check skipped                                                                                                                           | `engine/snapshot.ts:659,710-725` — **not threaded through CLI today** (the CLI's `restore` command does not pass it; see Pain points) |
| `opts.services` (engine `snapshot()`)                   | API arg  | undefined → `services` omitted from meta.json                                                                                                                   | `engine/snapshot.ts:453,622-625` — **not populated by CLI today** (the CLI does not pass any services slice; see Pain points)         |
| `keepBackup`, `atomic` (stage-and-swap)                 | API args | `false`, `true`                                                                                                                                                 | `engine/stage-and-swap.ts:59,64,79-80`                                                                                                |

CLI snapshot uses `resolveStack`, `resolveAppName`, `resolveForkDataDir`, `resolveForkCacheRoot`,
`stateDir` from `cli/stack-resolution.ts`. The `defaultSnapshotsDir()` helper at
`cli/commands/snapshot.ts:49` re-reads `stateDir()` at action time (NOT module load) to honor late
env overrides (see `cli/commands/snapshot.ts:45-49` comment).

Snapshot IDs are generated by `makeId(label)` at `cli/commands/snapshot.ts:56-68`: UTC
`YYYYMMDDTHHMMSS-<rand4hex>[-<label>]`. The 2-byte (4 hex char) random suffix prevents same-second
collisions; the optional `-<label>` is the user-supplied tail.

## Capabilities CONSUMED

### Engine resources / shared paths

- **`STATE_DIR`** (= `process.env.DEVSTACK_STATE_DIR ?? '.devstack'`) — base for `snapshots/`,
  `stacks/<stack>/state.json`, `stacks/<stack>/runtime/`, `networks/<network>.json`,
  `networks/<network>/runtime/`. Captured at module load (`engine/snapshot.ts:62`); also re-read
  action-time (`engine/snapshot.ts:263`).
- **`RUNTIME_DIR_NAME`** (`'runtime'`) from `engine/service-paths.ts:46`. Single source of truth for
  the per-service runtime dir name; snapshot mirrors `resolveRuntimeRoot` inline
  (`engine/snapshot.ts:262-287`) rather than importing it so this module stays pure-string and
  doesn't pull `StateStoreConfig` in.
- **`resolveAppDir()`** from `engine/resolve-app-dir.js` (`engine/snapshot.ts:58,270`) — resolves
  the project root for state-path math.
- **`captureCommand`** from `engine/capture-command.js` (`engine/snapshot.ts:54,329`) — funnels
  `tar` subprocess capture (audit finding E2).
- **`SnapshotPhases`** tuple from `engine/phases.js` (`engine/snapshot.ts:57,87`) — closed set of 20
  phase strings consumed by `pretty-error.ts` and TUI `PHASE_STATUS_OVERRIDES` (see
  `engine/phases.ts:212-244`).
- **`DockerLabel`** map from `engine/identity.js` (`engine/snapshot.ts:56,398-400`) —
  `devstack.app`, `devstack.stack` for filter args.
- **`Docker.inspectContainerImage`** from `engine/docker/image.ts:377` —
  `docker inspect --format '{{.Config.Image}}'` returns the supervisor's content-addressed base tag
  (`engine/snapshot.ts:541`).
- **`Docker.inspectContainerRunning`** from `engine/docker/exec.ts:126` — gates pause/unpause
  (`engine/snapshot.ts:560`).
- **`Docker.pauseContainer`** / **`Docker.unpauseContainer`** from `engine/docker/exec.ts:66,108` —
  quiesce writable layer around commit (`engine/snapshot.ts:567-573`).
- **`Docker.commitContainer`** from `engine/docker/exec.ts:155` — freezes container RW layer into
  `devstack-snap:<id>-<name>` (`engine/snapshot.ts:561`).
- **`Docker.saveImage`** from `engine/docker/image.ts:268` — `docker save -o <tar>`
  (`engine/snapshot.ts:578`).
- **`Docker.loadImage`** from `engine/docker/image.ts:300` — `docker load -i <tar>`, parses the
  resulting tag from stdout (`engine/snapshot.ts:820`).
- **`Docker.tagImage`** from `engine/docker/image.ts:347` — retag the loaded snapshot image to the
  supervisor's content-addressed tag (`engine/snapshot.ts:832`).
- **`Docker.DockerError`** from `engine/docker` (`engine/snapshot.ts:107`) — error class the
  `snapshotError` envelope unwraps to keep the inner phase in the surfaced message.

### Effect/Layer/Context machinery

- **`Effect.gen`**, **`Effect.fail`**, **`Effect.mapError`**, **`Effect.ensuring`**,
  **`Effect.ignore`**, **`Effect.flatMap`**, **`Effect.try`**, **`Effect.tryPromise`**,
  **`Effect.orElseSucceed`**, **`Effect.acquireUseRelease`**, **`Effect.catchTag`**,
  **`Effect.tapError`**, **`Effect.logWarning`**, **`Effect.withSpan`** — pervasive across both
  files.
- **`Schema.TaggedErrorClass`** (`engine/snapshot.ts:81`, `engine/stage-and-swap.ts:40`) for
  `SnapshotError` and `StageAndSwapError`.
- **`Schema.Struct`**, **`Schema.Literals`**, **`Schema.String`**, **`Schema.Number`**,
  **`Schema.Boolean`**, **`Schema.Array`**, **`Schema.Record`**, **`Schema.Unknown`**,
  **`Schema.optional`**, **`Schema.Defect`**, **`Schema.decodeUnknownSync`** — for `SnapshotMeta`,
  `ContainerEntry`, `ExtraEntry`, `ServicesBucketSchema`, error class shapes.
- **`FileSystem.FileSystem`** Context tag — required service for `snapshot()`/`restore()`/`list()`
  (`engine/snapshot.ts:462,667,923`).
- **`Path.Path`** Context tag — required service for path joins.
- **`ChildProcessSpawner.ChildProcessSpawner`** from `effect/unstable/process` — required service
  for spawning `tar` and `docker`. Threaded through `snapshot()` and `restore()` via
  `yield* ChildProcessSpawner.ChildProcessSpawner` (`engine/snapshot.ts:467,672`).
- **`ChildProcess.make`** / **`ChildProcess.Command`** from `effect/unstable/process` — used to
  construct `tar` / `docker` argv (`engine/snapshot.ts:353,369,393,407`).

### Runtime resources

- **`tar`** system binary — invoked via `spawn('tar', ['-cf', ...])` / `['-xf', ...]`.
  `--no-same-owner` is required for cross-UID portability between save and restore
  (`engine/snapshot.ts:369`). Both GNU tar and BSD tar supported (`engine/snapshot.ts:368`).
- **`docker`** CLI — `docker ps`, `docker rm`, `docker pause`, `docker unpause`, `docker commit`,
  `docker save`, `docker load`, `docker tag`, `docker inspect`, `docker image inspect`.
- **Host filesystem** — read `runtime/` recursively, read `state.json`, write tars, untar back, copy
  files.
- **Docker daemon** — must be reachable for the container pass; absence falls through best-effort
  (`engine/snapshot.ts:401`, `cli/commands/snapshot.ts:133`).

### Surfaces / observability

- **OpenTelemetry spans** — `SnapshotCreate`, `SnapshotRestore`, `SnapshotList`,
  `SnapshotPreCleanupApp`, `stageAndSwap` (`engine/snapshot.ts:410,641,867,962`;
  `engine/stage-and-swap.ts:243`). Span attributes carry `snapshot.id`, `snapshot.app`,
  `snapshot.stack`, `stage.target`.

### CLI-only consumed (`cli/commands/snapshot.ts`, `cli/commands/wipe.ts`)

- **`resolveStack`**, **`resolveAppName`**, **`resolveForkDataDir`**, **`resolveForkCacheRoot`**,
  **`stateDir`** from `cli/stack-resolution.js` (`cli/commands/snapshot.ts:35-40`).
- **`safeDirSize`** from `engine/fs-utils.js` (`cli/commands/snapshot.ts:42,229`) — for the 1 GiB
  fork-data auto-include threshold.
- **`pruneStack`** from `cli/commands/_prune-stack.js` (`cli/commands/wipe.ts:43`) — shared with
  `devstack prune`.
- **`sweepStaleGitLocks`** from `engine/move-build-lock.js` (`cli/commands/wipe.ts:38,347`).
- **`promptConfirm`** / **`promptTypeToConfirm`** from `cli/cli-prompt.js`
  (`cli/commands/snapshot.ts:27`, `cli/commands/wipe.ts:39`).
- **`emitEnvelope`**, **`failWithEnvelope`**, **`jsonModeEnabled`**, **`successEnvelope`** from
  `cli/envelope.js` for `--json` mode (`cli/commands/snapshot.ts:28-33`).
- **`EX_SNAPSHOT_NOT_FOUND`**, **`EX_USAGE`**, **`EX_CONFIRM_REQUIRED`** from `cli/exit-codes.js`
  (`cli/commands/snapshot.ts:34`).
- **`Argument`**, **`Command`**, **`Flag`** from `effect/unstable/cli` for CLI shape.

### stage-and-swap consumed

- **`crypto.randomBytes`** for suffix entropy (`engine/stage-and-swap.ts:29,84`).
- **`fs.promises`** (`fs.mkdir`, `fs.rm`, `fs.rename`, `fs.access`, `fs.cp`) — uses Node's promised
  fs directly, NOT Effect's `FileSystem.FileSystem` (`engine/stage-and-swap.ts:30,93-235`).
- **`path.dirname`** (`engine/stage-and-swap.ts:31,93`).
- **`stringifyCause`** from `engine/stringify-cause.js`
  (`engine/stage-and-swap.ts:34,98,119,159,182,219`) — formats Effect causes into error messages.

### npm dependencies

- **`effect`** (Schema, Effect, FileSystem, Path, Console, Option, Cause, Exit, Sink, Stream, Layer)
- **`effect/unstable/process`** (`ChildProcess`, `ChildProcessSpawner`)
- **`effect/unstable/cli`** (`Argument`, `Command`, `Flag`)
- **`@effect/vitest`** (test files)
- **`@effect/platform-node/NodeServices`** (test files for `NodeServicesLayer`)
- Node built-ins: `node:fs`, `node:fs/promises`, `node:os`, `node:path`, `node:crypto`,
  `node:child_process`

## Capabilities PRODUCED

### TypeScript exports (engine/snapshot.ts)

- `class SnapshotError` — tagged error with `phase: SnapshotPhase`, `message: string`, optional
  `cause` defect (`engine/snapshot.ts:81-90`).
- `interface SnapshotMetaServices` — declaration-mergeable typed bucket for per-service meta slices
  (`engine/snapshot.ts:177-186`). In-tree contributor today: `sui` (`{chainId: string}`).
- `type SnapshotMetaServicesShape = Partial<SnapshotMetaServices>` (`engine/snapshot.ts:220`).
- `const buildServicesBucket(entries): Record<string, unknown>` — TS-typed constructor for the
  bucket (`engine/snapshot.ts:230-232`).
- `const readServiceMeta<K>(meta, name): SnapshotMetaServices[K] | undefined` — typed accessor
  (`engine/snapshot.ts:241-248`).
- `const snapshot(opts) => Effect<{path, containerTars, runtimeTar?, extrasTars}, SnapshotError, FS|Path|Spawner>`
  (`engine/snapshot.ts:419-641`).
- `const restore(opts) => Effect<{loadedImages, runtimeRestored, extrasRestored}, SnapshotError, FS|Path|Spawner>`
  (`engine/snapshot.ts:647-867`).
- `const list(opts?) => Effect<ReadonlyArray<{id, createdAt, stack?, network?, services?}>, SnapshotError, FS|Path>`
  (`engine/snapshot.ts:908-962`).

### TypeScript exports (engine/stage-and-swap.ts)

- `class StageAndSwapError` — `op: 'mkdir'|'rename-aside'|'rename-promote'|'cleanup'`,
  `target: string`, `message: string`, optional `cause` (`engine/stage-and-swap.ts:40-48`).
- `interface StageAndSwapOptions<E, R>` — `target`, `stage(stagingDir)`, optional `keepBackup`,
  `atomic` (`engine/stage-and-swap.ts:50-65`).
- `const stageAndSwap<E, R>(opts) => Effect<string, E | StageAndSwapError, R>`
  (`engine/stage-and-swap.ts:74-243`).

### CLI commands (cli/commands/snapshot.ts)

- `export const snapshotCommand` — `devstack snapshot` parent with four subcommands: `save`,
  `restore`, `list`, `delete` (`cli/commands/snapshot.ts:650-655`). Registered in `cli/main.ts`
  (asserted by `cli/main.test.ts:55-60`).

### CLI commands (cli/commands/wipe.ts)

- `export const wipeCommand` — `devstack wipe` top-level (`cli/commands/wipe.ts:168-405`).

### Files written

Under `<snapshotsDir>/<id>/` (default `<STATE_DIR>/snapshots/<id>/`):

| Path                         | Content                                                            | When written                                                                    |
| ---------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `<id>/state.json`            | Verbatim copy of `<stack>/state.json`                              | `engine/snapshot.ts:494` — only if source exists                                |
| `<id>/runtime.tar`           | `tar -cf - -C <runtimeDir> .` of the entire per-stack runtime tree | `engine/snapshot.ts:515` — only if `skipRuntime !== true` AND source dir exists |
| `<id>/containers/<name>.tar` | `docker save devstack-snap:<id>-<name>` per container              | `engine/snapshot.ts:540,578` — one per `opts.containers` entry                  |
| `<id>/extras/<key>.tar`      | `tar -cf - -C <extra.path> .` of each opt-in extras root           | `engine/snapshot.ts:603,613` — one per `opts.extras` entry, skip missing        |
| `<id>/meta.json`             | JSON-encoded `SnapshotMeta`                                        | `engine/snapshot.ts:637` — always written last                                  |

### Docker resources produced

- **Docker images** `devstack-snap:<id>-<name>` — one per saved container, persists on the local
  daemon until `docker rmi` (NOT automatically GC'd by `snapshot` or `wipe`). The tar is the
  portable artifact; the local image is a byproduct.

### meta.json shape (SnapshotMeta)

Schema at `engine/snapshot.ts:190-211`:

```
{
  createdAt: number,         // Date.now() at save
  stack: string,             // 'main' default
  app: string,               // CLI/caller derived
  network: string,           // 'localnet' default
  runtimeIncluded: boolean,  // whether runtime.tar rode the snapshot
  containers?: [ { id, name, originalImage } ],  // ContainerEntry[]
  extras?: [ { key, path } ],                    // ExtraEntry[]
  services?: Record<string, unknown>,            // typed via SnapshotMetaServices
}
```

`ContainerEntry.originalImage` is load-bearing — see Hard requirements.

### Events / state-store entries

Snapshot does NOT publish to the in-process registries. It READS `state.json` (the on-disk
serialization of state-store) and WRITES it back at restore time. State-store registry membership is
unaffected by save (the live registries keep humming).

## Lifecycle

### snapshot() startup / ordered steps (`engine/snapshot.ts:464-641`)

1. Resolve `stack`/`network`/`stackPaths` (state file + runtime dir) via `resolveStackPaths()`
   (`engine/snapshot.ts:469-471`).
2. Build target paths under `<snapshotsDir>/<id>/`: `target`, `stateDst`, `metaDst`,
   `runtimeTarDst`, `containersDir`, `extrasDir` (`engine/snapshot.ts:473-479`).
3. `mkdir -p <target>` (`engine/snapshot.ts:481`). Errors → `SnapshotError(phase='create-dir')`.
4. **state.json pass** — if `stackPaths.stateFile` exists, copy verbatim to `<id>/state.json`
   (`engine/snapshot.ts:485-499`). Errors → `SnapshotError(phase='state-copy')`.
5. **runtime/ pass** — if `skipRuntime !== true` AND `stackPaths.runtimeDir` exists,
   `tar -cf <id>/runtime.tar -C <runtimeDir> .` (`engine/snapshot.ts:507-517`). Errors →
   `SnapshotError(phase='runtime-tar')`. The `-C srcDir .` form makes archive entries relative so
   untar at a different absolute path on restore puts files at right offsets.
6. **Container pass** — if `opts.containers.length > 0`, `mkdir -p <id>/containers/`, then for each
   container:
   - `Docker.inspectContainerImage(id)` → originalImage tag. Empty → fail
     `SnapshotError(phase='container-inspect')` (`engine/snapshot.ts:541-549`).
   - `Docker.inspectContainerRunning(id)` to decide whether to pause (`engine/snapshot.ts:560`).
   - If running: `Docker.pauseContainer(id)` then
     `Docker.commitContainer(id, devstack-snap:<id>-<name>)` with
     `Effect.ensuring(unpauseContainer)` so unpause fires on both success and failure
     (`engine/snapshot.ts:566-577`). Errors →
     `SnapshotError(phase='container-pause'|'container-commit')`.
   - If stopped: skip pause; `Docker.commitContainer` directly (already quiescent)
     (`engine/snapshot.ts:575-577`).
   - `Docker.saveImage(imageName, <id>/containers/<name>.tar)` (`engine/snapshot.ts:578`). Errors →
     `SnapshotError(phase='container-save')`.
   - Record `{id, name, originalImage}` into `containerEntries[]`.
   - **Containers are processed serially** in a `for` loop (`engine/snapshot.ts:538`); no
     parallelism.
7. **Extras pass** — if `opts.extras.length > 0`, `mkdir -p <id>/extras/`, then for each
   `{key, path}`:
   - `fs.exists(path)` — missing extras are silently skipped (NOT failed)
     (`engine/snapshot.ts:604-612`).
   - `tar -cf <id>/extras/<key>.tar -C <extra.path> .` (`engine/snapshot.ts:613`). Errors →
     `SnapshotError(phase='extras-tar')`.
8. **meta.json pass** — construct `SnapshotMeta`, JSON-stringify (2-space indent), write to
   `<id>/meta.json` (`engine/snapshot.ts:622-638`). Errors → `SnapshotError(phase='meta-write')`.
   `services` bucket built via `buildServicesBucket(opts.services)` when non-empty.
9. Return `{path: <target>, containerTars, runtimeTar, extrasTars}`.

### snapshot() ready criteria

`snapshot()` is a one-shot Effect — readiness is its exit. There's no asynchronous post-condition
probe. The file system contents AT return are the contract: `<target>/meta.json` exists ↔ snapshot
completed successfully.

### snapshot() concurrency / locking

- **No lock is taken** around the source `runtime/` or `state.json`. A concurrent supervisor write
  while `tar` is running could observe a torn file. The pause-around-commit mitigates this for
  containers but NOT for host-side state.
- Container pass holds the daemon's effective lock only for the duration of
  `pause + commit + unpause + save` per container (serial).
- Two `snapshot()` calls against the same `id` overwrite each other (the test file's design note
  `engine/snapshot.test.ts:31-37` flags this; the CLI's id format `<timestamp>-<rand>[-<label>]`
  makes collisions practically impossible).

### restore() startup / ordered steps (`engine/snapshot.ts:669-867`)

1. Resolve `stackPaths` (target state file + runtime dir).
2. Stat `<source>` directory; missing → fail `SnapshotError(phase='not-found')`
   (`engine/snapshot.ts:685-693`).
3. **readMeta** — `readMeta(fs, <source>/meta.json)` (`engine/snapshot.ts:698`). Decodes
   `SnapshotMeta`; on JSON parse error or schema mismatch returns `undefined` (best-effort;
   `engine/snapshot.ts:893-898`).
4. **Chain guard** — if `meta !== undefined` AND `opts.expectedChainId` set AND
   `meta.services.sui.chainId` set AND they differ → fail `SnapshotError(phase='chainId-mismatch')`
   with detailed message naming both chainIds (`engine/snapshot.ts:710-725`). Skipped if either side
   undefined.
5. **Pre-cleanup** — `preCleanupApp(spawner, meta.app, meta.stack)`:
   `docker ps -aq --filter label=devstack.app=<app>,label=devstack.stack=<stack>` then
   `docker rm -f` each. `.pipe(Effect.ignore)` — best-effort, daemon down is OK
   (`engine/snapshot.ts:738-740,387-413`). Skipped if `meta === undefined`.
6. **state.json pass** — if `<source>/state.json` exists: mkdir-p `dirname(stackPaths.stateFile)`,
   then copy `<source>/state.json` → live state file (`engine/snapshot.ts:743-761`). Errors →
   `SnapshotError(phase='state-restore')`.
7. **runtime/ pass** — if `<source>/runtime.tar` exists:
   - `fs.remove(runtimeDir, {recursive: true, force: true})` — WIPE first to clear stale orphans
     (`engine/snapshot.ts:778`). This is Bug B's regression fix (see Hard requirements).
   - `fs.makeDirectory(runtimeDir, {recursive: true})` (`engine/snapshot.ts:785`).
   - `tar -xf <source>/runtime.tar -C <runtimeDir> --no-same-owner` (`engine/snapshot.ts:792`).
     Errors → `SnapshotError(phase='runtime-extract')`.
   - Set `runtimeRestored = true`.
8. **Container pass** — if `<source>/containers/` exists:
   - `readDirectory(containersDir)`.
   - Index `meta.containers` by `name` → `originalImage` (`engine/snapshot.ts:813-816`).
   - For each `*.tar` entry:
     - `Docker.loadImage(tarPath)` → `{tag}` parsed from `Loaded image: <tag>` line. Errors →
       `SnapshotError(phase='container-load')`.
     - If `originalImage` known: `Docker.tagImage(tag, originalImage)` to retag the loaded image
       (`engine/snapshot.ts:831-836`). Errors → `SnapshotError(phase='container-retag')`.
9. **Extras pass** — if `<source>/extras/` exists, iterate `meta.extras`:
   - Skip if `<source>/extras/<key>.tar` missing (`engine/snapshot.ts:850-855`).
   - `mkdir -p <extra.path>`, then `tar -xf <extras-tar> -C <extra.path> --no-same-owner`
     (`engine/snapshot.ts:856-861`).
   - Errors → `SnapshotError(phase='extras-extract')`.
10. Return `{loadedImages, runtimeRestored, extrasRestored}`.

### restore() ready criteria

Like save, ready = return. The contract for "resume works": the next `devstack apply` against this
stack must (a) find on-disk state.json, runtime/ tree, and retagged docker images in place; (b) the
supervisor's `Docker.run` reuse-if-image-matches probe in `engine/docker/...` will then adopt the
snapshot images by recreating containers from them (not from a fresh base image). Resume semantics
are exercised end-to-end by `engine/snapshot.docker.test.ts` (the `apply2` step).

### restart behavior / idempotency

- `snapshot()` is **NOT idempotent against the same id**: re-running overwrites because
  `makeDirectory({recursive: true})` tolerates EEXIST and subsequent file writes truncate. The CLI
  sidesteps via the random suffix in `makeId()`.
- `restore()` IS effectively idempotent against the same `(snapshot id, target stack)`: the
  pre-cleanup wipes containers, the state.json copy overwrites, the runtime tar untar follows a
  `rm -rf` of the runtime dir. Running it twice gives the same result as running it once.

### Teardown / interrupt semantics

- **`snapshot()` interrupt**: if the Effect is interrupted mid-save, the partial snapshot dir is
  left on disk. The pause/commit/unpause path uses
  `Effect.ensuring(unpauseContainer.pipe(Effect.ignore))` (`engine/snapshot.ts:573`) so a paused
  container is unpaused on both success and failure. Partial tars / partial container saves are NOT
  cleaned up — `list()` skips snapshot dirs lacking a parseable `meta.json`
  (`engine/snapshot.ts:946-948`) so a partial save shouldn't break `list()`.
- **`restore()` interrupt**: even less safe. Mid-restore can leave the live state in any of:
  state.json copied but runtime not extracted, runtime dir wiped but tar not yet extracted
  (transiently empty), some containers loaded but not retagged. There is no transactional wrapper
  around the multi-pass restore today.
- **`stageAndSwap()`** IS robust against interrupt: `Effect.acquireUseRelease` registers staging-dir
  cleanup that fires on success, failure, AND interrupt (`engine/stage-and-swap.ts:106-136`).

### wipe lifecycle (cli/commands/wipe.ts)

1. Resolve `{app, stack, stateDir, upstreamCachePath, includeImages, keepSnapshots, noStop}` from
   flags (`cli/commands/wipe.ts:214-226`).
2. If `--dry-run`: emit preview envelope + return (no side effects, no prompt).
3. Prompt — `--also-upstream-cache` triggers `promptTypeToConfirm` (tier 2: must type stack name);
   else `promptConfirm` (tier 1: y/N).
4. `pruneStack({app, stack, keepSnapshots, noStop, removeImages: images})` — kills labelled
   containers, removes labelled networks/volumes, removes per-stack state dir (with `snapshots/`
   survival via `keepSnapshots` at `_prune-stack.ts:235`).
5. If `--also-upstream-cache`: `rm -rf .devstack/sui-fork-cache/`.
6. `sweepStaleGitLocks(~/.move)` — unconditional, 60s age gate.
7. Emit envelope.

## Hard requirements / invariants

Each cited to file:line or a test that asserts it:

1. **`originalImage` retag on restore must run.** Without it, the supervisor's `Docker.run`
   reuse-if-name-and-image-match probe sees a name match but image mismatch and recreates from a
   fresh base image, running a brand-new genesis → chain state lost. Captured at save
   (`engine/snapshot.ts:541-549,582-586`) and applied at restore (`engine/snapshot.ts:826-837`).
   Asserted end-to-end by `engine/snapshot.docker.test.ts:140-261` (the
   `apply2 → packageId equality` chain). The four bugs the original v4 design shipped with are
   listed at `engine/snapshot.docker.test.ts:7-19`.

2. **Per-(app, stack) container scoping.** Container enumeration on save AND pre-cleanup on restore
   MUST filter on BOTH `devstack.app=<app>` AND `devstack.stack=<stack>` — filtering on stack alone
   clobbers sibling apps that share `stack=main` (`cli/commands/snapshot.ts:117-145`,
   `engine/snapshot.ts:393-400`). Captured as bug #1 in `engine/snapshot.docker.test.ts:11-12`.

3. **Walrus deploy outputs MUST ride the runtime tar.** `runtime/walrus/<name>/deploy/` holds the
   storage-node private keys + per-node config that `walrus-deploy` wrote. A state-store entry that
   says "walrus is already deployed" can't be honored on resume without these files. The
   `acquireLocalCluster`'s ChainProbe-backed verify probe (`services/walrus/internal.ts:211+`, see
   also commit `a0ab4293`) detects absence and invalidates the cache, but cleaner is for both halves
   to travel together — the single `runtime/` tar achieves this by construction
   (`engine/snapshot.ts:14-23`). Asserted by `engine/snapshot.test.ts:285-336` ("walrus deploy
   outputs (multiple instances) ride the runtime tar verbatim").

4. **Mode bits MUST survive the tar round-trip.** Seal master-key (`runtime/seal/master-key.env`),
   account keys (`runtime/accounts/<name>.key`), walrus node keys
   (`runtime/walrus/<name>/deploy/node-*.key`) all sit at 0o600. Tar with default flags preserves
   mode; the test pins this (`engine/snapshot.test.ts:231-282,328-334`).

5. **Container must be paused around `docker commit` if running.** Without quiescence, RocksDB /
   postgres mid-WAL-fsync at commit time produces snapshots that need recovery on next boot or fail
   to open entirely (`engine/snapshot.ts:553-559`). The pause is skipped when the container is
   stopped (already quiescent) — `docker pause` errors on a stopped container. `Effect.ensuring`
   guarantees unpause even on commit failure (`engine/snapshot.ts:573`). Asserted by
   `engine/snapshot.test.ts:594-665` (3 ordering cases).

6. **Restore MUST wipe the runtime/ dir before untar.** Bug B regression: pre-fix, untar overlaid
   onto whatever was in `runtimeDir`, so orphan files survived the restore and "rollback" silently
   kept stale state (`engine/snapshot.ts:763-794`). Asserted by `engine/snapshot.test.ts:381-427`
   ("restore() clears stale files in runtime/ that were not in the snapshot").

7. **Cross-chain restore MUST be refused when both chainIds are known.** Silent retag of images
   under a divergent chainId would leave downstream lookups (publishMove cache, KnownPackage,
   dapp-kit MVR) pointing at addresses that don't exist on the running chain. Guard at
   `engine/snapshot.ts:710-725`; asserted by `engine/snapshot.test.ts:190-212`. CAVEAT: skipped when
   either `expectedChainId` or `meta.services.sui.chainId` is undefined — and the CLI does NOT pass
   `expectedChainId` today (see Pain points).

8. **`list()` MUST skip dirs lacking parseable meta.json.** A partial save from a crashed
   `snapshot()` shouldn't crash `list()` (`engine/snapshot.ts:903-907,946-948`). Asserted indirectly
   by `engine/snapshot.test.ts:120-144`.

9. **Pre-cleanup MUST be best-effort.** Daemon down, no matching containers, or permission errors
   don't fail the restore (`engine/snapshot.ts:387-413,739`). The label-filter must use BOTH app +
   stack to avoid clobbering siblings.

10. **`tar --no-same-owner` on extract.** Restore running as a different UID than the save (CI
    runner ≠ developer's local user) doesn't fail with EPERM on chown (`engine/snapshot.ts:369`).
    Supported by both GNU tar and BSD tar.

11. **`label-fragment` match in CLI restore MUST use `endsWith('-' + ref)`, not `indexOf('-')`.**
    Bug #2 of the four v4 bugs: pre-fix `indexOf('-')` sliced `<rand>-<label>` and never matched
    against just `<label>` — restore-by-label always failed (`cli/commands/snapshot.ts:84-90`).

12. **`SnapshotMeta.app` MUST be captured at save and used at restore-time pre-cleanup.** Without
    `app` in meta, restore can't scope the `docker rm -f` correctly
    (`engine/snapshot.ts:194-198,629,739`).

13. **stageAndSwap atomicity** — `rename(2)` is atomic on the same filesystem; an external watcher
    (Vite HMR) attached to `target` therefore never observes a half-written tree
    (`engine/stage-and-swap.ts:18-21`). Cross-filesystem fallback (`atomic: false`) loses this
    guarantee and logs a loud warning.

14. **stageAndSwap rollback restores backup on promote-rename failure.** Without rollback, a failed
    second rename would leave the consumer's `target` missing entirely. Asserted by
    `engine/stage-and-swap.test.ts:118-149`.

15. **stageAndSwap MUST NOT wrap caller's `stage` error.** Round-trip the caller's tagged error
    verbatim so it can pattern-match on its own error tag. Asserted by
    `engine/stage-and-swap.test.ts:151-176`.

16. **Snapshot-from-running daemon is supported.** `commitContainer` works against both running
    (pause-then-commit) AND stopped (`docker stop` finalizer already fired) containers — the test
    design note at `cli/commands/snapshot.ts:107-116` calls this out: `apply` exits leaves
    containers stopped-but-still-on-disk; the snapshot path picks them up either way.

## Failure modes

| Trigger                                                     | Current behavior                                                                                                                                                                                                                              | Recovery                                                                                                           |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `state.json` doesn't exist at save (empty/first-boot stack) | `fs.exists` → skip; `meta.runtimeIncluded` may still be true if runtime/ exists; no error (`engine/snapshot.ts:489-500`)                                                                                                                      | None needed                                                                                                        |
| `runtime/` doesn't exist at save (first-boot)               | Skip tar; `runtimeTar` undefined; tested at `engine/snapshot.test.ts:356-379`                                                                                                                                                                 | None needed                                                                                                        |
| `tar -cf` exits non-zero                                    | `SnapshotError(phase='runtime-tar' or 'extras-tar')` with truncated stderr in message; full stderr attached as `cause` (`engine/snapshot.ts:333-341`)                                                                                         | Re-run; investigate the underlying tar failure (EACCES, source vanished, …)                                        |
| `Docker.inspectContainerImage` returns empty                | `SnapshotError(phase='container-inspect')` with "docker reported no image tag" (`engine/snapshot.ts:543-549`)                                                                                                                                 | Inspect the container; the supervisor stamps `Config.Image` at run time so empty suggests a manual `docker create` |
| `Docker.commitContainer` fails on a paused container        | Commit error surfaces; `Effect.ensuring` still runs `unpauseContainer.pipe(Effect.ignore)` so the container is not left paused (`engine/snapshot.ts:573`). Asserted by `engine/snapshot.test.ts:623-645`                                      | Re-run; investigate docker daemon health                                                                           |
| `Docker.saveImage` fails (disk full, …)                     | `SnapshotError(phase='container-save')`; the committed `devstack-snap:<id>-<name>` image remains on the daemon (NOT cleaned up)                                                                                                               | `docker rmi devstack-snap:<id>-<name>`; re-run save                                                                |
| `meta.json` write fails                                     | `SnapshotError(phase='meta-write')`; partial snapshot dir left on disk. `list()` skips it because no parseable meta (`engine/snapshot.ts:903`)                                                                                                | None at runtime; user can `rm -rf <snapshot-dir>` manually                                                         |
| Restore of missing id                                       | `SnapshotError(phase='not-found')` with the id + path in message (`engine/snapshot.ts:689`); CLI maps to `EX_SNAPSHOT_NOT_FOUND` (`cli/commands/snapshot.ts:354`). Asserted by `engine/snapshot.test.ts:146-156`                              | Use `devstack snapshot list`                                                                                       |
| Cross-chain restore (both chainIds known and differ)        | `SnapshotError(phase='chainId-mismatch')` with both values in message; refuses to mutate disk (`engine/snapshot.ts:716-724`)                                                                                                                  | Restore into a fresh stack; or restart with the matching chainId                                                   |
| meta.json malformed/missing/old shape                       | `readMeta` returns `undefined`; chain guard skipped, pre-cleanup skipped, container retag skipped, extras restore skipped. State + runtime still restored — but post-restore state is degraded (`engine/snapshot.ts:893-898,710,738,838-863`) | Manual cleanup; re-take snapshot from a newer devstack                                                             |
| `docker load` produces no `Loaded image:` line              | `DockerError(phase='docker load')` from `Docker.loadImage`; wrapped to `SnapshotError(phase='container-load')` (`engine/snapshot.ts:822`)                                                                                                     | Investigate tar contents; re-snapshot                                                                              |
| `docker tag` fails                                          | `SnapshotError(phase='container-retag')`. Note: the loaded image is on the daemon under `devstack-snap:*` but NOT under the supervisor's expected tag — next `apply` will build fresh and lose chain state                                    | Manual `docker tag devstack-snap:<id>-<name> <originalImage>`; or re-run restore                                   |
| Restore mid-tar interrupt                                   | Runtime dir may be partially populated; state.json may already be over-copied. No transaction.                                                                                                                                                | Re-run restore (idempotent on rerun since the second runtime-extract again wipes then untars)                      |
| Pre-existing extras path doesn't exist at save              | Silent skip — by design, "a plugin might register an extra whose path is only populated after a specific code path runs" (`engine/snapshot.ts:607-611`). Asserted by `engine/snapshot.test.ts:477-494`                                        | None needed                                                                                                        |
| `preCleanupApp` daemon down                                 | `Effect.ignore` swallows; restore continues. The first subsequent `apply` will hit the Docker.run reuse probe and may or may not adopt stale containers depending on image match.                                                             | Start docker daemon; run `devstack wipe`; restore                                                                  |
| `stageAndSwap` cross-fs promote when `atomic: false`        | Fallback copy-then-rm logs warning + completes non-atomically (`engine/stage-and-swap.ts:185-225`)                                                                                                                                            | Use same-filesystem target                                                                                         |
| `stageAndSwap` rename-promote fails AND rollback fails      | Original promote error surfaced; target is in undefined state (`engine/stage-and-swap.ts:192-199`)                                                                                                                                            | Manual restore from backup dir on disk                                                                             |

## Persistence model

### What survives restart (= survives `apply` cycles without a snapshot)

- **`state.json`** — package IDs, port leases, seal BLS keypair cache, walrus deploy fingerprint,
  chainId, every namespaced cache entry. Owned by `engine/state-store.ts`; cited as snapshot input
  at `engine/snapshot.ts:485-499`.
- **`runtime/<service>/...`** — every service's host-side persisted state. Convention is enforced by
  `engine/service-paths.ts:43-46`'s `RUNTIME_DIR_NAME = 'runtime'` and the fact that every service
  routes through `servicePath()` (see `engine/service-paths.ts:100-115`). Snapshot tars the WHOLE
  tree.
- **Docker images** built by the supervisor (`devstack-sui.image:<hash>`,
  `devstack-postgres.image:<hash>`, etc.) — content-addressed cache.
- **Docker named volumes** with `devstack.*` labels (RocksDB stores, postgres data, walrus blobs).
- **`<DEVSTACK_APP_DIR>/.devstack/sui-fork-cache/`** — shared warmed upstream cache for fork mode;
  per-chainId scoping (`cli/commands/wipe.ts:97-110`).
- **`<DEVSTACK_APP_DIR>/.devstack/active`** — the active-stack-name marker.

### What survives snapshot (subset of persisted)

Snapshot captures:

- `state.json` (copy)
- `runtime/` tree (tar) — INCLUDING by-convention every in-tree service's subdir:
  - `runtime/accounts/<name>.key` (mode 0o600)
  - `runtime/wallet/token` (mode 0o600)
  - `runtime/seal/master-key.env` (mode 0o600)
  - `runtime/walrus/<name>/deploy/` (storage-node configs + `node-*.key` at 0o600)
  - `runtime/sui-fork/` (per-stack fork state, when present)
  - …any future `runtime/<service>/` subdir
- Container images via `docker commit + save` (RW layer; includes RocksDB at `/root/.sui`, postgres
  at `/pgdata`)
- Opt-in extras (CLI passes `sui-fork-data` → `.devstack/stacks/<stack>/sui-fork/data/`)

Snapshot does NOT capture (unless an extras key is added):

- The shared `.devstack/sui-fork-cache/` — explicitly not included (this is a per-chainId warmed
  cache, not per-stack state)
- The supervisor's docker-build cache layers (only the writable-layer commit rides; the base layers
  are rebuilt if the image tag is missing)
- `~/.move/git/<repo>/` — devstack's Move dependency clones (not per-stack)
- Anything outside `runtime/` that no service registers as an extras path

### What gets wiped on `devstack wipe`

- Containers labelled `devstack.app=<app>,devstack.stack=<stack>` (kill + rm)
- Networks + volumes with the same labels
- `.devstack/stacks/<stack>/` recursive, INCLUDING `state.json`, `runtime/`, `sui-fork/`, AND
  `snapshots/` (unless `--keep-snapshots`)
- Stale `~/.move/git/<repo>/.git/*.lock` (60s age gate, unconditional)
- Optionally: `devstack-*` images (`--images`)
- Optionally: `.devstack/sui-fork-cache/` (`--also-upstream-cache`)

What `wipe` does NOT undo that snapshot wouldn't restore:

- The supervisor's docker image build cache — wipe doesn't touch it; the next `apply` reuses cached
  layers. Snapshot doesn't capture base layers either; the assumption is that `Docker.run` will
  rebuild the supervisor's base image from the same Dockerfile and find the cached layers, then the
  retagged snapshot image (carrying chain state in RW layer) is what gets booted.
- The shared upstream cache (`.devstack/sui-fork-cache/`) — survives by default. Snapshot doesn't
  capture it either. This is fine: it's per-chainId content-addressed; a `wipe + restore` of a fork
  stack re-uses the same cache against the same upstream.

### What is process-local only

- Effect Layer state (registries, scopes, in-process state-store cache, port-lease tracker) — all
  rebuilt on next `apply`. None of this rides snapshots.

## Modes & variants

Snapshot has two operations (save, restore) with sub-modes for what's included. There is no
fundamental "fork-mode snapshot vs localnet snapshot" distinction at the snapshot engine level —
fork-mode adds an extras key (`sui-fork-data`) and may populate `services.sui.chainId` for the
cross-chain guard, but the pipeline is unchanged.

| Dimension                  | save (default)                                                                                 | save `--no-include-images`                                                                                                 | save `--include-fork-data` (explicit on)                                                                                         | save (no fork data)                                         | restore                                                                                                            | list                              | delete                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------- | --------------------------------------------------------------------- |
| Container pass             | runs — `commit + save` per labelled container                                                  | **skipped** — `containers: []` (no `docker ps` enumeration)                                                                | runs (mode is orthogonal to extras)                                                                                              | runs                                                        | runs `docker load + tag` per `<id>/containers/*.tar`                                                               | n/a                               | n/a                                                                   |
| Runtime tar                | always tarred unless `opts.skipRuntime` (no CLI flag)                                          | always tarred                                                                                                              | always tarred                                                                                                                    | always tarred                                               | always extracted if `runtime.tar` present (with pre-wipe)                                                          | n/a                               | n/a                                                                   |
| Extras pass                | runs for whatever's in `opts.extras` — CLI populates `sui-fork-data` based on threshold        | same                                                                                                                       | runs — `sui-fork-data` forced on                                                                                                 | NOT populated by CLI                                        | extracts each `meta.extras` entry to its recorded `path`                                                           | n/a                               | n/a                                                                   |
| Pre-cleanup `docker rm -f` | n/a                                                                                            | n/a                                                                                                                        | n/a                                                                                                                              | n/a                                                         | runs against `(meta.app, meta.stack)` containers; best-effort                                                      | n/a                               | n/a                                                                   |
| Chain guard                | n/a                                                                                            | n/a                                                                                                                        | n/a                                                                                                                              | n/a                                                         | runs only if both `opts.expectedChainId` AND `meta.services.sui.chainId` set (CLI does NOT pass `expectedChainId`) | n/a                               | n/a                                                                   |
| Confirmation prompt        | none                                                                                           | none                                                                                                                       | none                                                                                                                             | none                                                        | none                                                                                                               | none                              | `promptConfirm` (or `--yes`)                                          |
| Dry-run support            | yes                                                                                            | yes                                                                                                                        | yes                                                                                                                              | yes                                                         | yes                                                                                                                | n/a                               | yes                                                                   |
| JSON envelope              | yes                                                                                            | yes                                                                                                                        | yes                                                                                                                              | yes                                                         | yes                                                                                                                | yes                               | yes                                                                   |
| State-store mutation       | reads (and copies) `state.json`                                                                | reads + copies                                                                                                             | reads + copies                                                                                                                   | reads + copies                                              | overwrites live `state.json`                                                                                       | reads `meta.json` per dir         | n/a                                                                   |
| Reads docker daemon        | yes (`docker ps`)                                                                              | no                                                                                                                         | yes                                                                                                                              | yes                                                         | yes (`docker load`, `docker rm -f`, `docker tag`)                                                                  | no                                | no                                                                    |
| Writes docker daemon       | yes (`commit`, `save`)                                                                         | no                                                                                                                         | yes                                                                                                                              | yes                                                         | yes (`load`, `tag`, `rm -f`)                                                                                       | no                                | no                                                                    |
| Persistence side-effects   | new `<id>/` snapshot dir with up to 5 file groups                                              | only `state.json` + `runtime.tar` + `meta.json`                                                                            | adds `extras/sui-fork-data.tar`                                                                                                  | base set                                                    | mutates live `runtime/`, `state.json`, docker daemon                                                               | none                              | `rm -rf <id>/`                                                        |
| Failure recovery           | partial dir on disk, `list()` skips it                                                         | same                                                                                                                       | same                                                                                                                             | same                                                        | partial restore — re-run is idempotent for runtime/state, container loads accumulate                               | n/a                               | filesystem cleanup                                                    |
| Hard requirements          | invariants 1, 2, 3, 4, 5, 12, 16                                                               | invariants 3, 4 only (no container pass)                                                                                   | invariants 1-5, 12, 16 + the `sui-fork-data` tar must round-trip                                                                 | same as default                                             | invariants 1, 2, 6, 7, 9, 10, 11                                                                                   | invariant 8                       | scope to one snapshot                                                 |
| Tests covering this mode   | `engine/snapshot.test.ts` `pause/commit/unpause` + `engine/snapshot.docker.test.ts` end-to-end | `engine/snapshot.test.ts:338-354` (`skipRuntime=true` — closest equivalent; `--no-include-images` flag covered indirectly) | OPEN QUESTION: no test asserts the `sui-fork-data` extras round trip end-to-end; `engine/snapshot.fork.docker.test.ts` is a stub | `engine/snapshot.test.ts` state-only / runtime/ round-trips | `engine/snapshot.test.ts` + `engine/snapshot.docker.test.ts`                                                       | `engine/snapshot.test.ts:120-144` | `cli/commands/snapshot.ts:519-648` (no engine-side test for `delete`) |
| Effect dependencies        | FS, Path, Spawner                                                                              | FS, Path, Spawner                                                                                                          | FS, Path, Spawner                                                                                                                | FS, Path, Spawner                                           | FS, Path, Spawner                                                                                                  | FS, Path                          | FS, Path                                                              |

### stage-and-swap modes

| Dimension                   | default (`atomic: true`, `keepBackup: false`)                | `keepBackup: true`                     | `atomic: false` (cross-fs)                                                       |
| --------------------------- | ------------------------------------------------------------ | -------------------------------------- | -------------------------------------------------------------------------------- |
| Promote mechanism           | `fs.rename` (atomic on same fs)                              | same                                   | `fs.cp -r` then `fs.rm -rf` (NOT atomic)                                         |
| Backup retention            | dropped after success                                        | retained as `<target>.backup-<suffix>` | dropped after success                                                            |
| Rollback on promote failure | backup → target                                              | same                                   | error surfaced; no rollback path in fallback branch                              |
| Caller `stage` error        | passed through unwrapped via the `E` channel                 | same                                   | same                                                                             |
| Warning log on fallback     | none                                                         | none                                   | `Effect.logWarning` ("rename failed; falling back to copy-then-rm — NOT atomic") |
| Tests                       | `engine/stage-and-swap.test.ts:48-68,97-115,118-149,178-193` | `engine/stage-and-swap.test.ts:70-95`  | OPEN QUESTION: no test exercises `atomic: false` branch                          |

## Test coverage

### `engine/snapshot.test.ts` (666 LOC)

`describe('snapshot() / restore() — state-only round-trip')`:

- `captures state.json and restores it byte-for-byte` (`:82-118`) — write state.json, save, mutate
  state.json, restore, assert byte equality.
- `list() returns the saved snapshot with meta` (`:120-144`) — two saves, list returns sorted
  entries with stack + createdAt.
- `restore() of a missing id fails with a clear error` (`:146-156`) — asserts message contains both
  id and "not found".
- `round-trips a typed services bucket (sui slice → meta.json → list)` (`:158-188`) —
  `services: {sui: {chainId: '0xchain-A'}}` round-trips through meta.json (under `services.sui`, NOT
  at top level) and surfaces via `list()`.
- `restore() refuses a cross-chain restore (services.sui.chainId mismatch)` (`:190-212`) — save with
  chainId A, restore with `expectedChainId: '0xchain-B'`, asserts error message contains both
  chainIds + "chainId mismatch".

`describe('snapshot() / restore() — runtime/ tar round-trip')`:

- `tars + restores runtime/<service>/ files with mode bits` (`:231-283`) — populates
  `runtime/accounts/alice.key` (0o600), `runtime/seal/master-key.env` (0o600),
  `runtime/walrus/main/deploy/deploy` (0o644); save, wipe, restore; asserts contents AND mode bits.
- `walrus deploy outputs (multiple instances) ride the runtime tar verbatim` (`:285-336`) — two
  walrus instances (`main`, `alt`) with `deploy/` + `node-0.key` (0o600); save, wipe, restore;
  per-instance + per-file mode preserved.
- `skipRuntime=true omits the runtime tar` (`:338-354`) — `runtimeTar` undefined on save result.
- `first-boot stack with no runtime/ yet is a clean no-op` (`:356-379`) — empty stack save + restore
  returns `{runtimeRestored: false, loadedImages: []}` without erroring.
- `restore() clears stale files in runtime/ that were not in the snapshot` (`:381-427`) — Bug B
  regression: snap-A with only alice.key; create bob.key + `stray-service/data.json` after save;
  restore snap-A; bob.key and stray-service/ MUST be gone (orphan-purge).

`describe('snapshot() / restore() — extras round-trip')`:

- `tars + restores opt-in extras paths` (`:449-475`) — write `foo.txt` (0o600), save with
  `extras: [{key: 'foo', path: extrasDir}]`, rm the file, restore, file back with 0o600.
- `missing extras path is skipped, not failed` (`:477-494`) —
  `extras: [{key: 'gone', path: <nonexistent>}]`; save succeeds with `extrasTars.length === 0`.

`describe('snapshot() pause/commit/unpause ordering')` (uses stub `ChildProcessSpawner`):

- `pauses the container before commit and unpauses after` (`:594-621`) — recorded docker
  invocations: pauseIdx < commitIdx < unpauseIdx all set.
- `unpauses even when commit fails` (`:623-645`) — `commitFails: true`; pause AND unpause still both
  recorded even though save failed.
- `skips pause/unpause when the container is already stopped` (`:647-665`) — `running: false`; no
  pause or unpause; commit still happens.

### `engine/snapshot.docker.test.ts` (272 LOC)

Single integration block `describe.skipIf(!DOCKER_OK || !DIST_OK)`:

- `apply → snapshot save → wipe → snapshot restore → apply preserves chain identity` (`:162-261`) —
  5-minute timeout. Drives the built CLI against `examples/arena`. Asserts: apply1 ok, packageIds
  captured pre-snapshot; `snapshot save --label LABEL` ok, output `saved snapshot \S+-LABEL`;
  `wipe --yes` ok; `snapshot restore LABEL` ok with `runtime/ extracted` and
  `loaded images: …devstack-snap:…` lines; apply2 ok with `publishMove(connect_four): cache hit` +
  `Action(arena.openLobby): cache hit` (the smoking-gun assertions); post-restore packageIds CONTAIN
  the pre-snapshot value. Try/finally cleanup runs `wipe --yes` + removes per-LABEL snapshot dirs.

### `engine/snapshot.fork.docker.test.ts` (30 LOC)

`describe.skipIf(!process.env.RUN_FORK_DOCKER_TESTS === '1')`:

- `save → wipe → restore preserves chainId + forkedAtCheckpoint in SnapshotMeta` (`:20-29`) — STUB.
  Body asserts `SHOULD_RUN === true`. Docstring describes the intended assertions: chainId +
  forkedAtCheckpoint + upstream round-trip; `--expectedChainId` + `--expectedUpstream` validate
  against fresh boot. Note: the file references `meta.forkedAtCheckpoint` / `meta.upstream` as if
  they were top-level meta fields but the current SnapshotMeta schema only carries them under
  `services.sui` — comment is stale (see Open questions).

### `engine/snapshot-deepbook.docker.test.ts` (50 LOC)

`describe.skipIf(!DOCKER_OK || !DEVSTACK_INTEGRATION_TESTS)`:

- All 6 cases are `it.todo`. Intended assertions documented in module comment (`:1-34`):
  - `apply → save → wipe → restore: deepbook-config.ts regenerated identical content` —
    `src/generated/deepbook-config.ts` re-emits with verbatim `packageIds`, `coins`, `pools`,
    `marginPools`, `pyth`.
  - `on-chain deepbook package + pool ids unchanged after restore` — query restored sui RPC, assert
    ids match step 1.
  - `pyth PriceInfoObject ids unchanged after restore` — Pyth on-chain state captured by
    sui-localnet's snapshot.
  - `indexer last-checkpoint cursor preserved in Postgres after restore`.
  - `server /ticker shows the same per-pool lastPrice after restore`.
  - `margin pool ids + supplier-cap balance unchanged after restore`.

### `engine/stage-and-swap.test.ts` (205 LOC)

`describe('stageAndSwap')`:

- `happy path: writes target, drops the staging+backup siblings` (`:48-68`) — pre-existing target
  with old.txt; stage writes new.txt; post-success target has new.txt only, no siblings remain.
- `keepBackup: previous target survives as a sibling` (`:70-95`) — `keepBackup: true`; backup dir
  contains old.txt verbatim post-success; no staging sibling.
- `stage failure: pre-existing target untouched, staging dir cleaned` (`:97-115`) —
  `stage: () => Effect.fail('boom')`; target byte-identical pre/post; no siblings.
- `promote-rename failure rolls back to the pre-existing target` (`:118-149`) — `stage` deletes the
  staging dir, causing second-rename ENOENT; pre-existing target byte-identical post-failure
  (rollback restored backup); no siblings.
- `stage failure surfaces the caller-supplied error verbatim` (`:151-176`) —
  `stage: () => Effect.fail('caller-tag')`; cause carries `'caller-tag'` unwrapped (NOT a
  `StageAndSwapError`).
- `absent pre-existing target: success creates target, no rollback needed` (`:178-193`) — target
  doesn't exist; stage writes fresh.txt; post-success target has fresh.txt.
- `StageAndSwapError is a tagged error with op + target diagnostic fields` (`:195-204`) — \_tag, op,
  target preserved.

## Pain points today

1. **Snapshot embeds first-class service knowledge.** `engine/snapshot.ts:1-50` module comment is a
   manifest of every in-tree service's runtime paths. Adding a new service requires either: (a) the
   service routes its writes through `servicePath('<name>', …)` so it auto-rides the runtime tar
   (the convention path); or (b) the service uses paths outside `runtime/`, in which case the CLI
   must register an extras entry by hand (today only `sui-fork-data` is registered). There is no
   plugin-registry hook for either case — both require editing engine or CLI source. The
   `SnapshotMetaServices` declaration-merging convention (`engine/snapshot.ts:151-186`) at least
   provides typed slots for plugin-contributed meta, but the actual _capture_ (telling the snapshot
   what to tar) is hardcoded.

2. **CLI does NOT thread `expectedChainId` through `restore`.** `engine/snapshot.ts:655-659` defines
   the option; `engine/snapshot.test.ts:190-212` asserts the guard fires when set; but
   `cli/commands/snapshot.ts:435-439` calls `restore({id, dir, stack})` without `expectedChainId`.
   The cross-chain guard is dead in practice unless an engine-level caller fills it in. This is the
   biggest correctness gap.

3. **CLI does NOT populate `services` bucket on save.** `cli/commands/snapshot.ts:286-293` passes
   only `{id, dir, app, stack, containers, extras}` to `snapshot()`. The
   `services: {sui: {chainId}}` slice from `SnapshotMetaServices` is never written — the CLI would
   need to first acquire the running Sui's chainId (e.g. by reading state.json's published
   `sui.localnet` registry entry, or by running an embedded supervisor stub) and pass it through.
   Today the cross-chain guard is doubly dead: no `expectedChainId` AND no
   `meta.services.sui.chainId`.

4. **`engine/snapshot.fork.docker.test.ts` is a placeholder.** 30 LOC stub with a body that just
   asserts `SHOULD_RUN === true`. Comments reference `meta.chainId` / `meta.upstream` /
   `meta.forkedAtCheckpoint` as TOP-level fields but the current schema only carries `chainId` under
   `services.sui`; `upstream` / `forkedAtCheckpoint` are NOT in `SnapshotMetaServices.sui` today
   (`engine/snapshot.ts:177-186`). Comment is stale.

5. **No transactional `restore()`.** Mid-restore interrupt or failure leaves the live state in any
   of: state.json partially overwritten, runtime/ wiped but not yet untarred, some container tars
   loaded but not retagged. The `stageAndSwap` primitive (`engine/stage-and-swap.ts`) exists but
   `restore()` doesn't use it. The pre-cleanup `docker rm -f` is also irreversible — once it runs,
   you can't "rollback to before the restore started" by re-running anything.

6. **No `snapshot-from-live` helper.** The spec calls out checking for one. There isn't:
   `snapshot()` is always against the current state-store + runtime dir + (optional)
   currently-deployed docker containers. Forks against testnet/mainnet are pre-warmed via the
   `sui-fork-cache/` mechanism (not via snapshot pre-population); a snapshot of a fork stack picks
   up whatever's in the live `sui-fork/data/` dir at save time, plus the chainId in state.json.
   There's no "build me a snapshot artifact directly from a live RPC checkpoint" path. OPEN QUESTION
   below.

7. **Concurrent `snapshot()` against the same id silently overwrites.**
   `engine/snapshot.test.ts:31-37` calls this out as acceptable because the CLI's `makeId()` adds a
   random suffix. But the engine API is callable from non-CLI sites — a plugin author calling
   `snapshot({id: 'foo'})` twice would overwrite without warning.

8. **No locking around source `runtime/` or `state.json` during save.** A concurrent supervisor
   write while `tar` walks the tree could observe a torn file (e.g. seal master-key.env
   mid-rotation). Mitigations: account keystore writes are mode 0o600 single-shot; seal's rotation
   does write atomically via tmp+rename. But the invariant isn't enforced by snapshot itself.

9. **`saveImage` byproduct (`devstack-snap:<id>-<name>` images) is never cleaned up.** The tar in
   `<id>/containers/` is the portable artifact; the local daemon's image lingers until manual
   `docker rmi`. A long-running developer's daemon accumulates `devstack-snap:*` images proportional
   to snapshot count.

10. **Pre-cleanup runs BEFORE chain guard logically, but they're in the right order in code.** The
    chain guard runs at `engine/snapshot.ts:710-725`, pre-cleanup at `:738-740`. Good — cross-chain
    refusal happens before the destructive `docker rm -f`. But the state.json copy + runtime untar
    happen AFTER pre-cleanup; if the chain guard had been ordered after, a refused restore would
    still have nuked containers. The current order is correct but the dependency is implicit.

11. **`SnapshotMeta` schema vs runtime mismatch.** `engine/snapshot.ts:892-898` does
    `try { decodeMetaSync(parsed) } catch { return undefined }`. A snapshot from an older devstack
    (or a corrupt write) silently downgrades to "no meta" and the restore degrades to "state +
    runtime only, no pre-cleanup, no retag" — silently losing chain state on next apply. There's no
    version field on `SnapshotMeta` and no warning on schema mismatch.

12. **`runtime.tar` is always full.** No incremental, no per-service slicing. A 5 GB walrus deploy
    state means every snapshot is 5 GB+ on disk. The 1 GiB threshold on `--include-fork-data` is the
    only size mitigation; runtime/ has none.

13. **CLI's `--no-include-images` flag has no engine-side test for the state-only path.**
    `engine/snapshot.test.ts:338-354` tests `skipRuntime: true` (the inverse mode); there's no test
    for `containers: []` + runtime included that asserts the resume path can rebuild from genesis.

14. **`engine/snapshot.ts` mirrors `engine/service-paths.ts:resolveRuntimeRoot` rather than
    importing it.** `engine/snapshot.ts:262-287` re-implements the env-override + local-like vs
    live-net branching inline, with the comment "Inline the check so this module stays pure-string
    and doesn't depend on `SuiNetwork`'s literal type" (`:271-273`). Two sources of truth for the
    same path math; a future refactor of `resolveRuntimeRoot` won't auto-propagate.

15. **Container enumeration is the CLI's responsibility, not the engine's.**
    `cli/commands/snapshot.ts:117-145` does
    `docker ps -a --filter ... --format '{{.ID}}\t{{.Names}}'` and passes the parsed tuples to
    `snapshot()`. A non-CLI caller (programmatic) must replicate this enumeration. There's no engine
    helper that says "give me the containers I should snapshot for (app, stack)".

16. **`buildServicesBucket` is a thin spread.** `engine/snapshot.ts:230-232` returns
    `{ ...entries } as Record<string, unknown>`. The TS typing comes from
    `Partial<SnapshotMetaServices>`; the runtime is just a permissive spread. The function exists to
    centralize the typing fiction, not to do any real work.

17. **Deepbook L4 regression is unimplemented.** `engine/snapshot-deepbook.docker.test.ts` is 50 LOC
    of `it.todo`. No automated regression covers the deepbook stack's snapshot ride-through.

## Open questions

1. **Should snapshot-from-live exist?** Today there's no "pre-populate a fork stack from a live
   testnet RPC checkpoint via snapshot" pathway; pre-warming is via `.devstack/sui-fork-cache/`. Is
   "snapshot from a remote node" intended for v2, or is the pre-warm cache the only mechanism?

2. **Are `upstream` and `forkedAtCheckpoint` ever going to be top-level `SnapshotMeta` fields?**
   `engine/snapshot.fork.docker.test.ts:13` and `:26` reference them as if they were, but
   `SnapshotMetaServices.sui` only declares `chainId`. The placeholder test's intent disagrees with
   the current schema.

3. **What is the cross-stack restore contract precisely?** `cli/commands/snapshot.ts:399-434` says
   "intentionally allowed (operator might want to clone a known-good world into a fresh stack)" and
   just emits a warning. But the on-disk runtime tar contains paths rooted at
   `runtime/<service>/...` — they extract fine into the new stack's runtime dir. The `state.json` is
   copied verbatim including its cached publishMove entries keyed by chainId; since the loaded
   container's chain IS the source chain (RW layer rides via `docker commit`), the chainId persists
   across stacks. Is that intended, or should cross-stack restore re-derive chainId? OPEN.

4. **What is the resume contract end-to-end?** Restore returns. The next `devstack apply` is
   supposed to adopt the snapshot images via the supervisor's `Docker.run`
   reuse-if-name-and-image-match probe. The `engine/snapshot.docker.test.ts:213-232` asserts this
   works for arena, but the supervisor-side logic (image cache probe, decideRunAction,
   fresh-vs-adopt branching) lives in `engine/docker/...` and isn't documented as a snapshot
   dependency. If the supervisor changes its cache-skip semantics, snapshot resume breaks silently.

5. **Should the engine snapshot API enumerate containers itself?** Today the CLI does
   `docker ps --filter` and passes ids to `snapshot()`. A programmatic caller (test fixture, plugin
   author) must replicate. Should `snapshot()` accept `{stack, app}` and discover its own container
   list?

6. **Why is there no `engine/snapshot.docker.test.ts` for `--no-include-images`?** State-only
   snapshot is documented at `cli/commands/snapshot.ts:180-184` as "rare, but useful when the
   runtime dir is large". No test verifies the resume path (genesis re-run + cache invalidation)
   works correctly.

7. **Is `stageAndSwap` intended to be used by `restore()`?** The primitive exists in this scope
   (`engine/stage-and-swap.ts`) and is "the atomic-swap mechanism used during restore" per the spec,
   but the actual `restore()` does NOT use it (`engine/snapshot.ts:763-794` is a wipe-then-untar).
   Was integration intended but unshipped? Today `stageAndSwap` consumers are
   `services/codegen.ts:246` and `codegen/emitters/bindings.ts:142` — both codegen, not snapshot.

8. **What's the semantics when `meta.services.sui.chainId` is set but `opts.expectedChainId` is
   NOT?** Currently: guard skipped, restore proceeds, chain state lands on disk, next `apply` MIGHT
   mismatch the running stack's chain. Should the engine require both or refuse to restore without
   `expectedChainId`?

9. **Is the snapshot's `network` field used for anything beyond meta record-keeping?**
   `engine/snapshot.ts:470` defaults to `'localnet'`; `resolveStackPaths` uses it to pick the
   local-like vs live-net path branch. But cross-network restore (snapshot saved under
   `network='localnet'`, restored with `network='testnet'`) would resolve different `runtimeDir`
   paths and could write into the wrong tree. No guard checks `meta.network === opts.network`.

10. **`runtimeTar` field on result vs `meta.runtimeIncluded` — same info, two surfaces.** Why both?
    Caller might inspect `result.runtimeTar` for the absolute path, but `meta.runtimeIncluded` is
    what `list()` could surface. Today `list()` doesn't surface it.

11. **Should the snapshot dir live OUTSIDE `.devstack/stacks/<stack>/`?** Today
    `<DEVSTACK_STATE_DIR>/snapshots/` is sibling to `stacks/`, so `wipe` of a single stack doesn't
    remove the snapshot dir IF the snapshot dir is outside `stacks/<stack>/`. But the
    `_prune-stack.ts:235` `if (entry === 'snapshots') continue` suggests there's ALSO a
    `stacks/<stack>/snapshots/` that wipe preserves with `--keep-snapshots`. Which path is
    canonical? Both seem to exist in different code paths.

12. **No `delete` engine API.** `cli/commands/snapshot.ts:519-648` implements `snapshot delete`
    inline via `fs.remove(targetDir, {recursive: true, force: true})` (`:633`). There's no
    `engine/snapshot.ts::delete()` export. Why? Is delete intentionally "just a directory rm" with
    no engine ceremony, or is this an oversight?

## Opportunities noticed

1. **Service-paths capture is the obvious extension point.** Every service that routes through
   `servicePath('<name>', …)` already auto-rides the runtime tar. The "snapshot knows about
   services" pain point really comes from extras (which require explicit registration) and
   per-service meta slices (which require declaration merging + manual buildServicesBucket calls in
   the CLI). A unified `ServiceSnapshot` plugin registry — "here's my extras paths, here's my
   pre-/post-restore validators, here's my chain-guard slice" — would centralize the per-service
   contract instead of scattering it.

2. **`engine/snapshot.ts:262-287` duplicates `engine/service-paths.ts:64-82` `resolveRuntimeRoot`.**
   Mirroring with a "kept inline to avoid dep" comment is a smell. A small `engine/path-routing.ts`
   that both modules import would remove the duplication and eliminate the comment's premise.

3. **`buildServicesBucket` could go.** It's `(entries) => ({...entries})` with a cast. Replace call
   sites with `services: opts.services as Record<string, unknown>` (or just inline an object
   literal). The TS contract is already enforced by `SnapshotMeta.services`'s permissive
   `Record<string, unknown>` shape at the schema boundary.

4. **The hardcoded path comments at `engine/snapshot.ts:1-50` are duplicated as JSDoc + inline + on
   `SnapshotMetaServices`.** They drift. A single doc table mapping service → runtime path → meta
   slice would survive better.

5. **`restore()` should use `stageAndSwap`.** The primitive is right there in the same directory,
   it's tested, and it would make restore atomic against external watchers (Vite HMR on `runtime/`).
   Current `rm + mkdir + tar -x` is the very pattern stageAndSwap exists to replace; the only reason
   it isn't used is order-of-development (snapshot predates stage-and-swap centralization; codegen
   migration happened first per `engine/stage-and-swap.ts:23-27`).

6. **`SnapshotMeta` has no schema version.** Even though `engine/snapshot.ts:892-898` falls back to
   `undefined` on decode failure, a `version: 1` field would let future schema evolution detect old
   vs new without silently losing information.

7. **Container enumeration helper.** Lift `cli/commands/snapshot.ts:117-145` into
   `engine/snapshot.ts` (or `engine/docker/inventory.ts`) so programmatic callers don't need to
   shell out to docker themselves. Today `engine/docker/inventory.ts:removeDockerByLabel` already
   does the (app, stack) label-filter walk for `pruneStack`; a sibling `listContainersForAppStack`
   belongs there.

8. **CLI restore should pass `expectedChainId`.** Reading the running stack's chainId from the live
   state-store registry (`SuiStateRegistry`) at CLI invocation time would close the cross-chain
   guard gap with one new line in `cli/commands/snapshot.ts:435-439`. Same for
   `services.sui.chainId` on save: read the registry, pass through.

9. **`engine/snapshot-deepbook.docker.test.ts` is 50 LOC of `it.todo`.** Either implement or remove
   — `it.todo` files create the illusion of coverage without delivering it.

10. **`engine/snapshot.fork.docker.test.ts` has stale comments referencing top-level meta fields
    (`upstream`, `forkedAtCheckpoint`) that don't exist on the current `SnapshotMeta` schema.**
    Either update schema (extend `SnapshotMetaServices.sui`) or update the test comments.

11. **`devstack-snap:<id>-<name>` images are never GC'd.** Add a `prune --include-snapshot-images`
    pass that drops `devstack-snap:*` images with no matching `<id>/` dir on disk — they're orphans.

12. **`runtime.tar` size is unbounded.** A 5 GB walrus deploy state means every snapshot is 5 GB+ on
    disk. The 1 GiB threshold on `--include-fork-data` shows the team has thought about this for one
    pathway; the runtime tar deserves the same treatment, or at minimum a `--max-runtime-size` flag
    that warns/refuses.

13. **`snapshot()` and `restore()` should accept `Effect.Scope`-based callers' cancellation
    gracefully.** `Effect.ensuring` is used for unpause only. A scoped resource that registers
    `docker rm -f devstack-snap:<id>-<name>` on interrupt would prevent the orphan-image problem
    above.

14. **`STATE_DIR` at module load (`engine/snapshot.ts:62`) vs action-time read
    (`engine/snapshot.ts:263`).** Two places read the env var. The module-load capture is dead (only
    used to build `DEFAULT_SNAPSHOTS_DIR`); the action-time read is the truth. Drop the module-load
    constant or document why both exist. `cli/commands/snapshot.ts:45-49` already preaches the
    action-time pattern in a comment.

15. **`Schema.optional` on `containers` + `extras` + `services` produces three different
    `...(x.length > 0 ? {x} : {})` spreads in `engine/snapshot.ts:632-634`.** A small `omitEmpty`
    helper would clean this up.

16. **`pruneStack` shared with `prune` is good, but `cli/commands/_prune-stack.ts:235`'s
    `if (entry === 'snapshots') continue` hardcodes the same string the snapshot module derives
    differently.** Centralize the snapshots-dir-name constant.

17. **`SnapshotMeta.services` is `Schema.Record(Schema.String, Schema.Unknown)` — the type narrowing
    is purely TypeScript declaration merging, which doesn't survive runtime serialization.** A
    plugin author whose meta slice declaration isn't loaded at restore-time still gets the raw
    record via `readServiceMeta` (cast as unknown). Documented at `engine/snapshot.ts:172-176`.
    Consider whether out-of-tree plugins really need to read meta they didn't declare, or whether
    the API should refuse the access.

18. **Wipe's `--keep-snapshots` interacts in two places.** `cli/commands/_prune-stack.ts:235` skips
    the `snapshots/` entry under `<stackDir>/`; the canonical snapshots dir is
    `<STATE_DIR>/snapshots/` (NOT `<STATE_DIR>/stacks/<stack>/snapshots/`). Suggests there are TWO
    snapshot locations or a leftover from an earlier path layout. Audit and pick one.

19. **The `runtimeIncluded: boolean` field on meta is redundant with checking
    `fs.exists(<source>/runtime.tar)` at restore.** It's set at save (`engine/snapshot.ts:631`) but
    not read at restore (`engine/snapshot.ts:772-776` stats the tar file directly). Dead field.

20. **`prettyError` / `summarizeCause` integration depends on `SnapshotError.phase` being a closed
    set.** `engine/phases.ts:212-244` `SnapshotPhases` tuple is the source. Adding a new phase
    requires updating both files. A code-mod helper or a single literal that gets reused would be
    safer.
