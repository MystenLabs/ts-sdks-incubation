# 17 Snapshot (distilled)

## Purpose

Snapshot captures a point-in-time, fully-replayable image of a running stack and lets a later
`wipe + restore` cycle return the stack to byte-identical chain state, package IDs, account keys,
deploy outputs, master-keys, and indexer cursors. It is the load-bearing primitive behind "rewind to
a known-good world": integration tests, demo resets, fork rollbacks, and
`apply → save → wipe → restore → apply` regressions.

In the redesign, snapshot should be an **orchestrator** that drives a generic capture/restore
pipeline across participating components. The components themselves describe what to capture;
snapshot does not embed first-class knowledge of any particular service.

## Responsibilities

- Capture three layers of stack state into a single addressable artifact:
  1. **Stack-level scalar state** (the on-disk serialization of state-store: package IDs, port
     leases, cached fingerprints, chainId, namespaced caches).
  2. **Per-stack host filesystem tree** (every service's persisted host-side state — keystores,
     deploy outputs, fork data, indexer DBs).
  3. **Per-container writable-layer state** (RocksDB, Postgres, walrus blobs — everything living
     inside containers).
- Quiesce containers (pause if running) around any writable-layer commit so the captured layer is
  internally consistent.
- Restore each layer in an order that (a) refuses cross-chain restore before any destructive
  mutation, (b) clears stale host state before re-extracting, and (c) re-tags loaded container
  images under the names the supervisor expects so the next `apply` adopts them instead of
  rebuilding fresh.
- Provide an atomic stage-and-swap primitive that any consumer (snapshot itself, codegen, future
  participants) can use to replace a directory tree under an external watcher without ever exposing
  a half-written intermediate.
- Provide list/delete operations over the snapshot catalog that tolerate partial/corrupt artifacts.
- Provide a wipe operation scoped to one `(app, stack)` that tears down containers, networks,
  volumes, and per-stack on-disk state, with snapshots and shared upstream caches surviving by
  default.
- Surface phase-labeled errors and tracing spans so a partial failure points at the exact step.

## Snapshotable capability contract

A participating component declares — to the snapshot orchestrator — the behaviors it needs in both
directions. Conceptually:

- **Capture descriptor.** "Here are the paths/artifacts I own that must ride the snapshot." A
  participant can contribute:
  - Zero or more host-filesystem subtrees (auto-included if they live under the convention-shared
    `runtime/<service>/` root, opt-in otherwise via a registered extras key).
  - Zero or more containers it manages (identified by stable label tuples so the orchestrator can
    enumerate without service-specific code).
  - An optional typed metadata slice ("my chainId is X", "I forked at checkpoint Y") to be embedded
    in the snapshot's metadata.
- **Quiescence hook.** "Before you commit my containers, here's how to make my state consistent."
  For most services this is "pause the container"; some may need an application-level flush.
- **Pre-restore hook.** "Before you overwrite my live state, here's what you must check or clean."
  Examples: cross-chain refusal, version compatibility, side-state invalidation.
- **Post-restore hook.** "After you've extracted my files and re-tagged my images, here's what I
  need to do to be ready." Examples: re-validate a deploy artifact, warm a cache.
- **Identity guard contribution.** "Here's the slice of metadata that, if it disagrees with my
  current live identity, must refuse restore." (Chain identity is the canonical case; other
  components may contribute their own.)
- **Permission to skip.** A capture descriptor may declare itself missing-tolerant (extras paths
  absent at save time are silently skipped) or required (absence is an error). Mode bits on captured
  files must round-trip.

The orchestrator only sees this contract. It does not know what "walrus" or "seal" or "sui" mean.

## Lifecycle states

### Snapshot artifact states (on disk)

- **Absent** — no directory under the snapshot catalog for this id.
- **Partial** — directory exists, metadata is missing or unparseable. Catalog listing skips it; a
  future janitor can sweep it.
