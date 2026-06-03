# Snapshot unification + walrus cleanup — consolidated findings (authoritative)

Single durable record so these hard-won facts stop getting re-discovered. Supersedes
the snapshot sections of `snapshot-redesign.md` and the spec in `snapshot-clean-rewrite.md`
(kept as inputs). Branch `mh/devstack-stage-a`.

## A. The decision: snapshot IS lifecycle management (ONE flow)

All snapshotting is the SAME flow, a parameterization of the unified lifecycle
reconciler — NOT a separate subsystem:

> **gracefully stop everything → snapshot (docker commit each container + capture local
> files) / swap-in (restore) → resume if needed.**

- Same path for every trigger (CLI / dashboard button / second shell). No offline-vs-live
  split, no dual transport, no background-task/ack/granular-progress ceremony.
- It is `reconcile(...)` with the mutate-step in the middle: `up`/`down`/`restart`/`wipe`/
  `restore`/`capture` are all `stop → mutate → resume` over the graph.
- **This was DESIGNED (the reconciler) but never implemented for snapshot** — the
  lifecycle workflow hedged ("capture is an export sibling, NOT a reconcile
  parameterization") and snapshot stayed a ~4,000-LOC separate subsystem; the bounce was
  reverted when walrus broke. The clean rewrite is the follow-through that was dropped.
- Thin target ~1,500 LOC: one catalog reader, capture/restore mutate-steps, identity-guard,
  slim descriptor, thin service; the stop/resume mechanics live in the lifecycle, not here.
- **Identity/contribution must be gathered BEFORE the stop** (plugin resolved-state is gone
  once scopes close) — the gather-before-drain lesson; fail-closed `requireIdentity` /
  identity-guard runs here, pre-mutation.

## B. Walrus cleanup — the hard-won container facts (DO NOT re-learn the hard way)

1. **Walrus storage-node containers EXIT on `docker start`** after a graceful stop
   ("container did not reach running after docker start (state=stopped)"). You CANNOT
   resume a walrus node by `docker start`.
2. **Resume must be RECREATE-from-image**, and then **WAIT for write-readiness.** Recreated
   nodes come up but re-sync their committee/epoch; writing too soon →
   `Too many failures while writing blob to nodes`. The earlier full-plugin bounce's ONLY
   real failure was writing before the nodes were write-ready.
3. **A graceful STOP (SIGTERM + grace) flushes RocksDB** memtable → SST, so the committed
   image is faithful. **`docker pause` (freezer cgroup) does NOT flush** (memtable stays in
   RAM, not in the committed image) → the just-written blob is lost. This is the ORIGINAL
   walrus capture-survival regression (Stage-D-era; the flush/quiesce was lost). The
   graceful-stop flow fixes it for free.
4. **One DISTINCT image tag PER storage node** is mandatory (the silent-data-loss fix —
   a shared tag collapses N nodes' committed RocksDB to one). Load-bearing invariant.
5. **Seal vault survival is DOWNSTREAM of walrus** (seal ciphertext lives on walrus) —
   vault-seal `s1Survived=false` whenever walrus fails; fix walrus and seal follows.
6. **The resume mechanics (recreate + wait-write-ready) belong in the LIFECYCLE
   reconciler's resume**, not bespoke in snapshot — every `up`/`restart`/`restore`/capture
   resume needs it. Fix once, all paths inherit it. (This is the unification payoff that
   was missed.)

## C. Sacred invariants — gated by the UNCHANGED e2e tests (never "rewrite" these)
- survival matrix `test/e2e/snapshot-restore-matrix.test.ts`: sui/walrus/seal/deepbook/
  codegen survive restore; S2 rolls back; cache-wipe orphans **loudly**.
- warm-restart id-stability `test/e2e/private-content-boot.test.ts` (decrypt depends on
  chainId / vault pkg / seal ids not churning).
- identity-guard **fail-closed BEFORE any mutation** (cross-chain refusal).
- walrus per-node distinct images (B.4).
- capture non-destructive (resume restores same state) / restore destructive.
- lock-safety (no roster-heartbeat starvation during the snapshot window).
- name-vs-id ambiguity guard.
- **deploy cache is the sole source post-D1** — preserved across restore's stage-and-swap
  (`DEPLOY_CACHE_NAMESPACES`); restore reuses it so ids are stable (no fresh-id orphaning).
  Survival-after-restore alone proves nothing post-D1; the cache-wipe phase is the teeth.

## D. Why the reductions kept coming up small (meta — so we don't repeat it)
- A–E + lifecycle netted ~0 src: **relocation, not removal** (added abstractions ≈ deleted
  systems; the 882-LOC reconciler added ~as much as it removed).
- **Dead-code hunting finds ~nothing** (the no-orphan-exports test already bars orphan
  exports). The real wins are **duplicate LIVE implementations + over-built systems**.
- Review approaches that reason "from the current code" defend every abstraction a test
  pins → 3.4% cuts. The fix: **blind minimal reconstruction from user-need**, with a
  defender bar of **default-cut / tests-don't-justify-keep / invariants-or-user-need-only /
  feature-tradeoffs→owner**.

## E. Current state + parked work (so nothing is lost)
- **Committed:** Phase A (`b867f719`, reconciler foundation), B (`599da5be`, fs-plan +
  wipe/prune via reconcile), C (`b06b1bd0`, restore via 4-step reconcile), dead-code
  (`1fcf5f1d`, −580 incl. the fully-dead `cross-process/lock.ts` service). Design docs
  committed (`5653f05c`).
- **Parked (recoverable):** tag `parked/capture-bounce` (`88adc857`) — both bounce
  attempts (container-level `docker start` + full-plugin recreate); both failed walrus
  differently (B.1 / B.2). Kept for salvage; the approach is superseded by graceful-stop +
  recreate-resume-with-readiness.
- **Matrix is RED at Phase C** (walrus/seal — the original B.3 regression). The clean
  rewrite (graceful-stop flush + recreate-resume-wait-ready) is what turns it green.
- **In flight:** full-system review `w2l1bxy2r` (holistic minimal design + ordered rewrite
  plan with the fixed defender bar) — must land + be owner-approved before the rewrite.

## F. Next (after the full-system review)
Ordered rewrite, invariant-gated: lifecycle spine + resume-walrus-fix FIRST → snapshot
dissolves into it (thin capture/restore mutate-steps + one catalog reader) → matrix green.
Do NOT rebuild snapshot wiring into systems the review eliminates (read-models, transport).
