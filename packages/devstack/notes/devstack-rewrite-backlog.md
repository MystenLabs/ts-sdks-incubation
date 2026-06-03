# Devstack rewrite — deferred-work & cleanup backlog

Durable, triaged record of every deferred item + every subagent "Opportunities noticed" across the
simplification rewrite. **This rewrite exists to remove complexity properly — not to relocate it.**
Nothing gets deferred under a vague label; it lands here with a type, a triage bucket, and a _when_.

## Working rules (process correction — 2026-06)

1. **No relocate-don't-resolve.** A stage is not "done" when code is moved/renamed/wrapped — only
   when it's _minimized_. A new abstraction (dispatcher, seam, helper, layer) is only acceptable if
   it removes a system; if it just relocates one, it's a shortcut. Relocation shortcuts are exactly
   how the original complexity accreted.
2. **Cleanup in-stage, or log it here.** Adjacent cleanups are applied within the stage that
   surfaces them. If genuinely cross-stage, they go in this file with `when:` — never dropped on the
   floor, never hidden in a commit message.
3. **Every agent's `## Opportunities noticed` is harvested here** at the end of each fan-out.
4. **End-of-stage minimality check.** Before declaring a stage done: `git diff --shortstat` the
   stage, scan for new wrappers/indirection, and ask "did we delete or relocate?". Record the
   stage's actual net LOC + systems removed (the real metric is system count).
5. **Estimates are tracked against reality.** The plan's per-stage LOC estimates were optimistic
   (Stage B especially — see below). Track actual net per stage; don't let an inflated estimate mask
   a relocation.

## Triage buckets: `apply-now` · `fold-into-<stage>` · `deferred(when)`

---

## Apply now (high-value, before continuing)

_(populated by the A+B shortcut audit — see below; items get checked off as applied)_

## Fold into a later stage

- `fold-into-C` — A2 `sui-move-build` + `move-summary-runner` **shared-core merge** was NOT done; A2
  only hoisted `sui-move-build` → `plugins/sui/move`. `move-summary-runner.ts` is still a separate
  file. The plan wanted one merged module extracting `stageDisposablePackage`/
  `ensureMoveHome`/`runMoveCliOneShot`. (untracked-deferral — caught by self-review)
- `fold-into-D` — `DEPLOY_CACHE_NAMESPACES` → plugin-declared (derive from ctx.persist namespaces);
  B-coupled, belongs in D1.
- `fold-into-E3` — endpoint fan-out unification folds into the ctx.endpoint dispatch.
- `fold-into-E2` (from E1 capture-bounce) — the `quiesce` contract FIELD on `SnapshotableDecl` +
  its plugin decls (seal `quiesce: Effect.void`, walrus comment) are now DEAD: the E1 bounce's
  graceful stop does the flush, capture no longer invokes `quiesce`. Remove the field + decls. [E1
  left it in place by instruction; no caller remains — grep `decl.quiesce` returns 0 hits in src.]
- `fold-into-E2` (from E1 capture-bounce) — live background-capture is now redundant with the
  bounce but NOT deleted: `background-tasks.ts` still wraps the bounce in the
  `snapshotCaptureTask`/`seq`/started+skipped/interrupt machinery, and the CLI ack bridge
  (`up.ts` `pendingCaptures` + `snapshotCaptureAckFromEvent`, `cli/wirings/snapshot.ts`
  `runSnapshotCaptureAgainstLiveSupervisor`) still round-trips the capture through the
  command-channel reply. The bounce is now the SINGLE capture behavior (live + offline both route
  through `doCaptureBounce`/`handle.captureBounce`), so the dual-path is collapsible — but the
  seq-guard (refuse concurrent capture) + started/skipped events are still load-bearing UX, so
  this is a careful collapse, not a raw delete. E2 owns it.
- `fold-into-E2` (from E1 capture-bounce) — `ContainerRuntime.pauseAndCommit` is now only ever
  called against ALREADY-STOPPED containers (the bounce drains first), so its `if running → pause`
  branch is dead and the `pause`/`unpause` contract methods have no production caller. Rename
  `pauseAndCommit` → `commit` and drop `pause`/`unpause` from the contract (touches ~20 test
  stubs + `contract-shape.test.ts`; deferred from E1 to avoid churning them mid-bounce).

