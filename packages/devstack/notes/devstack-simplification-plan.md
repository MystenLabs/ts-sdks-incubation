# Devstack Simplification Plan

Single source of truth for the devstack simplification effort. Self-contained: a new session should be able to drive the whole arc from this doc. Supersedes the earlier split docs (`system-simplification-roadmap.md`, `plugin-api-migration.md`, `stage-a-deprivilege-sui.md`).

**Status / fidelity:** Stage A and Stage B are specified at execution fidelity (file-level, gated). Stages C–E are specified at design fidelity (the moves, the decisions, the ground truth) and should be detailed into file-level steps when reached. All file:line citations were grep/Read-verified June 2026 on branch `mh/snapshot-restore-matrix-e2e` (now merged) — **re-grep at edit time; some will have drifted.**

---

# Part I — Orientation

## 0. Thesis: too many systems, not too much depth

Every past devstack refactor nets ~5% because the complexity is **multiplicity** — roughly 2× the systems the job needs — so any one change deletes only part of one duplicated fork. The goal of this plan is to reduce the **count of systems**, not the line count, so the codebase fits in one head and the *next* change has one place to land.

The measured multiplicity (the spine of the whole plan):

| The job needs | Exists today | Target |
|---|---|---|
| 1 store + 1 frozen replica | 4 "stores": cache (real), artifact-publisher (storage-less wrapper), **state-store (DEAD)**, snapshot | cache + snapshot |
| 1 live read-model | projection + projection-snapshot (same field-set serialized twice) | projection (with persisted tail) |
| 1 endpoint source | 1 route fanned into 3 registries (router / manifest / projection) | 1 source → 3 sinks via 1 adapter |
| 1 projection→view derivation | 4 renderers (TUI / dashboard / status / plain) re-deriving the same summary | 1 shared ViewModel |
| 1 scoped-map primitive | 2 (multimap + ref-map; LWW = "highest seq" over multimap) | 1 `defineScopedRegistry` |
| 1 tar reader | 3 hand-rolled tar parsers in snapshot | 1 |
| 1 cross-process lock | 3 lock primitives | 1 |
| 1 Move-build path | 2 (`substrate/sui-move-build` + `plugins/sui/move-summary-runner`) | 1 |
| a name-blind kernel | 3 Sui-domain folders **inside** substrate | 0 (in `plugins/sui/`) |
| 1 contribution path | CapabilitySinks kind-dispatch registry + the `capabilities` 2nd-closure on every plugin | inline typed `ctx.*` verbs |

## 1. Validated direction (4 independent adversarial reviews → endorse-with-changes)

**The prize (keep in full):** delete the plugin `capabilities: ({value,runtime}) => [...decls]` second-closure and the `CapabilitySinksService` kind-dispatch registry; plugins emit contributions **inline in `start`** via typed `ctx.*` verbs. This is ~all the readability/size win and it *improves* type-safety (kills the `SinkAccept = (decl: unknown)` erasure seam for built-ins).

**Two trims to the original proposal, both validated:**
1. **Minimal `ctx`, not a god-object.** Mirroring the 11 infra services onto `ctx` deletes no logic, costs `Layer` test isolation, and is less idiomatic. **Infra stays `yield* Service`.** Only `ctx.persist` is promoted (it changes behavior — folds the chain into the cache key). `ctx` carries: the buffered declarative verbs + `ctx.persist` + the strategy bus + `ctx.fail`.
2. **`ctx.tx` is dropped entirely.** A `TransactionBuilder` is `@mysten/sui/transactions`; a framework `ctx.tx` would source an SDK/signer ambiently (none exists) and create a hidden Sui dependency bypassing `dependsOn`/`MissingProviders`, putting a Sui transactor on every plugin's `ctx` (even postgres). Signed-tx stays a `deps.sui` value-level op (the `action` `signAndExecute(account, build)` pattern).

**Sui is just a plugin** (owner principle). The substrate knows only generic dimensions (opaque `ChainId`, content-addressed cache, containers, `local|live|fork` mode) and never names "Sui." Sui-domain mechanics live in `plugins/sui/`; siblings consume via `deps.sui` or by importing the `plugins/sui/` bus. Sui gets **no special tier** — a `src/sui-domain/` layer would re-privilege it.

## 2. Two owner decisions (resolved — they gate Stages D & E)

