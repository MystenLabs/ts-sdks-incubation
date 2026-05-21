# 02 Engine Resources (distilled)

## Purpose

Engine-resources is the substrate layer of devstack: the small, composable kernel-level capabilities
that the engine and every plugin lean on. It owns disk-backed key/value persistence, inter-stack
coordination (port allocation, cross-process file locks, per-signer leases), filesystem observation,
per-stack identity that flows into docker labels and on-disk paths, the canonical
`.devstack/<identity>/runtime/<service>/` layout, atomic file writes, content-addressed caching,
SHA-256 hashing, env-var redaction for child processes, the app-directory resolver, and a generic
publish/subscribe registry primitive plus a global on-disk stack registry. None of these own
service-specific logic — they are the kernel pieces every service composes against.

## Subsystems overview

- **State store** — disk-backed kv with cross-process lock; the durable substrate for everything
  that survives restart.
- **State-store keys** — typed catalog of canonical key strings for first-class cached artifacts.
- **Port allocator** — host-wide port reservation with in-process + cross-process + dual-host
  coordination.
- **File lock** — sync O_EXCL primitive with PID-aware stale recovery, shared by
  allocator/state-store/sui-fork.
- **Leasing** — in-process per-address semaphore-of-1 for serializing signer use.
- **File watcher** — thin recursive `fs.watch` wrapper emitting a normalized change stream.
- **Identity** — `(app, stack, network)` triple that flows into docker labels and filesystem paths.
- **Service paths** — canonical `.devstack/<identity>/runtime/<service>/` layout, lazily created.
- **Atomic write** — tempfile+rename helper with `ifChanged` variant for hot-path emitters.
- **Cache** — produce-once / verify-on-hit discipline keyed by content-hash, layered on state store.
- **Content hash** — SHA-256 primitive used by cache keys, docker image tags, codegen fingerprints,
  watcher dedup.
- **Safe env** — allowlist-based redactor for env vars passed to child processes.
- **Resolve app dir** — single source of truth for "where is the user's app rooted."
- **Generic registry primitive** — boilerplate-remover for the publish/subscribe Ref pattern.
- **Global stack registry** — cross-invocation `~/.devstack/registry.json` for stack discovery +
  lifecycle classification.

---

### State store

- **Responsibilities.** Provide a durable, cross-process-safe kv store scoped per
  `(stack, network)`. Hold a mandatory exclusive lock for the supervisor's lifetime so two devstacks
  can't fight over the same identity. Persist arbitrary plugin state (including bigints) across
  restarts.
- **Lifecycle.** Built in the bootstrap layer BEFORE any docker work. Acquire steps: mkdir parent,
  best-effort chmod existing file to 0600, retry-loop O_EXCL lock acquisition with jittered backoff
  and stale-PID reclaim, load existing payload or start empty. Cleanup: uninterruptible finalizer
  that deletes the lock file only if our `instanceId` is still on disk.
- **Inputs / dependencies.** Identity (stack, network), optional explicit state-dir override,
  app-dir resolver, network classifier (local-like vs live), process-liveness helper, host-name +
  PID + random UUID, bigint-safe JSON codec, Effect-platform FileSystem.
- **Outputs / capabilities provided.** Get (in-memory snapshot, no disk hit), put, remove — all
  keyed by opaque strings. Lock acquisition + release. Multi-line user-facing recovery message when
  a competing live holder is detected. Two typed errors: locked-by-other, and
  schema-version-too-new.
- **Invariants.**
  - Every mutation goes to disk via tempfile+rename — no torn writes possible.
  - Lock body must carry pid + host + instanceId; release deletes only on instanceId match.
  - Lock release survives interrupt (uninterruptible finalizer) so SIGINT can't leak locks.
  - Higher schema version than current fails loudly; all other read errors collapse to empty map.
  - Bigints round-trip losslessly via `{__bigint: "<string>"}` shape.
  - Tempfile names are per-write unique (pid + time + entropy).
  - Path precedence: `DEVSTACK_STATE_DIR` env > config `stateDir` > network-aware default.
  - Local-like networks (`localnet`, `*-fork`) route to `.devstack/stacks/<stack>/`; live nets to
    `.devstack/networks/<network>/`.