## Deferred (explicit, with when)

- `deferred(A3-followup)` — move Sui network vocab out of `api/inference-network.ts`; carries an
  unresolved design choice (default resolver vs L4 convenience). Out of the A+B PR by scope
  decision.
- `deferred(A4-followup)` — optional `network` → `chain` rename. Low urgency.
- `deferred(end-of-rewrite)` — ARCHITECTURE.md full rewrite to the post-A–E state; delete shipped
  plan sections from `devstack-simplification-plan.md` (git is the archive) once the whole arc
  lands.

## Stage ledger (actual net, the real accounting)

| Stage | net LOC (src+test)                   | systems removed                                                                                                                             | notes                                                                                |
| ----- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| A     | −1,097                               | dead state-store; sui de-privileged (substrate name-blind)                                                                                  | beat ~600 estimate                                                                   |
| B     | +366 → −7 (after P5 emit dedup −373) | CapabilitySinks registry, capability-decl 2nd-closure, dispatch-contributions, `<Caps>`                                                     | plan est. ~−5,900 was a large over-count (relocatable closures counted as deletable) |
| C     | ~+27 (C1 −69, C2+C3 +96)             | ArtifactPublisher Service+Layer (folded into cache.publish); 2 scoped-map primitives → 1; 3 L3 composition files → 1 boot.ts                | consolidation; flat LOC, system-count is the win                                     |
| D     | −1,688                               | crash-recovery marker subsystem; integrity.json; 1 of 2 tar parsers; deploy-cache double-store; keepCache flag; CapabilityDeliveryObservers | the real deletion stage (D2 alone −1,286)                                            |

| E | ~+773 (src consolidation + ViewModel/adapters/core + NEW tests; deletes EndpointUrl, 3
endpoint helpers, 2 lock dups) | 2 divergent health derivers → 1 ViewModel; 3-way endpoint
derivation → 1 adapter; 3 lock files → 1 acquireExclusive; 2 reapers → 1 combinator;
CapabilityDeliveryObservers | hardening + consolidation; net positive (new tests + fail-loud code) |

**FINAL TOTAL A–E (b9ae8a2c→HEAD): net −1,992 (src −1,173, test −819); 21 source modules deleted;
~8–9 systems removed.** The plan's ">10k removed" was the inflated Stage-B estimate; honest result
is ~−2k net with the system-count drop (the real goal) intact, type-safety preserved-to-improved,
substrate name-blind, _plus_ substantial new test coverage.

Newly found (this pass), logged not dropped:

- `deferred(end-of-rewrite)` — `packages/docs/.../state-and-snapshots.mdx` still lists `state.json`
  in the artifact layout (removed in A1) — stale doc. [stale-doc · low]
- `deferred(end-of-rewrite)` — `contracts/snapshotable.ts` comments still phrase the auto-include as
  `runtime/<plugin-key>/` (pre-path-collapse); inaccurate. [stale-doc · low]
- `deferred(end-of-rewrite)` — `contracts/plugin-expander.ts:24` comment names the deleted
  `CapabilitySinks` harvest path. [stale-doc · low]

## Audit findings (A+B relocate-don't-resolve sweep)

_Synthesized from 4 adversarial audits, each finding grep-verified against the tree on
`mh/devstack-stage-a` (commits through P5 `6b367143`). Severities re-rated from evidence;
over-reaches called out inline so they are not actioned as busywork._

**Headline:** A+B is a genuine reduction, not relocation. CapabilitySinks registry,
`dispatch-contributions.ts`, and the capability second-closure are DELETED; P5 (`6b367143`)
collapsed the per-plugin emit ceremony into one `emitContributions` router (`plugin-ctx.ts:124`).
The "relocate-don't-delete" shortcut did **not** recur anywhere new beyond the now-fixed emit seams.
What remains is a routine dead-code + stale-doc tail plus one named-but-unwritten test. The stage
ledger above already records the honest accounting (B: +366 → −7 after P5).

