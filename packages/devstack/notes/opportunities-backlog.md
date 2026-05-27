# Devstack opportunities backlog

> Durable triage list seeded by the 2026-05-26 thorough review. Triage markers:
> 🔴 Critical, 🟠 Major, 🟡 Style sweep, ⚪ Closed.
>
> Anchor: `/Users/michaelhayes/.claude/plans/indexed-skipping-squid.md` (8-phase remediation plan).
> Delete this file once empty (per `feedback_completed_plans_should_be_deleted`).

---

## 2026-05-27 — doc-refinement pass (Phase D)

Second thorough review surfaced findings that were "real per the docs" but where the docs
themselves were over-rigid. Closed-by-rule-relaxation rather than by implementation:

- ~~`ChainOperation<Produced>` typed seam adoption~~ — REJECTED. Substrate primitive deleted
  (`git rm src/substrate/runtime/artifact-publisher/chain-operation.ts` + test); zero plugin
  consumers six months after landing was the signal that the abstraction wasn't load-bearing.
  STYLE_GUIDE §11 relaxed: produce body shape is plugin-owned.
- ~~`makeRegistry<T>()` substrate helper for 3 orchestrator register-with-finalizer patterns~~ —
  REJECTED. Three copies of ~30 lines is cheaper than one substrate primitive parameterized 3
  ways. STYLE_GUIDE §23 pruned to reflect.
- ~~snapshot's four `failPhase` helpers → one~~ — REJECTED. Four copies of ~8 lines, each
  locally readable. Same reasoning as above; STYLE_GUIDE §23 pruned.