- **Known issues / edge cases.** Cross-host (NFS) bodies are treated as alive by definition — stale
  locks accumulate on shared mounts. All non-migration read errors are swallowed silently, so
  corrupt caches are invisible. Retry loop on Effect-platform FS is its own code path, not shared
  with the sync file-lock primitive.

### State-store keys

- **Responsibilities.** Provide typed builders for the canonical key strings of the 13 first-class
  artifacts (publishMove, coinMint, walrusDeployOutput, walrusSeedWal, sealBlsKeypair,
  sealKeyServerId, deepbookPools, deepbookMarginPools, deepbookMarginSeed, deepbookBalanceManager,
  pythPackage, pythPusher, dockerOneShot).
- **Lifecycle.** Stateless. Pure functions.
- **Inputs / dependencies.** None.
- **Outputs / capabilities provided.** Canonical string keys for each artifact, taking a structured
  input object.
- **Invariants.** Snapshot-stable: changing any builder's format invalidates every prior snapshot
  and every cached entry. New artifact keys should land in this catalog, not at the callsite.
- **Known issues / edge cases.** Convention-only — no static enforcement that callers route through
  this catalog. Bare-string keys at callsites would silently bypass it.

### Port allocator

- **Responsibilities.** Reserve a host-wide port for a service, scanning forward from a preferred
  port. Coordinate against sibling supervisors on the same host via per-port lock files. Verify the
  port is bindable on both `0.0.0.0` and `127.0.0.1` before returning it.
- **Lifecycle.** Pure in-process state at construction (empty held-set). Lock files at
  `<lockDir>/<port>.lock` (default `~/.devstack/ports/`, overridable via env). Finalizer drops every
  owned lock on supervisor scope teardown.
- **Inputs / dependencies.** Caller-supplied preferred port and max-scan window. File-lock
  primitive. PID + hostname + start-time for ownership body. Network bind probe via Node net.
- **Outputs / capabilities provided.** Allocate, release, snapshot of held ports. A typed error when
  the scan window is exhausted.
