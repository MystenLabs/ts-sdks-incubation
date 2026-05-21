# 04 Runtime: Docker (distilled)

## Purpose

The container-runtime adapter turns the engine's primitive-graph intent into actual containers,
images, networks, volumes, and reverse-proxy routes by driving a container CLI. It is the single
seam through which every long-lived service container, one-shot job, exec invocation, image
build/pull, network create/attach, host-port publication, and Host()-routed entrypoint flows. It
owns:

- The race-safety story for container start (adopt / resume / recreate / fresh state machine,
  per-name serialisation, name-collision recovery).
- The cross-process labelling contract so sweep / wipe / prune / inventory / Docker Desktop UI can
  enumerate and group devstack resources reliably.
- The shared reverse-proxy router lifecycle (singleton container, file-provider config, dynamic-dir
  watch).
- The orphan-sweep mechanism that culls resources for primitives the user removed since the last
  run.
- The cross-stack inventory primitives that `doctor` / `prune` / `wipe` enumerate label-stamped
  resources through.

Conceptually it is one implementation of a generic `ContainerRuntime` interface; today there is
exactly one impl (the host docker CLI), but the architecture goal is for runtime adapters to be
swappable (podman / nerdctl / hypothetical others).

## Responsibilities

- **Image management** — pull (with per-layer progress narration), build (content-addressed),
  exists-probe (short-circuit cached builds), tag (alias under a new name), save/load (tar
  serialisation for snapshots), inspect (read the tag a container was started from).
- **Long-lived container lifecycle** — adopt-or-create idempotent start, scope-bound stop finalizer,
  image-mismatch recreate, stopped-container resume, port-conflict resume-fallback, name-collision
  recovery, host-port readback after start.
- **One-shot container lifecycle** — run-to-completion with wall-clock timeout, TERM-then-KILL
  escalation, configurable grace, automatic removal, optional per-line streaming sink, optional
  post-mortem retention.
- **Exec inside running container** — capture stdout/stderr/exitCode.
- **Pause/unpause/commit** — cgroup-freezer wrapping around image commit for quiescent snapshot of
  writable layer.
- **Restart** — force re-read of bind-mounted config files.
- **Force-remove by name** — for invalidation paths and name-collision cleanup.
- **Log streaming** — per-line follow with normalisation (text-prefix `INFO|WARN|ERROR` and
  structured tracing-subscriber JSON), best-effort tail snapshot for error enrichment, exit-code
  wait.
- **Ready probes** — race a user-provided probe against container exit so a crashed container
  surfaces its log tail.
- **Network management** — idempotent labelled bridge create (with optional subnet/gateway),
  idempotent secondary-network attach, IP readback after attach (with retry).
- **Volume management** — pre-create named volumes with labels BEFORE the run argv fires (avoid lazy
  unlabelled creation).
- **Reverse-proxy router** — singleton router container (boot via adopt/resume/recreate/fresh),
  entrypoint registry, file-provider config write/remove (atomic), singleton CORS middleware,
  memoised router-network IP.
- **Sweep / claim** — claim-set bookkeeping during cycle, post-build orphan sweep against the (app,
  stack, network) label triple, parallel-stop opt-in for composite primitives.
- **Inventory** — cross-stack enumeration of containers / networks / volumes / images plus state-dir
  filesystem walk, three-way classification (running / idle / repo-gone), label-filtered teardown
  helpers, pure rendering and sizing helpers.
- **Error wrapping** — single canonical error envelope; pipe-compatible combinator for
  plugin-specific re-tagging.

## Generic container-runtime requirements

Any backend (docker, podman, nerdctl, finch, hypothetical) must satisfy:

- **Subprocess seam** — every backend call flows through a single subprocess capture surface; spawn
  failures and non-zero exits map into one canonical error envelope (phase / message / stdout /
  stderr / exitCode / cause).
- **Name-atomic create** — runtime must guarantee `--name`-style atomicity so two concurrent
  creators see one win and one fail with a recognisable "already in use" signal.
- **Inspect by name** — backend exposes a stable way to read `(running, image, id, lastExitCode)`
  for a name; null when absent.
