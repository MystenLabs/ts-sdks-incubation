# Step 3 Plan — Collapse the Substrate State-Model Machinery

> **Status:** Design for owner review. Not execution. Verified against the live tree on branch `mh/devstack-cleanup` @ `5c597fc4` — every file:line below was re-checked on the real branch.
>
> Produced by an 18-agent workflow: 8 system deep-mappers + 3 cross-cutting mappers → 3 independent architects (minimal-blast / clean-slate / strangler) → adversarial stress-test of each → synthesis. The synthesis fixed two load-bearing claims the original audit got **wrong** (see §8).

---

## 1. Summary

The brief's north-star — "one projection `SubscriptionRef` + a manifest" — is **half right and half a category error**, and getting that distinction correct is the whole plan. There is already exactly **one runtime state model**: the process-scoped `SubscriptionRef<SubscribableState>` (the projection), mutated by one pure reducer (`applyEvent`/`updateRef`). The other "state systems" in the brief are **not competing copies of that state** — they are genuinely different kinds of thing the audit lumped together: the supervisor's live per-plugin runtime (Refs/Deferreds/Scopes — KEEP-VERBATIM), an on-disk handoff to out-of-process build integrations (the manifest — cannot become an in-process ref), and scope-local capability plumbing with zero persistence (strategy/scoped registries). So Step 3 is **"strip the machinery wrapped around the one model and delete the one genuinely-redundant persistence twin"** — not "merge five state models into one ref."

The end state is **four narrow state owners, each with an unchanged public contract**: (1) the projection ref (the one model, fed by one reducer, with its leaf bridges folded in); (2) the supervisor live runtime (verbatim); (3) a **slimmed manifest** (dead `services`/contribution channel removed, the live `extras` and `identity.chain` preserved); (4) a **single strategy multimap** (the generic scoped-registry core inlined into its one real consumer; the single-mode LWW surface pushed into its two plugin consumers). The largest single deletion — `projection/persisted.ts` (the `projection.v4.json` snapshot) — is **owner-gated** but the evidence is resolved: it is read by exactly one consumer (the offline `status` verb), and ID-stability provably runs through a separate path (the package plugin's `CacheService` + each plugin's `preRestore` identity contribution), so deleting it does **not** touch decryption.

**Honest net LOC delta:** **−420 to −620**, depending on three owner decisions (persisted.ts: −180 if deleted / −120 if slimmed / 0 if kept; manifest `services` hard-removal vs optional: −20 / 0; strategy-helper inline: −50 / 0). **Recommended default path: ≈ −470.** Most of the headline 3678 LOC the brief frames as "state systems" is the KEEP-VERBATIM supervisor core (lifecycle 1126 + supervisor-state 748) and the load-bearing reducer — correctly **not** removable.