- **Complete** — metadata is present and parseable; the artifact is a valid restore source.
- **Deleted** — directory removed (idempotent file-system rm).

A complete snapshot is the contract: metadata present means save succeeded; metadata absent means do
not trust this directory.

### Restore-in-progress states

Restore today is non-transactional and passes through several observable intermediate states. The
redesign should collapse these behind an atomic swap, but the conceptual phases are:

1. **Quiescent** — pre-cleanup not yet run; live stack untouched.
2. **Identity-checked** — cross-chain guard has either passed or refused; no mutation yet.
3. **Containers torn down** — labelled containers removed (best-effort; daemon-down tolerated).
4. **Scalar state replaced** — the on-disk state-store file overwritten from the snapshot.
5. **Host tree wiped and re-extracted** — runtime root cleared, then untarred (orphan files from the
   live state are purged by construction).
6. **Container images loaded and re-tagged** — each container tar loaded; re-tagged under the
   originally-recorded image name so the supervisor's reuse probe adopts it.
7. **Extras re-extracted** — each opt-in extras tar restored to its registered path.
8. **Ready** — return; next `apply` is expected to adopt the snapshot without rebuilding.

Mid-phase interrupt today leaves the stack in a torn state and requires a full re-run. The redesign
should either bracket the whole restore behind one atomic swap or make every phase individually
re-runnable with the same final result.

## Inputs / dependencies

- A resolved `(app, stack)` identity, plus the resolved on-disk paths for that stack's scalar-state
  file, host runtime tree, and snapshot catalog directory.
- A way to enumerate containers belonging to `(app, stack)` via stable label filters (not
  service-specific names).
- A capability to pause, commit, save, load, tag, and inspect containers, plus to remove them by
  label.
- A capability to create and extract tar archives that preserve mode bits and tolerate cross-UID
  extraction (saver UID may differ from restorer UID).
- A capability for atomic directory replacement on the same filesystem, with a documented non-atomic
  fallback for cross-filesystem targets.
- File-system, path, and process-spawn capabilities from the environment.
- The set of registered snapshotable participants (see capability contract).
- Optional caller-supplied identity assertions (e.g. expected chain identity) that the orchestrator
  threads into the appropriate hook.
- For wipe: the same label-filter machinery, plus the right to delete labelled networks/volumes and
  per-stack on-disk dirs, with snapshots and shared upstream caches surviving by default.

## Outputs / capabilities provided

- A snapshot save operation that produces an addressable artifact carrying scalar state, host tree,
  container images, opt-in extras, and a single canonical metadata record.
- A snapshot restore operation that consumes such an artifact and mutates a live stack to match.
- A snapshot list operation that enumerates the catalog and surfaces per-artifact metadata,
  tolerating partial/corrupt entries.
- A snapshot delete operation scoped to one artifact id.
- An atomic stage-and-swap primitive usable by any subsystem that needs to replace a directory tree
  under external watchers without exposing a half-written intermediate.
- A wipe operation that tears down a stack's live footprint without touching the snapshot catalog or
  shared upstream caches by default.
- Phase-tagged errors and tracing spans pinpointing the failing step.
- A typed metadata record per artifact: creation time, app, stack, network, whether the host tree
  was included, what containers and extras were captured, and per-participant typed metadata slices.

## Invariants and constraints

- **Atomic swap.** External watchers attached to a replaced directory must never observe a
  half-written tree. Same-filesystem rename guarantees this; cross-filesystem fallback must log
  loudly and is the only exception.
- **Cross-chain refusal.** When both the snapshot and the live stack carry a known chain identity
  and they disagree, restore must refuse before any destructive mutation. If either side's identity
  is unknown, the guard cannot fire — the system should make this case rare by design rather than
  silently lenient.
- **Per-(app, stack) scoping.** Both container enumeration on save and pre-cleanup on restore must
  filter on the full identity tuple, never on stack alone. Cross-app clobbering is a correctness
  violation.