- **Invariants.**
  - Three-step claim ordering MUST be: in-process Ref CAS → cross-process O_EXCL → dual-host bind
    probe. Losing the in-process race must not touch the file lock.
  - Probe is sequential `0.0.0.0` then `127.0.0.1` — on Linux a wildcard bind covers loopback so the
    two cannot be parallel.
  - Stale-PID reclaim: dead holder PIDs unlock; alive PIDs refuse.
  - Foreign-host bodies are treated as alive (PIDs aren't comparable across hosts).
  - Unreadable lock file (EACCES) is treated as alive — refuse to claim.
  - Release only deletes a lock our PID owns; missing-file release is a no-op.
- **Known issues / edge cases.** No per-lock TTL — stale locks on shared NFS that originate from
  another host never reclaim. Release re-reads the lock file to recover its own body rather than
  caching it at claim time (extra read per release). No test pins the default scan window.

### File lock

- **Responsibilities.** Shared sync primitive for cross-process exclusive ownership of an arbitrary
  file path. Encodes a lock body, atomically claims via O_EXCL create, inspects an existing holder
  for liveness, reclaims dead holders.
- **Lifecycle.** No init — pure module-level helpers. Callers install their own finalizers to
  release.
- **Inputs / dependencies.** Lock path. Optional body shape opts (with/without `instanceId`,
  with/without `acquiredAt`). Process-liveness helper. PID, hostname, random UUID, bare Node `fs`
  sync APIs.
- **Outputs / capabilities provided.** Try-claim (success or holder-detected), release
  (ownership-checked), body codec (parse + serialize + own-body construct).
- **Invariants.**
  - O_EXCL create is the only "win" signal — no rename-then-readback.
  - Foreign-host bodies are alive by definition.
  - Same-host bodies use PID liveness probe + process start-time match (defends against PID reuse on
    POSIX; Windows defense is weaker).
  - Stale (dead PID) reclaim via unlink + retry O_EXCL.
  - Release is idempotent (missing file is fine) and ownership-checked (mismatched body left alone).
  - `parseLockBody` must reject malformed PIDs (NaN, Infinity, negative, non-finite, pre-format
    bare-int payloads).
- **Known issues / edge cases.** Three lock implementations share ~90% of their code (this module,
  state-store's Effect retry loop, sui-fork's variant) — the module header itself flags the
  duplication. Reclaim errors lose detail — caller can't distinguish "unlink failed" from "write
  failed."

### Leasing

- **Responsibilities.** Serialize work that touches a particular signer address within one
  supervisor process. Different addresses run in parallel; the same address serializes.
- **Lifecycle.** In-memory only. Empty map at construction; per-address semaphores lazily created on
  first use. No finalizer — map lives on the bootstrap layer's scope.
- **Inputs / dependencies.** Effect Semaphore + Ref. Address string.
- **Outputs / capabilities provided.** A wrapper that runs an Effect under an exclusive permit,
  releasing on success, failure, or interrupt.
- **Invariants.**
  - Permit released on completion, failure, AND interrupt.
  - Two fibers on the same address serialize; two on different addresses run in parallel.
  - Two fibers racing to create the per-address semaphore are atomically resolved via Ref.modify
    (loser uses winner's semaphore).
- **Known issues / edge cases.** **Single-process only.** Two supervisors signing with the same
  address don't coordinate through this — they rely on chain-level mechanisms (gas object
  versioning, shared-object locking). Semaphores aren't GC'd within a supervisor lifetime.

### File watcher

- **Responsibilities.** Wrap recursive Node `fs.watch` and emit a normalized stream of
  `{kind, path}` events. Subscribe both `'change'` and `'rename'` event types to defend against
  platform-version variance.
- **Lifecycle.** No state at construction. `fs.watch` is invoked per watch call. Watcher is closed
  by a stream-scope finalizer on teardown (try/catch absorbs already-closed).
- **Inputs / dependencies.** Path to watch. Bare Node `fs.watch`. Effect Stream/Queue.
- **Outputs / capabilities provided.** A stream of change events with a single normalized `kind`
  discriminator. A typed error type for construction/event failures.
- **Invariants.**
  - Both `'change'` and `'rename'` event names subscribed to handle Node version differences.
  - `Stream.callback` queue absorbs events emitted before the consumer attaches — no events lost
    during boot.
  - A failed watcher on one path does NOT tear down the supervisor — errors funnel through the
    stream and the caller catches at its boundary.
  - `'rename'` maps to `'add'` (no add-vs-remove discrimination).
- **Known issues / edge cases.** Linux recursive watch silently degrades to non-recursive —
  sub-directory changes may be missed. The module is intentionally thin: debounce, gitignore-style
  filtering, and content-hash dedup all live in the supervisor layer, leaving every consumer to
  reinvent them. No chokidar (deferred until reported as needed).

### Identity

- **Responsibilities.** Carry the `(app, stack, network)` triple that uniquely names a devstack.
  Derive a default app name from `package.json`. Validate names so they survive docker labels and
  path joins. Expose the canonical docker label keys.
- **Lifecycle.** Synchronous derive + validate at construction in the bootstrap layer, before any
  docker label is built.
- **Inputs / dependencies.** Optional app-directory path. App's `package.json#name` (read with
  `readFileSync`). Network identifier (type-only dep on the network enum).
- **Outputs / capabilities provided.** The validated identity triple. The set of docker label keys
  (`devstack.app`, `devstack.stack`, `devstack.network`, `devstack.action`).
- **Invariants.**
  - Uniqueness keyed by the full triple — different network can't collide on labels or paths.
  - Names must match a restrictive lowercase-alphanum regex (no `..`, `/`, quotes, spaces,
    shell-meaningful chars).
  - Derivation strips npm scopes (`@foo/bar` → `bar`) and leading non-alphanumerics (`_template` →
    `template`).
  - Final fallback for app name is never blank.
