# engine-resources

## Purpose

Engine-resources is the substrate layer of devstack: the set of small,
composable capabilities the engine and plugin authors lean on when a
node starts and runs. It owns persistence (a disk-backed kv state-store
with a publish/subscribe registry pattern over Effect Refs), inter-stack
coordination (a port allocator with cross-process file-locking, a
shared file-lock primitive, and per-signer leasing), filesystem
observation (a chokidar-free fs.watch wrapper), the per-stack identity
that flows into docker labels and on-disk paths, the canonical
`.devstack/<identity>/runtime/<service>/` directory layout (`service-paths`),
the atomic-write helper that backs every hot-path sidecar, a cache
discipline keyed by content-hash, a SHA-256 hashing primitive used by
cache + image tags + fingerprints, an allowlist-based env-var redactor
for child processes, and the centralized "where is the app dir"
resolver. None of these resources own service-specific logic; they are
the kernel-level pieces every service composes against.

## Current implementation

File-by-file. LOC is the raw `wc -l` count.

State store
- `engine/state-store.ts` — 530 LOC. The disk-backed kv. Resolves a
  per-stack or per-live-net JSON path under `.devstack/`, acquires a
  pid-aware exclusive lock with jittered-backoff stale recovery, loads
  the persisted `{version, data}` payload (refusing newer schema
  versions, swallowing every other read error to an empty map), writes
  through tempfile+rename on every put/remove, and releases the lock on
  scope teardown only if its `instanceId` is still on disk.
- `engine/state-store-keys.ts` — 164 LOC. Typed builders for the
  canonical state-store key strings used by every cached
  primitive (publishMove, coinMint, walrusDeployOutput, walrusSeedWal,
  sealBlsKeypair, sealKeyServerId, deepbookPools/MarginPools/MarginSeed
  /BalanceManager, pythPackage, pythPusher, dockerOneShot).

Port allocator
- `engine/port-allocator.ts` — 215 LOC. `allocate(preferred, {maxScan})`
  + `release(port)` + `snapshot`. Per-port file lock under
  `~/.devstack/ports/<port>.lock` (overridable via
  `DEVSTACK_PORT_LOCK_DIR`). Three-step claim: in-process Ref CAS →
  cross-process O_EXCL lock → dual-host (`0.0.0.0` + `127.0.0.1`)
  bind probe. Finalizer drops every owned lock on scope teardown.

File lock primitive
- `engine/file-lock.ts` — 211 LOC. Shared body codec
  (`{pid, startedAt, host, instanceId?, acquiredAt?}`) + sync
  `tryClaimLockSync` and `releaseLockSync`. O_EXCL create with
  stale-PID recovery (unlink-and-retry). Used by port-allocator and
  sui-fork; state-store composes only the parse helper because it has
  its own jittered-backoff retry loop on Effect-platform FS.

Leasing
- `engine/leasing.ts` — 65 LOC. Per-address Effect `Semaphore`-of-1
  cache keyed by signer address. `withExclusive(address, work)` wraps
  `work` in `sem.withPermits(1)` so the permit is released on
  completion, failure, or interrupt without manual Scope management.

File watcher
- `engine/file-watcher.ts` — 136 LOC. Pure node `fs.watch` (recursive)
  wrapped in `Stream.callback`. Emits `{kind: 'change'|'add'|'remove',
  path}`. Translates fs.watch's `'change'`/`'rename'` event types into
  the normalized kind and subscribes both `'change'` and `'rename'`
  event names for platform variance. **No chokidar.** No minimatch
  here — globbing lives in the supervisor's filter compilation, not in
  this service.

Identity
- `engine/identity.ts` — 116 LOC. `Identity` Effect service carrying
  `{app, stack, network}`. `validateIdentity` rejects names that won't
  survive docker labels / path joins. `deriveAppName(appDir?)`
  reads `<appDir>/package.json#name`, strips npm scopes
  (`@foo/x` → `x`), strips leading non-alphanumerics, falls back to
  `basename(appDir)` then `'devstack-app'`. `DockerLabel` constant
  exposes the four wire-level docker label keys (`devstack.app`,
  `devstack.stack`, `devstack.network`, `devstack.action`).

Service paths
- `engine/service-paths.ts` — 131 LOC.
  `servicePath(serviceName, ...parts)` and `runtimeRoot`. Validates
  the service name (`/^[a-z][a-z0-9-]{0,63}$/`), resolves the runtime
  root using the same path-precedence rules as state-store
  (`DEVSTACK_STATE_DIR` env → `cfg.stateDir` → `.devstack/stacks/<stack>/runtime`
  for localnet + `*-fork`, else `.devstack/networks/<network>/runtime`),
  and lazily `mkdir -p`s the service subdirectory. Exports
  `RUNTIME_DIR_NAME = 'runtime'` constant. The `ExtraPathEntry` schema
  is for snapshot manifest serialization.

Atomic write
- `engine/atomic-write.ts` — 60 LOC. `writeFileAtomic(target, body, {mode?})`
  and `writeFileAtomicIfChanged(target, body, {mode?})`. Writes to a
  sibling `.${basename}.tmp.<random-hex>` then `rename(tmp, target)`.
  Mkdir-p's the parent dir on every call.

Cache
- `engine/cache.ts` — 178 LOC. `withCache(spec)` — produce-once /
  verify-on-hit cache discipline against `StateStore`. Caches are keyed
  by `${namespace}/${chainId}/${contentHash(JSON.stringify(inputs), {length: 16})}`,
  with chainId omitted when empty. Verify probe returns `undefined` to
  invalidate (evict + produce); errors in verify collapse to invalidation
  via caller-side `Effect.orElseSucceed(() => undefined)`.

Content hash
- `engine/content-hash.ts` — 91 LOC. `contentHash(input, {length?})` —
  SHA-256, lowercase hex, default full 64 chars. Object inputs go
  through `JSON.stringify` with NO key sort (caller responsibility).
  `createContentHasher()` returns a streaming `Hash`; `digestHex(hasher,
  {length?})` and `truncateDigest(hex, length)` are the finalize/slice
  helpers.

Safe env
- `engine/safe-env.ts` — 43 LOC. `inheritedHostEnv()` returns the
  subset of `process.env` matching a hard-coded allowlist
  (`PATH HOME USER SHELL LANG LC_ALL TERM TMPDIR NODE_ENV NODE_PATH
  NODE_OPTIONS PWD OLDPWD SystemRoot APPDATA LOCALAPPDATA USERPROFILE Path
  DEVSTACK_STACK`). Unset entries are omitted (no `undefined` values).

Resolve app dir
- `engine/resolve-app-dir.ts` — 15 LOC. `resolveAppDir()` returns
  `process.env.DEVSTACK_APP_DIR ?? process.cwd()`. Read at call-time so
  per-test mutation works. Exports `APP_DIR_ENV = 'DEVSTACK_APP_DIR'`.

Registry primitive (generic, in scope)
- `engine/define-registry.ts` — 83 LOC. `defineRegistry<I, T>(Tag)` →
  `{Live, publish, require}`. Append-only `Ref<ReadonlyArray<T>>`,
  last-write-wins on dedupe-by-name (the per-service registries layer
  that pass on top of `snapshot`, not in here).
- `engine/registry.ts` — 275 LOC. The GLOBAL stack registry at
  `~/.devstack/registry.json` (`{version: 1, stacks: RegistryEntry[]}`).
  Lifecycle classification (`active | dormant | stale | abandoned`).
  Used by doctor + prune. Read/upsert/clearPid/remove operations with
  bounded retry, tempfile+rename writes, defensive JSON parsing.

## Configuration

Every config knob touching these resources.

### Environment variables

`DEVSTACK_APP_DIR`
- Resolved by `resolveAppDir()` (`engine/resolve-app-dir.ts:15`). Read
  at every call (no caching), so per-test mutation works.
- Default: `process.cwd()`.
- Accepted values: any absolute or relative directory path.
- Consumers (non-exhaustive): `engine/state-store.ts:137`,
  `engine/snapshot.ts:233`, `engine/service-paths.ts:72`,
  `engine/sui-fork/meta.ts:148`, `engine/sui-build-container.ts:667`,
  `engine/supervisor.ts:1990`, `engine/docker/inventory.ts:606`.

`DEVSTACK_STATE_DIR`
- Read by `state-store.ts:resolvePaths` (`engine/state-store.ts:121-128`)
  and `service-paths.ts:resolveRuntimeRoot`
  (`engine/service-paths.ts:65-68`).
- When set and non-empty, overrides all path scoping: state-store file
  lives at `${DEVSTACK_STATE_DIR}/state.json`, runtime root lives at
  `${DEVSTACK_STATE_DIR}/runtime/`. Stack/network identity is ignored
  for these two paths.
- Default: unset → fall through to `cfg.stateDir` → fall through to
  network-aware scoping.
- Test enforces precedence: `state-store.test.ts:173-189`
  ("DEVSTACK_STATE_DIR override wins over stack/network scoping").

`DEVSTACK_PORT_LOCK_DIR`
- Read by `defaultPortLockDir()` (`engine/port-allocator.ts:81-82`).
- Overrides `~/.devstack/ports/` as the cross-process port-lock
  rendezvous directory. Used by vitest's setupFiles to isolate
  per-process test runs.
- Default: `path.join(os.homedir(), '.devstack', 'ports')`.

`DEVSTACK_REGISTRY_FILE`
- Read by `registryFilePath()` (`engine/registry.ts:80-84`).
- Overrides `~/.devstack/registry.json` for the global stack registry.
- Default: `path.join(homedir(), '.devstack', 'registry.json')`.

`DEVSTACK_STACK`
- Forwarded to spawned children by `safe-env.ts` allowlist
  (`engine/safe-env.ts:31`). Used by the runtime layer
  (`runtime/conventional-routes.ts:76`) and the CLI
  (`cli/stack-resolution.ts`) for stack-name resolution, but NOT
  consumed directly by any engine-resources module — they receive the
  resolved name through `StateStoreConfig.stack`.

`DEVSTACK_NETWORK`
- Read by `resolveNetwork()` in `engine/network.ts:80-94`. Defaults to
  `'localnet'`. Throws on unrecognized values. Fork variants
  (`mainnet-fork`, `testnet-fork`, `devnet-fork`) ARE valid env values.

### `defineDevstack` / `StateStoreConfig` options affecting these resources

`StateStoreConfig.stack` — drives the state-store path's `<stack>`
segment AND the runtime-root's per-stack subdir. Engine-resources doesn't
default it; the supervisor resolves via `resolveStackName` and passes in.

`StateStoreConfig.network` — chooses local-like routing vs.
live-net routing. `isLocalLikeNetwork(network)` (network is `'localnet'`
or ends with `'-fork'`) → `.devstack/stacks/<stack>/...`. Otherwise →
`.devstack/networks/<network>...`. `engine/state-store.ts:145`,
`engine/service-paths.ts:78`.