- **Integrity of captured files.** Mode bits (notably `0o600` for secret material — account keys,
  master keys, node keys, wallet tokens) must survive tar round-trip. Cross-UID extraction must not
  fail with EPERM.
- **Container quiescence.** A running container must be paused around the writable-layer commit; the
  unpause must fire on both success and failure paths (no orphaned paused containers). A stopped
  container is already quiescent and must not be paused.
- **No torn host state on restore.** The host tree must be cleared before extraction so orphan files
  from the live state are removed; rolling back to a snapshot must not leave residue from "the world
  it's rolling back from".
- **Re-tag on restore must run.** A loaded image carries a transient tag; without re-tagging under
  the originally-recorded image name, the supervisor's reuse probe sees a name match but image
  mismatch, recreates from a fresh base, and runs a brand-new genesis — chain state silently lost.
- **Partial saves are inert.** A crashed save must leave a directory the catalog can safely skip (no
  parseable metadata = invisible). A partial save must never break list/delete of sibling artifacts.
- **Pre-cleanup is best-effort.** Daemon down, no matching containers, permission errors must not
  fail the restore (the destructive mutation that follows is what carries semantic weight;
  pre-cleanup is hygiene).
- **Identity guard runs before destructive mutation.** Cross-chain refusal must precede pre-cleanup,
  scalar-state copy, and host-tree wipe. The current ordering is correct but the dependency should
  be explicit, not implicit.
- **Metadata is authoritative.** If metadata is missing or unparseable, restore must not silently
  downgrade to a partial restore that drops re-tag, pre-cleanup, and extras — that path quietly
  loses chain state. Either refuse, or surface a clear warning.

## Edge cases and known failure modes

- Empty/first-boot stack: scalar-state file absent, host tree absent. Save succeeds as a no-op for
  those layers.
- Tar subprocess failure (EACCES, source vanished mid-walk, disk full): surfaces as a phase-labeled
  error with truncated stderr in the message and full stderr in the cause.
- Container inspect returns no image tag: surfaces as a phase error (suggests a manually-created
  container, not supervisor-stamped).
- Commit fails on a paused container: unpause must still fire; container is never left paused.
- Save image fails (disk full): the committed image lingers on the daemon unless explicitly GC'd —
  orphan image accumulation is a known footgun.
- Metadata write fails: leaves a partial directory; the catalog hides it.
- Restore of a missing id: phase-labeled error with a clear message; CLI maps to a dedicated exit
  code.
- Cross-chain refusal: phase-labeled error naming both chain identities; no disk mutation.
- Malformed/missing/old metadata: current behavior silently downgrades restore — this is a known
  correctness gap.
- Mid-restore interrupt: scalar state may already be partially overwritten, host tree may be wiped
  but not yet extracted, some container images loaded but not re-tagged. Re-running restore is
  idempotent for the host-tree and scalar-state layers; container loads accumulate harmlessly.
- Pre-cleanup with daemon down: swallowed; restore continues.
- Concurrent saves against the same id: silently overwrite. The CLI sidesteps via a random suffix in
  the generated id; the engine API has no guard.
- No locking around the host tree during save: a concurrent supervisor write can produce a torn
  file. Mitigations live in individual services (atomic tmp+rename for secret material) rather than
  in the snapshot pipeline.
- Cross-filesystem stage-and-swap promote: falls back to copy-then-rm, loses atomicity, logs a loud
  warning.
- Cross-stack restore: today permitted with a warning; semantics around chain-identity carry-over
  across stacks are not pinned down.

## Learnings from current implementation

- **Service knowledge is currently hardcoded.** The save pipeline's module documentation is
  effectively a manifest of every in-tree service's runtime paths. Adding a service today means
  either routing all its writes through the shared host-tree convention (so it auto-rides) or
  editing the CLI to register an opt-in extras entry. There is no plugin hook for either. This is
  the central pain point the redesign must resolve via the Snapshotable contract.
