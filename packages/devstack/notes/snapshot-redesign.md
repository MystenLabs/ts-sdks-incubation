# Snapshot / restore — system re-think

Status: design, pre-implementation. Branch `mh/devstack-stage-a`.

## 0. Why this exists

A "radical reduce" attempt deleted the snapshot capture/restore engine + its e2e
matrix on a **false premise** — that sui/walrus are stateless and re-init from
code+config, so the content-addressed deploy cache could stand in for snapshots.
That is wrong (see §1) and was reverted. This doc is the proper re-think: what
snapshot/restore genuinely *needs* at each layer, grounded in where state
physically lives, and where the real over-complication is — so we simplify the
*duplication* the owner originally flagged **without removing the feature**.

## 1. Ground truth — where state physically lives (this dictates everything)

A service's durable state lives in exactly one of three places, and the capture
mechanism is forced by that location:

| Service (mode) | Declares | Physical location | Captured by | User loses if dropped |
|---|---|---|---|---|
| sui (local) | `managedContainers:[validator, postgres]` | chain ledger in **validator writable layer**; indexer PGDATA in **postgres writable layer** | **`docker commit`** | the entire chain — objects, balances, every tx the user created |
| walrus (local) | `managedContainers:[storage-node-0..N]` + `subtrees:[walrus/<name>/deploy/]` | RocksDB slivers in **each node's writable layer** (one distinct image tag per node) + keypairs/configs in host tree | **`docker commit`** (per-node) + tar | uploaded blobs + deploy keys |
| seal (local-keygen) | `managedContainers:[key-server]` + `subtrees:[seal]` | `master-key.env` (0600, **host tree**, FATAL if missing) + minimal container state | tar + commit | master key → on-chain KeyServer public key orphaned |
| postgres (container) | `managedContainers:[name]` | PGDATA relocated to writable layer via Dockerfile `ENV` | **`docker commit`** | all DB schema + rows |
| deepbook (local) | `subtrees:[deepbook/<name>]` | artifact cache in host tree | tar | pool ids (else re-publish) |
| account (ephemeral) | `subtrees:[account/<name>.key]` (0600) | host tree | tar | private key |
| wallet | `subtrees:[wallet/token]` (0600, FATAL) | host tree | tar | dev-wallet pairing |
| package / coin | (no subtree) | deploy-id **metadata** in `cache/<ns>/<chainId>/` | preserved live across restore | re-publish → orphans pre-snapshot objects |

**The load-bearing fact:** `docker commit` of container writable layers is the
*only* mechanism that captures sui chain state, walrus RocksDB, and postgres
data. The deploy cache holds only deploy-id **metadata** — it lets a fresh boot
*reuse* ids **iff the chain still holds those objects**. It is not a substitute
for capturing chain/blob/db state. Removing docker-commit silently loses all of
it. (That was the reverted mistake.)

## 2. What each layer needs

### Plugin API — `contracts/snapshotable.ts` (`SnapshotableDecl`)
The shape is right. Fields and their jobs:
- `managedContainers` → which containers to `docker commit` (writable-layer state)
- `subtrees` → host paths to tar (keypairs, master-key, token, configs)
- `secretMaterial` → 0600/0700 mode round-trip
- `quiesce` → flush/checkpoint before the pause window (RocksDB/WAL)
- `preRestore`/identity → fail-closed cross-chain corruption guard contribution
- `missingTolerance` → fatal (master-key, wallet token) vs fine (optional caches)
- `postRestore` → re-validate after swap

Two couplings are currently **implicit** and should become explicit:
1. **Deploy-cache preservation** lives as a hardcoded `DEPLOY_CACHE_NAMESPACES`
   list in `restore.ts`, not in the plugin's own declaration — so a plugin's
   cache-survival is invisible where you'd look for it. Candidate: a declared
   `preservesCacheNamespace` (or move the list into the plugin decls).
2. **Container-data-location** (PGDATA redirected *off* the upstream `VOLUME` so
   commit captures it) is a Dockerfile invariant enforced nowhere. Candidate:
   boot-time assert, or a loud comment + test.