`StateStoreConfig.stateDir` — optional explicit override, equivalent
to setting `DEVSTACK_STATE_DIR` per-instance. The env var wins on
ties (`engine/state-store.ts:121`, `engine/service-paths.ts:65`).

`config.watch` — list of gitignore-style patterns flowing into the
supervisor's `compileWatchFilter` (`engine/supervisor.ts:806-836`).
Together with each primitive's `__watchPaths`, this forms the positive
+ negation pattern set for `FileWatcher` consumers. The watcher
service itself doesn't read this config.

`config.hotRestart` — defaults to `watchRoots.length > 0`
(`engine/supervisor.ts:1460`). Controls whether file-watch events
debounce-and-restart or merely log.

### Defaults

| Knob | Default | Source |
|------|---------|--------|
| `MAX_RECLAIM_ATTEMPTS` (state-store lock) | 20 | `state-store.ts:307` |
| `BASE_BACKOFF_MS` (state-store lock) | 50 | `state-store.ts:308` |
| `BACKOFF_GROWTH` (state-store lock) | 1.5 | `state-store.ts:309` |
| `CURRENT_VERSION` (state-store schema) | 1 | `state-store.ts:97` |
| port-allocator `maxScan` | 100 | `port-allocator.ts:141` |
| port-allocator `defaultPortLockDir` | `~/.devstack/ports/` | `port-allocator.ts:82` |
| port-allocator probe hosts | `0.0.0.0` then `127.0.0.1` | `port-allocator.ts:118-129` |
| identity name regex | `/^[a-z0-9][a-z0-9._-]{0,63}$/` | `identity.ts:47` |
| service-paths name regex | `/^[a-z][a-z0-9-]{0,63}$/` | `service-paths.ts:48` |
| `RUNTIME_DIR_NAME` | `'runtime'` | `service-paths.ts:46` |
| content-hash algorithm | SHA-256 | `content-hash.ts:57` |
| content-hash default length | 64 (full) | `content-hash.ts:67` |
| `STALE_THRESHOLD_MS` (registry) | 30 days | `registry.ts:86` |
| registry `MAX_WRITE_ATTEMPTS` | 3 | `registry.ts:194` |
| watcher debounce | 250ms | `supervisor.ts:868` |
| file modes (atomic-write default) | OS umask unless `mode` passed | `atomic-write.ts:33` |
| state-store file mode | 0o600 (best-effort chmod) | `state-store.ts:497` |
| registry file mode | 0o644, dir 0o755 | `registry.ts:213, 219` |

## Capabilities CONSUMED

Each sub-component's dependencies, both engine-internal and external.

### State store

Filesystem
- Read/write `<dir>/state.json` and `<dir>/state.json.lock` (or
  per-network filename for live nets). `engine/state-store.ts:148-159`.
- `mkdir -p` the parent dir at acquire (`state-store.ts:219`).
- `chmod 0o600` on the file post-write, best-effort (`state-store.ts:226, 497`).
- Tempfile path: `${file}.tmp.${pid}.${Date.now()}.${randomBase36}`
  (`state-store.ts:482-484`).

OS / platform
- `process.kill(pid, 0)` for liveness (via `isHolderLive` →
  `process-liveness.ts:34`).
- `ps -o lstart=` (POSIX) / `tasklist` (Windows) for start-time match
  (`process-liveness.ts:60-71`).
- `os.hostname()` for the `host` slot in the lock body
  (`state-store.ts:238`).
- `crypto.randomUUID()` for `instanceId` (`state-store.ts:34, 244`).

Effect platform layer
- `FileSystem.FileSystem` (`state-store.ts:210`) — exists / readFileString
  / writeFileString (with `{flag: 'wx'}` for O_EXCL) / rename / remove /
  chmod / makeDirectory.
- `Effect.acquireUseRelease` for tempfile-write+rename
  (`state-store.ts:488`).
- `Effect.uninterruptible` around the release finalizer
  (`state-store.ts:391`).
- `Effect.sleep` for jittered backoff (`state-store.ts:318`).

External libs
- None beyond `effect` itself.

Other engine-resources
- `engine/resolve-app-dir.ts` (path resolution).
- `engine/network.ts:isLocalLikeNetwork` (routing).
- `engine/process-liveness.ts:isHolderLive`, `processStartTime`.
- `engine/json-bigint.ts:jsonBigintReplacer/Reviver` (BigInt-safe JSON).

### State store keys

Filesystem: none. Pure string builders.

OS/platform: none.

Effect: none — exported as plain functions.

External libs: none.

Other engine-resources: none. Independent module.

### Port allocator

Filesystem
- `~/.devstack/ports/<port>.lock` (overridable). Created
  via `tryClaimLockSync` → `fs.writeFileSync(path, body, {flag: 'wx'})`
  (`file-lock.ts:131-133`).
- `fs.mkdirSync(dirname(lockPath), {recursive: true})` per claim
  (`file-lock.ts:126`).

OS / platform
- `net.createServer().listen(port, host)` probe on `0.0.0.0` and
  `127.0.0.1` (`port-allocator.ts:51-63`). Sequential, not parallel,
  because `0.0.0.0:port` covers `127.0.0.1:port` on Linux
  (`port-allocator.ts:119-128`).
- `process.kill(pid, 0)` via `isHolderLive`.

Effect platform layer
- None on the OS path — the allocator uses bare Node FS/net APIs via
  `Effect.tryPromise` + `Effect.sync`.
- `Effect.withSpan('PortAllocator.allocate', {attributes: {preferred}})`
  (`port-allocator.ts:182`).
- `Ref` for the in-memory held set (`port-allocator.ts:134`).

External libs
- None.

Other engine-resources
- `engine/file-lock.ts:parseLockBody`, `tryClaimLockSync`,
  `releaseLockSync` (`port-allocator.ts:17`).

### Leasing

Filesystem: none — in-memory only.

OS/platform: none.

Effect platform layer
- `Semaphore.make(1)` (`leasing.ts:44`).
- `sem.withPermits(1)(work)` (`leasing.ts:60`) — interrupt-safe by
  construction.
- `Ref` for the per-address semaphore map (`leasing.ts:36`).
- `Effect.withSpan('Leasing.withExclusive', {attributes: {address}})`
  (`leasing.ts:61`).

External libs: none.

Other engine-resources: none.

### File lock

Filesystem
- `fs.writeFileSync(lockPath, body, {flag: 'wx'})` — O_EXCL create
  (`file-lock.ts:132`).
- `fs.readFileSync` for inspection (`file-lock.ts:142`).
- `fs.unlinkSync` for reclaim + release (`file-lock.ts:173, 206`).
- `fs.mkdirSync(dirname(lockPath), {recursive: true})`
  (`file-lock.ts:126`).

OS / platform
- `crypto.randomUUID()` (`file-lock.ts:55`).
- `os.hostname()` (`file-lock.ts:52`).
- `process.pid` (`file-lock.ts:51`).
- `process-liveness.ts:isHolderLive`, `processStartTime`
  (`file-lock.ts:30, 50`).

Effect platform layer: none — pure synchronous.

External libs: none.

Other engine-resources
- `engine/process-liveness.ts` (`file-lock.ts:30`).

### File watcher

Filesystem
- `fs.watch(path, {recursive: true})` (`file-watcher.ts:85`). Recursive
  watching silently degrades to non-recursive on Linux (no native
  inotify recursion); deferred to a future chokidar swap
  (`file-watcher.ts:13-15`).

OS / platform
- Node's `FSWatcher` event surface: `'change'` (with `eventType` arg
  `'change'` | `'rename'`) AND a top-level `'rename'` event subscribed
  separately for platform variance (`file-watcher.ts:106-107`).

Effect platform layer
- `Stream.callback<ChangeEvent, FileWatcherError>` (`file-watcher.ts:82`).
- `Queue.offerUnsafe`, `Queue.failCauseUnsafe` (`file-watcher.ts:95,
  110-119`).
- `Effect.addFinalizer` to close the watcher on stream scope teardown
  (`file-watcher.ts:124-133`).
- `Effect.withSpan('FileWatcher.watch', {attributes: {path}})`
  (`file-watcher.ts:134`).

External libs
- **No chokidar.** Note the file header explicitly defers chokidar
  ("Defer chokidar until someone reports it"). The minimatch dep
  consumed in `supervisor.ts:806-836` is at the supervisor layer, not
  here.

Other engine-resources: none.

### Identity

Filesystem
- `readFileSync('<appDir>/package.json', 'utf8')` (`identity.ts:101`).

OS / platform
- `basename(appDir)` (`identity.ts:30, 93`).

Effect platform layer
- `Context.Service` for the `Identity` tag (`identity.ts:39`).

External libs: none.

Other engine-resources
- `engine/network.ts:SuiNetwork` (type only).

### Service paths

Filesystem
- `existsSync(serviceDir)` + `mkdirSync(serviceDir, {recursive: true})`
  (`service-paths.ts:111-113`).

OS / platform
- `path.join` only.

Effect platform layer
- Requires `StateStoreConfig` service (`service-paths.ts:106`).

External libs: none.

Other engine-resources
- `engine/resolve-app-dir.ts:resolveAppDir` (`service-paths.ts:32`).
- `engine/state-store.ts:StateStoreConfig` (`service-paths.ts:33`).
- Inline check for local-like network instead of importing
  `isLocalLikeNetwork` (deliberate, `service-paths.ts:74-78`).

### Atomic write

Filesystem
- `fs.mkdir(dir, {recursive: true})` (`atomic-write.ts:27`).
- `fs.writeFile(tmp, body, options)` (`atomic-write.ts:33`).
- `fs.rename(tmp, target)` (`atomic-write.ts:34`).
- `fs.unlink(tmp)` on error (`atomic-write.ts:36`).
- `fs.readFile(target, 'utf-8')` for the `ifChanged` variant
  (`atomic-write.ts:53`).

OS / platform
- `crypto.randomBytes(6).toString('hex')` for tempfile suffix
  (`atomic-write.ts:30`).

Effect platform layer: none — pure `Promise`-based.

External libs: none.

Other engine-resources: none.

### Cache

Filesystem: none directly — delegates to `StateStore`.

OS/platform: none directly.

Effect platform layer
- Requires `StateStore` service (`cache.ts:121`).
- `Effect.annotateCurrentSpan` for cache outcome attributes
  (`cache.ts:129, 139, 143, 150`).
- `Effect.logInfo` for hit/miss/verify-fail logs (`cache.ts:140, 144,
  151`).
- `Option.isSome` for the get-result branch (`cache.ts:136`).

External libs: none.

Other engine-resources
- `engine/content-hash.ts:contentHash` (`cache.ts:14, 123`).
- `engine/state-store.ts:StateStore` (`cache.ts:15`).
- `engine/json-bigint.ts:jsonBigintReplacer` (`cache.ts:16`) — so
  bigint-valued inputs serialize losslessly into the cache key.