- **Identity guards exist but aren't threaded through.** The cross-chain refusal is implemented and
  tested at the engine layer, but the CLI does not pass the expected chain identity and does not
  populate the snapshot's own chain-identity slice. The guard is effectively dead in practice. The
  redesign must make wiring identity through the CLI a first-class responsibility of the
  orchestrator, not optional plumbing.
- **Restore is not transactional.** Mid-restore failure leaves observable torn states. An atomic
  stage-and-swap primitive exists in the same scope, is tested, and is used by codegen — but restore
  predates its centralization and does not use it. Restore should be built on top of the same
  primitive.
- **Convention beats configuration for host paths.** Services that already route through the shared
  `runtime/<service>/` convention auto-ride the host-tree tar by construction. This is the right
  default. Extras (paths outside the convention) should remain registerable but exceptional, not the
  norm.
- **Per-service typed metadata via declaration merging is fragile.** The current scheme requires the
  consumer's typed declaration to be loaded at restore-time; out-of-tree plugins get raw unknowns. A
  clearer contract on what's guaranteed about cross-version metadata access is needed.
- **Image GC is an unsolved adjacent problem.** Committed snapshot images accumulate on the local
  daemon proportional to snapshot count, with no automatic sweep.
- **Two locations exist for the snapshot catalog** — one shared across stacks, one nested per-stack
  — with wipe-time logic treating both. Canonical location should be picked.
- **Mode-bit preservation across tar is load-bearing for secret material.** Multiple services
  co-depend on this; the invariant should be stated once at the orchestrator level.
- **Stage-and-swap rollback discipline is precious and well-tested.** The primitive correctly
  preserves the caller's error tag (does not wrap), restores from backup on promote failure, and
  cleans up on interrupt. Carry this discipline forward verbatim.

## Cross-component references

- **Engine core** — owns the scalar-state file (on-disk serialization of state-store) that snapshot
  reads on save and overwrites on restore. State-store registry membership is unaffected by
  snapshot's operation.
- **Engine resources / service-paths** — defines the `runtime/<service>/` convention that snapshot
  tars wholesale. Resume after restore depends on the supervisor's reuse-if-name-and-image-match
  probe; this dependency is implicit and should be made explicit.
- **Runtime / docker** — provides the container lifecycle primitives snapshot orchestrates (pause,
  commit, save, load, tag, inspect, remove-by-label). Image cache semantics are load-bearing for
  restore adoption.
- **Sui** — current contributor of a typed metadata slice (chain identity) and of an opt-in extras
  path (fork data). Canonical example of a Snapshotable participant.
- **Walrus / Seal / Accounts / Wallet / Sui-fork / Postgres / Deepbook / Pyth / Indexer** — current
  implicit contributors via the shared host-tree convention; each owns a subtree under the runtime
  root that rides the host tree tar by construction. Some (deepbook, indexer) have intended
  regression tests that remain unimplemented.
- **Codegen** — current consumer of the stage-and-swap primitive; co-located in the same scope as
  snapshot today.
- **CLI / wipe** — wraps the engine for users; owns label-driven teardown, snapshot-catalog
  preservation, and upstream-cache preservation by default.
- **Observability** — phases enumerated as a closed tuple; spans named per operation. Adding phases
  requires touching both modules today.
- **Examples / arena** — end-to-end driver of the `apply → save → wipe → restore → apply`
  correctness assertion.

## Open questions / decisions deferred

- **Snapshot-from-live.** Whether the redesign supports building a snapshot artifact directly from a
  remote node checkpoint, or whether pre-warming a fork stack remains the only mechanism for "start
  from a known upstream state".
- **Shape of fork-mode metadata.** Whether upstream identifier and fork-checkpoint belong as
  first-class top-level metadata, or remain nested under the sui participant's slice. Existing
  placeholder tests and current schema disagree.