**Two audit over-reaches, rejected (do NOT action):**

- _"Inline the per-plugin builders, they are pure ceremony"_ (relocation audit, finding 2) —
  **WRONG.** `coinContributions` is shared across 3 coin modes (`coin/index.ts:303,351,387`) **and**
  a test (`test/plugins/coin/funding-strategy.test.ts`); inlining re-introduces exactly the
  duplication P5 removed. `makeLocalCapabilities`/`makeKnownCapabilities` factor mode-specific decl
  assembly. Keep them.
- _Severity inflation_ — `_runtimeRoot` and `AcquireContext` rated "high"; they are clean dead
  removals (low/medium). `strategyContributorDispatch` claimed "byte-identical" relocation; it is
  **not** (now calls `strategyRegistry.register` with priority — the seam absorbed real logic).

---

### Apply now (high-value, before continuing)

- **[dead-code · low · small]** Remove unused `_runtimeRoot` param —
  `src/substrate/runtime/supervisor/acquire-node.ts:329`; stop threading `runtimeRoot` through
  `acquireKeys` (~:540) and `acquireFullGraph` (~:569). The comment at :326-328 already admits it is
  dead "signature symmetry" threading. Single call site at :531.
- **[dead-code · low · trivial]** Delete orphaned `AcquireContext` interface —
  `src/substrate/plugin.ts:141-145`. Grep-verified ZERO real importers (only comment mentions at
  `acquire-node.ts:328`, `start-supervisor.ts:387`); drop/update those comments in the same edit.
- **[stale-doc · low · trivial]** Fix 2 deleted-file comment refs to `dispatch-contributions.ts` —
  `src/surfaces/tui/event-log.ts:148`, `src/surfaces/tui/plain-renderer.ts:124` → point at
  `acquire-node.ts` `dispatchBufferedContributions`. (Also `STYLE_GUIDE.md:216` still lists the file
  in its tree — audits missed this; fold with the doc pass below.)
- **[relocation-not-deletion · low · trivial]** Add a one-line "RELOCATED orchestrator seam, not
  net-new logic" note above `projectionDispatch` — `src/orchestrators/runtime-composition.ts:288`
  (it IS byte-identical to the old projection sink). Note that `strategyContributorDispatch` (:309)
  is **not** identical.

### Fold into a later stage (P5-followup / the planned code-review+simplify pass)

- **[overcomplication · low · small]** `fold-into-P5-followup` — Collapse the parallel 3-mode
  `ctx.snapshotExtra(snap); ctx.codegen(makeXxxCodegenable(bindings))` pairs in `seal/index.ts`
  (328/390/456) and `deepbook/index.ts` (487/730/883) where they differ only in the bindings source.
  Shallow but real. **Do NOT** touch `coinContributions` or the package `make*Capabilities` builders
  (see rejected over-reach).
