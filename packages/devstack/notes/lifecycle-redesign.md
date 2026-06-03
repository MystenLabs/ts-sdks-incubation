# Devstack lifecycle + state-management — unified redesign

Authoritative plan from two read-only workflows (`unified-lifecycle-redesign`,
`codegen-emit-unification`), each map → unify → adversarial-challenge → plan.
Supersedes the snapshot-only direction in `snapshot-redesign.md` §6 (kept for the
snapshot-specific detail). Branch `mh/devstack-stage-a` @ `fda5c512`.

## 1. The honest LOC reality (read this first)

The −9,266 from the reverted "radical reduce" was **feature removal**. Keeping
snapshot save/restore + its survival tests (which we are), the win is
**system-count, not line-count**:

- The **lifecycle reconciler unification alone is ~−250 to −450 LOC.** The
  collapsible part is *choreography* (~600–800 LOC of plan/drain/converge/lock
  duplication); the new shared reconcile body adds back ~250–350. The real code
  (capture, restore image-bundle/preflight/identity, the stage-and-swap / cache /
  container primitives, all survival tests) is irreducible or load-bearing.
- The **bigger cut is the snapshot bounce**: adopting the owner-approved
  `stop → commit → restart` for *capture* deletes the pause/freeze coordination,
  the per-plugin `quiesce` hooks, the live background-capture task + ack plumbing,
  the dual CLI process path, and the `snapshot.reservation` lock + their tests —
  realistically **~−2k to −3.5k** src+test, feature intact.
- **Net realistic (both): ~−2.5k to −4k.** Not −9k. −9k requires deleting the
  feature, which the owner has rejected.

Treat LOC as a side effect; the goal is **fewer systems** (7 hand-written flows →
1 reconciler + 1 export sibling + codegen sibling).

## 2. The unified model (validated; every invariant adversarially challenged)

ONE `reconcile(precondition, target, fsPlan, cachePolicy, scope, direction, locks)`
over three axes:

- **container target** `{running | absent}` — `decideRunAction` still picks the
  action (`fresh|adopt|unpause-adopt|resume|recreate|refuse|stop`); the caller
  only declares intent. Engine unchanged.
- **fsPlan** — one `stageAndSwap` vocabulary: `swap-tree` / `sweep-children` /
  `untar-artifact` / `tar-subtrees` / `preserveFromTarget` / `preserveOnPreseed`.
- **cachePolicy** — a **pair** `{cacheDisposition, snapshotsDisposition}` over the
  content-addressed `cache/<ns>/<chain>/<hash>` store: `reuse-verified` (default;
  *this* is warm-restart id stability) / `preserve` / `drop` / `reap-byproducts`.
- **scope** — sum type `graph-keys(subset)` (in-supervisor, dep-ordered) |
  `label-tuple({app,stack[,plugin,role]})` (out-of-supervisor, flat sweep).
- **direction** — `converge` (forward dep order) | `drain` (reverse).

Each flow becomes a constant assignment:

| Flow | target | fsPlan | cachePolicy | scope | direction |
|---|---|---|---|---|---|
| up (cold+warm) | running ∀ | none (codegen swap-tree post-acquire) | reuse-verified | graph-all | converge |
| down | absent-keep-layer (stop≠rm) | none | preserve | graph-all | drain |
| restart | — | none | reuse-verified | graph-subset | drain∘converge |
| restore | (ordered, below) | swap-tree(untar)+preserve | preserve | graph-all−keepAlive | converge |
| wipe | absent-hard (rm) | sweep-children+reap-empty | preserve \| drop (`--keep-cache`) | label({app,stack}) | drain |
| prune | — | reap meta-missing | reap-byproducts | label(role=SNAPSHOT_IMAGE) | gc |
| **capture** (export sibling) | paused/stopped-committed | tar-subtrees→swap-tree | none (D1) | label-enum | export |
| **codegen** (sibling) | — | swap-tree(generated/)+preserveOnPreseed | — | per-stack appRoot | — |

