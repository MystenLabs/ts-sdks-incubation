# Stack simplification audit (non-services)

**Status:** Design proposal, read-only audit. **Author:** stack-simplification-audit subagent,
2026-05-19. **Scope:** everything OUTSIDE the service layer's `onChainArtifact` / `ChainProbe` /
`containerPrimitive` redesign captured in `notes/integration-contract-redesign.md`. That plan covers
`services/**` and the two long-lived container plugins; this one covers engine, runtime, cli,
codegen, plugin-author primitives, the test harness, dev-wallet, and cross-cutting hygiene.

This is the prescriptive companion to the recon: each finding cites file + line numbers, sketches
the redesign (not the code), and projects LoC delta and the bug class eliminated.

## 1. Executive summary

Top five highest-leverage redesigns:

| #   | Redesign                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | LoC Δ | Bug class eliminated                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | **One container adoption primitive** (`adoptOrCreateContainer`). Collapse the two `inspectContainer` + adopt/start/recreate state machines (`docker/core.ts` and `sui-build-container.ts`) into a single race-safe helper that both long-lived primitives consume. Removes the per-container TOCTOU re-implementation.                                                                                                                                                                                                                                                         | −350  | TOCTOU races B6, sui-build C/H, ambiguous "name collision vs missing" handling. Sister of integration-contract-redesign §3.3 `containerPrimitive`, but at a lower layer so plugin-author code reuses it via `Docker.run` too.            |
| E2  | **One subprocess-capture helper** (`captureCommand`). Three near-identical implementations exist (`engine/docker/core.ts::runCapturing`, `engine/sui-cli.ts::runWithCapture`, `engine/snapshot.ts::runTar`); fold them and the per-module `decodeStream` clones into one `engine/subprocess.ts`. Lets emitters / scripts / tar / docker share one error-shape.                                                                                                                                                                                                                 | −280  | "Empty stderr swallowed" regressions, `decodeStream` duplication, three slightly-different truncation policies.                                                                                                                          |
| E3  | **One CLI manifest+stack reader** (`readStackContext({stack})`). Consolidates the duplicated "discover manifest → JSON.parse → assert v5 shape → walk services" snippet in `cli/commands/fork.ts`, `cli/commands/status.ts`, `cli/commands/manifest.ts`, `playwright/web-server.ts`, `engine/router-bootstrap.ts`. Returns a typed `{manifest, sui?, wallet?, ...}` projection.                                                                                                                                                                                                | −400  | Manifest shape drift (the playwright reader's hand-rolled `services.sui.faucet` projection is already out-of-sync with the v5 schema), missing-manifest precedence inconsistency, hand-coded "is this v3 or v5?" guards in three places. |
| E4  | **Atomic-dir-swap primitive** (`stageAndSwap`). Three emitters (`services/codegen.ts`, `codegen/emitters/bindings.ts`, plus a third one fork-shaped at `services/walrus/internal.ts:429-439`) each hand-roll the staging+rename-aside+rename-in+backup-rollback dance. Centralise.                                                                                                                                                                                                                                                                                             | −250  | "Staging dir leaks on emitter failure" + "lost user `.gitignore` on swap" + "Vite HMR storm because we did rename even when contents unchanged" (the bindings cache invalidation lives in this same module).                             |
| E5  | **Registry factory consolidation** — 13 `Context.Service` class declarations + `defineRegistry` triple-destructure in `engine/registries.ts` reduce to a single `defineDevstackRegistry('Sui', SuiStateRecord)` call that produces the class, Live, publish, require, AND wires the type into `gatherManifest`'s R-channel by declaration merging. Reduces 13 class declarations + 13 Live exports + 13 manifest-grouper imports to one table. Also fixes the `RegistryNetwork` parser bug in `engine/registry.ts:147` (rejects `'mainnet-fork'` despite upsert accepting it). | −200  | "Adding a new state registry needs edits in 5 files" + the silent registry-network parse-and-drop bug for fork stacks.                                                                                                                   |

Projected net LoC delta across this audit: **−2 700 LoC** before counting test collapse. Add ~300
LoC of new substrate; net **−2 400 LoC**. See §5 for the per-area math.

## 2. By area

### 2.1 Engine — subprocess + container adoption

#### E1. Two `inspectContainer` + adopt/recreate state machines

|                |                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**      | `engine/docker/core.ts:1102` (`inspectContainer`, `decideRunAction`, `Docker.run` dispatcher), `engine/sui-build-container.ts:132` (`inspectContainer`), `:171` (`dockerStart`), `:215` (`dockerRunDetached`), `:280` (`ensureContainer`).                                                                                                                                                                                                                               |
| **Evidence**   | Two parsers for `{{.State.Running}}                                                                                                                                                                                                                                                                                                                                                                                                                                      | {{.Config.Image}}`; two adopt/start/recreate state machines, each with their own `'missing' | 'started'`/`'created' | 'name-collision'`discriminators. The`sui-build-container.ts`doc-comment Bug C + Bug H both fix races that`engine/docker/core.ts` Bug 6 also has (and the integration-contract plan duplicates the same fix in §3.3). |
| **Problem**    | Two state machines, two race-windows, two test suites for the same logic. Plugin-author primitives that want a long-lived container reach for `dockerContainer` (which goes through `Docker.run`); engine-internal primitives like sui-build reach for their own.                                                                                                                                                                                                        |
| **Redesign**   | Extract `adoptOrCreateContainer({name, image, runArgs, expectedExitCodes, lockKey})` → `Effect<{containerId, hostPorts, reused}, DockerError, Spawner>`. Both `Docker.run` and `sui-build-container.ts:ensureContainer` call it. Internal: `Synchronized.Ref<Map<name, Deferred>>` serialises concurrent adopt-or-create for the same name (the per-name lock the integration-contract plan §3.3 calls out, but at the engine layer so EVERY container goes through it). |
| **LoC Δ**      | `sui-build-container.ts` shrinks ~660 → ~350 (no own state-machine), `Docker.run`'s adopt branches collapse from ~120 → ~50. Net **−380 LoC**.                                                                                                                                                                                                                                                                                                                           |
| **Bug class**  | TOCTOU races between inspect-and-rm, "name collision" misclassification, two test suites that test the same property differently.                                                                                                                                                                                                                                                                                                                                        |
| **Sequencing** | After integration-contract-redesign §3.3 lands (which defines `containerPrimitive` semantics). E1 lifts the per-name lock down a layer so it benefits everyone.                                                                                                                                                                                                                                                                                                          |

#### E2. Three spawn-and-capture-stdout-stderr-exit implementations

|                |                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**      | `engine/docker/core.ts:1488` `runCapturing` (+ `decodeStream:1541`, `runCapturingOrFail:1517`), `engine/sui-cli.ts:439` `runWithCapture` (+ inline `decode` at `:447`), `engine/snapshot.ts:295` `runTar` (+ `decodeStream:285`).                                                                                                                                                                                                                     |
| **Evidence**   | All three: `spawner.spawn → Effect.all([decode(stdout), decode(stderr), exitCode], {concurrency: 'unbounded'})`. Three different `decodeStream` (one only handles stderr, two handle both). Three different truncation policies (`STREAM_TRUNC_BYTES=1024`, `TAR_STDERR_TRUNC=500`, `MAX_ERROR_DETAIL=600`, plus `RENDER_FIELD_TRUNC=8192` in pretty-error). Three different error-mapping wrappers (`dockerError`, `suiCliError`, `wrapSpawnError`). |
| **Problem**    | Anyone changing one truncation policy or stream-drain shape has to remember to chain it through the others. The integration-contract plan adds a fourth (`SuiCliCapture` shape pattern matches `DockerExecResult`); without a shared helper, the count grows.                                                                                                                                                                                         |
| **Redesign**   | `engine/subprocess.ts` exports `captureCommand(spawner, cmd, op, opts?)` → `Effect<{exitCode, stdout, stderr}, SubprocessError, never>` plus `captureCommandOrFail`. Caller-provided error mapping via a `{toError: (raw) => MyError}` option, OR returning a sum type. Truncation centralised in `pretty-error.ts` (already exports `RENDER_FIELD_TRUNC`).                                                                                           |
| **LoC Δ**      | `engine/docker/core.ts` − ~80, `engine/sui-cli.ts` − ~30, `engine/snapshot.ts` − ~40, new module + ~50. Net **−100 LoC** — but the win is canonicality, not LoC.                                                                                                                                                                                                                                                                                      |
| **Bug class**  | One change to "swallow empty stderr" / "show stdout on non-zero exit" / "truncate at N bytes" propagates everywhere.                                                                                                                                                                                                                                                                                                                                  |
| **Sequencing** | Independent — fan out alongside E1.                                                                                                                                                                                                                                                                                                                                                                                                                   |

#### E3. Two `inspectContainer` decoders for different field sets

|               |                                                                                                                                                                            |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | --- | ------------------------------------------------------------ | ------- |
| **Where**     | `engine/docker/core.ts:1102` parses `Running                                                                                                                               | Image | Id  | ExitCode`; `engine/sui-build-container.ts:132`parses`Running | Image`. |
| **Evidence**  | Pipe-split parsing in both, with a `parts.length !== N` defensive check. After E1 collapses the adoption flow, the single helper carries one format string and one parser. |
| **Bug class** | Subsumed by E1.                                                                                                                                                            |

#### E4. `fs.exists → fs.mkdir / fs.access → write` triple-step idiom

|               |                                                                                                                                                                                                                                                                                                          |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | 174 hits of `recursive: true` mkdir across the codebase. Notable concentrations: `engine/snapshot.ts` (~10), `engine/state-store.ts:220`, `cli/commands/_prune-stack.ts`, every codegen emitter's staging-dir prep (`services/codegen.ts:246-265`, `codegen/emitters/bindings.ts:143-162`, ~50 LoC × 2). |
| **Evidence**  | `Effect.tryPromise({ try: () => fs.mkdir(dir, {recursive: true}), catch: …})` (or the Effect-FS equivalent) repeated 30+ times, each wrapping the result in a different error class.                                                                                                                     |
| **Redesign**  | A shared `ensureDir(path, errorClass)` Effect that takes the error-mapping function once. Skip the work entirely when `fs.mkdir(recursive: true)` is idempotent (which it is — the `fs.exists` pre-check is wasteful belt-and-braces).                                                                   |
| **LoC Δ**     | −80 from removing the per-callsite try/catch wrappers; the underlying mkdirs collapse to one-liners.                                                                                                                                                                                                     |
| **Bug class** | Inconsistent error-mapping: today some callers raise `CodegenError(phase: 'write')`, some `SnapshotError`, some swallow with `Effect.ignore`. The CodegenError-vs-SnapshotError split for the same "couldn't make a directory" failure is a real footgun in pretty-error's display.                      |

#### E5. Per-stack lock variant proliferation

|               |                                                                                                                                                                                                                                                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `engine/file-lock.ts` (canonical sync helper), `engine/state-store.ts:286-371` (async variant with jittered-backoff retry loop, 90 LoC), `engine/port-allocator.ts`, `engine/sui-fork/file-lock.ts`.                                                                                                                  |
| **Evidence**  | The state-store's async variant maintains its own MAX_RECLAIM_ATTEMPTS=20 + exponential backoff + jitter loop because `tryClaimLockSync` doesn't return a "retry-with-backoff" outcome. AGENTS.md actually flags this duplication ("State-store's lock has its own Effect-platform retry loop … and stays distinct"). |
| **Redesign**  | Add `tryClaimLock(lockPath, opts)` to `file-lock.ts` with `retry?: {attempts, baseBackoffMs, growth, jitter}`. State-store calls it; the sync variant becomes a thin `Effect.runSync` of the same.                                                                                                                    |
| **LoC Δ**     | `state-store.ts` − 60, `file-lock.ts` + 40. Net **−20 LoC**.                                                                                                                                                                                                                                                          |
| **Bug class** | Two implementations of "stale lock reclaim" — the sync one uses `unlinkSync + writeFileSync(wx)`, the async one uses `fs.remove + writeFileString(wx)` plus a tempfile probe nobody actually reads (`state-store.ts:362`). Keeping them in sync over time is a footgun.                                               |

#### E6. `RegistryNetwork` parser rejects fork variants

|               |                                                                                                                                                                                                                                                                                                                                                          |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `engine/registry.ts:147-154`.                                                                                                                                                                                                                                                                                                                            |
| **Evidence**  | `parseRegistry` only accepts `'localnet'                                                                                                                                                                                                                                                                                                                 | 'testnet' | 'mainnet' | 'custom'`— fork variants get silently dropped. But`RegistryEntry`'s type union AND `upsert`'s callers DO write fork variants in (`engine/registry.ts:48-55`— and`Devstack.identityShape` for any fork stack carries them). |
| **Problem**   | A user's fork-stack registry entry never survives a round-trip — every reread filters it out. doctor/prune don't see fork stacks. The classifyEntry "active" check is then wrong because `entry.pid` was dropped with the network.                                                                                                                       |
| **Redesign**  | Either drop the closed list (let upsert's union be the schema source of truth) or extend it; same one-line fix. The audit's preferred answer: replace the hand-rolled parser with `Schema.decodeUnknownSync(RegistryFileSchema)` where `RegistryNetwork` is `Schema.Literals(...)`. Use the same Schema in the type definition so the lists can't drift. |
| **LoC Δ**     | −30 (lose the hand-rolled parser, the per-field type-check fan-out at `:139-163`).                                                                                                                                                                                                                                                                       |
| **Bug class** | Silent serialization drop. Schema-validated boundary eliminates by construction.                                                                                                                                                                                                                                                                         |

#### E7. `engine/snapshot.ts` 3-level `wrap*Error` indirection

|               |                                                                                                                                                                                                                                                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `engine/snapshot.ts:211-225` — `wrapError`, `wrapDockerError`, `wrapSpawnError` differ only in the source-error shape; all three produce a `SnapshotError({message, cause})`. The factory consumes the same 20+ `.pipe(Effect.mapError(wrap*Error(...)))` calls.                                                        |
| **Evidence**  | grep `Effect.mapError(wrap` returns 20 lines (the `snapshot.ts` body and `restore()`). The phase tracking is in the message string, not the error field — `snapshot()` and `restore()` have no `phase` discriminator on the error, despite AGENTS.md's "phase is the canonical 'which step' field" rule for new errors. |
| **Redesign**  | Replace `SnapshotError({message, cause})` with `SnapshotError({phase: Schema.Literals(SnapshotPhases), context?, cause})` and use a closed phase enum. Wrap-once-per-step via `.pipe(Effect.mapError(snapshotError('extras-tar', {tarPath})))`.                                                                         |
| **LoC Δ**     | −60 (the 20 callsites collapse from a sentence string per site to a phase symbol + context object).                                                                                                                                                                                                                     |
| **Bug class** | Pretty-error currently can't surface "which step of restore failed" because the phase is in the freeform message. The TUI's `summarizeCause` can't bucket snapshot failures.                                                                                                                                            |

### 2.2 Engine — supervisor + scheduler

#### E8. `supervisor.ts` is monolithic (2 023 LoC)

|               |                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `engine/supervisor.ts` end-to-end.                                                                                                                                                                                                                                                                                                                                                     |
| **Evidence**  | `wc -l` says 2 023. AGENTS.md's split rule (Single file ≲ 600 LoC) was relaxed for "historical primitives" but the supervisor wasn't on that list. The file is doing five jobs: layer composition (`composeStackLayer`, `composeBootstrapLayer`), watch-fiber + `compileWatchFilter`, signal handling (`installSignalRestart`), launch loop, and the top-level `defineDevstack` entry. |
| **Redesign**  | Extract: `engine/supervisor/compose.ts` (layer build), `engine/supervisor/watch.ts` (watch-fiber + filter + ownership), `engine/supervisor/signals.ts` (POSIX signal bridge), `engine/supervisor/launch-loop.ts` (the outer race between restart/shutdown/build), `engine/supervisor.ts` (the public `defineDevstack` + `DevstackHandle` + glue).                                      |
| **LoC Δ**     | The same lines, but ~5 files of 250-500 lines each. The win is reviewability, not LoC.                                                                                                                                                                                                                                                                                                 |
| **Bug class** | None directly — but the file's size makes navigating its 6 mutable `Set<string>` / `Map<string,...>` collections (the watcher's `watchedFileHashes`, `ATTACHED_FOLLOWERS`, `HEAVY_INFRA_COSTS`, etc.) hard, and they accumulated as bugs landed.                                                                                                                                       |

#### E9. `StackMember` shape is "raw layer + N optional `__` fields"

|               |                                                                                                                                                                                                                                                                                                           |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `engine/supervisor.ts:114-197` and the parallel `LayeredTag` shape in `advanced/tag.ts:220-269`. Both carry the same `__kind` / `__displayTitle` / `__watchPaths` / `__pluginName` / `__hidden` / `__upstreamKeys` / `__layers` / `__extraMembers` / `[DevstackTagBrand]` panoply, declared inline twice. |
| **Evidence**  | `provide` / `tag` build a `LayeredTag` by `Object.assign` into a Context.Service class. The supervisor reads via `(m as { __kind?: TagKind }).__kind`-style casts (`supervisor.ts:1352-1361`, `defineDevstack` seed pass). Every introspection casts.                                                     |
| **Redesign**  | Promote the `__`-field bag into a single `TagMetadata` brand carried by `Symbol.for('@devstack/tag-metadata')` on the LayeredTag. The supervisor reads `tag[TagMetadata]?.kind` once. Eliminates the duplicate field-list (any new field is added in one place) and the dozen `as { ... }` casts.         |
| **LoC Δ**     | `supervisor.ts` − 40, `tag.ts` − 30. Net **−70 LoC** but more importantly removes a class of "added the field in `LayeredTag` but the supervisor's cast didn't get updated" bugs.                                                                                                                         |
| **Bug class** | Drift between the producer (tag.ts) and consumer (supervisor.ts) field lists. Today the only field that exists on `StackMember` but NOT on `LayeredTag` is `__extraMembers` — and it works correctly only because `flattenStackMembers` defensively casts.                                                |

#### E10. `EngineHandle` interface has 22 methods, half are TUI-only

|               |                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `engine/engine.ts:40-268`.                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Evidence**  | `EngineHandleShape` declares `markAcquiring`, `markReady`, `markFailed`, `setPhase`, `markStopping`, `markStopped`, `markAllReady`, `seedTags`, `appendLog`, `appendTagLog`, `setEntryTitle`, `setHeader`, `setBuildStatus`, `awaitRestart`, `requestRestart`, `awaitShutdown`, `requestShutdown`, `markSelectiveRestart`, `registerPrimitiveScope`, `closePrimitiveScope`, `invalidateSubset`, `invalidateAll`, `_shadowCache`. |
| **Problem**   | Two cohesive responsibilities are folded into one Service: (1) TUI mutation surface (markAcquiring / markReady / setPhase / appendLog / ...) consumed by `withEngineLifecycle` in `tag.ts`; (2) supervisor lifecycle (request/awaitRestart, request/awaitShutdown, registerPrimitiveScope, invalidateSubset). The shadow-cache leak through `_shadowCache: Ref` exists only for tests.                                           |
| **Redesign**  | Split into `EngineUI` (TUI mutators, consumed by `withEngineLifecycle`) and `Supervisor` (lifecycle gates, consumed by the launch loop). Tests touch `EngineUI` only — no need to expose shadow-cache.                                                                                                                                                                                                                           |
| **LoC Δ**     | The file gets longer by ~30 (two interfaces, two layers) but every callsite gets the narrower R-channel — `withEngineLifecycle`'s requirement collapses from `EngineHandle` (~22 methods) to `EngineUI` (~10 methods).                                                                                                                                                                                                           |
| **Bug class** | Test harness can't mock EngineHandle without mocking 22 methods (or `as` casting). The current `_shadowCache` "exposed for tests" leak (`engine.ts:267`) is a smell that vanishes under the split.                                                                                                                                                                                                                               |

#### E11. `formatRestartCascade` and `ownersFor` aren't testable in isolation

|               |                                                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `engine/supervisor.ts:635-679`. Both are exported "for tests" but live inside the supervisor module that pulls in the entire compose / launch pipeline. |
| **Redesign**  | Move to `engine/watch-attribution.ts` — pure functions, no Effect. After E8 this lands naturally.                                                       |
| **LoC Δ**     | ~0 net (move not delete).                                                                                                                               |
| **Bug class** | None — this is hygiene.                                                                                                                                 |

#### E12. `engine/known-deployments.ts` carries fork-mode + live-net tables

|                                                                   |                                          |
| ----------------------------------------------------------------- | ---------------------------------------- |
| **Where**                                                         | `engine/known-deployments.ts` (441 LoC). |
| **Quick read needed.** Not deep-audited; deferred to a follow-up. |

### 2.3 Engine — observability + errors

#### E13. `prettyError` ↔ `summarizeCause` ↔ `summarizeCauseForLog` divergence

|               |                                                                                                                                                                                                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `engine/pretty-error.ts:118` (`prettyError`), `engine/engine.ts:381-411` (`summarizeCause`, `extractDeepestMessage`, `rawFailure`), `advanced/tag.ts:401` (`summarizeCauseForLog` — wraps `prettyError`).                                                                                                           |
| **Evidence**  | Three different "walk the cause chain and produce a string" implementations:<br>1. `prettyError` — multi-line, full tree.<br>2. `summarizeCause` — one-line truncated to 80 chars for the TUI row.<br>3. `summarizeCauseForLog` — actually `prettyError(cause)` already.                                            |
| **Problem**   | (2) re-implements a "find deepest .cause" walk that (1) does too. They handle non-Error-shaped causes differently (the engine's `rawFailure` pulls Fail.error directly; pretty-error's recursion does the same but elsewhere). When `Schema.TaggedErrorClass` changes its private layout, two pieces of code break. |
| **Redesign**  | `prettyError(value, {mode: 'tree' \| 'oneLine', maxLength?: number})`. One implementation; the TUI row uses `mode: 'oneLine'`.                                                                                                                                                                                      |
| **LoC Δ**     | `engine.ts:381-411` deletes (~30 LoC), `summarizeCauseForLog` deletes (1 LoC alias).                                                                                                                                                                                                                                |
| **Bug class** | "TUI row says X, full log says Y" desync — the two extractors interpret tagged-error layout differently.                                                                                                                                                                                                            |

#### E14. Phase fields are `Schema.optional(Schema.Literals(...))` everywhere

|               |                                                                                                                                                                                                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `engine/errors.ts:129, 152, 286, 304, 322, 341, 353, 367, 381` (most tagged errors).                                                                                                                                                                             |
| **Evidence**  | AGENTS.md "phase-field shape rule" says lifecycle errors should be REQUIRED phase fields. Most existing errors made `phase` optional. The new errors that landed in PGR (`SeedManifestMismatchError`, `ForkUnsupportedError`) don't carry a phase at all.        |
| **Redesign**  | Sweep through the closed-phase errors and make `phase` required. Migration is one-line per error — the catchsites already either pattern-match on `phase` (in which case the cast checked-out) or don't (in which case `phase: 'unknown' as const` covers them). |
| **LoC Δ**     | ~0 net. The win is invariant enforcement.                                                                                                                                                                                                                        |
| **Bug class** | A primitive forgetting to stamp a phase falls into pretty-error's "no qualifier" branch and the TUI row reads `WalrusError: <freeform message>` instead of `WalrusError (publish): ...`.                                                                         |

#### E15. Spans named both PascalCase and camelCase

|               |                                                                                                                                                                                                                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | AGENTS.md prescribes PascalCase (`SuiBoot`, `WalrusPublishPackage`). Grep finds 11 violations: `manifest.write`, `manifest.finalize`, `manifest.watch`, `git-fetch`, `Devstack.watch`, `Devstack.signalRestart`, `StateStore.put`, `StateStore.remove`, `SuiCli.buildMove`, `SuiCli.scrubCachedMoveLocks`, `Codegen(${name})` interpolated. |
| **Redesign**  | Sweep — rename to PascalCase. Mostly grep+sed. The `Devstack.*` cluster reads strangely because the `Devstack.` prefix duplicates the service name annotation; drop the prefix.                                                                                                                                                             |
| **LoC Δ**     | ~0 (renames).                                                                                                                                                                                                                                                                                                                               |
| **Bug class** | Inconsistent grouping in OTLP traces (`SuiBoot` lands one row but `git-fetch` lands another).                                                                                                                                                                                                                                               |

### 2.4 Runtime — manifest + endpoints

#### E16. `runtime/service.ts` `groupApp` / `groupSui` / `groupDeepbook` are 5 hand-rolled projections — DONE

|               |                                                                                                                                                                                                                                                                                                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `runtime/service.ts:99-223`.                                                                                                                                                                                                                                                                                                                                      |
| **Evidence**  | 5 `groupX` functions, each pulling fields out of a `RegistryRecord` and a flat `EndpointRecord[]`, projecting into a `ServiceManifest` shape. The `groupSui` body even iterates endpoint names via `manifestLeafUnder(e.name, 'services.sui')` — which already proves the projection is data-driven.                                                              |
| **Redesign**  | A `defineServiceProjection` API:<br>`defineServiceProjection({name: 'sui', stateRegistry: SuiStateRegistry, endpoints: ['sui-rpc', 'sui-faucet', 'sui-graphql'], project: (state, endpoints) => SuiManifest})`. The 5 projections become 5 declarations of ~10 lines each; `gatherManifest`'s 13 `yield* X` calls collapse to one loop over the projection table. |
| **LoC Δ**     | `runtime/service.ts` 378 → ~200 (−180).                                                                                                                                                                                                                                                                                                                           |
| **Bug class** | "Added new field to state registry, forgot to surface in grouper" (the deepbook indexer/server fields had this lag for two PRs).                                                                                                                                                                                                                                  |
| **Status**    | DONE 2026-05-19. Helper landed at `engine/service-projection.ts` (54 LoC); single-registry services migrated: `sui`, `seal`, `walrus`, `pyth`, `postgres` (5 of 5). Each becomes a `defineServiceProjection({name, registry, project})` entry consuming a thin `ProjectionContext` (`{endpoints, network}`). The helper absorbs `yield* Registry → snapshot → last-record` per service, dropping ~24 LoC of state-snapshot lines from `gatherManifest`. **Deepbook stays group-style** (4 registries); a follow-up multi-registry variant collapses it. `groupApp` stays as a free function (no state registry). LoC headline came in flat (`service.ts` 378→350, helper +54; net +27) — the structural win is "adding a service is 1 table entry, not 4 edits". |

#### E17. `runtime/manifest-emit.ts` slow-tick re-snapshot + final flush

|               |                                                                                                                                                                                                                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `runtime/manifest-emit.ts:75-166`.                                                                                                                                                                                                                                                             |
| **Evidence**  | The emitter writes the manifest THREE times per cycle: eager at acquire, every 500ms during the lifetime, and on finalize. Default tick is 500ms; over a 60s dev session that's 120 writes for a stack that's static after the first second.                                                   |
| **Problem**   | Tax on Vite's watcher + on the disk + on test parallelism (the `writeFileAtomicIfChanged` shortcut catches identical bodies but the rename still touches mtime in some implementations). The slow-tick exists because some primitives publish their endpoint after the manifest's eager write. |
| **Redesign**  | Subscribe to registry mutations (`RegistryShape` gains a `subscribe(): Stream<unit>`) so the emit only fires when a registry actually changed. Drop the slow-tick and the final flush (the on-mutate emit already captures the late writes).                                                   |
| **LoC Δ**     | `manifest-emit.ts` − 30; per-registry +5 LoC (the subscribe Stream).                                                                                                                                                                                                                           |
| **Bug class** | "Manifest grew stale in the 500ms window between two late registers" — today the second register's value lands in the next tick, but if shutdown wins the race, it doesn't. The mutate-driven path is correct by construction.                                                                 |

#### E18. `runtime/discover-manifest.ts` walk-up — best-effort + required-true split

|               |                                                                                                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `runtime/discover-manifest.ts:73-133`.                                                                                                                                       |
| **Evidence**  | A small file (134 LoC) but the precedence ladder (env → override → walk-up) is implemented twice (once for each `required` branch).                                          |
| **Redesign**  | Refactor as `const candidates = [envOverride, override, ...walkUp(cwd)].filter(p => p && existsSync(p))`; first hit wins. The "required: true" throw is one line at the end. |
| **LoC Δ**     | −30.                                                                                                                                                                         |
| **Bug class** | Two slightly-different precedence implementations.                                                                                                                           |

### 2.5 CLI

#### E19. Three CLI commands re-implement "read v5 manifest → assert shape → pull `services.sui.rpc.url`"

|               |                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `cli/commands/fork.ts:80-105` (`readManifestSuiBlock`), `cli/commands/status.ts:13-79`, `playwright/web-server.ts:90-189` (`resolveEndpoint` — pulls flat endpoint name from nested manifest).                                                                                                                                                                                           |
| **Evidence**  | Each one re-parses `JSON.parse(readFileSync(...))`, asserts the shape (some with "is this v3 or v5?" defensive logic — playwright's is at `web-server.ts:144`), and then walks the projection. The playwright reader maintains its own flat-endpoint-name to v5-path lookup table at `:166-180` — a parallel implementation of the `manifestLeafUnder` logic in `runtime/service.ts:81`. |
| **Redesign**  | `cli/manifest.ts::readManifest(stack)` → `Effect<Manifest, ManifestDiscoveryError>` (or its sync sibling). Plus `manifest.lookupEndpoint(name) → string                                                                                                                                                                                                                                  | undefined`derived from the same`defineEndpoint(...)` declarations the supervisor consults — meaning the playwright reader and the fork CLI use the same projection. |
| **LoC Δ**     | `playwright/web-server.ts` − 90, `cli/commands/fork.ts` − 30, `cli/commands/status.ts` − 30, new module + 60. Net **−90 LoC**.                                                                                                                                                                                                                                                           |
| **Bug class** | Manifest shape drift — when v5 ships v6, all three readers need updates; today the playwright reader already lags (it carries v3 fallback code).                                                                                                                                                                                                                                         |

#### E20. `cli/commands/fork.ts` is 917 LoC; subcommands repeat the `resolveForkRuntimeCtx → makeForkClient` boilerplate

|               |                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `cli/commands/fork.ts:114-157`, `:171-249` (status), `:256-310` (advance-clock), `:317-...` (advance-checkpoint), `:...` (replay-to), `:...` (seed), `:...` (cache prune).                                                                                                                                                                                                                                 |
| **Evidence**  | Every subcommand body opens with:<br>`\nconst resolved = yield* resolveStack(fs, path, stack);\nconst ctx = yield* resolveForkRuntimeCtx(resolved);\nconst client = makeForkClient(ctx);\n`<br>followed by an `Effect.tryPromise({ try: () => client.forkingService.X(...).response, catch: cause => new Error(...) }).pipe(Effect.catch(...failAlreadyReported(...)))`. Six subcommands, six near-copies. |
| **Redesign**  | `forkSubcommand({op: 'advance-clock', args: {duration: numberArg}, run: (ctx, args) => Effect})` factory. The 6 commands declare in a ~30-line table.                                                                                                                                                                                                                                                      |
| **LoC Δ**     | `fork.ts` 917 → ~500 (−417).                                                                                                                                                                                                                                                                                                                                                                               |
| **Bug class** | Inconsistent error reporting (some subcommands `failAlreadyReported`, some throw). Each subcommand's catch-mapper string drifts.                                                                                                                                                                                                                                                                           |

#### E21. `cli/commands/doctor.ts` is 723 LoC mixing 4 check types

|               |                                                                                                                                                                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `cli/commands/doctor.ts` — `checkDocker`, `checkSui`, `checkPort`, fork stack walks, inventory.                                                                                                                                                                                                   |
| **Redesign**  | Each check is an `interface Check { name, ok, required, detail? }` producer. Extract a table of `[{name, run: Effect<Check>}]` and the orchestrator becomes a `forEach({concurrency: 'unbounded'})`. The 4 inline implementations move into individual files under `cli/commands/doctor/checks/`. |
| **LoC Δ**     | ~0 net (refactor not delete), but each check becomes individually testable.                                                                                                                                                                                                                       |
| **Bug class** | None directly; the file is a navigability tax.                                                                                                                                                                                                                                                    |

#### E22. `cli/commands/prune.ts` `Mode` resolver vs the equivalent in `wipe.ts`

|               |                                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `cli/commands/prune.ts:144-173` (`resolveMode`), `cli/commands/wipe.ts:131-145` (the flag mutual-exclusion check).                                                              |
| **Evidence**  | Two CLIs each carry their own "validate the flag combination is sensible" logic, expressed as imperative if-branches.                                                           |
| **Redesign**  | Use `Effect.flagsValidated({ atMostOne: [...], requiresOne: [...] })` if exists, OR a tiny `cli/flag-validation.ts` helper. Each command's mode resolution becomes declarative. |
| **LoC Δ**     | −40 across the two commands.                                                                                                                                                    |
| **Bug class** | Mistake about flag precedence (prune's `--list > target > --repo-gone > --all-orphans > interactive` cascade) is currently encoded once, easy to miss when adding a new mode.   |

#### E23. `cli/loaders.ts` `requireLaunchEffect` + `requireLayer` duplicate-validate

|               |                                                                                                                                                                 |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **Where**     | `cli/loaders.ts:56-95`. Both validators throw the same `ConfigLoadError({phase: 'validate', configPath, expected, message})` with slightly-different sentences. |
| **Redesign**  | One `validateDevstackExport(configPath, mod, {needs: 'launchEffect'                                                                                             | 'layer'})`. The two callsites become one-liners. |
| **LoC Δ**     | −20.                                                                                                                                                            |
| **Bug class** | None — hygiene.                                                                                                                                                 |

### 2.6 Codegen

#### E24. `services/codegen.ts` and `codegen/emitters/bindings.ts` share atomic dir-swap

|               |                                                                                                                                                                                                                                                                                                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `services/codegen.ts:242-383` (the outer atomic swap around staging dir), `codegen/emitters/bindings.ts:141-318` (bindings' OWN atomic swap inside the outer one).                                                                                                                                                                                                    |
| **Evidence**  | Both implement: random-suffix staging → `fs.rm(staging, ...)` → `fs.mkdir(staging, ...)` → run emit body → `fs.rename(outputDir, backup)` → `fs.rename(staging, outputDir)` → `fs.rm(backup, ...)`. Bindings does it again INSIDE the codegen outer swap because bindings' content addressed cache invariant is per-target (each Move package needs its own promote). |
| **Problem**   | Two implementations of the same primitive; the failure-recovery branches differ (codegen's restores the backup, bindings' just `fs.rm`s the staging). The outer codegen swap also handles `.gitignore` snapshot/restore, which the bindings inner swap doesn't need.                                                                                                  |
| **Redesign**  | `codegen/atomic-dir.ts::stageAndSwap({outputDir, prepareStaging, preserveOnSwap?})` returns an Effect that handles random suffix + staging + backup + rollback + the optional `.gitignore` snapshot. Bindings opts in with `preserveOnSwap: []` (nothing to preserve); codegen opts in with `preserveOnSwap: ['.gitignore']`.                                         |
| **LoC Δ**     | `services/codegen.ts` − 100, `codegen/emitters/bindings.ts` − 80, new module + 80. Net **−100 LoC**.                                                                                                                                                                                                                                                                  |
| **Bug class** | The "backup not removed on success" leak (`services/codegen.ts:381` only removes when outputExists was true — but tomato-tomato edge cases exist), the "user's `.gitignore` lost on swap" (codegen handles; bindings doesn't, even though it could).                                                                                                                  |

#### E25. `codegen/helpers.ts::writeIfChanged` always does an explicit chmod

|               |                                                                                                                                                                                                             |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `codegen/helpers.ts:23-40`.                                                                                                                                                                                 |
| **Evidence**  | Comments admit the explicit chmod is "Cheap on warm paths (one syscall)". But `writeFileAtomicIfChanged` already chmods on writes — the extra chmod is for the no-op case (existing file with wrong perms). |
| **Redesign**  | Drop the explicit chmod. If perms-drift is a real risk, make `writeFileAtomicIfChanged` itself responsible for "chmod always if file exists; chmod on create if it doesn't"; centralise the policy.         |
| **LoC Δ**     | −10.                                                                                                                                                                                                        |
| **Bug class** | Tiny but real: every codegen emit pass touches N file atimes via the chmod. Removing it stops one source of Vite HMR noise.                                                                                 |

#### E26. Each emitter's `runEmit` is wrapped in a 5-deep `Effect.tryPromise` lattice — DONE

|               |                                                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Where**     | `codegen/emitters/bindings.ts:143-318`. Every fs op is `Effect.tryPromise({ try, catch: cause => new CodegenError({...}) })`. 20+ instances.                                               |
| **Redesign**  | A `fsOp<T>(op: string, body: () => Promise<T>) => Effect<T, CodegenError>` curry. Each callsite becomes one line.                                                                          |
| **LoC Δ**     | `bindings.ts` − 60, `services/codegen.ts` − 80. Net **−140 LoC**.                                                                                                                          |
| **Bug class** | The 20 `catch:` bodies all do `stringifyCause(cause)` and rebuild a CodegenError; if a new field is added to CodegenError (like AGENTS.md's `phase:` requirement), 20 sites need touching. |
| **Status**    | DONE 2026-05-19. Helper landed at `codegen/helpers.ts::fsOp({emitter, phase, message}, () => Promise<T>) → Effect<T, CodegenError>` (+20 LoC including JSDoc); auto-appends `stringifyCause(cause)` to the message and threads `cause` into the structured error. Callsites consolidated: `bindings.ts` `generateFromPackageSummary` tryPromise, `services/codegen.ts::writeGitignore`, and `codegen/helpers.ts::writeIfChanged` itself (now a one-line `fsOp` wrapper). Pre-existing emit count was lower than the audit headlined (~6 sites across both files, not 20) so the headline `−140` overshoots; actual non-test source delta is `bindings.ts` −3, `services/codegen.ts` −7, `helpers.ts` +20 (helper), net **+10 LoC** but **−10 LoC at callsites**. The structural win — "add a field to CodegenError, change one place" — is realised. The `fs.access` probe and `Effect.promise(maxSourceMtime)` sites intentionally still bypass `fsOp` because their callers convert failure into a falsey value in the success channel rather than raising CodegenError. |

#### E27. `bindings.ts` has a private `lastEmitFingerprint` module Map — DONE

|               |                                                                                                                                                                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `codegen/emitters/bindings.ts:40`.                                                                                                                                                                                                                             |
| **Evidence**  | A module-local `Map<string, string>` cache survives across test runs and across hot-restart cycles within one process. Comments admit the scope is intentional.                                                                                                |
| **Problem**   | Two issues. (1) Test isolation — the next test sees a fingerprint from the previous test's source-tree mtime. (2) The fingerprint scheme is a parallel implementation of `withCache` (cache key + verify-via-source-mtime).                                    |
| **Redesign**  | Use `withCache(spec)` from `engine/cache.ts` for the bindings short-circuit. Cache key = source-tree fingerprint; verify = same mtime walk. The module-local Map disappears; the cache lives in `StateStore`, where every other content-addressed cache lives. |
| **LoC Δ**     | `bindings.ts` − 80. The fingerprint walk stays (it's the cache-key input), but its consumer is `withCache`.                                                                                                                                                    |
| **Bug class** | (1) test cross-talk via module-global state, (2) the cache invalidation reason (mtime-changed vs source-tree-grew) is harder to debug from a Map than from `withCache`'s structured log lines.                                                                 |
| **Status**    | DONE 2026-05-19, scaled-down redesign. Took the lighter fix: replaced the module-global `lastEmitFingerprint` Map with a closure-scoped `Map<string,string>` constructed inside `BindingsEmitter()`. This kills bug class (1) — each `BindingsEmitter()` instance gets its own cache; tests can no longer cross-talk through it (pinned via a new `it.live` "two BindingsEmitter() instances do not share fingerprint state" case). `withCache` was rejected because it would (a) drag in `StateStore` as a new dependency on a previously-pure emitter, (b) persist the short-circuit to disk where a corrupted bindings dir + matching mtimes could deadlock the cache, and (c) require an in-memory `StateStore` stub in every bindings unit test. The source-mtime probe inside `computeFingerprint` already IS the verify probe; lifting it into `withCache` would not add invalidation power. `bindings.ts` delta: −3 LoC source; the cache stash collapses to `cache.set(outputAbs, fingerprint)`. Independence from E26: orthogonal — `fsOp` consolidation does not touch the fingerprint store. |

#### E28. `services/codegen.ts` writes `.gitignore` even on emitter failure

|               |                                                                                                                                                                                                                                                                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `services/codegen.ts:393` runs `writeGitignore` after the atomic swap.                                                                                                                                                                                                                                                                 |
| **Evidence**  | The swap order: stage → emit → swap outputDir aside → rename staging in → drop backup → write .gitignore. On emitter failure the staging dir is removed and outputDir is untouched. But the `writeGitignore` lives outside the `tapError` cleanup, so a write that races a partial earlier failure can re-write the user's .gitignore. |
| **Redesign**  | Move into the staging dir BEFORE the swap, so it rides the rename.                                                                                                                                                                                                                                                                     |
| **LoC Δ**     | ~0.                                                                                                                                                                                                                                                                                                                                    |
| **Bug class** | Eventual-consistency footgun if a user manually edits the .gitignore mid-cycle.                                                                                                                                                                                                                                                        |

### 2.7 Plugin-author primitives

#### E29. `dockerContainer` accepts `optionsInput` as static OR builder

|               |                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `advanced/plugin-author/docker-container.ts:480-530`.                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Evidence**  | `DockerContainerOptionsInput = DockerContainerOptions                                                                                                                                                                                                                                                                                                                                                                                                               | (identity) => DockerContainerOptions`. Both shapes are present because some options need identity-derived values (per-stack network names). |
| **Problem**   | The builder form forces `staticImage` to be passed separately (`docker-container.ts:529`) because the image MUST resolve at factory time. Two-arg callsites are inelegant. Internal `buildContainerInternals` calls `optsIsBuilder ? optionsInput(identity) : optionsInput` and has to throw a runtime TypeError if the contract is violated.                                                                                                                       |
| **Redesign**  | Have ALL primitives accept the builder form (drop the static branch) — they get a free `identity` value, the image is always pulled out of the resolved options, and the runtime TypeError disappears. Static callers add `() => ({...})` wrappers (~3 chars overhead). The image-build layer wraps around the resulting container layer regardless of how the image was specified, with the image source captured at factory time via a separate `image` argument. |
| **LoC Δ**     | −30 in `docker-container.ts` (the dual-path is gone), +1 char per callsite (a `() =>`).                                                                                                                                                                                                                                                                                                                                                                             |
| **Bug class** | The "passed a builder without staticImage" TypeError lands at acquire time, not at type-check time. The unified form makes the failure compile-time.                                                                                                                                                                                                                                                                                                                |

#### E30. `containerPrimitive` (integration-contract §3.3) should replace `dockerContainer`'s tag form

|               |                                                                                                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `advanced/plugin-author/docker-container.ts:520-555` (`dockerContainer`) vs `advanced/plugin-author/docker-container.ts:579-592` (`runDockerContainer`).                                                            |
| **Evidence**  | The two surfaces (tag-form + inline-Effect form) share `buildContainerInternals` but each has its own export. The integration-contract plan's `containerPrimitive` (§3.3) duplicates the tag-form for a third time. |
| **Redesign**  | Have the integration-contract `containerPrimitive` REPLACE `dockerContainer` (the tag-form). `runDockerContainer` stays as the inline form for primitives that need it. The result: one spec shape covers both.     |
| **LoC Δ**     | The plan's new helper subsumes ~250 LoC from the current `dockerContainer`.                                                                                                                                         |
| **Bug class** | Subsumed by integration-contract §3.3.                                                                                                                                                                              |

#### E31. `git-fetch.ts` inlines its own content-hash

|               |                                                                                                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `advanced/plugin-author/git-fetch.ts:159`.                                                                                                                              |
| **Evidence**  | `crypto.createHash('sha256').update(repo).update(ref).digest('hex').slice(0, 12)`. AGENTS.md's table prescribes `engine/content-hash.ts::contentHash` for exactly this. |
| **Redesign**  | Replace with `contentHash([repo, ref].join('\0'), { length: 12 })`.                                                                                                     |
| **LoC Δ**     | −3.                                                                                                                                                                     |
| **Bug class** | Drift: if `contentHash` ever moves to BLAKE3 / changes truncation policy, the cache keys for cross-callers won't line up.                                               |

### 2.8 Test harness

#### E32. `playwright/web-server.ts::resolveEndpoint` cold-start fallback is correctness-fragile

> Title corrected 2026-05-19 — the fallback is NOT dead; it's the normal cold-start
> path (playwright.config.ts loads before the supervisor writes the manifest).
> Removal would break every example's Playwright run. Tracked redesign is an
> opt-in `webServer({ fallback: 'conventional' | 'fail' })` switch (~+5 LoC) so
> CI can opt into fail-fast while local-dev keeps the convenient cold-start.


|               |                                                                                                                                                                                                                                                                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `playwright/web-server.ts:90-189`.                                                                                                                                                                                                                                                                                                     |
| **Evidence**  | When the manifest doesn't exist yet, `resolveEndpoint` falls back to `conventionalUrl(endpoint)`. The fallback exists because `playwright.config.ts` runs at config-load time, BEFORE the spawned `pnpm dev` writes the manifest.                                                                                                      |
| **Problem**   | The fallback path is correctness-fragile: if the supervisor binds different ports than the conventional defaults (port conflict → auto-allocate), the fallback URL is wrong and playwright's `webServer.url` waits on a port nothing is listening on.                                                                                  |
| **Redesign**  | After E19's `readManifest` consolidation, the playwright path can defer to a single async-discovered manifest read, OR the supervisor's webServer launch path can write a minimal "pre-manifest" sidecar (`.devstack/stacks/<stack>/.url-hints.json`) with the actual port allocations. Either eliminates the fallback's failure mode. |
| **LoC Δ**     | ~−30 if the fallback goes away.                                                                                                                                                                                                                                                                                                        |
| **Bug class** | "Playwright timeout because port mismatch" — happens in CI when the runner has a busy port.                                                                                                                                                                                                                                            |

#### E33. `vitest/define-config.ts` is 36 LoC and provides only `defineDevstackVitestConfig`

|               |                                                                                                                                                                                   |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `vitest/define-config.ts`.                                                                                                                                                        |
| **Evidence**  | The whole `vitest/` directory is two files, total ~100 LoC. The `defineDevstackVitestConfig` wrapper passes ~5 default opts through.                                              |
| **Redesign**  | Inline into the README. Apps that want it can copy-paste the 10-line config. The wrapper currently adds zero value over `defineConfig({test: {...mydefaults, ...options.test}})`. |
| **LoC Δ**     | −100 (delete the directory).                                                                                                                                                      |
| **Bug class** | None — the wrapper exists because the playwright counterpart exists; doesn't mean it has to.                                                                                      |

### 2.9 Dev-wallet

#### E34. UI components total ~9 KLoC across 20 files; the 5 largest (~3 KLoC) duplicate Lit styles

|               |                                                                                                                                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `packages/dev-wallet/src/ui/dev-wallet-settings.ts` (692), `dev-wallet-signing.ts` (662), `dev-wallet-new-account.ts` (662), `dev-wallet-fork-panel.ts` (609), `dev-wallet-accounts.ts` (609).     |
| **Evidence**  | Each file has its own `static override styles = [sharedStyles, X, css\`...\`]` block, each ~80-200 LoC of CSS. Patterns repeat: section-header layout, address-row layout, copyable-detail styles. |
| **Redesign**  | Extract the per-pattern CSS into `styles.ts` (which already exists at 252 LoC) as named exports (`addressRowStyles`, `sectionListStyles`, etc.). Each component imports the patterns it needs.     |
| **LoC Δ**     | Estimated **−800 LoC** across the 5 biggest UI files; +200 in `styles.ts`. Net **−600 LoC**.                                                                                                       |
| **Bug class** | "Updated theme variable; only 4 of 6 places picked it up" — design drift between rows.                                                                                                             |

#### E35. `wallet-controller.ts` is 431 LoC delegating between panel + standalone

|               |                                                                                                                                                                                                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Where**     | `packages/dev-wallet/src/ui/wallet-controller.ts`.                                                                                                                                                                                                                                                                       |
| **Evidence**  | The controller exists to share logic between `dev-wallet-panel` and `dev-wallet-standalone`. The README says so. But each shareable piece (renderSigningModal, renderConnectPicker, renderTabContent, renderTabBar, renderNetworkBadge) is a thin delegation — the actual state still lives in fields on the controller. |
| **Redesign**  | Lit ReactiveController is the right pattern for shared state. The problem is most controller methods are render shims that should live on the host element. Keep state + subscriptions on the controller; move render methods to a mixin or to a base class extended by both panel + standalone.                         |
| **LoC Δ**     | ~−100 (the render shims fold into the host).                                                                                                                                                                                                                                                                             |
| **Bug class** | Today the panel and the standalone each forward properties to the controller in their `willUpdate`. A field added to one and not the other silently no-ops.                                                                                                                                                              |

#### E36. `adapters/devstack-adapter.ts`, `adapters/remote-cli-adapter.ts`, `adapters/fork-relay.ts` share an Adapter contract that isn't explicit

|               |                                                                                                                                                                                                                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | The three adapter files (334, 388, 340 LoC).                                                                                                                                                                                                                                            |
| **Evidence**  | Each adapter implements signing + account-list against a different backend (devstack manifest URL, remote CLI WebSocket, fork-mode admin RPC). The shared contract is informal — each one re-derives `getAccount`, `sign*`, `getBalance`, etc., with slightly-different error handling. |
| **Redesign**  | Define `interface WalletAdapter` (one shape; the existing `BaseSignerAdapter` is close but only covers signing) and have each concrete adapter implement it. Move shared helpers (account-by-address lookup, error-message formatting) into `adapters/_shared.ts`.                      |
| **LoC Δ**     | −150 across the three adapter files.                                                                                                                                                                                                                                                    |
| **Bug class** | New adapter authors copy-paste from an existing one and pick up its specific error-handling quirks; a typed contract makes the surface explicit.                                                                                                                                        |

### 2.10 Cross-cutting

#### E37. 18 distinct `DEVSTACK_*` env vars; no single registry

|               |                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `DEVSTACK_APP_DIR`, `DEVSTACK_STATE_DIR`, `DEVSTACK_STACK`, `DEVSTACK_NETWORK`, `DEVSTACK_MANIFEST_PATH`, `DEVSTACK_REGISTRY_FILE`, `DEVSTACK_ROUTER_DYNAMIC_DIR`, `DEVSTACK_PORT_LOCK_DIR`, `DEVSTACK_SUI_FORK_CACHE_DIR`, `DEVSTACK_KEEP_ONESHOT`, `DEVSTACK_NO_ROUTER`, `DEVSTACK_LOG_LEVEL`, `DEVSTACK_WARN_MISSING_UPSTREAM`, `DEVSTACK_STRICT_UPSTREAM` (planned), `DEVSTACK_INTEGRATION_TESTS`, `DEVSTACK_DIRECT_PORTS` (one mention in docker/core.ts), `PLAYWRIGHT`. |
| **Evidence**  | 18 module-level `process.env.DEVSTACK_X ?? default` patterns spread across 14 files. No central documentation.                                                                                                                                                                                                                                                                                                                                                                |
| **Problem**   | Each env var has different precedence rules vis-a-vis flags / config; documentation is in JSDoc comments scattered across the codebase. A user looking for "how do I override the state dir from CI" reads three different stories depending on where they grep.                                                                                                                                                                                                              |
| **Redesign**  | `engine/env.ts` exporting a typed `DevstackEnv` interface and one `readEnv()` Effect that surfaces all overrides in one place, with precedence documented at the top. Each consumer reaches for `env.stateDir` instead of `process.env.DEVSTACK_STATE_DIR`.                                                                                                                                                                                                                   |
| **LoC Δ**     | ~0 net (replace inline reads with helper calls), but each module's surface area shrinks.                                                                                                                                                                                                                                                                                                                                                                                      |
| **Bug class** | "What env vars does devstack respect?" — today the only answer is `grep`. A canonical registry doubles as the README's env-var reference.                                                                                                                                                                                                                                                                                                                                     |

#### E38. `Schema.optional(Schema.Defect)` on every cause field

|               |                                                                                                                                                                                              |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `engine/errors.ts` `cause: Schema.optional(Schema.Defect)` on 11 error classes.                                                                                                              |
| **Evidence**  | Every tagged error has the same `cause` field. Pretty-error walks it. It's required boilerplate.                                                                                             |
| **Redesign**  | A `defineDevstackError(name, fields)` helper that stamps `cause: Schema.optional(Schema.Defect)` automatically. Removes 11 lines × 1 = 11 LoC, but more importantly enforces the convention. |
| **LoC Δ**     | ~−10.                                                                                                                                                                                        |
| **Bug class** | None — convention enforcement.                                                                                                                                                               |

#### E39. Two `_tag` discriminator patterns: `Schema.TaggedErrorClass` vs `Data.TaggedError`

|              |                                                                                                           |
| ------------ | --------------------------------------------------------------------------------------------------------- |
| **Where**    | AGENTS.md says use `Schema.TaggedErrorClass`; `Data.TaggedError` still appears in codegen + faucet + CLI. |
| **Evidence** | grep `Data.TaggedError` finds ~6 sites.                                                                   |
| **Redesign** | Sweep — migrate to `Schema.TaggedErrorClass`. AGENTS.md already mandates; this is a follow-up of E14.     |
| **LoC Δ**    | ~0.                                                                                                       |

#### E40. Manifest schema lives in two parallel TS interfaces + Effect.Schema declarations

|               |                                                                                                                                                                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `runtime/manifest-schema.ts` has both `SuiManifest = Schema.Struct({...})` and `type SuiManifest = typeof SuiManifest.Type` (and the equivalent for every leaf).                                                                              |
| **Evidence**  | The `typeof X.Type` pattern is correct Effect; no LoC win. But the parallel TypeScript interfaces in `engine/registries.ts` for the `*StateRecord` types are HAND-MAINTAINED to mirror the Schema-described shape.                            |
| **Redesign**  | Define each `*StateRecord` via `Schema.Struct(...)` (with `typeof ... .Type` for the TS type), so the registry shape is Schema-validated at publish time. AGENTS.md prescribes this for the manifest already; do the same for the registries. |
| **LoC Δ**     | ~0 net (replace interfaces with Schema declarations) but enables Schema-validated registry boundaries — a new field added to a publish call wouldn't compile if the Schema doesn't carry it.                                                  |
| **Bug class** | The CoinRecord field grew several times this year (added `symbol`, `displayName`, `iconUrl`, `treasuryCapId`, etc.) — each addition had a "is this in the manifest schema too?" review check that could have been a Schema-compile-error.     |

#### E41. JSDoc on public surface vs `internal.ts` rule

|              |                                                                                                                                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Where**    | AGENTS.md's `internal.ts` rule says "Internal in a filename always means private to /advanced or below". Two `/services/X/internal.ts` files exist (seal: 1 243, walrus: 953) past the 600 LoC threshold that should have triggered a split.                       |
| **Evidence** | The integration-contract plan covers both. This audit notes only that the same pattern applies to engine: `engine/sui-build-container.ts` (662 LoC), `engine/snapshot.ts` (900 LoC), `engine/supervisor.ts` (2 023 LoC) all violate the 600-LoC default rule.      |
| **Redesign** | Apply E8 (supervisor split) and the equivalent for snapshot.ts (it has 4 clear sections: pre-cleanup, save, restore, list) and sui-build-container.ts (inspect, dockerStart, dockerRunDetached, ensureContainer, runBuild, runSummary are independently testable). |
| **LoC Δ**    | ~0 net.                                                                                                                                                                                                                                                            |

## 3. Recommended sequencing

```
                          ┌─ E2 (subprocess capture) ────┐
                          ├─ E4 (ensureDir helper) ──────┤
                          ├─ E6 (Registry schema parse) ─┤
   Independent layer ─────┼─ E15 (spans PascalCase) ─────┼─── (parallel fan-out)
                          ├─ E25, E28 (codegen hygiene) ─┤
                          ├─ E31 (git-fetch contentHash)─┤
                          └─ E33 (drop vitest wrapper) ──┘

   Cross-cutting + foundation
       E37 (env.ts) ──── E13 (one prettyError) ──── E14 (required phase) ── E38, E39 (error stamp)

   Manifest + registry shape
       E40 (Schema all registries) ── E5 (defineRegistry consolidation) ── E16 (projection table) ── E17 (mutate-driven emit)

   CLI consolidation
       E19 (readStackContext) ──── E20 (forkSubcommand factory) ──── E21 (doctor split) ──── E23 (loaders)

   Engine refactor
       E1 (adoptOrCreateContainer) ──── after integration-contract §3.3 lands
       E8 (supervisor split) ──── after E10 (EngineHandle split) lands
       E10 (EngineHandle split) ──── independent
       E9 (TagMetadata bag) ──── depends on E10
       E11 (watch-attribution extract) ──── follows E8

   Codegen
       E24 (atomic-dir primitive) ──── independent
       E26 (fsOp helper) ──── after E2
       E27 (bindings withCache) ──── after E24

   Plugin-author
       E29 (drop builder/static split) ──── independent
       E30 (containerPrimitive → dockerContainer) ──── coupled with integration-contract §3.3

   Test harness
       E32 (playwright fallback removal) ──── after E19

   Dev-wallet
       E34 (CSS extraction) ──── independent
       E35 (controller render extraction) ──── independent
       E36 (WalletAdapter contract) ──── independent
```

The fastest payoff cluster is "Cross-cutting" + "CLI consolidation" — both fan out to independent
subagents and individually-deliverable refactors. The "Engine refactor" cluster gates on the
integration-contract plan landing first (so we don't fight on `containerPrimitive`'s shape).

## 4. Out of scope (consciously not chased)

- **`engine/docker/inventory.ts` shape.** 895 LoC of label-driven docker introspection. Big file,
  but the `RawContainer` / `RawNetwork` / `RawVolume` parsers are correct as-is; refactoring them
  buys hygiene only.
- **`engine/docker/router.ts` (file-provider materialization).** Hand-rolled YAML write + finalizer
  is necessary because traefik's docker-provider races the per-stack network attach
  (`docker-container.ts:1284` documents it). A redesign would need either a different router or a
  different attach order; both are out of audit scope.
- **`engine/sui-fork/*`.** The fork integration plan governs this; the per-data-dir lock is already
  shared via `engine/file-lock.ts` so the duplication risk is bounded.
- **The composite-tag (`composeLayers`) shape vs single-tag rule.** The integration-contract plan
  changes how composites work (via `onChainArtifact`); the substrate shape (`primary + projections`)
  is preserved across the change. Touching `composeLayers` now would conflict.
- **`engine/dep-graph.ts`.** 362 LoC of pure data + cycle detection + topo-levels. Already cleanly
  factored; no obvious win.
- **`engine/cache.ts` shape itself.** The contract is good. The win is in ADOPTION
  (integration-contract plan), not shape changes here.
- **The `RegistryShape<T>` API design.** The integration-contract plan explores
  `register(): subscribe`-style additions; defer to that work.
- **`tui/*`.** Out of scope per the request scope; covered separately.

## 5. LoC math summary

| Cluster                           |        Δ LoC |
| --------------------------------- | -----------: |
| E1 (adoptOrCreateContainer)       |         −380 |
| E2 (captureCommand)               |         −100 |
| E4 (ensureDir)                    |          −80 |
| E5 (registry consolidation)       |         −200 |
| E6 (registry-network parser)      |          −30 |
| E7 (snapshot phases)              |          −60 |
| E8 (supervisor split)             | 0 (refactor) |
| E9 (TagMetadata)                  |          −70 |
| E10 (EngineHandle split)          |          +30 |
| E13 (one prettyError)             |          −30 |
| E16 (manifest projection table)   |         −180 (landed ~flat; structural win — see §2.4 E16 status) |
| E17 (mutate-driven manifest emit) |          −30 |
| E18 (discover-manifest collapse)  |          −30 |
| E19 (readStackContext)            |          −90 |
| E20 (forkSubcommand factory)      |         −417 |
| E22 (flag validation)             |          −40 |
| E23 (loaders consolidation)       |          −20 |
| E24 (stageAndSwap)                |         −100 |
| E25 (drop chmod)                  |          −10 |
| E26 (fsOp helper)                 |         −140 |
| E27 (bindings via withCache)      |          −80 |
| E29 (dockerContainer dual-form)   |          −30 |
| E31 (git-fetch contentHash)       |           −3 |
| E32 (playwright fallback)         |          −30 |
| E33 (vitest wrapper)              |         −100 |
| E34 (dev-wallet CSS extract)      |         −600 |
| E35 (dev-wallet controller)       |         −100 |
| E36 (WalletAdapter)               |         −150 |
| New substrate                     |         +250 |
| **Total**                         |   **−2 920** |

That's `−2 920` net LoC, before counting test-file simplifications and before the
integration-contract plan's `−2 500` (the two plans don't overlap by construction). Cumulative:
**~−5 400 LoC across both plans**.

The biggest single wins are E1 (adopt-or-create container), E20 (fork CLI factoring), E34
(dev-wallet CSS extraction), E19 (readStackContext consolidation), and E16 (manifest projection
table). All five are fan-out-safe and independently shippable.

## Session opportunities — 2026-05-19 cleanup round

Aggregated from `## Opportunities noticed` bullets surfaced by every implementation/audit agent
dispatched during the 2026-05-19 cleanup round (Phase A substrate, move-build lock,
readStackContext, captureCommand, stageAndSwap, CLI audit, dapp-kit/compose audit, image-dirs
consolidation, walrus options follow-up). Same per-finding format as E1-E41 (file:line + one-line
description + LoC delta + bug-class win if any).

Raw bullets collected: **47**. Post-dedup distinct findings: **24** (E42-E65). An additional **9**
bullets refined existing findings as sub-bullets under E2, E4, E7, E13, E17, E19, E24, E26, E27 —
listed inline below their parent.

### 2.11 Engine — subprocess + spawn-drain follow-ups

#### E42. `runOneShot` is a 4th spawn-drain-exit implementation

|               |                                                                                                                                                                                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Where**     | `engine/docker/exec.ts:340-401` (`runOneShot`, `drainLinesWithCallback`).                                                                                                                                                                                                                                          |
| **Evidence**  | After E2's `captureCommand` consolidation, three of the four spawn-drain implementations collapsed. The fourth (`runOneShot`) stayed because its per-line callback shape doesn't fit `captureCommand`'s "both-streams-at-once" return. Surfaced by `a4b7b549b38f87757` (captureCommand) and the `ae20228b` commit. |
| **Redesign**  | Add an optional `onLine?: OutputLineCallback` parameter on `captureCommand`; collapse `runOneShot`'s drain branch onto it.                                                                                                                                                                                         |
| **LoC Δ**     | **−40 LoC**.                                                                                                                                                                                                                                                                                                       |
| **Bug class** | Subsumed under E2's canonicality win — one less drain-loop to keep in sync.                                                                                                                                                                                                                                        |

#### E43. Three truncate-with-ellipsis policies + `RENDER_FIELD_TRUNC`

|               |                                                                                                                                                                                                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Where**     | `engine/snapshot.ts:290` (`truncateStderr`), `engine/sui-cli.ts:475-479` (`truncateForError`), `engine/docker/core.ts:32-33` (`truncate`), `engine/pretty-error.ts` (`RENDER_FIELD_TRUNC = 8192`).                                                                                                                       |
| **Evidence**  | After E2 the three captured-stream truncators live in three different files with three slightly-different ellipsis tails (`…`, `…`, `…[truncated]`). `captureCommand`'s default (500) doesn't reference `RENDER_FIELD_TRUNC`. Surfaced twice: by `a4b7b549b38f87757` and by `a724db9b56ae23ded` (via `ae20228b` commit). |
| **Redesign**  | One shared `truncateWithEllipsis(s, maxBytes)` helper in `engine/pretty-error.ts` next to `RENDER_FIELD_TRUNC`. All four sites consume it.                                                                                                                                                                               |
| **LoC Δ**     | **−15 LoC**.                                                                                                                                                                                                                                                                                                             |
| **Bug class** | Hygiene; removes a "log says cut at 500 bytes, pretty-error truncated again at 8192" overlap.                                                                                                                                                                                                                            |

#### E44. `SuiCliError` loses captured stdout/stderr/exitCode on most wrap-sites

|               |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `engine/sui-cli.ts:60-74` (`SuiCliError` declaration), `engine/sui-cli.ts::suiCliError` factory; `buildMove` enriches at `:193-201` but `publishMove` and other callers don't.                                                                                                                                                                                                                                                                                                  |
| **Evidence**  | `SuiCliError` declares both `phase: Schema.Literals(SuiCliPhases)` AND a free-form `message`. The `suiCliError` factory drops `prettyError(cause)`'s first line into `message` but ignores the captured stdout/stderr/exitCode returned by `runWithCapture`. Build/publish failures consequently lose context unless the caller hand-builds a richer envelope. A sui CLI ENOENT loses captured-stream context that DID exist before the spawn. Surfaced by `a4b7b549b38f87757`. |
| **Redesign**  | Thread `CaptureError.{stdout, stderr, exitCode}` directly into `SuiCliError` on every wrap.                                                                                                                                                                                                                                                                                                                                                                                     |
| **LoC Δ**     | **+10 LoC** (correctness fix — a deliberate positive delta).                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Bug class** | "publishMove ENOENT prints no captured stderr" — the user sees a bare `SuiCliError: <empty>` row instead of the dump that's already in memory.                                                                                                                                                                                                                                                                                                                                  |

#### E45. `engine/docker/core.ts::captureStreams` is a dead alias

|               |                                                                                                                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `engine/docker/core.ts:1479`. Consumed only by `docker/exec.ts:11, 44`.                                                                                                                       |
| **Evidence**  | One-line alias for `runCapturing`. After E1 / E30 land, the entire surface can just be `Docker.runCapturing`. Surfaced by `a4b7b549b38f87757` and `ae20228b` (also listed as point under E2). |
| **LoC Δ**     | **−2 LoC**.                                                                                                                                                                                   |
| **Bug class** | Dead-weight; remove.                                                                                                                                                                          |

E2 sub-bullet (refinement, no new finding): `runtime/manifest-emit.ts:33`
`Schema.encodeUnknownSync(ManifestV5)` runs on every emit; pair with E17 to drop the redundant
final-flush since the reader now Schema-validates on the read side (~−40 LoC + measurable HMR-noise
win). Surfaced by `af2c4ccf54b120fd8`.

### 2.12 Engine — container adoption + lock follow-ups

#### E46. `withCache` keyOverride could accept `Effect<string>`

|               |                                                                                                                                                                                                                                                                                                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `engine/cache.ts:144`.                                                                                                                                                                                                                                                                                                                                                |
| **Evidence**  | Several callers (`publishMove`, `walrus`) compute `keyOverride` from runtime values (sourceHash, chainId) and have to do `const sourceHash = yield* hashMoveSources(...)` BEFORE the `withCache` call just to plumb it. Letting `keyOverride` be an Effect would lift the work into `withCache`. Surfaced by `a0cc212cdab3369dd` (Phase A) and the `5c3f2357` commit. |
| **LoC Δ**     | **−25 LoC** across 5 callsites.                                                                                                                                                                                                                                                                                                                                       |
| **Bug class** | Hygiene; reduces "I had to materialize this string at the wrong layer" plumbing.                                                                                                                                                                                                                                                                                      |

#### E47. `inspectContainer` is private, needed by `containerPrimitive` diagnostics

|               |                                                                                                                                                                                                                                                                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `engine/docker/core.ts:1102`.                                                                                                                                                                                                                                                                                                           |
| **Evidence**  | Phase B will want to call it from `containerPrimitive` for diagnostic ("we just adopted vs created") logging. Currently the only access is the indirect `Docker.run` call. Exporting it lets `containerPrimitive` surface the action via `setPhase('adopted' \| 'started' \| 'recreated' \| 'fresh')`. Surfaced by `a0cc212cdab3369dd`. |
| **LoC Δ**     | **0 LoC** (export only).                                                                                                                                                                                                                                                                                                                |
| **Bug class** | Sequencing: lands during/after E1.                                                                                                                                                                                                                                                                                                      |

#### E48. `resolveUpstreamKeys` accepts string variant nobody uses

|               |                                                                                                                                                                                                                                                                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `advanced/tag.ts:421`.                                                                                                                                                                                                                                                                                                                               |
| **Evidence**  | `resolveUpstreamKeys` accepts `LayeredTag \| string \| undefined`. The string variant is rarely used in practice (every callsite checked passes LayeredTags). Restricting to `LayeredTag \| undefined` would catch a class of typos — `upstreamKeys: ['mispelled-tag-name']` silently becomes a dangling reference. Surfaced by `a0cc212cdab3369dd`. |
| **LoC Δ**     | **0 LoC** (narrowing only).                                                                                                                                                                                                                                                                                                                          |
| **Bug class** | Type narrowing turns runtime-silent typos into compile-time errors.                                                                                                                                                                                                                                                                                  |

#### E49. ChainProbe migration targets in walrus + deepbook verify loops

|               |                                                                                                                                                                                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Where**     | `services/walrus/internal.ts:940-960` (`probeWalrusObject` hand-rolls `ChainProbe.getObject`), `services/deepbook/local-deploy.ts:367-406` (`verifyCached` loop matches `objectsMatchTypes` semantics), and the pyth local-deploy equivalent.                                                                      |
| **Evidence**  | Walrus deploy verify currently casts through `as { object?: { type?: string } }`. Three identical loops across deepbook + walrus + pyth will collapse to one `chain.objectsMatchTypes([...], moveTypeEquals)` call. Phase B migration target. Surfaced by `a0cc212cdab3369dd` (Phase A) and the `5c3f2357` commit. |
| **LoC Δ**     | **−180 LoC** (−20 walrus + −40 × 3 deepbook/walrus/pyth verify loops).                                                                                                                                                                                                                                             |
| **Bug class** | Boundary-validated chain reads replace silent shape-drift on `client.core.getObject`. Sister of B1/B5/B7 elimination.                                                                                                                                                                                              |

#### E50. `Layer.build` test helper for LayeredTag composition

|               |                                                                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Where**     | `engine/test-helpers.ts` (new). Used in `engine/on-chain-artifact.test.ts` `runArtifact` (which re-derives the `provideMerge` fold from `__layers` because `Layer.build(__layer)` alone isn't enough). |
| **Evidence**  | Future Phase B/C test suites will all need to materialise a LayeredTag-with-upstreams. Currently each test inlines the fold. Surfaced by `a0cc212cdab3369dd` (Phase A).                                |
| **Redesign**  | Shared `buildLayeredTag(tag): Effect<Resolved, ..., never>` helper.                                                                                                                                    |
| **LoC Δ**     | **+15 LoC** new helper, **−20 LoC** across suites. Net **−5 LoC**.                                                                                                                                     |
| **Bug class** | Test infrastructure consistency; not directly a runtime win.                                                                                                                                           |

#### E51. Extract `withMoveBuildLock` + helpers into `engine/move-build-lock.ts`

|               |                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `engine/sui-build-container.ts:51-68` (lock helper exports), `:~371` (~110 LoC of lock implementation), `engine/sui-cli.ts:181, 364` (consumers; `path.join(os.homedir(), '.move')` duplicated).                                                                                                                                                                                                                                              |
| **Evidence**  | The lock helpers (`acquireMoveBuildLock`, `releaseMoveBuildLock`, `withMoveBuildLock`, `moveBuildLockPath`, `defaultMoveHome`) are a self-contained concern unrelated to the SuiBuildContainer service. Moving them to a dedicated module would let `sui-cli.ts` import without the cycle-via-SuiBuildContainer and shrink `sui-build-container.ts` by ~110 LoC. Surfaced by `af2748b70343aafcd` and the `5c3f2357` move-build-agent section. |
| **LoC Δ**     | **−110 LoC** out of `sui-build-container.ts` (move-and-tighten).                                                                                                                                                                                                                                                                                                                                                                              |
| **Bug class** | Reduces import cycle risk; one less giant file (E41-adjacent).                                                                                                                                                                                                                                                                                                                                                                                |

#### E52. "Bug D" identifier sweep + stale Move-build race comment

|               |                                                                                                                                                                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Where**     | `engine/sui-build-container.ts:47-49` (comment), `:638-643` (Bug D forward-looking comment), `engine/sui-build-container.test.ts:536` and `cli/commands/doctor.ts` (Bug D references throughout).                                                                                                      |
| **Evidence**  | The "Bug D" identifier across the codebase now refers to a race that lives at a different file after move-build lock relocation. Comment at `:47-49` claims the `~/.move/git/` race remains; with the funnel lock it doesn't, only the bind-mount `build/` race does. Surfaced by `af2748b70343aafcd`. |
| **Redesign**  | Update comment, sweep references (`git grep "Bug D"`).                                                                                                                                                                                                                                                 |
| **LoC Δ**     | **0 LoC** (rewording).                                                                                                                                                                                                                                                                                 |
| **Bug class** | Doc drift.                                                                                                                                                                                                                                                                                             |

E7 sub-bullet (refinement): `engine/snapshot.ts:212-223` `wrapError` + `wrapDockerError` indirection
still surrounds 29 `.pipe(Effect.mapError(wrapError(...)))` sites — already covered by E7, but
`a4b7b549b38f87757` re-confirms the −60 LoC projection.

### 2.13 Runtime — projection + endpoint follow-ups

#### E53. `lookupByManifestPath` helper for endpoint declarations

|               |                                                                                                                                                                                                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `runtime/endpoint-names.ts:25-138` (where `defineEndpoint(...)` declarations carry `manifestField.path` strings), `runtime/read-stack-context.ts::project` (hand-walks `manifest.services.sui.rpc`), `runtime/service.ts::groupSui`, `cli/commands/status.ts` `chainBlock` walk. |
| **Evidence**  | `defineEndpoint(...)` already declares each path; the readers hand-walk the strings. A `lookupByManifestPath(manifest, decl.manifestField.path)` would let all four callers drop their if-cascades. Surfaced by `af2c4ccf54b120fd8` and the `87f4e70f` commit.                   |
| **Redesign**  | Add helper (≈20 LoC). Drops if-cascades in three places.                                                                                                                                                                                                                         |
| **LoC Δ**     | **−80 LoC** net.                                                                                                                                                                                                                                                                 |
| **Bug class** | Drift: today `endpoint-names.ts` declares the path, three consumers re-encode it. Adding a new endpoint requires four edits; this collapses to one.                                                                                                                              |

E16 sub-bullet (refinement): `runtime/service.ts:81 manifestLeafUnder` ALSO walks the same
well-known endpoint set as `read-stack-context.ts::project`. After E16 lands, both can share one
`endpointProjectionTable()` helper (~−60 LoC if landed together). Surfaced by `af2c4ccf54b120fd8`.

E17 sub-bullet (refinement, repeat): see E45-area note above — pair E17 (mutate-driven emit) with
dropping the redundant final-flush since the reader now Schema-validates on the read side (~−40
LoC + measurable HMR-noise win).

E19 sub-bullet (refinement): `cli/commands/manifest.ts` `--json` path re-reads file via
`nodeFs.readFile` to preserve byte-for-byte fidelity; could `JSON.stringify(ctx.manifest, null, 2)`
and accept re-encoded output (~−10 LoC, optional trade-off). Surfaced by `af2c4ccf54b120fd8`.

### 2.14 CLI follow-ups

#### E54. `cli/commands/graph.ts:142-148` should use `Flag.choice`

|               |                                                                                                                                                                                                                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `cli/commands/graph.ts:142-148`.                                                                                                                                                                                                                                                                     |
| **Evidence**  | The flag is declared as `Flag.string` with manual inline validation because the comment claims "Effect-CLI doesn't ship a `Flag.choice` helper". But `cli/flags.ts:11` uses `Flag.choice('renderer', ['tui', 'plain', 'silent'])` successfully — the helper exists. Surfaced by `a604c14bae7144331`. |
| **Redesign**  | Migrate `--format` to `Flag.choice`; drop inline error message.                                                                                                                                                                                                                                      |
| **LoC Δ**     | **−5 LoC**.                                                                                                                                                                                                                                                                                          |
| **Bug class** | Hygiene; brings graph in line with the rest of the CLI.                                                                                                                                                                                                                                              |

#### E55. `cli/commands/wipe.ts` flag surface drift

|               |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `cli/commands/wipe.ts:81-84` (`--no-stop`), `:101-116` (`--also-upstream-cache`/`--keep-upstream-cache`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Evidence**  | (1) `--no-stop` says "only remove on-disk state" but the volumes pass refuses if containers reference them, so the flag produces a partial cleanup the user didn't ask for. Either remove or rename `--state-only` and have it actually do that. (2) `--also-upstream-cache` + `--keep-upstream-cache` are "mutually exclusive in spirit but accepting both"; the latter only exists to make the `SeedManifestMismatchError` recipe line read naturally. After the new error envelope lands the recipe can use the default — drop `--keep-upstream-cache`. Surfaced by `a604c14bae7144331`. |
| **Redesign**  | Either remove `--no-stop` or rename to `--state-only` and make it actually skip the volume refuse-check. Drop `--keep-upstream-cache`.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **LoC Δ**     | **−10 LoC**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Bug class** | "Sleeper bug — never causes the test suite to fail but quietly leaves resources behind."                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

#### E56. `cli/commands/prune.ts:76-80 --interactive` is dead

|               |                                                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `cli/commands/prune.ts:76-80`.                                                                                                                                      |
| **Evidence**  | Described as "force Ink picker even if other flags imply non-interactive" but no other flag does, so the flag is effectively dead. Surfaced by `a604c14bae7144331`. |
| **Redesign**  | Remove or repurpose.                                                                                                                                                |
| **LoC Δ**     | **−5 LoC**.                                                                                                                                                         |
| **Bug class** | Dead surface.                                                                                                                                                       |

#### E57. `cli/commands/snapshot.ts:62-85` silent multi-mode ref lookup

|               |                                                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `cli/commands/snapshot.ts:62-85`.                                                                                                                             |
| **Evidence**  | Three lookup modes from one `ref` positional (exact match → endsWith label → startsWith prefix). Not documented in `--help`. Surfaced by `a604c14bae7144331`. |
| **Redesign**  | Document in `--help`, OR split into `--id`/`--label`/`--prefix`.                                                                                              |
| **LoC Δ**     | **0 LoC** (doc fix) or **+10 LoC** (split).                                                                                                                   |
| **Bug class** | UX surprise; users with prefix-collision against a label hit a silent wrong-match.                                                                            |

#### E58. `cli/commands/_prune-stack.ts` should live in `engine/`

|               |                                                                                                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Where**     | `cli/commands/_prune-stack.ts:1-7`.                                                                                                                                                                                                              |
| **Evidence**  | Comment claims it lives under `cli/` because `removeStateOnDisk` depends on the CLI's view of where state lives, but that dependency is `resolveStateDir`, now an engine concern (`engine/resolve-app-dir.ts`). Surfaced by `a604c14bae7144331`. |
| **Redesign**  | Move to `engine/prune.ts`; CLI command becomes a thin shell.                                                                                                                                                                                     |
| **LoC Δ**     | **−15 LoC** in import-graph cleanup.                                                                                                                                                                                                             |
| **Bug class** | Engine and CLI share one prune primitive — eliminates the "what does 'pruned' mean in tests?" ambiguity.                                                                                                                                         |

#### E59. `cli/index.ts:18` file-scope `no-explicit-any` disable

|               |                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Where**     | `cli/index.ts:18` (eslint-disable for the whole file), motivated by `Effect.Effect<void, unknown, never>` cast at `:62`. |
| **Evidence**  | Could be tightened with the new envelope-emitter signature post-E20. Surfaced by `a604c14bae7144331`.                    |
| **LoC Δ**     | **0 LoC** (cosmetic).                                                                                                    |
| **Bug class** | None; cleans up the file.                                                                                                |

E19 sub-bullet (refinement, status.ts state.json): `cli/commands/status.ts` `tryReadJson` for
`state.json` still hand-rolls the "exists? read? parse?" cascade my new reader handles for the
manifest. A `tryReadJsonSchema(filePath, Schema)` helper (≈30 LoC) lets status drop ~20 LoC and gain
Schema-validation on the state file too. Est **−20 LoC** + bug-class win. Surfaced by
`af2c4ccf54b120fd8`.

E19 sub-bullet (refinement, fork networkToUpstream):
`cli/commands/fork.ts:107-112 networkToUpstream` is an if/else chain; could be a
`Record<NetworkLiteral, Upstream>` table (≈8 LoC). Est **−4 LoC**. Surfaced by `af2c4ccf54b120fd8`.

E32 sub-bullet (refinement, fallback option): `playwright/web-server.ts`
fallback-to-`conventionalUrl` is correctness-fragile (audit E32). Now that `readStackContextSync` is
in place, a small `webServer({fallback: 'conventional' \| 'fail'})` option lets callers opt in to
fail-fast. Est **+5 LoC** for the option, removes the silent-mismatch failure mode. Surfaced by both
`af2c4ccf54b120fd8` and the `87f4e70f` commit.

### 2.15 Codegen follow-ups

#### E60. `readFileOrUndefined` + `pathExists` shared helpers

|               |                                                                                                                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `services/codegen.ts:188-193` (`readExistingGitignore`), `codegen/emitters/bindings.ts:236-244` (`wrote` probe), `engine/stage-and-swap.ts:140-150` (`targetExists`).                   |
| **Evidence**  | Three callsites for the same `fs.readFile`-with-undefined-on-ENOENT idiom (or its access-probe sibling). 7-line Effect each. Surfaced by `ab1e79746a6b76e44` and the `c1dc4264` commit. |
| **Redesign**  | Shared `readFileOrUndefined(path)` + `pathExists(path)` helpers.                                                                                                                        |
| **LoC Δ**     | **−30 LoC** across three sites.                                                                                                                                                         |
| **Bug class** | Hygiene; reduces "is this ENOENT mapping correct here?" review surface.                                                                                                                 |

#### E61. `bindings.ts:142-144` hard-codes `outputDir/bindings`; emitters should declare `targetDir`

|               |                                                                                                                                                                                                                                                                                           |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `codegen/emitters/bindings.ts:142-144` (synthesizes `outputAbs = path.join(ctx.outputDir, 'bindings')` by hand).                                                                                                                                                                          |
| **Evidence**  | The emitter conventionally writes under `<outputDir>/<emitter.name>/` but only this emitter synthesizes the path manually. `defineEmitter` could expose a `targetDir` derived from `name`. Affects all four built-in emitters. Surfaced by `ab1e79746a6b76e44` and the `c1dc4264` commit. |
| **Redesign**  | `defineEmitter` carries `targetDir`. Callers drop the manual `path.join`.                                                                                                                                                                                                                 |
| **LoC Δ**     | **−10 LoC** across all four built-in emitters.                                                                                                                                                                                                                                            |
| **Bug class** | Drift: one emitter's path differs from the others.                                                                                                                                                                                                                                        |

#### E62. Compose-time duplicate-emitter check (currently runtime)

|               |                                                                                                                                                                                                                                           |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `services/codegen.ts:217-232`.                                                                                                                                                                                                            |
| **Evidence**  | Currently a runtime guard — but the LayeredTag for `Codegen({...})` knows its emitter set at compose time. Could become a compose-time invariant asserted at `tag(...)` build. Surfaced by `ab1e79746a6b76e44` and the `c1dc4264` commit. |
| **LoC Δ**     | **−16 LoC**.                                                                                                                                                                                                                              |
| **Bug class** | "User notices duplicate emitter at first cycle instead of at type-check."                                                                                                                                                                 |

E24 sub-bullet (refinement, ENOENT catchTag): `engine/stage-and-swap.ts:140-150` `targetExists`
access-probe duplicates what `fs.rename(stagingDir, target)` would surface as ENOENT — could just
attempt rename and `catchTag(ENOENT)` to skip the rename-aside path, saving the access syscall. Net
**~−5 LoC** + removes a TOCTOU window. Surfaced by `ab1e79746a6b76e44` and the `c1dc4264` commit.

E26 sub-bullet (refinement, writeGitignore): `services/codegen.ts:78-93 writeGitignore` uses
`phase: 'write'` and rebuilds the same error pattern as 20+ other sites — exactly what audit E26
(`fsOp` helper) centralizes. About **−15 LoC** just here when E26 lands. Surfaced by
`ab1e79746a6b76e44`.

E27 sub-bullet (refinement, bindings fingerprint): `bindings.ts:40 lastEmitFingerprint` migration
kept the module-global map intact; test isolation problem remains. After E27 lands the fingerprint
walk should fold into `stage` Effect's pre-step (cache-key from `withCache`). Surfaced by
`ab1e79746a6b76e44`.

### 2.16 Compose / dapp-kit / vite shell

#### E63. `compose/devstack.ts` brute-force `manifestRef.upstream = all-siblings`

|               |                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `compose/devstack.ts:151-174` (`manifestRef`), `:246-262` (Codegen members — same hack).                                                                                                                                                                                                                                                                                                                                                          |
| **Evidence**  | Both declare EVERY sibling key as upstream as a brute-force ordering hack ("place manifest last in topo"). Two reasons — `siblingKeys` registries + ExtrasResolved scope-binding — are real but the same hack is duplicated. If the supervisor exposed an explicit "schedule at level N+1" or "run-after-all" knob, both collapse from ~30 LoC of in-place patching to a 1-line declaration. Engine-side change. Surfaced by `a44f7b364824adc63`. |
| **Redesign**  | New supervisor knob: `runAfter: 'all-siblings' \| TagSpec[]`.                                                                                                                                                                                                                                                                                                                                                                                     |
| **LoC Δ**     | **−25 LoC** in `compose/devstack.ts` + small engine addition.                                                                                                                                                                                                                                                                                                                                                                                     |
| **Bug class** | "Forgot to add a new sibling to manifestRef.upstream → manifest fires before that sibling's state lands" — silent ordering bug.                                                                                                                                                                                                                                                                                                                   |

#### E64. `compose/devstack.ts isOptions` test gap + comment drift

|               |                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `compose/devstack.ts:115-127`.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Evidence**  | Discriminator depends on `DevstackTagBrand` symbol being present. The test at `compose/devstack.test.ts:46-54` already documents a sharp edge ("a faked ref carrying `__layer`" passes); but the bool-expression at `:124` correctly checks the brand. The test fakes only `__layer` and not the brand, so it's testing that NON-branded objects pass through — which is the opposite of robust. Worth a 2-line fix in the test. Surfaced by `a44f7b364824adc63`. |
| **LoC Δ**     | **+2 LoC** in test.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Bug class** | Test asserts the wrong invariant; correct it.                                                                                                                                                                                                                                                                                                                                                                                                                     |

#### E65. dapp-kit-stale doc-comments + tsconfig-subpaths workaround re-check

|               |                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `src/vite/index.ts:85-91` (references `createDevstackDappKit` from `@mysten-incubation/devstack/dapp-kit` which was deleted), `tsdown.config.ts:35-46` (fixtures comment still mentions `@mysten/dapp-kit-react` as the postcss-types problem source), `services/walrus.ts:251-260` (`localnetWalrusOptions` re-export wart), `services/walrus/options.ts:23-34` (`LocalnetWalrusOptions` and `LocalnetWalrusInputs` could collapse). |
| **Evidence**  | Doc/comments lag behind: dapp-kit/ is gone; the only remaining tsconfig-subpaths workaround triggers are `@effect/vitest` (vitest/playwright entries) and the vite plugin. If those don't trigger the postcss-types issue, the whole tsconfig.subpaths + finalize-subpath-dts toolchain (~80 LoC of scripts + a tsconfig) goes away. Surfaced by `a44f7b364824adc63` and `a6c87ecbf9774bd9d`.                                         |
| **Redesign**  | (1) Sweep stale comments. (2) Re-check the postcss-types workaround now that dapp-kit is gone. (3) Collapse `LocalnetWalrusOptions`/`Inputs` once example apps read from the manifest directly.                                                                                                                                                                                                                                       |
| **LoC Δ**     | **−10 LoC** (comments) **+ up to −80 LoC** (if workaround can go) **+ −30 LoC** (walrus options collapse). Net **~−120 LoC** if everything lands.                                                                                                                                                                                                                                                                                     |
| **Bug class** | Doc rot — references that no longer exist mislead future readers.                                                                                                                                                                                                                                                                                                                                                                     |

#### E66. Example apps duplicate `walrusCaptured` lookup cast

|               |                                                                                                                                                                                                                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `examples/private-content/src/lib/walrus.ts:19-31` and every other example app's walrus consumer.                                                                                                                                                                                              |
| **Evidence**  | The `walrusCaptured` lookup uses an inline `Record<string, ...>` cast to read from `captured`. Pattern repeats across example apps. A typed helper on the root barrel — `getWalrusCaptured(captured)` — would centralize the "walrus not deployed yet" error. Surfaced by `a6c87ecbf9774bd9d`. |
| **Redesign**  | Export `getWalrusCaptured(captured)` (or sibling helpers per service) from `@mysten-incubation/devstack`.                                                                                                                                                                                      |
| **LoC Δ**     | **−15 LoC per example × N apps** (~−45 LoC).                                                                                                                                                                                                                                                   |
| **Bug class** | "Example app's typed cast goes stale on schema change."                                                                                                                                                                                                                                        |

### 2.17 Image dirs follow-ups (post `adf77bb` consolidation)

#### E67. `services/sui.ts` repeats `new URL('../../<svc>-image/', ...)` pattern

|               |                                                                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `src/services/sui.ts:758, 780, 1624` (three sites with the same `new URL('../../<svc>-image/', import.meta.url).pathname` shape).                                                                 |
| **Evidence**  | A tiny helper `imageContext(name)` would centralize the convention. Trade-off: explicitness is nice for grepping. Only worth doing if a 4th occurrence shows up. Surfaced by `af2675516b852b3a3`. |
| **Redesign**  | One helper near the image-dirs root.                                                                                                                                                              |
| **LoC Δ**     | **−6 LoC** marginal (3 lines saved, +5 for helper).                                                                                                                                               |
| **Bug class** | Drift if image-dirs layout shifts again.                                                                                                                                                          |

#### E68. tsdown.config + `clean: true` for stale dist subdirs

|               |                                                                                                                                                                                                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `tsdown.config.ts:32-41` (8 explicit per-file copies that could collapse to 3 directory entries) + the consolidated `images/` layout still leaves stale `dist/seal-image/`, `dist/sui-image/`, `dist/walrus-image/` until `clean: true` (or its tsdown equivalent) is added. |
| **Evidence**  | After `adf77bb` moved the image dirs, the old `dist/<svc>-image/` paths can persist. Surfaced by `af2675516b852b3a3`.                                                                                                                                                        |
| **Redesign**  | (1) Add `clean: true` to the build config. (2) Collapse the 8 per-file copies to 3 directory entries.                                                                                                                                                                        |
| **LoC Δ**     | **−5 LoC** in config.                                                                                                                                                                                                                                                        |
| **Bug class** | Stale published artifacts shipping with old image layout.                                                                                                                                                                                                                    |

#### E69. `dockerImageRuntimeBuildArgs` variant absorbs walrus image wrapper

|               |                                                                                                                                                                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `src/services/walrus/image.ts:38-41` (`contentHash({context, dockerfile, buildArgs})`) vs `services/walrus/local-cluster.ts:155-167` (same content-addressed tag, bypasses `dockerImage(...)` because of a runtime-resolved build-arg).       |
| **Evidence**  | The duplication is intentional per the comment, but a `dockerImageRuntimeBuildArgs(...)` factory variant on the `dockerImage` primitive could absorb the wrapper case and delete the bespoke hash/tag logic. Surfaced by `af2675516b852b3a3`. |
| **Redesign**  | Extend `dockerImage(...)` with a runtime-buildArg variant.                                                                                                                                                                                    |
| **LoC Δ**     | **−20 to −30 LoC**.                                                                                                                                                                                                                           |
| **Bug class** | Two implementations of content-addressed image tagging.                                                                                                                                                                                       |

### 2.18 Cross-cutting follow-ups

E38 sub-bullet (refinement, ManifestShapeError): `engine/errors.ts:139-380` eleven tagged errors all
carry `cause: Schema.optional(Schema.Defect)` (E38). The new `ManifestShapeError` makes 12.
`defineDevstackError(name, fields)` helper would drop boilerplate on a per-class basis (~**−12
LoC** + convention enforcement). Surfaced by `af2c4ccf54b120fd8` and `87f4e70f` commit.

### 2.19 Notes hygiene

#### E70. Completed-work notes should move to `notes/done/`

|               |                                                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Where**     | `packages/devstack/notes/dirs-dapp-kit-compose-audit.md` and other completed proposal docs from 2026-05 cleanup.                 |
| **Evidence**  | Now describes work that has been completed; reading it as if it were an open proposal misleads. Surfaced by `a6c87ecbf9774bd9d`. |
| **Redesign**  | Move to `notes/done/` or delete.                                                                                                 |
| **LoC Δ**     | **0 LoC** (no code impact).                                                                                                      |
| **Bug class** | Doc rot.                                                                                                                         |

### Top-5 reranking note

None of these new findings would crack the existing top-5 (E1/E2/E3/E4/E5) on their own — the
highest-LoC new item is E49 (ChainProbe verify-loop migration) at **−180 LoC**, which is sister-work
to E1 and is best landed as part of Phase B of the integration-contract plan rather than as a
standalone. The cluster that would most-justify rerank attention is **E63 + E65 + E68** if pursued
together (`compose/devstack.ts` topo-knob

- dapp-kit/tsconfig-subpaths fossil sweep + image-dirs build hygiene) because all three touch the
  build/package surface and are fan-out-disjoint from the engine refactors. The existing top-5 still
  correctly captures the high-leverage redesigns; this addendum is follow-up sized.

---

End of audit. Pair this with `notes/integration-contract-redesign.md` for the full simplification
picture; the two plans together cover service-layer cache+verify, container lifecycle,
manifest/registry shape, CLI introspection, codegen pipeline, and dev-wallet UI.