### Content hash

Filesystem: none.

OS / platform
- `crypto.createHash('sha256')` (`content-hash.ts:27, 57, 78`).

Effect platform layer: none.

External libs: none.

Other engine-resources: none.

### Safe env

Filesystem: none.

OS / platform
- `process.env` read-only (`safe-env.ts:37`).

Effect platform layer: none.

External libs: none.

Other engine-resources: none.

### Resolve app dir

Filesystem: none directly (callers stat against the return value).

OS / platform
- `process.env.DEVSTACK_APP_DIR`, `process.cwd()` (`resolve-app-dir.ts:15`).

Effect platform layer: none.

External libs: none.

Other engine-resources: none.

### Generic registry (`registry.ts` global, `define-registry.ts`)

`define-registry.ts`
- `Ref<ReadonlyArray<T>>` (`define-registry.ts:35`).
- `Context.Service` typing (`define-registry.ts:58`).
- `LayeredTag`, `TagIdentity` types from `advanced/tag.ts`
  (`define-registry.ts:18`).

`registry.ts` (global stack registry, on-disk at
`~/.devstack/registry.json`)
- Effect `FileSystem.FileSystem` (`registry.ts:39, 196`).
- `Schedule.recurs` for write retry (`registry.ts:229`).
- `engine/process-liveness.ts:isPidAlive` for classification
  (`registry.ts:40, 107`).
- `crypto.randomUUID().slice(0, 8)` for tempfile suffix
  (`registry.ts:217`).
- `fs/existsSync` (`registry.ts:36`) for the default `repoExists`
  passed to `classifyEntry`.

## Capabilities PRODUCED

What each sub-component exposes to plugin authors + the engine.

### State store

API
- `get<T>(key: string): Effect.Effect<Option.Option<T>>`. Returns
  in-memory snapshot — no disk hit. `state-store.ts:512-515`.
- `put<T>(key: string, value: T): Effect.Effect<void>`. Updates the
  Ref then writes the full map to disk via tempfile+rename. Failures
  collapse to a warning log (the Ref has already mutated). Carries
  span `StateStore.put` with attribute `state.key`. `state-store.ts:516-519`.
- `remove(key: string): Effect.Effect<void>`. Same write protocol as
  put. Span `StateStore.remove`. `state-store.ts:520-527`.

Namespaces
- Not native. The convention is that callers either use
  `StateStoreKeys.<x>(...)` (which baked-in slashes) or build their own
  prefix (e.g. `walrus/foo/...`). The state-store treats keys as opaque
  strings — collision avoidance is the caller's responsibility.
- The `StateStoreKeys` catalog enforces the prefix convention for
  the 13 first-class artifacts; new keys land there per the file
  header (`state-store-keys.ts:9`).

Schema enforcement
- Persisted shape `{version: 1, data: Record<string, unknown>}`.
- Higher `version` than `CURRENT_VERSION` raises a typed
  `StateStoreMigrationError`. Same-or-lower version proceeds (no
  migration applied — the on-disk shape is treated as already at
  current version once accepted).
- All other read errors (IO, malformed JSON, missing file) collapse
  to an empty map. `state-store.ts:407-461`.

Persistence guarantees
- Every `put` / `remove` writes the full map to disk via tempfile+
  rename. Atomic per POSIX rename semantics.
- Lock body persists across the supervisor's lifetime; cleared only
  if `instanceId` still matches at scope teardown.
- BigInt round-trips losslessly via `{__bigint: "<string>"}` shape
  (`json-bigint.ts`).

Errors
- `StateStoreLockedError` — competing live holder. Carries `path`,
  `holderPid`, optional `holderStartedAt`, multi-line `message`.
  `state-store.ts:73-81`.
- `StateStoreMigrationError` — `path`, `foundVersion`, `expectedVersion`,
  `message`. `state-store.ts:83-91`.

State store keys
- 13 typed builders: `publishMove`, `coinMint`, `walrusDeployOutput`,
  `walrusSeedWal`, `sealBlsKeypair`, `sealKeyServerId`, `deepbookPools`,
  `deepbookMarginPools`, `deepbookMarginSeed`, `deepbookBalanceManager`,
  `pythPackage`, `pythPusher`, `dockerOneShot`.
- Each takes a structured input object and returns the canonical
  string key. Snapshot-stable: changing a format invalidates every
  snapshot taken before the change.
  (`state-store-keys.ts:16-156`).

### Port allocator

API
- `allocate(preferred: number, {maxScan?: number = 100}): Effect.Effect<number, PortAllocatorError>`.
  Scans `[preferred, preferred + maxScan]` for the first port that's
  free both in-memory + cross-process + on `0.0.0.0` + on `127.0.0.1`.
- `release(port: number): Effect.Effect<void>`. Removes from held set
  and unlinks the cross-process lock file.
- `snapshot: Effect.Effect<ReadonlyArray<number>>`. Currently-held ports.

Cross-process semantics
- Per-port lock file at `<lockDir>/<port>.lock`. Lock body is
  `{pid, startedAt, host}` (no `instanceId` here —
  release-by-`(pid, startedAt, host)` equality is sufficient because
  port-lock paths are per-port and collisions are rare).
- Stale-pid reclaim via `tryClaimLockSync` → unlink + retry O_EXCL.
- A foreign-host body is treated as ALIVE (PIDs aren't comparable
  across hosts) — see `process-liveness.ts:85-87`.

Port range
- Caller-supplied. The base ports for services live at the service
  layer (e.g. devstack-router → 8082, dev → 5173, faucet → 9123),
  forwarded as `preferred`.

Errors
- `PortAllocatorError` — `preferred`, `message`. Raised when scan
  exhausted or probe failure. `port-allocator.ts:35-41`.

### Leasing

API
- `withExclusive<A, E, R>(address: string, work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>`.
  Acquires a per-address semaphore-of-1, runs `work`, releases on
  completion/failure/interrupt.

"Leased" lifetime
- Strictly scoped to the wrapping `work` call. The lease is held for
  the wall-clock duration of `work`, never persisted, never carries
  across fiber boundaries.
- Per-address `Semaphore`s live in a `Ref<Map<address, Semaphore>>`
  for the lifetime of the supervisor (`leasing.ts:36`); they aren't
  GC'd, but they're cheap.

### File locks

API (sync, exported from `file-lock.ts`)
- `tryClaimLockSync(lockPath, opts?: {withInstanceId?, withAcquiredAt?}): TryClaimResult`.
  Atomic O_EXCL create; on EEXIST inspects the existing holder for
  liveness and either reclaims (unlink+retry) or returns
  `{ok: false, holder}`.
- `releaseLockSync(lockPath, ownBody)`. Deletes only when the on-disk
  body's `instanceId` matches OR `ownBody.instanceId` is undefined and
  `(pid, startedAt, host)` match.
- `ownLockBody(opts?)`, `parseLockBody(raw)`, `serializeLockBody(body)`
  — body codec primitives.

Blocking vs non-blocking
- All sync, non-blocking. No retry loop in this module — callers
  (port-allocator, state-store) implement their own retry/backoff.
- The state-store layer is async and does its own jittered-backoff
  retry (`state-store.ts:307-365`) using Effect-platform FS.

Stale-lock detection
- Via `isHolderLive` (`process-liveness.ts:83-93`): cross-host bodies
  alive; same-host bodies use `process.kill(pid, 0)` + `ps -o lstart=`
  match.

### File watcher

API
- `watch(path: string): Stream.Stream<ChangeEvent, FileWatcherError, Scope.Scope>`.
  Recursive `fs.watch` wrapped in a `Stream.callback`. Each fs event
  becomes one `ChangeEvent` of shape `{kind: 'change'|'add'|'remove', path: string}`.
- `kind` mapping: fs.watch's `'change'` → `'change'`, fs.watch's
  `'rename'` → `'add'` (no add-vs-remove discrimination — downstream
  just cares "something changed"). `file-watcher.ts:69`.
- `path` is the fs.watch filename (relative to the watch root) when
  present, else the watch root itself (`file-watcher.ts:68`).

Debounce
- **NONE in this service.** Debounce lives at the supervisor layer
  (`Stream.debounce('250 millis')` in `supervisor.ts:868`).

Change attribution / predicate filters
- **NONE in this service.** Attribution + minimatch filter compilation
  live at supervisor layer (`compileWatchFilter`, `WatchOwner`,
  `formatRestartCascade`).
- See "Pain points" — the boundary between service-level emission
  and supervisor-level filtering is documented in the file header
  comment (`file-watcher.ts:9-12`).

Errors
- `FileWatcherError` — `path`, `message`, optional `cause` (defect).
  `file-watcher.ts:29-36`.
- A watcher that fails during construction emits the error through
  the stream's `Queue.failCauseUnsafe`. The supervisor catches and
  logs (`supervisor.ts:932-935`) so one path's failure can't tear
  down the whole stack.

### Identity

Derivation rules (`deriveAppName`)
- Read `<appDir>/package.json` (default appDir = `process.cwd()`).
- Take `name` field. If it contains `/`, take the last segment
  (npm-scope strip: `@foo/bar` → `bar`).
- Strip leading non-alphanumeric chars (e.g. `_template` → `template`).
- Fall back to `basename(appDir)`. Final fallback: `'devstack-app'`.
- `identity.ts:91-116`.

Validation rules (`validateIdentity`)
- Both `app` and `stack` must match `/^[a-z0-9][a-z0-9._-]{0,63}$/`.
- Rejects `..`, `/`, shell-meaningful characters at the boundary
  (prevents directory traversal and docker label injection).
- Throws `TypeError` immediately at construction time.
- `identity.ts:47-55, 61-64`.

Docker labels
- `DockerLabel.APP = 'devstack.app'`
- `DockerLabel.STACK = 'devstack.stack'`
- `DockerLabel.NETWORK = 'devstack.network'`
- `DockerLabel.ACTION = 'devstack.action'`
- These flow into `--label key=value` args and `--filter
  label=key=value` args on every devstack-managed container/network/
  volume. (`identity.ts:78-83`.)
- `devstack.router=true` is NOT a `DockerLabel` member — it's a
  router-specific singleton flag.

### Service paths

Directory layout
- `localnet` + `*-fork`: `<appDir>/.devstack/stacks/<stack>/runtime/<service>/...`
- live nets: `<appDir>/.devstack/networks/<network>/runtime/<service>/...`
- override (`DEVSTACK_STATE_DIR` env or `cfg.stateDir`):
  `${stateDir}/runtime/<service>/...`

API
- `servicePath(service: string, ...parts: string[]): Effect.Effect<string, never, StateStoreConfig>`.
  Validates the service name (`/^[a-z][a-z0-9-]{0,63}$/`),
  `mkdir -p`s the service subdirectory, returns absolute path.