- **Known issues / edge cases.** Validation throws synchronously at Layer build time — the error
  surfaces as a fatal `Layer.build` abort, not a friendly TUI red entry. `Identity` validates `app`
  and `stack` but not `network` — it trusts upstream resolution. A `cwd` basename like `_Foo Bar`
  could survive `deriveAppName`'s strip rules but then trip `validateIdentity` on the embedded
  space.

### Service paths

- **Responsibilities.** Provide the canonical `.devstack/<identity>/runtime/<service>/...` directory
  layout. Validate service-name segments. Lazily create per-service subdirectories on first access.
  Expose the runtime root for snapshot save/restore.
- **Lifecycle.** No init. Service directories `mkdir -p`'d on demand.
- **Inputs / dependencies.** State-store config (stack, network, optional stateDir override).
  App-dir resolver. The `RUNTIME_DIR_NAME` constant.
- **Outputs / capabilities provided.** Absolute per-service path. Runtime-root path. The runtime-dir
  name as a single rename knob.
- **Invariants.**
  - Service name matches a stricter regex than identity names (`/^[a-z][a-z0-9-]{0,63}$/`).
  - Sub-parts (anything after the service segment) are NOT validated — only the service slice is
    trusted.
  - Runtime root path scoping must match state-store's path scoping exactly (snapshot save/restore
    depends on this).
  - Lazy mkdir is idempotent and race-tolerant.
  - Nothing under `.devstack/` is importable from app code (codegen outputs land in user-controlled
    paths instead).
  - Same path precedence as state-store: env override > config override > network-aware default.
- **Known issues / edge cases.** Requires `StateStoreConfig` as an Effect dependency even for
  compose-time path planning — no pure variant. The path-resolution logic byte-near-duplicates
  state-store's, and it inlines its own `isLocalLikeNetwork` check instead of importing the network
  module's. The mkdir surface is sync (not Effect FS), so a mkdir failure propagates as an Effect
  defect with no caught fallback.

### Atomic write

- **Responsibilities.** Write a file via tempfile+rename so concurrent readers never see a
  half-written file. Provide an `ifChanged` variant that no-ops on byte-equal content (to avoid
  watcher thrash for hot-path emitters like Vite manifest or traefik dynamic config).
- **Lifecycle.** Stateless Promise-based helper.
- **Inputs / dependencies.** Target path, body bytes, optional file mode. Random bytes for tempfile
  suffix. Bare Node `fs` async APIs.
- **Outputs / capabilities provided.** Plain write, write-if-changed (returns whether a write
  happened).
- **Invariants.**
  - Random hex tempfile suffix so concurrent writers don't collide on the same tmp path.
  - Parent dir always created (mkdir-p) before write.
  - Failed write cleans up the tmp file best-effort.
  - `ifChanged` reads existing content and skips the write entirely on equality (no disk hit).
  - `mode` only forwarded when explicitly set — otherwise OS umask applies.
- **Known issues / edge cases.** State-store implements the same protocol with a separate code path
  (Effect-based, different tempfile naming, no `ifChanged` variant) — the two are not unified.

### Cache

- **Responsibilities.** Produce-once / verify-on-hit discipline layered on the state store.
  Re-validate cached values against the chain (or filesystem) before trusting them; evict + produce
  on verify failure. Make cache keys deterministic from a `namespace` + `chainId` + content-hashed
  inputs.
- **Lifecycle.** Stateless. Uses state store and content hash at call time.
- **Inputs / dependencies.** State store. Content hash. Bigint-safe JSON replacer (for losslessly
  hashing bigint-valued inputs). Per-call cache spec carrying namespace, chainId, inputs producer,
  label, verify probe, produce.
- **Outputs / capabilities provided.** A wrapper that runs the cache lookup, conditional verify, and
  conditional produce. A helper to build the cache key string for instrumentation.
