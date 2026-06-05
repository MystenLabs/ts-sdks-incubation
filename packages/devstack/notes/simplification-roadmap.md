# Devstack Simplification Roadmap & PR #21 Review

_Generated 2026-06-04 from a 44-agent audit workflow (12 subsystem audits + 4 PR-review areas + 24
adversarial verdicts). Two highest-stakes claims independently grep-verified by the orchestrator:
deepbook bundled-asset LOC, and the boot-time restore ordering bug._

> ## OWNER DECISIONS (2026-06-04) — AUTHORITATIVE, supersedes the audit below
>
> Walked the owner through each proposed change one at a time. The audit had several **bad "not
> worth keeping" assumptions** — corrected here. This table is the plan of record; the architect
> report below is background.
>
> | #   | Change                                                                                                       | DECISION                                      | Note                                                                                                                                                                                                                                                                     |
> | --- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
> | 1   | Fork mode (~2.8k)                                                                                            | **KEEP**                                      | Audit wrong — fork-against-live-state is a core differentiator (Anvil/Hardhat-class). Add an example so it stops looking unused.                                                                                                                                         |
> | 2   | Ink TUI (~2.9k)                                                                                              | **KEEP**                                      | Audit wrong — interactive terminal `up` (q/r/s) is the default UX; don't downgrade to a flat log/browser.                                                                                                                                                                |
> | 3   | Postgres plugin (~1.2k)                                                                                      | **DEFER**                                     | May be used again soon. Verified zero internal deps (Sui indexer is embedded/RocksDB, NOT postgres), so deletable cleanly later. Revisit after other cleanups.                                                                                                           |
> | 4   | Cross-host / NFS support                                                                                     | **DROP**                                      | Single-host only (incl. parallel stacks + same-host `up`/`apply`). Drop foreign-host/NFS branches across roster/liveness/stack-lock/command-channel/doc-sync + the "architecture-mandated" cross-host network + container-claim ledger.                                  |
> | 5   | Warm boot cache (~1.65k)                                                                                     | **FIX**                                       | Boot speed matters. Fix the ordering bug (synthesize participants from meta.identity) + close the 2 fingerprint holes. Do NOT delete.                                                                                                                                    |
> | 6   | `runStack` programmatic API (~1.08k)                                                                         | **KEEP + make it the seam**                   | Owner wants programmatic embedding. Insight: TUI should consume runStack. Invert so CLI/TUI build on the RunHandle → removes the dual-handle duplication, one tested boot path.                                                                                          |
> | 7   | Deepbook                                                                                                     | **ON-DEMAND + DROP MAGIC**                    | (A) Stop shipping move-assets in the tarball; fetch-cache pinned rev at first `apply` (+ prefetch/`DEEPBOOK_MOVE_SOURCE` escape hatch). (B) Drop zero-arg `synthesize.ts` auto-DEX; require explicit config (deepbook-trader already explicit).                          |
> | 8   | Dashboard Traces tab + SpanStore + recording Tracer                                                          | **DROP**                                      | Not useful. Also delete FormatterRegistry (verified dead at runtime).                                                                                                                                                                                                    |
> | 8b  | ALL span instrumentation (235 `withSpan` + 12 `spans.ts` + annotateCurrentSpan, ~1.23k total w/ stores)      | **STRIP ALL**                                 | Owner: spans drive no real problem. No consumer remains once Traces tab gone. Big mechanical diff; accept OTEL re-instrumentation cost later.                                                                                                                            |
> | 9   | Snapshot self-hardening                                                                                      | **KEEP INSURANCE, strip ~40**                 | Audit wrong (wanted ~900) — integrity SHA + image-bundle-tags + interrupted-restore are real silent-corruption insurance (the bug class already hit). Strip only the executeFsPlan-for-restore indirection + the 15→1 phase-error taxonomy.                              |
> | 10  | Account variants (6, 579 LOC)                                                                                | **MINIMAL: ephemeral + impersonate + signer** | `signer` is the one BYO door; fold `env`/`inline` into signer recipes (`Ed25519Keypair.fromSecretKey(process.env.X)`); delete `keystore` (risky, shouldn't have existed).                                                                                                |
> | 11  | Interactive prune-picker (~380)                                                                              | **KEEP**                                      | Checkbox multi-select for a destructive op is a real ergonomic win.                                                                                                                                                                                                      |
> | 12  | Substrate "8 systems" state layer (~17.5k, target collapse ~1.5–4k)                                          | **GO ALL-IN (first)**                         | The real 10k→80k cause. Collapse projection/scoped-registry/strategy-registry/lifecycle-facts/reconcile-spec/manifest into ONE state model; keep supervisor core + contribution pipeline verbatim + control-plane (dashboard). Highest risk + highest conceptual payoff. |
> | —   | docker dead methods (−250), inert reconcile wrapper (−230), container-claim ledger (−425), misc dedup (~600) | **DELETE**                                    | Verified-dead/inert; no judgment needed.                                                                                                                                                                                                                                 |
>
> **Honest revised LOC:** the owner KEPT most feature-deletions (fork/TUI/postgres/runStack), so
> reduction comes from MACHINERY not features — roughly **~7–10k of git-tracked src**
> (84k→~74–77k) + ~9.6k off the shipped tarball + proportional test deletion. Smaller headline than
> the audit's fantasy, but the RIGHT kind: accidental complexity removed, every real capability
> kept. The substrate collapse (#12) is the biggest single lever and a large conceptual win (8
> systems → 2–3).
>
> **Sequence:** (0) fix PR #21 ordering bug [correctness gate, small] → (1) clear-cut strips:
> spans/FormatterRegistry, docker-dead, reconcile-wrapper, account-minimal, deepbook-synthesis
> [low-risk, shrinks the field] → (2) cross-host/NFS drop → (3) **substrate state-model collapse**
> [the main event, e2e suite as safety net] → (4) runStack-as-seam + deepbook on-demand fetch →
> later: postgres revisit, fork example.
>
> ---
>
> **CORRECTION (post-audit, verified):** Roadmap item **#1's "−10,300 LOC" is misleading.** The
> ~9.6k of deepbookv3 Move is **NOT git-tracked** — it is gitignored
> (`packages/devstack/.gitignore:16`) and fetched on demand at a pinned rev by
> `scripts/fetch-deepbook-move.mjs`. Only ~1k is git-tracked (pyth mock 586 + fetch/build scripts
> 218 + `synthesize.ts` 188). The 9.6k is a **build/ship artifact**: `build:deepbook-assets` copies
> it into `move-assets/`, which `package.json files` ships in the npm tarball to every consumer. So
> #1 is a **tarball/ship-size win, not a repo-LOC win**. Better framing: **don't ship
> `move-assets/`; fetch-cache the pinned rev at first deepbook `apply`** (runtime on-demand into a
> user cache), with an opt-in prefetch / `DEEPBOOK_MOVE_SOURCE` override for offline. Honest
> git-tracked reduction from the survived list ≈ **~14k `.ts`/test** (84k→~70k), plus ~9.6k off the
> tarball. The ~30k north star needs the deeper substrate collapses on top.

---

# Devstack Simplification — Lead Architect's Report

## 1. Verdict on the simplification goal

**It is achievable, but it has not happened yet — and the honest LOC story is brutal.** The growth
from ~12k to ~84k was _not scope_, it was a big-bang Effect-TS rewrite (May 18–21: ~19k→66k) plus a
dashboard/observability build-out (May 29: 60k→81k). The core job — boot local Sui + walrus + seal,
`up`, supervisor, reconcile, codegen — fit in **12,244 LOC at the first commit** and works the same
today at 84k. Roughly **~10k of genuinely-new user scope** (dashboard, postgres, deepbook, warm) was
added; the other **~60k is architecture** — substrate framework tax plus the self-imposed systems it
enabled (cross-process IPC, brokers, projection, scoped/strategy registries, control-plane,
observability rings) and oversized orchestrators (router, snapshot, fork). Stage A/B has trimmed ~3k
of an achievable **~30k+**. The simplification is real and bankable; the work is mostly _deletion of
machinery the tool built to run itself_, not feature loss.

## 2. The clean system (target design)

Build it from the user vocabulary backward: **~15 factories + 9 CLI verbs serving 13 jobs, ~9 of
them CORE.** That needs four layers, not the L0–L4 substrate-plus-orchestrator tower:

**Layer 1 — Container runtime (keep).** `runtime/docker/{service,container}.ts` is correct: CLI
subprocess, typed errors, `decideRunAction` state machine. Do _not_ introduce dockerode. Strip dead
contract methods and the L1→L0 cross-process claim coupling. ~5k → ~4.5k.

**Layer 2 — Supervisor (keep the core, shed the generality).** A dependency-ordered acquire/teardown
scheduler with ready-gates is the product. Keep `dep-graph` + level-batched acquire +
scope-finalizer teardown + the **plugin contribution pipeline** (`plugin-ctx` 5-verb closed surface
→ buffer → seal → replay → `ContributionDispatcher` over 5 closed decl kinds). This is the cleanest,
best-designed part of the codebase — it _earns its keep_, keep verbatim. What dissolves around it:
the `reconcile/` "unified spec" vocabulary (inline to `teardownKeys`/`acquireKeys`),
`lifecycle-fact.ts` (inline into the reducer), the duplicated transition table, the dead
watch/selective-restart-attribution surface.

**Layer 3 — One in-process state model.** Collapse the four parallel read models into **one
projection `SubscriptionRef` + a manifest**. What dissolves: the bespoke **observability rings**
(SpanStore + recording Tracer + cross-service LogStore + FormatterRegistry — the FormatterRegistry
is _dead at runtime_) replaced by plain Effect leveled logging + the pure cascade-formatter; the
**scoped-registry single-mode LWW** half replaced by a plain `SubscriptionRef<Map>` (keep only the
multimap, which has a real sibling-scope finalizer argument); **strategy-registry** inlined;
**control-plane** kept _only_ because the dashboard stays.

**Layer 4 — Surfaces.** **One live view, not two.** Keep the web dashboard (J12, in template + all
examples, real invested SPA) + a ~350-LOC plain renderer for attached `up`; **delete the entire Ink
TUI** and its display-derivation table machinery. CLI verbs unchanged (public contract).

**What dissolves wholesale — the self-imposed multi-process spine.** The single biggest conceptual
win: this is a **single-developer, single-host, one-stack-at-a-time tool** (verified across all
examples). Everything built to coordinate multiple processes/hosts is solving a problem the tool
invented: `cross-process/` roster-array + heartbeat + container-claim ledger, the port-broker
reservation-file layer, the router's route-lease/liveness protocol, the codegen lock, the
cross-process snapshot stack-lock. Replace each with an in-process `Effect.Semaphore(1)` + scope
finalizers. The _one_ documented real handoff (`apply`/`snapshot save` against a live `up`) survives
as a minimal command channel.

**Orchestrators shrink, not vanish.** Snapshot stays (REAL id-stability) but sheds its
self-hardening (integrity SHA, interrupted-restore sentinel, image-bundle-tag scanner, executeFsPlan
indirection) → ~5.8k to ~1.5–2k. Router stays (REAL stable origin) but goes per-stack and loses the
lease protocol; **keep Traefik-the-container** (the in-process-proxy swap did NOT survive review —
h2c/TCP risk). Warm and fork **delete entirely**.

**North star: ~30k LOC.** Four thin layers, one state model, one live view, one process.

## 3. Ranked simplification roadmap

Ordered by (LOC × confidence ÷ risk). LOC are the **adversarial-revised** numbers. Moves listed all
survived review.

| #   | Move                                                                                                                                                                 | Subsystem(s)                                                             |                            LOC saved | Risk     | Preserve (REAL req)                                                                                                                                  | Sequencing                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -----------------------------------: | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1   | Delete zero-arg `deepbook()` synthesis + 9.6k bundled Move tree; require explicit config                                                                             | plugins/deepbook                                                         |                           **10,300** | low      | Explicit deploy/seed/pyth path for deepbook-trader; fail-fast on missing opts                                                                        | Update packed-consumer-typecheck; remove fetch/build scripts                       |
| 2   | Delete fork mode end-to-end (sui/seal/walrus/account-impersonate)                                                                                                    | plugins/sui+seal+walrus+account, examples                                |                            **2,800** | med      | Relocate `fork-greeting/move` (warm-cache.test uses it via LOCAL); narrow NetworkMode union                                                          | Do before/with #8; touches docs + dashboard SealMode enum                          |
| 3   | Delete Ink TUI; plain renderer + web dashboard for live view                                                                                                         | surfaces/tui, display-derivation                                         |                            **2,300** | med      | One operator view + clean CI output (plain renderer); J12 web dashboard                                                                              | Independent; keep `--renderer plain\|silent`                                       |
| 4   | Delete warm/ entirely + `--warm` wiring + orphaned tests                                                                                                             | orchestrators/warm, cli, surfaces/cli                                    |                            **1,650** | low      | Nothing — SELF-IMPOSED; PR#21 proved it's _silently dead_ anyway                                                                                     | Independent; keep `recoverInterruptedRestore` separate                             |
| 5   | Delete postgres plugin                                                                                                                                               | plugins/postgres                                                         |                            **1,500** | low      | Nothing — only consumer is a dashboard demo                                                                                                          | Independent; remove root-barrel export                                             |
| 6   | Delete `runStack` + tests; mode-narrowing apparatus (`defineDevstackWith`/`*For`)                                                                                    | api                                                                      |                   **1,080** + **90** | med      | Keep `walrusFor` OR add `walrus({mode:'known'})` first (only path to known-Walrus)                                                                   | #2 narrows the unions first                                                        |
| 7   | Strip snapshot self-hardening (integrity SHA, interrupted-restore sentinel partial, image-bundle-tags, executeFsPlan, phase-error taxonomy)                          | orchestrators/snapshot                                                   |       **~900** (520+300−salvage+120) | med      | **KEEP** identity guard, `requireSnapshotDeployCache`/`scanHostTreeCacheRelPaths`, graceful-stop walrus flush, duplicate-tag guard                   | After #4 (warm gone simplifies)                                                    |
| 8   | Collapse cross-process spine → single-holder presence file + container-claim-by-label + in-process semaphores                                                        | substrate/cross-process, port-broker, docker, router-lease, codegen-lock | **~1,200** (165+425+250+400+60+misc) | med      | Single-holder PID+start-time liveness; intra-stack collision detect; ESRCH stale-reclaim; **port reservation file STAYS** (probe→listen gap is REAL) | Sequence: container-claim-by-label → roster→presence → router-lease → codegen-lock |
| 9   | Collapse command-channel bridge; apply/snapshot/prune run one-shot gated by roster claim                                                                             | cli/wirings, cross-process                                               |                              **350** | high→med | The one REAL handoff (`apply` vs live `up`) via minimal channel OR clean refusal                                                                     | After #8; keep the documented behavior tested                                      |
| 10  | Delete FormatterRegistry (dead at runtime)                                                                                                                           | observability                                                            |                              **420** | low      | Keep every `X_ERROR_TAGS`; keep cascade-formatter discover-by-shape                                                                                  | Independent                                                                        |
| 11  | Delete recording Tracer + SpanStore (dashboard-only)                                                                                                                 | observability, control-plane, dashboard                                  |                              **450** | med      | Keep `spans.ts` vocabulary + `Effect.withSpan` callsites (default tracer)                                                                            | Drop Traces tab                                                                    |
| 12  | Collapse cross-service LogStore → single bounded flat ring                                                                                                           | observability, control-plane, dashboard                                  |                              **275** | med      | Dashboard Logs tab + per-row logTail (status/TUI)                                                                                                    | After #3                                                                           |
| 13  | Collapse reconcile/ "unified spec"; inline graph axis to teardownKeys/acquireKeys                                                                                    | substrate/reconcile                                                      |                              **230** | low      | Keep `executeFsPlan`/`ReconcileFsOp` + per-op failers + `plan()`; keep spans; shutdown stays uninterruptible (Bug#13)                                | Independent                                                                        |
| 14  | Delete dead docker contract methods (followLogs/sweepOrphans/saveImage/pause/unpause)                                                                                | runtime/docker                                                           |                              **250** | low      | Keep `pauseAndCommit`, `removeManagedContainers`                                                                                                     | Independent                                                                        |
| 15  | Delete interactive Ink prune-picker; bare `prune`→CONFIRM_REQUIRED                                                                                                   | surfaces/cli                                                             |                              **380** | low      | Keep `--list/--dry-run/--all/--yes` + scope flags                                                                                                    | After #3 (ink fully gone)                                                          |
| 16  | Delete account impersonate variant (fork-only)                                                                                                                       | plugins/account                                                          |                              **300** | low→med  | Keep `source` discriminator schema (hardcode `'real'`); keep ephemeral; **owner sign-off before deleting BYO keystore/env/inline/signer**            | After #2                                                                           |
| 17  | Smaller dedup wins (lifecycle-fact inline, transition single-source, barrels, manifest-error unions, artifact-publisher iface, spans micro-files, routed-url helper) | substrate, plugins, build-integrations                                   |                             **~600** | low      | None load-bearing                                                                                                                                    | Sweep at end                                                                       |

**Credible total achievable reduction: ~24,000–27,000 LOC of src** (84k → ~57–60k), with the single
largest chunk (#1, 10.3k) being a no-risk bundled-asset deletion. If the owner additionally
green-lights demoting deepbook off the root barrel and the BYO-account removals, and the snapshot
redesign lands its full bounce-unification, the realistic floor approaches **~30–35k src** — back in
the neighborhood of the original tool's footprint, now with the dashboard, deepbook, and id-stable
snapshot/restore that the original lacked.

## 4. Do NOT touch (load-bearing)

These serve REAL user requirements; preserve verbatim through any rewrite:

- **The plugin contribution pipeline** — `plugin-ctx.ts` closed 5-verb surface,
  buffer→seal-after-start→replay, `ContributionDispatcher` over 5 closed decl kinds, the seq-tagged
  **scoped-registry multimap** (its sibling-scope finalizer-correctness argument is real). The
  cleanest design in the repo.
- **ID stability across restart** — master-key persistence, BLS-width guard, per-node distinct
  walrus image tags, `ephemeral` account key persistence, the cache key forwarding `spec.chain`
  verbatim. This is the private-content decryption invariant.
- **Snapshot identity guard + deploy-cache self-containment** — `runIdentityGuard` (fail-closed
  chain/vault/seal/walrus), `requireSnapshotDeployCache` + `scanHostTreeCacheRelPaths`. Removing
  these silently widens the re-mint window and breaks private-content.
- **Snapshot capture correctness** — graceful-stop flushes walrus RocksDB; recreate-from-image
  (never `docker start` — walrus exits on start).
- **Port reservation file** — the probe→listen gap is a REAL cross-process race; keep with ESRCH
  stale-reclaim. (Adversarial review _rejected_ deleting this.)
- **Router-as-Traefik-container** — stable browser origin + h2c(gRPC) + TCP passthrough; the
  in-process-proxy swap did NOT survive review. Make it per-stack, keep the container.
- **lease-broker** — serializes per-address funding/faucet (no double-spend on shared sequence).
  REAL, not the "built-ahead generic" the map flagged — only fix the stale header.
- **Faucet warm-up wire semantics** — non-2xx raise, body-Failure raise, per-fetch deadline,
  jittered retry (`faucet/http.ts`) survive verbatim even when the 5-file plugin is collapsed.
- **codegen + `@generated` layout + manifest + 7 export subpaths + CLI verbs + exit-code table** —
  the documented public contract.
- **Single-holder roster liveness** — PID + start-time (not bare `kill(0)`; PID recycling on
  long-uptime hosts is real); the same start-time stamp gates sui-fork RocksDB dual-writer (if fork
  survives — it shouldn't).

## 5. PR #21 correctness

**Two HIGH must-fix bugs — same root cause (ordering):** both boot-time restores run in
`beforeInitialAcquire`, _before_ participant registration, so the identity guard has nothing to
compare against.

- `orchestrators/warm/hooks.ts` — **warm restore always fails the guard → `--warm` is silently
  dead.** (Resolved by roadmap #4: delete warm. If kept, must move after registration.)
- `orchestrators/snapshot/interrupted-restore.ts` — **guard always fails → sentinel never clears →
  permanent boot-time retry loop.** This one is NOT deleted by #4; it must be fixed: move
  `recoverInterruptedRestore` after participants register, or the recovery can wedge every boot.
- `cli/wirings/up.ts` (medium, same root) — the `beforeInitialAcquire` ordering is the structural
  cause; fixing the hook placement resolves all three.

**Two HIGH warm-fingerprint correctness bugs** — both moot once warm is deleted (#4), otherwise
must-fix: fingerprint hashes only the top-level config bytes (misses transitive imports) and misses
`SEAL_MOVE_SOURCE_OVERRIDE` → both silently restore a stale baseline.

**Medium worth an explicit fix or owner-confirm:** `capture.ts` capture-side bounce has an
unprotected hard-kill window the restore path explicitly closed (asymmetric hardening — fix by
sharing the sentinel, or accept and document); `wipe.ts` plain `devstack wipe` now _preserves_ the
deploy cache (semantics change — confirm intent).

**Verdict:** Safe to merge after (a) fixing the `interrupted-restore` boot-time ordering bug so the
sentinel can actually clear, and (b) either deleting warm (preferred — kills the other 3 highs
outright) or fixing the warm ordering + fingerprint scope. Everything else is low-severity
doc/cosmetic drift.

## 6. Recommended first 3 steps

1. **Delete the deepbook synthesis path + bundled Move tree (#1, ~10,300 LOC, low risk).** Highest
   LOC-per-risk in the entire plan and fully independent. Delete `bootstrap-assets/` +
   `synthesize.ts`, collapse `deepbookCore` to explicit overloads with fail-fast on missing opts,
   remove the fetch/build scripts and `move-assets` from `package.json files`, update the
   packed-consumer-typecheck. deepbook-trader already passes everything explicitly, so it keeps
   working untouched.

2. **Delete warm/ entirely AND fix the interrupted-restore boot-ordering bug (#4 + PR#21 fix, ~1,650
   LOC).** One coherent stroke: warm is self-imposed _and_ PR#21 proved it silently dead, so
   deletion removes 3 of the 4 high-severity findings for free; then move
   `recoverInterruptedRestore` after participant registration so the remaining sentinel bug is
   fixed. This unblocks merging PR #21 and shrinks the snapshot surface for step 3.

3. **Strip snapshot self-hardening (#7, ~900 LOC, med risk).** With warm gone, delete
   `integrity.ts`, the executeFsPlan/swap-tree indirection, `image-bundle-tags.ts` (keeping the
   post-load duplicate-tag check), and collapse the 4 phase-error taxonomies to one — **keeping the
   identity guard and deploy-cache scanner verbatim**. Re-run snapshot-restore-matrix +
   private-content-boot e2e to confirm the id-stability teeth still bite. This takes snapshot from
   ~5.8k toward ~1.5–2k and lands the MEMORY-noted honest savings.

After these three (~12.8k removed, ~84k→~71k), proceed to the cross-process spine collapse (#8/#9)
and the Ink TUI removal (#3) as the next major waves.

---

## Appendix A — PR #21 correctness findings (high/medium)

### [HIGH] packages/devstack/src/orchestrators/warm/hooks.ts:123 (high conf)

**Warm restore runs before participant registration -> identity guard always fails -> --warm is
silently dead**

runWarmRestore (line 123: `deps.snapshot.restore({ id: WARM_BASELINE_SNAPSHOT_ID })`) is wired into
`beforeInitialAcquire` in cli/wirings/up.ts (line ~589) and the e2e harness boot-config-impl.ts
(line 516), BOTH of which run BEFORE the supervisor's initial acquire / supervise(). Plugin
Snapshotable participants are only registered during acquireFullGraph (via dispatcher.snapshotable
replay), which is inside runInitialAcquire AFTER beforeInitialAcquire. So at warm-restore time the
orchestrator's participantsRef is empty. snapshot.restore with no `participants` arg reads the empty
registered set (service.ts:452-453), so runRestore builds liveContributions=[] -> live={}
(restore.ts:888-893) and calls runIdentityGuard(meta.identity, {}) (restore.ts:894). A warm baseline
is captured WITH participants (runWarmCapture runs after the stack is up), so meta.identity is
non-empty (e.g. {sui: '{...chain...}'}); the guard hits loop-2 in identity-guard.ts:209-218 and
fails with IdentityMissingLiveError. runWarmRestore swallows the failure
(catchCause->logWarning->continue), so EVERY warm boot silently degrades to cold. The feature never
restores. The asserting test (warm-cache.test.ts 'boot 2 warm restore re-funded boot 1 marker') is
DEVSTACK_RUN_E2E+Docker gated, so the regression is invisible in normal CI.

_Fix:_ Build participants from the snapshot's own recorded identity at boot time, mirroring the
offline path's snapshotIdentityParticipants (cli/wirings/snapshot.ts:155-159): pass
`participants: Object.entries(meta.identity).map(([plugin,value]) => ({ plugin, liveIdentity: Effect.succeed({[plugin]: value}) }))`
so the contribution guard is tautologically satisfied when there is no live stack to compare.
Alternatively, make runRestore treat an empty participant list as 'no live stack to compare' and
skip runIdentityGuard (the runtime-identity guard on app/stack/network still fires). The warm hook
would need the meta, so list/find it (it already lists the catalog for the hit check) and pass the
synthesized participants through WarmSnapshotOps.restore.

### [HIGH] packages/devstack/src/orchestrators/snapshot/interrupted-restore.ts:235 (high conf)

**Interrupted-restore recovery runs before participant registration -> guard always fails ->
sentinel never clears (permanent boot-time retry)**

recoverInterruptedRestore calls deps.restoreSnapshot(snapshotId) (line 235), wired in up.ts to
`(id) => snapshot.restore({ id })` (up.ts:578) inside beforeInitialAcquire — again BEFORE the
initial acquire registers any participant. Same mechanism as the warm bug: participantsRef is empty,
runIdentityGuard(meta.identity={nonEmpty}, {}) fails with IdentityMissingLiveError. The recovery
exit is a Failure, so per the documented loop-safety the sentinel is DELIBERATELY left in place 'for
the next boot to retry' (lines 236-244). But the failure is by-construction, not a
transient/corrupt-artifact condition, so it re-fails on EVERY subsequent boot and the sentinel never
clears — the half-promoted image set is never reconciled by the auto-recovery it was designed for,
and an operator must remove .devstack-restore-in-progress.json by hand. This nullifies the exact
hard-kill-mid-promotion gap this module exists to close. (Boot itself still proceeds since the error
is swallowed, so it's not a boot-wedge, but the recovery is dead.)

_Fix:_ Same fix as the warm path: when re-invoking restore at boot, synthesize participants from the
snapshot's recorded meta.identity (read the meta for the sentinel's snapshotId and build
liveIdentity slices from it), or have runRestore skip the contribution-identity guard when
participants are empty. Wire restoreSnapshot in up.ts to a restore variant that supplies the
synthesized participants rather than the bare `snapshot.restore({ id })`.

### [MEDIUM] packages/devstack/src/cli/wirings/up.ts:588 (high conf)

**beforeInitialAcquire ordering makes both boot-time restores structurally unable to see live
participants**

This is the shared root cause of the two findings above, surfaced at the wiring site.
beforeInitialAcquire (up.ts:565-642) runs recoverInterruptedRestore (576-579) then runWarmRestore
(588-602) and only afterwards does superviseStackEffect proceed to runInitialAcquire
(boot.ts:265-269), which is where dispatcher.snapshotable -> registerParticipant fires. There is no
point before the first acquire at which the snapshot orchestrator knows the live participant set, so
ANY restore issued from beforeInitialAcquire is guaranteed to run with empty participants. The
design intent ('restore the tree, then let the initial acquire converge onto it') is sound, but the
restore identity-guard contract assumes a live participant set that does not exist yet. Worth fixing
at the contract level (restore must tolerate a no-live-stack boot-time invocation) rather than
per-call so future boot-time restore callers don't reintroduce it.

_Fix:_ Decide one contract: either (a) runRestore accepts an explicit 'offline/boot-time' mode that
synthesizes liveIdentity from meta.identity (the offline CLI path already does this and is the
precedent), or (b) treat empty inputs.participants as 'no live stack' and run only
runRuntimeIdentityGuard, skipping runIdentityGuard. Then route warm + interrupted-restore + the
offline CLI through that one mode so the three agree.

### [HIGH] packages/devstack/src/orchestrators/warm/fingerprint.ts:356 (high conf)

**Warm fingerprint hashes only the top-level config file's bytes, not its transitive import graph —
edits to imported sibling config silently restore a stale baseline**

`configSource: sha256Hex(configBytes)` hashes ONLY the bytes of the resolved `devstack.config.ts`
(the single `configPath`). The config is loaded via dynamic `import(url)`
(cli/wirings/config-loader.ts:89), so it routinely imports plugin config from sibling modules (e.g.
`import { POOLS } from './pools.ts'`, coin/package address constants, faucet amounts). Per-plugin
options are NOT serializable fingerprint inputs either: a plugin member exposes only
id/role/section/deps/watch (substrate/plugin.ts:174-192); the actual config is closed over inside
the plugin's `start` closure, and the `members` projection (fingerprint.ts:341-349) deliberately
omits it. So the ENTIRE per-plugin-config signal rests on the byte hash of one file. Edit an
imported `./pools.ts` (change a pool's coin type, a package id, a faucet amount) without touching
`devstack.config.ts`: configSource is unchanged, members/options/moveSources are unchanged →
fingerprint UNCHANGED → `runWarmRestore` HITs and restores the OLD baseline (hooks.ts:119-126). The
user gets the prior config silently, presented as a successful boot. This is the central staleness
concern; it is acknowledged as a v1 limitation in the module header (lines 11-14) and the user's
memory note, but it is under-guarded because the failure is SILENT (a stale restore is
indistinguishable from a clean boot).

_Fix:_ Either (a) fold a hash of the config module's resolved import graph into the fingerprint (the
loader already has the module URL; an esbuild/rollup metafile or a recursive import-scan of local
`./`/`../` specifiers under appRoot would catch sibling edits), or (b) hash the RESOLVED per-plugin
config rather than relying on config-source bytes — serialize each member's resolved options into
the canonical doc instead of only id/role/section/deps/watch. At minimum, surface a loud one-time
warning on a warm HIT that the fingerprint does not see imported config, so a stale restore is not
silent.

### [HIGH] packages/devstack/src/orchestrators/warm/fingerprint.ts:272 (high conf)

**Env-override matcher misses SEAL_MOVE_SOURCE_OVERRIDE — changing the seal Move source between warm
boots restores a stale baseline with a mismatched seal package**

`isImageOverrideEnvKey` matches only `^DEVSTACK_.*_IMAGE$`, `*_CARGO_IMAGE_OVERRIDE`, and
`*_FORK_IMAGE`. But `plugins/seal/bootstrap-assets/source-fetch.ts:109` reads
`SEAL_MOVE_SOURCE_OVERRIDE`, which points the seal deployment at a different on-disk Move source
tree (resolveSealSource returns `{ path: override }`). That override path is OUTSIDE the app's
watched `watch.paths`, so its Move bytes are NOT in `moveSources`, AND the env var name itself does
not match `isImageOverrideEnvKey`. Setting or changing `SEAL_MOVE_SOURCE_OVERRIDE` between two
`up --warm` runs leaves the fingerprint unchanged → a stale warm baseline (built from the old seal
source/package) is restored. Because seal package identity is load-bearing for private-content
decryption / id-stability (per the project's own invariant), a silent stale-seal-package restore can
break decryption while looking like a clean boot. The header comment (lines 265-275) claims the
matcher is 'generic so a new similarly-named override is captured', but it generalizes only on IMAGE
overrides and misses this SOURCE override.

_Fix:_ Add `SEAL_MOVE_SOURCE_OVERRIDE` (and audit for any other `*_SOURCE_OVERRIDE` / source-pinning
env vars) to the override matcher, e.g. `key.endsWith('_SOURCE_OVERRIDE')`. Better: when an override
points at a filesystem path, hash that path's contents into moveSources rather than only the
`KEY=value` pair, so editing the override target (not just repointing it) also invalidates the
baseline.

### [MEDIUM] packages/devstack/src/orchestrators/snapshot/capture.ts:753 (medium conf)

**Capture-side bounce has an unprotected hard-kill window (no sentinel) that the restore path
explicitly closed**

The new capture is a lifecycle bounce: graceful-stop (clean exit) → commit + tar → stage-and-swap →
release stack.lock → resumeAfterCapture (retag committed image onto original name, then HARD-rm the
stopped containers, then optional resume). `resumeAfterCapture` runs AFTER the lock is released and
is NOT wrapped in `Effect.uninterruptible`, writes NO durable breadcrumb, and there is NO boot-time
capture-recovery (boot.ts/up.ts only wires `recoverInterruptedRestore`, which reads the RESTORE
sentinel — confirmed no capture sentinel exists anywhere). The restore path deliberately closed
exactly this class of gap (interrupted-restore.ts sentinel rides the swap + boot resumes). A
hard-kill / power-loss between the graceful-stop and the hard-rm leaves cleanly-stopped containers
(graceful SIGTERM → exit 0/143, NOT 137). On the next boot, decideRunAction
(runtime/docker/container.ts:215) routes a clean, image/config-matching stopped container to
`{ kind: 'resume' }` = `docker start` — which is the precise failure mode capture.ts:749 warns about
('walrus storage nodes EXIT on docker start after a graceful stop'). The hard-rm that forces
facts:null→recreate is best-effort and not crash-safe. Whether the bug actually fires depends on
whether the pre-hard-rm retag changed the image digest enough to trip `!imageMatches` (which would
route to recreate and self-heal); that is uncertain and digest-dependent, which is why confidence is
medium. The OLD capture (pause-around-commit + always-unpause) never stopped containers, so this is
a NEW, narrow failure mode the bounce introduced for a REAL user requirement (capture must leave the
live stack healthy). Note the happy-path live capture is fine: command-loop.ts runs
doSelectiveRestart (recreate-from-image) after the handler returns.

_Fix:_ Mirror the restore protection on the capture bounce: write a capture-in-progress sentinel
into the runtime root before the graceful-stop (or before resumeAfterCapture's hard-rm) carrying the
snapshot id / committed image refs, clear it once resumeAfterCapture completes, and have the boot
hook (alongside recoverInterruptedRestore) detect a live capture sentinel and force
recreate-from-committed-image rather than letting decideRunAction `docker start` the cleanly-stopped
containers. At minimum, wrap the retag→hard-rm in resumeAfterCapture in Effect.uninterruptible
(matching restore.ts:1063) so an Effect-level interrupt cannot tear the handoff, and document the
residual SIGKILL window.

### Low-severity (titles)

- `packages/devstack/src/orchestrators/snapshot/capture.ts` — Capture-resume tail (retag + hard-rm)
  runs after the scope's cleanup finalizer is disarmed; a retag failure orphans committed temp
  images and leaves containers stopped
- `packages/devstack/src/cli/wirings/snapshot.ts` — Offline direct restore defeats the cross-chain
  identity guard by comparing the snapshot against itself (PRE-EXISTING, not a PR regression)
- `packages/devstack/src/orchestrators/snapshot/interrupted-restore.ts` — Recovery doc overstates
  artifact durability — a sentinel whose artifact was deleted/hard-wiped retries+fails every boot
  forever
- `packages/devstack/src/orchestrators/warm/hooks.ts` — Warm capture writes the baseline artifact
  before the sidecar; a recompute failure after capture leaves an orphan baseline with no sidecar
- `packages/devstack/src/orchestrators/snapshot/integrity.ts` — SHA-256 integrity detects corruption
  but not tampering, yet restore.ts comments claim it catches a 'tampered' artifact
- `apps/devstack-dashboard/src/lib/probe.ts` — Probe fetch has no timeout/AbortController — a daemon
  that accepts the socket but never responds leaves the dot stuck on 'probing' (yellow) indefinitely
- `packages/devstack/src/cli/wirings/up.ts` — Warm-restore and interrupted-restore recovery both run
  before the roster sole-holder claim — two concurrent `up --warm` can both restore before either
  wins the live lock
- `packages/devstack/src/plugins/dashboard/schema/root.ts` — GraphQL FundResult.digest field removed
  — breaking for any external query selecting it
- `packages/devstack/src/plugins/walrus/index.ts` — Stale plugin-header doc lists
  endpoint-registry/package-registry/coinType `provides` the plugin never emits
- `packages/devstack/src/substrate/runtime/cross-process/stack-lock.ts` — Stage E commit message
  describes an `acquireReservation` wrapper that does not exist at HEAD
- `packages/devstack/src/orchestrators/snapshot/wipe.ts` — Plain `devstack wipe` now PRESERVES the
  deploy cache (was: dropped it) — semantics change worth an explicit owner confirm
- `packages/devstack/src/orchestrators/snapshot/errors.ts` — CodegenManifestDrift error retained in
  the union but its sole producer (manifest-bridge readEnvelope) was deleted

## Appendix B — adversarial verdicts (which simplifications survived)

- **SURVIVES** (real-req: false, ~10300 LOC) — Delete the zero-arg deepbook() synthesis path + the
  ~9.6k-line bundled Move tree (bootstrap-assets) and require explicit publisher/package/pyth/pools.
- **SURVIVES** (real-req: false, ~2300 LOC) — Delete the Ink/React TUI; keep plain-renderer for
  attached `up`, route the rich live view + interactive commands to the existing web dashboard, and
  strip displa
- **SURVIVES** (real-req: false, ~2800 LOC) — Delete fork mode end-to-end (sui mode:'fork', seal
  fork-known, walrus fork branch)
- **SURVIVES** (real-req: false, ~1500 LOC) — Delete postgres plugin: safe.
- **REJECTED** (real-req: true, ~0 LOC) — Drop Traefik-the-container; replace with a ~150-200 LOC
  in-process Node http/net reverse proxy reading the EntrypointRegistry + resolved routes (saving
  ~1100 LO
- **SURVIVES** (real-req: true, ~400 LOC) — Strip the router's cross-process lease/liveness/lock
  protocol; keep stable-origin file-provider routing + readiness probe
- **SURVIVES** (real-req: false, ~1650 LOC) — Delete warm/ entirely (hooks + fingerprint + baseline)
  plus its --warm flag wiring. VERDICT: the proposal survives. The requirement it serves is
  genuinely SELF-
- **REJECTED** (real-req: true, ~520 LOC) — Collapse integrity.ts + image-bundle-tags.ts + restore
  preflights into the schema decode (~650 LOC)
- **REJECTED** (real-req: true, ~60 LOC) — Delete the port-broker cross-process reservation-file
  layer; keep only the in-process Ref + kernel bind probe (752 -> ~250 LOC, ~480 saved).
- **SURVIVES** (real-req: false, ~420 LOC) — CONFIRMED (refutation failed): The FormatterRegistry +
  custom-formatter path is genuinely dead at runtime and is safe to delete. It serves a SELF-IMPOSED
  requir
- **SURVIVES** (real-req: true, ~350 LOC) — Collapse the cross-process command-channel bridge:
  delete installCommandChannelBridge + snapshotCaptureAck/pending-Ref plumbing in up.ts, plus
  runApplyAgainstLi
- **SURVIVES** (real-req: false, ~450 LOC) — Delete the bespoke recording Tracer + SpanStore
  (span-store.ts) — self-imposed dashboard-only trace storage; SAFE to remove. Verdict: survives.
- **REJECTED** (real-req: true, ~180 LOC) — Drop the 384-line hand-rolled TAR reader (tar/reader.ts)
  in favor of system `tar`, OR scope it out with snapshot.
- **SURVIVES** (real-req: false, ~165 LOC) — Delete the multi-holder roster ARRAY + heartbeat
  machinery, replace with a single-holder presence file. The proposal's DIRECTION is sound and the
  requirement it
- **SURVIVES** (real-req: false, ~1080 LOC) — Delete api/run-stack.ts (424 LOC), its index.ts
  re-export block, and its two test files (test/api/run-stack.test.ts 513 +
  run-stack-mid-run-defect.test.ts 141).
- **SURVIVES** (real-req: false, ~380 LOC) — Delete the interactive Ink prune-picker
  (prune-picker.tsx + prune-picker-entry.ts) and collapse the auto-interactive branch into the
  existing non-interactive co
- **SURVIVES** (real-req: false, ~230 LOC) — Collapse the reconcile/ 'unified spec' layer (delete
  the ReconcileSpec/ReconcileScope/ReconcileTarget/ReconcileDirection vocabulary + the inert
  reconcileGraph w
- **REJECTED** (real-req: true, ~275 LOC) — Collapse the cross-service LogStore into the
  projection's per-row logTail (or drop it with the dashboard Logs tab); fallback: replace
  per-service-ring+error-awa
- **SURVIVES** (real-req: false, ~250 LOC) — Delete
  followLogs/sweepOrphans/saveImage(singular)/pause/unpause from the ContainerRuntime contract +
  their service.ts impls + logs.ts + the sweepOrphans block
- **REJECTED** (real-req: true, ~90 LOC) — Delete defineModeNamespace + suiFor/walrusFor/sealFor
  mode-narrowed factories
- **SURVIVES** (real-req: true, ~300 LOC) — Drop unused account variants down to what examples use:
  delete impersonate variant + its service.ts branch, and demote/remove keystore/env/inline/signer
  BYO var
- **REJECTED** (real-req: true, ~130 LOC) — Proposal to shrink the dashboard GraphQL schema mirror +
  by-hand narrowing by (a) deriving Pothos object types from "the projection Schema", (b) replacing
  per-f
- **SURVIVES** (real-req: false, ~425 LOC) — Delete the container-claim ledger (roster.ts:385-594)
  AND the dead sweepOrphans that is its only reader; rely on the scope-bound stop finalizer for
  orphan safet
- **REJECTED** (real-req: true, ~130 LOC) — Drop cross-host + recycled-PID liveness machinery; keep
  kill(0)+start-time. Delete LivenessProbeScope/layerLivenessProbeScope/makeReaper/LivenessCache +
  reclaim
