# programmable-api

## Purpose

The user-facing programmable API of devstack — the surface a `devstack.config.ts` author writes
against, and the substrate plugin authors extend. It is the layer that translates "I want a Sui
localnet, a publisher account, a Move package, and a dev server" into the Effect `Layer` graph the
supervisor (engine) builds.

Three concentric tiers live here:

1. **Top-level entry** — `devstack(...refs)` (variadic, default-fills `Sui` + `Faucet`,
   auto-attaches the manifest emitter) and the lower-level `defineDevstack(config)` (raw, no
   defaults, accepts a fully-built `DevstackConfig`). Both return the same `DevstackHandle`
   (`layer`, `run`, `runMain`, `launchEffect`).
2. **Tag substrate** — `tag(name, build, opts)`, `provide(TagClass, build, opts)`,
   `composeLayers({inner, primary, projections})`, `setPhase(phase)`, and the
   `makeService(plugin, kind, impl)` HOF. The primitive every factory uses to bind an
   `Effect.Effect<Shape>` into a stack-graph-visible `LayeredTag<Name, Shape>` carrying the private
   `__layer` / `__layers` / `__extraMembers` / `__upstreamKeys` / `__kind` / `__pluginName` /
   `__displayTitle` / `__watchPaths` / `__hidden` / `key` / `DevstackTagBrand` fields.
3. **Plugin-author helpers** — `dockerContainer`, `dockerImage`, `dockerOneShot`, `gitFetch`,
   `hostScript`. Higher-level shapes (long-lived container, content-addressed image build, cached
   one-shot, git clone, host process) that compose the tag substrate so a third-party plugin can
   land a new container-backed service in ~15 lines (see the `Redis` example).

The hand-rolled
`{__layer, __layers, __extraMembers, key, __kind, __pluginName, __displayTitle, __upstreamKeys}`
POJO return (used by `walrusLocalCluster`, `sealLocalKeygen`, postgres composite, sui-localnet's
`Object.assign(tag, {__layers})`) is the escape hatch when a primitive needs to project a single
body into multiple interface tags or lift inner siblings to top-level for parallel scheduling —
there is no public helper for it today.

## Current implementation

### `src/advanced/` — tag substrate + plugin-author entry barrel

| File                   | LOC | Summary                                                                                                                                                                                                                                                                                                                |
| ---------------------- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`             | 200 | Public `/advanced` barrel — exports tag substrate, plugin-author helpers, codegen plugin-author surface, faucet plugin-author surface, low-level interface tag escape hatches, admin-side interface tags. Comment block at top groups exports into 7 numbered tiers (`tag.ts:1-30`).                                   |
| `tag.ts`               | 667 | Tag substrate: `provide`, `tag`, `composeLayers`, `setPhase`, `CurrentTagKey` reference, `DevstackTagBrand` symbol, `withEngineLifecycle` wrap, `resolveUpstreamKeys` helper, type definitions for `LayeredTag` / `TagIdentity` / `TagKind` / `TuiDisplay` / `ProvideOptions` / `TagOptions` / `ComposeLayersOptions`. |
| `tag.test.ts`          | 62  | Lifecycle wrap finalizer test + tag-shape smoke + `@ts-expect-error` regression test for the deleted `lifecycle` option.                                                                                                                                                                                               |
| `tag-compose.test.ts`  | 195 | Hidden-tag behaviour tests (build runs without TUI seed; failure still propagates; non-hidden control case) + `composeLayers` ordering tests (inner→primary→projections; undefined drop; `__layers` precedence over `__layer`; last-wins on overlapping `Context.Reference`).                                          |
| `make-service.ts`      | 65  | `makeService(pluginName, kind, impl)` HOF that mutates an impl with `__kind` + `__pluginName` via `Object.assign`.                                                                                                                                                                                                     |
| `make-service.test.ts` | 70  | Stamp/reference-equality/preservation/discriminator-coverage/last-wins tests.                                                                                                                                                                                                                                          |

### `src/advanced/plugin-author/` — higher-level primitives

| File                       | LOC | Summary                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`                 | 88  | Plugin-author barrel — re-exports `provide` / `tag` / `composeLayers` / `setPhase` from `../tag.js`, plus `dockerImage` / `dockerContainer` / `runDockerContainer` / `dockerOneShot` / `gitFetch` / `hostScript`, plus registry write+require helpers (`publishAccount` etc.) and router primitives (`defineEntrypoint`, `routerEntrypoint`).                        |
| `docker-container.ts`      | 853 | `dockerContainer(name, options)` and `runDockerContainer(name, options)` — long-lived container as a `LayeredTag<Name, DockerContainerHandle>`. Resolves image via sibling `dockerImage(...)` tag, calls `Docker.run`, attaches secondary networks, awaits ready probe, publishes endpoint. Supports both static `options` and builder-form `(identity) => options`. |
| `docker-container.test.ts` | 68  | Factory shape smoke (LayeredTag metadata + image-source union enforces `{pull}` xor `{build}` + bare-string rejected at type level + routing-related fields absent without `routing`).                                                                                                                                                                               |
| `docker-image.ts`          | 187 | `dockerImage({name, pull                                                                                                                                                                                                                                                                                                                                             | build})`— content-addressed image builder. Tree-hashes context dir, short-circuits via`docker image inspect`. Wrapped as a `tag(name, ..., {kind: 'action'})`. |
| `docker-one-shot.ts`       | 160 | `dockerOneShot({name, image, ...})` — one-shot container action, caches exit/stdout/stderr in state-store keyed by content hash of inputs. **Sunset 2026-11-19** (Wave 6.8).                                                                                                                                                                                         |
| `git-fetch.ts`             | 384 | `gitFetch({name, repo, ref, subdirectory?})` — cached repo clone at `<stateDir>/git/<name>/<refHash>`. Sync repo/ref validators throw at factory time. `{hidden: true}` so the clone doesn't surface a TUI row.                                                                                                                                                      |
| `git-fetch.test.ts`        | 78  | Validator throws for empty/flag-injection/disallowed-transport repo and ref, accepts well-formed values.                                                                                                                                                                                                                                                             |
| `host-script.ts`           | 134 | `hostScript({name, command, args?})` — spawn a host process to completion, capture stdout + exit code, SIGTERM→SIGKILL escalation. **Sunset 2026-11-19** (Wave 6.8).                                                                                                                                                                                                 |

### `src/compose/` — top-level entry

| File               | LOC | Summary                                                                                                                                                                                                                                                                                                                                            |
| ------------------ | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `devstack.ts`      | 276 | `devstack(...args)` variadic entry. Splits trailing options from leading refs, flattens `Ref                                                                                                                                                                                                                                                       | Ref[]`to`StackMember[]`, auto-attaches `manifestRef`(every sibling as upstream), patches`codegen/`-prefixed members' `\_\_upstreamKeys`to include every sibling, calls`fillDefaults`(auto-Sui + auto-Faucet), then delegates to`defineDevstack`. Wires the default `RendererResolver`(TUI/plain factories) so the supervisor doesn't import`tui/`. |
| `defaults.ts`      | 41  | `fillDefaults(refs)` auto-appends `Sui()` when none is present (matched by exact key `@devstack/SuiTag`) and `Faucet({hidden: true})` when none is present (matched by `faucet/` prefix).                                                                                                                                                          |
| `devstack.test.ts` | 103 | Smoke: handle has `layer`/`run`/`runMain`; variadic accepts refs + ref arrays; trailing options recognized; plain options object (no `__layer`) treated as opts; object with `__layer` treated as a ref; user-supplied `Faucet` suppresses auto-append (no duplicate-key warning); custom-named Faucet suppresses too via `faucet/` prefix dedupe. |

### `src/engine/supervisor.ts` (load-bearing user-facing exports only)

| Export                          | Lines     | Summary                                                                                                                                                                                                                                                                                                            |
| ------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `interface StackMember`         | 113-195   | Structural shape of every ref. Carries `__layer` (required), `__layers?`, `__extraMembers?`, `key?`, `__kind?`, `__displayTitle?`, `__watchPaths?`, `__pluginName?`, `__upstreamKeys?`. The "anything carrying `__layer`" interface that hand-rolled escape hatches satisfy without going through `tag`/`provide`. |
| `interface DevstackConfig`      | 199-269   | Top-level config: `stack`, `extras?`, `stateDir?`, `stackName?`, `network?`, `renderer?`, `rendererResolver?`, `rendererFactory?`, `watch?`, `hotRestart?`.                                                                                                                                                        |
| `interface RunOverrides`        | 297-300   | Per-`run()`/`runMain()` overrides — `renderer?`, `rendererFactory?`.                                                                                                                                                                                                                                               |
| `interface DevstackHandle`      | 305-319   | Return shape — `layer`, `config`, `run`, `runMain`, `launchEffect`.                                                                                                                                                                                                                                                |
| `interface StackComposeOptions` | 947-980   | Subset of `DevstackConfig` that affects layer composition — `stackName?`, `network?`, `stateDir?`, `extras?`, `platformLayer?`, `infraOverrides?`. Used by `composeStackLayer`.                                                                                                                                    |
| `flattenStackMembers`           | 1015-1028 | Walks `__extraMembers` recursively, yields each member followed by its lifted siblings.                                                                                                                                                                                                                            |
| `composeStackLayer`             | 1044-1322 | Composes a `StackMember[]` into the fully-resolved `Layer<unknown, unknown, never>` (user layers + infra + platform). Runs duplicate-key warn, missing-`__upstreamKeys` warn (when `DEVSTACK_WARN_MISSING_UPSTREAM` is set), topo-level scheduler.                                                                 |
| `defineDevstack`                | 1324-2112 | Top-level entry. Most of the body is the supervisor's launch loop (engine setup, bootstrap layer, signal handling, watch fibers, per-cycle `runOnce`). The user-facing API is just `input: StackMember[] \| DevstackConfig => DevstackHandle`.                                                                     |

### Totals (in-scope only)

