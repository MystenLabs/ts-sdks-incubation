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
- `07d76f41` — Step 3 plan doc (18-agent design + adversarial stress-test) — notes/step3-substrate-collapse-plan.md
- `8f073471` — S3.1 lifecycle-fact → projection reducer (**−10**)
- `85548041` — S3.2 drop runtime projection barrel + hoist compile guards (**−10**)
- `f9ba45a8` — S3.3 remove dead manifest services/contribution channel (**−63**)
- `0b364686` — S3.4 multimap sibling-scope drop-by-seq guard test (+test, prereq)
- `346e1c22` — S3.5 strangle single-mode LWW → coin/package; dead single-mode machinery deleted (**−293**)
- `5b3ff47b` — S3.6 inline multimap → strategy-registry; delete scoped-registry/ (**−30**)
- `6a3e4994` — S3.8 full-delete persisted.ts (projection.v4.json); offline status from manifest (**−220**)
- **STEP 3 COMPLETE: ≈ −626 src LOC** (vs −530 est; S5 over-delivered). tsc 0 + 1851 units green; e2e blocked by a PRE-EXISTING sui-image-build infra failure (proven identical on pre-Step-3 `5c597fc4`).
- **Session total ≈ −5,900 src LOC + ~9.6k off the npm tarball.** (Parallel sui/postgres workstream moved to its own branch.)

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

