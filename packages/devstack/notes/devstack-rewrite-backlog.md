# Devstack rewrite — deferred-work & cleanup backlog

Durable, triaged record of every deferred item + every subagent "Opportunities noticed"
across the simplification rewrite. **This rewrite exists to remove complexity properly —
not to relocate it.** Nothing gets deferred under a vague label; it lands here with a
type, a triage bucket, and a *when*.

## Working rules (process correction — 2026-06)

1. **No relocate-don't-resolve.** A stage is not "done" when code is moved/renamed/wrapped —
   only when it's *minimized*. A new abstraction (dispatcher, seam, helper, layer) is only
   acceptable if it removes a system; if it just relocates one, it's a shortcut. Relocation
   shortcuts are exactly how the original complexity accreted.
2. **Cleanup in-stage, or log it here.** Adjacent cleanups are applied within the stage that
   surfaces them. If genuinely cross-stage, they go in this file with `when:` — never dropped
   on the floor, never hidden in a commit message.
3. **Every agent's `## Opportunities noticed` is harvested here** at the end of each fan-out.
4. **End-of-stage minimality check.** Before declaring a stage done: `git diff --shortstat`
   the stage, scan for new wrappers/indirection, and ask "did we delete or relocate?".
   Record the stage's actual net LOC + systems removed (the real metric is system count).
5. **Estimates are tracked against reality.** The plan's per-stage LOC estimates were
   optimistic (Stage B especially — see below). Track actual net per stage; don't let an
   inflated estimate mask a relocation.

## Triage buckets: `apply-now` · `fold-into-<stage>` · `deferred(when)`

---

## Apply now (high-value, before continuing)
_(populated by the A+B shortcut audit — see below; items get checked off as applied)_

## Fold into a later stage
- `fold-into-C` — A2 `sui-move-build` + `move-summary-runner` **shared-core merge** was NOT
  done; A2 only hoisted `sui-move-build` → `plugins/sui/move`. `move-summary-runner.ts` is
  still a separate file. The plan wanted one merged module extracting `stageDisposablePackage`/
  `ensureMoveHome`/`runMoveCliOneShot`. (untracked-deferral — caught by self-review)
- `fold-into-D` — `DEPLOY_CACHE_NAMESPACES` → plugin-declared (derive from ctx.persist
  namespaces); B-coupled, belongs in D1.
- `fold-into-E3` — endpoint fan-out unification folds into the ctx.endpoint dispatch.

## Deferred (explicit, with when)
- `deferred(A3-followup)` — move Sui network vocab out of `api/inference-network.ts`; carries
  an unresolved design choice (default resolver vs L4 convenience). Out of the A+B PR by
  scope decision.
- `deferred(A4-followup)` — optional `network` → `chain` rename. Low urgency.
- `deferred(end-of-rewrite)` — ARCHITECTURE.md full rewrite to the post-A–E state; delete
  shipped plan sections from `devstack-simplification-plan.md` (git is the archive) once the
  whole arc lands.

## Stage ledger (actual net, the real accounting)
| Stage | net LOC (src+test) | systems removed | notes |
|---|---|---|---|
| A | −1,097 | dead state-store; sui de-privileged (substrate name-blind) | beat ~600 estimate |
| B | +366 → −7 (after P5 emit dedup −373) | CapabilitySinks registry, capability-decl 2nd-closure, dispatch-contributions, `<Caps>` | plan est. ~−5,900 was a large over-count (relocatable closures counted as deletable) |
| C | ~+27 (C1 −69, C2+C3 +96) | ArtifactPublisher Service+Layer (folded into cache.publish); 2 scoped-map primitives → 1; 3 L3 composition files → 1 boot.ts | consolidation; flat LOC, system-count is the win |
| D | −1,688 | crash-recovery marker subsystem; integrity.json; 1 of 2 tar parsers; deploy-cache double-store; keepCache flag; CapabilityDeliveryObservers | the real deletion stage (D2 alone −1,286) |