- **Src**: 200 + 667 + 65 + 853 + 187 + 160 + 384 + 134 + 88 + 276 + 41 = **3055 LOC**
- **Test**: 62 + 195 + 70 + 68 + 78 + 103 = **576 LOC**
- (Excluded: supervisor.ts itself, since this doc only covers its user-facing exports —
  supervisor.ts is owned by the `engine-core` doc.)

## Configuration

Every knob a caller can set that affects the user-facing API.

### `DevstackConfig` (passed to `defineDevstack` or via trailing opts to `devstack(...)`)

| Key                | Type                                                                          | Default                                                                                                            | Read at                                                                                  | Notes                                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `stack`            | `ReadonlyArray<StackMember>`                                                  | required (on `DevstackConfig`); flattened from variadic refs on `devstack(...)`                                    | `supervisor.ts:200`, `supervisor.ts:1340`                                                | Array of refs (`Account()`, `Sui()`, …). `devstack(...)` accepts variadic refs and the trailing options object instead.        |
| `extras`           | `ExtrasInput` (`Record \| () => Record \| Effect<Record>`)                    | `undefined`                                                                                                        | `supervisor.ts:209`, `extras.ts:32-37`                                                   | Resolved once into `ExtrasResolved` (memoized Effect) at infra-layer build time. Consumed by manifest-emit + codegen emitters. |
| `stateDir`         | `string`                                                                      | `'.devstack'` (default lives in `state-store.ts`; also honored via `DEVSTACK_STATE_DIR` env in `git-fetch.ts:157`) | `supervisor.ts:210`                                                                      | Override the on-disk state directory.                                                                                          |
| `stackName`        | `string`                                                                      | `process.env.DEVSTACK_STACK ?? 'main'`                                                                             | `supervisor.ts:217`, resolved at `supervisor.ts:990`                                     | Logical stack name partitioning persisted state on localnet (`.devstack/stacks/<stack>/`). Ignored on live nets.               |
| `network`          | `SuiNetwork` (`'localnet' \| 'testnet' \| 'mainnet' \| 'devnet' \| '*-fork'`) | `resolveNetwork()` (reads `DEVSTACK_NETWORK` env, falls back to `'localnet'`)                                      | `supervisor.ts:224`                                                                      | Drives state-file layout + downstream factory's local-vs-known branching (`Walrus()`, `Seal()`, `Deepbook()`).                 |
| `renderer`         | `RendererKind` (`'tui' \| 'plain' \| 'silent'`)                               | `'tui'` when `process.stdout.isTTY` else `'plain'`                                                                 | `supervisor.ts:238`, `supervisor.ts:271-274`                                             | TUI when interactive, plain otherwise. CLI `--renderer` flag (in `RunOverrides`) overrides.                                    |
| `rendererResolver` | `(kind: RendererKind) => RendererFactory`                                     | `defaultRendererResolver` (wired by `compose/devstack.ts:94-98`)                                                   | `supervisor.ts:246`                                                                      | Maps a kind string to a concrete factory. Default knows about `tui/`; tests can swap.                                          |
| `rendererFactory`  | `RendererFactory`                                                             | `undefined`                                                                                                        | `supervisor.ts:254`                                                                      | Pre-resolved factory. Wins over `renderer`/`rendererResolver` when set.                                                        |
| `watch`            | `ReadonlyArray<string>`                                                       | `[]`                                                                                                               | `supervisor.ts:260`, aggregated at `supervisor.ts:1415-1418` with per-tag `__watchPaths` | `.gitignore`-style patterns. A change debounced to 250ms triggers a hot-restart of the full stack.                             |
| `hotRestart`       | `boolean`                                                                     | `true` when `watch` is non-empty else `false`                                                                      | `supervisor.ts:268`, `supervisor.ts:1460`                                                | Disable per-event restart while keeping the watcher running (log-only).                                                        |

### `RunOverrides` (passed to `handle.run(overrides)` / `runMain(overrides)`)

| Key               | Type              | Default                            | Notes                                                                    |
| ----------------- | ----------------- | ---------------------------------- | ------------------------------------------------------------------------ |
| `renderer`        | `RendererKind`    | inherits `DevstackConfig.renderer` | Per-call renderer override (CLI `--renderer`).                           |
| `rendererFactory` | `RendererFactory` | inherits                           | Pre-resolved factory override; highest precedence (`supervisor.ts:286`). |

### `StackComposeOptions` (passed to `composeStackLayer(stack, opts)` — `/advanced` entry for test fixtures)

| Key              | Type                             | Default             | Notes                                                                                          |
| ---------------- | -------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------- |
| `stackName`      | `string`                         | `'main'`            |                                                                                                |
| `network`        | `SuiNetwork`                     | `resolveNetwork()`  |                                                                                                |
| `stateDir`       | `string`                         | `'.devstack'`       |                                                                                                |
| `extras`         | `ExtrasInput`                    | `undefined`         |                                                                                                |
| `platformLayer`  | `Layer<unknown, unknown, never>` | `NodeServicesLayer` | Swap Node platform services for an in-memory fake. Test-only.                                  |
| `infraOverrides` | `Layer<unknown, unknown, never>` | `undefined`         | Layer merged INTO infra (later-wins shadow for e.g. deterministic `PortAllocator`). Test-only. |

### `ProvideOptions<A>` / `TagOptions<A>` (passed by plugin authors to `provide(TagClass, build, opts)` / `tag(name, build, opts)`)

