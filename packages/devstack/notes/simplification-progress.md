# Devstack Simplification — Execution Plan & Progress

Living tracker for the owner-approved simplification (decisions in `simplification-roadmap.md` → "OWNER DECISIONS").
Status: `[ ]` todo · `[~]` in progress · `[x]` done · `[-]` deferred/blocked

## Committed so far (branch `mh/devstack-cleanup`, all green — typecheck + ~1866 unit tests)
- `a9ad7167` — Step 0 PR#21 boot-restore fix + account→3 variants + deepbook synthesis & bundled-Move deletion + docker dead methods (**−1,828**)
- `16816626` — reconcile inert graph-spec wrapper inlined (**−117**)
- `83dab312` — spans strip: recording Tracer + SpanStore + Traces tab + 235 withSpan + 10 spans.ts (**−2,288**)
- `9f9610e7` — SpanAttr→LogAttr rename (now annotateLogs keys) (~0)
- `f341319d` — FormatterRegistry + dead errorContributions plumbing deleted (**−503**) — STEP 1 COMPLETE
- `360cc2be` — Step 2: cross-host/NFS drop (container-claim ledger, makeReaper, foreign-host branches, dead shared-network constant) (**−848**)
- **Session total ~−5,300 src LOC + ~9.6k off the npm tarball.** (Parallel sui/postgres workstream has since moved to its own branch.)

## ⚠️ Coordination (active as of 2026-06-04)
- The parallel postgres/sui workstream COMMITS TO THIS SAME BRANCH (`e1c960f9` landed between cleanup commits) → **verify `git status` is pure-mine before every `git add -A`.**
- Sui indexer uses a self-owned Postgres SIDECAR (`sui/index.ts` imports `bootPostgresSidecar`/`credentialedUrl`/`withDatabase` from `plugins/postgres`) — load-bearing.
- `postgres()` PLUGIN extract-then-delete is DEFERRED until the parallel postgres work settles (decision may change). Spans WERE stripped from postgres — owner confirmed no interference.
- Steps 2 (cross-host) + 3 (substrate collapse) touch supervisor/cross-process heavily — closer to the parallel work; coordinate before starting.

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
- `[x]` **inert reconcile spec wrapper** — DONE (commit 16816626, −117). Inlined the inert reconcileGraph at the 3 supervisor call sites; KEPT ReconcileSpec (label axis, used by wipe/prune) + executeFsPlan/ReconcileFsOp/plan() — audit over-scoped those.
### 1b. Observability surgery
- `[x]` **spans strip-all** — DONE (commit 83dab312, **−2,288 LOC, 128 files, 10 spans.ts deleted**). Removed recording Tracer + SpanStore + dashboard Traces tab + GraphQL Span type + 235 withSpan + helpers + annotateCurrentSpan. Reduced observability/spans.ts to the SpanAttr log-keys; sui/spans.ts kept (trimmed) as a shared log-key vocab. Deleted the obsolete span-attr-namespace style gate.
- `[x]` **SpanAttr → LogAttr rename** — DONE (commit 9f9610e7). Surviving constants are `annotateLogs` keys, not spans; renamed symbols + files (observability/spans.ts→log-attrs.ts, sui/spans.ts→log-attrs.ts) across 18 files + the name-blindness allowlist.
- `[x]` **FormatterRegistry delete** — DONE (**−506 LOC, 41 files**). Verified the cascade-formatter renders by SHAPE (only consulted the registry for a per-tag custom formatter, of which there were none) → deleted the ENTIRE dead `errorContributions` plumbing: formatter-registry.ts, api/plugin-errors.ts, the `PluginErrorContribution` field, the acquire-node harvest, the wiring, and all 13 `pluginErrorContributions(X_ERROR_TAGS)` calls. KEPT the error classes + all `X_ERROR_TAGS` (pinned by error-catalog-parity test; POSTGRES/DEEPBOOK feed passthroughOrWrap). Known-error render output unchanged.

### ✅ STEP 1 COMPLETE — all clear-cut strips landed (5 commits, all green).
- `[ ]` **dashboard `graphql-env.d.ts` regen** — stale (still lists SpanFilter/SpanRecord/spans), but DEAD (no SPA code references them). Run `pnpm --filter devstack-dashboard gql:generate` whenever the dashboard is next built. Harmless.

## Step 2 — cross-host / NFS drop  `[x] DONE` (commit 360cc2be, −848, all green)
Single-host only. Deleted: container-claim ledger (write-only dead; unwired container.ts writers, teardown still via stopWithGrace), makeReaper indirection (kept LivenessProbeScope), foreign-host liveness branches (roster + fork-orch) + dead `trustForeignHosts` field, dead SHARED_NETWORK_NAME constant, NFS comment de-scoping.
**Honest scope correction:** audit estimated ~1–1.4k but most of "cross-process" is genuinely SAME-HOST load-bearing → KEPT atomic-write (crash-atomicity on local FS, not NFS-only), reclaim-stale-file (O_EXCL TOCTOU), command-channel handoff, adoptExistingNetwork (parallel-stack race), port-reservation file, roster holder ARRAY (claim-race). Real droppable was the ledger + foreign branches, not a blanket cross-process gut.

## Step 3 — substrate state-model collapse (the main event)  `[ ]`
Collapse 8 systems → one state model. Keep supervisor core + contribution pipeline verbatim; keep control-plane (dashboard). Merge the 4 projection read-models; inline strategy-registry + lifecycle-facts; simplify scoped-registry single-mode LWW → plain `SubscriptionRef<Map>` (keep the multimap). e2e suite as safety net. (~1.5–4k LOC + large conceptual win)

## Step 4 — runStack-as-seam  `[ ]`
- `[ ]` Invert so CLI/TUI consume `runStack`'s RunHandle (one boot path); dedupe the Deferred/fork machinery.
- `[-]` ~~Deepbook on-demand fetch~~ — MOOT (done early): bundled Move + `move-assets` shipping + fetch/build scripts already DELETED in step 1a. Explicit deepbook publishes via `localPackage` and needs no bundled Move, so there is nothing to fetch.

## Step 5 — follow-ups  `[-]`
- `[-]` Revisit **postgres** delete (after the external-pg work settles + owner confirms).
- `[ ]` Add a **fork-mode example/doc** so it stops looking unused.
- `[ ]` Warm fingerprint hardening beyond the Step-0 fix (import-graph hash + `SEAL_MOVE_SOURCE_OVERRIDE`).

## Decisions ledger (quick ref)
fork **keep** · TUI **keep** · postgres **defer** · cross-host **drop** · warm **fix** · runStack **keep+seam** ·
deepbook **on-demand+explicit** · Traces/SpanStore/FormatterRegistry **drop** · spans **strip-all** ·
snapshot **keep insurance / strip ~40** · account **minimal (ephemeral+impersonate+signer)** · prune-picker **keep** ·
substrate **go all-in** · docker-dead/reconcile-wrapper/container-claim **delete**.