- **Resume of stopped** — a stopped container can be re-started without altering its writable layer.
- **Adopt-if-healthy short-circuit** — when an existing same-name same-image container is already
  running, skip rm + recreate.
- **Recreate triggers** — image mismatch, unclean shutdown (default: exit 137), and resume-failure
  are recreate-triggering classes.
- **Recreate opt-out for known-good exit codes** — caller may declare exit codes that should NOT
  trigger recreate (sui-localnet's SIGKILL-by-design case).
- **Port publication and readback** — caller-supplied host ports OR auto-allocation; actual bindings
  read back from runtime inspect (not assumed equal to request).
- **Network create idempotent + labelled** — and survives backend lifetime (no scope finalizer).
- **Network connect idempotent** — "already exists in network" is success.
- **IP readback retries** — secondary-network attach is asynchronous; IP must be polled until
  non-empty with a bounded budget.
- **Named volume create idempotent + labelled** — and pre-created BEFORE the run argv so labels are
  stamped (avoid lazy unlabelled creation).
- **Bind mount passthrough** — host paths are user-owned; runtime must not pre-create.
- **Exec in running container** — captures stdout/stderr/exitCode.
- **Pause / unpause / commit** — for quiescent snapshot of writable layer.
- **Image build content-addressed** — cache-short-circuit by tag-exists probe.
- **Image pull progress** — per-line layer narration emit-able through caller's phase sink.
- **Image save/load** — tar serialisation; load must surface the loaded tag.
- **Image tag alias** — required for snapshot restore.
- **Per-line log follow** — combined stdout/stderr stream, normalisable to (level, line); dedupe
  followers across hot-restart cycles so they don't accumulate.
- **Best-effort log tail** — for error enrichment.
- **Container exit wait** — block until exit, surface exit code.
- **Label-filtered enumeration** — list containers / networks / volumes / images by label; remove by
  label.
- **Stop with grace + signal** — caller-configurable signal and timeout; finalizer must be
  uninterruptible.
- **One-shot timeout with TERM-then-KILL escalation** — wall-clock budget; SIGTERM then SIGKILL
  after grace.
- **One-shot post-mortem retention opt-in** — env-driven escape hatch to skip `--rm` AND finalizer
  rm so failed jobs survive for forensics.
- **Belt-and-suspenders one-shot rm** — outer-scope rm catches containers that outlived the
  foreground subprocess on timeout paths.
- **Label-stamp contract** — every created resource carries the canonical label set (app, stack,
  action) plus compose-style labels for IDE grouping.
- **Name-composition policy** — deterministic, cross-stack-collision-free name composition consumed
  by both creator and enumerator paths.
- **Stderr classifier** — runtime-aware patterns for port conflict, name collision,
  no-such-container, "already exists in network".
- **Inventory pure helpers** — size parsing, byte formatting, classification, row rendering, totals
  aggregation are runtime-agnostic.
- **Reverse-proxy surface** — separable from container runtime per se; defined here as a sibling
  concern because it shares the subprocess seam. A runtime backend swap should not force a router
  backend swap.

## Docker-specific concerns

- **Docker CLI on PATH** — the implementation seam is `docker` invocation; daemon reachability is
  "Cannot connect to the Docker daemon" stderr.
- **Compose-style labels (five labels)** — `com.docker.compose.project`,
  `com.docker.compose.service`, `com.docker.compose.container-number=1`,
  `com.docker.compose.version=2.0.0`, `com.docker.compose.oneoff=False` are stamped to make Docker
  Desktop group devstack containers. These are docker-Desktop-specific UX; podman would skip or
  substitute.
- **Stderr-pattern matchers** — `isPortConflictStderr`, name-collision detection, "No such
  container", "already exists in network" assume docker's exact wording. A new backend needs
  equivalent classifiers in its own dialect.
- **`docker stop --signal` / `--time`** — flag shape and SIGTERM-deaf-binary handling (e.g.
  tokio-only-SIGINT) is docker's argv contract.
- **`docker network connect` async settle** — the IP-retry budget exists because docker registers
  the endpoint before the IP is allocated. Other backends may be synchronous and need no retry.
- **Compose-project name format** — `<app>` / `<app>-<stack>` / `<app>-<stack>-<network>` cascade is
  consumed by both label stamping AND sweep filtering; format is docker-Compose-compatible by
  design.
- **Volume lazy-create problem** — docker's `-v <name>:<path>` lazily creates volumes WITHOUT
  labels; we pre-create to work around. Other backends may not need this.
- **Traefik file-provider as router** — choice of traefik is a docker-deployment choice; the
  file-provider (not docker-provider) approach is needed because containers attach to two networks
  and the docker-provider's first-event handler captures the wrong IP.
- **Compose-style sweep filter** — sweep ANDs `com.docker.compose.project` AND `devstack.app` AND
  `devstack.stack` (belt-and-braces against project-name collisions with unrelated host workloads).
- **Router-network singleton** — `devstack-router` bridge survives across processes; cleanup
  requires `devstack prune --include-router`.
- **Cross-process safety relies on docker's `--name` atomicity** — exit 125 + "already in use" is
  the canonical signal for peer-collision recovery.

## Lifecycle states

### Container state machine

- **Missing** — name does not resolve to a container.
- **Running, image matches** — adopt: skip rm + run, reuse id, register stop finalizer.
- **Running, image mismatch** — recreate(image-mismatch).
- **Stopped (clean exit), image matches** — resume via start; on TOCTOU "No such container", promote
  to fresh; on other start failure, promote to recreate(resume-failed).
- **Stopped (exit 137, unclean), image matches** — recreate(unclean-shutdown) by default; if caller
  declares `expectedExitCodes: [137]`, treat as resume.
- **Stopped, image mismatch** — recreate(image-mismatch) regardless of `expectedExitCodes`.
- **Fresh creation** — `run -d` with full label set; on exit 125 + "already in use", fall back to
  start-and-adopt; second collision is a typed failure (no infinite loop).
- **Running (claimed)** — id is in `ClaimedContainers`; stop finalizer registered on caller's
  reuse-scope (or composite's parallel scope).
- **Orphaned** — labelled but NOT in this cycle's claim set; eligible for post-build sweep.
- **Removed** — only via name-collision cleanup, orphan sweep, router image-mismatch teardown, build
  container teardown, or explicit `wipe` / `prune --force`.

### Image state machine

- **Missing** — `imageExists(tag)` returns undefined.
- **Pulling** — pull subprocess in progress; layer-progress narration emits "pulling K/N layers"
  phases.
- **Pulled** — pull subprocess exited 0 and inspect returns a non-empty digest.
- **Built (content-addressed)** — build subprocess exited 0; tag
  `devstack-<name>:<treeHash>-<configHash>` exists with `devstack.image=true` label.
- **Cached (short-circuit)** — content-addressed tag already exists → build skipped.
- **Snapshot-loaded** — `docker load` produced a `Loaded image:` line; subsequently
  `tagImage(snap, originalTag)` aliases it.
- **Orphan-unlabelled** — pre-revision-X devstack-named images without the `devstack.image` label;
  surfaced by inventory but not auto-cleaned.

### Router state machine

- Same adopt/resume/recreate/fresh shape as long-lived containers, applied to the singleton
  `devstack-traefik` container with `devstack-router` network and dynamic-dir mount.

## Inputs / dependencies

### Consumed services

- **Subprocess spawner** — every backend invocation flows through one capture surface; the only true
  implementation seam.
- **Identity** — `(app, stack, network)` triple; drives name composition, label stamping, and
  per-stack DNS suffixes.
- **Scope** — long-lived `run` and `networkCreate` register finalizers on the ambient scope.
- **EngineHandle (optional)** — `markStopping(tagKey)` / `markStopped(tagKey)` for per-row teardown
  progress in the TUI; resolved once before finalizer registration so the closure captures it.
- **ClaimedContainers (optional Ref)** — write-once-per-cycle set of adopted-or-created ids;
  consumed by post-build sweep.
- **StopFinalizerScope (optional Scope)** — composite primitives override the default reuse-scope
  with a parallel-strategy child scope so sibling-container stops fan out concurrently.
- **Registry** — inventory cross-joins (app, stack) buckets with persisted registry entries.
- **FileSystem + node fs** — router dynamic-dir creation, file-provider atomic write/remove,
  state-dir enumeration.

### Consumed engine resources

- Canonical error envelope (`DockerError` today; the generic shape is
  phase/message/stdout/stderr/exitCode/cause).
- Identity label keys (`devstack.app` / `devstack.stack` / `devstack.network` / `devstack.action`).
- Subprocess capture helpers (unified across docker / sui-cli / snapshot).
- Atomic-write helper (tmp-and-rename).
- Process-liveness probe (state-lock pid liveness for inventory classification).
- Ready-probe primitives (race ready probe against exit wait).
- Tag substrate (`setPhase`, `LayeredTag`, `CurrentTagKey`, `TagKind`, `TuiDisplay`) for
  plugin-author wiring and pull-progress narration.

### Consumed runtime resources

- Host docker daemon (every operation).
- Host filesystem (`~/.devstack/traefik/dynamic/`, `~/.devstack/stacks/<stack>/`).
- Host ports (publishes `-p <bindAddress>:<hostPort>:<containerPort>`; defaults to loopback, opt-in
  `0.0.0.0` for devcontainers/WSL).
- Host process signals (`SIGTERM`/`SIGKILL` for one-shot escalation; `--signal`/`--time` on
  `docker stop`).

### Configuration knobs

- Per-call long-lived: name, image, args, env, env-files, ports, bind address, mounts, network,
  add-hosts, ip, hostname, network-alias, traefik entries, output-line sink, stop grace, stop
  signal, engine tag key, expected exit codes, detach.
- Per-call one-shot: name, image, args, env, mounts, network, entrypoint, timeout, grace,
  output-line sink.
- Identity: `(app, stack, network)` triple via Layer.
- Env: `DEVSTACK_ROUTER_DYNAMIC_DIR` (override dynamic-dir for tests), `DEVSTACK_KEEP_ONESHOT`
  (post-mortem retention). `DEVSTACK_DIRECT_PORTS` is documented but not implemented (open
  question).
- Inventory roots: optional array of filesystem roots for state-dir probing.

## Outputs / capabilities provided

- **Long-lived run result** — container id, name, reused flag, host-port map (read back from
  inspect, not assumed equal to request).
- **One-shot result** — exit code, captured stdout, captured stderr; does NOT throw on non-zero
  exit.
- **Exec result** — captured stdout, stderr, exit code.
- **Pull / build result** — digest (and tag for build).
- **Image-exists probe** — digest or undefined.
- **Commit result** — digest of committed image.
- **Log stream** — per-line text.
- **Log tail** — best-effort string.
- **Exit-wait result** — exit code.
- **Inventory rows** — (app, stack) buckets of containers/networks/volumes plus state-dir locations
  and registry cross-join.
- **Image inventory** — devstack-built images with in-use flags.
- **Router info** — singleton router probe plus active backend count.
- **Removed-id arrays** — best-effort label-filtered teardown surfaces.
- **Labelled side effects** — containers, networks, volumes, images all carry the canonical label
  set; built images carry `devstack.image=true`; router resources carry `devstack.router=true`.
- **File-provider YAMLs** — `<dynDir>/<id>.yml` per route plus singleton `_devstack-cors.yml`.
- **Process-global side effects** — per-name lock registries, attached-follower dedupe set,
  entrypoint registry, memoised router IP cache (all process-local).

## Invariants and constraints

1. **Per-name in-process serialisation** — two concurrent adopt/resume/recreate cycles for the same
   container name MUST serialise. Without this, vitest workers and concurrent apply cycles TOCTOU
   between inspect, rm, and run.

2. **Cross-process safety via runtime atomicity** — backend's `--name` atomicity (exit 125 +
   "already in use") is the canonical signal for peer-collision recovery; single-shot
   start-and-adopt fallback.

3. **Canonical label set on every resource** — containers carry `devstack.app` / `devstack.stack` /
   `devstack.action` plus five compose-style labels; networks carry the equivalent set; named
   volumes carry `devstack.app` + `devstack.stack`; built images carry `devstack.image=true`.
   Missing any label = orphan-by-construction (sweep/wipe/prune can't find it).

4. **AND on three labels for orphan-sweep filtering** — `compose.project` AND `devstack.app` AND
   `devstack.stack`. Compose-project alone is a false-positive vector against unrelated host
   workloads.

5. **Post-build sweep, NOT pre-build** — sweeping before layer build nukes still-healthy containers
   from a previous process before adoption can reuse them. Sweep MUST run after `Layer.build`
   completes, gated on build success. Cycle-1 only.

6. **Reuse-if-healthy short-circuit** — running + image matches MUST skip rm + run, just claim the
   id and register the stop finalizer.

7. **Resume-if-healthy** — stopped + image matches + no unclean-shutdown signal MUST resume via
   start (not rm + run).

8. **TOCTOU recovery on `start → missing`** — peer's finalizer rm'd between inspect and start;
   promote to fresh.

9. **Resume-fallback port handling** — port-conflict stderr → drop caller ports + auto-allocate;
   non-port stderr → preserve caller ports. Silent port reallocation would move an already-published
   URL out from under the caller.

10. **Name-collision recovery via start-and-adopt** — single-shot; second collision is a typed
    failure (no infinite loop).

11. **`expectedExitCodes` opt-out covers ONLY the unclean-shutdown branch** — image-mismatch still
    wins.

12. **No teardown-time rm of stateful long-lived containers** — chain state lives in the writable
    layer; the stop finalizer is the only teardown. Force-rm is reserved for: name-collision
    cleanup, orphan sweep, router image-mismatch, build container, explicit wipe/prune.

13. **Stop finalizer uninterruptible** — SIGINT-driven scope close must not kill the stop subprocess
    mid-flight.

14. **Caller-configurable stop signal** — SIGTERM-deaf binaries (tokio-only-SIGINT) must opt into a
    custom signal or hit grace timeout → SIGKILL → unclean-shutdown next cycle.

15. **Log-follower fork is scope-bound, not manual finalizer interrupt** — manual interrupt would
    join on the follower's natural exit (only when log stream closes).

16. **Process-global follower dedupe** — `ATTACHED_FOLLOWERS` set is checked-and-added atomically
    before fork; near-simultaneous attaches can't both pass.

17. **File-provider routing, NOT docker-provider** — docker-provider's first-event handler captures
    the per-stack IP before the router-network attach completes. File-provider lets us inspect the
    router-network IP synchronously and write the resolved YAML.

18. **File-provider write is atomic (tmp-and-rename)** — traefik watcher must never see a
    half-written YAML; torn read poisons the file until it next mutates.

19. **IP-readback retries** — `network connect` is async; budget ~3s (30 × 100ms).

20. **`network connect` idempotency** — "already exists in network" is success; required for
    adopt-path reattach and warm restart.

21. **`networkCreate` registers NO finalizer** — networks must survive the supervisor so stopped
    containers can resume into the same bridge id. Cleanup is `wipe` / `prune`.

22. **Host-port readback from inspect, NOT from caller options** — `start` ignores fresh-allocated
    ports; only `run` honors them. Auto-allocate must read actual binding from runtime.

23. **Content-addressed image build short-circuits via tag-exists probe** — without this, the
    warm-cache rebuild would re-tag the image and destroy a snapshot-restore alias of the original
    tag.

24. **Pre-create labelled volumes BEFORE the run argv** — backend's lazy `-v <name>:<path>` creation
    produces unlabelled volumes that no enumeration can find.

25. **Belt-and-suspenders one-shot rm** — timeout path may surface failure before the scope
    finalizer completes; outer `ensuring(rm -f)` catches outlived containers.

26. **Consistent `DEVSTACK_KEEP_ONESHOT` semantics** — when set, BOTH `--rm` is dropped AND the
    finalizer is skipped.

27. **CI fast-fail gates AFTER orphan sweep** — failed cycle must exit non-zero, BUT the sweep's
    `cycle === 1 && buildSucceeded` guard runs first so failures don't destroy sibling stacks'
    healthy resources.

28. **CORS middleware is a singleton YAML loaded before any backend references it** —
    underscore-prefixed filename sorts ahead of per-route entries.

29. **Composite parallel-stop opt-in is per-call** — single-container primitives use the calling
    scope; composites (e.g. 4-node walrus committee) override via `StopFinalizerScope` to fan out
    concurrently, turning O(sum(grace)) into O(max(grace)).

## Edge cases and known failure modes

- **Daemon unreachable** — every operation surfaces canonical error envelope; caller renders pretty
  error.
- **Image pull failure** — no automatic retry; layer narration settles at partial state.
- **Port conflict on fresh run path** — propagates as error (no special handling); only the
  resume-fallback path drops + reallocates.
- **Container exited 137 on prior cycle** — default behaviour is recreate(unclean-shutdown); opt-out
  via `expectedExitCodes`.
- **Image mismatch** — recreate regardless of `expectedExitCodes`.
- **Name collision** — peer beat us; `start <name>` to adopt the peer's id; second collision = typed
  failure.
- **TOCTOU `start → missing`** — peer's finalizer rm'd; promote to fresh.
- **`network connect devstack-router` fails** — warning logged, file-provider write skipped,
  container keeps direct-port access; "endpoint already exists" is idempotent success.
- **IP-readback budget exhausted** — hard failure (silent swallow would leave container live but
  unreachable via YAMLs).
- **File-provider write fails (FS perms)** — warning logged, finalizer NOT registered, container
  keeps direct-port access.
- **`renderFileProvider` validation throws synchronously** — caught into typed error;
  programming-error class.
- **`defineEntrypoint` after `ensureRouter`** — registry sees it but running router doesn't have the
  `--entrypoints.<name>.address=…` flag; routes 404 until next recreate.
- **`defineEntrypoint` conflicting (name, different port)** — throws synchronously; idempotent on
  identical tuple.
- **One-shot timeout fires** — escalation to SIGTERM then SIGKILL; outer ensuring rm catches
  outlived containers.
- **One-shot exit non-zero** — returned in result, NOT thrown; caller chooses.
- **Commit returns empty digest** — wrapped as canonical error.
- **`docker load` produced no `Loaded image:` line** — wrapped as canonical error.
- **Inventory: daemon down** — every enumeration falls back to empty; doctor reports "no resources
  found", no false errors.
- **Inventory: malformed `system df` JSON** — fallback to line-delimited; size shown as "unknown".
- **Orphan sweep individual rm fails** — per-id error swallowed; sweep continues with others.
- **Router IP cache stale after explicit prune+recreate** — argued unreachable because prune
  requires `pnpm dev` restart; test escape hatch exists but not exported.
- **File-provider YAML survives crashed process** — next `run` for the same primitive overwrites
  correctly, but a primitive REMOVED from config leaves orphan YAML referring to a stopped/missing
  container; traefik 502s until manual delete or `wipe`.
- **Concurrent `pnpm dev` invocations of the SAME app** — both adopt the same containers fine, but
  each registers a stop finalizer that fires on its own scope close, potentially stopping containers
  the peer is still using. OPEN: is this protected (file-lock?) or relied on the user?

## Learnings from current implementation

- **Audit E1 collapsed two parallel state machines** — `Docker.run` and
  `sui-build-container::ensureContainer` had independently re-implemented
  adopt/resume/recreate/fresh; consolidating into a single race-safe `ensureContainer` removed a
  class of drift bugs. The pure `decideRunAction` is exhaustively tested.
- **`wrapDocker` combinator eliminated ~25 sites of `catchTag('DockerError', …)` boilerplate** —
  every plugin error type gains a uniform conversion path.
- **Per-line streaming sinks with level promotion** — Rust-tracing-style stderr lines carrying
  embedded WARN/ERROR prefixes must be normalised to the matching log level; bare default-info
  classification loses signal in TUI.
- **`ATTACHED_FOLLOWERS` dedupe is load-bearing** — hot-restart cycles would otherwise accumulate
  followers; check-and-add is synchronous (atomic) before fork.
- **Pre-creating labelled volumes prevented ~100MB-per-cycle unlabelled state leak** — lazy
  `-v <name>:<path>` was the culprit.
- **Resume-fallback port handling MUST classify stderr** — silently re-allocating on non-port errors
  moves URLs out from under the caller (seal key server 2024 case).
- **Stop signal customisation is real-world necessary** — sui's tokio-only-SIGINT case is recurring,
  not academic.
- **Post-build sweep timing matters** — pre-build sweep was an early implementation that broke
  warm-resume; post-build + cycle-1 + buildSucceeded gate is the working invariant.
- **File-provider beat docker-provider for traefik** — docker-provider races the two-network attach
  and captures the wrong IP.
- **Composite teardown parallelism** — walrus 4-node committee exposed O(N × grace) shutdown time as
  a real UX problem; `StopFinalizerScope` is the targeted fix.
- **Content-addressed build tag + cache short-circuit interacts subtly with snapshot.restore** —
  `tagImage(snap, originalTag)` would be clobbered if a rebuild fired; the `imageExists`
  short-circuit is what protects this.
- **Belt-and-suspenders one-shot rm** — `timeoutOrElse` is permitted to surface its `orElse` failure
  before the inner scope finalizer completes; the outer ensuring rm catches the gap.
- **CORS middleware singleton must load before backends** — file-provider load order is
  filename-alphabetic; underscore prefix is the chosen convention.
- **Subprocess capture unification across docker / sui-cli / snapshot** is what makes the error
  envelope coherent.

## Cross-component references

- **Engine core / supervisor** — provides `ClaimedContainers` and invokes `dockerOrphanSweep`
  post-build. Engine handle (optional) drives per-row teardown progress.
- **Engine resources / plugin-author surface** — `dockerContainer`, `dockerImage`, `dockerOneShot`
  are the documented authoring helpers built on top of this layer; `containerPrimitive` is the
  substrate used by in-tree services.
- **Sui** — `sui-build-container` uses `ensureContainer` directly; sui-localnet uses
  `expectedExitCodes: [137]` and `stopSignal: 'SIGINT'` and `stopGraceSeconds: 30`.
- **Walrus / Seal / Deepbook / Postgres** — each is a primitive consumer of `Docker.run` /
  `runOneShot` / `exec`; walrus uses `StopFinalizerScope` for parallel-stop; walrus storage nodes
  use `networkAlias` / `hostname` / explicit subnets.
- **Snapshot** — consumes `pauseContainer` → `commitContainer` → `unpauseContainer` → `saveImage`;
  restore consumes `loadImage` + `tagImage`.
- **Router-bootstrap / router-hostname** — boot the singleton router and resolve per-route
  hostnames.
- **Ready probes** — `awaitContainerReady` races user probe against `dockerWait`; `followLogs` feeds
  log-pattern probes.
- **CLI** — `doctor` / `prune` / `wipe` / `stack` consume inventory primitives directly (today's
  inventory exports are NOT in the docker barrel; consumed via direct path import).
- **State store / file lock** — separate layer; per-name semaphore for state-store locks open-codes
  the same `Map<name, Semaphore(1)>` pattern.

## Open questions / decisions deferred

1. **Generic `ContainerRuntime` interface shape** — today's surface has ~25 distinct operations.
   Should some compose at the interface boundary (`restart = stop + start`,
   `pauseAndCommit = pause + commit + unpause`) or remain primitive?
2. **Reverse-proxy as a sibling interface vs nested in `ContainerRuntime`** — router primitives
   currently live in the same package because they share the subprocess seam, but conceptually a
   backend swap (docker → podman) is independent of a router swap (traefik → caddy / nginx / envoy).
   Likely two interfaces.
3. **Where does the cross-process container claim safety story live?** — peer `pnpm dev` invocations
   against the same app currently rely on docker's `--name` atomicity for create races, but two
   adopters both register stop finalizers. File-lock at the engine layer? Per-stack lock? Documented
   user-don't-do-that?
4. **Should the entrypoint registry be per-`defineDevstack` instead of process-global?** — today's
   pre-register-at-module-load pattern is fragile to dynamic imports and makes test isolation hard.
5. **Should `ATTACHED_FOLLOWERS` be a `Context.Reference<Ref<Set<string>>>` mirroring
   `ClaimedContainers`?** — process-global Set is exactly the anti-pattern `ClaimedContainers` was
   introduced to avoid.
6. **Should `traefikRouterIpCache` be replaced by `Effect.cachedFunction`?** — would obviate the
   `resetForTesting` escape hatch.
7. **`DEVSTACK_DIRECT_PORTS` — planned, dropped, or stale docstring?** — documented but never read.
8. **`DockerLabel.NETWORK`, `labels?: Record<string, string>`, `mounts[].readonly?`** —
   reserved-knob shadows that the engine silently ignores. Keep, remove, or wire up?
9. **`runOneShot`'s redundant happy-path rm** — every successful one-shot wastes a `docker rm`
   round-trip; could be conditional on timeout failure.
10. **Should `pauseContainer` / `unpauseContainer` be part of the public surface or co-located with
    `commitContainer` as snapshot-only?**
11. **Should label / name composition contracts be schema-validated at the interface boundary?** —
    any backend rename of labels or name format breaks every CLI enumerator silently.
12. **Single-mode-only today** — `detach: false`, podman, remote daemon, kubernetes-via-CLI are all
    theoretical. Does the redesign commit to making these real, or just leaves the seam available?
13. **Where do stderr classifiers live?** — they're a coherent "stderr classifier" module (port
    conflict, name collision, no-such-container, network-already-attached); a future runtime impl
    needs its own classifier set.
14. **Cross-stack singleton router teardown UX** — `prune --include-router` is the only path to
    clear; is there a per-process reset?
15. **Sweep does NOT clean up file-provider YAMLs from crashed processes** — orphan YAMLs referring
    to removed primitives 502 until `wipe`. Should sweep enumerate dynamic-dir YAMLs against the
    claim set?

## Opportunities noticed

- **Three parallel name-lock registries** (`ensure-container`'s, `containerPrimitive`'s, plus engine
  file-lock) should collapse into one shared substrate. Currently three semaphore acquisitions per
  container start where one would suffice.
- **Inventory file mixes pure helpers with effectful collectors** — pure half (~30%) tests cleanly
  without the subprocess seam; split into `inventory/render.ts` (pure) and `inventory/collect.ts`
  (effectful).
- **Router file serves five concerns** (boot, entrypoint registry, file-provider, CORS singleton, IP
  cache) — each is small but they have different lifetimes; split.
- **`decideRunAction` should be its own pure module** — already exhaustively tested; currently
  re-exported through two files.
- **`parseDockerPullLine` is a pure state machine living in an effectful file** — extract.
- **`removeDockerByLabel` and `dockerOrphanSweep` share a `removeByQuery` shape** — `ls -q --filter`
  → loop → `rm -f` with differing label sets.
- **Stderr classifiers are scattered** — port conflict, name collision, no-such-container, "already
  exists in network" patterns belong in one `stderr-classifiers.ts`.
- **Sweep-and-claim is a runtime-interface concept, not docker-specific** — generalising it
  (`enumerateClaimable(identity)`, `purge(id)`) would make the runtime-swap goal achievable.
- **Five compose-style labels duplicated across `run` and `networkCreate`** — extract
  `composeDockerLabels(identity, primitiveName)` helper.
- **`engine/docker.ts` 6-line back-compat shim is dead weight** — delete after sed.
- **Unlabelled-orphan image count is reported but never auto-cleaned** — should be a one-shot
  migration helper, not perpetual inventory cost.
- **No timeout on long-lived `docker run -d` invocation** — daemon hang would block layer build
  indefinitely.
- **`DEVSTACK_KEEP_ONESHOT` env read via raw `process.env`** instead of unified env helper —
  inconsistent.
- **`writeFileProvider` re-resolves dynamic dir per call** — cheap but unnecessary.
- **Public surface trimming** — `inventory.ts`, `inspectContainerIp`, `getTraefikRouterIp`,
  `pauseContainer`/`unpauseContainer` are not in the docker barrel; intentional or oversight?
- **`DockerLabelKind` name shadows `DockerLabel` constant family** — rename to `DockerResourceKind`.
- **`renderFileProvider` throws synchronously on validation** — asymmetric with the rest of the
  layer's typed-error model; document as deliberate invariant.
- **Snapshot's `pause → commit → unpause` could be a single `commitContainerQuiescent` helper** —
  every snapshot callsite currently gates on `inspectContainerRunning` manually.