- **Invariants.**
  - Key layout: `<namespace>/<chainId>/<inputs-hash-16chars>` with `chainId` slot omitted when
    empty.
  - Same inputs always produce the same key; different inputs always produce different keys;
    different chainIds produce different entries.
  - Inputs canonicalization (sorted keys, normalized bigints) is the caller's responsibility — the
    module does NOT canonicalize.
  - Hit + verify-success → no produce, no put.
  - Hit + verify-undefined → evict + produce + put.
  - Verify probe carries its own `R` requirement through to the consumer's effect signature.
  - Persistence failures (put / remove) never crash callers — they collapse to logged-and-ignored.
- **Known issues / edge cases.** The cache spec is invasive at the callsite — six fields, each with
  their own R/E parameters, inflating consumer effect signatures. `namespace` and `chainId` are bare
  strings — tests must pin literal key shapes to catch typos. Using `undefined` as the eviction
  sentinel makes a `T = undefined` cache statically indistinguishable from "invalid"; a tagged
  discriminator would be cleaner.

### Content hash

- **Responsibilities.** Provide a SHA-256 primitive used everywhere a content-addressed string is
  needed: cache keys, docker image tags, codegen fingerprints, watcher dedup.
- **Lifecycle.** Stateless.
- **Inputs / dependencies.** Node `crypto.createHash('sha256')`. Accepts strings (UTF-8),
  `Uint8Array`/`Buffer` (verbatim), or objects (via `JSON.stringify`, no replacer).
- **Outputs / capabilities provided.** One-shot hash, streaming hasher, finalize-to-hex, hex
  truncation. Length conventions in use: 12 (docker image tags), 16 (config-hash cache keys), 24
  (codegen fingerprint), 64 (full digest).
- **Invariants.**
  - Algorithm is fixed SHA-256; no algorithm choice exposed.
  - Determinism: same bytes always produce the same digest.
  - **No canonicalization** on object inputs — `{x:1, y:2}` and `{y:2, x:1}` produce different
    digests. Pinned in tests as intentional.
  - `Uint8Array` passes verbatim — no UTF-8 round-trip.
  - Streaming and one-shot yield identical digests for the same byte sequence.
  - Truncation is a hex char-slice, matching open-coded `digest('hex').slice(0, N)`.
- **Known issues / edge cases.** Circular references in object inputs throw via `JSON.stringify`.
  The contract for `Uint8Array` subclasses / subarray views isn't pinned by tests.

### Safe env

- **Responsibilities.** Build an allowlisted subset of `process.env` for inheritance into child
  processes spawned by the engine, so secrets and unrelated host vars don't leak.
- **Lifecycle.** Stateless.
- **Inputs / dependencies.** `process.env` (read-only). A hardcoded allowlist covering POSIX shell
  basics, Node configuration, working-dir hints, Windows equivalents, and `DEVSTACK_STACK`.
- **Outputs / capabilities provided.** A map of allowed env vars with their current values.
- **Invariants.**
  - Disallowed keys are simply omitted — no `undefined`, no placeholder, no log entry.
  - Unset allowed keys are also omitted (some platforms reject `undefined` values in `spawn`).
  - Cross-platform: Windows-specific keys forwarded only when set.
- **Known issues / edge cases.** Allowlist is a hardcoded array with no config knob. A plugin author
  wanting to forward a custom env var must hand-merge with the result map at every call site. Each
  consumer pattern is `{...inheritedHostEnv(), ...localEnv}` with `localEnv` winning — no shared
  "extend the allowlist" API.

### Resolve app dir

- **Responsibilities.** Return "where is the user's app rooted" — env-var override else
  `process.cwd()`. Read fresh on every call so per-test mutation works.
- **Lifecycle.** Stateless.
- **Inputs / dependencies.** `DEVSTACK_APP_DIR` env var, `process.cwd()`.
- **Outputs / capabilities provided.** Resolved app-dir path. The env-var name as an exported
  constant.
- **Invariants.** Env var beats cwd. No caching.
- **Known issues / edge cases.** None of consequence; the freshness contract is load-bearing for
  tests.

### Generic registry primitive

- **Responsibilities.** Standardize the publish/subscribe pattern used by per-service registries: a
  `Live` layer that allocates an append-only Ref of entries, a `publish` operation, and a
  `require(tag)` operation that orders the publisher's layer build BEFORE reading.