- **Cross-stack restore semantics.** Today permitted with a warning; whether the chain identity
  carried in the container's writable layer should be re-derived, refused, or accepted unchanged
  when restored into a different stack.
- **Resume contract documentation.** Restore's correctness depends on the supervisor's
  reuse-if-name-and-image-match probe; this dependency must be documented as a snapshot-side
  contract on the runtime/docker component, not left implicit.
- **Container enumeration ownership.** Whether the orchestrator discovers its own containers from
  the `(app, stack)` tuple, or whether the caller passes a list. Today the CLI enumerates and
  passes; programmatic callers must replicate.
- **Identity-guard fail-closed.** Whether restore should refuse when the snapshot's identity slice
  is set but the caller did not pass an expected identity — i.e. require both sides of the
  comparison rather than fail-open on either-undefined.
- **Network field semantics.** Whether snapshot must guard against cross-network restore (snapshot
  saved under one network, restored under another resolves different host paths).
- **Metadata versioning.** Whether the metadata record carries a schema version, and what restore
  does when versions disagree (refuse, warn, downgrade gracefully).
- **Snapshot-image GC.** Whether snapshot itself, wipe, or a separate prune pass is responsible for
  sweeping orphan committed images.
- **Host-tree size mitigation.** Whether the runtime tar gains per-service slicing, incremental
  snapshots, or a size threshold/warning, paralleling what exists today for fork data.
- **Delete API ownership.** Whether delete remains "directory rm only" (no engine ceremony) or grows
  hooks (e.g. to GC the byproduct images for that snapshot).
- **Canonical catalog location.** Whether the snapshot catalog lives shared-across-stacks or
  nested-per-stack. Both currently exist in different code paths.
- **Plugin-contributed metadata visibility.** Whether an out-of-tree consumer can read metadata
  slices it did not declare, or whether the API refuses access without a registered declaration.

## Opportunities noticed

- **A unified Snapshotable participant registry** is the redesign's central simplification: each
  component declares its capture descriptor, hooks, and identity-guard contribution; the
  orchestrator does not know about any specific service. This is the canonical answer to the
  "service knowledge is hardcoded" pain point.
- **Restore should be built on stage-and-swap.** The primitive exists, is tested, and is used by
  codegen. Reusing it makes restore atomic against external watchers and collapses several of the
  torn-state edge cases.
- **A single source of truth for runtime-root path math.** Snapshot today mirrors path-resolution
  logic from engine-resources rather than importing it; a small shared module would remove the
  duplication.
- **A schema version on metadata** would let restore detect old-vs-new explicitly instead of
  silently downgrading.
- **A container-enumeration helper in the engine** would let programmatic callers (tests, plugins)
  avoid replicating the CLI's `docker ps` enumeration.
- **A snapshot-image GC pass** (sweeping committed images with no surviving catalog entry) would
  close the orphan-accumulation footgun.
- **Hooks for identity wiring at the CLI layer** would close the cross-chain-guard gap end-to-end:
  read the live stack's identity on save, read it again on restore, pass it through.
- **Closed-set phase tuple** should be co-located with the orchestrator instead of split across
  snapshot and pretty-error modules — adding a phase should be a single edit.
- **Picking one canonical catalog location** removes a class of "wipe with --keep-snapshots and the
  catalog moved" confusion.
- **Either implement or delete the placeholder fork and deepbook regression tests.** `it.todo` files
  create the illusion of coverage; they should ship as real assertions in the redesign or be
  removed.
- **`runtimeIncluded` metadata field** is redundant with checking the host-tree tar's existence on
  disk; dead field.
- **A small `omitEmpty` helper** would clean up the metadata construction's three ad-hoc conditional
  spreads.
- **Centralize the snapshots-dir-name constant** rather than letting wipe's prune logic and
  snapshot's path logic hardcode the same string independently.
- **Scope-based cleanup of byproduct images on interrupt** would generalize the current
  unpause-on-interrupt discipline to other transient resources the orchestrator creates.
