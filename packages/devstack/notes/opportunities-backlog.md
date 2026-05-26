# Devstack opportunities backlog

> Durable triage list seeded by the 2026-05-26 thorough review. Triage markers:
> 🔴 Critical, 🟠 Major, 🟡 Style sweep, ⚪ Closed.
>
> Anchor: `/Users/michaelhayes/.claude/plans/indexed-skipping-squid.md` (8-phase remediation plan).
> Delete this file once empty (per `feedback_completed_plans_should_be_deleted`).

---

## 🔴 Critical — Phase 1 (user-visible regressions)

~~All Phase 1 items shipped 2026-05-26; entries moved to the Closed section below.~~

## 🔴 Critical — Phase 2 (orchestrator / CLI / supervisor correctness)

~~All Phase 2 items shipped 2026-05-26; entries moved to the Closed section below.~~

10a. **Follow-up to closed #10**: a deterministic regression test for "router dispatch lock held across readiness probe" should land alongside the Phase 6 supervisor split. The original `concurrent-contribute-route.test.ts` was flaky under vitest 4's parallel worker scheduling (`it.live` + forks + Promise gates starved sibling test workers). A lock-state-instrumentation harness (no real-time fiber scheduling) would let this land without flakiness.

---

## 🟠 Major — Phase 3 (dead code purge + namespace rename)

~~All Phase 3 items shipped 2026-05-26; entries moved to the Closed section below.~~

## 🟠 Major — Phase 4 (boundary corrections)

~~Items 24, 25, 26, 27, 28, 30, 31 all shipped 2026-05-26; entries moved to the Closed section below. Item 29 partially shipped (action sign/execute dedup done; `package/publish-executor.ts:101-146` SDK-envelope projector consolidation remains).~~

29a. **Follow-up to partially-closed #29**: collapse `package/publish-executor.ts:101-146` SDK-envelope projector onto `substrate/runtime/sui-execute/executeSuiTx`. Also: `account/service.ts`'s `AccountSignError{phase:'submit'}` overloads "no-digest" + "transport failure" + "FailedTransaction"; clean fix is splitting into `'submit' | 'no-digest' | 'failed-transaction'` phases so consumers don't keyword-match on messages.
27. ~~L4 surfaces reaching L1/L2~~ — shipped 2026-05-26. `cli/prune-direct.ts` now consumes the new `orchestrators/lifecycle-prune/` L3 surface; doctor probes moved to `cli/doctor-probes.ts` (L4-adjacent CLI infrastructure); `surfaces/cli/commands/prune.ts` reads a precomputed `PruneGroup.autoPrunable` field instead of importing router constants. STYLE_GUIDE §7 codifies the L4-vs-L4-adjacent split and `test/style/l4-boundary.test.ts` pins the boundary.
28. ~~`api/define-devstack.ts:16-17` special-cases wallet via `WALLET_EXPAND_ACCOUNTS_ALL`.~~ **Shipped (Phase 4 Wave 2C)** — lifted to substrate-owned `src/contracts/plugin-expander.ts` (`PLUGIN_EXPANDER` symbol + `attachPluginExpander`/`runPluginExpanders`/`isPluginExpanderPair`). Wallet contributes through `attachPluginExpander`; `define-devstack.ts` no longer imports any plugin. Compose-time hook (NOT routed through `CapabilitySinks`, which is the runtime-harvest path); the expander symbol writes a value-level property only so it doesn't leak into inferred Stack types (TS2742 invariant preserved).
29. Action duplicates sign/execute pipeline — **partially shipped (Phase 4 Wave 2C)**: `plugins/action/execute.ts` now delegates the sign+execute+wait+project pipeline to `account.withTransactionSigner(...).signAndExecute(txBytes)`; the inline `sdkClient.executeTransaction` path and the `RawExecuteEnvelope` projector are gone. **Still remaining**: collapsing the SDK-envelope projector at `package/publish-executor.ts:101-146` onto the substrate helper at `substrate/runtime/sui-execute/`. That lift can adopt `executeSuiTx` directly (already substrate-blessed Sui-aware module). Also remaining (style-sweep follow-up): account's `AccountSignError{phase:'submit'}` overloads "no-digest" and "transport failure"; the action mapping discriminates by message keyword. A clean fix is a distinct `'no-digest'` phase on `AccountSignError`.
30. ~~Playwright hardcoded route/port table — `playwright/stack-context.ts:77-82,225-235`.~~ **Shipped (Phase 4 Wave 2C)** — lifted to `build-integrations/runtime/conventional-routes.ts` (`BUILT_IN_CONVENTIONAL_HINTS`, `BUILT_IN_ENDPOINT_ALIASES`, `DEFAULT_ROUTER_ENTRYPOINT_PORT`, `builtInConventionalRoutes()`). Playwright consumes through the lifted table. Backlog'd follow-up: any future Vitest cold-start helper consumes the same source.
31. ~~Playwright second global slot via `as unknown as GlobalSlot`.~~ **Shipped (Phase 4 Wave 2C)** — typed slot block lives at `build-integrations/runtime/playwright-stack-context-slot.ts` alongside `dapp-kit-slot.ts`; `playwright/global-setup.ts` reads/writes the slot directly through the typed `declare global` block. Cast removed.