- **Lifecycle.** One Ref per Live layer, lazily built when the layer is required.
- **Inputs / dependencies.** A consumer-supplied Context tag plus advanced layered-tag types.
- **Outputs / capabilities provided.** `Live` / `publish` / `require` triple; the consumed registry
  yields `register` + `snapshot`.
- **Invariants.**
  - Append-only — no delete / update API. Consumers fold their own dedupe-by-name on snapshot.
  - `require(tag)` must yield the publisher's tag before resolving the registry so the snapshot is
    non-empty by the time it's read.
- **Known issues / edge cases.** Per-service registries hand-roll the triple in places where they
  could reuse this — the boilerplate-reduction is not fully realized.

### Global stack registry

- **Responsibilities.** Cross-invocation discovery file at `~/.devstack/registry.json` listing every
  devstack the user has run. Classify each entry as `active | dormant | stale | abandoned` for
  doctor/prune.
- **Lifecycle.** Lazy read. Read-modify-write upserts with bounded retry and tempfile+rename writes.
  No host-wide exclusive lock — last-write-wins is acceptable for this use case.
- **Inputs / dependencies.** Effect FileSystem. PID-alive check. Schedule for retry. Path override
  via env. File-existence check for `repoExists` classifier input.
- **Outputs / capabilities provided.** Read, upsert, clearPid, remove, pure classifier (with
  injectable `now`, `repoExists`, `pidAlive`).
- **Invariants.**
  - Schema-versioned (`{version: 1, stacks: [...]}`); defensive parse falls back to empty v1 on any
    error.
  - File mode 0644, parent dir 0755.
  - `firstSeen` preserved across upserts; `lastSeen` and `pid` updated.
  - `STALE_THRESHOLD_MS` = 30 days for classifier.
  - Atomic write via tempfile + rename — no partial state visible on rename failure.
- **Known issues / edge cases.** "Last-write-wins" + bounded retry can drop a boot-time write if a
  supervisor only upserts at boot+shutdown — entry would be absent until next boot. Wipe semantics
  for the matching registry entry assume `Registry.remove` is called; the contract isn't strictly
  enforced.

---

## Cross-subsystem invariants

- **Path scoping rules are universal.** `DEVSTACK_STATE_DIR` env > `cfg.stateDir` > network-aware
  default (local-like → `.devstack/stacks/<stack>/`, live → `.devstack/networks/<network>/`). State
  store, service paths, and snapshot must agree on these rules — they currently each inline them.
- **Persistent state lives under `<appDir>/.devstack/`.** State files (`state.json`), runtime
  per-service dirs, transient tempfiles, and lock files all root here. Override via env collapses to
  `${stateDir}/state.json` + `${stateDir}/runtime/...`. Host-wide files (global registry, per-port
  locks) live under `~/.devstack/` instead.
- **`devstack wipe` is expected to clear the full `.devstack/` tree** plus the matching
  global-registry entry. Per-port locks at `~/.devstack/ports/` are released by the supervisor
  finalizer if running; otherwise they age out via stale-PID recovery on next allocation.
- **All cross-process coordination uses O_EXCL `wx` create as the sole win signal.** Body parsing
  happens only AFTER the create succeeds (or fails). Stale-PID reclaim is unlink-then-retry.
  Foreign-host bodies are always alive.
- **PID liveness is `process.kill(pid, 0)` plus a process start-time match** (`ps -o lstart=` on
  POSIX, `tasklist` on Windows) — defends against PID reuse on POSIX; weaker on Windows.
- **Tempfile+rename is the only durable-write protocol.** State store, atomic-write, and global
  registry each implement it; they are not currently unified.
- **`(app, stack, network)` identity flows through docker labels AND filesystem paths.** Both
  surfaces depend on the same regex-validated name segments so a label that's a valid string is also
  a valid path segment.
- **Bootstrap-layer ordering matters.** State-store lock acquisition happens before docker work;
  identity validation happens before any label is constructed; supervisor watch fibers are forked
  under the supervisor scope so they tear down with it.

