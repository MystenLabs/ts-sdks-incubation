# engine-core

## Purpose

`engine-core` is the agnostic lifecycle substrate of devstack: the small Effect-v4 service that owns per-node lifecycle state transitions, the per-cycle scheduler that orders parallel topological build levels, the static dependency graph machinery that computes downstream-closures, the in-process restart/shutdown signalling queues that drive hot-restart, the selective per-primitive invalidation surface that closes only the affected scope subtree, and the per-primitive `withEngineLifecycle` wrap stamped onto every tag at factory time. It is what stays after stripping out the Docker layer, the TUI/plain/silent renderers, the per-service registries, and the snapshot/codegen/manifest pipelines. The current implementation is structurally a renderer-aware lifecycle bookkeeper — its public surface still produces shapes (`TuiState`, `TuiEntry`, `TuiHeader`, `TuiLog`) whose name and field structure reflect TUI consumption, even though the engine itself never renders.

## Current implementation

In-scope source files:

- `src/engine/engine.ts` (820 LOC) — `EngineHandle` Context.Service, `EngineHandleShape` interface, `EngineLive` Layer, `EndpointRegistryWithEngineLive` Layer; owns `Ref<TuiState>`, per-primitive scope registry `Ref<Map<string, Scope.Scope>>`, parallel shadow-cache `Ref<Map<string, unknown>>`, restart `Queue.dropping(1)`, shutdown `Deferred<void>`.
- `src/engine/supervisor.ts` (2112 LOC) — `defineDevstack`, `composeStackLayer`, `composeBootstrapLayer`, `buildBaseInfra`, `flattenStackMembers`, `compileWatchFilter`, `formatRestartCascade`, `formatShutdownAcquiringSummary`, `ownersFor`, `installSignalRestart`, `watchPathFiber`, the topological-level scheduler that uses `buildDepGraph` + `topoLevels` + `Layer.provideMerge`, the per-cycle `runOnce` body, the launch loop, the parallel-finalizer outer-scope plumbing for fast teardown, the hard-kill second-signal handler, and the `StackMember` / `DevstackConfig` / `DevstackHandle` / `WatchOwner` / `StackComposeOptions` interfaces. Much of this file is OUT of scope for this doc (orphan sweep, traefik bootstrap, signal SIGUSR2 handler details, hard-kill semantics) — the engine-core slice is the lifecycle machinery, scheduler, restart cascade, watch attribution, and the supervisor's interaction with `EngineHandle`.
- `src/engine/dep-graph.ts` (358 LOC) — `PrimitiveNode`, `DepGraph`, `DownstreamClosure`, `DepGraphMember`, `DepGraphError`, `buildDepGraph`, `computeDownstreamClosure`, `reachableConsumers`, `topoLevels`.
- `src/engine/phases.ts` (210 LOC) — per-domain phase-string tuples (`SuiPhases`, `WalrusPhases`, `SealPhases`, `DeepbookPhases`, `PythPhases`, `PostgresPhases`, `DeepbookIndexerPhases`, `DeepbookServerPhases`, `SuiCliPhases`, `PublishPhases`, `AccountPhases`, `CodegenPhases`, `WalletAppPhases`, `ManifestPhases`, `ManifestDiscoveryPhases`, `ConfigLoadPhases`) consumed by error classes and TUI overrides. The engine itself does NOT import this module — it's a vocabulary shared between error classes and pretty-error renderer; included here because phases are conceptually the engine's sub-status narration model.
- `src/advanced/tag.ts` (667 LOC) — `withEngineLifecycle` wrap, `provide`, `tag`, `composeLayers`, `setPhase`, `CurrentTagKey` reference, `LayeredTag` interface, `TuiDisplay` interface, `TagKind` type, `ProvideOptions`, `TagOptions`, `ComposeLayersOptions`, `resolveUpstreamKeys`, `DevstackTagBrand`. This is where the engine's contract is exposed to plugin authors — `withEngineLifecycle` is the glue that drives `markAcquiring` / `markReady` / `markFailed` automatically on every primitive's build.
- `src/engine/tui-state.ts` (139 LOC) — `TagStatus`, `TuiEntryKind`, `BuildStatus`, `TuiEntry`, `TuiHeader`, `TuiEndpoint`, `TuiLog`, `TuiState`, `TuiDimensions`. Internal-only; not re-exported from the root barrel. Engine reads/writes these shapes; renderers consume them.

In-scope test files:

- `src/engine/engine.test.ts` (438 LOC) — `EngineHandle.setPhase`, restart-signal `Queue.dropping(1)` semantics, `markFailed` root-cause extraction, Phase-3 selective-restart surface (shadow cache, invalidateSubset, scope finalization, sibling preservation, user-`r` vs watch-`invalidateSubset` split), Phase-3 deletion meta-tests (`notifyChangedTags`/`changedTags`/`clearChangedTags` are gone).
- `src/engine/supervisor.test.ts` (438 LOC) — `compileWatchFilter`, `DEFAULT_WATCH_EXCLUDES`, `formatRestartCascade` Phase-5 diagnostic surface (cascade enumeration, heavy-infra cost warning, owner dedupe), `flattenStackMembers` Phase-D composite restructure, `formatShutdownAcquiringSummary` SIGTERM summary.
- `src/engine/scheduler.test.ts` (220 LOC) — cross-level ordering, same-level parallel build, diamond resolution (one build via MemoMap), empty-stack and unkeyed-layer edge cases.
- `src/engine/dep-graph.test.ts` (386 LOC) — `buildDepGraph` (static graph derivation, watch-path capture, missing-key skip, dangling-upstream drop, duplicate-key first-wins, cycle detection), `computeDownstreamClosure` (strictly-downstream, diamond, independent subgraphs), `topoLevels` (leaves at L0, siblings same level, diamond, input-order preservation, empty graph, undeclared upstreams), `reachableConsumers`, Phase-A `__upstreamKeys` factory-time population (tag, provide, hostScript, dockerOneShot, dockerContainer, gitFetch, dockerImage, end-to-end).
- `src/engine/selective-restart.test.ts` (308 LOC) — P3.T4 end-to-end: watch-fire on `package` re-acquires `package`+`codegen`+`dev`, leaves `sui` untouched; mid-chain trigger; leaf trigger.

Totals: src LOC ≈ 4306 across the five primary modules; tests LOC ≈ 1790 across the five primary test files. The `supervisor.ts` file dominates by volume — engine-core surface is roughly half of it; the other half (renderer mount, identity, traefik, hard-kill handler) lives in adjacent docs.

## Configuration

Every knob the caller can set that reaches engine-core.

### `DevstackConfig` knobs that reach engine-core

(All cited via `supervisor.ts`.)

- `stack: ReadonlyArray<StackMember>` — the user stack. Required. Read at `supervisor.ts:200`, consumed by `composeStackLayer` (`supervisor.ts:1044`) and `defineDevstack` (`supervisor.ts:1324`). After `flattenStackMembers` (`supervisor.ts:1015-1028`) it is canonicalised by walking `__extraMembers`.
- `stateDir?: string` — passed through to `buildBaseInfra` (`supervisor.ts:401`). NOT consumed by engine-core directly; engine-resources owns this. Listed for completeness because `StackComposeOptions` carries it.
- `stackName?: string` — resolved via `resolveStackName` (`supervisor.ts:990-991`); precedence: explicit option → `DEVSTACK_STACK` env → `'main'`. Read at `supervisor.ts:1355, 1463`. Stamped into the TUI header (`supervisor.ts:1463, 1609-1614`).
- `network?: SuiNetwork` — defaults to `resolveNetwork()` else `'localnet'`. Read at `supervisor.ts:400, 1356, 1464`. Stamped into the TUI header.
- `extras?: ExtrasInput` — passed through to `composeStackLayer` (`supervisor.ts:1344`). NOT engine-core (it lives in `ExtrasLive`).
- `renderer?: RendererKind` (`'tui' | 'plain' | 'silent'`) — drives `resolveRendererKind` (`supervisor.ts:271-274`); defaults to `'tui'` when `process.stdout.isTTY === true`, else `'plain'`. Engine-core itself doesn't read renderer kind, but the supervisor uses it to decide the CI-fast-fail behaviour at `supervisor.ts:1743-1751` (non-`'tui'` first-cycle failure → non-zero exit).
- `rendererResolver?: RendererResolver` — see `resolveRendererFactory` (`supervisor.ts:282-294`).
- `rendererFactory?: RendererFactory` — pre-resolved factory wins over `renderer`/`rendererResolver`.
- `watch?: ReadonlyArray<string>` — explicit watch-set. Combined with per-primitive `__watchPaths` at `supervisor.ts:1415-1418`. Drives `compileWatchFilter` (`supervisor.ts:1419`), `watchOwners` (`supervisor.ts:1420-1432`), and `watchRoots` (`supervisor.ts:1433-1439`).
- `hotRestart?: boolean` — defaults to `watchRoots.length > 0` (`supervisor.ts:1460`). Only governs FILE-watch-driven restarts; the user-driven `r` gesture and SIGUSR2 always recycle.

### Environment variables read by engine-core

- `DEVSTACK_STACK` — fallback for `stackName` (`supervisor.ts:991`).
- `DEVSTACK_WARN_MISSING_UPSTREAM` — when set (any value), `composeStackLayer` prints one aggregate `console.warn` listing every keyed stack member missing `__upstreamKeys` (`supervisor.ts:1121-1137`). Treated as graph leaves either way; the env var is opt-in diagnostic noise for the migration to declared upstreams.
- `process.stdout.isTTY` — read once at `supervisor.ts:273` to default `renderer` to `'tui'` vs `'plain'`.

### Internal constants

- `LOG_BUFFER_LIMIT = 200` (`engine.ts:276`) — the bounded log tail length.
- `ERROR_SUMMARY_MAX = 80` (`engine.ts:338`) — per-row inline error summary cap.
- `SHUTDOWN_LOG_MESSAGE` (`supervisor.ts:104-105`) — fixed copy emitted via `engine.appendLog` on interrupt.
- `HEAVY_INFRA_COSTS` (`supervisor.ts:596-601`) — fixed map of `<key, cost-phrase>` for the diagnostic line. Hardcoded list, no user override.
- `DEFAULT_WATCH_EXCLUDES` (`supervisor.ts:749-786`) — always-applied negation patterns. No user override; the only opt-out is a positive include that lands in an excluded subtree (very unusual).
- `SHADOW_CACHE_PRESENT` (`engine.ts:285`) — unique-symbol sentinel.
- `defaultHeader` / `emptyState` (`engine.ts:287-302`) — initial `TuiState`. Deep-frozen.

### `ProvideOptions` knobs (per-primitive, factory-time)

Read by `provide()` / `tag()` in `advanced/tag.ts`, stamped onto the returned tag, then re-read by `composeStackLayer` and `defineDevstack` from each stack member:

- `kind?: TagKind` (`'service' | 'package' | 'account' | 'action' | 'app'`) — `tag.ts:127, 482, 566`; lands in `StackMember.__kind`; passed into `engine.markAcquiring` (`tag.ts:346`).
- `display?: (shape: A) => TuiDisplay` — `tag.ts:129`; called on success to project the resolved shape (`tag.ts:367-369`) and passed to `engine.markReady`.
- `displayTitle?: string` — `tag.ts:133, 483, 567`; lands in `StackMember.__displayTitle`; seeded by `engine.setEntryTitle` (`tag.ts:352`) and pre-seeded via `engine.seedTags` (`supervisor.ts:1382, 1384`).
- `plugin?: string` — `tag.ts:140, 487, 571`; lands in `StackMember.__pluginName`; passed to `engine.seedTags`.
- `hidden?: boolean` — `tag.ts:151, 488, 572`; lands in `StackMember.__hidden`; suppresses the row entirely (`tag.ts:341-343`, `supervisor.ts:1379`).
- `upstreamKeys?: ReadonlyArray<LayeredTag | string>` — `tag.ts:171, 489-496`; resolved via `resolveUpstreamKeys` (`tag.ts:412-427`); lands in `StackMember.__upstreamKeys`. Always stamped (even empty array) so `composeStackLayer` can distinguish "no upstreams" from "missing declaration."
- `watch?: ReadonlyArray<string>` — `tag.ts:201, 484, 568`; lands in `StackMember.__watchPaths`. Aggregated by `defineDevstack` (`supervisor.ts:1417`).
- `extraLayers?` (TagOptions only) — `tag.ts:508`; folded into `__layers` (`tag.ts:541-544`).

## Capabilities CONSUMED

Exhaustive. Engine-core today reaches into many adjacent components directly rather than receiving them as injected capabilities — this is documented as fact, not endorsed.

### Effect / Layer / Context machinery

`engine.ts` imports:

- `Cause` — `engine.ts:23, 380-410` for `markFailed`'s root-cause walk (`Cause.prettyErrors`, `Cause.pretty`, `cause.reasons`).
- `Context` — `engine.ts:23, 269-271` to declare `EngineHandle extends Context.Service<EngineHandle, EngineHandleShape>('@devstack/EngineHandle')`.
- `Deferred` — `engine.ts:23, 431, 607, 611` for the one-shot shutdown signal.
- `Effect` — `engine.ts:23` plus dozens of `Effect.gen`, `Effect.all`, `Effect.asVoid`, `Effect.as`, `Effect.scope`, etc.
- `Exit` — `engine.ts:23, 611, 668` for `Exit.void` to complete the shutdown deferred and close scopes.
- `Layer` — `engine.ts:23, 412-820` for `Layer.effect` constructors.
- `Queue` — `engine.ts:23, 423, 599, 605` for `Queue.dropping(1)`, `Queue.offer`, `Queue.take`.
- `Ref` — `engine.ts:23` throughout for `Ref.make`, `Ref.update`, `Ref.get`.
- `Scope` — `engine.ts:23, 191, 627, 656, 668` for `Scope.Scope` (the per-primitive scope type) and `Scope.close`.

`supervisor.ts` imports the same plus:

- `FileSystem`, `Path`, `Stdio`, `Terminal` (from `effect`) — for the `BootstrapServices` union and platform-layer wiring.
- `Stream` — `supervisor.ts:44, 508-524, 860-925` for `Stream.callback` (POSIX signal bridge) and `Stream.debounce` / `Stream.filter` / `Stream.runForEach` (watch debounce pipeline).
- `ChildProcessSpawner` (`effect/unstable/process`) — `supervisor.ts:49, 452, 1719`.
- `@effect/platform-node/NodeServices` — `supervisor.ts:47, 328` as `PlatformLive`.
- `@effect/platform-node/NodeRuntime` — `supervisor.ts:48, 2110` for `runMain`.

`dep-graph.ts` imports only `Schema` from `effect` (`dep-graph.ts:32`) to declare `DepGraphError extends Schema.TaggedErrorClass`.

`advanced/tag.ts` imports `Cause`, `Context`, `Effect`, `Layer`, `Scope` from `effect` (`tag.ts:38`).

### Engine resources (today: imported directly, NOT injected capabilities)

Engine.ts imports DIRECTLY from sibling modules — these are not received as capabilities through the EngineHandle service, they're built into the same Effect/Layer graph alongside the engine:

- `EndpointRegistry`, `EndpointRecord`, `RegistryShape` from `./registries.js` — `engine.ts:24`. The `EndpointRegistryWithEngineLive` layer (`engine.ts:802-820`) requires `EngineHandle` purely for merge-order stability — comment at `engine.ts:807-810` admits the layer "doesn't actually touch it anymore."
- `TagKind`, `TuiDisplay` from `../advanced/tag.js` — `engine.ts:34`. Engine API surface types (`markAcquiring`, `markReady`, `seedTags`) take these.
- Every `TuiState`/`TuiEntry`/`TuiHeader`/`TuiLog`/`BuildStatus`/`TuiEntryKind`/`TuiEndpoint` type from `./tui-state.js` — `engine.ts:25-33`.

Supervisor.ts imports the entirety of devstack's stateful infrastructure to build the bootstrap and stack layers — out of scope for this doc but listed as engine-core's compose-time reach:

- `StateStore`, `StateStoreConfig`, `StateStoreLive` (`supervisor.ts:88`) — engine-resources doc.
- `Identity`, `deriveAppName`, `validateIdentity` (`supervisor.ts:69`) — engine-resources doc.
- `Registry`, `RegistryLive`, `RegistryNetwork` (`supervisor.ts:71`) — engine-resources doc.
- `PortAllocatorLive`, `LeasingLive` (`supervisor.ts:70, 72`) — engine-resources doc.
- `FileWatcher`, `FileWatcherLive` (`supervisor.ts:68`) — engine-resources doc.
- All `*StateRegistryLive`, `PackageRegistryLive`, `AccountRegistryLive`, `CoinRegistryLive` (`supervisor.ts:74-87`) — per-service docs.
- `ClaimedContainers`, `dockerOrphanSweep` (`supervisor.ts:59`) — runtime-docker doc.
- `bootstrapRouterFor` (`supervisor.ts:60`) — runtime-docker doc.

### Surfaces the engine reaches INTO (current dependency that the rewrite will invert)

`engine.ts` consumes shapes whose canonical name is "TUI" even though the engine is the producer and the renderer is the consumer:

- `TuiState`, `TuiEntry`, `TuiHeader`, `TuiLog`, `TuiEndpoint`, `BuildStatus`, `TuiEntryKind` (`engine.ts:25-33`) — these belong to `tui-state.ts` (named for the consumer) yet the engine is their authoritative writer. `Ref.Ref<TuiState>` is the engine's primary state cell.
- `TuiDisplay` (from `advanced/tag.ts`) — the per-primitive value projection passed to `markReady` (`engine.ts:53, 464-490`). The engine doesn't render but takes the shape used by the renderer.

The `tui-state.ts` module's header comment (`tui-state.ts:1-19`) explicitly acknowledges this naming/ownership inversion: "Renderers under `tui/` … import these types as inputs. The reverse — engine importing tui/ — would invert the dependency." But because every field name (`title`, `primary`, `extras`, `endpoints`, `lastLog`, `selectiveRestart`) is rendering vocabulary, the engine is in practice expressing renderer concerns.

`supervisor.ts` further reads `TuiEntry` to drive `formatShutdownAcquiringSummary` (`supervisor.ts:709-724`) which is pure formatting glued onto the signal handler — engine state, renderer-domain string output.

### `advanced/tag.ts` consumes engine for the lifecycle wrap

- `EngineHandle` from `../engine/engine.js` (`tag.ts:39`) — `withEngineLifecycle` (`tag.ts:292-385`) optionally yields it via `Effect.serviceOption` (so primitives built outside a devstack still work) and calls `registerPrimitiveScope`, `markAcquiring`, `setEntryTitle`, `markReady`, `markFailed`, `appendLog` on it. The engine's R-channel cost is paid by `InfraLive` in `defineDevstack`.
- `Identity` from `../engine/identity.js` (`tag.ts:40`) — engine-resources, used to stamp span annotations.
- `annotateDevstackContext` from `../engine/observability.js` (`tag.ts:41`) — observability doc.
- `prettyError` from `../engine/pretty-error.js` (`tag.ts:42`) — observability doc; consumed by `summarizeCauseForLog` (`tag.ts:392`).

### External (none)