1. **Snapshots are wipe-scoped.** `devstack wipe` clears state *and* snapshots together; a snapshot never needs to survive a cache-wipe. → restore becomes **"roll the chain back + restart containers + reuse the live cache"** (ids are content-addressed and still present). This deletes the deploy-cache double-store — the churn engine (the merged branch's last commits fought it). (Stage D)
2. **The dashboard stays and is a priority** (local-dev explorer; TUI logs are hard to use; snapshotting needs a real UI). → control-plane + observability rings are load-bearing; the win is making the dashboard *robust + non-duplicative*, not cutting it. (Stage E)

## 3. Target architecture

**Can the substrate run plugins directly? — Yes, after Stage B.** Today the orchestrator↔substrate boundary is mediated by exactly one runtime mechanism: the CapabilitySinks harvest. Delete it and the supervisor reverts to its irreducible job (resolve graph → scopes → acquire → ready-gate → teardown → command-loop) and the 3 L3 composition files (926 LOC) collapse into one boot module.

```
substrate/        generic kernel: ChainId (opaque), cache (namespace,chain,contentHash),
                  ContainerRuntime, ports, identity {app,stack,chain}, local|live|fork mode.
                  No @mysten/sui import. Names no plugin.
orchestrators/    L3: layer assembly + post-acquire (manifest/codegen) hook + coin/package registries.
                  The static dispatch the inline ctx verbs hit. Name-aware (allowed at L3).
plugins/<name>/   each owns its domain (sui owns Sui mechanics; walrus its cluster; deepbook its DEX).
                  A plugin = definePlugin({ id, dependsOn?, role, section, start, errorContributions? }).
                  start(deps, ctx): yield* infra services; call ctx.* verbs to contribute.
```

## 4. The arc

| Stage | Move | Payoff | Risk | Precondition |
|---|---|---|---|---|
| **A** | delete dead state-store; hoist Sui out of substrate | name-blindness becomes TRUE; ~600 deleted | low | none |
| **B** | plugin inversion (keystone) | substrate runs plugins directly; ~5,900 deleted | med | `ctx.persist` proven first |
| **C** | fold artifact-publisher→cache.publish; unify scoped-maps; merge 3 composition files | fewer Service tags/primitives | low-med | B |
| **D** | restore = rebuild from cache + chain rollback; drop crash-recovery + redundant tar parsers | ~2,800 deleted; kills the churn engine | med | decision 1 ✓ (independent of B) |
| **E** | one shared ViewModel; robust dashboard; fold endpoint fan-out; collapse 3 locks | surfaces can't drift | low | decision 2 ✓ |

Net across all stages: **>10k LOC removed and ~8 fewer distinct systems**, type-safety preserved-to-improved, substrate name-blind for the first time. The point is the system-count drop: afterward "where does state live / how does a plugin contribute / how does a surface render / how is an endpoint exposed" each have **one** answer.

## 5. Traps — inherent complexity, do NOT collapse

- **Snapshot freeze core** (pause-window, fail-closed identity guard, atomic stage-and-swap, ~1.2–1.5k) — genuinely hard, e2e-proven. Only the gold-plating goes (Stage D).
- **Cross-process command-channel protocol** — a real feature (`apply`/`snapshot`/`prune` reach a running `up` from a second shell), guarding documented parallel-stack collision bugs. Collapse the 3 *locks* only.
- **Traefik router** — can't be an in-process proxy (upstreams are container IPs on a docker network); `docker-provider` was evaluated and rejected.
- **The two CLI dirs** (`cli/` wiring vs `surfaces/cli/` presentation) — doc-sanctioned, load-bearing for SIGINT→finalizers. Not duplication.
- **`runtime/docker/`→substrate boundary** — already correctly oriented; folding in creates a cycle. (The one-line re-export shim can go; the boundary stays.)

## 6. Cross-cutting gates (run every stage)

- **BC-CONFIG surface** (the only external contract): `release-surface` + `exports-parity` + `verb-list-parity` + flags + `envelope-contract` green; examples `tsc -b --noEmit` + dev-wallet + create-devstack-app build. The composer reads only `member.id` / `pluginDependencyRefs` / `isPlugin` off the `ResourceRef` brand — never `start`/`capabilities`/`Value`.
- **Runtime correctness:** `private-content-boot` (warm-restart id-stability) + `snapshot-restore-matrix` (`useRealRouter:true`) + `deepbook-boot` + `token-studio-boot` + parallel-stack arbitration.
- **Type-safety (Stage B):** `public-refs.test-d` + `public-ergonomics.test-d` + `release-surface` pin the inferred factory return types — gate B's every phase on them.
- **Name-blindness:** `name-blindness.test.ts` green, and *strengthened* after Stage A (3 fewer allowlist entries).

---

# Part II — The stages (execution order)

## STAGE A — De-privilege Sui + delete the dead state-store  *(no preconditions)*

The substrate is already mostly chain-agnostic: `ChainId` is an opaque brand sourced from `DevstackOptions.network`/`DEVSTACK_NETWORK` (`api/run-stack.ts:163-171`), not from the Sui plugin; the composer does not auto-mount Sui. The real Sui debt is three localized things.

### A1 · Delete the dead `state-store` (~450 LOC + snapshot phantom)
`StateStoreService`/`layerStateStore` are wired into zero contexts (only self-references); nothing calls `set/get/delete/listUnder`. It survives as a snapshot phantom (a `state.json` nothing writes). `StateStoreLockedError` doesn't exist.

- **Delete files:** `src/substrate/runtime/state-store/` (service 300 + schema 46 + index 4); `src/substrate/state-store.ts` (54, already private); `src/orchestrators/snapshot/state-document.ts` (77); `test/substrate/runtime/state-store/service.test.ts`; the `StateStoreError` class in `src/substrate/runtime/errors.ts:23`.
- **Excise snapshot phantom** (re-grep): `capture.ts` import `:61`, phases `read-state`/`write-state` `:80-81`, `saving-state` `:124`, copy-state block `:713-732`, `stateFilePath` `:464`; `restore.ts` import `:65-68`, phases `read-state`/`expand-state` `:108,:117`, `failStateDocument` `:145-162`, state blocks `:560-569` and `:934-956`; `wipe.ts` phase `remove-state` `:29` + `stateFile` plumbing `:46,:103,:160,:208-211`; `service.ts` `stateFilePath` args `:462,:571,:589`; `descriptor.ts` `SnapshotLayout.stateFile` `:43`; `snapshot/index.ts` re-export `:127-131`; `surfaces/cli/commands/wipe.ts:55`.
- **`paths.ts`:** delete `paths.stateFile` (`:70,:143`). **KEEP `paths.stateLockHint`** (`:71,:144`) — it's the cross-process lock advisory path (5 live tests depend on it), unrelated despite the name.
- **Docs:** scrub ~10 plugin doc-comments referencing "state-store keys" (`sui/mode/shared-boot.ts:53`, `sui/mode/shared.ts:94`, `seal/snapshot.ts:8`, `seal/keygen.ts:46`, `seal/mode/live.ts:7,11`, `coin/snapshot.ts:6,7`, `coin/mint.ts:16,17`, `wallet/pairing.ts:68`, `walrus/snapshot.ts:7`, `package/snapshot.ts:9,10`) + substrate mentions (`errors.ts:4`, `atomic-write.ts:4,21,34`, `cross-process/lock.ts:8,12,36`, `cross-process/roster.ts:79`, `manifest/manifest.ts:203`, `primitives/cache.ts:5`); remove `ARCHITECTURE.md` state-store roster line (L0 roster + one-page summary) **in the same PR**.
- **No back-compat concern:** `SNAPSHOT_META_VERSION` has no state field; existing snapshots with a stray `state.json` are forward-compatible.
- **Tests to update:** `snapshot/{capture,restore,wipe,cleanup}.test.ts`, `snapshot-container-image-roundtrip.test.ts:162`.
- **Gate:** unit + snapshot tests + `snapshot-restore-matrix` + `release-surface` green. **Rollback:** revert; pure dead-code.

### A2 · Hoist the three `sui-*` folders into `plugins/sui/`
All three are purely Sui-domain on top of generic substrate primitives; none are in the public barrel; consumers import deep paths directly (~24 files to re-point). The move fixes two real violations: `sui-execute/index.ts:40` imports `@mysten/sui/client` despite an opacity header; `sui-ledger/object-ref.ts:24` imports *up* into `plugins/sui` (the only substrate→plugin import in `src/`).

- **`sui-execute` → `plugins/sui/exec/`** (570 LOC, `index.ts` + `sign-and-dispatch.ts`). Consumers (10 src + 6 test): `sui/mode/fork.ts`, `seal/deploy.ts`, `action/execute.ts`, `coin/mint.ts`, `walrus/wal-swap.ts`, `account/service.ts`, `package/publish-executor.ts`, `deepbook/{faucet-strategy,deploy,pyth/index}.ts` + tests.
- **`sui-move-build` + `move-summary-runner` → `plugins/sui/move/` (MERGED).** Extract one shared core — `stageDisposablePackage()` (mkdtemp + disposable cp + `copyLocalMoveDeps`), `ensureMoveHome()`, `runMoveCliOneShot({image, argv, extraMounts, mapError})` — and make `runMoveBuild`/`runMoveSummary` thin callers (collapses ~150 LOC of duplicated scaffolding). `package/build.ts` is **not a pure shim** — it's package's `MoveBuildError→PublishError` adapter; keep it, just update its import (or inline `toPublishError` at 2 call sites). Consumers (6 src + 1 test): `sui/chain-build-container.ts`, `sui/move-summary-runner.ts` (absorbed), `sui/mode/{local,fork}.ts`, `seal/deploy.ts`, `package/build.ts`. **Barrel gate:** verify via `release-surface.test.ts` whether any Move symbol leaks publicly via `package`; preserve the re-export if so.
- **`sui-ledger` → pull DOWN into `deepbook`** (87 LOC, single consumer `deepbook/deploy.ts`). deepbook already `dependsOn` sui, so `SuiSdkShim` becomes a legal plugin→plugin import. (Promote to `plugins/sui/` only if a 2nd seeder appears — "future seeders" was runway.)
- **Gate:** unit + `private-content-boot` + `snapshot-restore-matrix` + `deepbook-boot` + `token-studio-boot` green; `name-blindness` green with the **3 sui-\* allowlist entries removed**; `release-surface` green. **Rollback:** per-module (3 independent commits).

### A3 · Move Sui network vocabulary out of `api/inference-network.ts`
It hardcodes Sui network names (`localnet/testnet/mainnet/devnet`), `sui:` aliases, and `DEFAULT='sui:local'` in the neutral api layer. Move the name table + aliases + default into a `plugins/sui/chain-resolver.ts` the Sui plugin contributes; the api/substrate layer keeps only opaque `ChainId` + the generic `local|live|fork` mode (`substrate/network.ts` — already module-augmentable, stays). **Open choice:** the Sui plugin registers as the default chain resolver (purest) vs. keep the default an explicit L4 convenience (lower-touch) — recommend the former. **Gate:** network-inference tests + create-devstack-app build green.

### A4 · (Optional, flagged) Rename the generic chain field `network` → `chain`
The chain dimension is surfaced as `network` (a Sui-ism) in projection/observability (`projection.ts:26`, `state-ref.ts:40`, `persisted.ts:131`, `spans.ts`, `control-plane/service.ts:48`, `mode-errors.ts:54`, the `network: identity.chain` assignments). Rename to `chain`. **Caveat:** touches the persisted `projection.v4.json` field — low-risk (regenerated each boot, not a cross-version contract) but note the schema. Lower urgency; its own commit or defer.

### Adjacent (defer with pointers — do NOT entangle into A)
- `selective-restart.ts:141-143` hardcodes `dashboard`/`host-service/` ids → a plugin-declared `restorable:false` flag. **Fold into Stage B** (plugin-contract reshape).
- `snapshot/descriptor.ts DEPLOY_CACHE_NAMESPACES` hardcodes plugin namespaces → plugins declare them. **Fold into Stage D.**

---

## STAGE B — Plugin API inversion (minimal ctx)  *(keystone; precondition for C)*

### B.0 The after-state plugin shape
```ts
definePlugin({
  id, dependsOn?, role, section,
  start: (deps, ctx) => Effect<Value>,   // ctx is a NEW additive 2nd arg
  errorContributions?, watch?, expand?,
});
```
The `capabilities` second-closure is gone; its emissions move inline into `start` via `ctx.*`. A plugin still compiles to `ResourceRef<Id,Value>` with the two brands, so composer/scheduler/`MissingProviders` are unchanged. Inside `start`: reach infra with `yield* Service` (unchanged); contribute with `ctx` verbs.

### B.1 The minimal `ctx` surface (typed)
```ts
interface PluginCtx<Value = unknown> {
  // the ONE infra promotion — folds chain from identity.chain → byte-identical cache key,
  // wrong-chain bug unrepresentable. Facade over ArtifactPublisher.publish.
  persist: <P,V>(spec: { namespace: string; contentHash: ContentHash;
    verify: (cached: P) => Effect<V|null, never>;
    produce: Effect<P, ArtifactPublishError, Scope>;
    register?: (a: P) => Effect<void, never>; }) => Effect<P, ArtifactPublishError, Scope>;
  // buffered declarative verbs (backing services live at L3, absent from plugin context →
  // buffer in start, replay at supervisor frame). Each carries its decl shape, NOT unknown.
  codegen:       (decl: Omit<CodegenableDecl<string>, 'kind'>) => Effect<void, never, Scope>;
  endpoint:      (decl: Omit<RoutableDecl, 'kind'>)            => Effect<EndpointUrl, never, Scope>;
  snapshotExtra: (decl: Omit<SnapshotableDecl, 'kind'>)       => Effect<void, never, Scope>;
  publish:       (decl: Omit<ProjectionDecl, 'kind'>)         => Effect<void, never, Scope>;
  // strategy bus ONLY (probes/faucets/no-graph-edge siblings), keyed on augmentable registry
  provides: <K extends StrategyKey>(key: K, value: Reg[K]['value'], discriminator?: Reg[K]['key'], opts?) => Effect<void, never, Scope>;
  requires: <K extends StrategyKey>(key: K, discriminator?: Reg[K]['key']) => Effect<Reg[K]['value'], StrategyNotFoundError>;
  fail: (message: string, cause?: unknown) => Effect<never, PluginRuntimeError>;
}
```
**NOT on ctx** (stay `yield* Service`): ContainerRuntime, PortBroker, Cache, Identity, StackPaths, httpServer, sharedMap, LeaseBroker, PostAcquireTasks, Logger, Package/Coin registries. **Not on ctx:** any Sui-domain op (→ `deps.sui`).

### B.2 The type-safety contract (named invariants — each is a gate)
- **INV-1 `Value = StartValue<Start>`** — inferred from `start`'s Effect success channel, as today; the deleted `capabilities` callback was the only other source. No `publish?` hook as Value source. `StartValue` matches `(...args:any[])` so the new `ctx` arg is absorbed.
- **INV-2 `deps` stays nominal** — typed off `dependsOn` via `ResourceValueOf<R> = R extends ResourceRef<string, infer V> ? V : never` over the ref phantom; the inversion touches none of `ResourceRef`/brands/overloads.
- **INV-3 `definePlugin`'s overloads ARE the public contract** — no factory has an explicit return annotation; types infer through `definePlugin`. The only signature changes: drop internal `<Caps>`; append `ctx: PluginCtx`. Both inference-neutral for `Id`/`Value`/`Needs`. Gate every phase on `public-refs.test-d` + `public-ergonomics.test-d` + `release-surface`.
- **INV-4 each verb carries its decl shape, never `unknown`** — the 5 payload SHAPE types (`CodegenableDecl`/`RoutableDecl`/`SnapshotableDecl`/`ProjectionDecl`/`StrategyContributorDecl`) survive as ctx-arg types; only the `CapabilityDecl` wrapper + `DevstackCapabilityRegistry` + `CapabilityPayloadFor`/`ExactCapabilityPayload` + the stamping helpers die. (Net type-safety *improves* — the `unknown` dispatch seam disappears for built-ins.)
- **GUARD-A** clamp each plugin's published `Value` to its narrow `resource<Id,Value>()` ref, not `start`'s widest return (the real `SuiResolved` vs `SuiResolvedRuntime` split, `sui/index.ts:87` vs `:187`).
- **GUARD-B** `DevstackStrategyRegistry` is size-bounded as a HARD rule — it's structurally identical to the deleted `DevstackCapabilityRegistry`; if it grows past probes/faucets it re-grows CapabilitySinks under a new name. A plugin's primary resolved Value must NEVER be reached via `ctx.requires` (bypasses `dependsOn`/`MissingProviders`, erases the nominal type).

### B.3 Before/after (the pattern)
`start` keeps its `yield* ContainerRuntimeService` / `yield* IdentityContext` etc.; the `capabilities` closure collapses into inline `ctx.snapshotExtra`/`ctx.codegen`/`ctx.endpoint`/`ctx.publish`/`ctx.provides` stamped from values already in hand; `yield* ArtifactPublisherService` + `publisher.publish({chain,...})` becomes `ctx.persist({...})` (chain folded from `identity.chain` → byte-identical key, ids don't churn). Sui-domain ops go through `deps.sui` (the `action` `signAndExecute(account, build)` pattern). Net per plugin: ~−15 to −22 lines of conformance shell; the body reads top-to-bottom.

### B.4 Phases (each commit green; the buffer/replay keeps P2 green so P3 is the only irreversible step)
- **P0 — `ctx.persist` + parity gate.** Stand up `PluginCtx` + the `ctx.persist` facade over the live `CacheService`/`ArtifactPublisher` (NOT the dead state-store); thread `ctx` as `start`'s additive 2nd arg (unconverted plugins ignore it). **Gate:** new `persist-id-parity.test.ts` — `publisher.publish` ≡ `ctx.persist` deep-equal + `===` id + same cache file (incl. ctx-injected `identity.chain`) + no re-`produce` on warm hit; `private-content-boot` + `snapshot-restore-matrix` green (ctx inert). **This is the keystone — prove it before any plugin converts.**
- **P0.5 — buffer/replay (a reshape of the existing post-start dispatch frame).** The supervisor already runs `start` → `resolveCapabilities` (post-start) → `dispatchContributions` (against the plugin scope). Swap the post-start `capabilities` callback for draining a ctx-owned `Ref<Decl[]>` at the same frame through the same dispatch. `ctx.endpoint` also flips a `calledEndpoint` Ref (scaffolds `routablesPresent` for P3). **Gate:** `ctx-buffer-replay.test.ts` — `ctx.endpoint` author ≡ `capabilities:[routable]` dispatch output.
- **P1 — the rest of the minimal verbs** over their L3 services (via replay) + `ctx.provides/requires` over StrategyRegistry + `ctx.fail`. `ctx.provides` finalizer lands on the plugin scope automatically (StrategyRegistry.register's `Scope.Scope` R-channel forces the drop-by-seq finalizer in `scoped-multimap` — **NOT** the event finalizer in `runtime-composition`). **Gate:** `plan-drain-excluding.test.ts` proves a `ctx.provides` strategy is reaped on selective-restart.
- **P2 — convert plugins** (id-stability-safe order). Fold each `capabilities` body into `start` as inline verbs; `yield* ArtifactPublisherService` → `ctx.persist` (same namespace/contentHash/verify/produce); infra `yield*` stays. Factory signatures + `Plugin` return types unchanged. Low-risk first (fan out 4–5): postgres, host-service, dashboard, faucet, coin, action, account, wallet, deepbook. `package` serial (shared files; delete orphan `declarePackage`). **Id-stability-critical, strictly serial, each e2e-gated `sui → walrus → seal`** (verified `dependsOn` chain) — re-run `private-content-boot` + `snapshot-restore-matrix` at each before the next. Fold the `selective-restart` `restorable:false` flag in here (Stage A adjacent item). **Gate per id-stability plugin:** cold→warm chainId/vault/seal/walrus ids identical.
- **P3 — flip the harvest (the one un-bisectable commit).** Point the replay drain at a static dispatch (lifted accept-bodies in `orchestrators/`, never an L1 switch — name-blindness stays); flip `acquireNode` to stop calling `resolveCapabilities`/`dispatchContributions`; replace `caps.some(kind==='routable')` with `calledEndpoint` read post-`start`. Remove `orchestratorSinks` plumbing same-commit. The FormatterRegistry feed (errorContributions) MOVES into the acquire path (not deleted). **Gate:** `operationalEndpointEventsFromResolvedValue` unit (no double/zero-emit); `ctx-primitives-boot.test.ts`; ALL boot e2es. Keep un-merged until green.
- **P4 — delete machinery.** `dispatch-contributions.ts`, `capability-sinks/` (FormatterRegistry stays — relocate its layer), `contracts/capability-decl.ts`, `api/define-capabilities.ts`, the `<Caps>` param, the barrel capability vocabulary. **Keep** `errorContributions` + `pluginErrorContributions` + `PluginErrorContribution` (pinned public) and the 5 payload shape types. Ship the **test-only ctx harness** (a decl-capturing fake) + migrate the ~3 plugin tests that drive `start()` and inspect `capabilities` as a pure function (`deepbook/factory.test.ts`).
- **P5 — cleanup.** Sweep orphaned decl-builders; add a **name-blindness regression grep** (`@mysten/sui/transactions`, `TransactionBuilder`, plugin-id strings under `src/substrate/**`).

### B.5 Eliminated vs kept
Removed: `dispatch-contributions` (242) + `capability-sinks/` dir (328) + `capability-decl.ts` (56) + `define-capabilities.ts` (97) + `orchestratorSinks` plumbing (~300) + per-plugin `capabilities` closures (~400 + ~5,044 conformance across plugins) + the `<Caps>` param + barrel vocab + projection event-sourcing ceremony (~600). **Kept:** `Plugin extends ResourceRef`, the brands, `errorContributions`/`pluginErrorContributions`/`PluginErrorContribution`, FormatterRegistry, the projection reducer + persisted schemas + plain-renderer, the 5 payload shapes, `endpointEventFromRoutable`/`manifestEndpointEntryFromRoutable`, `errors.ts`/`spans.ts`, all infra services.

---

## STAGE C — Collapses unlocked by the keystone  *(precondition: B)*

- **C1 — fold `artifact-publisher` into `cache.publish(spec)`.** Its entire persisted state IS the injected `CacheService`; a separate Service tag + Layer is ceremony over a `cache→verify→produce→register` method. Co-locate in `cache/`.
- **C2 — unify `scoped-multimap` + `scoped-ref-map` → one `defineScopedRegistry<K,V>(name, { multi? })`.** Post-B the multimap has 2 consumers (strategy, formatter), the ref-map 2 (package, coin); LWW = "highest seq" over the multimap. (~150–200 + de-dups 4 wrapper accessor sets.)
- **C3 — merge the 3 L3 composition files → 1 boot module** (`run.ts` + `runtime-composition.ts` + `built-in-plugin-layers.ts`; the sink-construction halves are dead post-B). **C4 — collapse the `capability-decl`/`define-capabilities` conditional-type ceremony** to a plain discriminated union of the 5 first-party kinds.

---

## STAGE D — Snapshot de-gold-plating  *(decision 1: wipe-scoped; independent of B)*

Irreducible core (~1.2–1.5k: pause-around-commit, fail-closed identity guard, atomic stage-and-swap) stays. Remove the gold-plating decision 1 unlocks.

- **D1 — collapse the deploy-cache double-store (the churn killer).** Today ids are tarred into the snapshot at capture AND preserved from the live cache on restore (captured-wins/live-fallback precedence + `overwrite:false` all-or-nothing skip). Under decision 1, restore reuses the live cache: **capture stops tarring `DEPLOY_CACHE_NAMESPACES`; restore drops the precedence + live-preserve fallback; `stage-and-swap` sheds its `overwrite:false` branch** back to plain preserve-always. Host-subtree capture (walrus blobs, seal vault material, keystores) is unchanged — real data, not derivable from cache — so the matrix still proves S1-survives/S2-rolls-back/S3-writable. Keep the identity-guard. Fold in the `DEPLOY_CACHE_NAMESPACES`→plugin-declared inversion (Stage A adjacent item). *(~1,500 src+test + the churn surface. Re-validate the matrix against the single-path version.)*
- **D2 — delete the crash-recovery marker** (`recover-pending` + `pending-marker`, 641 src + 511 test) — a millisecond, already-idempotent, already-`uninterruptible` Docker re-tag window with an unshipped v1 path. Replace with: leave staged images named-after-target, let the supervisor's reuse-if-name-and-image-match adopt them on next boot.
- **D3 — drop redundant tar machinery** — 3 hand-rolled tar parsers (`host-tree-tar`'s ~400-LOC pax/gnu validator over a self-produced archive + `image-bundle-tags`' parser + a third); `integrity.json` (203 + 146 test) SHA-walking an atomically-swapped, never-transmitted artifact. Rely on production-side `isSafeArchivePath` + `tar -x` escape-refusal (or one `tar -t` dry-run); trust `docker load`'s manifest; delete `integrity.json`.

---

## STAGE E — One ViewModel + robust dashboard  *(decision 2: dashboard is a priority)*

- **E1 — hoist `display-derivation` into a surface-neutral ViewModel.** 4 surfaces re-derive the same `ready/active/failed/waiting/health` summary (TUI, dashboard `computeHealthSummary`, `status` rollups, plain-renderer). `display-derivation.ts` is already Ink/React-free for exactly this reason. Lift the pure projection→ViewModel into a shared module that TUI + dashboard GraphQL + `status` consume; render layers stay per-surface.
- **E2 — harden the dashboard's `domain.ts`.** It re-narrows control-plane resolved values by resource-id prefix and degrades to `null` silently on value-shape drift. Keep the richer per-plugin shapes (not duplication); read `mode`/`url`/`status` from the projection via E1; make the narrowing fail-loud. (The dashboard is also the snapshot UI — it pairs with the simplified Stage D engine.)
- **E3 — fold the 3-way endpoint fan-out into one adapter.** One `RoutableDecl` fans into router-route + manifest-entry + projection-event. Make the router's `ResolvedRoute` the single source; derive the other two via one pure adapter. The 3 sinks stay (router proxies / manifest serves L5 apps / projection serves live UI — different consumers); only the derivation unifies. (Folds into B's `ctx.endpoint` verb.)
- **E4 — small collapses.** 3 cross-process locks → one timed-`O_EXCL`-with-liveness-reclaim (do NOT touch the roster/command-channel). Unify `lifecycle-prune` + `docker/sweep` into one scope-parameterized reaper.

---

# Appendix — verified ground truth (re-grep at edit time)

**Plugin type system:** `Plugin<Id,Value,Needs,Caps> extends ResourceRef<Id,Value>` at `substrate/plugin.ts:164-169`; `ResourceRef = {id, [resourceBrand], [resourceValue]?: ()=>Value}` `:21-25`; `StartValue<Start>` infers Value from start's Effect `:95-100`; 4 `definePlugin` overloads (tuple/record/single/none) `:260-304`; `MissingProviders` walks `dependsOn[].id` + brands `:336-354`. No factory carries an explicit `: Plugin<...>` return annotation.

**Plugin runtime context (the 11 inline services):** `buildPluginContext` `orchestrators/run.ts:115-156` — Identity, RuntimeRoot, StackPaths, Cache, StrategyRegistry, ContainerRuntime, ArtifactPublisher, PortBroker, LeaseBroker, PostAcquireTasks, Logger. **Absent (supervisor-frame only, need buffer/replay):** Snapshot, Codegen, Router, ManifestEndpoint (zero refs under `src/substrate/` except Snapshot read `readOptional` at the confined control-plane seam).

**`ctx.persist` keystone:** `ArtifactPublisher.publish<P,V>(spec)` cache key `(namespace, chain: ChainId, contentHash)` `artifact-publisher/index.ts:84,100-102`; `layerArtifactPublisher` requires only `CacheService` `:206`; `Identity.chain` is a `ChainId` `identity.ts:11`. Today the plugin passes `spec.chain` explicitly; `ctx.persist` folds `identity.chain` → byte-identical key. The strategy-leak finalizer is the drop-by-seq `addFinalizer` in `scoped-multimap/service.ts:105-117` (via `StrategyRegistry.register`), **NOT** the event finalizer in `runtime-composition.ts:342-348`.

**Capability mechanism (deleted in B):** `capabilities` = a 2nd closure `({value, runtime: AcquireContext}) => CapabilityDecl[]`; harvested post-`start` in `acquire-node.ts` (~`:180-282`), routed by `dispatch-contributions.ts` through `CapabilitySinksService` (`kindOf` is the one `decl.kind` read) to L3 sink bodies (`runtime-composition.ts:368-406` + `built-in-plugin-layers.ts:32` publishResultSink). 11 `errorContributions` producers; static field, feeds FormatterRegistry. `routablesPresent` = `caps.some(kind==='routable')` `acquire-node.ts:253` → `operational-endpoints.ts:38`.

**Sui-in-substrate (Stage A2):** `sui-execute` 570 (`index.ts:40` imports `@mysten/sui/client`), `sui-move-build` 645, `sui-ledger` 87 (`object-ref.ts:24` imports up from `plugins/sui`). Move targets + ~24 consumers listed in Stage A2. `inference-network.ts:103-115,133-150,227` = Sui network vocab (A3).

**Whole-system LOC map:** plugins 30.8k · substrate 18.7k (runtime: cross-process 2.5k, supervisor 2.4k, observability 2.1k, lifecycle 1.2k, projection 976, port-broker 751, host-tree-tar 652, sui-move-build 645, sui-execute 570, control-plane 387, stage-and-swap 386, state-store 350, lease-broker 332, capability-sinks 328, manifest 290, cache 222, artifact-publisher 213, strategy-registry 206) · orchestrators 12k (snapshot 5.0k, router 3.1k, codegen 2.3k, lifecycle-prune 713) · runtime/docker 5.6k · surfaces 4.9k (cli 3.3k, tui 1.6k) · cli 2.9k · api 1.3k · contracts 1.2k.