## Learnings from current implementation

- **The thin file-watcher is in practice useless.** Every consumer must re-add minimatch filtering,
  250 ms debounce, and a per-file content-hash dedup at the supervisor layer. The "service emits raw
  events, supervisor filters" seam forces every consumer to reproduce the filtering. A redesigned
  watcher should absorb debounce + gitignore-style filtering + content-hash dedup.
- **Three lock implementations share ~90% code.** `engine/file-lock.ts` (sync), state-store's Effect
  retry loop, and `sui-fork`'s variant all reimplement body codec, O_EXCL semantics, stale-PID
  recovery, and finalizer pattern. A unified sync + Effect API with configurable jittered backoff
  would collapse them.
- **Path resolution is duplicated three ways.** State store, service paths, and snapshot each inline
  the env > cfg > network-aware default precedence. Service paths even inlines its own
  `isLocalLikeNetwork` check rather than importing it. A shared path-resolver returning the full set
  `{stateDir, runtimeDir, stateFile, lockFile}` would consolidate.
- **Atomic-write and state-store's tempfile+rename are two separate code paths** implementing the
  same protocol with subtly different APIs. State store has no `ifChanged` variant; atomic-write
  isn't Effect-flavored.
- **Cache spec is invasive at the callsite.** Six fields with independent R/E parameters bloat
  consumer effect signatures, and `namespace`/`chainId` as bare strings require literal-key-shape
  tests to catch typos.
- **`StateStoreKeys` is convention-only.** Nothing prevents a callsite from building its own key
  string. A branded `TypedKey` would prevent drift.
- **Identity throws synchronously at Layer build.** Errors surface as fatal `Layer.build` aborts,
  not friendly TUI red entries.
- **No per-port lock TTL.** Stale-PID recovery handles dead local supervisors but leaks across
  shared-NFS hosts since foreign-host bodies are alive by definition.
- **`releasePortLock` re-reads the lock file** to recover its body rather than caching the holder
  body at claim time — an extra read per release.
- **`servicePath` always needs `StateStoreConfig`** even for pure path planning. A non-Effect
  variant would let build-time tools compute paths without the layer dance.
- **`safe-env` allowlist is universal and hardcoded** — no per-primitive opt-in for forwarding a
  custom env var to a child process.
- **`state-store` swallows all non-migration read errors silently** — corrupt caches are invisible.
  A best-effort warning log would surface corruption without blocking boot.
- **`file-lock` reclaim errors lose detail.** Returning a generic "ok: false, holder" loses the
  difference between "couldn't unlink" and "couldn't write."
- **`displayPath` lives in `engine/` but is consumed only by codegen** — misclassified.
- **What worked.** O_EXCL create-and-detect as the single source of truth; uninterruptible
  finalizers for lock release; `acquireUseRelease` for tempfile writes; sequential dual-host probe
  order (0.0.0.0 first); `Stream.callback`'s queue-before-attach for not losing boot-time fs events;
  Semaphore-of-1 leasing (interrupt-safe by construction); content-hash determinism with deliberate
  non-canonicalization (callers always know if they need it); identity name regex catching
  shell-meaningful chars early; the bootstrap-layer placement of the state-store lock (acquires
  before docker work).

## Cross-component references

- **engine-core / supervisor** owns: minimatch filter compilation, 250 ms debounce, per-file
  content-hash dedup cache for the watcher. The redesign needs to decide where these land — pushing
  them into the watcher absorbs supervisor lines but trades simplicity for thickness.
- **engine-core / supervisor** owns: bootstrap layer composition that places state-store lock
  acquisition before docker. Engine-resources must remain composable into that bootstrap layer.
- **network module** owns: network enum + `isLocalLikeNetwork`. State-store and service-paths must
  agree with it on local-like-ness routing.
- **process-liveness module** owns: PID-alive + start-time-match. File-lock, state-store,
  port-allocator, and global registry all depend on it.
- **json-bigint module** owns: bigint-safe JSON codec. State store and cache (for cache-key
  building) depend on it.
