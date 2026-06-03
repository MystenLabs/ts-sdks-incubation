# Snapshot clean rewrite — ONE unified flow

Owner decision: **all snapshotting is the same flow** — gracefully stop everything →
snapshot (docker commit + capture local files) / swap-in (restore) → resume if needed.
No offline-vs-live split, no dual transport, no background-task/ack/progress ceremony.
Target: replace the ~4,000-LOC `orchestrators/snapshot/` + ~450 CLI + reservation +
transport machinery with a thin (~1,500) subsystem. This also fixes the red matrix
(graceful stop flushes RocksDB → walrus blob survives).

## The one flow

`run(op, id)` where `op ∈ {capture, restore}`:

0. **gather (BEFORE stop, plugins live):** run each participant's identity +
   contribution effects to concrete values; resolve managedContainers label tuples +
   declared subtrees. Merge identity + `requireIdentity` fail-closed HERE (capture) /
   run identity-guard fail-closed (restore) — before any mutation. (Plugin state is
   gone after stop, so this must precede it — the gather-before-drain lesson.)
1. **graceful stop all** managed containers — reuse the lifecycle stop (`stopWithGrace`
   → `docker stop`, SIGTERM + grace). This FLUSHES RocksDB/WAL → the committed image is
   faithful (the walrus capture fix). No `quiesce` hook needed; the graceful stop is the
   flush.
2. **mutate (while stopped):**
   - capture: `docker commit` each stopped container → one deduplicated image bundle;
     `tarHostTree` the gathered subtrees; write `meta.json` LAST; publish via
     `stageAndSwap` to `snapshots/<id>`.
   - restore: load the snapshot image bundle + retag each to its original imageName;
     `stageAndSwap` the host-tree in, preserving `cache/<DEPLOY_CACHE_NAMESPACES>` +
     control files; (containers are already stopped — no separate hard-rm needed).
3. **resume:** bring the stack back by **recreate-from-image** (reuse the reconciler
   converge / `decideRunAction` recreate — NOT `docker start`, which walrus nodes exit
   on) and **WAIT for write-readiness** before returning. For capture this restores the
   same state (the commit captured it → non-destructive); for restore it's the snapshot
   state.

Triggered identically by CLI (boots-or-attaches) and by a dashboard button (submits the
same op). The dashboard snapshot **list** stays read-only.

## Thin module set (~1,500 LOC target)
- `snapshot-catalog.ts` — ONE reader (list + name/id resolve with ambiguity guard);
  CLI + dashboard both use it (one pure parser; sync + Effect I/O wrappers may fork).
- `snapshot-run.ts` — the unified `run(op)` flow (gather → stop → mutate → resume).
- `snapshot-capture.ts` / `snapshot-restore.ts` — the mutate-step bodies.
- `descriptor.ts` (slim), `identity-guard.ts` (keep), `errors.ts` (inline failPhase, no
  factory), `wipe.ts` + `prune.ts` (keep via reconcile), thin `service.ts`.

## DELETE (accidental abstractions — rewrite their unit tests)
background-task state machine (`startBackgroundSnapshotCapture` + seq/skip/ack),
ack-correlation (`snapshotCaptureAckFromEvent`/`pendingCaptures` in up.ts), granular
per-phase progress ceremony (`SnapshotCaptureProgressPhase` + onProgress plumbing),
`phase-error.ts` factory (inline), the gather/commit-as-separate ceremony (fold into the
one flow), the over-abstracted `SnapshotOrchestratorService` participant registry where
it's ceremony, the dual offline/live process paths (one path), `cli/snapshot-reader.ts`
(fold into the one catalog reader). Re-evaluate `snapshot-reservation` — if the whole
stack is stopped for the (fast) snapshot, `stack.lock` likely suffices; keep only the
lock-safety INVARIANT, not necessarily the separate module.

## INVARIANTS — sacred, gated by the UNCHANGED e2e tests (do NOT rewrite these)
- survival matrix (`test/e2e/snapshot-restore-matrix.test.ts`): sui/walrus/seal/deepbook/
  codegen survive restore; S2 rolls back; cache-wipe orphans loudly.
- warm-restart id-stability (`test/e2e/private-content-boot.test.ts`).
- identity-guard fail-closed BEFORE any mutation.
- walrus **per-node distinct images** (silent-data-loss fix).
- capture non-destructive (resume restores same state) / restore destructive.
- lock-safety (no roster-heartbeat starvation during the snapshot).
- name-vs-id ambiguity guard.

Unit tests are rewritten to the new internals; the e2e invariant tests are the contract
and must stay green at every step.