- `runtimeRoot: Effect.Effect<string, never, StateStoreConfig>`.
  Returns the per-stack runtime root (called by the snapshot save/
  restore pipeline).
- `RUNTIME_DIR_NAME = 'runtime'` constant. Single knob for renaming;
  no string-literal `'runtime'` allowed elsewhere.
- `ExtraPathEntry = Schema.Struct({key, path})` for the snapshot
  manifest format.

Used by (`grep` confirms): account (`services/account.ts:991`,
`servicePath('accounts')`), seal (`services/seal/internal.ts:432, 708`,
`servicePath('seal')`), walrus (`services/walrus/internal.ts:334`,
`servicePath('walrus', name, 'deploy')`), wallet
(`services/wallet/internal.ts:144`, `servicePath('wallet', 'token')`).

### Atomic write

API
- `writeFileAtomic(target, body, options?: {mode?})`. Writes to a
  sibling tmp path with a random 6-byte hex suffix, then `rename(tmp,
  target)`. `mkdir -p`s the parent dir.
- `writeFileAtomicIfChanged(target, body, options?: {mode?}): Promise<boolean>`.
  Reads existing content; if it matches, returns `false` (no write).
  Otherwise writes atomically and returns `true`.

Guarantees
- POSIX rename atomicity → concurrent readers see either prior or new
  content, never half-written.
- Failed write cleans up the tmp file (`atomic-write.ts:35-37`).
- The `mode` parameter is only forwarded when explicitly set
  (`atomic-write.ts:33`); otherwise the OS umask applies.
- The "if changed" variant skips the disk hit on no-op, used by
  hot-path emitters (Vite manifest, traefik dynamic config) to avoid
  watcher thrash.

### Cache

API
- `withCache<T>(spec: CacheSpec<T, ...>): Effect.Effect<T, EInputs | EVerify | EProduce, RInputs | RVerify | RProduce | StateStore>`.
- `buildCacheKey({namespace, chainId, inputsHash}): string` —
  exported for instrumentation.

`CacheSpec`
- `namespace: string` — `'<service>/<artifact>'` convention.
- `chainId: string` — chain identifier; empty string opts into
  chain-independent keying.
- `inputs: Effect.Effect<Record<string, unknown>, EInputs, RInputs>` —
  per-primitive inputs. Caller is responsible for canonicalization
  (sorted keys, normalized bigints).
- `label?: string` — log-message label, defaults to `namespace`.
- `verify: (cached: T) => Effect.Effect<T | undefined, EVerify, RVerify>` —
  on-chain or on-disk re-validation. Return `undefined` to invalidate.
- `produce: Effect.Effect<T, EProduce, RProduce>` — produces a fresh
  value on miss / verify-fail.

Keying
- `${namespace}/${chainId}/${contentHash(JSON.stringify(inputs,
  jsonBigintReplacer), {length: 16})}` when chainId non-empty.
- `${namespace}/${contentHash(...)}` when chainId is `''`.
- `cache.ts:171-178`.

TTL / invalidation
- No TTL. Invalidation is **explicit-via-verify**: the cached value is
  re-validated against the chain (or filesystem) before being trusted.
- Eviction on verify-fail uses `state.remove(key)` (best-effort,
  `Effect.ignore`).

Span annotations
- `cache.namespace`, `cache.key` — always set.
- `cache.outcome ∈ {'hit', 'miss', 'verify-fail'}` — outcome of the
  cache lookup.

### Content hash

Algorithm
- SHA-256 (`createHash('sha256')`).
- Output: lowercase hex string.

Inputs accepted
- `string` — UTF-8 bytes.
- `Uint8Array` (including `Buffer`) — hashed verbatim.
- `object` — serialized via `JSON.stringify(input)` (no replacer,
  no key sort).

Stability guarantees
- Determinism: same bytes → same digest, every time.
- **No canonicalization.** `{x:1, y:2}` and `{y:2, x:1}` produce
  different digests; callers MUST canonicalize before hashing
  (`content-hash.ts:36-45`, test pins the non-canonicalization).

Length conventions
- `12` — content-addressed docker image tags.
- `16` — config-hash cache keys (deepbook pools, pyth feeds, fork
  meta).
- `24` — codegen bindings fingerprint.
- `64` — full digest (file content fingerprints; watcher dedup).

API
- `contentHash(input, {length?})`.
- `createContentHasher(): Hash` — streaming hasher.
- `digestHex(hasher, {length?}): string` — finalize streaming.
- `truncateDigest(hex, length): string`.

### Safe env

API
- `inheritedHostEnv(): Record<string, string>`.

Allowlist (redaction is "everything not on the list")
- `PATH`, `HOME`, `USER`, `SHELL`, `LANG`, `LC_ALL`, `TERM`, `TMPDIR`,
- `NODE_ENV`, `NODE_PATH`, `NODE_OPTIONS`, `PWD`, `OLDPWD`,
- Windows: `SystemRoot`, `APPDATA`, `LOCALAPPDATA`, `USERPROFILE`, `Path`,
- `DEVSTACK_STACK`.

Redaction format
- Disallowed keys: **simply omitted** from the returned map. No
  `undefined`, no placeholder, no log.
- Unset allowed keys are also omitted (no `undefined` values, since
  some platforms reject them in child-process spawn).
- (`safe-env.ts:34-43`.)

Consumers: `advanced/plugin-author/host-script.ts`,
`services/dev/internal.ts`, `engine/sui-cli.ts`.

### Resolve app dir

API
- `resolveAppDir(): string` — returns `process.env.DEVSTACK_APP_DIR ?? process.cwd()`.
- `APP_DIR_ENV = 'DEVSTACK_APP_DIR'` — env var name constant.

### Generic registry primitive

`define-registry.ts`
- `defineRegistry<I, T>(Tag): {Live, publish, require}` — boilerplate
  remover for "publish/subscribe registry" pattern. Each call returns:
  - `Live: Layer.Layer<I>` — wires up the append-only Ref store.
  - `publish(entry: T): Effect.Effect<void, never, I>`.
  - `require(tag: LayeredTag<...>): Effect.Effect<RegistryShape<T>, E, R | TagIdentity<Name> | I>` —
    yields the publishing tag (forcing its build) before resolving the
    registry, so the snapshot is non-empty by the time the consumer
    reads.

`RegistryShape<T>`
- `register: (entry: T) => Effect.Effect<void>` — append-only.
- `snapshot: Effect.Effect<ReadonlyArray<T>>` — current array. Consumer
  applies its own dedupe-by-name pass.

`registry.ts` (global stack registry — `~/.devstack/registry.json`)
- `read: Effect.Effect<RegistryFile>` — defensive parse.
- `upsert(input): Effect.Effect<void>` — read-modify-write, bounded retry.
- `clearPid(app, stack, network): Effect.Effect<void>` — drops `pid` field.
- `remove(app, stack, network): Effect.Effect<void>`.
- `classifyEntry(entry, options?): 'active' | 'dormant' | 'stale' | 'abandoned'` —
  pure classifier with injectable `now`, `repoExists`, `pidAlive`.

## Lifecycle

### Initialization

State store
- Built inside `defineDevstack` via `composeBootstrapLayer` →
  `buildBaseInfra` (`supervisor.ts:383-415`).
- Lifted into the **bootstrap layer** (not the user-stack layer) so
  the lock acquires BEFORE any docker work runs (`supervisor.ts:424-432`).
- Acquire steps:
  1. `mkdir -p` the directory (`state-store.ts:219`).
  2. `chmod 0o600` any pre-existing state file (best-effort, idempotent;
     `state-store.ts:224-229`).
  3. Lock acquisition loop (up to 20 attempts, jittered 50ms × 1.5^n
     × [0.5, 1.5]; `state-store.ts:307-365`).
  4. Load existing state from disk OR start empty
     (`state-store.ts:407-465`).

Port allocator
- Lives in `InfraLiveCore` (`supervisor.ts:344-368`, line 364).
- Pure in-process state at construction — empty held set Ref, no
  filesystem touch until `allocate()` is called.

Leasing
- `LeasingLive` lives in `InfraLiveCore` (`supervisor.ts:365`).
- Empty `Ref<Map<address, Semaphore>>` at construction. Semaphores
  are lazily created on first `withExclusive` call per address.

File lock
- No init — pure module-level helpers.

File watcher
- `FileWatcherLive` lives in both `InfraLiveCore` AND the bootstrap
  layer (`supervisor.ts:366, 475`). No state at construction —
  the underlying `fs.watch` call happens per `watch(path)` invocation.
- Watcher subscriptions are forked under
  `Effect.forkScoped(supervisor.ts:936-938)` so they live for the
  supervisor's scope and tear down with it.

Identity
- Built in `buildBaseInfra` (`supervisor.ts:408-414`) — synchronous
  derive + validate, no async.
- Validation runs at construction, BEFORE any docker label is built —
  malformed names fail loud at boot, not far downstream.

Service paths
- No init. Service directories are `mkdir -p`'d on first
  `servicePath('foo')` call.

Atomic write
- Stateless. Always available.

Cache
- Stateless. Uses `StateStore` and `contentHash` at call time.

Content hash
- Stateless.

Safe env
- Stateless.

Resolve app dir
- Stateless — reads `process.env` at every call.

Generic registry primitive
- `defineRegistry` returns a `Live: Layer<I>` that, when built,
  allocates one `Ref<ReadonlyArray<T>>` per layer.

### Cleanup

State store
- `Effect.addFinalizer` wrapped in `Effect.uninterruptible`
  (`state-store.ts:390-399`). Reads on-disk body; deletes the lock
  file only if `instanceId` matches.

Port allocator
- Finalizer drops every owned port lock on scope teardown
  (`port-allocator.ts:204-211`). Best-effort `releasePortLock` per
  held port. Errors are swallowed.

Leasing
- No finalizer. Per-address semaphores live to scope teardown; the
  supervisor's scope teardown collects them as ordinary refs.

File lock
- `releaseLockSync` is callers' responsibility. State-store +
  port-allocator install Effect finalizers that call it; sui-fork
  (out of scope, but uses the same primitive) does the same.

File watcher
- `Effect.addFinalizer` calling `watcher.close()` on stream scope
  teardown (`file-watcher.ts:124-133`). Try/catch absorbs
  already-closed watchers.

Identity, service paths, atomic write, cache, content hash, safe env,
resolve app dir, generic registry primitive
- No cleanup needed.

### Cross-process semantics

State store
- Path-scoped by `(stack, network)`. Two stacks on the same machine
  with different `(stack, network)` use distinct files and locks → no
  contention.
- Two processes against the SAME `(stack, network)` (e.g. two `pnpm
  dev` against the same stack) race for the O_EXCL lock; the loser
  fails with `StateStoreLockedError` and a multi-line recovery message
  (`state-store.ts:255-284`).