### Orchestrator — `orchestrators/snapshot/`
Owns sequencing + policy (correctly):
- **capture:** enumerate participants → `quiesce` → pause all running managed
  containers (finalizer always unpauses) → `docker commit` each → save image
  bundle → tar subtrees → merge + guard identity (conflict = fail at capture) →
  write `meta.json` **last** → atomic publish via stage-and-swap.
- **restore:** read meta → **identity-guard fail-closed BEFORE any mutation** →
  preflight every artifact → untar host-tree to staging → load image bundle →
  stage-and-swap (PRESERVE `cache/<ns>`, command-channel, roster, claims,
  reservation) → promote staged images to original names → remove old
  containers → post-restore hooks.
- plus wipe (+ `--keep-cache`), prune, identity-guard, descriptor (meta v3).

Minor layering nit: `image-bundle-tags.ts` (docker save/OCI manifest parsing) is
snapshot-domain knowledge sitting near substrate; small relocate into the
orchestrator.

### Substrate — `substrate/runtime/`
Generic, name-blind primitives, correctly shared and load-bearing:
- `host-tree-tar`, `tar/reader` (shared), `stage-and-swap` (**also used by
  codegen + seal bootstrap** — load-bearing beyond snapshot), `cross-process/
  snapshot-reservation` (O_EXCL lock), `liveness` (shared by roster / stack-lock
  / reservation / claims), `paths`, docker `save`/`load`/`tag`, `decideRunAction`
  (adopts the restored image on next boot).
- The container-image path (commit → save → load → tag → promote) is the
  mechanism that round-trips writable-layer state. Keep.

## 3. The genuine over-complication (what the owner flagged)

Snapshot/restore intent is wired through **two process paths** that duplicate the
plumbing to the same orchestrator and disagree on semantics:

- **One-shot CLI** (`devstack snapshot save/restore/list/delete`) boots an entire
  supervisor just to call the orchestrator, then tears it down.
- **Live supervisor command-channel** (TUI `s`, dashboard mutations, peer CLI)
  drives the *same* orchestrator against a running `up`.

Concrete duplication / asymmetry:
- **save** is live-aware (route to supervisor if present, else one-shot);
  **restore** is offline-only (CLI refuses if a supervisor is live).
- **restore has two semantics:** the supervisor path does
  `orchestrator.restore` **+ full drain + re-acquire**; the CLI offline path does
  `orchestrator.restore` **only** (swaps the tree, relies on the next boot to
  re-acquire). Latent correctness gap.
- **list** is implemented twice (`SnapshotReader` fs-walk vs `orchestrator.list`).
- **capture result** returns synchronously (CLI) vs via an event round-trip
  (supervisor command-channel ack).

This — not the feature — is the "duplicate and over-complicated implementation"
to collapse.

## 4. The decision: process model — separate process vs wired-in

- **A. Supervisor-owned (always live).** Capture/restore are operations the
  supervisor performs on itself. The CLI one-shot path *attaches-or-boots* a
  supervisor and submits the *same* command; offline = boot a throwaway
  supervisor, submit, exit. One code path; restore always drains + re-acquires.
  Deletes the bespoke one-shot bootstrap + the save/restore asymmetry. Cleanest
  mental model; medium risk (restore behavior unifies).
- **B. Offline-owned (stack stopped).** Capture/restore require no live
  supervisor; remove the live dashboard/TUI triggers + command-channel snapshot
  plumbing. Biggest deletion, simplest model — but loses live
  capture-without-reboot (the reason the supervisor plumbing exists).
- **C. Keep both, unify the plumbing.** One shared "attach-or-boot supervisor +
  submit snapshot command" helper used by CLI *and* dashboard; restore made
  live-aware + symmetric with save; list unified. Removes the duplication, keeps
  every current surface. Lowest risk.

## 5. Explicitly NOT doing
- Not removing `docker commit` / container-image capture (load-bearing).
- Not removing named save / restore / list.
- Not weakening the identity guard.
- Not deleting the snapshot-restore matrix e2e (it is the survival proof).

