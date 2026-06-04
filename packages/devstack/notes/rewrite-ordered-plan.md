# Devstack rewrite — verified ordered plan (full-system review, fixed-bar)

Output of the holistic review with the FIXED defender bar (default-cut, tests-don't-
justify-keep, invariants-only, feature-tradeoffs→owner). The review **self-corrected its
own inflated estimates** under adversarial verification — that's the credibility signal.

## Honest LOC accounting (verified against source, not notes)
- The unified design's "~82.9k → ~54k (−28.9k)" is **NOT real.** Adversarial verification
  cut the big cross-system claims to their true removable:
  - command-path 4,600 → **375**
  - read-models 5,300 → **400** (spine already minimal)
  - lifecycle 2,400 → **400** (mostly already shipped)
  - router 1,988 → **400** (rest is load-bearing cross-process arbitration)
  - sui 1,500 → **10** (per-mode bodies are irreducible divergence, not duplication)
- **~10.5k gross removable; ~6.8k ALREADY SHIPPED** (A–E: plugin inversion 5,900 +
  state-store 450 + read-model spine + Sui dispatcher + lifecycle residual).
- **Genuinely PENDING removal ≈ 3,800–4,200 LOC, dominated by snapshot (~3,042).**
- There is **no hidden ~29k of dead systems.** The codebase is mostly load-bearing. The
  real win is **fewer systems** (7 lifecycle flows → 1, 2 scoped maps → 1, capabilities
  mediation deleted) — and that's largely already banked in A–E.

## Ordered rewrite (each step invariant-gated; orchestrator sweeps once at the end)
0. **Verify the spine (delete nothing):** reconcile/{spec,graph,fs-plan} + the 7 flows
   already route through reconcileGraph/reconcileLabel; `decideRunAction`+`ensureContainer`
   stay verbatim. GATE: full suite + matrix + private-content-boot green (matrix is RED now
   — STEP 2 turns it green).
1. **Command-path dissolves into the spine (~375), BEFORE snapshot:** delete
   `background-tasks.ts` token Ref-machine → Effect `forkScoped` + `Fiber.interrupt`;
   inline command-loop switch into `dequeue→reconcile→await Exit→ack/fail`; one
   `publishReply`. KEEP the ndjson file-channel (~300) + the cross-process arbitration trio
   (roster/stack-lock/liveness/reservation ~1,613). GATE: boot-concurrency + Bug-#13.
   **+ FOLD IN PR#3 (cleanup hunt):** seal the plugin contribution buffer after `start`
   returns (`acquire-node.ts`) — freeze it + throw loud on push-after-seal, so a late async
   `ctx.*` fails loudly instead of being silently dropped.
2. **SNAPSHOT dissolves into the lifecycle bounce (~3,042 — the big one):** capture =
   stop→commit+tar→restart (graceful stop flushes RocksDB; resume = recreate + wait-write-
   ready, NEVER docker-start — the walrus fix); restore = ordered [identity-guard step0 →
   swap-tree(untar)+preserve → hard-rm → converge]. Delete pause-window/quiesce/live-
   background-capture/dual-CLI-path/snapshot-reservation(187)/2nd-tar-parser/integrity.json;
   deploy-cache double-store → live-cache-only (wipe couples cache+snapshots). KEEP-IN-
   MINIMAL: identity-guard, walrus per-node distinct images, LIVE_RESTORE_PRESERVED_PATHS.
   GATE (CRITICAL): snapshot-restore-matrix (all survive) + private-content-boot. This fixes
   the red matrix AND is the largest cut.
   **+ FOLD IN PR#1 (cleanup hunt):** add a fail-closed cache-existence preflight in restore
   — post-D1 the live `cache/<DEPLOY_CACHE_NAMESPACES>` is the SOLE source; if it's missing,
   restore must REFUSE (typed `cache-missing` error) rather than silently re-deploy with
   fresh ids (which orphans all pre-snapshot objects). Matches the identity-guard-before-
   mutation posture.
3. **Read-model spine — VERIFY-ONLY** (already minimal; the "divergent health bucketing"
   and "11,800-LOC observability" premises were FALSE — observability is 2,095 and the
   per-service rings deliberately fix a crash-loop bug → keep). ~0.
4. **Router E3 endpoint adapter (~400):** fold the 3-way endpoint fan-out
   (router/manifest/projection) into ONE adapter off ResolvedRoute via `ctx.endpoint`. Do
   NOT touch lease/stale-sweep/dispatch-file (that's the router owner-decision). GATE:
   parallel-stack collision scenario.
   **+ FOLD IN codegen dedup (codegen-emit run):** extract ONE pure `stackSubpath(root,
   ...segments)` composer in substrate; call it from both the runtime (RuntimeRoot) and
   codegen (appRoot) instead of the hand-rolled `.devstack/stacks/<stack>` in
   `codegen/output-location.ts`; collapse the two `resolveCodegenOutput` call seams
   (`run-stack.ts` + `build-verb-layers.ts`) into one. Codegen STAYS a separate orchestrator
   (appRoot/HMR, pure projection regenerated from cache) — only the path vocabulary is shared.
5. **Owner-gated (LAST, all net-zero/relocation — recommend SKIP unless owner wants):**
6. **Minimality sweep:** one typecheck+test+build; delete-or-relocate check; `git rm` the
   shipped plan docs; final honest LOC accounting.

## Owner decisions (surfaced instead of auto-defended)
- **Router architecture (default KEEP):** the router is a cross-process (userId,
  dockerContextId) **profile singleton** (outlives any one `pnpm dev`), NOT per-stack.
  Keeping lease/stale-sweep/reuse/dispatch-parse prevents 3 real bugs (force-removing a live
  sibling's Traefik, route-collision clobber, stale dead-sibling routes). Option (b)
  per-stack router only removes arbitration by removing the shared resource, at the cost of
  N Traefik containers + N networks. **Recommend: keep (a).**
- **Dashboard narrowing relocation (net ~0):** move `dashboard/domain.ts` (1,118) narrowing
  into per-plugin contracts — moves complexity, doesn't remove it. **Recommend: skip.**
- **GraphQL schema codegen (net ~0):** replace hand-written Pothos (1,219) with TS-interface
  codegen — trades one hand-maintenance for a build step. **Recommend: skip** unless wanted.

## Sources combined (so nothing is lost)
This plan merges: the full-system review (w2l1bxy2r, the spine), the snapshot minimal
reconstruction (wsvoxfatu → snapshot-walrus-findings.md), the codegen-emit run
(stackSubpath dedup, STEP 4), and the cleanup hunt's PR comments (PR#1→STEP 2, PR#3→STEP 1).
Superseded: the over-conservative duplicate-systems hunt (wmsypsgul). OPEN: **PR#2 needs a
reply on the PR** — verified NOT a bug (scoped-registry `setSingle` append-without-prune is
the intentional seq-tagged LWW design; the per-scope finalizer bounds it). NOT YET AUDITED:
whether the ALREADY-SHIPPED rewrites fully captured their deletions (see the lock.ts find).

## What this means
The genuine remaining work is **STEP 1 (command-path, ~375) + STEP 2 (snapshot, ~3,042,
fixes the matrix) + STEP 4 (router E3, ~400)** ≈ ~3,800 LOC, plus the system-count wins.
Snapshot is the headline. Owner-decision items are net-zero relocations (recommend skip).
