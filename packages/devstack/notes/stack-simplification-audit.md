# Stack simplification audit (non-services)

**Status:** Design proposal, read-only audit.
**Author:** stack-simplification-audit subagent, 2026-05-19.
**Scope:** everything OUTSIDE the service layer's
`onChainArtifact` / `ChainProbe` / `containerPrimitive` redesign captured
in `notes/integration-contract-redesign.md`. That plan covers
`services/**` and the two long-lived container plugins; this one covers
engine, runtime, cli, codegen, plugin-author primitives, the test
harness, dev-wallet, and cross-cutting hygiene.

This is the prescriptive companion to the recon: each finding cites
file + line numbers, sketches the redesign (not the code), and projects
LoC delta and the bug class eliminated.

## 1. Executive summary

Top five highest-leverage redesigns:

| #  | Redesign | LoC Δ | Bug class eliminated |
|----|----------|-------|----------------------|
| E1 | **One container adoption primitive** (`adoptOrCreateContainer`). Collapse the two `inspectContainer` + adopt/start/recreate state machines (`docker/core.ts` and `sui-build-container.ts`) into a single race-safe helper that both long-lived primitives consume. Removes the per-container TOCTOU re-implementation. | −350 | TOCTOU races B6, sui-build C/H, ambiguous "name collision vs missing" handling. Sister of integration-contract-redesign §3.3 `containerPrimitive`, but at a lower layer so plugin-author code reuses it via `Docker.run` too. |
| E2 | **One subprocess-capture helper** (`captureCommand`). Three near-identical implementations exist (`engine/docker/core.ts::runCapturing`, `engine/sui-cli.ts::runWithCapture`, `engine/snapshot.ts::runTar`); fold them and the per-module `decodeStream` clones into one `engine/subprocess.ts`. Lets emitters / scripts / tar / docker share one error-shape. | −280 | "Empty stderr swallowed" regressions, `decodeStream` duplication, three slightly-different truncation policies. |
| E3 | **One CLI manifest+stack reader** (`readStackContext({stack})`). Consolidates the duplicated "discover manifest → JSON.parse → assert v5 shape → walk services" snippet in `cli/commands/fork.ts`, `cli/commands/status.ts`, `cli/commands/manifest.ts`, `playwright/web-server.ts`, `engine/router-bootstrap.ts`. Returns a typed `{manifest, sui?, wallet?, ...}` projection. | −400 | Manifest shape drift (the playwright reader's hand-rolled `services.sui.faucet` projection is already out-of-sync with the v5 schema), missing-manifest precedence inconsistency, hand-coded "is this v3 or v5?" guards in three places. |
| E4 | **Atomic-dir-swap primitive** (`stageAndSwap`). Three emitters (`services/codegen.ts`, `codegen/emitters/bindings.ts`, plus a third one fork-shaped at `services/walrus/internal.ts:429-439`) each hand-roll the staging+rename-aside+rename-in+backup-rollback dance. Centralise. | −250 | "Staging dir leaks on emitter failure" + "lost user `.gitignore` on swap" + "Vite HMR storm because we did rename even when contents unchanged" (the bindings cache invalidation lives in this same module). |
| E5 | **Registry factory consolidation** — 13 `Context.Service` class declarations + `defineRegistry` triple-destructure in `engine/registries.ts` reduce to a single `defineDevstackRegistry('Sui', SuiStateRecord)` call that produces the class, Live, publish, require, AND wires the type into `gatherManifest`'s R-channel by declaration merging. Reduces 13 class declarations + 13 Live exports + 13 manifest-grouper imports to one table. Also fixes the `RegistryNetwork` parser bug in `engine/registry.ts:147` (rejects `'mainnet-fork'` despite upsert accepting it). | −200 | "Adding a new state registry needs edits in 5 files" + the silent registry-network parse-and-drop bug for fork stacks. |

Projected net LoC delta across this audit: **−2 700 LoC** before counting
test collapse. Add ~300 LoC of new substrate; net **−2 400 LoC**. See
§5 for the per-area math.

## 2. By area

### 2.1 Engine — subprocess + container adoption

#### E1. Two `inspectContainer` + adopt/recreate state machines

| | |
|--|--|
| **Where** | `engine/docker/core.ts:1102` (`inspectContainer`, `decideRunAction`, `Docker.run` dispatcher), `engine/sui-build-container.ts:132` (`inspectContainer`), `:171` (`dockerStart`), `:215` (`dockerRunDetached`), `:280` (`ensureContainer`). |
| **Evidence** | Two parsers for `{{.State.Running}}|{{.Config.Image}}`; two adopt/start/recreate state machines, each with their own `'missing' | 'started'` / `'created' | 'name-collision'` discriminators. The `sui-build-container.ts` doc-comment Bug C + Bug H both fix races that `engine/docker/core.ts` Bug 6 also has (and the integration-contract plan duplicates the same fix in §3.3). |
| **Problem** | Two state machines, two race-windows, two test suites for the same logic. Plugin-author primitives that want a long-lived container reach for `dockerContainer` (which goes through `Docker.run`); engine-internal primitives like sui-build reach for their own. |
| **Redesign** | Extract `adoptOrCreateContainer({name, image, runArgs, expectedExitCodes, lockKey})` → `Effect<{containerId, hostPorts, reused}, DockerError, Spawner>`. Both `Docker.run` and `sui-build-container.ts:ensureContainer` call it. Internal: `Synchronized.Ref<Map<name, Deferred>>` serialises concurrent adopt-or-create for the same name (the per-name lock the integration-contract plan §3.3 calls out, but at the engine layer so EVERY container goes through it). |
| **LoC Δ** | `sui-build-container.ts` shrinks ~660 → ~350 (no own state-machine), `Docker.run`'s adopt branches collapse from ~120 → ~50. Net **−380 LoC**. |
| **Bug class** | TOCTOU races between inspect-and-rm, "name collision" misclassification, two test suites that test the same property differently. |
| **Sequencing** | After integration-contract-redesign §3.3 lands (which defines `containerPrimitive` semantics). E1 lifts the per-name lock down a layer so it benefits everyone. |

#### E2. Three spawn-and-capture-stdout-stderr-exit implementations

| | |
|--|--|
| **Where** | `engine/docker/core.ts:1488` `runCapturing` (+ `decodeStream:1541`, `runCapturingOrFail:1517`), `engine/sui-cli.ts:439` `runWithCapture` (+ inline `decode` at `:447`), `engine/snapshot.ts:295` `runTar` (+ `decodeStream:285`). |
| **Evidence** | All three: `spawner.spawn → Effect.all([decode(stdout), decode(stderr), exitCode], {concurrency: 'unbounded'})`. Three different `decodeStream` (one only handles stderr, two handle both). Three different truncation policies (`STREAM_TRUNC_BYTES=1024`, `TAR_STDERR_TRUNC=500`, `MAX_ERROR_DETAIL=600`, plus `RENDER_FIELD_TRUNC=8192` in pretty-error). Three different error-mapping wrappers (`dockerError`, `suiCliError`, `wrapSpawnError`). |
| **Problem** | Anyone changing one truncation policy or stream-drain shape has to remember to chain it through the others. The integration-contract plan adds a fourth (`SuiCliCapture` shape pattern matches `DockerExecResult`); without a shared helper, the count grows. |
| **Redesign** | `engine/subprocess.ts` exports `captureCommand(spawner, cmd, op, opts?)` → `Effect<{exitCode, stdout, stderr}, SubprocessError, never>` plus `captureCommandOrFail`. Caller-provided error mapping via a `{toError: (raw) => MyError}` option, OR returning a sum type. Truncation centralised in `pretty-error.ts` (already exports `RENDER_FIELD_TRUNC`). |
| **LoC Δ** | `engine/docker/core.ts` − ~80, `engine/sui-cli.ts` − ~30, `engine/snapshot.ts` − ~40, new module + ~50. Net **−100 LoC** — but the win is canonicality, not LoC. |
| **Bug class** | One change to "swallow empty stderr" / "show stdout on non-zero exit" / "truncate at N bytes" propagates everywhere. |
| **Sequencing** | Independent — fan out alongside E1. |

#### E3. Two `inspectContainer` decoders for different field sets

| | |
|--|--|
| **Where** | `engine/docker/core.ts:1102` parses `Running|Image|Id|ExitCode`; `engine/sui-build-container.ts:132` parses `Running|Image`. |
| **Evidence** | Pipe-split parsing in both, with a `parts.length !== N` defensive check. After E1 collapses the adoption flow, the single helper carries one format string and one parser. |
| **Bug class** | Subsumed by E1. |

#### E4. `fs.exists → fs.mkdir / fs.access → write` triple-step idiom

| | |
|--|--|
| **Where** | 174 hits of `recursive: true` mkdir across the codebase. Notable concentrations: `engine/snapshot.ts` (~10), `engine/state-store.ts:220`, `cli/commands/_prune-stack.ts`, every codegen emitter's staging-dir prep (`services/codegen.ts:246-265`, `codegen/emitters/bindings.ts:143-162`, ~50 LoC × 2). |
| **Evidence** | `Effect.tryPromise({ try: () => fs.mkdir(dir, {recursive: true}), catch: …})` (or the Effect-FS equivalent) repeated 30+ times, each wrapping the result in a different error class. |
| **Redesign** | A shared `ensureDir(path, errorClass)` Effect that takes the error-mapping function once. Skip the work entirely when `fs.mkdir(recursive: true)` is idempotent (which it is — the `fs.exists` pre-check is wasteful belt-and-braces). |
| **LoC Δ** | −80 from removing the per-callsite try/catch wrappers; the underlying mkdirs collapse to one-liners. |
| **Bug class** | Inconsistent error-mapping: today some callers raise `CodegenError(phase: 'write')`, some `SnapshotError`, some swallow with `Effect.ignore`. The CodegenError-vs-SnapshotError split for the same "couldn't make a directory" failure is a real footgun in pretty-error's display. |

#### E5. Per-stack lock variant proliferation

| | |
|--|--|
| **Where** | `engine/file-lock.ts` (canonical sync helper), `engine/state-store.ts:286-371` (async variant with jittered-backoff retry loop, 90 LoC), `engine/port-allocator.ts`, `engine/sui-fork/file-lock.ts`. |
| **Evidence** | The state-store's async variant maintains its own MAX_RECLAIM_ATTEMPTS=20 + exponential backoff + jitter loop because `tryClaimLockSync` doesn't return a "retry-with-backoff" outcome. AGENTS.md actually flags this duplication ("State-store's lock has its own Effect-platform retry loop … and stays distinct"). |
| **Redesign** | Add `tryClaimLock(lockPath, opts)` to `file-lock.ts` with `retry?: {attempts, baseBackoffMs, growth, jitter}`. State-store calls it; the sync variant becomes a thin `Effect.runSync` of the same. |
| **LoC Δ** | `state-store.ts` − 60, `file-lock.ts` + 40. Net **−20 LoC**. |
| **Bug class** | Two implementations of "stale lock reclaim" — the sync one uses `unlinkSync + writeFileSync(wx)`, the async one uses `fs.remove + writeFileString(wx)` plus a tempfile probe nobody actually reads (`state-store.ts:362`). Keeping them in sync over time is a footgun. |

#### E6. `RegistryNetwork` parser rejects fork variants

| | |
|--|--|
| **Where** | `engine/registry.ts:147-154`. |
| **Evidence** | `parseRegistry` only accepts `'localnet' | 'testnet' | 'mainnet' | 'custom'` — fork variants get silently dropped. But `RegistryEntry`'s type union AND `upsert`'s callers DO write fork variants in (`engine/registry.ts:48-55` — and `Devstack.identityShape` for any fork stack carries them). |
| **Problem** | A user's fork-stack registry entry never survives a round-trip — every reread filters it out. doctor/prune don't see fork stacks. The classifyEntry "active" check is then wrong because `entry.pid` was dropped with the network. |
| **Redesign** | Either drop the closed list (let upsert's union be the schema source of truth) or extend it; same one-line fix. The audit's preferred answer: replace the hand-rolled parser with `Schema.decodeUnknownSync(RegistryFileSchema)` where `RegistryNetwork` is `Schema.Literals(...)`. Use the same Schema in the type definition so the lists can't drift. |
| **LoC Δ** | −30 (lose the hand-rolled parser, the per-field type-check fan-out at `:139-163`). |
| **Bug class** | Silent serialization drop. Schema-validated boundary eliminates by construction. |

#### E7. `engine/snapshot.ts` 3-level `wrap*Error` indirection

| | |
|--|--|
| **Where** | `engine/snapshot.ts:211-225` — `wrapError`, `wrapDockerError`, `wrapSpawnError` differ only in the source-error shape; all three produce a `SnapshotError({message, cause})`. The factory consumes the same 20+ `.pipe(Effect.mapError(wrap*Error(...)))` calls. |
| **Evidence** | grep `Effect.mapError(wrap` returns 20 lines (the `snapshot.ts` body and `restore()`). The phase tracking is in the message string, not the error field — `snapshot()` and `restore()` have no `phase` discriminator on the error, despite AGENTS.md's "phase is the canonical 'which step' field" rule for new errors. |
| **Redesign** | Replace `SnapshotError({message, cause})` with `SnapshotError({phase: Schema.Literals(SnapshotPhases), context?, cause})` and use a closed phase enum. Wrap-once-per-step via `.pipe(Effect.mapError(snapshotError('extras-tar', {tarPath})))`. |
| **LoC Δ** | −60 (the 20 callsites collapse from a sentence string per site to a phase symbol + context object). |
| **Bug class** | Pretty-error currently can't surface "which step of restore failed" because the phase is in the freeform message. The TUI's `summarizeCause` can't bucket snapshot failures. |

### 2.2 Engine — supervisor + scheduler

#### E8. `supervisor.ts` is monolithic (2 023 LoC)

| | |
|--|--|
| **Where** | `engine/supervisor.ts` end-to-end. |
| **Evidence** | `wc -l` says 2 023. AGENTS.md's split rule (Single file ≲ 600 LoC) was relaxed for "historical primitives" but the supervisor wasn't on that list. The file is doing five jobs: layer composition (`composeStackLayer`, `composeBootstrapLayer`), watch-fiber + `compileWatchFilter`, signal handling (`installSignalRestart`), launch loop, and the top-level `defineDevstack` entry. |
| **Redesign** | Extract: `engine/supervisor/compose.ts` (layer build), `engine/supervisor/watch.ts` (watch-fiber + filter + ownership), `engine/supervisor/signals.ts` (POSIX signal bridge), `engine/supervisor/launch-loop.ts` (the outer race between restart/shutdown/build), `engine/supervisor.ts` (the public `defineDevstack` + `DevstackHandle` + glue). |
| **LoC Δ** | The same lines, but ~5 files of 250-500 lines each. The win is reviewability, not LoC. |
| **Bug class** | None directly — but the file's size makes navigating its 6 mutable `Set<string>` / `Map<string,...>` collections (the watcher's `watchedFileHashes`, `ATTACHED_FOLLOWERS`, `HEAVY_INFRA_COSTS`, etc.) hard, and they accumulated as bugs landed. |

#### E9. `StackMember` shape is "raw layer + N optional `__` fields"

| | |
|--|--|
| **Where** | `engine/supervisor.ts:114-197` and the parallel `LayeredTag` shape in `advanced/tag.ts:220-269`. Both carry the same `__kind` / `__displayTitle` / `__watchPaths` / `__pluginName` / `__hidden` / `__upstreamKeys` / `__layers` / `__extraMembers` / `[DevstackTagBrand]` panoply, declared inline twice. |
| **Evidence** | `provide` / `tag` build a `LayeredTag` by `Object.assign` into a Context.Service class. The supervisor reads via `(m as { __kind?: TagKind }).__kind`-style casts (`supervisor.ts:1352-1361`, `defineDevstack` seed pass). Every introspection casts. |
| **Redesign** | Promote the `__`-field bag into a single `TagMetadata` brand carried by `Symbol.for('@devstack/tag-metadata')` on the LayeredTag. The supervisor reads `tag[TagMetadata]?.kind` once. Eliminates the duplicate field-list (any new field is added in one place) and the dozen `as { ... }` casts. |
| **LoC Δ** | `supervisor.ts` − 40, `tag.ts` − 30. Net **−70 LoC** but more importantly removes a class of "added the field in `LayeredTag` but the supervisor's cast didn't get updated" bugs. |
| **Bug class** | Drift between the producer (tag.ts) and consumer (supervisor.ts) field lists. Today the only field that exists on `StackMember` but NOT on `LayeredTag` is `__extraMembers` — and it works correctly only because `flattenStackMembers` defensively casts. |

#### E10. `EngineHandle` interface has 22 methods, half are TUI-only

| | |
|--|--|
| **Where** | `engine/engine.ts:40-268`. |
| **Evidence** | `EngineHandleShape` declares `markAcquiring`, `markReady`, `markFailed`, `setPhase`, `markStopping`, `markStopped`, `markAllReady`, `seedTags`, `appendLog`, `appendTagLog`, `setEntryTitle`, `setHeader`, `setBuildStatus`, `awaitRestart`, `requestRestart`, `awaitShutdown`, `requestShutdown`, `markSelectiveRestart`, `registerPrimitiveScope`, `closePrimitiveScope`, `invalidateSubset`, `invalidateAll`, `_shadowCache`. |
| **Problem** | Two cohesive responsibilities are folded into one Service: (1) TUI mutation surface (markAcquiring / markReady / setPhase / appendLog / ...) consumed by `withEngineLifecycle` in `tag.ts`; (2) supervisor lifecycle (request/awaitRestart, request/awaitShutdown, registerPrimitiveScope, invalidateSubset). The shadow-cache leak through `_shadowCache: Ref` exists only for tests. |
| **Redesign** | Split into `EngineUI` (TUI mutators, consumed by `withEngineLifecycle`) and `Supervisor` (lifecycle gates, consumed by the launch loop). Tests touch `EngineUI` only — no need to expose shadow-cache. |
| **LoC Δ** | The file gets longer by ~30 (two interfaces, two layers) but every callsite gets the narrower R-channel — `withEngineLifecycle`'s requirement collapses from `EngineHandle` (~22 methods) to `EngineUI` (~10 methods). |
| **Bug class** | Test harness can't mock EngineHandle without mocking 22 methods (or `as` casting). The current `_shadowCache` "exposed for tests" leak (`engine.ts:267`) is a smell that vanishes under the split. |

#### E11. `formatRestartCascade` and `ownersFor` aren't testable in isolation

| | |
|--|--|
| **Where** | `engine/supervisor.ts:635-679`. Both are exported "for tests" but live inside the supervisor module that pulls in the entire compose / launch pipeline. |
| **Redesign** | Move to `engine/watch-attribution.ts` — pure functions, no Effect. After E8 this lands naturally. |
| **LoC Δ** | ~0 net (move not delete). |
| **Bug class** | None — this is hygiene. |

#### E12. `engine/known-deployments.ts` carries fork-mode + live-net tables

| | |
|--|--|
| **Where** | `engine/known-deployments.ts` (441 LoC). |
| **Quick read needed.** Not deep-audited; deferred to a follow-up. |

### 2.3 Engine — observability + errors

#### E13. `prettyError` ↔ `summarizeCause` ↔ `summarizeCauseForLog` divergence

| | |
|--|--|
| **Where** | `engine/pretty-error.ts:118` (`prettyError`), `engine/engine.ts:381-411` (`summarizeCause`, `extractDeepestMessage`, `rawFailure`), `advanced/tag.ts:401` (`summarizeCauseForLog` — wraps `prettyError`). |
| **Evidence** | Three different "walk the cause chain and produce a string" implementations:<br>1. `prettyError` — multi-line, full tree.<br>2. `summarizeCause` — one-line truncated to 80 chars for the TUI row.<br>3. `summarizeCauseForLog` — actually `prettyError(cause)` already. |
| **Problem** | (2) re-implements a "find deepest .cause" walk that (1) does too. They handle non-Error-shaped causes differently (the engine's `rawFailure` pulls Fail.error directly; pretty-error's recursion does the same but elsewhere). When `Schema.TaggedErrorClass` changes its private layout, two pieces of code break. |
| **Redesign** | `prettyError(value, {mode: 'tree' \| 'oneLine', maxLength?: number})`. One implementation; the TUI row uses `mode: 'oneLine'`. |
| **LoC Δ** | `engine.ts:381-411` deletes (~30 LoC), `summarizeCauseForLog` deletes (1 LoC alias). |
| **Bug class** | "TUI row says X, full log says Y" desync — the two extractors interpret tagged-error layout differently. |

#### E14. Phase fields are `Schema.optional(Schema.Literals(...))` everywhere

| | |
|--|--|
| **Where** | `engine/errors.ts:129, 152, 286, 304, 322, 341, 353, 367, 381` (most tagged errors). |
| **Evidence** | AGENTS.md "phase-field shape rule" says lifecycle errors should be REQUIRED phase fields. Most existing errors made `phase` optional. The new errors that landed in PGR (`SeedManifestMismatchError`, `ForkUnsupportedError`) don't carry a phase at all. |
| **Redesign** | Sweep through the closed-phase errors and make `phase` required. Migration is one-line per error — the catchsites already either pattern-match on `phase` (in which case the cast checked-out) or don't (in which case `phase: 'unknown' as const` covers them). |
| **LoC Δ** | ~0 net. The win is invariant enforcement. |
| **Bug class** | A primitive forgetting to stamp a phase falls into pretty-error's "no qualifier" branch and the TUI row reads `WalrusError: <freeform message>` instead of `WalrusError (publish): ...`. |

#### E15. Spans named both PascalCase and camelCase

| | |
|--|--|
| **Where** | AGENTS.md prescribes PascalCase (`SuiBoot`, `WalrusPublishPackage`). Grep finds 11 violations: `manifest.write`, `manifest.finalize`, `manifest.watch`, `git-fetch`, `Devstack.watch`, `Devstack.signalRestart`, `StateStore.put`, `StateStore.remove`, `SuiCli.buildMove`, `SuiCli.scrubCachedMoveLocks`, `Codegen(${name})` interpolated. |
| **Redesign** | Sweep — rename to PascalCase. Mostly grep+sed. The `Devstack.*` cluster reads strangely because the `Devstack.` prefix duplicates the service name annotation; drop the prefix. |
| **LoC Δ** | ~0 (renames). |
| **Bug class** | Inconsistent grouping in OTLP traces (`SuiBoot` lands one row but `git-fetch` lands another). |

### 2.4 Runtime — manifest + endpoints

#### E16. `runtime/service.ts` `groupApp` / `groupSui` / `groupDeepbook` are 5 hand-rolled projections

| | |
|--|--|
| **Where** | `runtime/service.ts:99-223`. |
| **Evidence** | 5 `groupX` functions, each pulling fields out of a `RegistryRecord` and a flat `EndpointRecord[]`, projecting into a `ServiceManifest` shape. The `groupSui` body even iterates endpoint names via `manifestLeafUnder(e.name, 'services.sui')` — which already proves the projection is data-driven. |
| **Redesign** | A `defineServiceProjection` API:<br>`defineServiceProjection({name: 'sui', stateRegistry: SuiStateRegistry, endpoints: ['sui-rpc', 'sui-faucet', 'sui-graphql'], project: (state, endpoints) => SuiManifest})`. The 5 projections become 5 declarations of ~10 lines each; `gatherManifest`'s 13 `yield* X` calls collapse to one loop over the projection table. |
| **LoC Δ** | `runtime/service.ts` 378 → ~200 (−180). |
| **Bug class** | "Added new field to state registry, forgot to surface in grouper" (the deepbook indexer/server fields had this lag for two PRs). |

#### E17. `runtime/manifest-emit.ts` slow-tick re-snapshot + final flush

| | |
|--|--|
| **Where** | `runtime/manifest-emit.ts:75-166`. |
| **Evidence** | The emitter writes the manifest THREE times per cycle: eager at acquire, every 500ms during the lifetime, and on finalize. Default tick is 500ms; over a 60s dev session that's 120 writes for a stack that's static after the first second. |
| **Problem** | Tax on Vite's watcher + on the disk + on test parallelism (the `writeFileAtomicIfChanged` shortcut catches identical bodies but the rename still touches mtime in some implementations). The slow-tick exists because some primitives publish their endpoint after the manifest's eager write. |
| **Redesign** | Subscribe to registry mutations (`RegistryShape` gains a `subscribe(): Stream<unit>`) so the emit only fires when a registry actually changed. Drop the slow-tick and the final flush (the on-mutate emit already captures the late writes). |
| **LoC Δ** | `manifest-emit.ts` − 30; per-registry +5 LoC (the subscribe Stream). |
| **Bug class** | "Manifest grew stale in the 500ms window between two late registers" — today the second register's value lands in the next tick, but if shutdown wins the race, it doesn't. The mutate-driven path is correct by construction. |

#### E18. `runtime/discover-manifest.ts` walk-up — best-effort + required-true split

| | |
|--|--|
| **Where** | `runtime/discover-manifest.ts:73-133`. |
| **Evidence** | A small file (134 LoC) but the precedence ladder (env → override → walk-up) is implemented twice (once for each `required` branch). |
| **Redesign** | Refactor as `const candidates = [envOverride, override, ...walkUp(cwd)].filter(p => p && existsSync(p))`; first hit wins. The "required: true" throw is one line at the end. |
| **LoC Δ** | −30. |
| **Bug class** | Two slightly-different precedence implementations. |

### 2.5 CLI

#### E19. Three CLI commands re-implement "read v5 manifest → assert shape → pull `services.sui.rpc.url`"

| | |
|--|--|
| **Where** | `cli/commands/fork.ts:80-105` (`readManifestSuiBlock`), `cli/commands/status.ts:13-79`, `playwright/web-server.ts:90-189` (`resolveEndpoint` — pulls flat endpoint name from nested manifest). |
| **Evidence** | Each one re-parses `JSON.parse(readFileSync(...))`, asserts the shape (some with "is this v3 or v5?" defensive logic — playwright's is at `web-server.ts:144`), and then walks the projection. The playwright reader maintains its own flat-endpoint-name to v5-path lookup table at `:166-180` — a parallel implementation of the `manifestLeafUnder` logic in `runtime/service.ts:81`. |
| **Redesign** | `cli/manifest.ts::readManifest(stack)` → `Effect<Manifest, ManifestDiscoveryError>` (or its sync sibling). Plus `manifest.lookupEndpoint(name) → string | undefined` derived from the same `defineEndpoint(...)` declarations the supervisor consults — meaning the playwright reader and the fork CLI use the same projection. |
| **LoC Δ** | `playwright/web-server.ts` − 90, `cli/commands/fork.ts` − 30, `cli/commands/status.ts` − 30, new module + 60. Net **−90 LoC**. |
| **Bug class** | Manifest shape drift — when v5 ships v6, all three readers need updates; today the playwright reader already lags (it carries v3 fallback code). |

#### E20. `cli/commands/fork.ts` is 917 LoC; subcommands repeat the `resolveForkRuntimeCtx → makeForkClient` boilerplate

| | |
|--|--|
| **Where** | `cli/commands/fork.ts:114-157`, `:171-249` (status), `:256-310` (advance-clock), `:317-...` (advance-checkpoint), `:...` (replay-to), `:...` (seed), `:...` (cache prune). |
| **Evidence** | Every subcommand body opens with:<br>```\nconst resolved = yield* resolveStack(fs, path, stack);\nconst ctx = yield* resolveForkRuntimeCtx(resolved);\nconst client = makeForkClient(ctx);\n```<br>followed by an `Effect.tryPromise({ try: () => client.forkingService.X(...).response, catch: cause => new Error(...) }).pipe(Effect.catch(...failAlreadyReported(...)))`. Six subcommands, six near-copies. |
| **Redesign** | `forkSubcommand({op: 'advance-clock', args: {duration: numberArg}, run: (ctx, args) => Effect})` factory. The 6 commands declare in a ~30-line table. |
| **LoC Δ** | `fork.ts` 917 → ~500 (−417). |
| **Bug class** | Inconsistent error reporting (some subcommands `failAlreadyReported`, some throw). Each subcommand's catch-mapper string drifts. |

#### E21. `cli/commands/doctor.ts` is 723 LoC mixing 4 check types

| | |
|--|--|
| **Where** | `cli/commands/doctor.ts` — `checkDocker`, `checkSui`, `checkPort`, fork stack walks, inventory. |
| **Redesign** | Each check is an `interface Check { name, ok, required, detail? }` producer. Extract a table of `[{name, run: Effect<Check>}]` and the orchestrator becomes a `forEach({concurrency: 'unbounded'})`. The 4 inline implementations move into individual files under `cli/commands/doctor/checks/`. |
| **LoC Δ** | ~0 net (refactor not delete), but each check becomes individually testable. |
| **Bug class** | None directly; the file is a navigability tax. |

#### E22. `cli/commands/prune.ts` `Mode` resolver vs the equivalent in `wipe.ts`

| | |
|--|--|
| **Where** | `cli/commands/prune.ts:144-173` (`resolveMode`), `cli/commands/wipe.ts:131-145` (the flag mutual-exclusion check). |
| **Evidence** | Two CLIs each carry their own "validate the flag combination is sensible" logic, expressed as imperative if-branches. |
| **Redesign** | Use `Effect.flagsValidated({ atMostOne: [...], requiresOne: [...] })` if exists, OR a tiny `cli/flag-validation.ts` helper. Each command's mode resolution becomes declarative. |
| **LoC Δ** | −40 across the two commands. |
| **Bug class** | Mistake about flag precedence (prune's `--list > target > --repo-gone > --all-orphans > interactive` cascade) is currently encoded once, easy to miss when adding a new mode. |

#### E23. `cli/loaders.ts` `requireLaunchEffect` + `requireLayer` duplicate-validate

| | |
|--|--|
| **Where** | `cli/loaders.ts:56-95`. Both validators throw the same `ConfigLoadError({phase: 'validate', configPath, expected, message})` with slightly-different sentences. |
| **Redesign** | One `validateDevstackExport(configPath, mod, {needs: 'launchEffect' | 'layer'})`. The two callsites become one-liners. |
| **LoC Δ** | −20. |
| **Bug class** | None — hygiene. |

### 2.6 Codegen

#### E24. `services/codegen.ts` and `codegen/emitters/bindings.ts` share atomic dir-swap

| | |
|--|--|
| **Where** | `services/codegen.ts:242-383` (the outer atomic swap around staging dir), `codegen/emitters/bindings.ts:141-318` (bindings' OWN atomic swap inside the outer one). |
| **Evidence** | Both implement: random-suffix staging → `fs.rm(staging, ...)` → `fs.mkdir(staging, ...)` → run emit body → `fs.rename(outputDir, backup)` → `fs.rename(staging, outputDir)` → `fs.rm(backup, ...)`. Bindings does it again INSIDE the codegen outer swap because bindings' content addressed cache invariant is per-target (each Move package needs its own promote). |
| **Problem** | Two implementations of the same primitive; the failure-recovery branches differ (codegen's restores the backup, bindings' just `fs.rm`s the staging). The outer codegen swap also handles `.gitignore` snapshot/restore, which the bindings inner swap doesn't need. |
| **Redesign** | `codegen/atomic-dir.ts::stageAndSwap({outputDir, prepareStaging, preserveOnSwap?})` returns an Effect that handles random suffix + staging + backup + rollback + the optional `.gitignore` snapshot. Bindings opts in with `preserveOnSwap: []` (nothing to preserve); codegen opts in with `preserveOnSwap: ['.gitignore']`. |
| **LoC Δ** | `services/codegen.ts` − 100, `codegen/emitters/bindings.ts` − 80, new module + 80. Net **−100 LoC**. |
| **Bug class** | The "backup not removed on success" leak (`services/codegen.ts:381` only removes when outputExists was true — but tomato-tomato edge cases exist), the "user's `.gitignore` lost on swap" (codegen handles; bindings doesn't, even though it could). |

#### E25. `codegen/helpers.ts::writeIfChanged` always does an explicit chmod

| | |
|--|--|
| **Where** | `codegen/helpers.ts:23-40`. |
| **Evidence** | Comments admit the explicit chmod is "Cheap on warm paths (one syscall)". But `writeFileAtomicIfChanged` already chmods on writes — the extra chmod is for the no-op case (existing file with wrong perms). |
| **Redesign** | Drop the explicit chmod. If perms-drift is a real risk, make `writeFileAtomicIfChanged` itself responsible for "chmod always if file exists; chmod on create if it doesn't"; centralise the policy. |
| **LoC Δ** | −10. |
| **Bug class** | Tiny but real: every codegen emit pass touches N file atimes via the chmod. Removing it stops one source of Vite HMR noise. |

#### E26. Each emitter's `runEmit` is wrapped in a 5-deep `Effect.tryPromise` lattice

| | |
|--|--|
| **Where** | `codegen/emitters/bindings.ts:143-318`. Every fs op is `Effect.tryPromise({ try, catch: cause => new CodegenError({...}) })`. 20+ instances. |
| **Redesign** | A `fsOp<T>(op: string, body: () => Promise<T>) => Effect<T, CodegenError>` curry. Each callsite becomes one line. |
| **LoC Δ** | `bindings.ts` − 60, `services/codegen.ts` − 80. Net **−140 LoC**. |
| **Bug class** | The 20 `catch:` bodies all do `stringifyCause(cause)` and rebuild a CodegenError; if a new field is added to CodegenError (like AGENTS.md's `phase:` requirement), 20 sites need touching. |

#### E27. `bindings.ts` has a private `lastEmitFingerprint` module Map

| | |
|--|--|
| **Where** | `codegen/emitters/bindings.ts:40`. |
| **Evidence** | A module-local `Map<string, string>` cache survives across test runs and across hot-restart cycles within one process. Comments admit the scope is intentional. |
| **Problem** | Two issues. (1) Test isolation — the next test sees a fingerprint from the previous test's source-tree mtime. (2) The fingerprint scheme is a parallel implementation of `withCache` (cache key + verify-via-source-mtime). |
| **Redesign** | Use `withCache(spec)` from `engine/cache.ts` for the bindings short-circuit. Cache key = source-tree fingerprint; verify = same mtime walk. The module-local Map disappears; the cache lives in `StateStore`, where every other content-addressed cache lives. |
| **LoC Δ** | `bindings.ts` − 80. The fingerprint walk stays (it's the cache-key input), but its consumer is `withCache`. |
| **Bug class** | (1) test cross-talk via module-global state, (2) the cache invalidation reason (mtime-changed vs source-tree-grew) is harder to debug from a Map than from `withCache`'s structured log lines. |

#### E28. `services/codegen.ts` writes `.gitignore` even on emitter failure

| | |
|--|--|
| **Where** | `services/codegen.ts:393` runs `writeGitignore` after the atomic swap. |
| **Evidence** | The swap order: stage → emit → swap outputDir aside → rename staging in → drop backup → write .gitignore. On emitter failure the staging dir is removed and outputDir is untouched. But the `writeGitignore` lives outside the `tapError` cleanup, so a write that races a partial earlier failure can re-write the user's .gitignore. |
| **Redesign** | Move into the staging dir BEFORE the swap, so it rides the rename. |
| **LoC Δ** | ~0. |
| **Bug class** | Eventual-consistency footgun if a user manually edits the .gitignore mid-cycle. |

### 2.7 Plugin-author primitives

#### E29. `dockerContainer` accepts `optionsInput` as static OR builder

| | |
|--|--|
| **Where** | `advanced/plugin-author/docker-container.ts:480-530`. |
| **Evidence** | `DockerContainerOptionsInput = DockerContainerOptions | (identity) => DockerContainerOptions`. Both shapes are present because some options need identity-derived values (per-stack network names). |
| **Problem** | The builder form forces `staticImage` to be passed separately (`docker-container.ts:529`) because the image MUST resolve at factory time. Two-arg callsites are inelegant. Internal `buildContainerInternals` calls `optsIsBuilder ? optionsInput(identity) : optionsInput` and has to throw a runtime TypeError if the contract is violated. |
| **Redesign** | Have ALL primitives accept the builder form (drop the static branch) — they get a free `identity` value, the image is always pulled out of the resolved options, and the runtime TypeError disappears. Static callers add `() => ({...})` wrappers (~3 chars overhead). The image-build layer wraps around the resulting container layer regardless of how the image was specified, with the image source captured at factory time via a separate `image` argument. |
| **LoC Δ** | −30 in `docker-container.ts` (the dual-path is gone), +1 char per callsite (a `() =>`). |
| **Bug class** | The "passed a builder without staticImage" TypeError lands at acquire time, not at type-check time. The unified form makes the failure compile-time. |

#### E30. `containerPrimitive` (integration-contract §3.3) should replace `dockerContainer`'s tag form

| | |
|--|--|
| **Where** | `advanced/plugin-author/docker-container.ts:520-555` (`dockerContainer`) vs `advanced/plugin-author/docker-container.ts:579-592` (`runDockerContainer`). |
| **Evidence** | The two surfaces (tag-form + inline-Effect form) share `buildContainerInternals` but each has its own export. The integration-contract plan's `containerPrimitive` (§3.3) duplicates the tag-form for a third time. |
| **Redesign** | Have the integration-contract `containerPrimitive` REPLACE `dockerContainer` (the tag-form). `runDockerContainer` stays as the inline form for primitives that need it. The result: one spec shape covers both. |
| **LoC Δ** | The plan's new helper subsumes ~250 LoC from the current `dockerContainer`. |
| **Bug class** | Subsumed by integration-contract §3.3. |

#### E31. `git-fetch.ts` inlines its own content-hash

| | |
|--|--|
| **Where** | `advanced/plugin-author/git-fetch.ts:159`. |
| **Evidence** | `crypto.createHash('sha256').update(repo).update(ref).digest('hex').slice(0, 12)`. AGENTS.md's table prescribes `engine/content-hash.ts::contentHash` for exactly this. |
| **Redesign** | Replace with `contentHash([repo, ref].join('\0'), { length: 12 })`. |
| **LoC Δ** | −3. |
| **Bug class** | Drift: if `contentHash` ever moves to BLAKE3 / changes truncation policy, the cache keys for cross-callers won't line up. |

### 2.8 Test harness

#### E32. `playwright/web-server.ts::resolveEndpoint` is dead-ended on a fallback

| | |
|--|--|
| **Where** | `playwright/web-server.ts:90-189`. |
| **Evidence** | When the manifest doesn't exist yet, `resolveEndpoint` falls back to `conventionalUrl(endpoint)`. The fallback exists because `playwright.config.ts` runs at config-load time, BEFORE the spawned `pnpm dev` writes the manifest. |
| **Problem** | The fallback path is correctness-fragile: if the supervisor binds different ports than the conventional defaults (port conflict → auto-allocate), the fallback URL is wrong and playwright's `webServer.url` waits on a port nothing is listening on. |
| **Redesign** | After E19's `readManifest` consolidation, the playwright path can defer to a single async-discovered manifest read, OR the supervisor's webServer launch path can write a minimal "pre-manifest" sidecar (`.devstack/stacks/<stack>/.url-hints.json`) with the actual port allocations. Either eliminates the fallback's failure mode. |
| **LoC Δ** | ~−30 if the fallback goes away. |
| **Bug class** | "Playwright timeout because port mismatch" — happens in CI when the runner has a busy port. |

#### E33. `vitest/define-config.ts` is 36 LoC and provides only `defineDevstackVitestConfig`

| | |
|--|--|
| **Where** | `vitest/define-config.ts`. |
| **Evidence** | The whole `vitest/` directory is two files, total ~100 LoC. The `defineDevstackVitestConfig` wrapper passes ~5 default opts through. |
| **Redesign** | Inline into the README. Apps that want it can copy-paste the 10-line config. The wrapper currently adds zero value over `defineConfig({test: {...mydefaults, ...options.test}})`. |
| **LoC Δ** | −100 (delete the directory). |
| **Bug class** | None — the wrapper exists because the playwright counterpart exists; doesn't mean it has to. |

### 2.9 Dev-wallet

#### E34. UI components total ~9 KLoC across 20 files; the 5 largest (~3 KLoC) duplicate Lit styles

| | |
|--|--|
| **Where** | `packages/dev-wallet/src/ui/dev-wallet-settings.ts` (692), `dev-wallet-signing.ts` (662), `dev-wallet-new-account.ts` (662), `dev-wallet-fork-panel.ts` (609), `dev-wallet-accounts.ts` (609). |
| **Evidence** | Each file has its own `static override styles = [sharedStyles, X, css\`...\`]` block, each ~80-200 LoC of CSS. Patterns repeat: section-header layout, address-row layout, copyable-detail styles. |
| **Redesign** | Extract the per-pattern CSS into `styles.ts` (which already exists at 252 LoC) as named exports (`addressRowStyles`, `sectionListStyles`, etc.). Each component imports the patterns it needs. |
| **LoC Δ** | Estimated **−800 LoC** across the 5 biggest UI files; +200 in `styles.ts`. Net **−600 LoC**. |
| **Bug class** | "Updated theme variable; only 4 of 6 places picked it up" — design drift between rows. |

#### E35. `wallet-controller.ts` is 431 LoC delegating between panel + standalone

| | |
|--|--|
| **Where** | `packages/dev-wallet/src/ui/wallet-controller.ts`. |
| **Evidence** | The controller exists to share logic between `dev-wallet-panel` and `dev-wallet-standalone`. The README says so. But each shareable piece (renderSigningModal, renderConnectPicker, renderTabContent, renderTabBar, renderNetworkBadge) is a thin delegation — the actual state still lives in fields on the controller. |
| **Redesign** | Lit ReactiveController is the right pattern for shared state. The problem is most controller methods are render shims that should live on the host element. Keep state + subscriptions on the controller; move render methods to a mixin or to a base class extended by both panel + standalone. |
| **LoC Δ** | ~−100 (the render shims fold into the host). |
| **Bug class** | Today the panel and the standalone each forward properties to the controller in their `willUpdate`. A field added to one and not the other silently no-ops. |

#### E36. `adapters/devstack-adapter.ts`, `adapters/remote-cli-adapter.ts`, `adapters/fork-relay.ts` share an Adapter contract that isn't explicit

| | |
|--|--|
| **Where** | The three adapter files (334, 388, 340 LoC). |
| **Evidence** | Each adapter implements signing + account-list against a different backend (devstack manifest URL, remote CLI WebSocket, fork-mode admin RPC). The shared contract is informal — each one re-derives `getAccount`, `sign*`, `getBalance`, etc., with slightly-different error handling. |
| **Redesign** | Define `interface WalletAdapter` (one shape; the existing `BaseSignerAdapter` is close but only covers signing) and have each concrete adapter implement it. Move shared helpers (account-by-address lookup, error-message formatting) into `adapters/_shared.ts`. |
| **LoC Δ** | −150 across the three adapter files. |
| **Bug class** | New adapter authors copy-paste from an existing one and pick up its specific error-handling quirks; a typed contract makes the surface explicit. |

### 2.10 Cross-cutting

#### E37. 18 distinct `DEVSTACK_*` env vars; no single registry

| | |
|--|--|
| **Where** | `DEVSTACK_APP_DIR`, `DEVSTACK_STATE_DIR`, `DEVSTACK_STACK`, `DEVSTACK_NETWORK`, `DEVSTACK_MANIFEST_PATH`, `DEVSTACK_REGISTRY_FILE`, `DEVSTACK_ROUTER_DYNAMIC_DIR`, `DEVSTACK_PORT_LOCK_DIR`, `DEVSTACK_SUI_FORK_CACHE_DIR`, `DEVSTACK_KEEP_ONESHOT`, `DEVSTACK_NO_ROUTER`, `DEVSTACK_LOG_LEVEL`, `DEVSTACK_WARN_MISSING_UPSTREAM`, `DEVSTACK_STRICT_UPSTREAM` (planned), `DEVSTACK_INTEGRATION_TESTS`, `DEVSTACK_DIRECT_PORTS` (one mention in docker/core.ts), `PLAYWRIGHT`. |
| **Evidence** | 18 module-level `process.env.DEVSTACK_X ?? default` patterns spread across 14 files. No central documentation. |
| **Problem** | Each env var has different precedence rules vis-a-vis flags / config; documentation is in JSDoc comments scattered across the codebase. A user looking for "how do I override the state dir from CI" reads three different stories depending on where they grep. |
| **Redesign** | `engine/env.ts` exporting a typed `DevstackEnv` interface and one `readEnv()` Effect that surfaces all overrides in one place, with precedence documented at the top. Each consumer reaches for `env.stateDir` instead of `process.env.DEVSTACK_STATE_DIR`. |
| **LoC Δ** | ~0 net (replace inline reads with helper calls), but each module's surface area shrinks. |
| **Bug class** | "What env vars does devstack respect?" — today the only answer is `grep`. A canonical registry doubles as the README's env-var reference. |

#### E38. `Schema.optional(Schema.Defect)` on every cause field

| | |
|--|--|
| **Where** | `engine/errors.ts` `cause: Schema.optional(Schema.Defect)` on 11 error classes. |
| **Evidence** | Every tagged error has the same `cause` field. Pretty-error walks it. It's required boilerplate. |
| **Redesign** | A `defineDevstackError(name, fields)` helper that stamps `cause: Schema.optional(Schema.Defect)` automatically. Removes 11 lines × 1 = 11 LoC, but more importantly enforces the convention. |
| **LoC Δ** | ~−10. |
| **Bug class** | None — convention enforcement. |

#### E39. Two `_tag` discriminator patterns: `Schema.TaggedErrorClass` vs `Data.TaggedError`

| | |
|--|--|
| **Where** | AGENTS.md says use `Schema.TaggedErrorClass`; `Data.TaggedError` still appears in codegen + faucet + CLI. |
| **Evidence** | grep `Data.TaggedError` finds ~6 sites. |
| **Redesign** | Sweep — migrate to `Schema.TaggedErrorClass`. AGENTS.md already mandates; this is a follow-up of E14. |
| **LoC Δ** | ~0. |

#### E40. Manifest schema lives in two parallel TS interfaces + Effect.Schema declarations

| | |
|--|--|
| **Where** | `runtime/manifest-schema.ts` has both `SuiManifest = Schema.Struct({...})` and `type SuiManifest = typeof SuiManifest.Type` (and the equivalent for every leaf). |
| **Evidence** | The `typeof X.Type` pattern is correct Effect; no LoC win. But the parallel TypeScript interfaces in `engine/registries.ts` for the `*StateRecord` types are HAND-MAINTAINED to mirror the Schema-described shape. |
| **Redesign** | Define each `*StateRecord` via `Schema.Struct(...)` (with `typeof ... .Type` for the TS type), so the registry shape is Schema-validated at publish time. AGENTS.md prescribes this for the manifest already; do the same for the registries. |
| **LoC Δ** | ~0 net (replace interfaces with Schema declarations) but enables Schema-validated registry boundaries — a new field added to a publish call wouldn't compile if the Schema doesn't carry it. |
| **Bug class** | The CoinRecord field grew several times this year (added `symbol`, `displayName`, `iconUrl`, `treasuryCapId`, etc.) — each addition had a "is this in the manifest schema too?" review check that could have been a Schema-compile-error. |

#### E41. JSDoc on public surface vs `internal.ts` rule

| | |
|--|--|
| **Where** | AGENTS.md's `internal.ts` rule says "Internal in a filename always means private to /advanced or below". Two `/services/X/internal.ts` files exist (seal: 1 243, walrus: 953) past the 600 LoC threshold that should have triggered a split. |
| **Evidence** | The integration-contract plan covers both. This audit notes only that the same pattern applies to engine: `engine/sui-build-container.ts` (662 LoC), `engine/snapshot.ts` (900 LoC), `engine/supervisor.ts` (2 023 LoC) all violate the 600-LoC default rule. |
| **Redesign** | Apply E8 (supervisor split) and the equivalent for snapshot.ts (it has 4 clear sections: pre-cleanup, save, restore, list) and sui-build-container.ts (inspect, dockerStart, dockerRunDetached, ensureContainer, runBuild, runSummary are independently testable). |
| **LoC Δ** | ~0 net. |

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

The fastest payoff cluster is "Cross-cutting" + "CLI consolidation" — both
fan out to independent subagents and individually-deliverable refactors.
The "Engine refactor" cluster gates on the integration-contract plan
landing first (so we don't fight on `containerPrimitive`'s shape).

## 4. Out of scope (consciously not chased)

- **`engine/docker/inventory.ts` shape.** 895 LoC of label-driven docker
  introspection. Big file, but the `RawContainer` / `RawNetwork` / `RawVolume`
  parsers are correct as-is; refactoring them buys hygiene only.
- **`engine/docker/router.ts` (file-provider materialization).** Hand-rolled
  YAML write + finalizer is necessary because traefik's docker-provider
  races the per-stack network attach (`docker-container.ts:1284` documents
  it). A redesign would need either a different router or a different
  attach order; both are out of audit scope.
- **`engine/sui-fork/*`.** The fork integration plan governs this; the
  per-data-dir lock is already shared via `engine/file-lock.ts` so the
  duplication risk is bounded.
- **The composite-tag (`composeLayers`) shape vs single-tag rule.** The
  integration-contract plan changes how composites work (via
  `onChainArtifact`); the substrate shape (`primary + projections`) is
  preserved across the change. Touching `composeLayers` now would conflict.
- **`engine/dep-graph.ts`.** 362 LoC of pure data + cycle detection +
  topo-levels. Already cleanly factored; no obvious win.
- **`engine/cache.ts` shape itself.** The contract is good. The win is in
  ADOPTION (integration-contract plan), not shape changes here.
- **The `RegistryShape<T>` API design.** The integration-contract plan
  explores `register(): subscribe`-style additions; defer to that work.
- **`tui/*`.** Out of scope per the request scope; covered separately.

## 5. LoC math summary

| Cluster | Δ LoC |
|---------|------:|
| E1 (adoptOrCreateContainer) | −380 |
| E2 (captureCommand) | −100 |
| E4 (ensureDir) | −80 |
| E5 (registry consolidation) | −200 |
| E6 (registry-network parser) | −30 |
| E7 (snapshot phases) | −60 |
| E8 (supervisor split) | 0 (refactor) |
| E9 (TagMetadata) | −70 |
| E10 (EngineHandle split) | +30 |
| E13 (one prettyError) | −30 |
| E16 (manifest projection table) | −180 |
| E17 (mutate-driven manifest emit) | −30 |
| E18 (discover-manifest collapse) | −30 |
| E19 (readStackContext) | −90 |
| E20 (forkSubcommand factory) | −417 |
| E22 (flag validation) | −40 |
| E23 (loaders consolidation) | −20 |
| E24 (stageAndSwap) | −100 |
| E25 (drop chmod) | −10 |
| E26 (fsOp helper) | −140 |
| E27 (bindings via withCache) | −80 |
| E29 (dockerContainer dual-form) | −30 |
| E31 (git-fetch contentHash) | −3 |
| E32 (playwright fallback) | −30 |
| E33 (vitest wrapper) | −100 |
| E34 (dev-wallet CSS extract) | −600 |
| E35 (dev-wallet controller) | −100 |
| E36 (WalletAdapter) | −150 |
| New substrate | +250 |
| **Total** | **−2 920** |

That's `−2 920` net LoC, before counting test-file simplifications and
before the integration-contract plan's `−2 500` (the two plans don't
overlap by construction). Cumulative: **~−5 400 LoC across both plans**.

The biggest single wins are E1 (adopt-or-create container), E20 (fork
CLI factoring), E34 (dev-wallet CSS extraction), E19 (readStackContext
consolidation), and E16 (manifest projection table). All five are
fan-out-safe and independently shippable.

---

End of audit. Pair this with `notes/integration-contract-redesign.md`
for the full simplification picture; the two plans together cover
service-layer cache+verify, container lifecycle, manifest/registry shape,
CLI introspection, codegen pipeline, and dev-wallet UI.