- **snapshot module** owns: save/restore of `runtime/<service>/`. It needs the runtime root to match
  state-store path scoping exactly.
- **sui-fork** (out of engine-resources scope) shares the file-lock primitive — any redesign of the
  lock module must remain compatible.
- **CLI / runtime layer** owns: stack-name resolution from `DEVSTACK_STACK`. Engine-resources
  receives the resolved name via config.
- **doctor / prune / wipe** consume the global registry's classifier and the `.devstack/` tree
  layout.

## Open questions / decisions deferred

- Is the global `~/.devstack/registry.json` engine-resources, or its own subsystem? The pub/sub
  framing doesn't fit; it's a cross-process discovery file.
- Should the supervisor's per-file content-hash watcher dedup cache live in the watcher (and
  therefore engine-resources) instead of the supervisor?
- Is `displayPath` engine-resources, observability's, or codegen-only? Today it's misfiled in
  `engine/` but consumed only by codegen.
- Is `maxScan: 100` (port allocator) a hard requirement or just a starting point? No test pins it.
- Does the global registry's last-write-wins semantics break under high concurrency if a supervisor
  only upserts at boot+shutdown?
- Does `devstack wipe` enumerate every path it should (including lock files, transient tempfiles,
  runtime per-service trees)?
- What is the contract for content-hash on `Uint8Array` subclasses (e.g. `Buffer`, subarray views)?
- What happens when `DEVSTACK_NETWORK` env resolves to a fork variant but a downstream
  `StateStoreConfig` carries the base network?
- What's the contract for an unparseable / invalid-by-regex `package.json#name` whose
  `basename(cwd)` ALSO produces an invalid identity? Today's fallback chain doesn't cover that.
- Should state-store's Effect-based retry loop fold into a shared file-lock module that also has an
  Effect variant? The retry policy is the only difference between the sync and Effect call-sites.
- Should `safe-env` allowlist be extensible per primitive (via a Layer-supplied config) instead of
  universally hardcoded?

## Opportunities noticed

- **Unify the three lock implementations** into one module that exposes sync and Effect variants
  with a configurable jittered-backoff retry policy.
- **Consolidate path resolution** into one helper returning
  `{stateDir, runtimeDir, stateFile, lockFile}` for state-store, service-paths, and snapshot.
- **Fold atomic-write and state-store's tempfile+rename** into one tempfile+rename module with
  optional `ifChanged` and Effect-flavored variants.
- **Thicken FileWatcher** to absorb debounce + gitignore-style filter + content-hash dedup,
  eliminating duplicate logic in the supervisor.
- **Move `displayPath`** out of `engine/` — either into `services/codegen/` or generalize into a TUI
  helper. It's not an engine resource.
- **Brand `StateStoreKeys`** with an opaque typed-key shape so bare-string puts are statically
  rejected.
- **Generalize per-service registries** onto `defineRegistry` so the publish/subscribe boilerplate
  doesn't get re-hand-rolled per service.
- **Cache holder body in port allocator at claim time** instead of re-reading the file on release.
- **Make `safe-env` allowlist extensible** per primitive via a config Layer, so plugins forward
  custom env vars without widening the universal allowlist.
- **Add a pure path planner** for `servicePath` so build-/compose-time consumers don't need
  `StateStoreConfig` injected.
- **Use a tagged discriminator in the cache's verify result** instead of `undefined` as the eviction
  sentinel.
- **Add a best-effort warning log** to state-store's silent-swallow read-error path so corrupt
  caches are visible.
- **Carry richer reclaim errors** out of `file-lock` so a wedged port allocator is debuggable
  without strace.
- **Validate `network` inside `Identity`** rather than trusting upstream resolution
  (defense-in-depth, since paths and labels both consume it).
- **Surface identity-validation errors as TUI red entries** rather than fatal `Layer.build` aborts.
- **Either import `isLocalLikeNetwork` from `engine/network.ts` everywhere or move the helper into a
  constants module** so `service-paths` doesn't have to inline it.