- Stale-lock recovery (dead pid → unlink + retry-O_EXCL) handles
  ungraceful shutdown of a previous supervisor
  (`state-store.ts:332-365`).
- Cross-host (NFS-shared `.devstack/`): foreign-host bodies are treated
  as alive (PID comparison is meaningless across hosts;
  `process-liveness.ts:85-87`).

Port allocator
- Host-wide rendezvous via `~/.devstack/ports/`. Two parallel
  supervisors (e.g. `DEVSTACK_STACK=test pnpm dev` and `DEVSTACK_STACK=alpha
  pnpm dev`) coordinate via the per-port `wx`-created lock files.
- Order of operations matters: in-process Ref CAS BEFORE the
  cross-process O_EXCL claim. Otherwise the in-process loser would
  unlink the in-process winner's file lock. (`port-allocator.ts:151-174`,
  test `S1` in `port-allocator.test.ts:397-444`.)
- Stale-pid reclaim mirrors state-store's: a dead holder's lock is
  unlinked and the O_EXCL retried.

Leasing
- **Single-process only.** Per-address semaphores live in this
  supervisor's memory. Two supervisors signing with the same address
  do NOT serialize against each other through `Leasing` — they must
  rely on the chain-level mechanism (gas object versioning,
  shared-object locking) or higher-level coordination.

File lock
- Generic primitive — cross-process via O_EXCL. Each consumer
  (port-allocator, state-store, sui-fork) chooses its own lock path
  shape.

File watcher
- Per-process. Two supervisors watching the same directory each get
  their own fs.watch handle.

Identity
- Identity is **per-supervisor**. Two stacks with the same `app` but
  different `(stack, network)` are distinct. The state-store lock
  files at distinct `(stack, network)` paths enforce that.

Service paths
- Path-scoped identically to state-store. Per-`(stack, network)`
  runtime root → no contention between parallel stacks.

Atomic write
- POSIX rename is atomic — concurrent readers see prior-or-new, never
  partial. Concurrent writers race on the rename; last-write-wins by
  POSIX.

Cache
- Layered on state-store. Cross-process semantics are inherited from
  the state-store lock + atomic-write protocol.

Content hash
- Pure / stateless. No coordination needed.

Safe env
- Stateless.

Resolve app dir
- Stateless.

Global registry (`~/.devstack/registry.json`)
- Cross-process via tempfile+rename and read-modify-write loop with
  bounded retries (`registry.ts:194, 229`). Last-write-wins by design;
  losing writers re-upsert on their next iteration
  (`registry.ts:22-25`).
- No host-wide exclusive lock. The window between read and write is
  small enough that the bounded retry + last-write-wins is
  acceptable for the registry's use case (doctor / prune don't need
  perfect read-time consistency).

## Hard requirements / invariants

The "MUST" list. Citations are file:line or test name.

State store

- **Atomic-write guarantee.** No torn writes on crash. Every put/remove
  writes to `${file}.tmp.${pid}.${time}.${rand}` then `rename(tmp,
  file)`. Tested at `state-store.test.ts:209-226` ("put writes via
  tempfile then rename (no direct write to state.json)").
- **Cross-process arbitration.** Lock body MUST carry `pid`, `host`,
  `instanceId`. Tested at `state-store.test.ts:267-293`.
- **O_EXCL is single source of truth.** No rename-then-readback in the
  stale-lock reclaim path — only one writer can win the kernel's
  create-new-file race (`state-store.ts:336-365`).
- **Schema-version safety.** Higher-than-current versions fail loudly
  with `StateStoreMigrationError`. Other read errors fall through to
  empty map. `state-store.ts:432-444`.
- **Finalizer-only delete.** Release MUST only delete the lock file
  when the on-disk `instanceId` still matches ours
  (`state-store.ts:392-398`).
- **Lock release survives interrupt.** Finalizer wrapped in
  `Effect.uninterruptible` so SIGINT/SIGTERM teardown can't leave the
  lock file behind (`state-store.ts:391`).
- **BigInt round-trip.** Bigint-valued state must survive persistence
  losslessly via the `{__bigint: "<string>"}` shape. `state-store.test.ts:250-265`
  pins the round-trip.
- **Tempfile uniqueness.** Multiple writes in the same process produce
  distinct tempfile names (`state-store.test.ts:228-248`).
- **Path precedence.** `DEVSTACK_STATE_DIR` > `cfg.stateDir` > network-
  aware default. `state-store.test.ts:173-189`.

Port allocator

- **No double-allocation across processes.** Per-port `wx`-created lock
  file is the host-wide source of truth. `port-allocator.test.ts:174-356`
  ("claimPortLock / releasePortLock — file lock").
- **Dual-host bind probe.** Both `0.0.0.0` AND `127.0.0.1` MUST be
  bindable; tested separately at `port-allocator.test.ts:76-119`.
- **In-process CAS BEFORE cross-process claim.** Loser of the
  in-process race must NOT touch the file lock.
  `port-allocator.test.ts:371-444` ("S1: concurrent allocate must not
  touch a sibling supervisor's file lock").
- **Stale-pid reclaim.** A lock file with a dead pid (or unparseable
  body, including the pre-Theme-6c bare-pid format) is reclaimable.
  `port-allocator.test.ts:217-254`.
- **Live-holder refuse.** A lock whose pid is alive must NOT be
  reclaimed. `port-allocator.test.ts:256-280`.
- **EACCES is "still alive."** A lock file we can't read (chmod 000,
  multi-user box) MUST NOT be treated as stale.
  `port-allocator.test.ts:298-320`.
- **Release ownership check.** A lock written by a different pid MUST
  NOT be deleted on `releasePortLock`. `port-allocator.test.ts:332-349`.
- **Release on missing is noop.** No throw on
  `releasePortLock`-missing-file. `port-allocator.test.ts:351-356`.

Leasing

- **Permit released on completion.** `leasing.test.ts:10-23`
  ("sequential calls on the same address compose without contention").
- **Permit released on failure.** `leasing.test.ts:129-142`
  ("failed fiber releases its permit").
- **Permit released on interrupt.** `leasing.test.ts:103-127`
  ("interrupted fiber releases its permit").
- **Different addresses don't serialize.** `leasing.test.ts:64-101`
  ("two fibers on DIFFERENT addresses run in parallel").
- **Same address serializes.** `leasing.test.ts:26-62`.

File lock

- **O_EXCL is the win signal.** `file-lock.ts:131-132` — `writeFileSync(...,
  {flag: 'wx'})`.
- **Cross-host bodies are alive.** `process-liveness.ts:85-87`.
- **Foreign pid + alive → refuse.** `file-lock.test.ts:80-88`.
- **Stale (dead pid) → reclaim.** `file-lock.test.ts:90-106`.
- **Pre-Theme-6c bare-pid body → reclaim.** `file-lock.test.ts:49-51`
  + `port-allocator.test.ts:240-254`.
- **Release only by ownership match.** `file-lock.test.ts:108-135`.
- **Release is idempotent.** `file-lock.test.ts:117-125`.
- **`parseLockBody` rejects malformed pids.** Including NaN, Infinity,
  negative, non-finite. `file-lock.test.ts:57-59`,
  `state-store.ts:188-190`.

Watcher

- **Every change reaches the dispatcher** as long as fs.watch fires
  it. The watcher subscribes BOTH `'change'` and `'rename'` event
  names to defend against platform-version variance
  (`file-watcher.ts:106-107`).
- **No events lost during boot.** `Stream.callback` queues events
  before the consumer attaches (queue-backed via `Queue.offerUnsafe`).
- **fs.watch failure on one path can't tear down the whole devstack.**
  Errors funnel through `FileWatcherError` and are caught at the
  supervisor watch-fiber boundary (`supervisor.ts:932-935`).
- **Recursive watch is best-effort on Linux** — silently degrades to
  non-recursive (documented in `file-watcher.ts:13-15`).

Identity

- **Uniqueness via `(app, stack, network)` triple.** Two devstacks
  with different network can't collide on docker labels / paths.
- **Name regex rejects shell-meaningful chars.**
  `/^[a-z0-9][a-z0-9._-]{0,63}$/` — no `..`, `/`, quotes, etc.
  (`identity.ts:47, 51-54`).
- **`deriveAppName` strips npm scopes.** `@foo/bar` → `bar`.
  `identity.ts:115`.
- **`deriveAppName` strips leading non-alphanumeric.** `_template` →
  `template`. `identity.ts:95-96`.
- **Final fallback never blank.** `'devstack-app'` if everything else
  fails. `identity.ts:96`.

Service paths

- **Service name regex.** `/^[a-z][a-z0-9-]{0,63}$/`
  (`service-paths.ts:48`).
- **Sub-parts NOT validated.** Caller can pass user-controlled names;
  the service slice is the only trusted segment.
- **Lazy mkdir-p.** Idempotent + race-tolerant
  (`service-paths.ts:111-113`).
- **Runtime root must match state-store path scoping.** Snapshot
  save/restore relies on this — see `RUNTIME_DIR_NAME` documentation
  (`service-paths.ts:35-46`).
- **Nothing importable from app code lives under `.devstack/`.**
  Codegen outputs land in user-controlled `opts.output`
  (`service-paths.ts:23-27`).

Atomic write

- **Tempfile suffix is random.** No two concurrent writers collide on
  the same tmp path (`atomic-write.ts:30-31`).
- **Parent dir is created.** `mkdir -p` is unconditional
  (`atomic-write.ts:27`).
- **Cleanup tmp on rename failure.** `atomic-write.ts:35-37`.
- **`ifChanged` doesn't touch disk on no-op.** `atomic-write.ts:51-59`.

Cache

- **Cache key determinism.** Same inputs → same key.
  `cache.test.ts:142-164`.
- **Cache key sensitivity.** Different inputs → different key.
  `cache.test.ts:142-164`.
- **chainId is part of the key.** Same inputs across two chains
  produce two distinct entries. `cache.test.ts:166-191`.
- **Empty chainId omits the slot.** `cache.test.ts:58-62`.
- **Hit + verify-success → no produce.** `cache.test.ts:85-109`.
- **Hit + verify-undefined → evict + produce.** `cache.test.ts:111-140`.
- **Verify carries `R` through to the consumer.** `cache.test.ts:193-228`.
- **Persistence failures must not crash callers.** `state.put` is
  wrapped in `Effect.ignore` (`cache.ts:155`); `state.remove` likewise
  (`cache.ts:148`).

Content hash

- **SHA-256 only.** No algorithm choice exposed.
- **Bytewise determinism.** Tested at `content-hash.test.ts:11-22`.
- **Truncation by char-slice from full hex.** `content-hash.test.ts:17-22`,
  matches `createHash(...).digest('hex').slice(0, N)` exactly
  (`content-hash.test.ts:53-58`).
- **No canonicalization on objects.** Tested at
  `content-hash.test.ts:36-44`.
- **Uint8Array passes through verbatim.** No UTF-8 round-trip.
  `content-hash.test.ts:24-28`.
- **Streaming = one-shot equivalent.** `content-hash.test.ts:62-70`.

Safe env

- **Disallowed keys are dropped.** Tested at `safe-env.test.ts:33-43`
  (covers `AWS_SECRET_ACCESS_KEY`, `MASTER_KEY`, `GITHUB_TOKEN`,
  user-defined vars).
- **Unset allowed keys are omitted.** No `undefined` values returned —
  some platforms reject them in spawn(`safe-env.test.ts:45-53`).
- **Cross-platform.** Windows-specific keys (USERPROFILE, APPDATA,
  LOCALAPPDATA) forwarded when set (`safe-env.test.ts:55-63`).

Resolve app dir

- **Env var wins over cwd.** `process.env.DEVSTACK_APP_DIR ?? process.cwd()`.
  Read fresh on each call.

Generic registry primitive

- **Append-only.** No `delete`/`update` API. Callers fold their own
  dedupe-by-name on `snapshot`.
- **`require(tag)` orders the publisher's build BEFORE the read.**
  `define-registry.ts:74-80`, tested in `registries.test.ts:26-46`.

## Failure modes

State store

- **Competing live holder.** Fails immediately with
  `StateStoreLockedError`; the multi-line message walks the user
  through Ctrl-C / `kill -TERM` / `rm <lock>`.
  `state-store.ts:255-284`.
- **Newer-than-current schema version.** Fails with
  `StateStoreMigrationError`; user must upgrade devstack or wipe.
  `state-store.ts:432-444`.
- **Corrupt or unparseable state.json.** Silently falls through to
  empty map. The migration-needed error is the only one that
  propagates (`state-store.ts:455-461`).
- **Disk full / read-only fs during persist.** Caught by
  `persistAndWarn` (`state-store.ts:504-506`); logged as warning, the
  in-memory Ref has already mutated.
- **Lock acquisition timeout (20 attempts exhausted).** Fails with
  `StateStoreLockedError` referencing the winner of the final read
  (`state-store.ts:367-370`).
- **Partial write of state.json.** Impossible by construction — rename
  is atomic per POSIX.

Port allocator

- **No free port in the scan window.** Fails with `PortAllocatorError`
  carrying `preferred` + a "No free port found in [N, N+maxScan]"
  message (`port-allocator.ts:176-181`).
- **Probe failure.** Treated as "port not free" (`port-allocator.ts:148`).
- **File-lock unreadable (EACCES).** Treated as a live holder (refuse
  to claim) — `file-lock.ts:144-151`.
- **Sibling supervisor crashes mid-claim.** The dead supervisor's
  finalizer didn't fire, so its lock file persists. The next
  supervisor's claim attempt detects the dead pid via `isHolderLive`
  and reclaims (`file-lock.ts:152-158`).
- **Two fibers in same process race.** In-process Ref CAS prevents
  double-allocation; loser scans forward (`port-allocator.ts:157-174`).

Leasing

- **Work fails.** Permit released; failure propagates to caller
  (`leasing.test.ts:129-142`).
- **Work interrupted.** Permit released; the interrupt propagates
  (`leasing.test.ts:103-127`).
- **Two fibers race to create the per-address semaphore.** Ref.modify
  atomic check-then-insert; the loser uses the winner's semaphore
  (`leasing.ts:42-52`).

File lock

- **EEXIST during O_EXCL create.** Inspect the holder; alive → refuse,
  dead → unlink+retry (`file-lock.ts:135-158`).
- **Read of lock body fails after EEXIST.** ENOENT → retry (holder
  vanished); other errors → refuse cautiously (`file-lock.ts:144-151`).
- **Unlink during reclaim fails with EACCES/EIO.** Refuse to claim
  (`file-lock.ts:174-177`).
- **Mismatched instanceId on release.** Lock file left in place
  (`file-lock.ts:198-205`).

File watcher

- **fs.watch fails to construct.** `FileWatcherError` raised through
  the stream's `Queue.failCauseUnsafe`
  (`file-watcher.ts:84-91, 109-119`).
- **Watcher emits an error event.** Same path — `FileWatcherError`
  with `cause` set (`file-watcher.ts:109-119`).
- **Watcher closed mid-stream.** `Effect.addFinalizer` catches the
  "already closed" failure (`file-watcher.ts:128-130`).
- **Linux recursive degrade.** Silent — events for sub-directories may
  not fire. Documented but not handled.

Identity

- **Invalid app or stack name.** `validateIdentity` throws `TypeError`
  synchronously at construction (`identity.ts:51-54`).
- **Missing or malformed `package.json`.** `deriveAppName` falls back
  to `basename(cwd)` then `'devstack-app'` (`identity.ts:101-115`).

Service paths

- **Invalid service name.** `requireValidServiceName` throws
  synchronously (`service-paths.ts:50-57`).
- **mkdir failure.** Propagates as an Effect defect — no caught
  fallback. `service-paths.ts:111-113`.

Atomic write

- **Disk full / permission denied.** Throws synchronously; tmp file
  is best-effort `unlink`'d (`atomic-write.ts:35-37`).
- **Parent dir can't be created.** Throws synchronously
  (`atomic-write.ts:27`).

Cache

- **Verify probe fails.** Caller is expected to wrap with
  `Effect.orElseSucceed(() => undefined)`; the cache treats undefined
  as invalidation.
- **Eviction state.remove fails.** Wrapped in `Effect.ignore`
  (`cache.ts:148`).
- **state.put fails.** Wrapped in `Effect.ignore`; the produced value
  still returns (`cache.ts:155`).
- **state.get fails.** Propagates — but the live `StateStore` doesn't
  return errors from `get` (in-memory Ref read).

Content hash

- **Object input with circular reference.** `JSON.stringify` throws;
  caller's responsibility to canonicalize input.

Safe env

- No failure mode — returns an empty record if nothing's set.

Resolve app dir

- No failure mode.

Generic registry primitive

- `register` cannot fail (Ref update).
- `require(tag)` propagates `tag`'s build failure (the publisher's
  errors flow through).