| E | ~+773 (src consolidation + ViewModel/adapters/core + NEW tests; deletes EndpointUrl, 3 endpoint helpers, 2 lock dups) | 2 divergent health derivers → 1 ViewModel; 3-way endpoint derivation → 1 adapter; 3 lock files → 1 acquireExclusive; 2 reapers → 1 combinator; CapabilityDeliveryObservers | hardening + consolidation; net positive (new tests + fail-loud code) |

**FINAL TOTAL A–E (b9ae8a2c→HEAD): net −1,992 (src −1,173, test −819); 21 source modules deleted; ~8–9 systems removed.** The plan's ">10k removed" was the inflated Stage-B estimate; honest result is ~−2k net with the system-count drop (the real goal) intact, type-safety preserved-to-improved, substrate name-blind, *plus* substantial new test coverage.

Newly found (this pass), logged not dropped:
- `deferred(end-of-rewrite)` — `packages/docs/.../state-and-snapshots.mdx` still lists `state.json` in the artifact layout (removed in A1) — stale doc. [stale-doc · low]
- `deferred(end-of-rewrite)` — `contracts/snapshotable.ts` comments still phrase the auto-include as `runtime/<plugin-key>/` (pre-path-collapse); inaccurate. [stale-doc · low]
- `deferred(end-of-rewrite)` — `contracts/plugin-expander.ts:24` comment names the deleted `CapabilitySinks` harvest path. [stale-doc · low]

## Audit findings (A+B relocate-don't-resolve sweep)

_Synthesized from 4 adversarial audits, each finding grep-verified against the tree on `mh/devstack-stage-a` (commits through P5 `6b367143`). Severities re-rated from evidence; over-reaches called out inline so they are not actioned as busywork._

**Headline:** A+B is a genuine reduction, not relocation. CapabilitySinks registry, `dispatch-contributions.ts`, and the capability second-closure are DELETED; P5 (`6b367143`) collapsed the per-plugin emit ceremony into one `emitContributions` router (`plugin-ctx.ts:124`). The "relocate-don't-delete" shortcut did **not** recur anywhere new beyond the now-fixed emit seams. What remains is a routine dead-code + stale-doc tail plus one named-but-unwritten test. The stage ledger above already records the honest accounting (B: +366 → −7 after P5).

**Two audit over-reaches, rejected (do NOT action):**
- _"Inline the per-plugin builders, they are pure ceremony"_ (relocation audit, finding 2) — **WRONG.** `coinContributions` is shared across 3 coin modes (`coin/index.ts:303,351,387`) **and** a test (`test/plugins/coin/funding-strategy.test.ts`); inlining re-introduces exactly the duplication P5 removed. `makeLocalCapabilities`/`makeKnownCapabilities` factor mode-specific decl assembly. Keep them.
- _Severity inflation_ — `_runtimeRoot` and `AcquireContext` rated "high"; they are clean dead removals (low/medium). `strategyContributorDispatch` claimed "byte-identical" relocation; it is **not** (now calls `strategyRegistry.register` with priority — the seam absorbed real logic).

---

### Apply now (high-value, before continuing)

- **[dead-code · low · small]** Remove unused `_runtimeRoot` param — `src/substrate/runtime/supervisor/acquire-node.ts:329`; stop threading `runtimeRoot` through `acquireKeys` (~:540) and `acquireFullGraph` (~:569). The comment at :326-328 already admits it is dead "signature symmetry" threading. Single call site at :531.
- **[dead-code · low · trivial]** Delete orphaned `AcquireContext` interface — `src/substrate/plugin.ts:141-145`. Grep-verified ZERO real importers (only comment mentions at `acquire-node.ts:328`, `start-supervisor.ts:387`); drop/update those comments in the same edit.
- **[stale-doc · low · trivial]** Fix 2 deleted-file comment refs to `dispatch-contributions.ts` — `src/surfaces/tui/event-log.ts:148`, `src/surfaces/tui/plain-renderer.ts:124` → point at `acquire-node.ts` `dispatchBufferedContributions`. (Also `STYLE_GUIDE.md:216` still lists the file in its tree — audits missed this; fold with the doc pass below.)
- **[relocation-not-deletion · low · trivial]** Add a one-line "RELOCATED orchestrator seam, not net-new logic" note above `projectionDispatch` — `src/orchestrators/runtime-composition.ts:288` (it IS byte-identical to the old projection sink). Note that `strategyContributorDispatch` (:309) is **not** identical.

