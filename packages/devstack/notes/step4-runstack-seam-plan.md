# Step 4 Plan — `runStack` as the One Boot Seam

> Status: **APPROVED — IN EXECUTION** on `mh/devstack-cleanup`. Produced by a 14-agent workflow (5 boot-path mappers + 2 cross-cutting → 3 architects → adversarial stress each → synthesis). **Two stress-flagged claims were confirmed as hard blockers all three architect designs under-handled** (readiness-gate divergence; zero non-e2e coverage of the `up` boot path). This plan fixes both.
>
> **OWNER DECISIONS (2026-06-04):** validation → **proceed with Docker-free unit gates** (accept residual on the e2e-only warm/IPC round-trip; e2e blocked by the pre-existing sui-image-build issue). apply/snapshot → **INCLUDE** (Q3 overridden: route the one-shot verbs through the shared boot-core too, so `superviseStackEffect`'s assembly has ONE site everywhere → adds **Step 5**). Q1 facade / Q4 warm-CLI-only / Q6 boot-config-impl-follow-up → adopt recommendations.

---

## 1. Summary

Today `runStack` (`src/api/run-stack.ts`, 424 LOC) and the `up` verb (`runUpLive`, `src/cli/wirings/up.ts`, 709 LOC) are **two independent orchestrations of the same supervised boot**. Each separately: composes substrate+orchestrator Layers, builds the contribution dispatcher + post-acquire hook + `extendContext`, allocates a projection ref before supervising, calls `superviseStackEffect`, and hand-rolls a boot-completion gate / stop bridge / error-to-typed-error tee. The only genuinely CLI-specific work is a **set of hooks** injected into `beforeInitialAcquire`/`withinScope` (interrupted-restore recovery, warm restore/capture, roster claim, cross-process command-channel IPC, TUI mount, event tee) plus a snapshot/wipe/prune `commandHandler`. None of that is boot machinery — it is injection.

**End state:** `runStack(stack, opts) -> RunHandle` is the single function that owns the boot machinery and the one `superviseStackEffect` call for long-running stacks. The CLI `up` collapses to: resolve identity/config → call `runStack` with its CLI concerns passed as **optional injected hooks + a `commandHandler`** → `await handle.start` (readiness) → block the outer fiber on `handle.awaitShutdown` → project failures to `CliError`. The **Ink TUI becomes a pure consumer** of `handle.state` (SubscriptionRef), `handle.events` (Stream), and the command surface — exactly the inversion the owner expected ("I would have expected tui would be a consumer"). Programmatic embedders keep the same public contract.

**The single seam** is `runStack`; **what was duplicated** is the boot-machinery quartet — *(layer composition + dispatcher/hook/`extendContext` assembly + projection-ref-before-supervise + the Deferred/fork lifecycle & error tee)* — which today exists verbatim in both `run-stack.ts:254-415` and `up.ts:527-707`.

**Final `RunHandle` shape** (existing 5 fields kept verbatim; 3 additive fields):

```ts
export interface RunHandle {
  // — unchanged (existing programmatic contract) —
  readonly start: Effect<void, BootError, never>;
  readonly stop: Effect<void, never, never>;
  readonly awaitShutdown: Effect<void, unknown, never>;
  readonly events: Stream<EngineEvent, never, never>;       // single-consumer (documented)
  readonly state: SubscriptionRef<SubscribableState>;        // makeProjectionRefSync, process-lifetime
  // — additive (CLI/TUI consumers) —
  readonly commands: Queue.Enqueue<EngineCommand>;           // TUI keypress publisher + IPC dispatch
  readonly runCommand: (c: EngineCommand) => Effect<void, unknown>; // IPC ack-correlated dispatch
  readonly identity: Identity;                               // CLI roster/channel/warm paths
}
```

`commandHandler`, the warm/roster/IPC/TUI hooks, and the `whenReady` watcher are NOT public `RunHandle` fields — `commandHandler` is a `RunStackOptions` input; the hooks travel through an **internal, non-exported `runStackWithBoot`** the CLI imports (so substrate types never touch the public `runStack` facade — see §7-Q1).

**Honest net LOC delta: ≈ −95** (genuine dedup ≈ −150 from collapsing `up.ts`'s parallel `program`; offset by ≈ +55 of additive seam plumbing + the new ordering/readiness/roster regression tests this plan *adds* because the path is otherwise untested). Smaller than the −105/−122 the architects claimed because their counts omitted the test additions that are the only thing making this reviewable without e2e.

**Overall risk: high** — concentrated in one step (the `up.ts` cutover). The two things that make it tractable: (a) the PR#21 ordering already lives *inside* `superviseStackEffect` (`boot.ts:265-287`), which both paths already call, so we move *who supplies the hooks*, not *when they fire*; (b) the plan **does not unify the readiness gate onto runStack's broken watcher** (the blocker below) and **adds Docker-free boot tests** as the actual regression gate, since the cited `main.test.ts` only exercises `up --help` and never boots a supervisor.

**Two corrections to the architects' shared premises, verified in-tree:**
1. **No `start`/`run` split is needed** (clean-slate proposed one). The SIGINT handler is `forkScoped` *inside* `startSupervisor` (`start-supervisor.ts:359`, `installSignalHandler(commands)`); the latch + `awaitShutdown` drive teardown **identically whether the supervisor is the outer fiber or `forkDetach`ed**, provided the CLI fiber blocks on `handle.awaitShutdown`. `forkDetach` (`run-stack.ts:371`) is fine for the CLI.
2. **The readiness gate must NOT be unified onto runStack's current per-node watcher** (minimal-blast and clean-slate both kept it; strangler-stress flagged it without a fix). **Hard blocker** — detailed in §3.2.

---

## 2. Current state

| Surface | File | LOC | Boot role |
|---|---|---|---|
| `runStack` | `src/api/run-stack.ts` | **424** | Public programmatic seam: forkDetach supervisor, sync handle, Deferred-gated boot |
| `runUpLive` (`up`) | `src/cli/wirings/up.ts` | **709** | CLI verb: blocking outer fiber, TUI, warm/roster/IPC, snapshot handler |
| Boot helpers (shared) | `src/orchestrators/boot.ts` | **789** | `superviseStackEffect` + dispatcher/hook/layer builders — already converged; both paths call these |
| `buildVerbLayers` | `src/cli/wirings/build-verb-layers.ts` | 60 | Substrate+orchestrator+codegen Layer composition for CLI verbs |
| `up-lifecycle` | `src/cli/up-lifecycle.ts` | 62 | `resolveUpRendererMode` + `makeQueueCommandPublisher` (CLI-only) |
| TUI renderer | `src/surfaces/tui/**` | ~2975 | Already a consumer of `state`/`events`/`publishCommand`; never consumes `runStack` (the gap) |
| **e2e boot harness** | `test/e2e/boot-config-impl.ts` | — | **THIRD parallel boot orchestration** (`makeProjectionRef`, `supervise()`, manual `awaitReady`, manual warm ordering); omits `recoverInterruptedRestore`/roster/IPC entirely |

### Duplication table — what each does that the other also does

| Responsibility | `runStack` | `runUpLive` | Verified shared helper |
|---|---|---|---|
| Substrate + orchestrator + codegen Layer composition | `run-stack.ts:254-261` | `up.ts:527-532` (`buildVerbLayers`) | both call `layerProductionOrchestrators`+`buildSubstrateLayers`+`resolveProductionCodegenOptions` (`boot.ts:295-320`) |
| Dispatcher + post-acquire hook + `extendContext` assembly | `run-stack.ts:264-275` | `up.ts:551-563` | `buildProductionContributionDispatcher`/`buildProductionPostAcquireHook`/`extendBuiltInPluginContext` |
| Projection ref allocated **before** supervise | `run-stack.ts:231` (`makeProjectionRefSync`, sync) | `up.ts:535` (`makeProjectionRef`, in-scope Effect) | **different constructors** — see §6 |
| `superviseStackEffect` invocation | `run-stack.ts:266-321` | `up.ts:555-680` | `boot.ts:241-289` |
| Boot-completion gate | `run-stack.ts:294-320` (per-node `awaitReady` watcher → `bootDeferred`) | implicit: `raceFirst(runInitialAcquire, awaitShutdown)` (`boot.ts:276`) | **NOT shared — divergent semantics (blocker, §3.2)** |
| stop → command-channel bridge | `run-stack.ts:285-292` | n/a (CLI is the blocking fiber) | — |
| Error → typed error | `run-stack.ts:339-353` (`catchCause` → `BootError` + `midRunCauseRef` tee) | `up.ts:688-707` (`matchCauseEffect` → `CliError`) | parallel implementations |
| forkDetach lifecycle (`start`/`stop`/`awaitShutdown`) | `run-stack.ts:355-408` | n/a (outer fiber) | — |

**CLI-only (true injections, not duplication):** interrupted-restore (`up.ts:584-587`), warm restore/capture (`up.ts:596-609`, `656-678`), roster claim (`up.ts:615-619`), command-channel IPC (`up.ts:611-614`, body `252-458`), TUI mount + event tee (`up.ts:620-646`), snapshot/wipe/prune handler (`up.ts:546-561`, body `97-171`).

---

## 3. Target: the one boot seam

### 3.1 What `runStack` becomes

`runStack(stack, opts) -> RunHandle` stays the **only** place `superviseStackEffect` is called for `lifetime: 'long-running'` stacks. It keeps its public signature and sync-allocation discipline. Internally:

- **Layer composition** routes through the shared `buildVerbLayers` helper (delete the inline copy at `run-stack.ts:254-261`). To avoid an `api/ → cli/` import inversion, **hoist `buildVerbLayers` into `orchestrators/boot.ts`** first (Step 0) so both `api/` and `cli/` import *down* into orchestrators.
- It **composes** caller-injected hooks with its own built-in ones (explicit, named, ordered `Effect.gen` — never free-form):
  - built-in `beforeInitialAcquire` (event-queue handoff + stop bridge, `run-stack.ts:276-293`) runs **FIRST** (so a `stop()` during boot always has a bridge), then `opts.boot.beforeInitialAcquire(handle)`.
  - built-in `withinScope` readiness-watcher → resolves boot gate runs, then `opts.boot.withinScope(handle)`.
- `opts.boot.commandHandler` threads straight into `superviseStackEffect`'s existing `commandHandler` slot (`boot.ts:224`).

The single boot sequence lives where it already lives — `superviseStackEffect` → `startSupervisor` → `beforeInitialAcquire` → `runInitialAcquire`/`raceFirst` → `withinScope` → `awaitShutdown` (`boot.ts:247-289`). **We are not moving the ordering; we are de-duplicating the wrapper around it.**

### 3.2 The readiness gate — the one structural change to the seam (blocker fix)

**Problem (verified):** runStack's boot gate forks a per-node `registry.awaitReady(key)` watcher (`run-stack.ts:305-318`). `awaitReady` (`plugin-registry.ts:232-236`) suspends on `entry.readyGate`, only resolved by `markReady` (success) or `markFailed` (fail). A node that reaches a **non-failed terminal state** — `done` (a run-to-completion plugin) — **never resolves its gate**, so `awaitReady` hangs forever. The CLI's gate is `runInitialAcquire` returning, which uses `allReadyOrTerminal` (`state.ts:86-98` → `isReadyOrTerminal`, `state-machine.ts:70-71`: `ready || done`). **These two readiness signals disagree on `done` nodes.** Routing the CLI through runStack's current watcher would **hang `up` on any stack with a run-to-completion plugin** — a silent regression all three designs missed.

**Fix:** Make the boot gate use the **supervisor-owned signal that already backs `runInitialAcquire`**. `startSupervisor` returns `{ handle, runInitialAcquire }` where `runInitialAcquire: Effect<void, SupervisorPostAcquireFailed>` (`start-supervisor.ts:109, 480`) completes exactly when `acquireFullGraph` + `allReadyOrTerminal` + `runPostAcquireHook` are done (`start-supervisor.ts:389-413`). The seam resolves `bootDeferred` from **that** signal, not from a per-node watcher: replace runStack's `withinScope` per-node watcher with the same `raceFirst(runInitialAcquire → 'booted', awaitShutdown → 'shutdown')` outcome the CLI path already uses (`boot.ts:276-286`), and tee its result into `bootDeferred`. This makes the single gate **structurally identical** to the existing long-running gate — one definition, `done`-tolerant, fork-safe.

> This is the single genuinely-new piece of seam logic. It is **net simplification**: runStack stops re-deriving readiness and reuses the supervisor's own gate. Regression-tested by a Docker-free `done`-node stack (Step 1 test) so the equivalence is *proven*.

### 3.3 How each surface consumes the handle

- **Programmatic:** `runStack(stack, opts)` → `await handle.start` → read `handle.state`/`handle.events` → `handle.stop` → `handle.awaitShutdown`. Unchanged contract.
- **CLI `up`:** builds CLI hooks closing over its own warm Refs; `const handle = runStackWithBoot(stack, { identity, appRoot, runtimeRoot, codegen, commandHandler, boot })`; then, inside `Effect.scoped`, `yield* handle.start` (mapping `BootError` → `CliError`), then `yield* handle.awaitShutdown` (outer fiber blocks here so SIGINT reaches the supervisor's in-scope signal handler), projecting the cause to `CliError` via `findCliSupervisorLiveError`. `forkDetach` preserved; SIGINT teardown is command-channel/latch driven and unaffected.
- **TUI:** mounted *inside* the CLI's `beforeInitialAcquire` hook (kept co-located with the supervised scope — its flush finalizer must run on scope close), reading `handle.state`, a tee of `handle.events`, and `makeQueueCommandPublisher(handle.commands)`. The TUI now references **public `RunHandle` fields** instead of the raw `SupervisorHandle` — the "TUI is a consumer" proof point.

### 3.4 Warm / restore / fork / teardown routing

- **Warm restore + interrupted-restore:** CLI-authored, injected as `boot.beforeInitialAcquire`, run inside the shared `superviseStackEffect.beforeInitialAcquire` **before** `runInitialAcquire` — PR#21 order preserved structurally (`boot.ts:265-267`).
- **Warm capture:** injected as `boot.withinScope`, runs after the readiness gate fork is scheduled (so a slow `docker commit` cannot delay `handle.start` — pinned by a Step-2 timing test).
- **Fork mode:** entirely a stack/plugin concern (the `sui` plugin); flows through the substrate Layers identically on both paths and is **untouched** by the seam.
- **Teardown:** `handle.stop` (programmatic) / SIGINT→scope-close (CLI) → `shutdown.requested` on the command channel → `shutdownLatch` → `awaitShutdown` resolves → scope finalizer tears down plugins (`start-supervisor.ts:450-460`). One path.

### 3.5 What stays CLI-only

Argv/flag parsing; config loading + `resolvedIdentityForStack`/`identityValueFor`; `resolveUpRendererMode`; `devstackVersion` read + warm fingerprint inputs; the **hook bodies themselves** (recover/warm/roster/IPC/TUI/snapshot-handler, authored in `cli/`, passed *as* hooks); `BootError`/`awaitShutdown`-cause → `CliError` projection; the outer-fiber blocking contract. **`apply.ts`/`snapshot.ts` stay direct `superviseStackEffect` consumers** (`lifetime: 'one-shot'`, ~45 LOC each, no fork/handle to dedup) — out of scope (§7-Q3).

---

## 4. Migration map

| Duplicated responsibility | Destination |
|---|---|
| Substrate+orchestrator+codegen Layer composition (`run-stack.ts:254-261` inline + `up.ts:527-532`) | **SEAM** via hoisted `buildVerbLayers` (Step 0); one composition site for long-running boots |
| Dispatcher + post-acquire hook + `extendContext` (`run-stack.ts:264-275` + `up.ts:551-563`) | **SEAM** (runStack body); deleted from `up.ts` |
| Projection-ref-before-supervise (`up.ts:535` `makeProjectionRef`) | **SEAM** (`makeProjectionRefSync`, `run-stack.ts:231`); `up.ts` reads `handle.state`. *Strictly safer* for PR#21 — ref allocated at call time, not in-scope |
| Boot-completion gate (`run-stack.ts:305-318` per-node watcher) | **DELETED**; replaced by supervisor-owned `runInitialAcquire`/`raceFirst` gate (§3.2) |
| stop bridge / forkDetach lifecycle / single-start claim / mid-run tee (`run-stack.ts:285-408`) | **SEAM** (already there); `up.ts` consumes `start`/`stop`/`awaitShutdown` |
| Error→typed (`up.ts:688-707`) | **CLI-ONLY** but shrinks: consumes discriminated channels (`start` fails ⇒ boot; `awaitShutdown` fails ⇒ mid-run), no re-discrimination |
| Snapshot/wipe/prune handler (`up.ts:97-171`) | **CLI-ONLY**, injected via `commandHandler` opt |
| recover/warm/roster/IPC/TUI hooks (`up.ts:564-678`) | **CLI-ONLY**, injected via `boot` hook bag (verbatim bodies; only `SupervisorHandle`→`RunHandle` field refs change for TUI) |
| `makeQueueCommandPublisher` (`up-lifecycle.ts:43`) | **CLI-ONLY**, now consumes `handle.commands` |
| e2e `boot-config-impl.ts` third orchestration | **TRACKED FOLLOW-UP** (backlog) + parity comment now (§8) |

---

## 5. Sequenced steps

Each step independently green via `tsc` + named unit tests. **e2e excluded** (blocked by the pre-existing sui-image-build infra failure). Order protects id-stability + the PR#21 ordering by making every behavioral seam-change *precede* the `up.ts` cutover, each pinned by a new Docker-free test.

### Step 0 — Hoist `buildVerbLayers` into `orchestrators/boot.ts`
- **Changes:** move `buildVerbLayers`/`buildDirectSnapshotLayers` from `cli/wirings/build-verb-layers.ts` into `orchestrators/boot.ts` (or sibling `orchestrators/layers.ts`); re-export from the old path for `apply.ts`/`snapshot.ts`. No behavior change. Resolves the `api/ → cli/` import-direction problem before runStack consumes it.
- **LOC:** +0 (move). **Risk:** low.
- **Validation:** `tsc`; `vitest run test/orchestrators/boot.test.ts`.

### Step 1 — Unify the readiness gate inside `runStack` (blocker fix) + add `commands`/`runCommand`/`identity` to `RunHandle`
- **Changes:** (a) Replace runStack's per-node `awaitReady` watcher (`run-stack.ts:294-320`) with the supervisor-owned readiness signal: tee `raceFirst(runInitialAcquire→'booted', awaitShutdown→'shutdown')` into `bootDeferred` (mirroring `boot.ts:276-286`). Thread `runInitialAcquire`/outcome to the seam via the existing `withinScope(handle)` callback if `handle` exposes it; otherwise add a minimal `onBooted`/readiness Deferred to `SuperviseStackOptions` resolved at `boot.ts:283`. (b) Add `commands`, `runCommand`, `identity` to `RunHandle`, handed out via a Deferred slot mirroring `eventQueueRef`. Purely additive.
- **LOC:** ≈ +12. **Risk:** medium (touches the boot gate).
- **Validation:** `tsc`; `vitest run test/api/run-stack.test.ts test/api/run-stack-mid-run-defect.test.ts`. **NEW gate-equivalence test:** Docker-free stack with one `ready` leaf + one **`done` run-to-completion** plugin — assert `handle.start` **resolves** (today's watcher would hang). Plus a `done`+failing variant asserting `start` fails `BootError`.

### Step 2 — Add internal `boot` injection bag + `commandHandler` to a non-exported `runStackWithBoot`
- **Changes:** Define `runStackWithBoot(stack, optsWithBoot)` in a **non-exported** `src/api/run-stack-internal.ts`; `runStack` becomes the thin public facade delegating with `boot: undefined`. Bag: `{ commandHandler?, beforeInitialAcquire?, withinScope? }`. Compose built-in hooks then caller hooks as one named ordered `Effect.gen` (stop-bridge/handoff FIRST; readiness fork before caller `withinScope`). Fold **all** hook failures into `BootError.cause` so `start` stays `Effect<void, BootError>`. No call site uses the bag yet ⇒ byte-identical behavior.
- **LOC:** +45. **Risk:** medium.
- **Validation:** `tsc` (type-level: zero-`boot` `runStack` infers `start: Effect<void, BootError>`); `vitest run test/api/run-stack*.test.ts`. **NEW hook-order test:** inject recording hooks; assert via timestamp Refs *built-in handoff+stop-bridge → caller beforeInitialAcquire → first acquire* (recover-before-acquire) and *readiness-fork before caller withinScope*. **NEW roster→exit-40 test:** inject a hook failing with `CliSupervisorLiveError`; assert `handle.start` fails `BootError` and `findCliSupervisorLiveError(cause)` extracts it.

### Step 3 — Cut `up.ts` over to `runStackWithBoot`; delete the parallel orchestration
- **Changes:** Replace `up.ts`'s `program`/`superviseStackEffect`/`matchCauseEffect` (`up.ts:534-707`) with: keep config-load + `effectiveIdentity` + warm-input resolution + `rendererMode`; create warm Refs; build the three CLI hooks (`beforeInitialAcquire` = recover→warm-restore→IPC→roster→TUI-mount→event-tee, *verbatim*, only `handle.*` refs change from raw `SupervisorHandle` to `RunHandle`; `withinScope` = warm-capture; `commandHandler` = `makeSnapshotCommandHandler`); `const handle = runStackWithBoot(...)`; inside `Effect.scoped`, `yield* handle.start` then `yield* handle.awaitShutdown`, projecting to `CliError`. Delete inline layer composition, `makeProjectionRef`, dispatcher/hook build, `matchCauseEffect`. Keep renderer mount + flush finalizer **inside** the `beforeInitialAcquire` hook (co-located with supervised scope — preserves flush-on-scope-close; avoids the outer-vs-inner scope split flagged as riskiest).
- **LOC:** **−150**. **Risk:** high.
- **Validation:** `tsc`; `vitest run test/cli/main.test.ts` (`up --help` still green — NOT a boot gate). Real gates = Step-1/2 seam tests (now cover the merged path). **NEW CLI boot smoke (Docker-free):** drive `runStackWithBoot` with the **actual CLI hook bundle** against a leaf stack; assert (a) `recoverInterruptedRestore` before any acquire, (b) a pre-claimed roster lock yields `CliSupervisorLiveError` → projected `exit 40`, (c) the renderer receives the boot identity projection from `handle.state`. **Structural grep:** `superviseStackEffect` has exactly ONE long-running call site + two one-shot; `up.ts` no longer imports `buildProductionContributionDispatcher`/`buildProductionPostAcquireHook`/`superviseStackEffect`/`makeProjectionRef`.

### Step 4 — Delete dead plumbing + minimality sweep
- **Changes:** Remove unused `up.ts` imports; point `makeQueueCommandPublisher` at `handle.commands`; confirm `apply.ts`/`snapshot.ts` still consume `buildVerbLayers` via the re-export; tidy `run-stack.ts` header comments. Run the delete-or-relocate minimality check.
- **LOC:** −20. **Risk:** low.
- **Validation:** `tsc`; full devstack unit sweep (excluding e2e-tagged); regression triad `run-stack*.test.ts` + `boot.test.ts` + the three new seam tests.

### Step 5 — Route `apply`/`snapshot` through the shared boot-core (OWNER-ADDED, Q3 = include)
- **Changes:** Extract the assembly the seam now owns (substrate+orchestrator+codegen layers via hoisted `buildVerbLayers` + `buildProductionContributionDispatcher` + `buildProductionPostAcquireHook` + `extendBuiltInPluginContext` + the single `superviseStackEffect` invocation) into a shared internal boot-core parameterized by `lifetime`. `runStackWithBoot` calls it with `lifetime: 'long-running'` (wraps the forkDetach handle); `apply.ts`/`snapshot.ts` call it with `lifetime: 'one-shot'` (run-to-completion, no handle/forkDetach, existing teardown semantics). Goal: ONE assembly + ideally ONE `superviseStackEffect` call site across all four verbs. Do NOT bloat the public `RunHandle` — one-shot returns its existing result type, not a handle.
- **Files:** `src/api/run-stack-internal.ts` (or a sibling boot-core module), `src/cli/wirings/apply.ts`, `src/cli/wirings/snapshot.ts`.
- **LOC:** ≈ −40 (dedup the assembly duplicated in apply.ts + snapshot.ts).  **Risk:** medium (one-shot teardown semantics differ from long-running — must preserve exactly; one-shot has no awaitShutdown-blocking).
- **Validation:** `tsc`; `vitest run test/cli/apply*.test.ts test/cli/snapshot*.test.ts test/orchestrators/snapshot/*.test.ts` (one-shot boot + teardown + identity-guard ordering unchanged); structural grep that `superviseStackEffect` has the minimum call sites (one core, called with two lifetimes) and the assembly helpers are imported from ONE place.

**Net across steps: −150 −20 +12 +45 −40 ≈ −153 source, +~36 test ⇒ honest ≈ −115** (apply/snapshot inclusion adds ~−20 net beyond the −95 baseline).

---

## 6. Invariant guards

| Invariant | How preserved | How proven WITHOUT e2e |
|---|---|---|
| **ID-stability** | Identity resolved once at call time (`run-stack.ts:213`); codegen resolved once via the shared `resolveProductionCodegenOptions` (now the only site). No restart churn; warm/restore hooks unchanged. | `run-stack.test.ts` "infers app and stack" (`:142`) + "rejects bogus network" (`:504`); grep: exactly one `resolveProductionCodegenOptions` per boot path. |
| **PR#21 boot ordering** | Ordering lives inside `superviseStackEffect` (`boot.ts:265-287`), unchanged. Seam composes built-in (stop-bridge FIRST) then caller hooks as an explicit named ordered `Effect.gen`. CLI hook keeps `recover→warm→roster` in one copied gen. | **NEW Step-2 hook-order test** (recording hooks + timestamps). This gate **does not exist today** — `main.test.ts` never boots `up`. |
| **Projection-ref process-lifetime** | `handle.state` is the single `makeProjectionRefSync` ref allocated at call time, outside the supervised scope. CLI moves *onto* this ref (from in-scope `makeProjectionRef`) — strictly safer. | `run-stack.test.ts` "state available synchronously before start" (`:232`); **NEW restart-cycle test:** stop→start cycle on a leaf stack, assert same ref persists + `cycle.id` increments + subscription survives. |
| **Warm / restore / interrupted-restore** | Routed as injected hooks **through the shared `superviseStackEffect.beforeInitialAcquire`** so ordering cannot fragment. Warm-capture sequenced after readiness fork. | Step-2 hook-order test; existing `orchestrators/warm/*` unchanged. Full round-trip only by e2e (blocked) — residual risk (§7-Q5). |
| **Fork-mode handoff** | Fork is a `sui`-plugin/substrate-layer concern, flows through shared Layer composition; seam never touches it. | grep: no fork branch in changed files; substrate layer composition byte-identical (Step-0 `boot.test.ts`). |
| **TUI UX parity** | TUI mount + flush finalizer stay **inside** the CLI `beforeInitialAcquire` hook (co-located, as today). Only the data source changes to `handle.*` fields. | `tsc`; Step-3 CLI-smoke test asserts renderer receives boot identity; `resolveUpRendererMode` tests unchanged. |
| **`runStack` public contract** | Public `runStack` signature kept; `boot` bag + substrate types live in non-exported `runStackWithBoot`. 5 existing `RunHandle` fields verbatim; 3 additions are api-level types (no substrate leak). `start` stays `Effect<void, BootError>`. | Type-level assert (Step 2); full `run-stack*.test.ts` green. |

---

## 7. Risks & open questions for the owner

**Q1 — Public `runStack` facade vs internal `runStackWithBoot`?** The `boot` bag exposes substrate types. **Recommendation:** keep `runStack` the clean public facade; the CLI imports a deep non-exported `runStackWithBoot`. The "one seam" claim holds — one *implementation*, public facade. (Adopted.)

**Q2 — Readiness-gate unification (§3.2) in scope?** It's a **blocker** (the CLI would hang on `done` nodes through runStack's current watcher), so it must land *with* this step, gated by the `done`-node equivalence test. It changes the *mechanism*, not the observable contract. **Recommendation:** include as Step 1.

**Q3 — Invert `apply`/`snapshot` too, or defer?** One-shot, ~45 LOC each, no fork/handle/Deferred to dedup. **Recommendation:** defer — `RunHandle` is a long-running abstraction; folding one-shot in would re-bloat it.

**Q4 — Programmatic warm?** Today warm is CLI-only (injected hooks). **Recommendation:** keep warm CLI-injected for now; the hook bag is the right shim if you later want embedded warm-boot.

**Q5 — Residual: warm/roster/IPC have no non-e2e coverage and e2e is blocked.** Steps 1–3 add Docker-free gates for *ordering, readiness, roster-exit-40, projection delivery*, but the **full warm round-trip** and **cross-process IPC ack correlation** are only exercised by e2e. **Recommendation:** accept the residual (hooks moved *verbatim*, only handle-field refs change), and prioritize unblocking the sui-image-build e2e separately. A Docker-free fake-IPC harness before the cutover adds ~1 step if you want to close it.

**Q6 — `e2e/boot-config-impl.ts` is a third parallel orchestration.** Re-implements `supervise()` + manual `awaitReady` + manual warm ordering; omits `recoverInterruptedRestore`/roster/IPC. **Recommendation:** track routing it through the seam as a follow-up; add a parity comment now so it stops silently diverging.

---

## 8. Honest accounting

**Genuine dedup/removal (≈ −150 source):** `up.ts`'s entire parallel `program` (`:534-707`) — the second `superviseStackEffect` call, duplicated dispatcher/post-acquire-hook/`extendContext`, in-scope `makeProjectionRef`, duplicated `provide(substrateLayers)`, and `matchCauseEffect` re-discrimination. The real cost the owner flagged. Plus runStack's bespoke per-node readiness watcher (`:294-320`), replaced by reusing the supervisor's gate — a delete *and* a correctness fix.

**Relocation, not removal (net ~0):** `buildVerbLayers` hoist (Step 0); the CLI hook bodies (recover/warm/roster/IPC/TUI/snapshot-handler) — relocated from `up.ts`'s inline call into injected hooks. Same code, new caller. The dedup is the *wrapper*, not the hooks.

**Additive (≈ +45 source + ~36 test):** the `boot` injection bag + composition + 3 `RunHandle` fields; three new regression tests (gate-equivalence, hook-order, roster-exit-40) + CLI-smoke + restart-cycle. **Not optional:** the cited `main.test.ts` only runs `up --help` and `boot.test.ts` drives `supervise()` directly — neither boots the `up` wiring, so without these the highest-risk step would tsc-pass while a reordered hook, a hung `done`-node gate, or a lost exit-40 slipped through.

**What the architects over/under-estimated:** over-estimated LOC reduction (−105/−122 omitting test additions; honest ≈ −95); under-estimated the readiness-gate divergence (would hang `up` on `done` nodes); over-estimated the `start`/`run` split need (SIGINT handler is in-scope, `forkDetach`+`await awaitShutdown` preserves teardown); under-estimated the validation gap (every architect cited `main.test.ts:483-491` as an ordering gate — that range is a `finally` cleanup block and `up` is never booted there).