## Persistence model

### `.devstack/` directory tree

Under `<appDir>/`:

```
.devstack/
├── stacks/<stack>/                    # localnet + *-fork
│   ├── state.json                     # the state-store kv (mode 0600)
│   ├── state.json.lock                # exclusive lock body
│   ├── state.json.tmp.<pid>.<time>.<rand>   # transient — only during write
│   └── runtime/<service>/             # per-service state (snapshot tarred)
│       ├── walrus/...
│       ├── seal/...
│       ├── accounts/...
│       ├── wallet/...
│       └── ... (any servicePath()-registered service)
├── networks/<network>.json            # live nets (testnet/mainnet/devnet)
├── networks/<network>.lock            # ditto
└── networks/<network>/runtime/<service>/  # live-net runtime root
```

Override paths (when `DEVSTACK_STATE_DIR=/x` or `cfg.stateDir='/x'`):

```
/x/state.json
/x/state.json.lock
/x/runtime/<service>/...
```

Outside `<appDir>`:

```
~/.devstack/
├── registry.json                      # global stack registry (mode 0644)
└── ports/<port>.lock                  # per-port host-wide rendezvous
```

### Wipe semantics (what `devstack wipe` removes)

- The entire `.devstack/` tree (state.json + runtime/<service>/* +
  state.json.lock).
- The matching entry in `~/.devstack/registry.json` is removed via
  `Registry.remove`.
- Per-port locks at `~/.devstack/ports/<port>.lock` are released by
  the supervisor's finalizer if it's still running; otherwise they
  age out via the stale-pid recovery path on the next allocation.

### Survives restart

- `state.json` data — every cached publish-result, seal keypair,
  walrus deploy output, etc.
- `runtime/<service>/*` — every per-service file (seal master key,
  walrus deploy artifacts, wallet token, etc.).
- `~/.devstack/registry.json` — global view of stacks across
  invocations.

### Process-local only

- The `Ref<Map<string, unknown>>` in-memory state-store map.
- The `Ref<Set<number>>` in-memory held-port set.
- The `Ref<Map<address, Semaphore>>` leasing map.
- The `watchedFileHashes` content-hash cache in the supervisor (not
  technically engine-resources, but it's the watcher's dedupe cache).

### Cleared between cycles (hot-restart) but not across runs

- Leasing semaphore map is not in scope of a single stack scope; it
  lives on the bootstrap-level layer. Reset only on supervisor exit.
- Per-port held set: same; lives on the bootstrap-level layer.

## Modes & variants

| Sub-component | Modes | Notes |
|---------------|-------|-------|
| State store | local-like (`localnet` + `*-fork`) vs live-net | Path layout diverges (`stacks/<stack>` vs `networks/<network>`). Same code path. |
| State store path | env > cfg > default | Precedence pinned at `state-store.test.ts:173-189`. |
| Port allocator probe | `0.0.0.0` first, then `127.0.0.1` | MUST be sequential, not parallel (Linux 0.0.0.0 bind covers 127.0.0.1). `port-allocator.ts:119-128`. |
| File-lock body | with `instanceId` (state-store, sui-fork) vs without (port-allocator) | Opt-in via `tryClaimLockSync({withInstanceId})`. |
| File-lock body | with `acquiredAt` (state-store) vs without | Opt-in via `tryClaimLockSync({withAcquiredAt})`. |
| Atomic write | `writeFileAtomic` vs `writeFileAtomicIfChanged` | The latter no-ops on bytewise-equal content. |
| Content hash | one-shot vs streaming | `contentHash(input)` vs `createContentHasher()` + `.update()` + `digestHex()`. |
| Content hash output | length 12 / 16 / 24 / 64 | Convention only; the algorithm is the same SHA-256 every time. |
| Cache key | with chainId vs without | `chainId === ''` omits the slot. `cache.ts:171-178`. |
| FileWatcher backend | node `fs.watch` only | NO chokidar; the comment in `file-watcher.ts:13-15` lists chokidar as deferred. |
| File watcher kind mapping | `'change'` → `'change'`, `'rename'` → `'add'` | No add-vs-remove discrimination. `file-watcher.ts:69`. |
| Process liveness | POSIX (`ps -o lstart=`) vs Windows (`tasklist`) | PID-reuse defense limited on Windows. `process-liveness.ts:47-71`. |

## Test coverage

`engine/state-store.test.ts` (~324 LOC)
- `state-store path precedence`
  - `localnet uses .devstack/stacks/<stack>/state.json under cwd by default` — default routing for localnet.
  - `DEVSTACK_APP_DIR overrides cwd` — env-var app-dir takes effect.
  - `explicit stateDir overrides default path scoping` — `cfg.stateDir` wins over network-aware routing.
  - `live nets resolve to .devstack/networks/<network>.json` — live-net routing.
  - `DEVSTACK_STATE_DIR override wins over stack/network scoping` — env-var beats `cfg.stateDir`.
- `state-store atomic write`
  - `put writes via tempfile then rename (no direct write to state.json)` — atomic-write protocol.
  - `tempfile carries pid + entropy so concurrent writers do not collide` — uniqueness of tmp names.
  - `values round-trip across in-process get / put / remove` — happy-path + BigInt round-trip.
  - `lock body carries pid, host, instanceId — required for cross-process arbitration` — body shape pin.
  - `in-process serialization: a second StateStore acquired inside a held scope sees the lock` — wx-write proof + finalizer-removes-lock.

`engine/state-store-keys.test.ts` (~148 LOC)
- 13 `describe` blocks, each pinning the canonical key shape for one builder (`publishMove`, `coinMint` × 2 variants, `walrusDeployOutput`, `walrusSeedWal`, `sealBlsKeypair`, `sealKeyServerId`, `deepbookPools`, `deepbookMarginPools`, `deepbookMarginSeed`, `deepbookBalanceManager` × 2 variants, `pythPackage`, `pythPusher`, `dockerOneShot`).
- Each assertion pins the literal string format — a regression invalidates every prior snapshot + every cached entry against that key.

`engine/port-allocator.test.ts` (~446 LOC)
- `PortAllocator.allocate — dual-host probe`
  - `scans forward when a 127.0.0.1 listener already holds the preferred port` — 127.0.0.1 probe gates.
  - `scans forward when a 0.0.0.0 listener holds the preferred port` — wildcard probe gates.
  - `returns the preferred port when no external listener holds it` — happy path.
- `PortAllocator.release`
  - `release removes the port from the held set so a subsequent allocate returns it again` — release flips the in-memory bit.
- `claimPortLock / releasePortLock — file lock`
  - `claims a fresh port and writes our holder JSON to the lock file` — body shape on disk.
  - `rejects re-claiming our own port (idempotence is NOT a goal)` — self-pid liveness defeats double-claim.
  - `reclaims a stale lock written by a dead pid` — stale-pid recovery.
  - `reclaims a stale-format lock (pre-Theme-6c bare pid body)` — obsolete-format reclaim.
  - `refuses to reclaim a lock when the referenced pid is alive` — live-holder refuse.
  - `reclaims an unreadable / corrupt lock file by overwriting it` — malformed body reclaim.
  - `refuses to reclaim a lock file when readFileSync throws EACCES` — EACCES is "alive."
  - `release deletes a lock we wrote` — basic release.
  - `release leaves a lock written by a different pid untouched` — ownership check on release.
  - `release on a missing lock is a noop (no throw)` — idempotent release.
- `PortAllocator.allocate — in-process race guard`
  - `two concurrent allocates against the same preferred return distinct ports` — Ref.modify CAS works.
  - `S1: concurrent allocate must not touch a sibling supervisor's file lock` — order-of-operations invariant (in-process CAS before cross-process file lock).

`engine/leasing.test.ts` (~143 LOC)
- `Leasing.withExclusive`
  - `sequential calls on the same address compose without contention` — happy path.
  - `two fibers racing on the SAME address serialize` — mutual exclusion.
  - `two fibers on DIFFERENT addresses run in parallel` — per-address fairness.
  - `interrupted fiber releases its permit so the next acquirer proceeds` — interrupt safety.
  - `failed fiber releases its permit` — failure safety.

`engine/file-lock.test.ts` (~137 LOC)
- `file-lock — parse / serialize`
  - `round-trips a body without optional fields` — base codec.
  - `round-trips a body WITH instanceId + acquiredAt` — full codec.
  - `returns undefined for malformed JSON` — defensive parse.
  - `returns undefined for the pre-Theme-6c bare-pid format` — obsolete-schema rejection.
  - `returns undefined for a payload missing required fields` — strictness.
  - `rejects non-finite pid (NaN / Infinity)` — pid sanity.
- `file-lock — tryClaimLockSync / releaseLockSync`
  - `claims a fresh path` — happy path.
  - `refuses to claim when another live holder owns the path` — live-holder refuse (self-pid).
  - `reclaims a stale lock (dead PID, same host)` — stale recovery.
  - `release deletes the lock only when ownBody.instanceId matches` — ownership-on-release.
  - `release is idempotent — running on an already-released lock is a no-op` — idempotency.
  - `release with mismatched instanceId leaves the on-disk lock alone` — defensive release.

`engine/cache.test.ts` (~230 LOC)
- `buildCacheKey`
  - `includes chainId in the middle slot when non-empty` — key layout.
  - `omits chainId when empty (chain-independent caches)` — alt layout.
- `withCache`
  - `cache miss → produce + put + return` — miss path.
  - `cache hit + verify-success → no produce, no put` — hit path.
  - `cache hit + verify-undefined → evict + produce + put` — verify-fail invalidation.
  - `different inputs produce different cache keys` — key sensitivity.
  - `chainId is part of the cache key` — chainId in key.
  - `verify can read services from the runtime` — `R` flow-through.

`engine/content-hash.test.ts` (~96 LOC)
- `contentHash`
  - `hashes a string as UTF-8 bytes and returns the full hex digest by default` — base form.
  - `truncates to options.length chars` — length knob.
  - `hashes a Uint8Array verbatim (no UTF-8 round-trip)` — binary input.
  - `hashes an object via JSON.stringify` — object form.
  - `does NOT canonicalize object key order — caller is responsible` — non-canonicalization pinned.
  - `distinct inputs map to distinct digests (collision-resistance smoke)` — diff inputs diff outputs.
  - `matches the open-coded createHash(...).digest().slice(0, N) form` — equivalence with hand-rolled.
- `createContentHasher / digestHex`
  - `streams multiple .update(...) calls into a single digest` — streaming = one-shot.
  - `digestHex truncates via the same length knob as contentHash` — uniform knob.
  - `digestHex without length returns the full hex digest` — default 64.
- `truncateDigest`
  - `slices a hex digest to length chars` — primitive.

`engine/safe-env.test.ts` (~64 LOC)
- `inheritedHostEnv`
  - `forwards allowed POSIX entries when set` — base allowlist.
  - `strips disallowed entries (secrets must not leak)` — redaction.
  - `omits unset allowed entries instead of emitting undefined values` — no `undefined` slots.
  - `forwards Windows-specific entries (USERPROFILE, APPDATA) when set` — cross-platform allowlist.

`engine/registries.test.ts` (GENERIC parts only — service-specific bits are out of scope for this doc)
- `registries`
  - `publishEndpoint writes through to register` — `publish` wires through to `register`. Uses `EndpointRegistry` as an exemplar.
  - `requireEndpointRegistry(tag) yields the tag first, then resolves the registry` — `require(tag)` ordering.
  - `publishPackage works` — same shape for a different registry.
- (The remaining `engine hooks` block tests TUI/engine surface and is OUT OF SCOPE for engine-resources.)

`engine/registry.test.ts` (~237 LOC)
- `classifyEntry`
  - `returns active when pid is alive` — pid-alive → active.
  - `returns abandoned when repoPath is missing on disk` — repo-gone → abandoned.
  - `returns stale when lastSeen is older than 30 days and repo exists` — stale threshold.
  - `returns dormant when lastSeen is recent and repo exists` — recent-but-no-pid → dormant.
  - `returns dormant when lastSeen is unparseable but repo exists` — unparseable date → dormant.
- `registry I/O`
  - `read on a missing file returns an empty v1 registry` — initial state.
  - `upsert creates a fresh entry with firstSeen + lastSeen + pid` — insertion.
  - `upsert preserves firstSeen on subsequent writes` (live wall-clock) — firstSeen invariant.
  - `clearPid drops pid without changing lastSeen` — clean-shutdown hook.
  - `remove drops only the matching entry` — surgical remove.
  - `upserts to different (app, stack, network) coexist` — multi-key indep.
  - `atomic write — no partial state.json visible on rename failure` — tempfile+rename smoke.

## Pain points today

- **`FileWatcher` is too thin to be useful alone.** Every consumer wraps
  it with `compileWatchFilter` + debounce + content-hash dedup. The
  module's own doc-comment lists chokidar as "deferred" and points
  out that Linux recursive-watch silently degrades. The supervisor
  reimplements: minimatch filter compilation (`supervisor.ts:806-836`),
  250ms debounce (`supervisor.ts:868`), and a per-file content-hash
  cache (`supervisor.ts:537`). The combined effect is that
  `engine/file-watcher.ts` is more or less a curio — the real watcher
  logic lives in the supervisor.

- **Three lock implementations share 90% of their code.**
  `engine/file-lock.ts` (port-allocator + sui-fork sync caller),
  `engine/state-store.ts` (Effect retry loop), and
  `engine/sui-fork/file-lock.ts` (out of scope here). The file header
  of `file-lock.ts` itself flags the duplication (`file-lock.ts:1-24`).
  State-store keeps its own loop "for the jittered backoff" but only
  the loop differs — body codec, O_EXCL semantics, stale-pid recovery,
  and finalizer pattern are all reimplemented per-site.

- **`state-store.ts` and `service-paths.ts` duplicate the path-resolution
  logic.** Both inline the `DEVSTACK_STATE_DIR` env > `cfg.stateDir` >
  network-aware default branch (`state-store.ts:118-159`,
  `service-paths.ts:64-82`), and `service-paths.ts` even inlines its
  own `isLocalLikeNetwork` check instead of importing from
  `engine/network.ts` (`service-paths.ts:78`). The note at
  `service-paths.ts:60-62` says it "mirrors" state-store's logic — it
  literally copy-pastes the precedence.

- **`safe-env.ts` allowlist is a hardcoded ALL_CAPS array** with no
  config knob. The doc comment justifies the choice ("no business
  reaching third-party plugin scripts"), but a plugin author who wants
  to forward a custom env var has no path other than re-spawning with
  a hand-built env map (consumers in `host-script.ts`, `dev/internal.ts`,
  `sui-cli.ts` each merge `inheritedHostEnv()` with their own
  per-call additions).

- **`atomic-write.ts` and the state-store's tempfile+rename loop are
  separate code paths.** state-store uses Effect-platform
  `acquireUseRelease` with its own tempfile naming
  (`state-store.ts:482-498`); `atomic-write.ts` is a freestanding
  Promise helper. Both implement the same protocol but the surface
  area differs (`atomic-write.ts` supports an `ifChanged` variant
  that state-store doesn't use).

- **Cache spec is invasive at the callsite.** Every primitive defines
  a 6-field `CacheSpec` inline; `namespace` and `chainId` are
  effectively free strings, and the test suite has to pin literal key
  shapes (`cache.test.ts:142-191`) to catch typos. The `produce` /
  `verify` / `inputs` fields all carry their own R/E parameters, which
  inflates the consumer's effect signature in a way that's hard to
  read.

- **`StateStoreKeys` is the only canonical key catalog but it lives
  outside the modules that consume it.** Each service that uses
  `StateStoreKeys.<x>` must import from `engine/state-store-keys.ts`;
  the per-service registry classes (e.g. `SuiStateRegistry`) layer on
  top but don't enforce that callers go through the catalog. The
  comment at `state-store-keys.ts:9` says "New keys land here, never
  at the callsite" — there's no static enforcement of that.

- **Identity validation throws synchronously** at construction
  (`identity.ts:51-54`). Means the supervisor's error reporting is
  late — the throw escapes the Layer build and surfaces as a fatal
  `Layer.build` abort, not a TUI red entry.

- **No per-port lock TTL.** Stale-pid recovery handles dead supervisors,
  but a long-running supervisor on a different host accumulates lock
  files on a shared NFS mount that the cross-host check refuses to
  reclaim (foreign-host bodies are "alive" by definition;
  `process-liveness.ts:85-87`).

- **`releasePortLock` re-reads the lock file** to learn its own body
  rather than caching the holder body at allocation time
  (`port-allocator.ts:102-116`). Adds an extra read on every release.
  The comment justifies it ("the port allocator doesn't keep a
  per-port body cache") but the cost is real.

- **`servicePath` requires `StateStoreConfig`** as an Effect
  dependency. Consumers must thread it through their layer graph
  even if they only want a deterministic path string. There's no
  pure variant for compose-time path planning.

- **`displayPath` lives in `engine/display-path.ts` but is consumed
  only by `services/codegen.ts`** (single user). The doc-comment
  argues for relativizing paths in TUI output, but the file isn't
  imported by anything that touches engine-resources today. The task
  prompt flags "include if used by these components; otherwise mark
  it observability's concern" — by usage it's neither, it's
  codegen's concern.

## Open questions

- **OPEN QUESTION: Is the global `~/.devstack/registry.json` registry
  considered engine-resources?** It uses the file-watcher-style
  tempfile+rename + read-modify-write protocol that's a sibling of the
  state-store. The task scope lists "publish/subscribe registry
  pattern" but the global registry isn't a pub/sub pattern — it's a
  cross-process discovery file. The doc treats it as in-scope (under
  generic registry primitive) but the boundary is fuzzy.

- **OPEN QUESTION: What's the relationship between `safe-env.ts` and
  `inheritedHostEnv()` consumers' override semantics?** Each consumer
  does `{...inheritedHostEnv(), ...localEnv}` — `localEnv` wins on
  conflict. There's no shared "extend the allowlist for this
  primitive" API.

- **OPEN QUESTION: Does the port allocator's `maxScan: 100` default
  reflect a hard requirement?** No test pins the value; the only
  evidence is the function signature default at
  `port-allocator.ts:141`. The error message exposes the range
  `[preferred, preferred + maxScan]` so any caller that needs a wider
  scan has to pass it explicitly.

- **OPEN QUESTION: Is `displayPath` engine-resources?** It's in the
  `engine/` directory but not used by any in-scope module. Its only
  consumer is `services/codegen.ts`. The task prompt says to include
  it "if used by these components; otherwise mark it observability's
  concern" — neither holds. I'm marking it neither.

- **OPEN QUESTION: Does the global registry's "last-write-wins"
  acceptance hold under high concurrency?** The doc comment at
  `registry.ts:22-25` argues "the losing supervisor will re-upsert
  itself on the next iteration of its own loop" but doesn't link to
  the loop; if a supervisor only upserts at boot + shutdown, a lost
  boot write means the entry is absent until next boot.

- **OPEN QUESTION: Are state-store lock files supposed to be
  cleared on `devstack wipe`?** The wipe semantics section above
  assumes they are (since `.devstack/` is fully removed) but I
  haven't verified the wipe command's exact path enumeration.

- **OPEN QUESTION: What's the contract for content-hash on `Uint8Array`
  subclasses (e.g. `Buffer`)?** The code uses
  `input instanceof Uint8Array` (`content-hash.ts:60`), which Buffer
  satisfies, but the test only covers `new Uint8Array(...)`. Whether
  a SubarrayView passes through verbatim is not pinned.

- **OPEN QUESTION: What's the behavior when `DEVSTACK_NETWORK`
  resolves to a fork variant via env-var but `StateStoreConfig`
  carries the base network?** The CLI's `--network` flag is narrower
  than the env var; the resolution at
  `engine/network.ts:80-94` allows fork variants from env, but the
  downstream config could carry a different value. Whether this
  produces a runtime mismatch isn't pinned by tests.

- **OPEN QUESTION: Should the supervisor's per-file content-hash
  cache (`watchedFileHashes` at `supervisor.ts:537`) live in
  engine-resources?** It's logically part of the file-watcher's
  dedup discipline but lives in the supervisor. Per the task scope
  ("supervisor → engine-core") it's out of scope here, but the file
  watcher's API is incomplete without that dedup, so it's a doc-
  boundary thing.

- **OPEN QUESTION: What's the contract for an unparseable
  `package.json#name`?** `deriveAppName` falls back to
  `basename(appDir)`, but what if `basename(appDir)` itself violates
  the identity name regex (e.g. cwd is `/Users/_Foo Bar/`)? Today the
  fallback `'devstack-app'` is only reached when *both* package.json
  and basename produce empty strings — a basename like `_Foo Bar`
  would survive `deriveAppName` (it strips leading non-alphanumeric
  → `Foo Bar`) but then `validateIdentity` rejects the space. Whether
  that flow is tested is unclear.

- **OPEN QUESTION: Why does the state-store keep its own retry loop
  on Effect-platform FS instead of folding into `file-lock.ts`?** The
  file header at `file-lock.ts:21-24` says "its retry semantics
  aren't a fit for sync `fs`," but `Effect.sleep` is available on
  Effect-platform FS too — the retry loop COULD live in a shared
  Effect-based variant. The trade-off isn't documented.

## Opportunities noticed

- **Unify the three lock implementations.** `engine/file-lock.ts`,
  the retry loop in `engine/state-store.ts:307-365`, and the sui-fork
  variant share 90% of their code. A single `file-lock` module
  exposing both sync (`tryClaimLockSync`) and Effect (`tryClaimLock`)
  variants with a configurable jittered-backoff retry would collapse
  three sites into one. The file-lock.ts header explicitly flags this
  as the next consolidation (`file-lock.ts:1-24`).

- **Push path resolution into one helper.** `state-store.ts:118-159`
  and `service-paths.ts:64-82` are byte-near-identical. A shared
  `resolveStackStatePaths(cfg)` returning `{stateDir, runtimeDir,
  stateFile, lockFile}` would let both modules and snapshot
  (`engine/snapshot.ts:230-248`) share the precedence rules.

- **Fold `engine/atomic-write.ts` and state-store's tempfile+rename
  into one module.** Both implement the same protocol with slightly
  different APIs. A unified `atomicWriteEffect(target, body, mode?)`
  Effect operator would consolidate.

- **`FileWatcher` should absorb debounce + minimatch filter + content-
  hash dedup.** The supervisor reimplements all three on top of the
  raw stream — the "thin service emits raw events" boundary
  documented in `file-watcher.ts:9-12` is exactly the seam that
  forces every consumer to reproduce the filtering. A `FileWatcher
  .watchFiltered(opts)` API taking gitignore-style patterns +
  debounce window would absorb most of `supervisor.ts:806-939`.

- **`displayPath` is misplaced.** Lives in `engine/` but only
  `services/codegen.ts` consumes it. Either move to
  `services/codegen/display-path.ts` or generalize it to a TUI
  helper. The current location implies it's an engine-resource but it
  doesn't touch state-store, ports, paths, identity, atomic writes,
  cache, content hash, safe env, or app-dir resolution.

- **`StateStoreKeys` should be enforced.** Today it's "convention" —
  any callsite can build its own key string. A typed wrapper
  (`store.put(StateStoreKeys.publishMove(...), value)` becomes
  `store.put(typedKey, value)` with `typedKey` of an opaque branded
  type) would prevent typos and let the catalog grow without bare-
  string drift. See `state-store-keys.ts:9` for the unenforceable
  convention.

- **Generic registry primitive should subsume per-service registries.**
  `defineRegistry` already exists; the per-service registries in
  `registries.ts` (out of scope per task brief) hand-roll the
  Live/publish/require triple in many places. A grep for
  `defineRegistry` would tell how much remaining boilerplate could
  be collapsed (this lives outside engine-resources scope, but worth
  flagging because the primitive is here).

- **`releasePortLock` re-reads the file to recover its own body.**
  An allocator-side cache of `{port → ownBody}` at allocation time
  would let release match by `instanceId` directly (matches the
  state-store's `acquiredBody` capture at `state-store.ts:374`).

- **`safe-env.ts` allowlist should be configurable per primitive.**
  Today's allowlist is universal. A `Layer.succeed(SafeEnvConfig,
  {extraAllowedKeys: [...]})` pattern would let a plugin that needs
  to forward `STRIPE_API_KEY` to its child process opt in explicitly
  without the engine-resources allowlist permanently widening for
  every other consumer.

- **`servicePath` requires `StateStoreConfig` even for
  read-only path planning.** A pure
  `computeServicePath(cfg, service, ...parts): string` would let
  build-time / compose-time consumers avoid the Effect dance entirely.

- **`engine/network.ts` is imported only as types from
  `engine/state-store.ts` and `engine/service-paths.ts`, but the
  latter inlines its `isLocalLikeNetwork` check.** Either import the
  function (matches state-store) or move the helper into the network
  module's set of constants. The inline check is justified as
  "avoiding a runtime dep edge" — it's only a type import edge
  anyway.

- **Cache spec's `verify` carrying the eviction sentinel `undefined`**
  is awkward — TypeScript can't statically distinguish "cache is
  invalid" from "T is `undefined`." A `Result<T> = {valid: true, value:
  T} | {valid: false}` discriminator would be clearer.

- **`state-store.ts` swallowing read errors silently** (line 458-460:
  "all other read errors collapse to an empty map") makes corrupt
  caches invisible. A best-effort warning log on each swallowed
  error would surface the corruption without blocking boot.

- **`file-lock.ts:reclaimSync` errors lose detail.** Returns
  `{ok: false, holder: priorHolder}` without distinguishing "couldn't
  unlink" from "couldn't write." Diagnosing a wedged port allocator
  becomes "trust the comment and look at strace."

- **`identity.ts` validates app + stack but not network.** The network
  flows through the same paths (docker labels, filesystem paths) and
  arrives via `resolveNetwork()` which validates against
  `ENV_RESOLVABLE_NETWORKS` (`engine/network.ts:84-93`), so it's
  validated upstream — but `Identity` doesn't re-validate, which is a
  silent assumption that the supervisor's flow is the only way an
  Identity gets built.