### Fold into a later stage (P5-followup / the planned code-review+simplify pass)

- **[overcomplication · low · small]** `fold-into-P5-followup` — Collapse the parallel 3-mode `ctx.snapshotExtra(snap); ctx.codegen(makeXxxCodegenable(bindings))` pairs in `seal/index.ts` (328/390/456) and `deepbook/index.ts` (487/730/883) where they differ only in the bindings source. Shallow but real. **Do NOT** touch `coinContributions` or the package `make*Capabilities` builders (see rejected over-reach).
- **[untracked-deferral · high · small]** `fold-into-P5-followup` — Add the contract-name name-blindness regression test (plan P5 edit#2, never written). Existing `test/substrate/name-blindness.test.ts` checks plugin NAMES via `\bname\b` only; add a check that `supervisor/acquire-node.ts` + `supervisor/*` contain no contract-name literals (`routable`/`codegenable`/`snapshotable`/`projection`/`strategy-contributor`) used as dispatch keys, **excluding** the legitimate discriminant switch in `acquire-node.ts`. High because it guards the exact invariant this rewrite protects.
- **[stale-doc · medium · small]** `fold-into-P5-followup` — Rewrite `STYLE_GUIDE.md` §21.8 (:637-667, "the supervisor harvests them post-acquire") and :163 (`CapabilitySinks.dispatch`) to the `ctx.provides()` / static `StrategyContributorDecl` emission pattern.
- **[stale-doc · medium · small]** `fold-into-P5-followup` — Fix `ARCHITECTURE.md` stale refs at :37, :94, :113, :152 (`CapabilitySinksService` / harvest path / `registerSink`). Audits listed 37/94/152; :113 ("the supervisor harvests it") also stale.
- **[stale-doc · low · small]** `fold-into-P5-followup` — Rewrite 7 stale plugin header comments ("Capabilities emitted:" / "Capability decls emitted:") in `sui`, `seal`, `postgres`, `wallet`, `walrus`, `account`, `deepbook` `index.ts` to describe `ctx.*` verbs.
- **[dead-code · medium · medium]** `fold-into-P5-followup` — Decide `CapabilityDeliveryObservers` (`runtime-composition.ts:143-153`): the type is referenced but `observers` always defaults to `{}`, so the branches at :371-383 never fire at runtime. Either delete type + dead branches (no near-term observability hook planned) or keep with a "deliberate unused extensibility seam" comment. It is dead-at-runtime, not dead-type — that nuance drives the choice.

### Deferred (explicit, with when)

- `deferred(end-of-rewrite)` — Mark/delete shipped Stage A+B sections of `notes/devstack-simplification-plan.md` (still reads "specified at execution fidelity"). Already tracked here; leave it — the doc still hosts C/D/E specs, so per-stage deletion now would churn. [doc-hygiene · low]
- `deferred(end-of-rewrite)` — Replace the two `OptionalService` accessors (`wiring.ts:45-82`) with `Context.getOptionUnchecked` if/when Effect v4 ships it. Already noted in-code; upstream-watch, not present complexity. [trivial]
- `deferred(future)` — Add a runtime/type guard rejecting any re-added `kind:'local-published'` contribution (overcomplication audit, finding 3). The `discoverPublishedCoins` relocation into `package` start is correct and documented (`publish-output.ts:6-8`, `package/index.ts:296/409-413/506`); a guard is defensive nice-to-have, not a gap today. [low]
- `deferred(Stage-C)` — `artifact-publisher/` → `cache.publish`, scoped-multimap/ref-map unification, boot merge. Correctly not started; gated on B (done), independent of D. **Not a shortcut.**
- `deferred(Stage-D)` — `wipe.ts` keepSnapshots/keepCache coupling (D0), `DEPLOY_CACHE_NAMESPACES`→`ctx.persist` inversion (D1, B-coupled), recover-pending/pending-marker/integrity removal (D2/D3). Correctly not started; gated on decision-1 + D0. **Not a shortcut.**