## Step 3 — substrate state-model collapse (the main event)  `[~] IN PROGRESS`
**Full plan: deleted now Step 3 is shipped — archived in git at commit `07d76f41` (`git show 07d76f41:packages/devstack/notes/step3-substrate-collapse-plan.md`).** 18-agent design + adversarial stress-test. KEY REFRAME: there is already ONE runtime state model (the projection `SubscriptionRef`); the other "systems" are different kinds of thing (supervisor live runtime = keep verbatim; manifest = out-of-process on-disk handoff, can't be a ref; registries = scope-local capability plumbing). So Step 3 = strip machinery around the one model + delete the one redundant persistence twin — NOT a 5-into-1 merge.
**Two audit claims CORRECTED:** (1) `projection.v4.json` is NOT load-bearing for decryption — sole reader is offline `status`; id-stability is CacheService + preRestore. (2) manifest `extras` is a LIVE user feature, not dead.
**OWNER DECISIONS (2026-06-04):** persisted.ts → **FULL DELETE** (−180; offline status endpoints-only when down) · chain-* helpers → **KEEP** (skip S7) · manifest `services` → `Schema.optional` (default) · control-plane de-abstraction → backlog. **Net ≈ −530.**
Sequenced steps (each independently green; supervisor core + contribution pipeline + restore path UNTOUCHED):
- `[x]` S1 move lifecycle-fact → reducer (update.ts), keep named exports (**−10**, tsc 0 / 12 tests green)
- `[x]` S2 move projection compile guards → projection.ts; drop projection/index.ts barrel (**−10**, tsc 0 / projection+name-blindness+no-orphan green)
- `[x]` S3 drop dead manifest `services`+`PluginManifestContribution`; `services`→Schema.optional (**−63**, no version bump; tsc 0 / manifest 15 + build-integrations 190 green). Backlog: rename `ManifestError.reason` 'duplicate-contribution'→'duplicate-endpoint'.
- `[x]` S4 ADD missing multimap sibling-scope drop-by-seq finalizer test (PREREQ for S5/S6) — 3 tests via StrategyRegistry public surface (survives inline), green vs current; drop-by-seq + close-order-independence + uninterruptible-finalizer
- `[x]` S5 strangle single-mode LWW → coin/package as `Ref<Map>` (**−293**, not +40: deleting defineScopedRefMap exposed dead single-mode machinery — defineSingle/makeSingleSurface/makeScopedRegistryCore/winningEntry/projectEntries all dead; multimap backing SubscriptionRef→Ref, `.changes` verified dead; tsc 0 / coin+package 55 + scoped+strategy 15 green). NOTE for S6: scoped-registry/service.test.ts now holds makeScopedMultimap unit tests — relocate/retire when deleting the dir.
- `[x]` S6 inline multimap → strategy-registry; DELETE scoped-registry/ (**−30** net; structural win = one fewer substrate module; S5 already took the big −293. Coverage relocated to strategy-registry/multimap-core.test.ts; sibling-scope guard byte-unchanged. tsc 0 / strategy 15 + account 41 + name-blindness 3 green)
- `[-]` S7 SKIP (keep chain helpers per owner)
- `[x]` S8 FULL DELETE persisted.ts + relocate Account/Package schemas → update.ts; offline status from manifest (**−220**, indep-verified tsc 0 / 8 files 47 tests green). Caught 2 missed consumers (plain-renderer.ts + decode-once.test.ts also imported the schemas); 3 writers were in cli/wirings/ not orchestrators; offline `status` now via `degradedStatusFromContext(ctx)` (identity+endpoints from manifest, empty rows). CacheService/preRestore/restore/identity-guard UNTOUCHED (verified). Docs cli.mdx help-text updated (docs-drift parity).
- `[x]` S9 full sweep + minimality — **tsc 0; full unit suite 264 files / 1851 pass / 1 skip / 0 fail** (incl. persist-id-parity + supervisor/snapshot-restore + orchestrators/snapshot/restore unit tests + sui local-image build-args + name-blindness + no-orphan-exports). Minimality: zero dangling imports to any deleted module; barrel clean. The `rm projection.v4.json` decrypt gate is MOOT (nothing writes/reads it anymore).
  - **e2e BLOCKED by a PRE-EXISTING infra failure (NOT Step 3):** `private-content-boot` + `snapshot-restore-matrix` fail at the sui Docker image build — `FROM ${SUI_TOOLS_IMAGE}` resolves empty → `sui#0` never ready → `[{key:'sui#0'},…(10)] !== []`. **PROVEN pre-existing:** reproduced the identical failure on the pre-Step-3 commit `5c597fc4`. Step 3 never touched the sui-image/docker-build path (empty diff vs `5c597fc4`); base image `mysten/sui-tools:eced…-arm64` IS present locally; the build-arg is constructed correctly (unit test green) yet empty at actual build time. Owned by the sui-tools migration (`adaf37e1`) workstream. id-stability for Step 3 is instead proven by: restore/CacheService/preRestore/identity-guard UNTOUCHED (verified) + the restore/id-parity UNIT tests green.
**Guards:** do NOT inline operational-endpoints (name-blindness `faucet` leak into acquire-node); S4 test is a hard prereq before the registry collapse.

## Step 4 — runStack-as-seam  `[~] IN PROGRESS`
**Full plan: `notes/step4-runstack-seam-plan.md`** (14-agent design + adversarial stress). DIAGNOSIS: runStack (424) + the CLI `up` verb (709) are TWO independent orchestrations of the SAME supervised boot (layers + dispatcher/hook/extendContext + projection-ref-before-supervise + boot-gate/stop-bridge/error-tee, duplicated verbatim). Inversion: runStack = the ONE seam; CLI passes its concerns as injected hooks + commandHandler; TUI becomes a pure consumer of `handle.state`/`events`/`commands`. Public runStack contract preserved (boot bag in non-exported `runStackWithBoot`).
**TWO blockers the architects missed (synthesis fixed):** (1) runStack's per-node `awaitReady` gate HANGS on `done` run-to-completion nodes → would silently hang `up`; fix = unify onto the supervisor's own `runInitialAcquire`/`allReadyOrTerminal` gate (delete + correctness fix). (2) the `up` boot path has ZERO non-e2e coverage (`main.test.ts` only runs `up --help`) → plan ADDS Docker-free gates (hook-order, gate-equivalence, roster→exit-40, restart-cycle). Also found a THIRD parallel boot orchestration in `test/e2e/boot-config-impl.ts` (follow-up).
**OWNER DECISIONS (2026-06-04):** validation → proceed w/ Docker-free gates (e2e blocked by pre-existing sui-image-build); apply/snapshot → **INCLUDE** (route one-shot verbs through shared boot-core too → Step 5); facade/warm-CLI-only/boot-config-impl-followup → recommendations. **Net ≈ −115** (architecture-quality win > LOC win). Risk HIGH, concentrated in the S3 up.ts cutover.
Sequenced (each independently green via tsc + named UNIT tests; e2e excluded):
- `[x]` S0 hoist `buildVerbLayers` → **new `orchestrators/layers.ts`** (sibling, not boot.ts — keeps it from growing); re-export shim covers all 5 consumers; no cycle (orchestrators imports nothing from api/cli). tsc 0 / boot 9 + cli 104 green.
- `[x]` S1 unify readiness gate onto supervisor's `runInitialAcquire` + add `commands`/`runCommand`/`identity` to RunHandle. Reused boot.ts's existing withinScope-after-raceFirst (BOOT.TS UNTOUCHED); preserved runStack's stricter fail-on-acquire-failure via a hang-free status scan in withinScope. tsc 0 / 28 tests (run-stack+mid-run+NEW readiness-gate+boot) green. +81 src / +173 test. HONEST: current `done` producer (role:task) markReady's before→done, so old watcher didn't actively hang TODAY; divergence is latent contract-boundary — fix removes the fragile coupling. **Carry to S2/S5:** (i) a first-class `runInitialAcquire` outcome `{booted,failures}` or `strictAcquire` flag would let runStack consume the supervisor verdict vs re-deriving the status scan (S2); (ii) one-shot `awaitAll` (ready-gate.ts:47 / boot.ts:270) has the SAME per-node hang risk → move to allReadyOrTerminal (S5); (iii) passing the command queue INTO startSupervisor removes the eager-queue pump fiber (S2/S3).
- `[x]` S2 non-exported `runStackWithBoot` (run-stack-internal.ts) + boot bag {commandHandler?, beforeInitialAcquire?, withinScope?}; runStack = thin facade (505→157). Hooks composed built-in-FIRST then caller (proven by hook-order test); all hook failures fold into BootError via existing catchCause (start stays Effect<void,BootError,never> — type-asserted + verified load-bearing). InternalRunHandle = RunHandle + supervisor:SupervisorHandle (no public leak; index.ts exports only runStack). tsc 0 / 22 tests (run-stack+mid-run+gate+NEW boot-bag) green. +184 src (SETUP — dedup lands S3) +199 test. **S4-minimality:** collapse the two InternalRunHandle construction sites (makeRunHandleSlots).
- `[x]` S3 cut up.ts over to runStackWithBoot; deleted the parallel orchestration (superviseStackEffect now ONE long-running site + 2 one-shot; up.ts clean of dispatcher/makeProjectionRef/matchCause). 3 CLI hooks built verbatim-except-handle-refs (recover→warm→IPC→roster→TUI in beforeInitialAcquire; warm-capture in withinScope; snapshot handler as commandHandler); TUI mount+flush stays inside beforeInitialAcquire. NEW Docker-free up-boot-smoke test (recover-before-acquire + roster→exit-40 + boot identity). Necessary seam change: widened bag-hook R to BootHookServices so hooks share the SEAM's stateful SnapshotOrchestratorService (live participant capture). tsc 0 / full sweep 267 files 1860 pass. **HONEST LOC: up.ts 709→840 (+131); Step 4 net so far ≈ +430 src — the seam abstraction is BIGGER than the ~150-line duplication removed. OWNER-ACCEPTED (architecture win: one orchestration + TUI-as-consumer + readiness bugfix + programmatic seam; runStack has 0 real consumers today).**
- `[x]` S4 clean the seam + functional API (owner bar: "actually better + more functional"). Killed the commandHandler Deferred-indirection → a FACTORY `Effect<SupervisorCommandHandler, never, CommandHandlerServices>` the seam resolves with its own live services (CLI closes over the real SnapshotOrchestratorService directly). `makeRunHandleSlots()` collapses the 2 InternalRunHandle construction sites + documents the sync-alloc contract once. Relocated the ~280-line IPC bridge → new `cli/wirings/up-ipc.ts` (**up.ts 807→528**). Documented public RunHandle (per-field) + runStack (programmatic contract). Survived the mid-session #23 merge byte-intact; tsc 0 / full sweep 267 files 1871 pass. Net all-files ≈ +116 (−191 logic + 307 pure relocation + richer API docs).
- `[ ]` S5 route apply/snapshot through shared boot-core (one assembly site, lifetime-parameterized) (−40)
**Guards:** PR#21 ordering lives inside superviseStackEffect (unchanged — move WHO supplies hooks, not WHEN); projection-ref process-lifetime (handle.state = makeProjectionRefSync, CLI moves onto it — strictly safer); fork untouched (sui-plugin concern); runStack public contract (start stays Effect<void,BootError>).
- `[-]` ~~Deepbook on-demand fetch~~ — MOOT (done early in step 1a).

## Step 5 — follow-ups  `[-]`
- `[-]` Revisit **postgres** delete (after the external-pg work settles + owner confirms).
- `[ ]` Add a **fork-mode example/doc** so it stops looking unused.
- `[ ]` Warm fingerprint hardening beyond the Step-0 fix (import-graph hash + `SEAL_MOVE_SOURCE_OVERRIDE`).

## Decisions ledger (quick ref)
fork **keep** · TUI **keep** · postgres **defer** · cross-host **drop** · warm **fix** · runStack **keep+seam** ·
deepbook **on-demand+explicit** · Traces/SpanStore/FormatterRegistry **drop** · spans **strip-all** ·
snapshot **keep insurance / strip ~40** · account **minimal (ephemeral+impersonate+signer)** · prune-picker **keep** ·
substrate **go all-in** · docker-dead/reconcile-wrapper/container-claim **delete**.