- **cold vs warm boot collapses to zero code** — it's the cache `lookup→verify→
  reuse|produce` loop resolving per-artifact, not a branch.
- **capture, with the approved bounce**, is `drain → (commit each stopped
  container + tar subtrees + write meta) → converge` — which deletes the
  pause-window machinery. It stays a distinct *export* entry (data flows
  live→artifact), but reuses the reconciler's drain/converge for the bounce.
- **restore is an ordered destructive pair**, NOT adopt:
  `[precondition: identity-guard fail-closed BEFORE first mutation]` →
  `fsPlan swap-tree(untar)+preserve(per-ns cache + control files)` →
  `R1 hard container rm (label-scope, policy-independent)` →
  `R2 converge recreate-from-fresh` (decideRunAction picks up restored images).

## 3. Load-bearing guardrails (the adversarial pass — must hold or it breaks)

1. **cachePolicy is a `{cache,snapshots}` pair**, never a coarse enum. Wipe's
   wholesale preserve predicate and restore's per-namespace + control-file
   preserve list stay **two projections**; control-file preservation
   (command-channel/roster/claims/reservation) is a restore-direction constant,
   never folded into cache policy. (Else warm-restart ids churn / command-channel
   breaks. Guard: `private-content-boot.test.ts`.)
2. **identity-guard is a typed precondition** — ordered step 0, runs **before** the
   first mutation (the docker load/tag inside the swap build). (Guard:
   `restore.test.ts:214/263` — sweep/load/tag calls === [] on mismatch.)
3. **Post-D1 truth**: capture writes NO cache copy into the artifact; the **live**
   cache is the sole source and is preserved across restore. Drop any
   "overwrite:false / restore-wins-over-live on cache" claim. (Guard: matrix
   boot-3 cache-wipe orphan teeth.)
4. **Ownership arbitration stays ABOVE reconcile** in `cli/wirings`
   (`probeSupervisorPresence` → refuse | forward | require-sole-holder). Locks +
   `(pid,hostname,startTime)` liveness + sole-holder are REQUIRED declared riders.
5. **Codegen**: `preserveOnPreseed` is a distinct named rider (whole-tree pre-build
   clone, `preserveTimestamps` → HMR mtime-stability). Codegen uses its own
   `codegenLockFile` (NOT `stack.lock`). Acceptance: warm re-emit = zero mtime
   changes.
6. **Orphan-safety**: the per-container converger stays exactly `ensureContainer`
   (uninterruptible inspect→apply→publish-ports→arm-stop-finalizer prefix). The
   reconciler only chooses the target — never re-implements action execution.

## 4. KEEP verbatim
`decideRunAction` + `ensureContainer`; `stageAndSwap`; the cache
`lookup→verify→reuse|produce` loop; `identity-guard`; the **entire** snapshot
feature (capture/restore/list/delete/wipe/prune); ALL survival tests
(matrix + private-content-boot + restore.test); the cross-process arbitration trio.

## 5. Codegen verdict (separate workflow)
**Keep codegen a separate orchestrator** — it writes to `appRoot` (the
HMR-watched app source tree), not the runtime root; it has per-file no-touch mtime
discipline + TS aggregation/bindings. It has **no** capture/restore to dedup (it's
a pure projection that regenerates from the preserved cache). The **only** real
duplication: the `.devstack/stacks/<stack>` path shape is authored twice — extract
one pure `stackSubpath(stack, …segments)` composer in substrate, called with
`appRoot` for codegen and `RuntimeRoot` for substrate; collapse the two
`resolveCodegenOutput` call seams into one. Small.

## 6. Plan — two tiers

**Tier 1 — clear ROI, the "trivial feature" (recommended for this PR):**
the snapshot bounce (capture = `stop→commit+tar→restart`; restore = ordered
destructive reconcile) + the codegen path-vocabulary dedup. Deletes
pause-coordination + quiesce + live-background-capture + dual CLI path +
reservation + their tests; keeps feature + matrix. **~−2k to −3.5k. Moderate risk.**

**Tier 2 — architecture quality, low LOC, higher surface:**
the full reconciler unification of up/down/restart/wipe/prune (8 phases below).
**~−300 LOC + one mental model.** Touches the supervisor core; worth it for the
system-count reduction, skippable if LOC/risk is the priority.

### Tier 2 phases (each independently landable + green)
- P0 — seam contract types only (ReconcileSpec, structured CachePolicy). Pure add.
- P1 — extract `plan(scope,direction)` + `reconcileGraph(spec)`; rewire
  selective-restart + shutdown through it. decideRunAction untouched.
- P2 — fs-plan executor over unchanged stageAndSwap (preserve-list builders as
  direction constants; no preserve-list collapse).
- P3 — route wipe + prune through reconcile (label-scope).
- P4 — route restore through the 4-step body (precondition → swap → R1 rm → R2).
- P5 — route up/down through reconcile (graph-scope; orphan window stays in
  ensureContainer).
- P6 — hoist ownership arbitration above reconcile as a seam precondition.
- P7 — minimality sweep + `git rm` the shipped plan + log residuals to the backlog.

## 7. Decision pending (owner)
Tier 1 + Tier 2 both in PR #21; or Tier 1 now + Tier 2 as a follow-up; or Tier 1
only. (Tier 1 is where the LOC + "trivial feature" payoff is; Tier 2 is a
quality/system-count play at near-zero LOC.)