| Key                             | Type                                                                   | Default                                                       | Notes                                                                                                                                                                                                                         |
| ------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`                          | `TagKind` (`'service' \| 'package' \| 'account' \| 'action' \| 'app'`) | `undefined` (TUI shows in 'other' section, elided when empty) | TUI sectioning. `tag.ts:94`.                                                                                                                                                                                                  |
| `display`                       | `(shape: A) => TuiDisplay`                                             | `undefined`                                                   | Projection of the resolved value into TUI fields (`title`, `primary`, `extras`, `endpoints`). Runs once on `markReady`. `tag.ts:129`.                                                                                         |
| `displayTitle`                  | `string`                                                               | `undefined` (falls back to key with `@devstack/` stripped)    | Friendly title rendered while still pending/acquiring. `tag.ts:133`.                                                                                                                                                          |
| `plugin`                        | `string`                                                               | `undefined`                                                   | Drives the `[plugin]` chip + section color. In-tree values: `'sui' \| 'wallet' \| 'walrus' \| 'seal' \| 'deepbook' \| 'coin' \| 'move' \| 'account' \| 'codegen' \| 'pyth' \| 'postgres' \| 'dev' \| 'action'`. `tag.ts:140`. |
| `hidden`                        | `boolean`                                                              | `false`                                                       | Suppresses TUI row entirely (build still runs; failures still propagate). `tag.ts:151`.                                                                                                                                       |
| `upstreamKeys`                  | `ReadonlyArray<LayeredTag \| string \| undefined>`                     | `undefined`                                                   | Static dep declaration. Resolved to `__upstreamKeys: string[]` (deduped, `undefined` entries dropped) by `resolveUpstreamKeys` (`tag.ts:412-427`). Consumed by `buildDepGraph` + topo scheduler. `tag.ts:171`.                |
| `watch`                         | `ReadonlyArray<string>`                                                | `undefined`                                                   | `.gitignore`-style watch patterns aggregated by `defineDevstack` alongside `config.watch`. Triggers full-stack restart (selective per-primitive teardown is future work). `tag.ts:201`.                                       |
| `extraLayers` (TagOptions only) | `ReadonlyArray<Layer>`                                                 | `[]`                                                          | Inner-tag layers prepended to `__layers` before the outer's own `__layer`. Used by composites that surface inner siblings without going through `composeLayers`. `tag.ts:508`.                                                |

### Environment variables consumed by the API

| Variable                         | Read at                                      | Effect                                                                                        |
| -------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `DEVSTACK_STATE_DIR`             | `git-fetch.ts:157`                           | Override the cache root for `gitFetch` clones (parallel to the `stateDir` config knob).       |
| `DEVSTACK_STACK`                 | `supervisor.ts:991`                          | Fallback for `stackName` when not explicitly configured.                                      |
| `DEVSTACK_NETWORK`               | `engine/network.ts` (via `resolveNetwork()`) | Fallback for `network`.                                                                       |
| `DEVSTACK_WARN_MISSING_UPSTREAM` | `supervisor.ts:1121`                         | When set, `composeStackLayer` warns aggregate list of stack members missing `__upstreamKeys`. |

## Capabilities CONSUMED

### From the engine

- `EngineHandle` service — `tag.ts:312`. Tag substrate optionally requires it (resolved via
  `Effect.serviceOption`, noop when absent — supports standalone unit tests). Used for
  `markAcquiring` / `markReady` / `markFailed` / `setEntryTitle` / `setPhase` / `appendLog` /
  `registerPrimitiveScope` lifecycle hooks.
- `Identity` service — `tag.ts:322`, `docker-container.ts:669`. Annotates spans with
  `<app>/<stack>/<network>` triple. `dockerContainer` builder-form options receive it.
- `EngineLive` layer (transitively via `InfraLive`) — `supervisor.ts:347`.
- `Scope.Scope` — `tag.ts:311`. Captures per-primitive ambient scope (forked by Effect's MemoMap per
  `Layer.effect`) and registers it for selective invalidation.
- `Context.Reference<string>` `CurrentTagKey` (defined here, `tag.ts:51-53`) — read by `setPhase`,
  by `dockerContainer`'s body (`docker-container.ts:655`), and pinned by `withEngineLifecycle` on
  each build body.
- `StateStore` — `docker-one-shot.ts:109` (caches exit/stdout/stderr).
- `ChildProcessSpawner` — `git-fetch.ts:149`, `host-script.ts:78`.
- `FileSystem` — `git-fetch.ts:148`, `docker-image.ts:42` (for tree-hash context walk).
- `EndpointRegistry` (via `publishEndpoint` helper) — `docker-container.ts:830`.
- `RouterEntrypoint` registry — `docker-container.ts:688` (resolves `routing.entrypoint` to the
  well-known port/protocol).
- `ClaimedContainers` — provided by the supervisor at `supervisor.ts:1658`; `Docker.run` adds to it.

### From the supervisor

- `composeStackLayer(stack, opts)` — `supervisor.ts:1044`. `defineDevstack` calls it twice: once for
  the public `handle.layer` field (`supervisor.ts:1340`) and once per launch cycle
  (`supervisor.ts:1493`).
- `flattenStackMembers(stack)` — `supervisor.ts:1015`. Used by `defineDevstack`
  (`supervisor.ts:1338`) and `composeStackLayer` (`supervisor.ts:1053`).
- `buildDepGraph` + `computeDownstreamClosure` + `topoLevels` from `engine/dep-graph.ts` —
  `supervisor.ts:1174`, `supervisor.ts:1453-1454`.
- `compileWatchFilter` + `DEFAULT_WATCH_EXCLUDES` — `supervisor.ts:806`, `:749` (used by file-watch
  fiber).
- `bootstrapRouterFor`, `Docker` ops, `dockerOrphanSweep`, `routerHostname`, `routerId`,
  `awaitReady`, `awaitContainerReady`, `publishEndpoint`, `defineEntrypoint` — all from `engine/*`.

### From npm

- `effect` — `Context`, `Effect`, `Layer`, `Scope`, `Cause`, `Schema`, `Stream`, `Ref`, `Option`,
  `FileSystem` (`tag.ts:38`, `docker-image.ts:2`, `git-fetch.ts:16`, `host-script.ts:1`,
  `docker-one-shot.ts:1`, `compose/devstack.ts:8`).
- `effect/unstable/process` — `ChildProcess`, `ChildProcessSpawner` (`git-fetch.ts:17`,
  `host-script.ts:2`).
- `@effect/platform-node/NodeServices`, `@effect/platform-node/NodeRuntime` — `supervisor.ts:47-48`.
- `node:crypto`, `node:path`, `node:fs/promises` — `git-fetch.ts:14-15`, `docker-image.ts:1`,
  `supervisor.ts:32-33`.
- `minimatch` — `supervisor.ts:50` (watch filter compile).

### From other workspace modules (devstack-internal)

- `../engine/engine.ts` — `EngineHandle`, `EngineLive`.
- `../engine/identity.ts` — `Identity`, `IdentityShape`, `deriveAppName`, `validateIdentity`.
- `../engine/observability.ts` — `annotateDevstackContext`.
- `../engine/pretty-error.ts` — `prettyError`.
- `../engine/docker.ts` — `Docker.run`, `Docker.pull`, `Docker.build`, `Docker.runOneShot`,
  `Docker.networkConnect`, `Docker.imageExists`, `ClaimedContainers`, `dockerOrphanSweep`.
- `../engine/docker/router.ts` — `routerEntrypoint`, `RouterLabel`, `defineEntrypoint`.
- `../engine/docker/logs.ts` — `awaitContainerReady`.
- `../engine/docker/core.ts` — `OutputLineCallback`.
- `../engine/router-hostname.ts` — `routerHostname`, `routerId`.
- `../engine/ready-probe.ts` — `awaitReady`, `ReadyProbe`, `ReadyProbeError`.
- `../engine/errors.ts` — `DockerError`, `HostProcessError`, `ManifestError`.
- `../engine/content-hash.ts` — `contentHash`, `createContentHasher`, `digestHex`.
- `../engine/state-store.ts` + `state-store-keys.ts` — for `dockerOneShot` cache.
- `../engine/safe-env.ts` — `inheritedHostEnv` (`host-script.ts:3`).
- `../engine/registries.ts` — `publishEndpoint`, plus the registry exports surfaced through
  `/advanced/plugin-author`.
- `../engine/extras.ts` — `ExtrasInput`, `ExtrasResolved`, `ExtrasLive`.
- `../runtime/manifest-emit.ts` — `emitManifest()` (wrapped by `manifestRef` in
  `compose/devstack.ts:166`).
- `../runtime/service.ts` — `gatherManifest` (re-exported from `/advanced`).
- `../runtime/endpoint-names.ts` — `EndpointName`.
- `../codegen/*` — `defineEmitter`, emitters (re-exported from `/advanced`).
- `../services/sui.ts` — `SuiTag`, `Sui()` (the `fillDefaults` import target).
- `../services/faucet/index.ts` — `Faucet`, faucet strategies (re-exported from `/advanced`).
- `../services/*` — interface tag classes re-exported from `/advanced`.
- `../tui/index.ts` + `../tui/plain.ts` — renderer factories wired by `compose/devstack.ts:41`.

## Capabilities PRODUCED

### Top-level exports surfaced from `@mysten-incubation/devstack`

- `devstack(...refs)` — variadic compose entry (`compose/devstack.ts:196`).
- Returns a `DevstackHandle` (`{ layer, config, run, runMain, launchEffect }`) — the supervisor's
  public contract.

### `/advanced` (`@mysten-incubation/devstack/advanced`) — escape hatch surface

(See `src/advanced/index.ts:1-201` for the full annotated barrel.)

- **Tier 1 — Tag substrate**: `tag`, `provide`, `composeLayers`, `setPhase`, `LayeredTag`,
  `TagIdentity`, `TagKind`, `TuiDisplay`, `ProvideOptions`, `TagOptions`, `ComposeLayersOptions`,
  `makeService`.
- **Tier 2 — defineDevstack family**: `defineDevstack`, `composeStackLayer`, `DevstackHandle`,
  `DevstackConfig`, `StackMember`, `StackComposeOptions`, `RendererKind`, `RunOverrides`.
- **Tier 3 — Plugin-author primitives**: `dockerImage`, `dockerContainer`, `runDockerContainer`,
  `dockerOneShot`, `gitFetch`, `hostScript`, `pickCreatedByType`, `PackageWithCapture`,
  `knownDeployments`.
- **Tier 4 — Runtime accessor surface**: `gatherManifest`, `EndpointName`, `ExtrasInput`.
- **Tier 5 — Codegen plugin-author surface**: `defineEmitter`, `BindingsEmitter`,
  `DappKitConfigEmitter`, `DeepbookConfigEmitter`, `StackHandleEmitter`, `CodegenError`.
- **Tier 6 — Faucet plugin-author surface**: `Faucet`, `FaucetTag`, `FaucetStrategy`,
  `FaucetRequestError`, `suiHttpStrategy`, `walExchangeStrategy`, `treasuryCapMintStrategy`.
- **Tier 7 — Misc plugin-author surface**: `pythMid`, `DevstackSigner`.
- **Tier 8 — Low-level interface tag escape hatches**: `SuiTag`, `CoinTag`, `WalrusNetworkTag`,
  `WalrusNodesTag`, `WalrusProxyTag`, `DeepbookCoreTag`.
- **Tier 9 — Admin-side interface tag classes**: `WalrusAdminTag`, `SealKeyManagerTag`,
  `DeepbookAdminTag`.
- **Plugin-author registry/router exports** (from `/advanced/plugin-author`): `AccountRegistry`,
  `CoinRegistry`, `EndpointRegistry`, `PackageRegistry`, `publishAccount`, `publishCoin`,
  `publishEndpoint`, `publishPackage`, `requireAccountRegistry`, `requireCoinRegistry`,
  `requireEndpointRegistry`, `requirePackageRegistry`, plus their record types and
  `defineEntrypoint` / `listEntrypoints` / `routerEntrypoint` / `RouterEntrypoint`.

### Runtime artifacts produced

- **TUI state entries** — every non-hidden `tag()`/`provide()` call results in one seed entry
  (`supervisor.ts:1374-1389`) with `{key, kind?, title?, plugin?}`, and lifecycle calls
  (`markAcquiring`/`markReady`/`markFailed`/`setPhase`/`setEntryTitle`) via `withEngineLifecycle`.
- **`EngineHandle` registration**: `engine.registerPrimitiveScope(name, primitiveScope)`
  (`tag.ts:345`) — every primitive's ambient layer scope is registered so
  `engine.invalidateSubset(keys)` can close just one primitive's resources.
- **Logs** — on failure, `withEngineLifecycle` appends a `level: 'error'` entry via
  `engine.appendLog` with the full `prettyError(cause)` walk (`tag.ts:373-377`).
- **Per-primitive `Effect.withSpan(...)`** — each plugin-author primitive wraps its body with a
  named span (`DockerImage(<name>)`, `DockerContainer(<name>)`, `GitFetch(<name>)`,
  `HostScript(<name>)`, `DockerOneShot(<name>)`).
- **`Effect.annotateCurrentSpan({...})`** — per-tier attributes (`dockerImage.name`,
  `dockerImage.tag`, `git.repo`, `git.ref`, …).
- **Docker images, containers, networks** — when `dockerImage` / `dockerContainer` / `dockerOneShot`
  are reached, with `devstack.app` / `devstack.stack` / compose-project labels stamped via
  `Docker.run`.
- **Filesystem artifacts** — `<stateDir>/git/<name>/<refHash>` for `gitFetch`; `state-store` entries
  for `dockerOneShot` cache hits.
- **`EndpointRegistry` entries** — `dockerContainer({endpoint})` publishes one named endpoint per
  call.
- **Manifest emitter ref** — `compose/devstack.ts:151-172` wraps the `emitManifest()` Effect in a
  hidden `tag('manifest', ..., {kind: 'app', upstreamKeys: siblingKeys})` so the manifest entry
  shows up as a top-level row that runs at the topo-graph's last level.

### Internal-only fields stamped on every tag (the `LayeredTag` private surface)

| Field                                         | Stamped by                                                                           | Consumer                                                                                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `key: string`                                 | `provide` (`tag.ts:481`), `tag` (`tag.ts:563`)                                       | duplicate-key guard, seed entries, dep graph, watch attribution, TUI                                                                             |
| `__layer: Layer`                              | `provide` (`tag.ts:472`), `tag` (`tag.ts:561`)                                       | `composeStackLayer` fold (when `__layers` absent)                                                                                                |
| `__layers?: ReadonlyArray<Layer>`             | `tag` (`tag.ts:541-544`), hand-rolled in composites                                  | `composeStackLayer:1204` prefers it over `__layer`. Inner→primary→projections order is provider-before-consumer (`composeLayers` enforces this). |
| `__extraMembers?: ReadonlyArray<StackMember>` | hand-rolled in composites (walrus `local-cluster.ts:343`, seal `internal.ts:1212`)   | `flattenStackMembers` lifts to top-level as separate dep-graph nodes                                                                             |
| `__kind?: TagKind`                            | `provide` (`tag.ts:482`), `tag` (`tag.ts:566`), `makeService` (`make-service.ts:65`) | TUI sectioning, seed entries                                                                                                                     |
| `__displayTitle?: string`                     | `provide` (`tag.ts:483`), `tag` (`tag.ts:567`)                                       | TUI pre-ready label                                                                                                                              |
| `__watchPaths?: ReadonlyArray<string>`        | `provide` (`tag.ts:484-486`), `tag` (`tag.ts:568-570`)                               | Watch-set aggregation (`supervisor.ts:1417`) + per-path attribution (`watchOwners`)                                                              |
| `__pluginName?: string`                       | `provide` (`tag.ts:487`), `tag` (`tag.ts:571`), `makeService` (`make-service.ts:65`) | TUI `[plugin]` chip + section color, seed entries                                                                                                |
| `__hidden?: boolean`                          | `provide` (`tag.ts:488`), `tag` (`tag.ts:572`)                                       | TUI suppression + seed skip + lifecycle short-circuit                                                                                            |
| `__upstreamKeys?: ReadonlyArray<string>`      | `provide` (`tag.ts:489-496`), `tag` (`tag.ts:573`)                                   | `buildDepGraph` consumer; dep graph + selective restart cascade                                                                                  |
| `[DevstackTagBrand]: true` (`symbol`)         | `provide` (`tag.ts:480`), `tag` (`tag.ts:564`)                                       | `compose/devstack.ts:121-127` `isOptions` discriminator — distinguishes a ref from an options object                                             |

## Lifecycle

### Startup (from a user's POV)

1. User writes `devstack.config.ts` with `export default devstack(account, package, dev)`.
2. CLI (or user's own `runMain`) calls `handle.runMain()` (`supervisor.ts:2110`).
3. `defineDevstack` body fires (synchronously at module load if `devstack(...)` is called at top
   level):
   - `flattenStackMembers(config.stack)` (`supervisor.ts:1338`) expands `__extraMembers`
     recursively.
   - `composeStackLayer(config.stack, {...})` (`supervisor.ts:1340`) is called to populate
     `handle.layer` — but the actual layer build doesn't run yet.
   - Seed entries collected (`supervisor.ts:1374-1389`) — every non-hidden member contributes
     `{key, kind?, title?, plugin?}`.
   - Watch set aggregated (`supervisor.ts:1414-1439`).
   - Static dep graph built (`supervisor.ts:1453-1454`).
4. `runMain` invokes `buildLaunchEffect(overrides)` → `nodeRunMain(...)`. The supervisor's launch
   loop takes over (out of scope for this doc).
5. Each tag's `withEngineLifecycle`-wrapped build body runs when its layer is acquired:
   - `Effect.scope` captures the per-primitive ambient scope (`tag.ts:311`).
   - `engine.registerPrimitiveScope(name, scope)` so selective invalidation can target it.
   - `engine.markAcquiring(name, kind)` flips the TUI row to acquiring.
   - `engine.setEntryTitle(name, displayTitle)` if `displayTitle` was passed.
   - `build` runs with `CurrentTagKey` pinned (`tag.ts:383`) so `setPhase` knows which row to
     update.
   - On success: `engine.markReady(name, display(value))` if `display` was passed.
   - On failure: `engine.markFailed(name, cause)` +
     `engine.appendLog({level: 'error', message: prettyError(cause)})`.

### Ready criteria

- A tag is **ready** when its build Effect resolves successfully and the engine receives
  `markReady`. Downstream consumers' `yield* SomeTag` returns the resolved value at that point.
- A composite (walrus, seal, …) that uses the hand-rolled `__layer`/`__layers` escape hatch wires
  its lifecycle manually (`local-cluster.ts:186-239`). It calls `engine.markAcquiring` / `markReady`
  itself rather than going through `withEngineLifecycle`.

### Restart behavior

- **Full restart** (`r` keypress / SIGUSR2): supervisor closes the per-cycle scope
  (`supervisorScope`) which cascades through every primitive's finalizer in parallel. The user's
  `__layer` graph rebuilds from scratch on the next cycle. The bootstrap layer (engine, StateStore,
  Identity, FileWatcher) survives across cycles.
- **Selective restart** (file-watch fire matched against `__watchPaths`):
  `engine.invalidateSubset(affectedKeys)` closes the per-primitive scopes for the affected set +
  transitive downstream closure (via `__upstreamKeys` → dep graph), leaving siblings + bootstrap
  untouched.
- **`docker run` adoption**: `Docker.run` (consumed by `dockerContainer`) reuses an already-running
  container when its image tag matches; this is what makes warm restarts fast.

### Teardown

Out of scope for this doc — `defineDevstack`'s body does most of it. From this doc's perspective:

- A tag's finalizers attach to its own per-primitive scope. Once that scope closes,
  `Effect.addFinalizer`-registered cleanup runs.
- `tag.test.ts:20-41` pins: "build's finalizer attaches to the ambient (per-primitive) scope".

## Hard requirements / invariants

1. **`Object.assign` mutation in `provide`** (`tag.ts:498`): `provide(TagClass, build, opts)`
   MUTATES the canonical `Context.Service` class with `__layer` / `key` / `__kind` /
   `__displayTitle` / `__watchPaths` / `__pluginName` / `__hidden` / `__upstreamKeys`. The class
   itself becomes the yieldable `LayeredTag`. **Calling two impl factories targeting the same
   canonical tag in the same stack was always a configuration error** (`tag.ts:444-446`); the
   `composeStackLayer` duplicate-key warn (`supervisor.ts:1098`) catches the more common form.

2. **`composeLayers` ordering is provider-before-consumer** (`tag.ts:661-667`):
   `[inner..., primary, projections...]`. `composeStackLayer` folds left-to-right with
   `Layer.provideMerge(layer, acc)`, so each layer consumes from the accumulated layers. Reversing
   this order silently breaks resolution at runtime (`ServiceNotFound`). Pinned by
   `tag-compose.test.ts:115-194`.

3. **`__layers` precedence over `__layer`** (`tag.ts:594-598`, `supervisor.ts:1204`): when a tag has
   both, `__layers` wins so composite primitives' inner layers surface. Pinned by
   `tag-compose.test.ts:148-165`.

4. **`__extraMembers` lifted siblings must be deduped on key** (`supervisor.ts:1082-1103`): a
   composite that lifts a shared inner sibling (e.g. two `Walrus()` instances both contributing
   `gitFetch(...)` of the same upstream Move tree) must surface only once after
   `flattenStackMembers`. Implemented as a first-wins drop in `composeStackLayer`'s
   `keyedMembers.set` (`supervisor.ts:1186`).

5. **`CurrentTagKey` default value** (`tag.ts:51-53`): outside an engine-wrapped build, `setPhase`
   is a silent noop. This is what lets unit tests exercise a primitive's effect directly without
   providing the engine.

6. **Hidden tags must not touch `EngineHandle`** (`tag.ts:341-343`, pinned by
   `tag-compose.test.ts:33-86`): a `{hidden: true}` build runs to completion (and its failure still
   propagates), but no seed entry, `markAcquiring`/`markReady`, or log lines fire. Used by
   `gitFetch` (always hidden — the clone artifact is consumed by the parent, not a row of interest).

7. **`tag()`'s `Name` parameter doubles as the runtime key** (`tag.ts:524`):
   `class T extends Context.Service<TagIdentity<Name>, A>()(name as Name) {}`. The string passed
   becomes both the type-level identity and the lookup key (`@devstack/Foo` or `accounts/alice`,
   etc.). The naming convention is **kebab/dot-namespaced**; in-tree examples: `@devstack/SuiTag`,
   `account/alice`, `accounts.alice`, `package.hello`, `codegen/<name>`, `faucet/<name>`,
   `manifest`, `walrus.cluster`, `seal.local`. There is no uniqueness enforcement at construction;
   `composeStackLayer`'s duplicate-key guard catches conflicts at compose time.

8. **`Object.assign` mutation in `tag` returns the same class reference**
   (`make-service.test.ts:24-28`, `tag.ts:574`): `makeService(...)` MUST return the same impl
   reference (mutating Object.assign) so caller code relying on referential equality continues to
   work.

9. **The `DevstackTagBrand` symbol on every member** (`tag.ts:63-64`, `tag.ts:480`): unique-symbol
   stamped by `provide` / `tag`. `compose/devstack.ts:121-127` `isOptions` checks
   `!(DevstackTagBrand in arg)` to distinguish a tag from a trailing options object. Without this
   brand, an options-shaped tag would be misclassified as options and dropped from the stack. Tests:
   `compose/devstack.test.ts:46-54`.

10. **`fillDefaults` matches Sui by exact key and Faucet by `faucet/` prefix**
    (`defaults.ts:27-28`): so a renamed user Faucet (`Faucet({name: 'custom'})` with key
    `faucet/custom`) still suppresses the auto-append. Pinned by `compose/devstack.test.ts:56-102`.

11. **`manifestRef` declares every sibling key as upstream** (`compose/devstack.ts:151-172`):
    otherwise the user's `extras` Effect — which can `yield*` any user-stack ref — would race
    against the manifest's level in the topo graph and throw `Service not found`. Same treatment is
    patched onto `codegen/`-prefixed members (`compose/devstack.ts:244-258`) with a cycle guard
    (skip siblings that already name codegen as upstream — Dev typically lists Codegen in `needs:`).

12. **`auto-Faucet` must be `{hidden: true}`** (`defaults.ts:32-39`): user didn't type it, so
    surfacing it as a row is confusing ("[sui] faucet pending — what is this?").

13. **`docker-image.ts`'s `SKIP_DIRS` set** (`docker-image.ts:29`): build outputs / caches that must
    never participate in the context-tree hash. Changing this list busts every downstream image tag
    — load-bearing for content-addressed cache hits.

14. **`docker-image.ts`'s short-circuit via `docker image inspect`** (`docker-image.ts:129-137`):
    when the content-addressed tag is already on the daemon, skip `docker build` entirely. Two
    failure modes this prevents: (a) the build cache re-tagging an image we'd point at a snapshot
    via `snapshot.restore`, (b) seconds of wall-time on warm cache. The phase narration
    `building <name>` only fires on cache miss.

15. **`git-fetch.ts` transport allowlist** (`git-fetch.ts:67-89`): only `https://`, `http://`,
    `git://`, `ssh://`, or SCP-style `git@host:path` shorthand. Validated synchronously at factory
    construction so a typo in `gitFetch({repo: '...'})` blows up at config load (where the stack
    trace points at the user's call), not deep in an Effect chain. Same for `ref`
    (`git-fetch.ts:98-121`). Test: `git-fetch.test.ts:12-78`.

16. **`git-fetch.ts` GC of stale refHash siblings** (`git-fetch.ts:198-206`): on a fresh clone,
    every other `refHash` dir under `<parentDir>` is removed. Without this, a moving branch ref
    (`ref: 'main'`) cuts a new refHash on every upstream advance and leaks the prior clone forever.

17. **`docker-one-shot.ts` cache key** (`docker-one-shot.ts:89-103`): content-hashed JSON of
    `{name, image, entrypoint, args, env, mounts, network, inputs}`, BigInt-safe via `jsonReplacer`.
    Persisted under `StateStoreKeys.dockerOneShot(...)`. Cache hits return the prior result with
    `cached: true`.

18. **`dockerContainer`'s image source union deliberately rejects bare strings**
    (`docker-container.ts:74-83`, pinned by `docker-container.test.ts:46-57`): plugin authors must
    spell out `{pull: '…'}` or `{build: {…}}` so the same option doesn't mean both at different
    callsites. The internal `{tag: <pre-resolved>}` variant is on `DockerContainerImageInternal`,
    never on the public union.

19. **`dockerContainer` builder-form requires `staticImage`** (`docker-container.ts:617-622`): when
    options are `(identity) => DockerContainerOptions`, the image must be resolved at factory time
    so the build layer can wrap the container tag's layer. Builder-form callers MUST pass
    `staticImage` as the third arg or the factory throws `TypeError`.

20. **`dockerContainer`'s `engineTagKey` defaults to `CurrentTagKey`**
    (`docker-container.ts:655-656`, `:784`): when the enclosing composite has N container builds
    under one tag (walrus's 4 nodes), all converge on the same engine row — last container's stop
    marks the row "stopped".

21. **Lifecycle wrap is one-shot, not per-yield** (`tag.ts:292-385`): the wrap fires when the Layer
    is built, not every time someone yields the tag. So `markAcquiring` → `markReady` is a single
    transition; subsequent `yield* TagClass` reads from `Context.get` against the resolved value.

22. **`makeService` is the canonical replacement for hand-rolled
    `Object.assign({__kind, __pluginName})`** (`make-service.ts:1-22`): tests in
    `make-service.test.ts:48-58` pin shape-equivalence with the literal Object.assign for
    back-compat with the 24 pre-HOF callsites.

## Failure modes

| Trigger                                                          | Current behavior                                                                                                                                                                                                                                                                                             | Recovery                                                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Build Effect fails inside `withEngineLifecycle`                  | `engine.markFailed(name, cause)` + `engine.appendLog({level: 'error', message: prettyError(cause)})` BEFORE the failure escapes the wrap (`tag.ts:365-379`). Launch loop catches at `Layer.buildWithMemoMap` and waits on `restartSignal`.                                                                   | TUI `r` keypress triggers full restart; user edits config + saves to trigger watch-fire. |
| Build Effect fails inside hidden tag                             | Same as above, but no row to mark — failure still propagates through the consumer's normal failure path (`tag.ts:341-343`, pinned by `tag-compose.test.ts:66-85`).                                                                                                                                           | Same.                                                                                    |
| `gitFetch` malformed repo/ref                                    | Synchronous `throw new GitFetchError(...)` at factory construction (`git-fetch.ts:69-121`).                                                                                                                                                                                                                  | User edits the config.                                                                   |
| `dockerImage` `{build}` context-walk fails (read error)          | `DockerError({phase: 'dockerImage', message: hashLocalTree …, cause})` (`docker-image.ts:58-65`).                                                                                                                                                                                                            | Fix path / perms; restart.                                                               |
| `dockerImage` `{pull}` fails (network, auth)                     | `DockerError({phase: 'dockerImage', message: pull failed, cause: <inner>})` (`docker-image.ts:90-99`).                                                                                                                                                                                                       | Fix network/login; restart.                                                              |
| `dockerContainer` ready probe times out                          | `ReadyProbeError` from `awaitContainerReady` / `awaitReady` (`docker-container.ts:807-814`). When `awaitExit: true` (default), the probe races `docker wait`, so a container crashing during boot surfaces its log tail in the error.                                                                        | Inspect log tail; fix container; restart.                                                |
| `dockerContainer` `routing.entrypoint` not registered            | `DockerError({phase: 'router-entrypoint', message: 'entrypoint X is not registered. Call defineEntrypoint(...) before composing the stack'})` (`docker-container.ts:690-697`).                                                                                                                               | User registers entrypoint at module load.                                                |
| `dockerContainer` `endpoint.routingName` doesn't match any route | `DockerError({phase: 'router-entrypoint', message: "endpoint.routingName='X' doesn't match any routing[].name (have: …)"})` (`docker-container.ts:728-737`).                                                                                                                                                 | Fix the routing name.                                                                    |
| `dockerOneShot` cache miss + `Docker.runOneShot` fails           | `DockerError({phase: 'dockerOneShot', message: dockerOneShot 'X', cause})` (`docker-one-shot.ts:128-138`).                                                                                                                                                                                                   |                                                                                          |
| `hostScript` timeout                                             | `HostProcessError({phase: command, message: "hostScript 'X' timed out after Nms"})` (`host-script.ts:115-122`). SIGTERM is sent at expiry, SIGKILL after `gracePeriodMs`.                                                                                                                                    | Bump `timeoutMs` or fix the command.                                                     |
| Duplicate top-level user-authored tag key                        | `console.warn` (`supervisor.ts:1097-1099`); last-wins applies to layer composition; first-wins applies to topo graph (`supervisor.ts:1186`). Not a throw because rare hand-rolled-layer cases might collide legitimately.                                                                                    | User removes the duplicate.                                                              |
| `__extraMembers` lift collides with sibling-lift                 | First-wins drop, silent (`supervisor.ts:1090-1093`). The `userAuthoredKeys` set distinguishes user-authored collisions (warn) from lifted-sibling dedupes (silent).                                                                                                                                          | (Expected — the whole point of the lift is dedupe.)                                      |
| Stack member missing `__upstreamKeys`                            | When `DEVSTACK_WARN_MISSING_UPSTREAM` env is set, `console.warn` lists the missing keys (`supervisor.ts:1121-1137`). Otherwise silent. Member is treated as a graph leaf (lands at level 0); selective restart drops its downstream cascade.                                                                 | User declares `upstreamKeys: [...]` on the factory.                                      |
| Trailing arg to `devstack(...)` not classifiable                 | `isOptions` returns true iff `typeof === 'object' && !DevstackTagBrand in arg && !Array.isArray`. A plain options-shaped object with `__layer` (a malformed tag) flows through as a ref — pinned by `compose/devstack.test.ts:46-54`. Otherwise `defineDevstack` rejects the bad shape with a runtime error. | Make sure trailing options have no `__layer` field.                                      |
| `tag()` called with `{lifecycle: 'long-lived'}` (deleted option) | `@ts-expect-error` typecheck failure (the field is no longer on `TagOptions` post Phase 2 of selective-restart). Pinned as a meta-test: `tag.test.ts:53-61`.                                                                                                                                                 | Remove the field.                                                                        |

## Persistence model

### What survives restart (full or selective)

- **`StateStore` entries**: `dockerOneShot` cache (`docker-one-shot.ts:147`). Container handles +
  image tags managed by `Docker.run` and the engine — out of this doc's scope.
- **`gitFetch` clones**: `<stateDir>/git/<name>/<refHash>` (`git-fetch.ts:164`). Cache layout is
  content-addressed on `sha256(repo@ref).slice(0,12)`. Stale refHashes GC'd on next clone
  (`git-fetch.ts:198`).
- **Docker images**: content-addressed `devstack-<name>:<treeHash>-<configHash>` tags from
  `dockerImage`. Short-circuit via `docker image inspect` (`docker-image.ts:129`).
- **Docker containers**: adopted on next acquire by `Docker.run` (out of this doc's scope, but
  `dockerContainer` consumes the adoption path transparently).

### What survives snapshot

- Same as restart — devstack's snapshot mechanism (out of this doc's scope) captures the
  `StateStore` + on-disk image tags.

### What `devstack wipe` clears

- `StateStore` entries.
- `gitFetch` clones under `<stateDir>/git/`.
- Docker resources labelled by `devstack.app=<app>` / `devstack.stack=<stack>` (label-based sweep —
  `dockerContainer`'s `Docker.run` stamps these).

### Process-local only

- `withEngineLifecycle`'s `EngineHandle` registration of primitive scopes (in-memory).
- `CurrentTagKey` reference value (in-memory, scoped to the build effect).
- `defineEntrypoint`'s router-entrypoint registry (module-level mutable map; reset on process exit).
- `watchedFileHashes` map in supervisor (`supervisor.ts:537`) — content-hash dedupe across watch
  events.

## Modes & variants

The programmable API surface is largely single-mode (one shape of `tag`/`provide`, one shape of
`devstack(...)`/`defineDevstack`), but it has three sub-variants worth tabulating:

### Variant 1 — Tag construction style

| Dimension                 | `tag(name, build, opts)`                                                                                       | `provide(TagClass, build, opts)`                                                                                                                         | Hand-rolled `{__layer, __layers, key, ...}`                                                                                                                                             |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| When to use               | Per-instance one-off tag (per-account, per-package, action, custom plugin not implementing a shared interface) | Implementing a SHARED interface tag (multiple impl factories `→` one canonical `Context.Service` class)                                                  | Composite primitive projecting one body into MULTIPLE interface tags via `Layer.effectContext`, OR composite lifting inner siblings via `__extraMembers`                                |
| Creates new class?        | Yes — `class T extends Context.Service<TagIdentity<Name>, A>()(name) {}` (`tag.ts:524`)                        | No — mutates the passed `TagClass` via `Object.assign` (`tag.ts:498`)                                                                                    | No — returns a POJO satisfying the `StackMember` interface                                                                                                                              |
| `key` field               | The `name` parameter                                                                                           | `TagClass.key` (e.g. `'@devstack/SuiTag'`)                                                                                                               | Caller-supplied (e.g. `LOCAL_CLUSTER_KEY = '@devstack/WalrusLocalCluster'`)                                                                                                             |
| Lifecycle wrap            | Yes (`withEngineLifecycle`)                                                                                    | Yes (`withEngineLifecycle`)                                                                                                                              | No — manual `markAcquiring` / `markReady` / `markFailed` (`local-cluster.ts:186-239`)                                                                                                   |
| Supports `__extraMembers` | No (factory returns `LayeredTag`, which doesn't carry `__extraMembers` on its public type)                     | No (same)                                                                                                                                                | Yes — required for lifted siblings                                                                                                                                                      |
| Supports `__layers`       | Yes via `extraLayers` opt or by mutating the result (sui: `Object.assign(tag, { __layers: layers })`)          | Yes via mutating the result                                                                                                                              | Yes — that's the whole point                                                                                                                                                            |
| In-tree examples          | `Account()`, `Package()`, `Action()`, `Codegen()`, `Coin()`, `Dev()`                                           | `Sui()` (via `suiLocalnet` / `suiTestnet` / `suiMainnet` / `suiFork`), `Postgres()`, `Pyth()`, `Faucet()`, `sealLocalKeygen` (its inner internal tag), … | `walrusLocalCluster` (`local-cluster.ts:333-349`), `sealLocalKeygen` (`internal.ts:1200-1216`), `suiLocalnet` (mutates after `provide` to attach inner image `__layers`, `sui.ts:1271`) |
| Out-of-tree pattern       | Yes (preferred — `Redis()` example uses `dockerContainer` which itself uses `tag`)                             | Rare — would require importing a canonical tag class from `/advanced`                                                                                    | Discouraged — escape hatch only                                                                                                                                                         |

### Variant 2 — Top-level entry

| Dimension                  | `devstack(...refs)` (default)                                                                 | `defineDevstack(config)` (advanced)                                                    |
| -------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Import                     | `@mysten-incubation/devstack` (main barrel)                                                   | `@mysten-incubation/devstack/advanced`                                                 |
| Signature                  | Variadic `(...args: ReadonlyArray<Ref \| Ref[] \| DevstackComposeOptions>) => DevstackHandle` | `(input: StackMember[] \| DevstackConfig) => DevstackHandle`                           |
| Default-fill               | Yes — `Sui()` + `Faucet({hidden: true})` auto-added when missing (`defaults.ts`)              | No — caller passes exactly what they want                                              |
| Auto-manifest              | Yes — `manifestRef(siblingKeys)` appended (`compose/devstack.ts:260`)                         | No                                                                                     |
| Codegen sibling-keys patch | Yes (`compose/devstack.ts:244-258`)                                                           | No                                                                                     |
| Renderer resolver          | Default `tuiRendererFactory` / `plainRendererFactory` wired (`compose/devstack.ts:54-98`)     | Caller must wire (or accept silent renderer fallback)                                  |
| Use case                   | Every example app                                                                             | Test fixtures, custom state-store keys, callers that want to pre-build the Layer graph |

### Variant 3 — Plugin-author primitive shapes

| Primitive                                    | Returns                                                                   | Use case                                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dockerImage({name, pull \| build})`         | `LayeredTag<Name, {tag, digest}>` (`kind: 'action'`)                      | Content-addressed image build/pull                                                                                                                 |
| `dockerContainer(name, options)`             | `LayeredTag<Name, DockerContainerHandle>` (`kind: 'service'`)             | Long-lived container (services)                                                                                                                    |
| `runDockerContainer(name, options)`          | `{imageLayers, effect: Effect<DockerContainerHandle>}`                    | Same machinery, called from inside an existing `Effect.gen` — for factories that need to translate `DockerError` to a domain-specific tagged error |
| `dockerOneShot({name, image, ...})`          | `LayeredTag<Name, {exitCode, stdout, stderr, cached}>` (`kind: 'action'`) | One-shot container action with cached result. **Sunset 2026-11-19** if no caller emerges.                                                          |
| `gitFetch({name, repo, ref, subdirectory?})` | `LayeredTag<Name, {path, ref, sha}>` (`hidden: true`)                     | Cache an upstream repo at a ref                                                                                                                    |
| `hostScript({name, command, args?, ...})`    | `LayeredTag<Name, {exitCode, stdout}>` (`kind: 'action'`)                 | Spawn a host process to completion. **Sunset 2026-11-19** if no caller emerges.                                                                    |

## Test coverage

### `src/advanced/tag.test.ts`

| Block                                                                                       | Asserts                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tag() lifecycle wrap` > `build's finalizer attaches to the ambient (per-primitive) scope`  | `Effect.addFinalizer` inside a tag's build attaches to the ambient layer scope (not to a long-lived "lifecycle: long-lived" scope, which Phase 2 of selective-restart deleted). Closing the per-cycle scope fires the finalizer. |
| `tag() shape` > `surfaces __layer and __layers`                                             | Trivial smoke: `t.key`, `t.__layer`, `t.__layers.length >= 1`.                                                                                                                                                                   |
| `tag() shape` > `rejects 'lifecycle' at the type level (P2.T3 — option deletion meta-test)` | `@ts-expect-error` regression — if `lifecycle` is re-added to `TagOptions`, this directive flags as unused and CI flips red.                                                                                                     |

### `src/advanced/tag-compose.test.ts`

| Block                                                                                                    | Asserts                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hidden tag` > `build runs and value resolves without surfacing a TUI entry`                             | A `{hidden: true}` tag's build runs and value resolves; `engine.tuiState` has no entry for it.                                                             |
| `hidden tag` > `failure inside a hidden tag still propagates to the consumer`                            | Hidden failure preserved (`Effect.flip` yields `'boom'`); engine still has no entry.                                                                       |
| `hidden tag` > `non-hidden tag does surface an entry (control case)`                                     | Sanity check — `kind: 'service'` tag's entry status flips to `'ready'`.                                                                                    |
| `composeLayers ordering` > `inner → primary → projections is the emitted order`                          | `composeLayers({inner: [innerTag], primary, projections: [projA, projB]})` returns `[innerA, innerB, primary, projA, projB]` in that order.                |
| `composeLayers ordering` > `undefined inner entries are dropped (conditional inclusion)`                 | `inner: [{__layer: innerA}, undefined, undefined]` yields `[innerA, primary]`.                                                                             |
| `composeLayers ordering` > `inner __layers takes precedence over __layer (transitive fan-out)`           | When inner carries both, `__layers` wins so inner composite tags surface their full layer set.                                                             |
| `composeLayers ordering` > `later layer wins on overlapping Context.Reference (deterministic last-wins)` | Pins the fold semantic: `provideMerge(layer, acc)` left-to-right → later layer wins for the same tag. A refactor reversing fold direction would flip this. |

### `src/advanced/make-service.test.ts`

| Block                                                                     | Asserts                                                                                                               |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `stamps __kind and __pluginName`                                          | After `makeService('myplugin', 'service', t)`, `stamped.__kind === 'service'`, `stamped.__pluginName === 'myplugin'`. |
| `returns the same reference (mutating Object.assign)`                     | `stamped === t`.                                                                                                      |
| `preserves pre-existing tag fields (__layer, __layers, key)`              | Stamping doesn't clobber existing fields.                                                                             |
| `accepts every TagKind discriminator`                                     | Iterates `['service', 'action', 'app', 'account', 'package']` and verifies each is settable.                          |
| `matches the literal Object.assign(impl, {__kind, __pluginName}) shape`   | Back-compat with the 24 pre-HOF call sites.                                                                           |
| `overwrites existing __kind / __pluginName when called twice (last-wins)` | Defensive — last-wins semantic of `Object.assign`.                                                                    |

### `src/advanced/plugin-author/docker-container.test.ts`

| Block                                                                    | Asserts                                                                                                                          |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `returns a LayeredTag with the canonical metadata fields`                | `t.key`, `t.__layer`, `t.__layers.length >= 2` (image layer + own layer), `t.__kind === 'service'`, `t.__displayTitle === name`. |
| `accepts the {build: {...}} image source`                                | `dockerContainer(name, {image: {build: {context, dockerfile, buildArgs}}})` returns a LayeredTag.                                |
| `rejects bare-string 'image' at the type level (compile-only assertion)` | `@ts-expect-error` — `DockerContainerImage = 'postgres:15'` fails typecheck.                                                     |
| `omits routing-related fields when no 'routing' is configured`           | `t.__watchPaths === undefined`, `t.__hidden === undefined`.                                                                      |

### `src/advanced/plugin-author/git-fetch.test.ts`

| Block                                                              | Asserts                                                                     |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `throws GitFetchError for an empty repo`                           | Sync validator.                                                             |
| `throws GitFetchError for a repo starting with - (flag-injection)` | Sync validator (avoids `git clone -<flag>` injection).                      |
| `throws GitFetchError for a disallowed transport (file://)`        | Transport allowlist (https/http/git/ssh/SCP only).                          |
| `throws GitFetchError for an empty ref`                            | Sync ref validator.                                                         |
| `throws GitFetchError for a ref starting with -`                   | Flag-injection guard.                                                       |
| `throws GitFetchError for a ref with disallowed characters`        | Conservative allow-set: alphanumeric + `_ / . @ + - = :`.                   |
| `throws GitFetchError for a ref containing the @@ typo`            | Defense-in-depth typo check.                                                |
| `thrown values carry the GitFetchError _tag`                       | `err._tag === 'GitFetchError'`, message matches `/repo must not be empty/`. |
| `accepts a well-formed https repo + ref without throwing`          | Happy path doesn't hit network — pure validator.                            |
| `accepts the SCP-style git@host:owner/repo.git shorthand`          | SCP form is whitelisted.                                                    |

### `src/compose/devstack.test.ts`

| Block                                                                           | Asserts                                                                                                                 |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `returns a handle with 'layer', 'run', and 'runMain'`                           | Basic shape: `typeof run === 'function'`, `typeof runMain === 'function'`, `layer` defined.                             |
| `accepts a mix of refs and ref arrays in the variadic args`                     | `devstack(alice, [bob, hello])` flattens.                                                                               |
| `accepts trailing options`                                                      | `devstack(alice, {renderer: 'silent'})` works.                                                                          |
| `recognizes a plain options object (no __layer) as options, not a ref`          | The trailing-options branch fires (if missed, `defineDevstack` rejects with a runtime error on the stack member shape). |
| `treats an object with __layer as a ref even when it shares option-shaped keys` | `isOptions` skips anything with the `DevstackTagBrand`.                                                                 |
| `does NOT auto-append a Faucet when the user supplied one`                      | No duplicate-key warning fires (would surface as `console.warn` from `composeStackLayer`).                              |
| `still auto-appends a Faucet when the user did NOT supply one`                  | Sanity check the dedup gate doesn't over-fire.                                                                          |
| `honors a custom-named user Faucet (Faucet({name: ...}))`                       | Dedup matches `faucet/` prefix so a renamed user Faucet still suppresses auto-append.                                   |

## Pain points today

1. **`provide` mutates its argument** (`tag.ts:498`): the canonical `Context.Service` class is
   mutated with `__layer` / `key` / etc. via `Object.assign`. Calling two impl factories against the
   same class in the same stack is "a configuration error" (`tag.ts:444-446`), but nothing in the
   type system prevents it. The duplicate-key guard catches the user-facing form at compose time,
   but the underlying mutation makes the failure mode unpredictable when two stacks share the same
   module instance (e.g. a test importing `SuiTag` after a sibling test already mutated it).

2. **Hand-rolled escape hatch (no helper)** (`local-cluster.ts:333-349`,
   `seal/internal.ts:1200-1216`, `sui.ts:1271`): every composite primitive that needs
   `__extraMembers` or wants to project one body into multiple interface tags hand-rolls the POJO
   and types it as `as unknown as StackMember`. There's no `compositeTag(...)` helper analogous to
   `tag()` / `provide()`. The fields it must remember to set: `__layer`, `__layers`,
   `__extraMembers`, `__kind`, `__pluginName`, `__displayTitle`, `__upstreamKeys`, `key`. Drift here
   would silently break the dep graph / TUI sectioning / selective restart. Lift-related rationale
   lives in scattered comments (`supervisor.ts:122-145`, `local-cluster.ts:302-322`,
   `seal/internal.ts:1159-1216`) — the contract for what makes a composite vs a single-tag isn't
   centrally documented.

3. **Lifecycle wrap doesn't apply to hand-rolled composites** (`local-cluster.ts:186-239`):
   walrus/seal manually call `engine.markAcquiring` / `markReady` / `markFailed` and manually thread
   `setPhase` via a `pushPhase` callback. If a future engine method lands (e.g.
   `markPhaseDuration`), every hand-rolled composite has to update. This is the price of the
   `Layer.effectContext` shape — `withEngineLifecycle` only knows how to wrap a single-shape
   `Effect<A>`.

4. **`tag` and `provide` duplicate field-stamping logic** (`tag.ts:471-499` vs `tag.ts:549-575`):
   the two factories independently build the `extras` object with all the same conditional field
   assignments. A new field added to `ProvideOptions` must be added in both places, plus the
   hand-rolled escape hatch sites.

5. **`__upstreamKeys` resolution accepts both string and `LayeredTag`** (`tag.ts:412-427`): callers
   can pass either, which makes the call site loose but means a typo in a string ("@devstack/SuiTag"
   vs "@devstack/Sui") silently lands as a dangling reference dropped by `buildDepGraph`. The
   factories that mix `SuiTag.key` with `[...seedAccountTags, ...innerSiblings]`
   (`local-cluster.ts:332`) are particularly easy to get wrong because some entries are strings and
   others are tags.

6. **`composeStackLayer` warns aggregate-line about missing `__upstreamKeys` only when an env var is
   set** (`supervisor.ts:1121`): defaulting to silent means a primitive that forgot to declare its
   upstreams works correctly at the layer level (MemoMap dedupes), but appears as a leaf in
   `buildDepGraph` and drops its downstream cascade. Easy to overlook.

7. **Codegen sibling-keys patching** (`compose/devstack.ts:244-258`): `compose/devstack.ts` reaches
   in and mutates `__upstreamKeys` on every `codegen/`-prefixed member after the user composed the
   stack, with a cycle guard. This is a one-off escape hatch for "ANY user ref might appear in the
   extras Effect" — but the pattern of "patch upstreamKeys post-compose" can't be repeated for other
   primitives without growing the same special case. The manifest emitter has the same problem but
   solves it more cleanly via `manifestRef(siblingKeys)`.

8. **Two sunset-marked primitives with no in-tree callers** (`docker-one-shot.ts:60-65`,
   `host-script.ts:44-53`): `dockerOneShot` and `hostScript` have zero in-tree callers as of Wave
   6.8 and are scheduled for removal 2026-11-19 unless an out-of-tree user surfaces. They are kept
   on the API surface for plugin-author needs that don't fit `dockerImage` / `dockerContainer` /
   `gitFetch`, but no one has reached for them yet.

9. **`docker-container.ts` is 853 lines** — and the bulk is options-typedef commentary + the
   `dockerContainer` / `runDockerContainer` / `buildContainerInternals` triple-fork. The
   `DockerContainerImageInternal` `{tag}` branch (`docker-container.ts:98`) is in-tree-only but
   lives on the same module as the public surface, which means a plugin author reading
   `docker-container.ts` to understand the shape has to skip past the internal escape hatch.

10. **`compose/devstack.ts` patches stack members in place** (`compose/devstack.ts:257`):
    `(m as { __upstreamKeys: ReadonlyArray<string> }).__upstreamKeys = merged`. This works because
    the tag substrate already uses `Object.assign` mutation, but it's a pattern that doesn't
    generalize — and a parallel-agent change to one of the composite primitives could observe the
    patched value mid-run.

11. **`makeService` HOF was added after the fact** (`make-service.ts:1-22`): it replaced 24
    hand-rolled `Object.assign(impl, {__kind, __pluginName})` sites. New code should reach for it,
    but the substrate `tag` / `provide` still emit `__kind` / `__pluginName` themselves via the
    `kind` / `plugin` options, so there are TWO ways to get the same stamping. The redundancy means
    a plugin author can do either pattern; `makeService` is mostly for the hand-rolled composite
    escape hatches that don't use `provide` / `tag` at all.

12. **`DevstackComposeOptions extends Omit<DevstackConfig, 'stack'>`** (`compose/devstack.ts:105`):
    the trailing options to `devstack(...)` mirror `DevstackConfig` minus `stack`. The two types are
    coupled but live in two different files (compose vs supervisor). Adding a new top-level config
    knob requires touching both.

## Open questions

1. **What is the right helper for hand-rolled composite primitives?** There's no
   `compositeTag({key, plugin, kind, layerContext, innerSiblings, upstreamKeys})` helper. Every
   composite site reimplements the POJO and the manual lifecycle hooks. The substrate offers
   `composeLayers({inner, primary, projections})` for the layer-ordering piece, but the wrapping
   `Object.assign` + `__extraMembers` + manual `markAcquiring`/`markReady` is open-coded everywhere.

2. **`__extraMembers` contract** — what's the order semantic across nested composites?
   `flattenStackMembers` walks recursively (`supervisor.ts:1019-1025`), but the test coverage
   doesn't pin a deeply-nested case. OPEN QUESTION: if composite A lifts composite B as an extra
   member, and B itself lifts inner C, does C end up at level 0 (with A and B as downstreams) or at
   the same level as B?

3. **`tag()` vs `provide()` choice for one-off tags** — when an out-of-tree plugin wants to declare
   a new tag with a unique key, both work. `provide(SomeNewClass, build)` requires the author to
   write `class SomeNewTag extends Context.Service<...>()(...)` themselves; `tag(name, build)` does
   that internally. The barrel comment (`advanced/index.ts:46-50`) implies `makeService` is the
   canonical out-of-tree shape, but `makeService` only stamps `__kind` / `__pluginName` — it doesn't
   replace the underlying `tag()` call.

4. **Hand-rolled `{__layer}` escape hatch — what services does it skip?** The supervisor comment
   (`supervisor.ts:108-112`) calls out walrus/seal as the canonical sites. OPEN QUESTION: does the
   escape hatch skip:
   - `withEngineLifecycle` (yes — composites call `markAcquiring`/`markReady` manually).
   - `CurrentTagKey` pinning (yes — composites use the closed-over `LOCAL_CLUSTER_KEY` directly).
   - `DevstackTagBrand` (NO — `local-cluster.ts:333` returns a POJO that does NOT carry the brand;
     the `isOptions` check in `compose/devstack.ts:121-127` would mis-identify it as options. But
     `walrusLocalCluster` is called by `Walrus()` which goes through `makeService`, which doesn't
     stamp the brand either. How does the brand check survive here? Possibly via inheritance — the
     underlying `Context.Service` class carries it. Worth verifying.)
   - Per-primitive scope registration with the engine (yes — `engine.registerPrimitiveScope` is
     called only by `withEngineLifecycle`).

5. **`DevstackTagBrand` on hand-rolled composites** — the brand is stamped by `provide` / `tag`
   (`tag.ts:480`, `tag.ts:564`), but `walrusLocalCluster` (`local-cluster.ts:333-349`) returns a
   POJO without it. Yet `compose/devstack.ts:121-127`'s `isOptions` check relies on the brand to
   discriminate refs from options. OPEN QUESTION: why doesn't the brand-less walrus composite get
   misclassified? (Hypothesis: the underlying `provide(...)` call inside the composite returns a
   class with the brand, but the composite then returns a POJO that doesn't carry it. The fact that
   this works today is either luck — walrus is never the last variadic arg — or there's another
   discriminator path I'm missing.)

6. **Renderer factory wiring** — `compose/devstack.ts:94-98` wires the default resolver (TUI/plain).
   `defineDevstack` (the lower-level entry) does NOT — callers using `defineDevstack` directly get
   the silent renderer fallback (`supervisor.ts:292-293`) unless they pass a `rendererResolver`.
   OPEN QUESTION: is this intentional, or should `defineDevstack` also default to TTY-detection?

7. **`extras` resolution scope** — `ExtrasResolved` carries a memoized Effect that may yield ANY
   user-stack ref (`compose/devstack.ts:144-149`). The patching of `codegen/`-prefixed members +
   manifestRef are the only two consumers that get the sibling-keys treatment. OPEN QUESTION: what
   happens if a user writes a hand-rolled tag that consumes `ExtrasResolved`? It would fail with
   `Service not found` for any ref it yields that isn't already at a strictly-lower topo level. Is
   there a generalizable solution beyond manually patching `__upstreamKeys`?

8. **`Effect.serviceOption(EngineHandle)` in plugin-author primitives** — `tag.ts:312` resolves
   `EngineHandle` as optional so a tag can be tested standalone. But the in-tree code path
   (`InfraLive` always provides `EngineHandle`) means the `None` branch is dead in production. OPEN
   QUESTION: is the standalone-test usability worth the per-yield serviceOption resolve, or could we
   provide a `NoopEngineHandle` Layer for tests?

9. **`__watchPaths` patterns and selective restart** — the comment at `tag.ts:174-201` notes that
   today watch fires a FULL-STACK restart, with selective per-primitive teardown tracked as future
   work that will key on `__watchPaths`. OPEN QUESTION: is the selective-restart path
   (`engine.invalidateSubset`) wired to `__watchPaths` today, or only to `__upstreamKeys`-derived
   downstream closures? (`supervisor.ts:1454` references the closure, but the watch-fire path's
   invalidation target isn't visible from the tag substrate alone.)

10. **`makeService` vs `provide({plugin})` redundancy** —
    `provide(TagClass, build, {plugin: 'walrus'})` stamps `__pluginName`.
    `makeService('walrus', 'service', tag(...))` also stamps it. Hand-rolled composites use
    `makeService`. The in-tree consistency rule is unclear — what's the canonical way for a new
    plugin author to attribute their tag?

11. **`docker-container.ts`'s comment about `containerPrimitive`** (`docker-container.ts:535-545`):
    mentions `containerPrimitive(spec)` in `engine/container-primitive.ts` as the "canonical
    race-safe shape for new code" while `dockerContainer` stays as the simpler historical surface.
    OPEN QUESTION: is `dockerContainer` deprecated in favor of `containerPrimitive`, or are they
    parallel surfaces? `containerPrimitive` is not exported from `/advanced` (not in the barrel), so
    plugin authors can't reach for it today even if they wanted to.

## Opportunities noticed

1. **Centralize the lifecycle-wrap + brand-stamp pattern in a single helper.** The pattern
   `extras = {__layer, key, [DevstackTagBrand]: true, ...optional fields}; Object.assign(class, extras)`
   is duplicated between `provide` (`tag.ts:471-499`) and `tag` (`tag.ts:549-575`). Plus the
   hand-rolled composites (walrus, seal, …) duplicate the same field set as a POJO. A
   `materialize({class, layer, layers?, key, kind?, displayTitle?, watch?, plugin?, hidden?, upstreamKeys?, extraMembers?})`
   helper would dedupe.

2. **Surface a `compositeTag()` helper.** The hand-rolled composite shape (walrus / seal) is
   load-bearing but undocumented in the API surface. A first-class helper would carry the contract
   (you need `__layers` for the inner→primary→projections fold AND `__extraMembers` for the lifted
   siblings AND manual `markAcquiring`/`markReady` because you're going through
   `Layer.effectContext`) into one place.

3. **`makeService` vs `{plugin}` option redundancy** — pick one.
   `provide(TagClass, build, {plugin: 'walrus'})` already does the work;
   `makeService('walrus', 'service', impl)` is a leftover from the hand-rolled era. Either deprecate
   `makeService` (forcing all plugin attribution through `provide`/`tag` opts) or codify
   `makeService` as the canonical post-construction stamp and remove `plugin`/`kind` from
   `ProvideOptions`.

4. **`DEVSTACK_WARN_MISSING_UPSTREAM` should be on by default** — or graduated to a throw — for
   unreleased devstack. Today it's silent unless an env var is set (`supervisor.ts:1121`); a
   primitive that forgets to declare `upstreamKeys` works at the layer level but drops its
   downstream cascade. Per the "no compat for never-cases" memory, devstack is unreleased —
   defaulting to loud is safe.

5. **`compose/devstack.ts:244-258`'s codegen patching is a special case** — could be generalized to
   "any member with `__readsExtras: true`" via a new opt, so codegen and manifestRef both express
   the same need declaratively rather than via key-prefix sniffing + post-compose mutation.

6. **`dockerOneShot` + `hostScript` sunset** — Wave 6.8 marked these for removal 2026-11-19. The
   substrate doc should explicitly note the sunset window so the architecture-design phase knows
   whether to design around them. Per the "delete completed plans" memory, if the sunset passes
   without a caller, the source files + the `/advanced` barrel entries should be deleted in one go.

7. **`compose/devstack.ts:152-172` manifestRef leaks a `tag()` call into compose** — the manifest is
   a hidden+kind:'app' tag with `siblingKeys: ReadonlyArray<string>` declared as upstreams. The
   shape is sui-generis (read-extras, top-level only). Could be expressed as an `auto: 'manifest'`
   opt on `DevstackConfig` and pushed into `defineDevstack`, removing the cross-layer reach from
   `compose/`.

8. **`compose/devstack.ts:115-127`'s `isOptions` discriminator** is brittle — relies on
   `DevstackTagBrand` being on every ref, but hand-rolled composites' POJOs may not carry it (see
   Open Question 5). Switching to a positive `hasDevstackTagBrand` check OR adding the brand to all
   hand-rolled composites would close the gap.

9. **`/advanced/index.ts` barrel groups exports into 7 numbered tiers via comments** — the structure
   is good but the tiers don't map to import paths. A tiered import
   (`@mysten-incubation/devstack/advanced/substrate`, `…/plugin-author`, `…/codegen`) would give
   static-analysis-friendly tree shaking and make the API surface easier to navigate.

10. **`StackMember` is structural ("anything with `__layer`")** — but the type doesn't expose
    `__layers` / `__extraMembers` / `__kind` / `__displayTitle` / `__watchPaths` / `__pluginName` /
    `__upstreamKeys` / `key` consistently on the public type, so call sites use
    `as { __watchPaths?: ... }` casts throughout `supervisor.ts:1379-1430`. Tightening `StackMember`
    to require these fields (or moving them onto a richer subtype) would remove the casts.

11. **`docker-container.ts` is too large for a single primitive** (853 LOC). Splitting
    `dockerContainer` (the tag-shape factory) from `runDockerContainer` (the Effect-shape factory)
    from `buildContainerInternals` (the shared body) into separate files would clarify the API
    surface. Today the `{tag: <pre-resolved>}` in-tree escape hatch (`docker-container.ts:98`) lives
    alongside the public surface.

12. **Plugin-author primitives don't share an `Effect.fn(name)` convention.** `dockerImage` uses
    `Effect.withSpan('DockerImage(<name>)')`; `dockerContainer` uses
    `Effect.withSpan('DockerContainer(<name>)')`; `gitFetch` uses
    `Effect.withSpan('GitFetch(<name>)')`; `walrusLocalCluster` uses
    `Effect.fn('walrusLocalCluster(<name>)')`. Standardizing on one shape (and surfacing it as a
    helper) would tighten the observability story.

13. **`composeLayers({inner, primary, projections})` doesn't validate that `inner`'s last entry
    provides what `primary` consumes.** A typo or missing inner layer fails at runtime with
    `ServiceNotFound`. A typed `dependsOn` slot on `primary` (verified at compose time) would shift
    the failure earlier. Today the verification is "the test that exercises this composite catches
    it".

14. **`tag-compose.test.ts:115-194`'s ordering tests use
    `Layer.empty as unknown as Layer.Layer<any, any, any>` casts** — because `composeLayers`'s
    `any`-channel types don't accept `never`. Tightening the type signature (or introducing a
    `Layer.identity()` helper sized to `<any,any,any>`) would remove the test-only cast.

15. **`make-service.ts` lives in `/advanced/` but is imported by `services/*` (in-tree)** — the
    boundary is a little fuzzy. Either `/advanced/` is the public plugin-author surface and
    `make-service` belongs deeper, or in-tree services should reach for `provide({plugin, kind})`
    directly. The dual `{plugin, kind}` in `ProvideOptions` + `makeService` HOF is the redundancy
    noted in Opportunity 3.

16. **`gitFetch` is always `{hidden: true}`** (`git-fetch.ts:276`) — but it carries no `kind`. The
    `hidden` semantics override the kind, but at the type level any `kind` value would be accepted.
    Pin the constraint at the type level (a `HiddenTagOptions` variant that doesn't accept `kind` /
    `display`) to prevent confusion.