## 🟠 Major — Phase 5b (deferred substrate lifts)

Phase 5a closed items 34, 35, 36 (doc-only), 37 on 2026-05-26 (entries in Closed below). Items 32 and 33 are deferred to a follow-up phase that pairs naturally with the Phase 6 supervisor split, where the projection emit-paths get split out of the supervisor monolith and can adopt the new opaque event/projection shapes cleanly.

32. `SpanAttr` carries 12 plugin-domain keys — `src/substrate/runtime/observability/spans.ts:20-60`. Lift via a substrate `SpanVocabDecl` capability + per-plugin spans.ts contributions; harvest through the existing `CapabilitySinks` Layer composition.
33. Substrate `EngineEvent`/`projection.ts` carry `account.updated`/`package.updated` + branded `account/${string}`/`package/${string}`/`coin: string` keys. Introduce a name-blind `projection.updated` event `{ kind: string, key: string, payload: unknown }` and lift account-/package-specific projection handling to a new L3 orchestrator (`src/orchestrators/projection/`) that knows the typed payload shapes. Land alongside the supervisor split so the publisher path moves out cleanly.
37a. `EnsureContainerSpec.networkAttach` is name-blind — accepts network names but no `--network-alias` plumbing, so plugins exposing a `networkAlias` field on their handle (postgres, future siblings) cannot have Docker register an alternate DNS name. Phase 1 bug #5 worked around this in `plugins/postgres/index.ts` by routing codegen at the container DNS name (`${app}-${stack}-${name}`) instead. Long-term: extend `EnsureContainerSpec` to accept per-network aliases (e.g. `networkAttach: ReadonlyArray<string | { name: string; aliases?: string[] }>`), thread through the runtime adapter's `docker network connect --alias`, then flip the postgres codegen back to `value.networkAlias` and let parallel stacks dial by the alias rather than the per-stack container name.

## 🟠 Major — Phase 6 (supervisor split)

38. `src/substrate/runtime/supervisor.ts` 1789 LOC — split into `supervisor/{index,command-loop,acquire-node,dispatch-contributions,background-tasks,shutdown,wiring}.ts`.
39. `dispatchContributions` catches only `UnknownContributionKind`, misattributes `ContributionSinkFailed` to plugin — fix during split.
40. `getOrDefault[Effect]` "smoke-test no-op fallback" endemic — lift to one `OptionalService<T>` helper during the split.

---

## 🟡 Style sweep — Phase 7

### 7A — Free-form span keys (~254 sites)
41. `walrus/*` (~6 files), `seal/*` (~5), `sui/mode/*` (~5), `package/{mode-local,publish-executor}` (~7), `coin/*` (~4), `account/{service.ts:6 sites, funding.ts:3 sites}`, `postgres/*` (~4), `deepbook/*` (~5), `action/execute.ts` (1).

### 7B — Bespoke retry / decode / HTTP
42. `account/funding.ts:486-529` `waitForBalanceAtLeast` → `retry-policy.ts`.
43. `account/service.ts:315-329` `makeFundingBalanceReader` → `retry-policy.ts`.
44. `seal/mode/local-keygen.ts:194-198` `JSON.parse + Schema.decodeUnknownEffect` → `decodeJsonText`.
45. `cli/snapshot-reader.ts:46-65` bare decode → `decodeJsonTextSync`.
46. `build-integrations/runtime/read-stack-context.ts:62` bare decode → `decodeUnknownSync`.
47. `sui/mode/shared-boot.ts:191` bespoke `postJsonRpc` → new substrate `json-rpc-client.ts` primitive.
48. `faucet/http.ts:128-203` bespoke retry — either `HttpProbes` or document carve-out.
49. `walrus/deploy.ts:130-131` `DEPLOY_BIND_SOURCE_RETRY_ATTEMPTS` → `retry-policy.ts`.

### 7C — `as unknown as` at user-facing surface (~10 sites)
50. `wallet/index.ts:169`, `account/index.ts:199,210`, `deepbook/index.ts:269,274,290,459`, `host-service/{index.ts:57,service.ts:463,466}`, `api/{define-devstack,define-devstack-with}.ts` (~5).

### 7D — Misc style
51. `surfaces/tui/event-log.ts:208-215` substring-match on `pluginKey` for color.
52. `surfaces/cli/commands/prune-picker.tsx` ink eager-import.
53. Naming `coinRegistryLayer` vs `layerPackageRegistry`.
54. `build-integrations/vitest/setup.ts:90` `console.warn` default writer.
55. `build-integrations/runtime/cold-start-url.ts:156` dead conditional `'h2c' ? 'http' : 'http'`.
56. `cli/main.ts:120-174` manual `ENGINE_COMMAND_TAGS` tuple.
57. `cli/main.ts:176-190` redundant `instanceof CliSupervisorLiveError`.
58. `cli/main.ts:898-900` duplicated `provideFileSystem` helper.

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