- **[untracked-deferral · high · small]** `fold-into-P5-followup` — Add the contract-name
  name-blindness regression test (plan P5 edit#2, never written). Existing
  `test/substrate/name-blindness.test.ts` checks plugin NAMES via `\bname\b` only; add a check that
  `supervisor/acquire-node.ts` + `supervisor/*` contain no contract-name literals
  (`routable`/`codegenable`/`snapshotable`/`projection`/`strategy-contributor`) used as dispatch
  keys, **excluding** the legitimate discriminant switch in `acquire-node.ts`. High because it
  guards the exact invariant this rewrite protects.
- **[stale-doc · medium · small]** `fold-into-P5-followup` — Rewrite `STYLE_GUIDE.md` §21.8
  (:637-667, "the supervisor harvests them post-acquire") and :163 (`CapabilitySinks.dispatch`) to
  the `ctx.provides()` / static `StrategyContributorDecl` emission pattern.
- **[stale-doc · medium · small]** `fold-into-P5-followup` — Fix `ARCHITECTURE.md` stale refs at
  :37, :94, :113, :152 (`CapabilitySinksService` / harvest path / `registerSink`). Audits listed
  37/94/152; :113 ("the supervisor harvests it") also stale.
- **[stale-doc · low · small]** `fold-into-P5-followup` — Rewrite 7 stale plugin header comments
  ("Capabilities emitted:" / "Capability decls emitted:") in `sui`, `seal`, `postgres`, `wallet`,
  `walrus`, `account`, `deepbook` `index.ts` to describe `ctx.*` verbs.
- **[dead-code · medium · medium]** `fold-into-P5-followup` — Decide `CapabilityDeliveryObservers`
  (`runtime-composition.ts:143-153`): the type is referenced but `observers` always defaults to
  `{}`, so the branches at :371-383 never fire at runtime. Either delete type + dead branches (no
  near-term observability hook planned) or keep with a "deliberate unused extensibility seam"
  comment. It is dead-at-runtime, not dead-type — that nuance drives the choice.

### Deferred (explicit, with when)

- `deferred(end-of-rewrite)` — Mark/delete shipped Stage A+B sections of
  `notes/devstack-simplification-plan.md` (still reads "specified at execution fidelity"). Already
  tracked here; leave it — the doc still hosts C/D/E specs, so per-stage deletion now would churn.
  [doc-hygiene · low]
- `deferred(end-of-rewrite)` — Replace the two `OptionalService` accessors (`wiring.ts:45-82`) with
  `Context.getOptionUnchecked` if/when Effect v4 ships it. Already noted in-code; upstream-watch,
  not present complexity. [trivial]
- `deferred(future)` — Add a runtime/type guard rejecting any re-added `kind:'local-published'`
  contribution (overcomplication audit, finding 3). The `discoverPublishedCoins` relocation into
  `package` start is correct and documented (`publish-output.ts:6-8`,
  `package/index.ts:296/409-413/506`); a guard is defensive nice-to-have, not a gap today. [low]
- `deferred(Stage-C)` — `artifact-publisher/` → `cache.publish`, scoped-multimap/ref-map
  unification, boot merge. Correctly not started; gated on B (done), independent of D. **Not a
  shortcut.**
- `deferred(Stage-D)` — `wipe.ts` keepSnapshots/keepCache coupling (D0),
  `DEPLOY_CACHE_NAMESPACES`→`ctx.persist` inversion (D1, B-coupled),
  recover-pending/pending-marker/integrity removal (D2/D3). Correctly not started; gated on
  decision-1 + D0. **Not a shortcut.**

## Deletion-ceiling audit (answering: why only ~-2k, not -10k?)

**Verdict:** The -10k was a fantasy, not a missed opportunity. Two independent signals confirm it:
(1) The A-E arc already removed 8-9 whole SYSTEMS (crash-recovery markers, capability-sinks,
second-closure dispatch, state-store, double deploy-cache, integrity.json, lock collapse) and netted
only -2k — because deletions were largely offset by the inline ctx-verb emission that replaced the
registries. That is the structural truth: the complexity was systems-breadth, and collapsing a
system removes its plumbing but the work it did mostly relocates inline. (2) Bottom-up, the
touchable surface is ~74k LOC of TS/TSX (the other ~9.6k is untouchable Move in bootstrap-assets). I
grep-verified every claimed deletion across all 5 hunts. The TRUE-dead, true-reduction inventory is
small and concrete: the 16 machine-verified non-witness orphans in KNOWN_UNCLEARED_ORPHANS (~150 LOC
incl. comments), a handful of test/e2e-only exports deletable with their tests, and genuine
test-helper duplication (StackPaths mocks ~70 net, ContainerRuntime stubs ~23). The hunts also
contained material errors that inflated the number: makeWalrusLocalRoutables and
parseAllKnownDeepbookDeployments DO NOT EXIST;
coinContributions/coinKnownResourceKey/makeDeepbookDeepFundingContribution/makeSealRoutable/productionRouterProfile
are all actively USED (not dead); accountCells/packageCells and normalizeNetworkAttachment have 4
and 3 call sites respectively, so inlining them DUPLICATES rather than reduces. Honest ceiling: ~300
LOC low-risk + up to ~250 more medium-risk (test-coupled deletions, sweep.ts loop collapse,
command-loop helper extraction) = realistically ~450-550 additional removable, landing net around
-2.5k. To approach even -4k you would have to re-scope: collapse a remaining whole system (e.g. fold
the projection event-sourcing layer, or merge dashboard/domain into the TUI ViewModel) — those are
architecture decisions, not deletions, and each is a multi-hundred-LOC rewrite with real correctness
risk. There is no honest path to -10k on this package as scoped.

**Honest remaining-removable:** ~300 LOC low-risk + ~220 medium = ~520 more → net ~-2.5k. No honest
path to -10k; beyond ~-2.5k requires collapsing another whole system (projection event-sourcing fold
/ dashboard-domain→ViewModel merge) = architecture rewrite, not deletion.

### Apply now (verified dead, ~300 LOC, no-orphan-test-mandated)

- Delete the 16 VERIFIED-DEAD non-witness orphans from KNOWN_UNCLEARED_ORPHANS and shrink the
  allowlist. Each grep-confirmed to have ZERO real consumers (only the declaration). Highest value:
  src/substrate/runtime/projection/update.ts bumpCycle/declareRow/dropRow/declarePackage (~52 LOC
  incl. doc comments) — abandoned parallel API; sibling declareAccount IS wired at
  start-supervisor.ts:300, proving these four are leftovers. Plus \_\_capacities (~9 LOC). ~150 LOC
  total, low risk. The no-orphan test ENFORCES that deletion (list can only shrink), so this is
  mandated cleanup, not optional.
- Delete projectPluginSlice + projectEndpoints in src/orchestrators/codegen/manifest-bridge.ts:68-77
  (~26 LOC incl. comments). Doc comments claim 'build integrations consume this' but grep across
  src/build-integrations + test shows ZERO actual consumers — aspirational dead code. Remove the two
  allowlist entries too. Low risk.
- Delete routesStream (src/orchestrators/router/service.ts:975-977 + the re-export at
  router/index.ts:79). Verified: only the declaration and one barrel re-export, no downstream call.
  ~5 LOC. Low risk.
- Delete the remaining small verified-dead orphans: peekReservation, attributeFire, alreadyReported,
  subscriptionLost, EnvVarName, VerbRunner, LENIENT_RETRY_PROFILE, FORK_UPSTREAM_TO_KNOWN_NETWORK
  (all zero-consumer per grep). EngineEventTag/EngineCommandTag are 1-line type aliases the comment
  says feed lint exhaustiveness — delete only if the lint rule does not reference them. ~40-60 LOC
  combined, low risk. Shrink allowlist accordingly.
- Extract the duplicated StackPaths mock to test/helpers/ (which already exists alongside
  test-plugin-ctx.ts). stackPathsFor/stackPathsLayer is copy-pasted across 5 test files (lock,
  ensure-container-paused, network-alias, ownership-lifecycle, ensure-container-orphan-window) with
  a ~25-30 LOC body each. One variant takes a rosterFile param — parameterize it. Net ~70 LOC after
  the shared helper. Low risk (test-only).
- Extract the byte-identical noop ContainerRuntime stub (Effect.die() shape filler) duplicated as
  noopContainerRuntime in capture-command.test.ts:39 and unusedContainerRuntime in
  capture-collision-tdz.test.ts:59 into test/helpers/. ~23 LOC net, low risk.

### Do next (medium-risk, test-coupled / state-machine)

- Delete test/e2e-only exports together with the tests that are their SOLE consumers (only a true
  reduction if the test is also removed; otherwise you just hide an export). Candidates:
  runStackEffect (boot.ts:321-336, only run.test.ts) ~16 LOC + its test block;
  bootRouterOrchestrator (boot.ts:475-480, only test/e2e/boot-config-impl.ts) ~6 LOC; factFromRow
  (lifecycle-fact.ts:74-78, only lifecycle-fact.test.ts) ~5 LOC + test; holders() on
  LeaseBrokerService (lease-broker/service.ts:304-310, consumed by 14 test assertions across 2
  files) ~11 LOC but deleting it deletes meaningful diagnostic-behavior tests — confirm those tests
  are not the only coverage of release semantics first. Net ~40-80 LOC depending on how much test
  you remove. Medium risk: you are deleting test coverage, so each needs a judgment call on whether
  the behavior is covered elsewhere.
- Collapse the duplicated container-removal loop in src/runtime/docker/sweep.ts.
  removeManagedContainers (168), removeDevstackContainers (186),
  removeDevstackContainersByKindAndName (203) share an identical
  filter→iterate→removeManagedContainer→count loop. Extract one parameterized helper taking a
  filter; keep the three public names as thin wrappers (they are consumed by
  orchestrators/lifecycle-prune and snapshot). Realistic net ~30-40 LOC, medium risk (these run real
  docker teardown; the spans/labels must survive).
- Extract the repeated doSelectiveRestart + allReadyOrTerminal-gate pattern in
  src/substrate/runtime/supervisor/command-loop.ts (appears at 57, 78, 103, 193 plus
  maybeRunPostAcquire called 7x). A runRestartIfReady helper would remove ~30-45 LOC. Medium risk:
  this is the supervisor restart state machine — the empty-slice settle path (175-191) and
  post-acquire ordering are load-bearing per the warm-restart invariants. Bound to this one file,
  add a focused test, do not touch teardown.ts semantics.
- Inline move-summary-runner.ts helpers
  (makeSummaryScratch/prepareSummaryPackage/stageSummarySource/ensureMoveHome, 242-336) used by the
  two internal Docker/Host variants where the Host variant duplicates logic inline (74-98).
  Reconcile to call the shared helpers from both. ~35 LOC, medium risk (Move build path; covered by
  codegen e2e).

### NOT worth it (looks deletable, is load-bearing — do NOT touch)

- coinContributions / coinKnownResourceKey (coin/index.ts) — claimed dead, FALSE. coinContributions
  is called at index.ts 303/351/387 + 3 tests; coinKnownResourceKey at 328. Load-bearing.
- makeDeepbookDeepFundingContribution (deepbook/index.ts) — claimed dead, FALSE. Used at
  index.ts:886. makeSealRoutable likewise USED at seal/index.ts:345.
- makeWalrusLocalRoutables and parseAllKnownDeepbookDeployments — claimed deletable, but they DO NOT
  EXIST in the tree (zero grep hits anywhere). Phantom LOC; the hunt invented ~85 LOC of credit.
- productionRouterProfile (boot.ts:414) — claimed test-only dead, FALSE. Used in production at
  boot.ts:433 as the default profile (router.profile ?? productionRouterProfile()).
- accountCells / packageCells (display-derivation.ts:712/755) — claimed trivially inlineable for 48
  LOC. FALSE premise: 4 call sites in resource-table.tsx (317, 373, 406, 449). Inlining would
  DUPLICATE the cell-construction body 4x — a net INCREASE.
- normalizeNetworkAttachment (container.ts:440) — claimed 'called twice, fold it'. Actually 3 call
  sites (256, 462, 1090). Folding is not a reduction.
- ForkAdminSurface — claimed dead re-export. The TYPE is load-bearing: consumed by
  fork-faucet-strategy.ts, account/service.ts:317, and tests. Only the sui/index.ts:309 re-export
  line might be trimmable (~2 LOC), not the type.
- FaucetStrategyContribution (faucet/index.ts:72) — exported from the PUBLIC package barrel
  src/index.ts:316. Even if internally unused, deleting a public type export is a breaking API
  change, not a low-risk 9-LOC cleanup. Leave unless doing a deliberate API-break.
- The **-prefixed orphans (**LifecycleTableShape, **NoDisplayVocab, **TuiDisplayVocabClean,
  **capacities is the exception) — these are COMPILE-TIME exhaustiveness/vocabulary witnesses (e.g.
  **LifecycleTableShape forces the transition-table shape assertion). They appear as 'orphan
  exports' but are load-bearing static checks. Do not delete.
- Codegen defineSimpleConstExport / makePhaseFailer / snapshot identity helpers — these are real
  shared abstractions used by 5 plugins / 4 phase classes. Inlining trades one indirection for N
  copies; the hunts themselves mark trueReduction:false. Net-neutral at best.
- SpanAttr registry, PortAllocationWindow, subprocess-capture op override — architecture-intended
  generality flagged by the substrate hunt at medium/high risk for ~8-12 LOC each. Per the
  load-bearing-invariants memo these defensive/observability seams gate real failure modes; the LOC
  is not worth the regression risk.

## First-principles simplification proposal (feature-set lens)

## Devstack First-Principles Simplification — Synthesis

**Branch reality check:** the live tree is `mh/devstack-stage-a`, not the
`mh/devstack-simplification` named in the task header. All LOC and behavior claims below are
grep/wc-verified against `mh/devstack-stage-a`.

**Bottom line:** the _honest_ ceiling above the dead-code level is far lower than the explorers'
headline numbers. After adversarial verification, the genuinely-safe structural cuts total
**~3.0–3.9k LOC**, and the one truly large lever (the web dashboard, ~17.4k LOC) is a **product
bet** that breaks the default-scaffolded user's only path to fund/mint/clock/logs unless those
capabilities are ported to the CLI first. Most explorer headline payoffs are illusory or break real
workflows.

### Honest total payoff

| Track                                                               | LOC           | Confidence                      |
| ------------------------------------------------------------------- | ------------- | ------------------------------- |
| Safe structural cuts (no user loss)                                 | **~600–900**  | high                            |
| Snapshot reduction (drop orchestrator + docker-commit, keep guards) | **~1.7–2.9k** | medium (needs cache-parity e2e) |
| **Subtotal (no owner product decision needed)**                     | **~2.3–3.8k** | —                               |
| Web dashboard (owner-call, gated on CLI capability-port)            | +14–17.4k     | a product bet, not cleanup      |

Realistic mechanical payoff **without** touching the dashboard product question: **~3.0–3.9k LOC**.
The dashboard, if cut, dominates everything — but only the owner can authorize it and only after a
capability-port.

---

### ELIMINATE — no real user loss

1. **Network-mode abstraction** (~100–250 LOC). The substrate `DevstackNetworkModeRegistry`,
   `NetworkConfig`/`NetworkMode` types, `defineModeNamespace`, `defineDevstackWith`, and the
   `suiFor/sealFor/walrusFor/deepbookFor` narrowed namespaces. **Verified: zero examples use them.**
   Real network selection runs through `ParsedDevstackNetwork` (the `DEVSTACK_NETWORK` env path the
   CLI/runStack actually use) and Sui's own `SuiPluginMode` discriminated union — both survive.
   Owner rubber-stamp only because `defineDevstackWith` is a documented public API (needs a
   changeset + doc-page delete).
2. **ContainerRuntime abstraction → inline as DockerRuntime** (~150–250 LOC of framing). No second
   backend exists, no user-facing runtime knob, the service tag is literally docker-named. Drop the
   backend-neutral framing + substrate re-export; **keep the interface type** (live test seam).
   Re-introduce with a real driver if podman is ever requested.
3. **Snapshot docker-commit / image save+load** (~200–400 LOC). **Verified present** (capture.ts:72,
   restore.ts:768). Expensive, unnecessary for stateless sui/walrus/seal; postgres state is better
   captured by host-tree-tar. Bundled into the snapshot reduction below.

### RADICALLY REDUCE

1. **Snapshot capture/restore orchestrator** (3678 LOC) → keep identity-guard (255), descriptor
   validation, stage-and-swap. The "skip re-deploy" promise is **already delivered by the
   content-addressed deploy cache** — fresh boot with cache intact reuses the same packageId, so
   codegen re-emits identical bindings; `wipe --keep-cache; boot` reaches the same on-chain state.
   Snapshot's residual value is a _labeled checkpoint_ (an owner-call). Merge host-tree-tar into a
   per-service export contract. **~1.5–2.5k LOC. Gate on an e2e proving cache-hit restore parity
   before shipping.**
2. **Cross-process lock cleanup — confirm, but payoff already banked.** `acquireExclusive` is
   **already one core** (stack-lock.ts:183) with thin wrappers; `runtime-control-lock.ts` is
   **verified a 9-line path helper**. Remaining dedup: fold snapshot-reservation's second standalone
   `sweepOrphan` (~lines 100–149) into the core reclaim path. **~100–150 LOC, not the
   explorer's 700.** Do **not** touch liveness, the unparseable-body re-stat guard, backoff reset,
   or foreign-host short-circuit (each fixes a real race).
3. **Fork-holder ↔ roster liveness micro-dedup** (~10–40 LOC). Expensive machinery is **already
   shared**; only `isForkHolderAlive` (~8 lines) duplicates. The two holders differ in load-bearing
   semantics (instanceId vs pid+host+startTime; inside-data-dir vs stack-root; no-heartbeat-reclaim
   vs heartbeat-reclaim), so do **not** force them through one model. Owner's plan already says "do
   NOT touch the roster."

### OWNER CALLS — real product tradeoffs

1. **Web dashboard** (~17.4k LOC: plugin 3279 + control-plane 366 + SPA 14128 + 1.3M shipped
   bundle). **The explorers' "TUI parity" premise is false** — verified: TUI keymap is q/r/s only;
   the CLI tree has no logs/traces/fund/mint/clock. The dashboard is the **sole** surface for
   searchable Logs + Traces, Fund (SUI/WAL/DEEP), Mint, advance-clock, restartPlugin, and
   postgres/deepbook/seal panels — **and it ships default-on in the scaffold**
   (`members:[localnet, app, dashboard()]`). The owner's own plan (decision 2) and web-dashboard
   design notes signal _invest_. **Decision: (A) KEEP** — fix docs, trim the bundle, do the Stage-E
   shared-projection + endpoint-fold to remove duplication without losing value; or **(B) CUT** —
   but only _after_ porting `devstack fund/mint/clock/restart <plugin>` + `devstack logs/traces`
   over the existing logStore/spanStore. The capability-port is the gating work; deletion is
   non-regressive only once it's done. Note: observability (2095 LOC, 59 importers, feeds the TUI)
   is **not** a dashboard dependency and stays regardless.
2. **Physically split walrus/seal/deepbook** (9924 LOC) into separate published packages —
   **packaging only, zero LOC reduction.** They are already opt-in (scaffolder drops unselected;
   sideEffects:false tree-shakes them). Relocates maintained LOC, doesn't cut it. Yes/no on whether
   a leaner core npm surface is worth losing single-barrel discoverability.
3. **Snapshot labeled-checkpoint convenience** — the user-facing half of the snapshot reduction.
   Keep named save/restore, or accept `wipe --keep-cache; boot` (identical on-chain, no label)?

### KEEP — load-bearing for users (rejected cuts)

- **account/coin/wallet/package** (~17.5k of the explorer's "27.3k optional layer"): they emit the
  typed-bindings deliverable users come for; `package` imports `account`+`coin` so the split is
  **architecturally impossible**. Cut rejected.
- **Traefik router** (~3.1k): the router-disabled path **explicitly fails for container upstreams**
  (service.ts:520); cutting it forces _adding_ host-port publishing + CORS + collision handling
  (net-negative) and breaks the documented `endpoint()/.localhost:5175` origin. Cut rejected.
- **Roster + command-channel + liveness + stack-lock + container-claims** (~2.6k): dominant consumer
  is the **single-stack** apply/snapshot/up-refusal routing; the ~50-LOC sentinel reintroduces
  recycled-PID mis-routes and a double-`up` TOCTOU race. The real gap is a missing two-process
  integration test. Radically-reduce rejected.
- **Codegen** (2.4k), **Manifest** (290), **Observability** (2095), **TUI** (3111), **CLI** (~3.7k),
  Sui modes + PortBroker + stage-and-swap + identity-guard + descriptor validation — all
  load-bearing.