No process / network / filesystem dependencies from `engine.ts` or `dep-graph.ts`. `supervisor.ts` has many (`node:fs/promises`, `node:path`, `node:child_process` for the hard-kill path, the `minimatch` dep for watch globs at `supervisor.ts:50`) but they are out of scope for engine-core except where they touch lifecycle (`installSignalRestart`, the watch debounce stream, `formatShutdownAcquiringSummary`'s consumer).

## Capabilities PRODUCED

### `EngineHandle` service (`engine.ts:269-271`)

A `Context.Service<EngineHandle, EngineHandleShape>('@devstack/EngineHandle')`. Built once per supervisor lifetime by `EngineLive` (`engine.ts:412`) inside the bootstrap layer (`supervisor.ts:473-484`) so it survives `r` hot-restart cycles.

`EngineHandleShape` (`engine.ts:40-267`):

State cells:
- `tuiState: Ref.Ref<TuiState>` — public read for renderers; mutated only by engine methods.

Status transitions (idempotent unless noted):
- `markAcquiring(name: string, kind?: TagKind) => Effect.Effect<void>` — flip pending → acquiring. Auto-registers an entry for unknown keys (`engine.ts:326-329`) so inner tags fired by composite primitives appear in the dashboard.
- `markReady(name: string, display?: TuiDisplay) => Effect.Effect<void>` — flip acquiring → ready. Clears `phase`, `lastLog`, `selectiveRestart` on transition (`engine.ts:478-489`).
- `markFailed(name: string, cause: Cause.Cause<unknown>) => Effect.Effect<void>` — flip → failed. Extracts root-cause message via `summarizeCause` (`engine.ts:380-410`); walks `Cause.prettyErrors[0]` then `rawFailure(cause)` then falls back to outermost message; prefers tagged-error `stderr` over `message`; trims to 80 chars (`engine.ts:338, 388`).
- `markStopping(name: string) => Effect.Effect<void>` — flip ready → stopping. Best-effort even for unknown keys.
- `markStopped(name: string) => Effect.Effect<void>` — flip stopping → stopped.
- `markAllReady: Effect.Effect<void>` — flip every `pending`/`acquiring` entry to `ready` (`engine.ts:580-585`). Safety net for hand-rolled Layers that bypass the `tag` wrap.
- `markSelectiveRestart(keys: ReadonlySet<string>) => Effect.Effect<void>` — light up the affected set's `selectiveRestart: true` flag (`engine.ts:533-544`). Drops unknown keys silently. No-op for empty set.

Sub-status / metadata:
- `setPhase(key: string, phase: string) => Effect.Effect<void>` — push narration; no-op for unknown keys (`engine.ts:552-559`). Auto-cleared on ready/failed transitions.
- `setEntryTitle(name: string, title: string) => Effect.Effect<void>` — stamp friendly title before display projection runs.
- `setHeader(patch: Partial<TuiHeader>) => Effect.Effect<void>` — patch app/stack/network/buildStatus/cycle.
- `setBuildStatus(status: BuildStatus) => Effect.Effect<void>` — convenience wrapper for `setHeader({ buildStatus })`.

Initial seed:
- `seedTags(entries: ReadonlyArray<{key, kind?, title?, plugin?}>) => Effect.Effect<void>` — replace entries list with pending-shaped rows (`engine.ts:438-457`).

Logs:
- `appendLog(entry: TuiLog) => Effect.Effect<void>` — bounded ring of size `LOG_BUFFER_LIMIT = 200` (`engine.ts:561-566`).
- `appendTagLog(name: string, entry: TuiLog) => Effect.Effect<void>` — global log AND per-entry `lastLog` in one write so the row's detail column and the global tail can't drift (`engine.ts:570-576`).

Restart / shutdown signals:
- `awaitRestart: Effect.Effect<void>` — `Queue.take(restartQueue)` (`engine.ts:605`).
- `requestRestart: Effect.Effect<void>` — `Queue.offer(restartQueue, void 0)` non-blocking (`engine.ts:599`). Coalesces concurrent calls via `Queue.dropping(1)`.
- `awaitShutdown: Effect.Effect<void>` — `Deferred.await(shutdownSignal)` (`engine.ts:607`).
- `requestShutdown: Effect.Effect<void>` — `Deferred.done(shutdownSignal, Exit.void)` (`engine.ts:611`); idempotent.

Selective-restart machinery:
- `registerPrimitiveScope(key: string, scope: Scope.Scope) => Effect.Effect<void>` — record the primitive's layer scope + parallel write to shadow cache (`engine.ts:628-652`).
- `closePrimitiveScope(key: string) => Effect.Effect<void>` — drop the entry BEFORE closing the scope so a concurrent re-acquire sees consistent state (`engine.ts:653-669`). Silently no-ops on unknown key. Does NOT touch the shadow cache (test pin at `engine.test.ts:387-410`).
- `invalidateSubset(keys: ReadonlySet<string>) => Effect.Effect<void>` — for each key: evict shadow-cache entry, then `closePrimitiveScope`. Run with `Effect.all({ concurrency: 'unbounded', discard: true })` (`engine.ts:714-747`). No-op on empty set or unknown keys.
- `invalidateAll: Effect.Effect<void>` — enumerate every registered scope key and delegate to `invalidateSubset` (`engine.ts:753-757`).
- `_shadowCache: Ref.Ref<ReadonlyMap<string, unknown>>` — internal; exposed on the shape only so `engine.test.ts` can assert shadow-cache shape (`engine.ts:266`). Sentinel value `SHADOW_CACHE_PRESENT` (`engine.ts:285`).

### `EngineLive` Layer (`engine.ts:412`)

`Layer.Layer<EngineHandle>` — no requirements, no errors. Pure construction of `Ref`s, `Queue`, `Deferred`. Built once per supervisor lifetime and shared via MemoMap across hot-restart cycles.

### `EndpointRegistryWithEngineLive` Layer (`engine.ts:802-820`)

`Layer.Layer<EndpointRegistry, never, EngineHandle>`. Still requires `EngineHandle` for merge-order stability per the comment at `engine.ts:807-810` even though the body no longer touches it.

### State shapes published

From `tui-state.ts`:
- `TagStatus = 'pending' | 'acquiring' | 'ready' | 'failed' | 'stopping' | 'stopped'` (`tui-state.ts:37`).
- `TuiEntryKind = 'service' | 'package' | 'account' | 'action' | 'app' | 'other'` (`tui-state.ts:39`).
- `BuildStatus = 'idle' | 'running' | 'failed' | 'restarting' | 'shutting-down'` (`tui-state.ts:46`).
- `TuiEntry` (`tui-state.ts:48-89`) — `{key, kind, status, plugin?, phase?, error?, title?, primary?, extras?, endpoints?, lastLog?, selectiveRestart?}`.
- `TuiHeader` (`tui-state.ts:91-99`) — `{app, stack, network, buildStatus, cycle}`.
- `TuiEndpoint` (`tui-state.ts:101-105`) — `{name, url, kind?}`.
- `TuiLog` (`tui-state.ts:107-111`) — `{ts, level, message}`.
- `TuiState` (`tui-state.ts:113-134`) — `{entries, endpoints, logs, header, depTreeLevels?}`.
- `TuiDimensions` (`tui-state.ts:136-139`) — `{rows, columns}`.

Note: the engine populates everything but `depTreeLevels`. That field exists in the type but is documented as "Populated once at supervisor compose time" (`tui-state.ts:127-132`); no producer currently writes it (confirmed via `grep -rn "depTreeLevels" src/` returns only the type declaration). OPEN QUESTION: is this surface still planned, or stale? (Listed in Open Questions below.)

### Events / signals

- Restart signal — `Queue.dropping<void>(1)` (`engine.ts:423`). `requestRestart` offers; `awaitRestart` takes. Coalesces concurrent producers into a single wake; preserves a wake landing between `take` returning and the next `take` call.
- Shutdown signal — `Deferred<void>` (`engine.ts:431`). `requestShutdown` completes (`Deferred.done`, idempotent); `awaitShutdown` waits.
- Watch attribution → invalidation — engine itself doesn't dispatch watch events; `supervisor.ts`'s `watchPathFiber` (`supervisor.ts:849-939`) drives `markSelectiveRestart` + `invalidateSubset` from filtered+debounced FS events.

### TypeScript exports from engine-core

From `engine.ts`:
- `EngineHandle`, `EngineHandleShape`, `EngineLive`, `EndpointRegistryWithEngineLive`.

From `dep-graph.ts`:
- `PrimitiveNode`, `DepGraph`, `DownstreamClosure`, `DepGraphMember`, `DepGraphError`, `buildDepGraph`, `computeDownstreamClosure`, `reachableConsumers`, `topoLevels`.

From `phases.ts`:
- Per-domain tuples and types: `SuiPhases`/`SuiPhase`, `WalrusPhases`/`WalrusPhase`, `SealPhases`/`SealPhase`, `DeepbookPhases`/`DeepbookPhase`, `PythPhases`/`PythPhase`, `PostgresPhases`/`PostgresPhase`, `DeepbookIndexerPhases`/`DeepbookIndexerPhase`, `DeepbookServerPhases`/`DeepbookServerPhase`, `SuiCliPhases`/`SuiCliPhase`, `PublishPhases`/`PublishPhase`, `AccountPhases`/`AccountPhase`, `CodegenPhases`/`CodegenPhase`, `WalletAppPhases`/`WalletAppPhase`, `ManifestPhases`/`ManifestPhase`, `ManifestDiscoveryPhases`/`ManifestDiscoveryPhase`, `ConfigLoadPhases`/`ConfigLoadPhase`.

From `tui-state.ts`:
- `TagStatus`, `TuiEntryKind`, `BuildStatus`, `TuiEntry`, `TuiHeader`, `TuiEndpoint`, `TuiLog`, `TuiState`, `TuiDimensions`. (Internal-only; not re-exported through the root barrel — confirmed at `tui-state.ts:11-19`.)

From `supervisor.ts` (engine-core slice):
- `StackMember`, `DevstackConfig`, `DevstackHandle`, `RunOverrides`, `StackComposeOptions`, `WatchOwner`.
- `defineDevstack`, `composeStackLayer`, `flattenStackMembers`, `compileWatchFilter`, `DEFAULT_WATCH_EXCLUDES`, `formatRestartCascade`, `formatShutdownAcquiringSummary`, `ownersFor`.
- Re-export `DownstreamClosure` from `./dep-graph.js` (`supervisor.ts:583`) — kept on `supervisor.ts` for legacy import paths even though the type lives in `dep-graph.ts`.
- Re-export `RendererKind`.

From `advanced/tag.ts` (engine-core's contract to plugin authors):
- `provide`, `tag`, `composeLayers`, `setPhase`, `CurrentTagKey`, `resolveUpstreamKeys`, `DevstackTagBrand`.
- `LayeredTag`, `TagIdentity`, `TagKind`, `TuiDisplay`, `ProvideOptions`, `TagOptions`, `ComposeLayersOptions`, `HasLayers`-shaped union (internal).

## Lifecycle

### Engine startup (per supervisor lifetime — one `defineDevstack(...)` run)

Ordered steps inside `buildLaunchEffect` (`supervisor.ts:1480-2103`):

1. `composeBootstrapLayer({stackName, network, stateDir})` (`supervisor.ts:1474-1478`) constructs the bootstrap layer carrying `EngineLive`, `FileWatcherLive`, `StateStoreFullLive`, `IdentityLive`, `RegistryLive`, and platform services.
2. `composeStackLayer(config.stack, …)` (`supervisor.ts:1493-1499`) builds the user-stack layer ONCE per launch (hoisted out of the per-cycle loop). Composition order:
   1. `flattenStackMembers(rawStack)` (`supervisor.ts:1053`) expands `__extraMembers`.
   2. Duplicate-key guard warns (not throws) when two user-authored top-level members collide (`supervisor.ts:1084-1103`).
   3. `DEVSTACK_WARN_MISSING_UPSTREAM` opt-in aggregate warning (`supervisor.ts:1121-1137`).
   4. `buildDepGraph(stack)` (`supervisor.ts:1174`) builds the static graph.
   5. `topoLevels(graph)` (`supervisor.ts:1175`) partitions members into provider-before-consumer levels.
   6. Each level is `Layer.mergeAll`'d (siblings build concurrently); levels are stacked with `Layer.provideMerge` (`supervisor.ts:1257-1261`).
   7. Un-keyed hand-rolled layers fold into an ambient base via `provideMerge` (`supervisor.ts:1247-1252`).
   8. InfraLive (`InfraLiveCore` + StateStoreFullLive + IdentityLive + ExtrasInfraLive + optional `infraOverrides`) is merged into the user layer (`supervisor.ts:1283-1292`).
   9. PlatformLive wraps the whole thing as the outermost ring.
3. `Effect.scope` is captured as the outer `ambient` scope (`supervisor.ts:1824`); `Scope.fork(ambient, 'parallel')` produces `longLived` (`supervisor.ts:1825`).
4. `Layer.makeMemoMap` creates the single supervisor-lifetime memo map (`supervisor.ts:1833`).
5. `Layer.buildWithMemoMap(bootstrapLayer, memoMap, longLived)` builds the bootstrap context (`supervisor.ts:1835`). `EngineHandle` and `Registry` are extracted via `Context.get` (`supervisor.ts:1836-1837`).
6. Hard-kill SIGINT/SIGTERM handler installed (`supervisor.ts:1861-1984`). Out of scope here.
7. Registry announce + clearPid finalizer (`supervisor.ts:1991-2002`). Out of scope here.
8. `bootstrapRouterFor('up')` runs once (`supervisor.ts:2012`). Out of scope here.
9. Renderer mounted on `longLived` (`supervisor.ts:2030-2034`). Out of scope here.
10. `installSignalRestart('SIGUSR2', engine)` (`supervisor.ts:2041`) — out of scope here.
11. For each `root` in `watchRoots`, fork `watchPathFiber(root, engine, hotRestart, watchOwners, watchFilter, downstreamClosure)` on `bootstrapCtx` (`supervisor.ts:2042-2058`).
12. `launchLoop` begins iterating `runOnce` (`supervisor.ts:2060-2067`).

### Per-cycle (`runOnce`) lifecycle (`supervisor.ts:1535-1788`)

Each cycle (the body of the launch loop):

1. Fork `supervisorScope` off the ambient per-cycle scope with `'parallel'` finalizer strategy (`supervisor.ts:1567`).
2. Register `engine.invalidateAll` as a finalizer on `supervisorScope` (`supervisor.ts:1593`) — at scope-close it fires concurrently with the layer-build cascade.
3. `claimedRef = Ref.make<Set<string>>` (`supervisor.ts:1606`) — orphan-sweep claim set (out of scope).
4. `engine.setHeader({app, stack, network, buildStatus: cycle === 1 ? 'running' : 'restarting', cycle})` (`supervisor.ts:1608-1614`).
5. `engine.seedTags(seedEntries)` (`supervisor.ts:1624`) — re-seed every cycle so terminal statuses from the previous run reset to `pending`.
6. `Effect.race(Layer.buildWithMemoMap(userStackLayer, memoMap, supervisorScope) [adopting `ClaimedContainers`, with `Effect.catchCause` projecting `'failed'`], engine.awaitShutdown [projecting `'interrupted'`])` (`supervisor.ts:1652-1682`) — race the build against shutdown.
7. If `buildOutcome === 'interrupted'`: `setBuildStatus('shutting-down')`, return false from runOnce (`supervisor.ts:1694-1697`).
8. If `cycle === 1 && buildSucceeded`: docker orphan sweep (`supervisor.ts:1716-1726`) — out of scope.
9. If `cycle === 1 && !buildSucceeded && rendererKind !== 'tui'`: `setBuildStatus('shutting-down')`, `Effect.fail` (CI fast-fail, `supervisor.ts:1743-1751`).
10. `setBuildStatus('running')` (`supervisor.ts:1753`).
11. `Effect.race(engine.awaitRestart [→ 'restart'], engine.awaitShutdown [→ 'shutdown'])` (`supervisor.ts:1768-1771`).
12. If `reason === 'shutdown'`: `setBuildStatus('shutting-down')`, return false; outer `Effect.scoped` closes `supervisorScope`, cascading parallel finalizers (`supervisor.ts:1772-1780`).
13. Else: `setBuildStatus('restarting')`, return true; loop iterates (`supervisor.ts:1781-1782`).

### Per-node lifecycle (per primitive, inside `withEngineLifecycle`)

States `pending → acquiring → ready` or `pending → acquiring → failed`; teardown `ready → stopping → stopped` for primitives whose stop finalizers explicitly call `markStopping`/`markStopped` (Docker.run-driven; not all primitives do).

`withEngineLifecycle(name, build, classification)` (`tag.ts:292-385`) sequence at each primitive's Layer.effect build:

1. `Effect.scope` — capture the per-primitive layer scope (MemoMap-forked from the per-cycle supervisor scope).
2. `Effect.serviceOption(EngineHandle)` — engine optional (so the wrap is a no-op outside a devstack).
3. `Effect.serviceOption(Identity)` then `annotateDevstackContext(serviceLabel)` (`tag.ts:322-328`) — observability annotations. Out of scope here.
4. If engine absent: `build.pipe(Effect.provideService(CurrentTagKey, name))` and return (`tag.ts:329-335`).
5. If `classification.hidden === true`: same provide of `CurrentTagKey` with empty string (so `setPhase` is a no-op) and return (`tag.ts:341-343`) — engine never sees the tag, no row.
6. `engine.registerPrimitiveScope(name, primitiveScope)` (`tag.ts:345`).
7. `engine.markAcquiring(name, classification.kind)` (`tag.ts:346`).
8. If `classification.displayTitle` present: `engine.setEntryTitle(name, classification.displayTitle)` (`tag.ts:351-353`).
9. `build.pipe(Effect.onExit(exit => …))` — on Success: `engine.markReady(name, display?.(exit.value))`; on Failure: `engine.markFailed(name, exit.cause)` + `engine.appendLog({level: 'error', message: \`${name}: ${prettyError(exit.cause)}\`})` (`tag.ts:364-379`).
10. `Effect.provideService(CurrentTagKey, name)` so `setPhase` calls inside the body know which entry to update (`tag.ts:381-384`).

### Restart: full-stack hot-restart vs selective per-node

Two distinct paths exercising different engine surfaces:

**Full restart** (user-driven `r` keypress, SIGUSR2):
1. Renderer / signal handler calls `engine.requestRestart` (offers to the dropping queue).
2. Inside `runOnce`'s post-build `Effect.race`, `engine.awaitRestart` resolves.
3. `runOnce` returns `true`, the outer launch loop iterates.
4. The previous cycle's `supervisorScope` closes via `Effect.scoped` (`supervisor.ts:1785`); its `invalidateAll` finalizer runs concurrently with the layer-build cascade, closing every registered primitive scope in parallel.
5. The next cycle re-seeds tags, re-runs `Layer.buildWithMemoMap` against the same memoMap — MemoMap dedupes bootstrap services (EngineHandle survives) but evicts user-stack entries (their MemoMap entries were on `supervisorScope` which closed).

**Selective restart** (file-watch-driven, scoped to affected closure):
1. `watchPathFiber` (`supervisor.ts:849-939`) receives an `fs.watch` event.
2. The compiled `watchFilter` is applied; events failing the filter are dropped before debounce (`supervisor.ts:860-866`).
3. Stream is debounced by 250ms (`supervisor.ts:868`).
4. `hashFileIfChanged(event.path)` (`supervisor.ts:539-557`) compares content hash to `watchedFileHashes` map; "first sight" or "content changed" proceeds, "content unchanged" logs debug and returns.
5. `ownersFor(event.path, owners)` resolves the changed path to one or more `WatchOwner` records (`supervisor.ts:669-677`). Absolute-path comparison with prefix-with-separator handling.
6. If `matched.length > 0`:
   - `formatRestartCascade(matched, downstreamClosure)` (`supervisor.ts:633-660`) unions `{owner.key} ∪ closure.get(owner.key)` across all matched owners to compute `affected`; renders a message including cascade enumeration and heavy-infra warning.
   - `engine.markSelectiveRestart(affected)` — lights up `selectiveRestart: true` on affected rows.
   - `engine.invalidateSubset(affected)` — concurrent close of each affected scope + shadow-cache eviction.
7. If `matched.length === 0` (unowned watch path): `engine.requestRestart` — fall back to full restart.
8. After `invalidateSubset` returns, the watch fiber loops back to `runForEach`. The supervisor's per-cycle `Layer.buildWithMemoMap` is NOT explicitly re-run — but the next consumer's `yield*` on any affected key MUST re-acquire because both the scope is closed and the shadow-cache entry is gone. OPEN QUESTION: how does the consumer's re-acquire actually get triggered if `runOnce` is currently blocked on `awaitRestart`? The selective-restart machinery is documented (in code comments) to leave the supervisor's outer `runOnce` cycle untouched, so the affected primitives' Layer entries must be re-driven by something — most likely the next `yield*` from a non-affected consumer hitting the empty shadow cache and triggering a fresh Layer build via MemoMap. The `selective-restart.test.ts` end-to-end test models this by re-calling `acquirePrimitive` manually after `invalidateSubset`. (Listed in Open Questions.)

### Teardown: scope finalizers, LIFO ordering, parallel strategy

- The supervisor's outer `ambient` scope is forked with `Scope.fork(ambient, 'parallel')` to create `longLived` (`supervisor.ts:1825`) — every long-lived finalizer (renderer unmount, registry clearPid, hard-kill handler removal, watch fibers, SIGUSR2 detach) registered on `longLived` runs CONCURRENTLY on close.
- The per-cycle `supervisorScope` is similarly forked with `'parallel'` (`supervisor.ts:1567`).
- `engine.invalidateAll` is registered as a finalizer on `supervisorScope` (`supervisor.ts:1593`); on close it walks every registered primitive scope and closes them concurrently via `Effect.all({ concurrency: 'unbounded' })` (`engine.ts:734-746`).
- Critical reason: without parallel teardown, `docker stop --time N` finalizers fire sequentially — comment at `supervisor.ts:1551-1563` and `supervisor.ts:1808-1814` quantifies "sui=30s + indexer-db=20s + walrus×4=20s each + seal=15s" ≈ 145s worst case vs `~max(grace)` ≈ 30s with parallel.
- N concurrent teardowns: `invalidateSubset(keys)` with N entries runs N concurrent scope closes (`engine.ts:734-746`). The Effect docs on Scope guarantee `Scope.close` is idempotent (`engine.ts:247-249`); supervisor invoking `invalidateAll` BEFORE outer-scope cascade fires is intentional and safe — the cascade collapses to no-op when it later encounters Closed scopes.
- Engine restart-signal / shutdown-signal teardown: `Queue.dropping(1)` and `Deferred<void>` have no externalised finalizers; they die with `EngineLive`'s build scope when `longLived` closes.

## Hard requirements / invariants

The "this MUST happen or X breaks" list with citations.

1. **All `mark*` calls are idempotent / merge-not-replace.** A late `markAcquiring` after `markReady` would otherwise drop the resolved title/primary. Validated by `updateEntry` + `mergeEntry` (`engine.ts:310-334`), which `{ ...base, ...patch }`-merges patches over the prior row.
2. **Auto-register entries unknown at `markAcquiring` time.** Inner composite tags (seal keyserver/keymanager, per-account tags) fire `markAcquiring` for keys not present in `seedTags`'s initial list — engine treats this as "first sight, start tracking" rather than dropping the update (`engine.ts:319-329`).
3. **`setPhase` on unknown key is a no-op (no auto-register).** Phases are pure narration over an existing acquire — auto-registering would create kindless/titleless rows. Asserted by `engine.test.ts:82-89` ("is a noop for unknown keys").
4. **Phase, lastLog, selectiveRestart are cleared on `markReady` / `markFailed`.** Without this, a row showing `(running genesis)` next to a ready URL would confuse the user. Asserted by `engine.test.ts:48-79` and the patch object in `engine.ts:478-489, 494-499`.
5. **`markAllReady` safety net.** Hand-rolled Layers that bypass the `tag` wrap won't trigger lifecycle transitions; the supervisor (out of scope) calls this after a successful build to flip every leftover `pending`/`acquiring` to `ready`. `engine.ts:580-585`. The CURRENT supervisor doesn't appear to call it explicitly in the path I read — OPEN QUESTION whether it's still wired or has been superseded. (Listed in Open Questions.)
6. **Restart signal coalescing.** `Queue.dropping(1)` means concurrent `requestRestart`s coalesce into a single wake (`engine.ts:423`). Asserted by `engine.test.ts:136-157` ("concurrent requestRestart calls coalesce into a single wake").
7. **Restart-signal lost-wake-up safety.** A `requestRestart` arriving between `awaitRestart` returning and the next `awaitRestart` call MUST be preserved in the queue. Asserted by `engine.test.ts:159-181` ("regression: request during the wake → next-await gap is NOT lost"). Critical — the previous `Ref<Deferred>` design dropped these (history comment `engine.ts:135-141`).
8. **`requestShutdown` is idempotent.** `Deferred.done` is idempotent by Effect's contract; second-press / signal-handler-overlap MUST NOT throw (`engine.ts:608-611`).
9. **Shadow cache mirrors MemoMap by presence/absence only.** Value is a sentinel symbol; engine never reads the value. Asserted by sentinel comment (`engine.ts:278-285`).
10. **Shadow-cache eviction happens BEFORE scope close in `invalidateSubset`.** Symmetric with `closePrimitiveScope`'s "drop before close" so a concurrent re-acquire sees consistent state. `engine.ts:716-746` orders `Ref.update(shadowCache, delete)` before `closePrimitiveScope(key)`.
11. **`closePrimitiveScope` drops the registry entry BEFORE closing.** Otherwise a watcher firing during teardown would see the closed scope as "still registered" and skip the close. `engine.ts:660-668`.
12. **`closePrimitiveScope` does NOT touch the shadow cache.** Only `invalidateSubset` evicts. Asserted by `engine.test.ts:387-410` ("shadow cache survives an explicit close of an unrelated primitive scope") — load-bearing because the `r` path closes the outer scope without going through `invalidateSubset`.
13. **`invalidateSubset` is concurrent across keys.** Sequential close cascades stacked `docker stop` grace windows; parallel collapses to max(grace). Asserted by code structure (`Effect.all` with `concurrency: 'unbounded'`, `engine.ts:734-746`) and by the supervisor's `invalidateAll`-as-finalizer wiring (`supervisor.ts:1593`).
14. **`invalidateSubset` on unknown key is a no-op (no throw).** Dep graph and engine scope registry can disagree if a primitive failed before `registerPrimitiveScope`. Asserted by `engine.test.ts:327-346` ("P3.T2b — invalidateSubset on an unknown key is a no-op").
15. **`invalidateSubset({})` is a no-op.** Asserted by `engine.test.ts:348-359`.
16. **User-`r` path (`requestRestart`) MUST NOT call `invalidateSubset` nor touch scopes.** It closes the supervisor outer scope which cascades through MemoMap to every primitive scope; doing both would double-close. Asserted by `engine.test.ts:361-385`.
17. **Selective restart spares scopes outside the affected set.** This is THE invariant the feature exists to deliver — asserted by `engine.test.ts:308-325` ("P3.T3 — invalidateSubset spares scopes outside the affected set") and by `selective-restart.test.ts:103-211`.
18. **Topological scheduler: cross-level provider-before-consumer.** Asserted by `scheduler.test.ts:31-55, 57-84`. Consumer's level strictly exceeds any provider's level; `Layer.provideMerge` makes lower-level outputs visible to upper-level builds.
19. **Topological scheduler: same-level parallel build.** Asserted by `scheduler.test.ts:87-130` — two siblings sharing a Deferred-based join point both reach "started" without sequential deadlock.
20. **Topological scheduler: diamond resolution dedupes the shared provider.** Asserted by `scheduler.test.ts:132-175` — `buildCount === 1` even with two consumers.
21. **Topological scheduler: stable input order within a level.** Members keep declaration order so the TUI surfaces siblings in the user's authored sequence. Asserted by `dep-graph.test.ts:205-217` and `dep-graph.ts:336-338`.
22. **DepGraph cycle detection fails hard.** A typo'd `__upstreamKeys` annotation that forms a cycle throws `DepGraphError({phase: 'cycle', cycle: […]})` at compose time rather than infinite-looping the closure walk (`dep-graph.ts:181-213`). Asserted by `dep-graph.test.ts:88-112`.
23. **DepGraph drops dangling upstream references silently.** A primitive whose `dependsOn:` mentions a tag not in this stack composition is tolerated — its upstream edge is dropped. `dep-graph.ts:166-170`, asserted by `dep-graph.test.ts:66-74`.
24. **DepGraph skips members without `key`.** Hand-rolled Layer escape hatches have no identity; they aren't in the graph but their layers still ship via the un-keyed bucket. `dep-graph.ts:161-163`, `supervisor.ts:1184-1190`, asserted by `dep-graph.test.ts:54-64` and `scheduler.test.ts:188-219`.
25. **DepGraph duplicate-key: first occurrence wins.** Matches `composeStackLayer`'s duplicate-key handling. `dep-graph.ts:163-164`, asserted by `dep-graph.test.ts:76-86`.
26. **`__upstreamKeys` always stamped (even empty array) by `provide`/`tag`.** So `composeStackLayer` can distinguish "primitive has no upstreams" from "primitive forgot to declare." `tag.ts:489-496`, the migration warning at `supervisor.ts:1121-1137`.
27. **`__upstreamKeys` dedupes across LayeredTag and bare-string entries.** Asserted by `dep-graph.test.ts:287-293`.
28. **`flattenStackMembers` walks nested `__extraMembers` recursively.** A composite inside another composite's extras must still be flattened. Asserted by `supervisor.test.ts:246-262`.
29. **`flattenStackMembers` returns leaves unchanged.** `supervisor.test.ts:286-300`.
30. **DownstreamClosure is strictly-downstream (owner NOT in its own closure).** So a single-primitive cascade reads `"0 downstream"` not `"1 downstream: self"` and so callers union `{owner} ∪ closure[owner]` explicitly. `dep-graph.ts:67-83, 245-265`, asserted by `dep-graph.test.ts:115-145`.
31. **Watch attribution: positive bare paths only.** Globs and `!`-negations contribute to the filter but NOT to `watchOwners`. `supervisor.ts:1426-1432`, asserted by `dep-graph.test.ts:42-52` for the graph side.
32. **Watch filter: positive AND not-negated.** A path triggers restart iff some positive pattern matches AND no negation matches. `DEFAULT_WATCH_EXCLUDES` always prepended. Asserted by `supervisor.test.ts:34-102`.
33. **`hashFileIfChanged` short-circuits when bytes unchanged.** Format-on-save with no diff must NOT trigger a restart. `supervisor.ts:539-557`. Limitation noted: trailing event in a multi-file save window reports the last changed file only.
34. **Watch fire on owned path uses `invalidateSubset` (selective).** `supervisor.ts:884-908`. Watch fire on unowned path uses `requestRestart` (full). Asserted by selective-restart e2e tests and the `formatRestartCascade` shape tests.
35. **`formatRestartCascade` co-derives log message AND affected set.** Same call produces both so the diagnostic line and the engine signal can't drift. `supervisor.ts:633-660`, asserted by `supervisor.test.ts:115-208`.
36. **Heavy-infra cost warning is NOT user-opt-out.** Hardcoded list at `supervisor.ts:596-601`; the comment explicitly says "If a dep graph routes Sui/Walrus downstream of a watch-fire, that's a graph bug — fix the graph, don't silence the warning."
37. **`markFailed` walks the cause chain to the innermost message.** The outer wrapper's generic preamble would consume the 80-char budget. Asserted by `engine.test.ts:184-209`.
38. **`markFailed` prefers tagged-error `stderr` over `message`.** Docker/sui-cli stderr is what the user must copy. Asserted by `engine.test.ts:211-230`.
39. **`appendLog` is bounded to 200 entries.** Long-running stacks must NOT grow the Ref unbounded. `engine.ts:276, 564`.
40. **`appendTagLog` updates global log AND per-entry `lastLog` in one Ref update.** The two views can't drift. `engine.ts:570-576`.
41. **Engine `Ref<TuiState>` is the single source of truth.** Renderers and the hard-kill handler both read it directly via `Ref.getUnsafe(engine.tuiState)` (`supervisor.ts:1884`) — re-derivation would silently miss state set via `setPhase` etc.
42. **Engine state survives `r` cycles.** `EngineLive` is built on `longLived`, not on the per-cycle `supervisorScope`. `supervisor.ts:1466-1478, 1825-1836` carefully comment this — pre-fix the bootstrap was per-cycle and a `r` re-opened the state.json.lock + re-mounted watchers + re-installed handlers.
43. **`Notify*ChangedTags` API is permanently removed.** Phase 3 deletion ratchet via `@ts-expect-error` assertions in `engine.test.ts:413-438` ensures the `notifyChangedTags` / `changedTags` / `clearChangedTags` surfaces don't come back.
44. **`Effect.race(awaitRestart, awaitShutdown)` in the runOnce post-build wait.** Shutdown wins → exit cleanly; restart wins → next cycle. `supervisor.ts:1768-1782`. The race vs `awaitShutdown` is mirrored against the layer build itself (`supervisor.ts:1652-1682`) so a `q` mid-build short-circuits acquire instead of waiting for every primitive's retry budget.
45. **`registerPrimitiveScope` overwrites on second call for the same key.** Watcher fiber may rebuild a primitive mid-cycle via `invalidateSubset`; the next acquire's wrap registers fresh. `engine.ts:179-184, 628-651` — `Map.set` overwrites.
46. **`Layer.buildWithMemoMap` not `Layer.build` in the per-cycle path.** Single memoMap is held for supervisor lifetime; bootstrap entries are reused across cycles, user-stack entries rebuild fresh on `supervisorScope`. `supervisor.ts:1833, 1653-1656`.

## Failure modes

Engine-machinery failure surfaces (NOT service failures).

### `DepGraphError({phase: 'cycle'})` at compose time

Trigger: `__upstreamKeys` annotations form a cycle. Current behavior: thrown synchronously inside `composeStackLayer` (`dep-graph.ts:206-212`). Per code comment + plan citation at `dep-graph.ts:113-115`: "Dep-graph failure is a hard error. No fallback to the old full-restart loop." Recovery: user must fix the annotation; no runtime mitigation.

### Layer build failure mid-cycle (primitive acquire fails)

Trigger: any user primitive's build effect fails. Current behavior: `Effect.catchCause` (`supervisor.ts:1660-1679`) intercepts the failure inside the `Effect.race`, projects to `'failed'`, writes `prettyError(cause)` to stderr (non-TUI renderers only) and via `engine.appendLog`. Per-primitive lifecycle: the wrap's `Effect.onExit` (`tag.ts:364-379`) has already called `markFailed` + appended its own log line — so by the time the outer catch fires, the affected row is already red.

Recovery: in TUI mode, supervisor falls through to `engine.awaitRestart` so the user can press `r` after fixing the bug (`supervisor.ts:1755-1771`). In non-TUI mode (`'plain' | 'silent'`) on the first cycle, supervisor calls `Effect.fail` with a non-zero exit (`supervisor.ts:1743-1751`) — CI fast-fail.

### Watch fiber errors (fs.watch failure for one watched path)

Trigger: `fs.watch` on a path throws or emits a defect. Current behavior: `Effect.catchCause` (`supervisor.ts:933-935`) collapses to `Effect.logWarning(\`file watcher for ${path} failed: …\`)`. The single fiber dies but the supervisor and sibling watchers stay up.

Recovery: none automatic — once a watcher fiber dies, that root is unwatched until next supervisor lifetime. (Possibly a wrong abstraction; noted in Pain points.)

### `hashFileIfChanged` throw

Trigger: read failure on a watched file (race with delete, permissions, etc.). Current behavior: `Effect.catch(() => Effect.succeed({changed: true, reason: 'hash failed'}))` (`supervisor.ts:557`) — fail-open. Recovery: the restart proceeds; next save re-hashes successfully.

### `closePrimitiveScope(unknown key)` / `invalidateSubset({unknown})`

Trigger: dep-graph and scope-registry disagree (primitive failed before `registerPrimitiveScope`). Current behavior: silent no-op (`engine.ts:656-658`, `engine.ts:716`). Recovery: not needed — a missing scope just means there's nothing to close.

### Restart signal in the wake/next-await gap

Trigger: producer fires between `awaitRestart` returning and the next loop's `awaitRestart` call. Current behavior: queue preserves the wake; next take returns immediately (`engine.ts:419-423, 599, 605`). Recovery: built-in to the data structure.

### `requestShutdown` called twice (double Ctrl-C scenario at the engine layer)

Trigger: q-keypress + signal both fire. Current behavior: `Deferred.done` idempotent (`engine.ts:608-611`). Recovery: built-in.

### Concurrent `invalidateAll` + outer-scope cascade

Trigger: shutdown path — `engine.invalidateAll` is registered as a finalizer on `supervisorScope`, so it fires concurrently with the layer-build cascade. Current behavior: `Scope.close` is idempotent (`engine.ts:247-249`) — second-closer collapses to no-op. Recovery: built-in.

### Build cycle interrupted mid-acquire (`q` press during layer build)

Trigger: the `Effect.race(buildEffect, awaitShutdown)` is won by shutdown (`supervisor.ts:1652-1682`). Current behavior: build effect interrupted, partial-acquire primitives' Layer scopes roll back on `supervisorScope`, `setBuildStatus('shutting-down')`, return false (`supervisor.ts:1694-1697`). Critically, orphan sweep is SKIPPED because `claimedRef` is incomplete (`supervisor.ts:1708-1715`).

### Hand-rolled Layer escape hatch that never calls the engine

Trigger: a primitive bypasses `provide`/`tag` and supplies a hand-rolled `Layer` directly. Current behavior: no engine row, no markAcquiring, no scope registration; the layer's own scope is part of the per-cycle `supervisorScope` tree, so on shutdown the outer cascade catches it. `markAllReady` is the safety net (engine.ts:580-585) — though as noted in Open Questions, current callers of it are unclear.

## Persistence model

Engine itself persists NOTHING.

- The `Queue.dropping(1)` restart signal is in-process only.
- The `Deferred<void>` shutdown signal is in-process only.
- The `Ref<TuiState>` is in-process only.
- The per-primitive scope registry `Ref<Map<string, Scope.Scope>>` is in-process only — scopes are runtime objects.
- The shadow-cache `Ref<Map<string, unknown>>` is in-process only.
- The `watchedFileHashes` map (`supervisor.ts:537`) is in-process only; survives `r` cycles but not process exit.

All persistent state belongs to engine-resources (state-store), the file-lock, the port allocator, identity, paths — none owned by engine-core.

## Modes & variants

Renderer modes (`'tui' | 'plain' | 'silent'`) affect engine startup in two narrow ways:

1. **Default renderer selection** — `process.stdout.isTTY === true ? 'tui' : 'plain'` (`supervisor.ts:271-274`). Doesn't change engine behaviour, only the renderer factory used.
2. **CI fast-fail gate** — first-cycle build failure in non-TUI mode triggers `Effect.fail` (non-zero process exit, `supervisor.ts:1743-1751`); first-cycle build failure in TUI mode falls through to `awaitRestart` so the user can press `r`. The engine itself doesn't care; the supervisor branches on `rendererKind`.
3. **Stderr write on build failure** — non-TUI renderers also receive a synchronous `process.stderr.write(\`stack acquire failed:\\n${rendered}\\n\`)` belt-and-braces because the plain renderer's 500ms poll may not flush before `Effect.fail` exits (`supervisor.ts:1669-1671`).

Engine itself is single-mode — its public surface and state shape don't vary by renderer.

Other variant axes (network: `'localnet' | 'testnet' | 'mainnet' | 'devnet'`) affect state-store path layout (engine-resources doc), header rendering, and identity validation — not engine-core lifecycle.

## Test coverage

### `src/engine/engine.test.ts` (438 LOC)

`describe('EngineHandle.setPhase')`:
- `it.effect("updates the entry's phase while it is acquiring")` — `setPhase` stamps `phase` while `status === 'acquiring'`.
- `it.effect('overwrites prior phase on subsequent calls')` — last `setPhase` wins.
- `it.effect('clears phase automatically on transition to ready')` — `markReady` resets `phase` to undefined.
- `it.effect('clears phase automatically on transition to failed')` — `markFailed` resets `phase` to undefined; `error` carries the short summary.
- `it.effect('is a noop for unknown keys (no auto-register)')` — `setPhase` on a never-seeded key produces zero entries.

`describe('EngineHandle restart signaling — Queue.dropping semantics')`:
- `it.live('awaitRestart blocks when no request is pending')` — forked await is still pending after 20ms.
- `it.effect('requestRestart wakes a pending awaitRestart')` — basic round-trip.
- `it.live('concurrent requestRestart calls coalesce into a single wake')` — 8 concurrent offers + 1 take + 1 await proves the second await blocks (only one wake was preserved).
- `it.effect('regression: request during the wake → next-await gap is NOT lost')` — pins the queue-vs-Ref-Deferred fix.

`describe('EngineHandle.markFailed root-cause extraction')`:
- `it.effect('walks the cause chain to the innermost message for the row summary')` — `SuiCliError` wrapped in `PublishError`; row surfaces the inner.
- `it.effect('prefers tagged-error stderr over message when both are present')` — `DockerError.stderr` wins over `DockerError.message`.

`describe('EngineHandle selective-restart surface — Phase 3')`:
- `it.effect('P3.T1 — shadow cache is populated on registerPrimitiveScope and evicted on invalidateSubset')` — siblings outside affected set survive.
- `it.effect('P3.T2 — invalidateSubset closes the primitive scope and runs finalizers')` — finalizers fire.
- `it.effect('P3.T3 — invalidateSubset spares scopes outside the affected set')` — THE selective-restart invariant.
- `it.effect('P3.T2b — invalidateSubset on an unknown key is a no-op')` — no throw, no side effects.
- `it.effect('P3.T2c — invalidateSubset({}) is a no-op')`.
- `it.live('P3.T5 — user-r path (requestRestart) does NOT call invalidateSubset and does NOT touch scopes')`.
- `it.effect('shadow cache survives an explicit close of an unrelated primitive scope')` — `closePrimitiveScope` alone does not evict.

`describe('EngineHandle meta-tests — Phase 3 deletions')`:
- `it.effect('notifyChangedTags is gone from the EngineHandleShape')` — three `@ts-expect-error` lines ratchet the deletion.

### `src/engine/supervisor.test.ts` (438 LOC) (engine-core slice)

`describe('compileWatchFilter — gitignore-style include + negation')`:
- `it('positive bare path: matches the dir itself AND descendants')`.
- `it('positive bare path: does NOT match siblings or other trees')`.
- `it('default excludes win even when path is under a positive include')` — `**/Move.lock`, `**/build/**`, etc.
- `it('user negation: \`!path/to/x\` excludes that subtree from an outer positive include')`.
- `it('Codegen-style negation-only declaration: contributes filter, not a watch root')`.
- `it('absolute paths: passed through unchanged')`.
- `it('anchored-anywhere glob (\`**/*.move\`): matches any depth')`.
- `it('empty pattern set: nothing matches (positive-include required)')`.

`describe('formatRestartCascade — Phase 5 diagnostic surface')`:
- `it('enumerates downstream consumers when the closure is provided')` — `"2 downstream: codegen, dev"`.
- `it('falls back to owner-only shape when closure is undefined')` — forward-compat path.
- `it('annotates Sui in the affected set with reboot-cost warning (R4 mitigation)')` — `"Sui — ~90s reboot expected"`.
- `it('skips the reboot-cost warning when no heavy infra is in the affected set')`.
- `it('unions cascade across multiple matched owners (overlap deduped)')`.
- `it('warns once for Walrus / Seal heavy-infra (same as Sui)')` — dedup inside the `affected:` suffix.

`describe('flattenStackMembers — Phase D composite restructure')`:
- `it("expands a composite's __extraMembers to top-level after the parent")`.
- `it('walks nested __extraMembers (composite inside __extraMembers)')`.
- `it('lifted siblings participate in buildDepGraph + downstream closure')`.
- `it('returns a leaf member unchanged (no __extraMembers)')`.
- `it('preserves member ordering for non-composite siblings')`.

`describe('formatShutdownAcquiringSummary — Phase 3.4 SIGTERM summary')`:
- `it('returns empty string when no tag is acquiring')`.
- `it('returns empty string for an empty entry list')`.
- `it('lists each acquiring tag with its phase')`.
- `it('renders "(no phase)" for an acquiring tag whose phase is not set')`.
- `it('filters out non-acquiring entries')`.
- `it('aligns the phase column across rows with different key lengths')`.
- `it('uses the default preamble for the first-SIGTERM line')`.
- `it('respects a custom preamble for the second-SIGTERM line')`.
- `it('terminates the summary block with a trailing newline')`.

### `src/engine/scheduler.test.ts` (220 LOC)

`describe('composeStackLayer scheduler — cross-level ordering')`:
- `it.effect('a consumer declared after its provider via upstreamKeys still resolves')`.
- `it.effect('declared upstreams resolve in level-then-input order (no fold required)')` — consumer declared first in input array still gets level 1.

`describe('composeStackLayer scheduler — same-level parallel build')`:
- `it.effect('two siblings with no cross-dep build concurrently')` — Deferred-based join-point proof.

`describe('composeStackLayer scheduler — diamond resolution')`:
- `it.effect('two consumers of a shared provider both see the same instance')` — `buildCount === 1` via MemoMap.

`describe('composeStackLayer scheduler — degenerate inputs')`:
- `it.effect('empty stack produces a buildable layer with no extra services')`.
- `it.effect('un-keyed hand-rolled layers still ship via level 0')` — verifies the unkeyed-bucket path.

### `src/engine/dep-graph.test.ts` (386 LOC)

`describe('buildDepGraph')`:
- `it('derives-static-graph: each node carries the expected upstream keys')` — fixture sui ← package ← codegen ← dev.
- `it('watch-paths-attached: positive includes surface on the node, negations drop')`.
- `it('skips members without a key (hand-rolled layers)')`.
- `it('drops dangling upstream references (stale annotation surface)')`.
- `it('keeps the first occurrence on duplicate keys')`.
- `it('cycle-detection: a cyclic graph fails with DepGraphError(phase=cycle)')`.

`describe('computeDownstreamClosure')`:
- `it('computes-downstream-closure: closure is strictly-downstream (owner NOT included)')`.
- `it('handles a diamond: two consumers share an upstream')`.
- `it('isolates independent subgraphs (sibling stacks share nothing)')`.

`describe('topoLevels')`:
- `it('emits leaves at level 0 and consumers at higher levels')`.
- `it('groups independent siblings into the same level')`.
- `it('handles a diamond (consumer waits for both upstreams)')`.
- `it('preserves input order within a level (stable per-level emission)')`.
- `it('returns an empty array for an empty graph')`.
- `it('treats undeclared upstreams as leaves (missing __upstreamKeys)')`.

`describe('reachableConsumers')`:
- `it('returns the strictly-downstream set for a known owner')`.
- `it('returns an empty set for an unknown owner key')`.

`describe('Phase A: __upstreamKeys population at factory time')`:
- `it('tag() resolves LayeredTag entries to their .key')`.
- `it('tag() accepts bare-string upstream keys (forward-declared deps)')`.
- `it('tag() dedupes upstream keys (composite + bare-string overlap)')`.
- `it('hostScript auto-derives __upstreamKeys from dependsOn')`.
- `it('hostScript declares empty __upstreamKeys when no dependsOn is set')`.
- `it('dockerOneShot auto-derives __upstreamKeys from dependsOn')`.
- `it('dockerOneShot declares empty __upstreamKeys when no dependsOn is set')`.
- `it('dockerContainer declares its inner image tag as an upstream')`.
- `it('dockerContainer with {tag: ...} surfaces no inner image upstream')`.
- `it('gitFetch declares no upstream keys (leaf primitive)')`.
- `it('dockerImage declares no upstream keys (leaf primitive)')`.
- `it('buildDepGraph + computeDownstreamClosure read the populated field')` — end-to-end.

### `src/engine/selective-restart.test.ts` (308 LOC)

`describe('P3.T4 — selective-restart end-to-end')`:
- `it.effect('a watch-fire on package only re-acquires package + downstream (codegen, dev); sui stays live')` — the canonical selective-restart test. Cycle 1 acquires all four; trigger on `package`; finalizers for `package`/`codegen`/`dev` fire (count 1 each) but `sui`'s does not; re-acquire `package`/`codegen`/`dev` (counts 2); `sui`'s count stays at 1.
- `it.effect('a watch-fire on codegen only re-acquires codegen + dev; sui + package stay live')` — mid-chain trigger.
- `it.effect('a watch-fire on dev (leaf) only re-acquires dev itself; upstream stays live')` — leaf trigger with empty downstream set.

## Pain points today

Where engine-core's current implementation fights what an agnostic substrate should be.

1. **Engine.ts depends on `TuiDisplay`, `TagKind`, `TuiState`, `TuiEntry`, `TuiHeader`, `TuiLog` from neighbors (`engine.ts:25-34`).** These names and field shapes (`title`, `primary`, `extras`, `endpoints`, `lastLog`, `selectiveRestart`) are renderer vocabulary. An agnostic lifecycle engine would publish a domain-neutral state model — a renderer would project it. The `tui-state.ts` header (`tui-state.ts:1-19`) admits this is an inverted dependency and rationalises it as "internal-only plumbing."

2. **`markReady` takes a `TuiDisplay` projection (`engine.ts:53, 464-490`).** The engine is being asked to remember a display projection rather than the resolved primitive value. A renderer-agnostic engine would store a generic "result" payload and the renderer would project per-row.

3. **`appendTagLog` performs renderer-domain merging in the engine.** The engine writes both the global log and the per-entry `lastLog` in one atomic update (`engine.ts:570-576`) to keep the two views in sync — but "per-entry log tail" is a renderer concept; the engine should publish raw log lines and let the renderer derive the tail.

4. **Per-domain phase tuples in `phases.ts` (210 LOC) — engine module that engine.ts never imports.** It's a vocabulary shared between error classes and `pretty-error.ts` (observability doc). Coupling phase strings to error classes means renaming a phase is a downstream breaking change — comment at `phases.ts:18-20` calls this out. An agnostic engine would treat phases as opaque strings.

5. **The shadow cache exists ONLY because Effect's `MemoMap` doesn't surface per-entry eviction.** Comment at `engine.ts:671-712` is the most architecturally fraught block in the file — it's "a parallel `Map<tagKey, unknown>` mirroring Effect's MemoMap entries by tag identity" because "MemoMap key extraction is rejected as too fragile to internal Effect changes." The shadow cache is a workaround; the real ask is upstream-Effect surface for surgical MemoMap eviction. The sentinel-value-only design means the engine is paying memory + bookkeeping cost just for a presence bit.

6. **`EndpointRegistryWithEngineLive` still requires `EngineHandle` in R "for merge-order stability" even though it doesn't touch it (`engine.ts:802-820, 807-810`).** A leaked dependency, retained because flipping its R channel back to `never` would "shuffle the `InfraLive` composition." Wrong abstraction.

7. **`StackMember` (`supervisor.ts:113-195`) is double-stamped through bespoke `__layer`, `__layers`, `__extraMembers`, `__kind`, `__displayTitle`, `__watchPaths`, `__pluginName`, `__upstreamKeys`, `__hidden`.** Engine and supervisor both read these via runtime structural narrowing (`(m as { __extraMembers?: ... })`). A proper substrate would model a `StackNode` with explicit construction rather than tag mutation via `Object.assign` (`tag.ts:498-499`).

8. **`provide()` mutates the canonical Context.Service class via `Object.assign` (`tag.ts:498`).** The comment at `tag.ts:441-447` rationalises this as "one canonical tag per stack means one provide call per stack, so the mutation is one-shot in practice." But the class identity is now state-dependent — calling `provide(SuiTag, ...)` again in another factory composition mutates the same global class. A composable substrate would return a new object each time.

9. **Shutdown copy is duplicated between supervisor and TUI components (`supervisor.ts:104-105`).** Comment admits "the constant is duplicated deliberately so the supervisor doesn't import upward into `tui/`." The duplication is a symptom of engine code knowing rendering vocabulary.

10. **`HEAVY_INFRA_COSTS` hardcodes per-service tag keys and reboot estimates inside engine-core (`supervisor.ts:596-601`).** The agnostic lifecycle substrate is asserting opinions about Sui and Walrus specifically. Per-service primitives should declare their own cost annotations; the supervisor should look them up.

11. **`supervisor.ts` is 2112 LOC.** Mixes engine-core (scheduler, dep graph wiring, watch dispatch, restart loop) with engine-resources (state-store / file-lock / identity build), runtime-docker (orphan sweep, traefik bootstrap, hard-kill), and observability (signal handlers, log routing). A proper substrate would partition these.

12. **The seed pass duplicates the `__kind`/`__displayTitle`/`__pluginName` extraction logic (`supervisor.ts:1369-1389`).** Same shape is unpacked in `composeStackLayer` (`supervisor.ts:1080-1102`), `flattenStackMembers` (`supervisor.ts:1015-1028`), and watch-owner aggregation (`supervisor.ts:1420-1432`). One canonical projection would suffice.

13. **`Effect.race(awaitRestart, awaitShutdown)` is restated twice (post-build at `supervisor.ts:1768` and during-build at `supervisor.ts:1652`).** Both paths need the same priority semantic; an extracted helper would reduce the duplication and the risk of drift.

14. **`installSignalRestart('SIGUSR2', engine)` is forked at the supervisor's lifetime (`supervisor.ts:2041`), but the comment explicitly says "Effect v4 doesn't expose POSIX signal handling in core or `@effect/platform-node`" (`supervisor.ts:499-502`).** Wrong abstraction temporarily; should collapse once upstream surfaces it.

15. **`Layer.empty` cast through `unknown as Layer.Layer<any, any, any>` repeatedly (`supervisor.ts:1207, 1217, 1251, 1257`).** Wide-cast in scheduler folds because the seed type is too narrow for the fold accumulator. Per-fold cast indicates the abstraction's boundaries leak.

16. **`composeStackLayer` reads `(member as { key?: string }).key` and `(m as { __extraMembers?: ReadonlyArray<StackMember> }).__extraMembers` — every field accessed via runtime structural narrowing (`supervisor.ts:1080-1090, 1126-1129, 1184-1190`).** TS isn't helping because `StackMember` is too permissive (every `__*` field is optional). A discriminated union (LayeredTag-shape vs hand-rolled-Layer-shape) would let TS narrow.

17. **`depTreeLevels` is in `TuiState` (`tui-state.ts:118-133`) but nothing writes it.** Dead field today.

18. **Engine's restart signal and shutdown signal are conceptually parallel — both unidirectional in-process pub/sub — but use different primitives (`Queue.dropping(1)` vs `Deferred<void>`).** The queue handles coalescing of repeated requests; the deferred handles one-shot semantics. Both could be queues with different capacities; the asymmetry is structural noise.

## Open questions

1. **`depTreeLevels` field on `TuiState` (`tui-state.ts:118-133`) — who writes it?** Comment says "Populated once at supervisor compose time" but `grep -rn "depTreeLevels"` returns only the type declaration. Either dead code or a planned-but-unshipped field.

2. **`markAllReady` safety-net method — does anything actually call it?** `engine.ts:580-585` describes it as "called by `defineDevstack` after `Layer.build` completes," but searching `supervisor.ts` for `markAllReady` (and grepping the engine subtree) shows no production call site. May be dead code or only invoked by tests.

3. **How does the next consumer's re-acquire actually fire after `invalidateSubset`?** The selective-restart test (`selective-restart.test.ts:103-211`) explicitly re-calls `acquirePrimitive` to drive the re-acquire — production has no such manual loop. The watch fiber returns to its `runForEach` after `invalidateSubset`; the supervisor's `runOnce` is blocked on `awaitRestart`. So who drives the re-acquire? Hypothesis: the next consumer (in an unaffected primitive) that does `yield* AffectedTag` hits the empty MemoMap entry (because Effect's MemoMap is keyed off layer identity, and `engine.invalidateSubset` evicts the SHADOW cache but NOT the MemoMap). If the MemoMap entry is still present, the consumer gets the cached value from a closed scope — which seems broken. The comment at `engine.ts:671-712` says explicitly "the MemoMap is treated as a black box and is NOT mutated by `invalidateSubset`." Either: (a) Effect's MemoMap also evicts entries when their scope closes, or (b) the next consumer gets a stale value from a closed scope, or (c) the re-acquire is actually a side effect of something else (the `r` path or the next cycle's `Layer.buildWithMemoMap`). The behaviour is asserted by the e2e test but I can't confirm the mechanism from this codebase alone.

4. **What happens to in-flight primitives' state when a watch-fire invalidates them?** If primitive K is currently in the middle of `markAcquiring → setPhase → setPhase → markReady` and `invalidateSubset({K})` fires, the build is interrupted (scope close interrupts), but the entry in `tuiState` is still mid-transition. Is there an explicit reset, or does it stay in `acquiring` until the next acquire flips it?

5. **`__hidden` interplay with selective restart.** A hidden tag has no engine row; `registerPrimitiveScope` IS still called inside the engine-non-hidden branch — but the hidden branch returns early without registering. So a hidden tag's scope isn't in the registry. If that scope contained docker containers (e.g. `gitFetch`), does `invalidateSubset` reach it? Hypothesis: only via the outer `supervisorScope` cascade on full restart, never via selective restart. Worth confirming.

6. **`phases.ts` lives under `engine/` but engine.ts doesn't import it.** Is this module conceptually engine-core (sub-status narration model the engine needs to know) or observability (vocabulary shared between error classes and pretty-error)? It's listed in this doc's scope per the task description but its actual coupling is to errors.ts and pretty-error.ts.

7. **`TuiDimensions` (`tui-state.ts:136-139`) — used anywhere?** Not referenced in the in-scope files; renderers may consume it. Out of scope to verify here, but flagging the lone surface that the engine doesn't touch.

8. **What's the supervisor's contract for primitives that don't surface a `key`?** Hand-rolled `Layer` escape hatches are documented as exempt from the dep graph (`dep-graph.ts:161-163`), the duplicate-key guard (`supervisor.ts:1087-1102`), and the seed pass (they get `key: stack[${i}]` fallback at `supervisor.ts:1380`). But they CAN call into the engine if the user wires `EngineHandle` into their hand-rolled Layer manually. Is this supported, anti-pattern, or undefined?

9. **The renderer's `loggerLayer` is provided at the `runOnce` boundary (`supervisor.ts:1784`), not at supervisor startup.** Per-cycle re-installation of the logger sink. Engine-core neutral question, but it raises whether per-cycle vs supervisor-lifetime logger scoping matches the engine's per-cycle vs supervisor-lifetime state cell scoping.

10. **`flattenStackMembers` walks `__extraMembers` recursively (`supervisor.ts:1015-1028`), but composites currently only nest one level.** Test at `supervisor.test.ts:246-262` proves the helper handles deeper nesting. Is there a real production scenario for `__extraMembers` containing `__extraMembers`, or is this defensive?

11. **`installSignalRestart` is on `longLived` (supervisor lifetime), but the Stream's `addFinalizer` for the signal handler removes it (`supervisor.ts:512-518`).** Is the finalizer guaranteed to fire BEFORE process exit? If not, the listener lingers on a dead process — typically harmless but worth noting.

12. **`engine.invalidateAll` as a finalizer + `Layer.buildWithMemoMap`'s own cleanup cascade — does Effect guarantee they run truly in parallel?** Comment at `supervisor.ts:1571-1593` claims yes ("supervisorScope's 'parallel' strategy actually runs them concurrently"). Pinning this behaviour in tests would be valuable but isn't currently asserted.

## Opportunities noticed

1. **Strip the `TuiState`/`TuiEntry`/`TuiHeader`/`TuiLog` shapes out of `engine.ts`'s public surface.** Publish a domain-neutral lifecycle event model — `{key, status, kind?, value?, error?, phase?, log?, selectiveRestart?}` — and let renderers project. Removes the engine→TUI vocabulary inversion documented in `tui-state.ts:1-19`. The `TuiEntryKind`'s `'other'` fallback and `appendTagLog`'s `lastLog` write are obvious renderer concerns.

2. **Replace `TuiDisplay` on `markReady` with a generic result publish.** The engine should hold the resolved value (or a serialisable subset) and let a renderer-side projection compute `title`/`primary`/`extras`/`endpoints`. `engine.ts:464-490` is doing renderer work.

3. **Delete the shadow cache by pushing eviction-on-scope-close into Effect's MemoMap.** This is upstream work (Effect-v4 issue) but the workaround at `engine.ts:671-757` is the single most architecturally fraught block in the file.

4. **Stop mutating Context.Service classes in `provide()`.** `Object.assign(TagClass, extras)` (`tag.ts:498`) means the class identity is global mutable state. Return a fresh `LayeredTag` wrapper that holds a reference to the class instead.

5. **Discriminated union for `StackMember`.** Split LayeredTag-shape (carries `key`, `__layer`, `__upstreamKeys`, …) from hand-rolled-Layer-shape (carries only `__layer`); TS narrows away the runtime structural casts at `supervisor.ts:1080-1190`.

6. **Lift `HEAVY_INFRA_COSTS` out of engine-core.** Per-service primitives should declare their own reboot-cost annotation (a field on `LayeredTag` / `ProvideOptions`). The supervisor reads them, dedupes, and renders. The current hardcoded map at `supervisor.ts:596-601` is a coupling violation.

7. **Unify restart-signal and shutdown-signal primitives.** Both are unidirectional in-process pub/sub channels; one shared abstraction (a typed queue with coalescing semantics) would replace `Queue.dropping(1)` + `Deferred<void>`. Less surface area, fewer race-condition surfaces.

8. **Extract `installSignalRestart` and the SIGTERM handler from `supervisor.ts` into a `process-signals.ts` module.** Engine-core doesn't need to know about POSIX signals — only that something asks for a restart or a shutdown.

9. **Remove the `EndpointRegistryWithEngineLive` engine-requires-merge-order hack.** `engine.ts:802-820` admits it's load-bearing only for `InfraLive` composition order. Refactor `InfraLive` so this layer can be a plain `Layer.effect(EndpointRegistry, …)` with no `EngineHandle` in R.

10. **Consolidate the `__kind`/`__displayTitle`/`__pluginName` extraction.** `supervisor.ts:1080-1102`, `1369-1389`, `1420-1432` all dance through `(m as { __X?: ... }).__X` patterns. One pure projection from `StackMember` to a canonical `{key, kind, title, plugin, watchPaths, upstreamKeys}` record, consumed everywhere.

11. **Move `flattenStackMembers` (`supervisor.ts:1015-1028`) and the duplicate-key guard (`supervisor.ts:1080-1103`) into a `stack-canonical.ts` module.** Pure synchronous transforms, no Effect, no infra — they belong with the dep-graph helpers, not in the supervisor's launch wiring.

12. **`engine.test.ts:251-265` builds synthetic registered scopes via a helper because going through `withEngineLifecycle` would require providing `EngineHandle` recursively.** A testing surface — `engine.testHelpers.registerScope(key)` or similar — would make the test less surgical.

13. **The `depTreeLevels` field on `TuiState` (`tui-state.ts:118-133`) is dead.** Either wire it in `defineDevstack` after `topoLevels` runs (then renderers can show "level 0: sui; level 1: walrus, seal" banners) or remove it. Currently it's neither implemented nor used.

14. **`markAllReady` may be dead code.** No production call site found in this read. Confirm and delete, or wire it correctly.

15. **`hashFileIfChanged` lives in `supervisor.ts` (`supervisor.ts:539-557`) but is engine-resources adjacent.** It owns a module-scoped `watchedFileHashes` Map (`supervisor.ts:537`). Bundle with the file-watcher / watch-attribution code in a dedicated `watch-dispatch.ts` module.

16. **`installSignalRestart`'s `Stream.callback` + `Effect.forkScoped` plumbing (`supervisor.ts:503-524`) duplicates the `Effect.addFinalizer` shape used by the hard-kill handler.** A `processSignalStream(signal)` helper that returns `Stream<void>` would let both consumers share the wiring.

17. **`compileWatchFilter` precompiles `minimatch` patterns on every call (`supervisor.ts:806-836`).** Per-cycle re-compilation if hot-restart reaches it — actually it's only called once per supervisor lifetime, but the per-call resolving of bare-vs-glob and per-call building of two arrays could move to a builder pattern that caches.

18. **`SHADOW_CACHE_PRESENT` is a unique-symbol sentinel value but the map is typed `Ref<ReadonlyMap<string, unknown>>` (`engine.ts:712`).** Could be `Ref<ReadonlySet<string>>` — the engine only ever uses `Map.has` / `Map.delete` / `Map.set` with the sentinel. A Set is the honest type.

19. **Per-domain phase tuples in `phases.ts` are an enumerable vocabulary that's separately used in `tui/PHASE_STATUS_OVERRIDES`** (per `phases.ts:18-20` comment). The TUI override map and the error-class phase fields are two consumers of the same enum. Either centralise on phase metadata (each tuple element becomes `{name, color?, override?}`) or split into per-consumer enums. Currently the comment "Renaming a phase here is a downstream breaking change" reads as cost-acknowledged tech debt.

20. **The `Effect.race(buildEffect, awaitShutdown)` and `Effect.race(awaitRestart, awaitShutdown)` blocks (`supervisor.ts:1652-1682, 1768-1771`) could be a single named primitive — `interruptibleByShutdown(effect)` — that returns `'ok' | 'interrupted'` and keeps the supervisor's logic linear.

21. **`(yield* Effect.scope)` is called inside `withEngineLifecycle` (`tag.ts:311`) AND inside `runOnce` (`supervisor.ts:1566`). The per-primitive vs per-cycle scopes have different lifetimes by design but the call pattern is identical** — wrap in a helper `forkParallelScope(name?)` to make the intent clear at each call site.

22. **`buildDepGraph` (`dep-graph.ts:152-216`) and `topoLevels` (`dep-graph.ts:310-358`) both walk the graph and both build a consumers reverse-index. They share no helpers**. Extract `reverseEdges(graph)` once.

23. **`computeDownstreamClosure` BFSes from every node with a fresh visited set (`dep-graph.ts:230-267`).** O(V * (V+E)) worst case. For small dep graphs it's irrelevant; for a 1000-node stack it'd matter. Tarjan-style strongly-connected components or a single DFS with memoisation would be O(V+E). Probably not a real concern, but worth noting.

24. **`engine.test.ts:268-293` (`P3.T1 — shadow cache is populated on registerPrimitiveScope and evicted on invalidateSubset`)** verifies shape via `_shadowCache: Ref.Ref<ReadonlyMap<string, unknown>>` exposed on the public shape (`engine.ts:266`). The "exposed-for-tests-only" comment is honest but the surface is now permanent — Cf. principle that internal surfaces shouldn't lock-in test shape.
