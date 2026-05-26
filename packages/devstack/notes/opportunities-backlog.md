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

24. Account ↔ Coin bidirectional cross-import — `coin/index.ts:38` ↔ `account/funding.ts:32,40`. Lift `AccountFundingStrategy` to `src/contracts/funding-strategy.ts`.
25. Sui ↔ faucet reverse-import — `sui/index.ts:64-65` reaches `faucet/dispatcher.ts` + `faucet/strategies/sui-local.ts`. Sui-owned strategy.
26. Plugin barrel imports — ~25 sites across `plugins/{seal,wallet,walrus,coin,action,package,deepbook}` reach internal modules instead of `index.ts` barrels.
27. L4 surfaces reaching L1/L2 — `cli/prune-direct.ts:11-25` → `runtime/docker/*`; `surfaces/cli/commands/doctor-probes.ts:33-34` → `orchestrators/router/index.ts` + `plugins/router-entrypoints.ts`.
28. `api/define-devstack.ts:16-17` special-cases wallet via `WALLET_EXPAND_ACCOUNTS_ALL`. Lift to substrate expander capability.
29. Action duplicates sign/execute pipeline — `action/execute.ts:172-355` vs `account/service.ts:666-704`. Three SDK-envelope projectors collapse to one helper.
30. Playwright hardcoded route/port table — `playwright/stack-context.ts:77-82,225-235`. Lift to `runtime/conventional-routes.ts`.
31. Playwright second global slot via `as unknown as GlobalSlot` — `playwright/global-setup.ts:151-171`. Add typed `declare global`.

## 🟠 Major — Phase 5 (substrate name-blindness)

32. `SpanAttr` carries 12 plugin-domain keys — `src/substrate/runtime/observability/spans.ts:20-60`.
33. Substrate `EngineEvent`/`projection.ts` carry `account.updated`/`package.updated` + branded `account/${string}`/`package/${string}`/`coin: string` keys.
34. `port-broker/service.ts:72,91,115-116,526` `PORT_KINDS` includes `'wallet'`.
35. `strategy-registry/faucet-capability-for.ts:22-39` names faucet + hardcodes `'faucet:request'` prefix.
36. `substrate/runtime/sui-move-build/` (~480 LOC) Sui-aware substrate helper not documented as exception.
37. L1 Docker labels carry router-named slots — `runtime/docker/labels.ts:42-44`, `sweep.ts:147-320` router variants.
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