**Overall risk: medium.** No step touches the supervisor acquire/teardown core, the contribution pipeline, the `updateRef` seam, or the restore/identity-guard/warm path (the PR#21 class). The two real hazards are both mitigated below: a **name-blindness blocker** (do not inline `operational-endpoints` into substrate) and a **missing regression test** (the multimap drop-by-seq finalizer is unguarded — add the test *before* collapsing).

---

## 2. Current state

Measured LOC (`wc -l`, live branch). "In scope" = touched by this plan; "verbatim" = explicitly preserved.

| System | LOC (total) | Files in scope | What it actually is | Verdict |
|---|---|---|---|---|
| **projection** | 948 | `update.ts` (502), `persisted.ts` (241), `state-ref.ts` (128), `operational-endpoints.ts` (68), `index.ts` (9) | The one read-model ref + reducer + persisted twin + leaf bridges | Collapse machinery; the **ref + reducer stay verbatim** |
| **lifecycle/lifecycle-fact.ts** | 69 | `lifecycle-fact.ts` | EngineEvent→LifecycleFactDelta bridge (logically the reducer's, not lifecycle's) | Move into reducer |
| **lifecycle (core)** | 1057 | dep-graph, plugin-registry, state-machine, ready-gate, signals, watch-attribution | The supervisor acquire/teardown runtime | **KEEP VERBATIM** |
| **manifest** | 461 | `substrate/manifest.ts` (184), `runtime/manifest/manifest.ts` (277) | On-disk handoff for out-of-process consumers + a dead contribution channel | Slim (drop dead `services`/contributions) |
| **scoped-registry** | 387 | `service.ts` (364), `index.ts` (23) | Generic seq-tagged core; 1 multimap consumer + 2 single-mode consumers | Collapse into 3 consumers |
| **strategy-registry** | 195 | `service.ts` (105), `chain-probe-for.ts` (41), `chain-keyed-strategy-for.ts` (44), `index.ts` (5) | Scope-local capability multimap + 2 helper wrappers | Absorb core; helper inline (owner-gated) |
| **control-plane** | 341 | `service.ts`, `domain.ts` | Read-seam over the ref for the dashboard | **KEEP contract**; optional de-abstraction |
| **supervisor-state** | 748 | `state.ts` + concern modules | The supervisor's state bag | **KEEP VERBATIM** |
| **stage-and-swap** | 415 | — | Atomic publish primitive | **KEEP VERBATIM** (untouched) |

---

## 3. Target state model

**One runtime state model + three narrow owners. Nothing folds a `Scope.Closeable` or an out-of-process file into the ref.**

### (A) THE PROJECTION — the one model
- One process-scoped `SubscriptionRef<SubscribableState>`, created once in boot **before** `supervise` (the id-stability/renderer-continuity boundary; `start-supervisor.ts:96-105` design). `SubscribableState`'s shape stays **verbatim** — the dashboard reads every top-level field directly (`dashboard/schema/types.ts`) and the TUI subscribes to `.changes`.
- Mutated by exactly one pure reducer `applyEvent` via the single `updateRef` seam (`wiring.ts`). The exhaustive `_exhaustive: never` tag switch and the `__ProjectionFieldsClosed`/`__RowFieldsClosed` compile guards stay — they are the name-blind vocabulary gate.
- **What folds in:** `lifecycle-fact.ts` (the `factFromEvent` switch + `applyLifecycleFact` merge-not-replace) **moves into** `update.ts`, **re-exported** so its test repoints with one line. `state-ref.ts` compile guards (`__NoDisplayVocab`) move next to the other guards in `projection.ts`; `state-ref.ts` becomes just `emptyProjection` + `makeProjectionRef[Sync]`. The `projection/index.ts` barrel is deleted (7 test importers repointed; **zero src importers** — `substrate/runtime/index.ts` already imports sub-files directly).
- **`operational-endpoints.ts` STAYS where it is** (see §6 name-blindness — it is *not* inlined into substrate). Only the barrel indirection is dropped.
- **`persisted.ts` / `projection.v4.json`:** owner-gated (§7-Q1). The reducer's `AccountProjectionSchema`/`PackageProjectionSchema` (still needed for `projection.updated` payload validation, load-bearing per STYLE_GUIDE §20) relocate into `update.ts` regardless of the persisted.ts decision.

### (B) THE SUPERVISOR LIVE RUNTIME — verbatim
`PluginRegistry` (statusRef/readyGate/scope/`__resolved` per `PluginKey`), `ResolvedGraph`, `SupervisorState` bag, `ContributionDispatcher` and the five closed dispatch methods, the `state-machine.ts` ALLOWED table, `ready-gate.ts`/`signals.ts`/`watch-attribution.ts`. `PluginKey` minted once at `resolveGraph` (`dep-graph.ts:102-107`) — **the real ID-stability boundary**. Nothing here changes except that this owner *donates* `lifecycle-fact.ts` to the reducer (it logically belongs to projection, not lifecycle).

### (C) THE MANIFEST — slimmed on-disk handoff
Out-of-process handoff for Vitest/Playwright/Vite (which cannot import the engine). Survives as `{ identity:{app,stack,chain}, manifestVersion, endpoints, extras, codegen }`.
- **`identity.chain` STAYS** — load-bearing network-selection persistence (the strategy-lookup key; `projection.identity.network` is *set from* it at boot).
- **`extras` STAYS** — verified live: `options.extras` → `resolveManifestExtras` factory → written to disk → decoded into the public `StackContext.extras` (`read-stack-context.ts:151,176`, `stack-context.ts:73`). **This is a user feature, not dead code** (the strangler design was wrong here).
- **DROPPED:** the `services` slot + `PluginManifestContribution` + the contributions loop — provably dead (`buildEnvelope` is called once, `boot.ts:706` region, with `contributions: []`; `services` is therefore always `{}`).
- Endpoints come solely from `endpointSinksFromRoute` + the operational fallback (already the single derivation).

### (D) THE STRATEGY MULTIMAP — one capability store
The generic `makeScopedMultimap` core (seq-tagged store + drop-by-seq uninterruptible finalizer + priority/seq winner-fold) **inlines into its one consumer**, `strategy-registry/service.ts`. The single-mode `defineScopedRefMap` (LWW) **moves into its two consumers**, `coin/registry.ts` and `package/registry.ts`, as a plain `Ref<Map>` (the `.changes` `SubscriptionRef` is dead — verified zero readers; the dashboard subscribes only to the projection ref). `scoped-registry/` is deleted. The chain-* helpers are owner-gated (§7-Q4): **default KEEP** — they dedup the one `unknown→ChainProbe<Key>` cast across 5 plugins / 12 call sites; inlining is relocation that re-spreads the cast.

### How the manifest + dashboard read it
- **Dashboard** reads (B/C via the control-plane seam): the live `SubscribableState` ref (`state`, subscriptions), the name-blind `resolvedValues` accessor, snapshot/log accessors. **Contract unchanged.** Control-plane internal helper de-abstraction is optional and orthogonal (§5 step 8).
- **Manifest** is a *derived, write-only* projection of two ref fields (`identity`→`{app,stack,chain}`, `endpoints`) + codegen paths + `extras`, written once per cycle in the post-acquire hook. The endpoint overlap with the projection is a **single derivation** (`endpointSinksFromRoute`), not a duplicate.

### What stays verbatim (the protected spine)
Supervisor core (acquire/teardown/dep-graph/registry/state-machine), the contribution pipeline (PluginCtx closed verbs → buffer → seal-after-start → dispatcher replay), control-plane read contract, the projection ref process-lifetime invariant, the `updateRef` seam, `persisted.ts` rebrand-on-restore **if** persistence is kept, `stageAndSwap`, and the restore/identity-guard/warm path.

---

## 4. Merge map

| Current | → Destination | How / evidence |
|---|---|---|
| `projection/lifecycle-fact.ts` (69) | **Move** into `update.ts`, keep named exports | `factFromEvent`+`applyLifecycleFact` are called only from `update.ts`; merge-not-replace preserved. Remove `export * from './lifecycle-fact.ts'` at `lifecycle/index.ts:15`. Repoint `lifecycle-fact.test.ts:19` import. **It is a MOVE not an inline** — the test imports the names. |
| `projection/state-ref.ts` guards (`__NoDisplayVocab`) | `projection.ts` (next to `__ProjectionFieldsClosed`) | Compile-time only. `state-ref.ts` → factory + `emptyProjection`. |
| `projection/index.ts` barrel (9) | direct imports | **0 src importers**; 7 test importers repointed: lifecycle-fact, update, decode-once, persisted, state-dir-precedence, main, boot. |
| `projection/operational-endpoints.ts` (68) | **STAYS** (drop only barrel indirection) | Has 2 callers; one is `acquire-node.ts:438` *inside substrate*. Moving the `faucetUrl:'faucet'` table off its allowlisted home breaks name-blindness (§6). Net cost of any move ~10 LOC + an invariant — not worth it. |
| `projection/persisted.ts` (241) | **DELETE** (default) / slim / keep — owner-gated | Sole reader: `cli/main.ts:145` (offline `status`). Relocate `AccountProjectionSchema`/`PackageProjectionSchema` into `update.ts` regardless. ID-stability is independent (CacheService + `preRestore`). |
| `scoped-registry` multimap (`makeScopedMultimap`, ~150) | `strategy-registry/service.ts` | Only consumer. Seq-tagged store + drop-by-seq uninterruptible finalizer + winner-fold preserved verbatim. |
| `scoped-registry` single-mode (`defineScopedRefMap`, ~80) | `plugins/coin/registry.ts` + `plugins/package/registry.ts` | `Ref<Map>` not `SubscriptionRef` (`.changes` dead). filter-then-append keeps one-entry-per-key. `ScopedRefMapKeyMissingError` → shared errors. Delete `scoped-registry/`. |
| `manifest/manifest.ts` `PluginManifestContribution` + contributions/services loop (~55) | **DELETE** | `boot.ts` already passes `contributions:[]`. `buildEnvelope` input → `{identity, endpoints, extras, codegen}`. |
| `substrate/manifest.ts` `services` field (`ManifestEnvelope` + Schema) | **`Schema.optional`** (default) or hard-remove (owner-gated, §7-Q2) | Schema at `substrate/manifest.ts:77,161` (a **different module** from `runtime/manifest/manifest.ts` — the strangler cited the wrong file). Optional avoids the new-manifest/old-consumer decode break for ~2 LOC. |
| `strategy-registry/chain-probe-for.ts` + `chain-keyed-strategy-for.ts` (85) | **KEEP** (default) / inline (owner-gated, §7-Q4) | They dedup one cast across 5 plugins. If inlined, *also* delete the two helper tests **only after** their winner-selection/`StrategyNotFoundError`/prefix-assembly assertions are folded into a kept test. |
| control-plane `buildControlPlaneDomain`/`readOptional`/`enumerateResolvedValues`/`snapshotEntryFrom` (~50) | `controlPlaneDomainFromContext` | **Optional, off critical path.** `ControlPlaneService`/`ControlPlaneDomain` interfaces unchanged. **Keep `emptyControlPlaneDomain` exported** (pins the KEEP-VERBATIM shape for 5 test sites). |
| `scoped-registry` / `strategy-registry` cores | (relocated, not deleted) | The cores' *behavior* survives byte-for-byte; only their module boundaries collapse. This is honest relocation — counted as such in §8. |

---

## 5. Sequenced steps

Ordered to minimize blast radius: pure-relocation tidy-ups first (low risk, no id-stability surface), then the dead-code deletes, then the registry collapse (gated behind a new test), then the owner-decision deletes last. Each step is independently green against its named command. **Per the no-inline-validation-in-parallel-agents rule, these are sequential single-agent steps; the full e2e net runs once in step 9.**

> Validation uses `pnpm vitest run <path>` and `pnpm exec tsc -b`. Replace with the repo's actual scripts at execution (`running-vitest` skill).

---

**Step 1 — Move `lifecycle-fact` into the reducer**
- *Changes:* Move `factFromEvent` + `applyLifecycleFact` + `LifecycleFactDelta` into `update.ts`, **keep them as named exports**. Delete `lifecycle-fact.ts`; remove `export * from './lifecycle-fact.ts'` (`lifecycle/index.ts:15`). Repoint `lifecycle-fact.test.ts:19` to `update.ts`.
- *Files:* `update.ts`, `lifecycle/lifecycle-fact.ts` (del), `lifecycle/index.ts`, `lifecycle-fact.test.ts`.
- *LOC:* **−15** (move + re-export, not a true boundary deletion — honest).
- *Risk:* low.
- *Validate:* `pnpm vitest run test/substrate/runtime/lifecycle/lifecycle-fact.test.ts test/substrate/runtime/projection/update.test.ts && pnpm exec tsc -b`

**Step 2 — Move projection compile guards to `projection.ts`; drop the projection barrel**
- *Changes:* Move `__NoDisplayVocab` into `projection.ts`. `state-ref.ts` → `emptyProjection` + `makeProjectionRef[Sync]`. Delete `projection/index.ts`; repoint **all 7 test importers** (lifecycle-fact, update, decode-once, persisted, state-dir-precedence, main, boot). Sequence note: if step 8 keeps `persisted.ts`, repoint its barrel importers *here* so step 8 stays independent.
- *Files:* `projection.ts`, `state-ref.ts`, `projection/index.ts` (del), 7 test files.
- *LOC:* **−9**.
- *Risk:* low (guards are compile-time — `tsc` is the real check).
- *Validate:* `pnpm exec tsc -b && pnpm vitest run test/substrate/runtime/projection/`

**Step 3 — Drop dead manifest `services` + `PluginManifestContribution` channel**
- *Changes:* `buildEnvelope` input → `{identity, endpoints, extras, codegen}`. Delete `PluginManifestContribution`, the contributions loop, the services accumulation (`runtime/manifest/manifest.ts`). Make `services` `Schema.optional` in **`substrate/manifest.ts:77,161`** (the correct schema module) and on the `ManifestEnvelope` interface; leave `StackContext.services`/`read-stack-context.ts:150` as typed-optional defaulting to `{}` (**do not delete the read-side** — it is the public out-of-process surface). Drop `contributions:[]` from the `boot.ts` call.
- *Files:* `runtime/manifest/manifest.ts`, `substrate/manifest.ts`, `boot.ts`, `read-stack-context.ts`, `stack-context.ts`.
- *LOC:* **−70** (default optional path; −90 if owner approves hard-remove + version bump).
- *Risk:* medium (schema-decode coupling — mitigated by `optional` so old + new manifests both decode).
- *Validate:* `pnpm vitest run test/substrate/runtime/manifest/ test/build-integrations/runtime/read-stack-context.test.ts && pnpm exec tsc -b`

**Step 4 — Add the missing multimap finalizer test (BLOCKER PREREQUISITE for steps 5-6)**
- *Changes:* Add a test that registers the same capability key in two sibling scopes (A then B), closes A, asserts B's entry **survives** and A's is **gone** (drop-by-**seq**, not drop-by-key); plus an interrupt test that interrupts `register` mid-flight and asserts no entry leaks past scope close. This is the single most dangerous behavior in the registry collapse and is currently **unguarded** (verified: `scoped-registry/service.test.ts` covers only single-mode; the `strategy-registry/` dir has only the two chain-* helper tests).
- *Files:* `test/substrate/runtime/strategy-registry/sibling-scope.test.ts` (new).
- *LOC:* +40 (new test — *not* counted against the delta).
- *Risk:* low (additive).
- *Validate:* `pnpm vitest run test/substrate/runtime/strategy-registry/sibling-scope.test.ts` (green against current code, before any inline).

**Step 5 — Strangle single-mode into coin + package**
- *Changes:* Give `coin/registry.ts` and `package/registry.ts` each a self-contained LWW service over `Ref<Map>` (filter-then-append, seq-ordered; no `.changes`). Repoint both off `defineScopedRefMap`. Move the single-mode tests into the plugin suites.
- *Files:* `coin/registry.ts`, `package/registry.ts`, `scoped-registry/service.ts`, plugin/coin + plugin/package tests.
- *LOC:* **+40** (honest: LWW logic duplicated 2× — this is relocation that slightly *grows* LOC but removes the shared-abstraction tax).
- *Risk:* medium.
- *Validate:* `pnpm vitest run test/plugins/coin/ test/plugins/package/`

**Step 6 — Strangle the multimap into strategy-registry; delete `scoped-registry/`**
- *Changes:* Inline the seq-tagged store + `register`/`entriesFor`/`snapshot`/`keys` + drop-by-seq uninterruptible finalizer (specialized to `Entry`) into `strategy-registry/service.ts`. Winner-fold (priority DESC, seq DESC) + finalizer preserved verbatim. Delete `scoped-registry/`.
- *Files:* `strategy-registry/service.ts`, `scoped-registry/` (del).
- *LOC:* **−200**.
- *Risk:* medium — **now guarded by step 4's new test** (a naive drop-by-key rewrite would fail it).
- *Validate:* `pnpm vitest run test/substrate/runtime/strategy-registry/ test/plugins/account/`

**Step 7 *(OWNER-GATED, §7-Q4)* — Inline chain-* helpers**
- *Changes:* Inline `chainProbeFor`/`chainKeyedStrategyFor` at 5 plugins / 12 call sites. **Before deleting** the two helper tests, fold their winner-selection + `StrategyNotFoundError` + `<prefix>:<chainId>` assertions into a kept test. Keys stay opaque strings (name-blindness-neutral).
- *Files:* seal/action/walrus/package/index.ts, account/funding.ts, helper files (del), helper tests.
- *LOC:* **−50** (or **0** if owner keeps the helpers — **recommended default: KEEP, skip**).
- *Risk:* low.
- *Validate:* `pnpm vitest run test/plugins/seal test/plugins/account test/substrate/name-blindness.test.ts`

**Step 8 *(OWNER-GATED, §7-Q1)* — Resolve projection persistence**
- *Changes (if DELETE):* Delete `writeProjectionSnapshot`/`persistProjectionChanges`/`readProjectionSnapshot` + the hand-mirrored schemas + `rebrandPersistedState`. Repoint `cli/main.ts:145` to build a degraded `SubscribableState` from `readStackContext` (manifest identity+endpoints; rows/accounts/packages empty — the stack is down). Remove the 3 writer call sites (`up.ts:639`, `apply.ts:170`, `snapshot.ts:294`). **Remove the `persisted.ts` entry from `name-blindness.test.ts:117`.** Rewrite/delete `persisted.test.ts`, the `main.test.ts` status round-trip, and `state-dir-precedence.test.ts` assertions; **add a new unit test** for the degraded offline-status `SubscribableState` (must satisfy the closed-vocabulary shape).
- *Changes (if SLIM — the de-risked middle option):* Keep a minimal blob (rows-status slice only); delete the `StructuredError`/`Endpoint`/`BuildEntry`/full-state mirrors + rebrand (~120 LOC) while preserving offline rows.
- *Files:* `persisted.ts`, `update.ts` (schema relocation), `cli/main.ts`, `up.ts`/`apply.ts`/`snapshot.ts`, `name-blindness.test.ts`, 3 test files + 1 new.
- *LOC:* **−180** (delete) / **−120** (slim) / **0** (keep).
- *Risk:* high (largest deletion) — but **id-stability-inert by verified evidence** (sole reader is the offline status verb; ID-stability is CacheService + `preRestore`). Gated on a green private-content-boot e2e in step 9.
- *Validate:* `pnpm vitest run test/cli/main.test.ts test/cli/state-dir-precedence.test.ts test/substrate/runtime/projection/` then the **pre-merge id-stability gate** below.

**Step 9 — Full sweep + e2e net + minimality check**
- *Changes:* none (integration gate). Run the delete-or-relocate minimality check (`feedback_no_relocation_shortcuts`): confirm no dead re-exports in `substrate/runtime/index.ts`, no orphaned barrels, no leaked plugin names.
- *Validate:* `pnpm exec tsc -b && pnpm vitest run` (full ~1853 suite) `&& pnpm test:e2e` — critically **private-content-boot** (decrypt across restart/restore) and the **snapshot-restore-matrix** (PR#15: all surfaces survive restore). **Plus the dedicated pre-merge id-stability gate for step 8** (see §6).

---

## 6. Invariant guards

**ID-stability (chainId / vault-pkg-id / seal ids / walrus object ids must not churn).**
- *How preserved:* No step touches the actual ID-stability path. Verified on the live tree: packageId stability runs through the package plugin's `CacheService` keyed `<namespace>/<chainId>/<contentHash>` (`mode-local.ts:9,238`); the restore identity-guard sources its slice from **each plugin's `preRestore` contribution**, not from the projection snapshot (`identity-guard.ts:14,92-93`); the snapshot orchestrator does docker-commit, not projection-capture. `PluginKey` is minted once at `resolveGraph` and reused across restart (`dep-graph.ts:102-107`) — untouched. The profile's "packageId/upgradeCapId persistence in projection.v4.json is load-bearing" claim is **FALSE for restore** — those fields are *written* to the snapshot but never *read back* to drive decryption (the sole reader is the offline `status` verb, `cli/main.ts:145`; `persisted.test.ts:89` literally describes itself as "round-trips ... **for status readers**").
- *How proven:* Step 9 runs the **private-content-boot e2e**. **Plus a dedicated pre-merge gate for step 8:** boot a real walrus+seal stack, snapshot it, **`rm` `projection.v4.json` from the runtime root**, restore, and assert the seal-encrypted blob still decrypts — directly proving the snapshot is not a restore input (the existing e2e never reads the file, so this is the only test that *positively* proves independence).

**Restore round-trip (PR#21 class: warm/interrupted-restore ordering, participant registration).**
- *How preserved:* No step touches `start-supervisor.ts` seed (`:187/:202`), the `makeProjectionRef`-before-`supervise` ordering (`up.ts:536` precedes `:556`), the warm-cache path, or the interrupted-restore sentinel. The projection-snapshot writers (step 8) are write-only fire-and-forget sinks wired *inside* the post-start callback — deleting them cannot perturb boot ordering.
- *How proven:* Step 9 snapshot-restore-matrix e2e (PR#15: sui/deepbook/walrus-blob/seal-vault/codegen all survive restore).

**Dashboard contract (control-plane read seam).**
- *How preserved:* `ControlPlaneService` + `ControlPlaneDomain` interface shapes are KEEP-VERBATIM. The optional step-8-adjacent de-abstraction (control-plane helpers) folds *production* helpers only; `emptyControlPlaneDomain` stays exported (it pins the shape for 5 test sites). The dashboard subscribes only to the projection ref (`dashboard/schema/root.ts`), never to coin/package registries — so the single-mode `SubscriptionRef→Ref` drop (step 5) is invisible to it.
- *How proven:* `pnpm vitest run test/plugins/dashboard/` (the GraphQL read-contract regression net) in step 9.

**Name-blindness (`substrate/**` must not mention plugin names off the allowlist).**
- *How preserved:* **`operational-endpoints.ts` is NOT inlined** — this is the explicit fix for the minimal-blast blocker. Its `faucetUrl: 'faucet'` table is allowlisted at `name-blindness.test.ts:130`; `acquire-node.ts` (one of its 2 callers, *inside* substrate) is **not** on the allowlist, so moving the table there would fail with `acquire-node.ts matches: [faucet]`. We drop only the barrel indirection. The strategy multimap/single-mode collapses (steps 5-6) keep capability keys as opaque strings. Step 8 removes the `persisted.ts` allowlist entry **in the same commit** it deletes the file (the cap `<= 15` tolerates the shrink).
- *How proven:* `test/substrate/name-blindness.test.ts` is in the validation set for steps 7, 8, and 9.

**Selective-restart (downstream closure, fresh Deferred/Scope per restart).**
- *How preserved:* The entire supervisor live runtime (B) is verbatim — `planRestart`, `downstreamClosure`, `resetForRestart` (fresh readyGate/scope, reused statusRef + PluginKey) are untouched. `lifecycle-fact` (step 1) is the *reducer's* fact mapping, not the restart machinery; moving it does not touch `dep-graph.ts`/`plugin-registry.ts`.
- *How proven:* The supervisor + restart unit suites run unchanged in step 9; the merge-not-replace lifecycle delta is pinned by `lifecycle-fact.test.ts` + `update.test.ts` (step 1).

---

## 7. Risks & open questions for the owner

**Q1 — `projection.v4.json` / `persisted.ts`: DELETE, SLIM, or KEEP? *(gates the largest deletion, ±180 LOC)***
The evidence is **resolved, not a coin-flip** (the strangler framed it as undecidable — it isn't): `readProjectionSnapshot` has exactly one consumer (`cli/main.ts:145`, the offline `status` verb), ID-stability runs through CacheService + `preRestore`, and the dedicated test calls itself a "status reader." The only real cost of deletion is a **degraded offline `devstack status`** — when the stack is *down*, `status` would show identity + endpoints (from the manifest) but empty rows/accounts/packages.
- **Recommendation: SLIM, not full-delete** — keep a minimal rows-status blob (≈ −120 LOC) so offline `status` still shows per-plugin status, while deleting the scary hand-mirrored full-state schemas + rebrand. This captures ~⅔ of the win and entirely sidesteps the "is a degraded offline status acceptable?" UX question. Full-delete (−180) only if the owner confirms endpoints-only offline status is fine. Either way, gate on the dedicated `rm projection.v4.json` + decrypt e2e (§6).

**Q2 — Manifest `services`: `Schema.optional` or hard-remove with a version bump?**
The dead *writer* machinery (`PluginManifestContribution` + the loop) dies either way (step 3). The question is only the on-disk *shape*. Hard-removal makes a new manifest (no `services`) fail decode in an *old* build-integration consumer pinned to the current `CONSUMER_MANIFEST_VERSION` (the genuine cross-version break the minimal-blast design inverted).
- **Recommendation: `Schema.optional`** (≈ 2 LOC vs the full version-bump dance across 2 packages). It avoids both the public-type break and the cross-version decode break. Batch the hard field-removal into the next deliberate manifest version bump.

**Q3 — `StackContext.services` public type field: keep as frozen-empty `{}` or remove?**
It is exported public build-integration API (`stack-context.ts:71`), always `{}`, read by no live consumer (the `.services` hits in the tree are unrelated Traefik router services + log-filter services).
- **Recommendation: keep as typed-optional `{}`** for now — pair its removal with the Q2 version bump. Only remove sooner if the owner confirms no shipped/out-of-repo app reads `ctx.services`.

**Q4 — chain-* helpers (`chainProbeFor`/`chainKeyedStrategyFor`): inline or keep?**
The profile flags them as "boilerplate-collapsible," but they centralize the one load-bearing `unknown→ChainProbe<Key>` cast across 5 plugins / 12 call sites. Inlining is **relocation that re-spreads the cast** (and forces folding their winner-selection test coverage elsewhere — that coverage is *not* in funding/dashboard tests, verified).
- **Recommendation: KEEP (skip step 7).** They are the dedup, not the cruft. If the owner wants module-count reduction, relocate them to a plugin-side shared util (out of substrate) rather than inlining 12×.

**Q5 — Control-plane helper de-abstraction (step-8-adjacent, ~50 LOC): in this step or backlog?**
Real machinery-removal but orthogonal to the state-model question, and the dashboard read contract is the riskiest thing to perturb.
- **Recommendation: backlog** (`notes/devstack-rewrite-backlog.md`). Keep `emptyControlPlaneDomain` exported regardless.

---

## 8. Honest accounting

**Genuine removal (dead or truly-redundant code):**
- Manifest `services` + `PluginManifestContribution` + contributions loop: **−70**. *Genuinely dead* — `buildEnvelope` is called once with `contributions:[]`; `services` is provably always `{}`.
- `projection.v4.json` persistence: **−120 (slim) to −180 (delete)**. *Genuinely redundant* — a write-mostly twin read only by the offline status verb; not a restore input. This is the single biggest honest win and the audit **under-estimated** it (the profile mislabeled it "load-bearing for decryption," which is false).
- `projection/index.ts` barrel: **−9**. Genuine (0 src importers).

**Relocation (behavior survives byte-for-byte; module boundary collapses):**
- `scoped-registry` core → strategy-registry: the −200 is **mostly relocation** of the seq-tagged store + finalizer into its one consumer. Net LOC drops because the generic-abstraction surface (interface + two-surface dispatch) is shed, but the load-bearing logic moves, it doesn't disappear.
- Single-mode LWW → coin/package: **+40, an honest negative** — duplicating LWW 2× *grows* LOC; we accept it to delete the shared-abstraction tax (3 consumers, one of them dead-stream). This is the one place the plan trades LOC for fewer systems.
- `lifecycle-fact` → reducer: **−15, mostly relocation** (it's a MOVE with re-export, not a true boundary deletion — the test imports the names, so the boundary partially survives as exports).
- chain-* helpers (if inlined): **relocation that re-spreads a cast** — recommended *not* done.

**What the audit over/under-estimated:**
- **Over-estimated:** the literal "collapse 7 systems into one ref" framing. Most of the 3678 LOC is the KEEP-VERBATIM supervisor core + reducer — *correctly not* state-model duplication. The clean-slate's headline −545 and strangler's −485 both over-counted by treating `lifecycle` (1126) and `supervisor-state` (748) as collapsible; they are not. The minimal-blast's −188 *under*-reached by leaving persisted.ts and scoped-registry on the table.
- **Under-estimated:** persisted.ts (the audit called it load-bearing; it is the largest safe deletion). And the manifest `extras` channel was *over*-flagged as dead by two designs — it is a **live user feature** (verified), so it is correctly preserved here.

**Net delta by path:**
- **Recommended default** (slim persisted, optional services, keep helpers, control-plane to backlog): **≈ −470** (−70 manifest −120 persisted −9 barrel −15 lifecycle-fact −200 scoped-core +40 single-mode −96 misc/state-ref/guards), offset by +40 single-mode duplication and the +40 new test (not counted against product LOC).
- **Maximal** (full-delete persisted, hard-remove services, inline helpers): **≈ −620**.
- **Conservative** (keep persisted entirely): **≈ −290**.

No step relocates complexity without a net reduction except the deliberate single-mode duplication (+40), which buys the deletion of an entire generic substrate primitive (−387 directory) — a clearly favorable trade under the no-relocation rule.

---

## Stress-test results (per design)

| Approach | LOC delta claimed | Survives invariants | Adversary confidence |
|---|---|---|---|
| minimal-blast | −188 | yes (under-reached) | high |
| clean-slate | −545 | only after fixes | medium |
| strangler | −485 | only after fixes | medium |

The synthesis above takes the strangler spine (independently-green steps), grafts clean-slate's persisted.ts deletion (de-risked to SLIM by default), and applies every adversary fix: the `operational-endpoints` name-blindness blocker, the missing multimap finalizer test as a hard prerequisite, the correct `substrate/manifest.ts` schema module, and the `extras`-is-a-live-feature correction.