- ~~L2 wrapper-service required for every `defineScopedRefMap` consumer~~ — RELAXED. When the
  surface is a 1:1 re-projection (Move-package's PackageRegistry), consume the factory directly;
  add the wrapper when the first plugin-specific method lands. STYLE_GUIDE §10b updated.
- ~~File-LOC threshold at ~700~~ — DROPPED. LOC is a smell, not a threshold. `cli/main.ts` and
  `deepbook/{index,deploy}.ts` stay coherent; split only when readability genuinely suffers.
  STYLE_GUIDE §8 updated.
- ~~Named retry profile required for every retry~~ — RELAXED. One-off retries with no sibling
  reuse can stay inline. STYLE_GUIDE §16 updated.
- ~~Wallet↔host-service coupling as undocumented finding~~ — ACCEPTED as third sanctioned bus
  (endpoint-defaults). ARCHITECTURE.md updated.
- ~~Router orchestrator bypasses `ContainerRuntime.ensureContainer`~~ — ACCEPTED as documented
  carve-out (router stamps `kind`/`subkind`/`specVersion` labels). ARCHITECTURE.md updated;
  widening the L1 contract for one consumer was rejected.
- ~~`substrate/runtime/run.ts` L0→L1 import boundary violation~~ — REPAIR planned (Phase A #5):
  move file to `orchestrators/runtime-composition/run.ts`. ARCHITECTURE.md updated to clarify
  Layer-composition belongs at L3/L4 not L0.
- ~~Substrate name-blindness allowlist "TODO Phase 5b" markers~~ — DEMOTED to permanent design
  notes. Projection field set + supervisor's branded resource-id literal are substrate field
  shapes that name plugin-domain values by design; no further lift planned.
- ~~Wallet /execute endpoint shape~~ — DELETED 2026-05-27. Zero consumers, wire bug, dapp-kit/dev-wallet bypass. When a concrete consumer materializes (likely fork-impersonation UI), reintroduce matching the Sui Wallet Standard wire shape: flat `{bytes, signature, digest, effects (base64 BCS)}` on 200, transport/lifecycle errors via the existing `ErrorResponseSchema`. `account.signAndExecute` will need a sibling closure that surfaces BCS effects instead of the parsed `TxResult.effects: unknown` projection.

---

## 🔴 Critical — Phase 1 (user-visible regressions)

~~All Phase 1 items shipped 2026-05-26; entries moved to the Closed section below.~~

## 🔴 Critical — Phase 2 (orchestrator / CLI / supervisor correctness)

~~All Phase 2 items shipped 2026-05-26; entries moved to the Closed section below.~~

10a. ~~Follow-up to closed #10: deterministic regression test for "router dispatch lock held across readiness probe"~~ — **shipped (structural variant)**: `test/orchestrators/router/lock-state-instrumentation.test.ts` walks `src/orchestrators/router/service.ts`, locates the `Effect.scoped(...)` block containing `acquireStackLock`, and asserts both `publishRouteFile` and `waitForPublicRouteReadiness` live inside it (with publish before probe). Effect's Scope semantics carry the rest — the lock finalizer cannot fire until the scoped block closes, which is after the probe completes. Deterministic, no fibers, no real timing. STYLE_GUIDE §3 codifies the "no `it.live` fiber races for lock-ordering" rule + names the `Effect.Service` refactor as the escape hatch for lock-state questions that exceed structural checks.

---

## 🟠 Major — Phase 3 (dead code purge + namespace rename)

~~All Phase 3 items shipped 2026-05-26; entries moved to the Closed section below.~~

## 🟠 Major — Phase 4 (boundary corrections)

~~Items 24, 25, 26, 27, 28, 30, 31 all shipped 2026-05-26; entries moved to the Closed section below. Item 29 partially shipped (action sign/execute dedup done; `package/publish-executor.ts:101-146` SDK-envelope projector consolidation remains).~~

29a. ~~Follow-up to partially-closed #29: collapse `package/publish-executor.ts:101-146` SDK-envelope projector + `AccountSignError{phase:'submit'}` overload~~ — **shipped (sign-flow redesign)**: rather than splitting `phase` into more sub-discriminators, the account's `signAndExecute` was reshaped to mirror the SDK's discriminated-union return (`SuiClientTypes.TransactionResult`-style: `{$kind: 'Transaction' | 'FailedTransaction', ...}`). On-chain failures are now a RETURN VARIANT, not an error — callers dispatch on `$kind`. `AccountSignError.phase` carries only transport/lifecycle failures (`'build-tx' | 'sign' | 'submit' | 'await-finality' | 'dependent-package-not-found' | 'lease-acquire' | 'impersonation-bypass-attempt'`); the previously-overloaded "submit + no-digest + on-chain" set is gone. Action plugin gained `phase: 'execute-failed'` for the FailedTransaction variant mapping. `package/publish-executor.ts:rawEnvelopeFromAccountTx` deleted; impersonate path consumes `SignAndExecuteResult` directly via `publishChangesFromTxResult`. Walrus / coin / action / wallet all dispatch on `$kind` and surface their own plugin-shaped on-chain failure. STYLE_GUIDE §2 codifies "failed conditions as return-channel discriminated unions; phases describe steps, not failure kinds".
27. ~~L4 surfaces reaching L1/L2~~ — shipped 2026-05-26. `cli/prune-direct.ts` now consumes the new `orchestrators/lifecycle-prune/` L3 surface; doctor probes moved to `cli/doctor-probes.ts` (L4-adjacent CLI infrastructure); `surfaces/cli/commands/prune.ts` reads a precomputed `PruneGroup.autoPrunable` field instead of importing router constants. STYLE_GUIDE §7 codifies the L4-vs-L4-adjacent split and `test/style/l4-boundary.test.ts` pins the boundary.
28. ~~`api/define-devstack.ts:16-17` special-cases wallet via `WALLET_EXPAND_ACCOUNTS_ALL`.~~ **Shipped (Phase 4 Wave 2C)** — lifted to substrate-owned `src/contracts/plugin-expander.ts` (`PLUGIN_EXPANDER` symbol + `attachPluginExpander`/`runPluginExpanders`/`isPluginExpanderPair`). Wallet contributes through `attachPluginExpander`; `define-devstack.ts` no longer imports any plugin. Compose-time hook (NOT routed through `CapabilitySinks`, which is the runtime-harvest path); the expander symbol writes a value-level property only so it doesn't leak into inferred Stack types (TS2742 invariant preserved).
29. Action duplicates sign/execute pipeline — **partially shipped (Phase 4 Wave 2C)**: `plugins/action/execute.ts` now delegates the sign+execute+wait+project pipeline to `account.withTransactionSigner(...).signAndExecute(txBytes)`; the inline `sdkClient.executeTransaction` path and the `RawExecuteEnvelope` projector are gone. **Still remaining**: collapsing the SDK-envelope projector at `package/publish-executor.ts:101-146` onto the substrate helper at `substrate/runtime/sui-execute/`. That lift can adopt `executeSuiTx` directly (already substrate-blessed Sui-aware module). Also remaining (style-sweep follow-up): account's `AccountSignError{phase:'submit'}` overloads "no-digest" and "transport failure"; the action mapping discriminates by message keyword. A clean fix is a distinct `'no-digest'` phase on `AccountSignError`.
30. ~~Playwright hardcoded route/port table — `playwright/stack-context.ts:77-82,225-235`.~~ **Shipped (Phase 4 Wave 2C)** — lifted to `build-integrations/runtime/conventional-routes.ts` (`BUILT_IN_CONVENTIONAL_HINTS`, `BUILT_IN_ENDPOINT_ALIASES`, `DEFAULT_ROUTER_ENTRYPOINT_PORT`, `builtInConventionalRoutes()`). Playwright consumes through the lifted table. Backlog'd follow-up: any future Vitest cold-start helper consumes the same source.
31. ~~Playwright second global slot via `as unknown as GlobalSlot`.~~ **Shipped (Phase 4 Wave 2C)** — typed slot block lives at `build-integrations/runtime/playwright-stack-context-slot.ts` alongside `dapp-kit-slot.ts`; `playwright/global-setup.ts` reads/writes the slot directly through the typed `declare global` block. Cast removed.

## 🟠 Major — Phase 5b (deferred substrate lifts)

Phase 5a closed items 34, 35, 36 (doc-only), 37 on 2026-05-26 (entries in Closed below). Items 32 and 33 are deferred to a follow-up phase that pairs naturally with the Phase 6 supervisor split, where the projection emit-paths get split out of the supervisor monolith and can adopt the new opaque event/projection shapes cleanly.

32. ~~`SpanAttr` carries 12 plugin-domain keys~~ — **shipped (simpler variant)**: keys lifted to per-plugin `spans.ts` files (`src/plugins/wallet/spans.ts:WalletSpans`, `src/plugins/account/spans.ts:AccountSpans`, `src/plugins/coin/spans.ts:CoinSpans`, `src/plugins/sui/spans.ts:SuiSpans`). Substrate `SpanAttr` now carries engine-dimensional + http/process generic keys only. The originally-spec'd runtime `SpanVocabDecl` capability was dropped per user direction — no runtime consumer exists (substrate logger only reads engine-dimensional keys), so the per-plugin const-export pattern is the simplest correct answer. Style discipline pinned by STYLE_GUIDE §16 + the Wave 3B sweep + style test. Allowlist shrunk one entry (`spans.ts` no longer mentions plugin names; the surviving allowlist entry is for `host: 'server.address'` OTEL convention which the regex flags as "host").
33. ~~Substrate `EngineEvent` carries `account.updated`/`package.updated` event variants~~ — **shipped (event-layer variant)**: collapsed both into a single name-blind `projection.updated` carrying `{kind, key, payload, at}`. `substrate/events.ts` no longer mentions plugin names; the allowlist entry shrunk. Reducer (`substrate/runtime/projection/update.ts`) dispatches on `event.kind` and decodes `payload` per kind ('account' / 'package' today; new kinds slot in by extending the switch). Plugins (`account/registry.ts`, `package/index.ts`) emit the new envelope; orchestrator capability sink (`orchestrators/runtime-composition.ts:makeProjectionCapabilitySink`) stamps `rowKey` on the opaque payload via a single structural check. TUI consumers (`surfaces/tui/event-log.ts`, `surfaces/tui/plain-renderer.ts`) dispatch on the new variant. STYLE_GUIDE §21 codifies the discipline. **Deferred**: the branded keys (`account/${string}`, `package/${string}`) + the `SubscribableState.{accounts, packages}` field list stay (would cascade into projection persistence + the closed-field-list invariant); the L3 lift to `src/orchestrators/projection/` with a kind→decoder registry is a separate follow-up.
37a. ~~`EnsureContainerSpec.networkAttach` is name-blind — accepts network names but no `--network-alias` plumbing~~ — **shipped**: contract widened to `ReadonlyArray<string | { name: string; aliases?: ReadonlyArray<string> }>` (`src/contracts/container-runtime.ts`); Docker reference impl emits `--network-alias` on `docker run` for the primary attach and `--alias` on `docker network connect` for subsequent attaches (`src/runtime/docker/container.ts`, `src/runtime/docker/network.ts`). Postgres now passes `{ name: containerNetwork, aliases: [networkAlias] }` and the codegen is flipped back to `value.networkAlias` — parallel stacks dial by the per-stack alias rather than the container name. Test cover: `test/runtime/docker/network-alias.test.ts` (new) + `test/plugins/postgres/codegen-host.test.ts` (flipped expectations).

## 🟠 Major — Phase 6 (supervisor split)

38. ~~`src/substrate/runtime/supervisor.ts` 1815 LOC~~ — **shipped 2026-05-26**: split into `supervisor/{index,start-supervisor,command-loop,acquire-node,dispatch-contributions,teardown,background-tasks,shutdown,state,types,errors,wiring}.ts`; each module <500 LOC. `supervisor.ts` is now a one-line `export * from './supervisor/index.ts'` shim preserving caller import paths. ARCHITECTURE.md primitives row + STYLE_GUIDE §8 reference-shape codified.
39. ~~`dispatchContributions` catches only `UnknownContributionKind`, misattributes `ContributionSinkFailed`~~ — **shipped 2026-05-26**: `dispatchContributions` now catches BOTH tags via `Effect.catchTags`. `UnknownContributionKind` stays a no-op (substrate-open-by-default). `ContributionSinkFailed` publishes the new typed `engine.orchestrator.dispatchFailed` event + logs a warning; plugin lifecycle remains `ready`. Regression test at `test/substrate/runtime/supervisor-contribution-sink-fail.test.ts`.
40. ~~`getOrDefault[Effect]` "smoke-test no-op fallback" endemic~~ — **shipped 2026-05-26**: lifted to `OptionalService<T>` in `supervisor/wiring.ts`. Three callsites (Logger, RuntimeRoot, CapabilitySinks) fold into one shape; `OptionalService(tag).read(ctx, fallback)` / `.readEffect(ctx, fallback)`.

---

## 🟡 Style sweep — Phase 7

### 7A — Free-form span keys (~254 sites) — DEFERRED pairs with backlog #32

41. `walrus/*` (~6 files), `seal/*` (~5), `sui/mode/*` (~5), `package/{mode-local,publish-executor}` (~7), `coin/*` (~4), `account/{service.ts:6 sites, funding.ts:3 sites}`, `postgres/*` (~4), `deepbook/*` (~5), `action/execute.ts` (1). The plugin-side migration shape depends on whether `SpanAttr` stays substrate-canonical (caller imports a single namespace) or becomes plugin-contributed (caller imports its own plugin's `spans.ts`). Land alongside #32 SpanAttr lift.

### 7B — Bespoke retry / decode / HTTP
42. ~~`account/funding.ts:486-529` `waitForBalanceAtLeast`~~ — **shipped Phase 7B**: now consumes `makeBoundedSpacedSchedule` + `BALANCE_POLL_PROFILE` from `retry-policy.ts`. Loop body is `Effect.repeat({ schedule, until })`.
43. ~~`account/service.ts:315-329` `makeFundingBalanceReader`~~ — **shipped Phase 7B**: `FUNDING_BALANCE_TIMEOUT_MS` constant lifted to `retry-policy.ts` as `FUNDING_BALANCE_READ_TIMEOUT_MS`. Reader still uses `Effect.timeoutOrElse` (the local shape — wraps a `Promise`, returns `null` fallback — is right at this site; only the constant moved).
44. ~~`seal/mode/local-keygen.ts:194-198`~~ — **shipped Phase 7B**: `JSON.parse + Schema.decodeUnknownEffect` collapsed to `decodeJsonText(schema, raw, { source, mkError: i => i })`; surrounding `.pipe(Effect.catch(() => null))` makes the call-site decision-to-null explicit per task brief.
45. ~~`cli/snapshot-reader.ts:46-65`~~ — **shipped Phase 7B**: `JSON.parse + Schema.decodeUnknownSync` → `decodeJsonTextSync(SnapshotMetadataSchema, ..., { source, mkError })`. Surrounding try/catch fallback to `null`-named entry stays.
46. ~~`build-integrations/runtime/read-stack-context.ts:62`~~ — **shipped Phase 7B**: pre-built `Schema.decodeUnknownSync(...)` replaced with `decodeUnknownSync(ManifestEnvelopeSchema, parsed, { source: manifestPath, mkError: i => i })`. Surrounding try/catch + `ManifestShapeError` rewrap stays.
47. ~~`sui/mode/shared-boot.ts:191` bespoke `postJsonRpc` + `normalizeJsonOwner` + `getObjectViaJsonRpc`~~ — **shipped (gRPC pivot)**: JSON-RPC is deprecated upstream; the helpers were deleted in favor of `sdkClient.core.getObject(...)` (the gRPC core API already returns the `{object: {...}}` envelope and the native `SuiClientTypes.ObjectOwner` discriminants). `chain-probe.ts:ObjectOwnerSchema` now mirrors the SDK shape (`AddressOwner` / `ObjectOwner` / `Shared` / `Immutable` / `ConsensusAddressOwner` / `Unknown`); the `Parent` rename is gone. `assembleSuiClient`'s `sdkRpcUrl` parameter dropped (only consumed by the JSON-RPC plumbing). STYLE_GUIDE §16 codifies "Sui chain access goes through gRPC `core`; do not hand-roll JSON-RPC".
47a. ~~lift `substrate/runtime/json-rpc-client.ts` primitive~~ — **superseded by 47** (gRPC pivot makes a JSON-RPC primitive unnecessary).
48. ~~`faucet/http.ts:128-203` bespoke retry~~ — **shipped Phase 7B (carve-out variant)**: header comment at the file documents that one-shot POST + body-shape validation is owned here, not `HttpProbes.waitForHttpEndpoint(...)` (a *readiness probe* primitive). Retry constants lifted to `retry-policy.ts:FAUCET_HTTP_RETRY_PROFILE`; the local `DEFAULT_*` exports forward to the profile so callers see no change.
49. ~~`walrus/deploy.ts:130-131` `DEPLOY_BIND_SOURCE_RETRY_ATTEMPTS`~~ — **shipped Phase 7B**: profile lifted to `retry-policy.ts:DEPLOY_BIND_SOURCE_RETRY_PROFILE`; the hand-rolled `for(let attempt = 0; ; ...)` loop is now `Effect.repeat({ schedule: makeSpacedRetrySchedule(...), until: r => !isBindSourceMissing(r) })`.

### 7C — `as unknown as` at user-facing surface (~10 sites) — DEFERRED

50. ~~`as unknown as` audit at user-facing surface (~10 sites)~~ — **shipped (manifest variant)**: triage found every cast is a genuine TS inference limit (dependent-tuple narrowing, symbol-keyed property reads, generic-default widening, Node child_process iterable bridges); no architectural lift removes them today. `test/style/no-unknown-as.test.ts` pins the sanctioned-cast manifest with per-file counts + reasons; new casts at `src/api/`, `src/plugins/<name>/index.ts`, or `src/plugins/host-service/service.ts` fail CI, and so do removed casts (forcing the cleanup to update the manifest, surfacing the lift that closed it). STYLE_GUIDE §5 references the manifest as the source-of-truth for what's sanctioned at user-facing surfaces.

### 7D — Misc style
51. ~~`surfaces/tui/event-log.ts:208-215` substring-match on `pluginKey` for color~~ — shipped 2026-05-26. Lifted to `sectionForKey(key)` + `sectionColor(section)` in `display-derivation.ts`; event-log derives scope-chip color via the closed `RowSection` vocabulary, no plugin-name substring matching.
52. ~~`surfaces/cli/commands/prune-picker.tsx` ink eager-import~~ — shipped 2026-05-26. Split into `prune-picker-entry.ts` (no ink import) that lazy-imports `prune-picker.tsx` via `Effect.promise(() => import(...))`; `cli/prune-direct.ts` consumes the lazy seam, mirroring `surfaces/tui/index.ts` `mount-ink.tsx` pattern.
53. ~~Naming `coinRegistryLayer` vs `layerPackageRegistry`~~ — shipped 2026-05-26. Renamed `coinRegistryLayer` → `layerCoinRegistry` (callers updated: `coin/index.ts`, `runtime/built-in-plugin-layers.ts`, two test files, release-surface leak-detector). STYLE_GUIDE §6 codifies `layerXxx` prefix convention.
54. ~~`build-integrations/vitest/setup.ts:90` `console.warn` default writer~~ — shipped 2026-05-26. Default writer is now `(line) => process.stderr.write(line + '\n')`; zero `console.*` sites remain in `src/`.
55. ~~`build-integrations/runtime/cold-start-url.ts:156` dead conditional~~ — shipped 2026-05-26. Collapsed to `scheme: 'http'` with a one-line header comment naming the Traefik h2c convention.
56. ~~`cli/main.ts:120-174` manual `ENGINE_COMMAND_TAGS` tuple~~ — shipped 2026-05-26. Replaced with exhaustive `switch (knownTag)` over `EngineCommand['tag']` + `_exhaustive: never` proof. New `EngineCommand` variants now fail typecheck if not added to the discriminator switch.
57. ~~`cli/main.ts:176-190` redundant `instanceof CliSupervisorLiveError`~~ — shipped 2026-05-26. Dropped the `instanceof` branch; relies solely on `_tag === 'CliSupervisorLiveError'` (canonical Effect-tag pattern).
58. ~~`cli/main.ts:898-900` duplicated `provideFileSystem` helper~~ — shipped 2026-05-26. Hoisted the top-level `provideFileSystem(fs, effect)` to one place (near `rosterPathsFor`); `makeSnapshotCommandHandler` calls it directly with `params.fs` instead of carrying a closure variant.

---

## ⚪ Closed

### Phase 5a (shipped 2026-05-26)

34. ~~`port-broker/service.ts` `PORT_KINDS` includes `'wallet'`~~ — collapsed `PortKind` entirely; allocator now takes opaque `owner?` diagnostic string + per-call `windowHint?`. Default window covers every caller; wallet passes `windowHint: { start: 39200, size: 1000 }` to preserve its dapp-kit autoconnect port range.
35. ~~`strategy-registry/faucet-capability-for.ts` names faucet~~ — file `git mv`'d to `chain-keyed-strategy-for.ts`; signature is now `chainKeyedStrategyFor<P>(prefix, chainId)` (prefix is a parameter); substrate-side `FAUCET_CAPABILITY_KEY_PREFIX` constant + `faucetCapabilityKey` helper deleted. Account's three call sites import the prefix from `plugins/faucet/index.ts`.
36. ~~`substrate/runtime/sui-move-build/` undocumented~~ — added to ARCHITECTURE.md §"Substrate name-blindness" exceptions list alongside `sui-execute/`; module header points at the doc section.
37. ~~L1 Docker router-named labels~~ — `labels.ts` now carries generic `kind`/`subkind`/`specVersion`; `runtime/docker/sweep.ts` + `inventory.ts` expose generic `listDevstackContainersByKind` / `removeDevstackContainersByKindAndName`; router orchestrator stamps `kind='router'` + `subkind=<profile.id>`. STYLE_GUIDE §7 codifies the L1-labels-are-generic rule.

Also landed: `test/substrate/name-blindness.test.ts` — CI invariant that walks `src/substrate/` and grep-fails on plugin names outside an allowlist. The allowlist documents 15 outstanding entries (SpanAttr, events.ts, projection.ts, projection/*, supervisor.ts, plus substrate-host primitives) each with a TODO pointing at the Phase 5b/6 item that will close it.

### Phase 4 (shipped 2026-05-26)

24. ~~Account ↔ Coin bidirectional cross-import~~ — `AccountFundingStrategy<E, A>` lifted to substrate-neutral `src/contracts/funding-strategy.ts`; account narrows generics to `AccountValue`; coin imports the contract directly; `CoinResourceId` literal alias inlined at `account/funding.ts` (the cross-direction reach is gone). STYLE_GUIDE §7 adds the rule.
25. ~~Sui ↔ faucet reverse-import~~ — `faucet/strategies/{sui-local,sui-live}.ts` moved into `plugins/sui/{local-faucet-strategy,live-faucet-strategy}.ts`; `faucet/strategies/` deleted; sui imports `faucetCapabilityKey` / `FaucetStrategy` from `faucet/index.ts` barrel.
26. ~~Plugin barrel imports~~ — Wave 2A swept 18 files / 23 internal-module imports / 6 import-block consolidations across `plugins/{seal,wallet,walrus,deepbook,action,package,account}`; every cross-plugin import now goes through `index.ts`.
27. ~~L4 surfaces reaching L1/L2~~ — `cli/prune-direct.ts` consumes new `orchestrators/lifecycle-prune/`; doctor probes moved to `cli/doctor-probes.ts` (L4-adjacent CLI infrastructure). STYLE_GUIDE §7 codifies the L4-vs-L4-adjacent split; `test/style/l4-boundary.test.ts` pins the invariant.
28. ~~`api/define-devstack.ts` special-cases wallet~~ — lifted to substrate-owned `src/contracts/plugin-expander.ts` (`PLUGIN_EXPANDER` symbol + `attachPluginExpander` / `runPluginExpanders` / `isPluginExpanderPair`); wallet contributes through the contract; composer no longer imports any plugin.
30. ~~Playwright hardcoded route/port table~~ — lifted to `build-integrations/runtime/conventional-routes.ts` (`BUILT_IN_CONVENTIONAL_HINTS`, `BUILT_IN_ENDPOINT_ALIASES`, `DEFAULT_ROUTER_ENTRYPOINT_PORT`, `builtInConventionalRoutes()`); Playwright consumes the lifted table.
31. ~~Playwright second global slot via `as unknown as GlobalSlot`~~ — typed slot at `build-integrations/runtime/playwright-stack-context-slot.ts` mirrors `dapp-kit-slot.ts` pattern; cast removed.

### Phase 3 (shipped 2026-05-26)

15. ~~`plugins/faucet/service.ts` deleted~~ (`acquireFaucetService` + `FaucetService` had zero callers).
16. ~~`plugins/faucet/dispatcher.ts` trimmed~~ — `FaucetDispatcher` interface + `makeDispatcher` factory deleted; `FAUCET_CAPABILITY_KEY_PREFIX` + `faucetCapabilityKey` retained (sui plugin still consumes the key helper pending Phase 4 #25).
17. ~~`FAUCET_ERROR_TAGS` orphan~~ deleted from `faucet/errors.ts`.
18. ~~`plugins/action/lifecycle.ts` deleted~~; root re-export and release-surface leak entry dropped.
19. ~~`plugins/sui/{move-lock-scrub,cli-driver}.ts` deleted~~; `chain-build-container.ts` now imports `containerInnerScript` directly from `substrate/runtime/sui-move-build`.
20. ~~`LoggerError` deleted~~ from `substrate/runtime/observability/logger.ts` plus the unused `Data` import.
21. (`lifted-sibling-registry/` did not exist on this branch — no action needed; backlog item was stale.)
22. ~~`build-integrations/{vite,browser}/` empty dirs deleted~~.
23. ~~`@devstack-rewrite/` namespace tag eradicated~~ — sed-swept 35 src/ + 1 test/ sites to `@devstack/`. STYLE_GUIDE §5 codifies the rule (Effect Service tag identifiers MUST use the current package namespace).

### Phase 2 (shipped 2026-05-26)

7. ~~Snapshot restore brittle string-sniff + plain-Error orchestrator failures~~ — `snapshot/integrity.ts` + `snapshot/state-document.ts` now use `Schema.TaggedErrorClass` with discriminated `kind` field (`missing`/`corrupt`/`mismatch`/`walk-failed` and `read`/`parse`/`decode`/`write`); `restore.ts` consumes via `Effect.catchTag`. STYLE_GUIDE §2 sub-rule codifies the orchestrator-tagged-error pattern.
8. ~~Codegen has no per-cycle outer stage-and-swap~~ — `runEmitCycle` now wraps writes in `substrate/runtime/stage-and-swap`; pre-seeds the staging dir from the current output so emit idempotency reads the right baseline; `StageAndSwapError` maps to `CodegenWriteFailed{ stage:'rename' }`.
9. ~~Codegen watcher claims debounce but doesn't~~ — `Ref<latest>` + tap replaced with `Stream.debounce(150ms) → Stream.mapEffect(runEmitCycle)`. Window exported for tests.
10. ~~Router dispatch lock released before readiness probe~~ — lock now wraps `publishRouteFile + waitForPublicRouteReadiness` inside one `Effect.scoped`. Codified in STYLE_GUIDE §18. (Regression test deletion + follow-up tracked at item 10a above.)
11. ~~CLI snapshot completion misattributes peer's `captureSkipped`~~ — extended `EngineEvent.snapshot.captureSkipped` with `snapshotId?`/`name?`; CLI matcher requires `snapshotId === snapshotId`. Test: `test/cli/snapshot-completion.test.ts`.
12. ~~CLI event-stream decoder uncaught on truncated `events.ndjson`~~ — `tailRecords` gained `onDecodeError: 'skip'` option (Effect.option swallow + logDebug); CLI passes it; subscriber's `events` stream + `awaitCompletion`'s `findReply` also opt in so truncation tolerance applies uniformly. STYLE_GUIDE §20 codifies the rule.
13. ~~Supervisor hard-shutdown teardown not `Effect.uninterruptible` on in-loop path~~ — both `shutdown.requested`/`stack.stop` and `shutdown.hardKillRequested` branches now wrap teardown + `Deferred.succeed(shutdownComplete)` in `Effect.uninterruptible`. Header comments document why `process.exit` from signals.ts is still a hard kill.
14. ~~Docker `loadImage` fiber leak via `Effect.forkChild`~~ — actually `saveImages`'s `stderrFiber`/`exitFiber`; switched to `Effect.forkScoped` so they ride the `Stream.unwrap` scope. STYLE_GUIDE §1 reference uses cited.

### Phase 1 (shipped 2026-05-26)

1. ~~Walrus deploy cache-hit sentinel~~ — substrate `ArtifactPublisher.publish` simplified to return `Produced` only; walrus discriminator dance + sentinel deleted; same simplification applied to package/coin/action/seal callers.
2. ~~Walrus storage-node BLS pubkey placeholder~~ — `publicKey` field dropped from `WalrusStorageNode` (SDK reads it from `packageConfig`).
3. ~~Seal testnet `keyServerObjectId` placeholder~~ — set to `null` (typed `string | null`); `validateLiveInputs` rejects with `SealConfigError` when no override is supplied.
4. ~~Seal default version sentinel~~ — replaced with `DEFAULT_SEAL_VERSION` from `bootstrap-assets/source-fetch.ts`.
5. ~~Postgres codegen host~~ — codegen now emits `value.host` (container DNS name); substrate `networkAlias` plumbing tracked at Phase 5 item 37a.
6. ~~Coin mint cache key~~ — `signer.address` folded into `buildMintContentHash` (mirrors `package/mode-local.ts:149-152`).
