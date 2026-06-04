# Devstack Simplification — Execution Plan & Progress

Living tracker for the owner-approved simplification (decisions in `simplification-roadmap.md` → "OWNER DECISIONS").
Status: `[ ]` todo · `[~]` in progress · `[x]` done · `[-]` deferred/blocked

## ⚠️ Coordination (active as of 2026-06-04)
- sui-tools-external-pg MERGED (adaf37e1). Sui indexer now uses a self-owned Postgres SIDECAR (`sui/index.ts` imports `bootPostgresSidecar`/`credentialedUrl`/`withDatabase` from `plugins/postgres`). That sidecar is load-bearing.
- **A SECOND parallel workstream is now "fixing postgres issues."** → **Do NOT touch `plugins/postgres/**` or the postgres-plugin decision is ON HOLD.** The `postgres()` plugin "extract-then-delete" is DEFERRED until that settles (and the keep/delete decision may change again).
- **Spans strip must EXCLUDE postgres** files (`postgres/spans.ts`, withSpan in postgres) until the parallel postgres work lands — do sui/substrate/orchestrators/dashboard spans first, postgres last.
- Working on branch `mh/devstack-cleanup` (off mh/devstack-stage-a). Steps 0+1 batch committed there.

## Honest target
~7–10k of git-tracked **src** removed (84k → ~74–77k) + ~9.6k off the npm tarball + proportional test deletion.
Machinery removed, every real feature kept. Biggest single lever = the substrate state-model collapse (#12).

---

## Step 0 — PR #21 correctness fix (merge gate)  `[x] DONE` (typecheck + 1862 unit tests green)
Boot-time restores ran before participant registration → identity guard always failed (warm silently dead; interrupted-restore sentinel never cleared). FIXED via the "empty participants ⇒ no live stack ⇒ skip ONLY the contribution guard (keep runtime guard)" contract — zero call-site churn; deleted the redundant `snapshotIdentityParticipants` helper; 3 regression tests added. Files: orchestrators/snapshot/{restore,service}.ts, orchestrators/warm/hooks.ts, cli/wirings/{up,snapshot}.ts, test/orchestrators/snapshot/restore.test.ts.

## Step 1 — clear-cut strips (low-risk, shrink the field)
### 1a. Isolated chunks — `[x] DONE` (committed on mh/devstack-cleanup, all green)
- `[x]` **account → minimal**: kept ephemeral + impersonate + signer; deleted keystore/env/inline variants (`signer` is the one BYO door); migrated tests + docs. **−308 LOC**.
- `[x]` **deepbook drop zero-arg synthesis**: deleted synthesize.ts; fail-fast `DeepbookConfigError` on missing publisher/package/pools. **Plus**: the entire `bootstrap-assets/` Move tree + `move-assets` shipping + fetch/build scripts were now DEAD (synthesize was the sole consumer; explicit deepbook publishes via `localPackage`) → DELETED. **This makes Step-4 deepbook on-demand-fetch MOOT** (explicit deepbook needs no bundled Move). ~−800 src + ~9.6k off tarball.
- `[x]` **docker dead methods**: deleted followLogs/sweepOrphans/saveImage(singular)/pause/unpause + logs.ts; kept pauseAndCommit/removeManagedContainers/saveImages. Cleaned ~24 test mocks. **−248 src**.
- `[ ]` **inert reconcile spec wrapper** (`substrate/runtime/reconcile/**` + call sites): delete ReconcileSpec/Scope/Target/Direction + the inert reconcileGraph wrapper; inline graph axis to teardownKeys/acquireKeys; keep executeFsPlan/ReconcileFsOp + per-op failers + plan(). (~230 LOC) — NOT YET (touches restore.ts; do after step-0 settled — now unblocked).
### 1b. Observability surgery (do together; cross-cutting)
- `[ ]` **FormatterRegistry delete** (`observability/formatter-registry.ts` + harvest wiring + `api/plugin-errors.ts` signature): dead at runtime; keep every `X_ERROR_TAGS` + cascade-formatter. (~420 LOC)
- `[ ]` **spans strip-all** (~1,227 LOC, ~115 files): delete `span-store.ts` + recording Tracer + dashboard Traces tab + GraphQL Span type; remove 235 `withSpan` + 12 `spans.ts` vocab + 73 `annotateCurrentSpan`. Keep SpanAttr keys still used by logging (inline as constants). **Blocked on sui/postgres WIP** (overlaps both plugins).
- Sweep: orchestrator runs typecheck + non-e2e tests once after all chunks land; fix fallout.

## Step 2 — cross-host / NFS drop  `[ ]`
Single-host only (keep parallel-stacks + same-host `up`/`apply`). Drop foreign-host/NFS branches in roster/liveness/stack-lock/command-channel/versioned-doc-sync + the "architecture-mandated" cross-host network + container-claim ledger (+ dead sweepOrphans reader). fork-orchestration NFS holder check → plain same-host PID+start-time. (~1,000–1,400 LOC)

## Step 3 — substrate state-model collapse (the main event)  `[ ]`
Collapse 8 systems → one state model. Keep supervisor core + contribution pipeline verbatim; keep control-plane (dashboard). Merge the 4 projection read-models; inline strategy-registry + lifecycle-facts; simplify scoped-registry single-mode LWW → plain `SubscriptionRef<Map>` (keep the multimap). e2e suite as safety net. (~1.5–4k LOC + large conceptual win)

## Step 4 — runStack-as-seam + deepbook on-demand fetch  `[ ]`
- `[ ]` Invert so CLI/TUI consume `runStack`'s RunHandle (one boot path); dedupe the Deferred/fork machinery.
- `[ ]` Deepbook: stop shipping `move-assets` in `files`; fetch-cache pinned rev at first `apply` into a user cache; add prefetch + `DEEPBOOK_MOVE_SOURCE`.

## Step 5 — follow-ups  `[-]`
- `[-]` Revisit **postgres** delete (after the external-pg work settles + owner confirms).
- `[ ]` Add a **fork-mode example/doc** so it stops looking unused.
- `[ ]` Warm fingerprint hardening beyond the Step-0 fix (import-graph hash + `SEAL_MOVE_SOURCE_OVERRIDE`).

## Decisions ledger (quick ref)
fork **keep** · TUI **keep** · postgres **defer** · cross-host **drop** · warm **fix** · runStack **keep+seam** ·
deepbook **on-demand+explicit** · Traces/SpanStore/FormatterRegistry **drop** · spans **strip-all** ·
snapshot **keep insurance / strip ~40** · account **minimal (ephemeral+impersonate+signer)** · prune-picker **keep** ·
substrate **go all-in** · docker-dead/reconcile-wrapper/container-claim **delete**.