## 6. DECIDED: single `stop → commit → restart` flow (owner-approved)

Owner accepted a brief stack bounce as the price of snapshot. The snapshot
engine stops being a parallel subsystem and becomes a thin step wedged into the
**existing** lifecycle.

### Validated against the code (read-only verification)
- Graceful shutdown **stops, does not remove**: `stopWithGrace` → `docker stop`
  via the scope finalizer (`container.ts:756,1015`); no `docker rm` on graceful
  close. Writable layers survive.
- Restart **resumes by name-match**: `decideRunAction` returns `resume`
  (`docker start`) for a stopped container whose image **name** matches
  (`container.ts:148-151`) → writable layer preserved.
- Restore’s destructive path already exists: `removeManagedContainers`
  (`docker rm -f`) → promote restored image to original name → next boot sees
  `facts:null` → `fresh` → create from the restored image
  (`restore.ts:203-227,554-556`).
- `docker start` of a stopped container does **not** re-run deploy/init; the
  deploy cache (`DEPLOY_CACHE_NAMESPACES`) is preserved across restore’s swap.

So: **capture = non-destructive** (stop → commit → resume same container),
**restore = destructive** (stop → rm + load/retag + swap → recreate). Both ride
existing lifecycle actions — no freeze/quiesce/reservation needed.

### The thin module (`orchestrators/snapshot/`, post-redesign)
- `capture(meta)` — assumes containers are **stopped** (caller bounced via the
  existing drain): for each managed container `docker commit` → save to the image
  bundle; for each declared subtree `tarHostTree`; merge + guard identity; write
  `meta.json`; atomic publish via `stageAndSwap`. **No** pause/unpause, **no**
  quiesce, **no** reservation.
- `restore(id)` — identity-guard (fail-closed, before mutation) → load image
  bundle + retag to original names → `stageAndSwap` host tree (preserve
  `cache/<ns>`, command-channel, roster, claims) → `removeManagedContainers` so
  the following restart recreates fresh from the restored images.
- A single command path performs `drain (existing) → capture|restore → re-acquire
  (existing)`. CLI offline = boot → bounce → op → exit; dashboard/TUI = submit to
  the running supervisor which bounces in place. One path, not two.

### DELETE (the orchestration complexity)
- `capture.ts` pause/freeze choreography (pauseIntended/pauseConfirmed/unpause
  finalizers, `quiesceParticipant`) — replaced by commit-while-stopped.
- per-plugin `quiesce` hooks (clean shutdown flushes).
- live background-capture: `background-tasks.ts` `startBackgroundSnapshotCapture`
  + ack plumbing; `up.ts` `makeSnapshotCommandHandler`/`SnapshotCaptureAck*`/
  `PendingSnapshotCapture`.
- the dual-path bootstrap: collapse `runSnapshotCaptureDirect` /
  `…AgainstLiveSupervisor` into one bounce path; drop the offline-only restore
  asymmetry (restore goes through the same bounce).
- `cross-process/snapshot-reservation.ts` (+ `snapshotReservationFile`, re-export)
  — the stack lock covers it (we stop anyway).
- `cli/snapshot-reader.ts` fs-walk → use `orchestrator.list`.
- the now-unused command-channel `snapshot.capture` background variant.

### KEEP
- substrate docker `commit`/`save`/`load`/`tag`; `host-tree-tar`;
  `stage-and-swap` (shared w/ codegen); `tar/reader`.
- `identity-guard.ts`; `descriptor.ts` (slim if cheap); `wipe.ts`; `prune.ts`.
- CLI `save`/`restore`/`list`/`delete`; dashboard snapshot mutations (routed
  through the one path); TUI trigger.
- the snapshot-restore **matrix e2e** — adapt to the bounce flow; it stays the
  survival proof (sui chain / walrus blob / seal vault / deepbook / codegen all
  survive restore; cache-wipe orphans loudly).

### Honest LOC
The −9,266 figure was *feature removal*. Keeping the feature + its survival tests
and deleting only the orchestration complexity → realistic **−3k to −5k** src+test.
Measure, don’t promise.
