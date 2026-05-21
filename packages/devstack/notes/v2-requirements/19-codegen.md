# codegen

## Purpose

The codegen subsystem reads devstack's per-stack runtime state (the registries — Package, Endpoint,
Account, Coin, plus the per-service state registries) and emits a TypeScript "kit" that the user's
app code imports directly. Two layers: the **engine** (`src/codegen/`) defines the plug-in `Emitter`
contract, a `CodegenError` taxonomy, and shared `fsOp` / `writeIfChanged` helpers; the **service
factory** (`src/services/codegen.ts`) is the `Codegen({...})` LayeredTag a user drops into a
`devstack(...)` stack to declare "run these emitters against the resolved stack state, emit into
`./src/generated/`". The four built-in emitters (`BindingsEmitter`, `StackHandleEmitter`,
`DappKitConfigEmitter`, `DeepbookConfigEmitter`) collectively produce: typed Move-to-TS bindings
under `bindings/<pkg>/`, semantically-named handles (`accounts.ts` / `services.ts` / `extras.ts` /
`captured.ts` / `packages.ts` / `coins.ts`), a `dapp-kit-config.ts` the app spreads into
`createDAppKit(...)`, and (when the stack runs deepbook) a `deepbook-config.ts` the app spreads into
`client.$extend(deepbook(...))`. All writes go through a stage-and-swap pipeline so a watching Vite
dev server never observes a half-emitted tree.

Key terms used throughout:

- **LayeredTag** — devstack's wrapper around an Effect Layer; produced by the `tag(...)` factory in
  `src/advanced/tag.ts`. Carries a Context tag, the Layer that supplies it, plus metadata (`kind`,
  `displayTitle`, `watch`, `upstreamKeys`) the supervisor reads. Yielding a LayeredTag inside an
  Effect resolves to the underlying value.
- **Registry** — append-only Ref-backed store the platform exposes as a `Context.Service` tag (e.g.
  `PackageRegistry`, `EndpointRegistry`, `CoinRegistry`). Each per-service primitive `register`s its
  outputs at acquire time; `gatherManifest()` reads all of them at codegen time.
- **Manifest** — the unified shape produced by `runtime/service.ts::gatherManifest()` from the
  registries; the on-disk `.devstack/manifest.json` is one serialization, the codegen emitters
  another (live snapshot, not the disk file).
- **MVR placeholder** — Move-Verifiable Resolver alias (e.g. `@local/connect_four`) that dApp-Kit
  resolves to a chain-specific package id; emitting MVR strings rather than raw `packageId`s keeps
  generated bindings portable across networks.
- **Stage-and-swap** — atomic directory replace primitive (`engine/stage-and-swap.ts`): emitters
  write into `<target>.staging-<pid>-<rand>/`, then a single `rename(2)` promotes it over
  `<target>`. POSIX guarantees same-FS rename is atomic.
- **Emitter** — `{ name, emit }` plug-in (see `define-emitter.ts`); `emit` receives a
  `CodegenContext` (`{ packages, outputDir }`) and writes files. Run by the `Codegen` factory in
  declaration order, serialised (concurrency 1).
- **Fingerprint** — content hash of the inputs to one emit cycle; the bindings emitter folds
  source-tree mtimes into a fingerprint so re-runs with identical inputs short-circuit without
  invoking `sui move summary` or the dir swap.

## Current implementation

File-by-file inventory.

### Engine (`src/codegen/`)

| File                                            | LOC | Summary                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------- | --: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------- |
| `src/codegen/define-emitter.ts`                 |  91 | Emitter plug-in contract: `CodegenPackage`, `CodegenContext`, `Emitter<R>` interface, `defineEmitter` helper.                                                                                                                                                                                                             |
| `src/codegen/errors.ts`                         |  14 | `CodegenError` tagged class with closed `phase` set (`'read'                                                                                                                                                                                                                                                              | 'generate' | 'write'`) from `engine/phases.ts::CodegenPhases`. |
| `src/codegen/helpers.ts`                        |  60 | `fsOp` (curry a `() => Promise<T>` into `Effect<T, CodegenError>` with emitter+phase tagging) and `writeIfChanged` (Effect wrapper around `engine/atomic-write.ts::writeFileAtomicIfChanged` plus explicit post-write chmod).                                                                                             |
| `src/codegen/emitters/bindings.ts`              | 340 | `BindingsEmitter` — Move→TS bindings via `@mysten/codegen`. Per-package `sui move summary` (preferring the `SuiBuildContainer`'s pinned binary, falling back to host `sui`), stage-and-swap into `<outputDir>/bindings/`, per-instance closure-scoped fingerprint cache, duplicate-name dedupe (first wins with warning). |
| `src/codegen/emitters/stack-handle.ts`          | 205 | `StackHandleEmitter` — emits `accounts.ts`, `services.ts`, `extras.ts` (0o600), `captured.ts`, `packages.ts`, `coins.ts` from `gatherManifest()`. No-op writes via `writeIfChanged`.                                                                                                                                      |
| `src/codegen/emitters/dapp-kit-config.ts`       | 227 | `DappKitConfigEmitter` — emits `dapp-kit-config.ts` (0o600) with network/rpcUrl/MVR-overrides/burner-wallet wiring. Fork-network stripping; skip-emit when sui not in manifest yet.                                                                                                                                       |
| `src/codegen/emitters/deepbook-config.ts`       | 386 | `DeepbookConfigEmitter` — emits `deepbook-config.ts` (typed `deepbookConfig` for `@mysten/deepbook-v3`): packageIds, coins (SUI+DEEP seeded, rest from CoinRegistry, Pyth feed/PIO merged), pools, marginPools, optional pyth block. Skips emit when `services.deepbook` absent or `captured.deepTreasuryId` missing.     |
| `src/codegen/emitters/__integration_emitted__/` |   — | Per-worker scratch dir for the integration test (`it-<pid>-<rand>/`). Gitignored.                                                                                                                                                                                                                                         |

Engine src LOC: **1323**.

### Service factory (`src/services/`)

| File                      | LOC | Summary                                                                                                                                                                                                                                                       |
| ------------------------- | --: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/services/codegen.ts` | 327 | `Codegen(opts)` LayeredTag factory. Resolves package refs through their tags, dedupes by name, collision-checks emitter names, runs emitters serially under `stageAndSwap` over `outputDir`, then writes a `.gitignore` (preserving any user-customized one). |

Service-factory src LOC: **327**.

### Tests in scope

| File                                                          | LOC | Summary                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------- | --: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/codegen/emitters/bindings.test.ts`                       | 357 | Bindings happy-path, atomic swap with pre-existing tree, fingerprint short-circuit, source-edit invalidation, per-instance cache isolation, KnownPackage skip, duplicate-name dedupe. Mocks `@mysten/codegen` + stubs `ChildProcessSpawner`.                                                                    |
| `src/codegen/emitters/stack-handle.test.ts`                   | 192 | Emits all six files, extras propagation (1daec503 regression guard), no-op re-emit (mtime stable), empty-accounts render.                                                                                                                                                                                       |
| `src/codegen/emitters/dapp-kit-config.test.ts`                | 185 | Network/rpcUrl/MVR-overrides emit, chmod-tightening on re-emit (0o644 → 0o600), wallet manifest embedding, `enableBurnerWallet:false` branch, cold-boot skip when no SUI_RPC endpoint.                                                                                                                          |
| `src/codegen/emitters/dapp-kit-config.fork.test.ts`           | 163 | Fork-network translation: `mainnet-fork` / `testnet-fork` / `devnet-fork` strip to base name for `network`; `devstackNetwork` keeps unstripped form; `runtime` becomes `'forked'` / `'normal'`.                                                                                                                 |
| `src/codegen/emitters/deepbook-config.test.ts`                | 298 | Golden minimal output (SUI/MUSDC + one pool); margin + Pyth fully-seeded variant; skip-emit when `services.deepbook` absent; skip-emit when `captured.deepTreasuryId` missing.                                                                                                                                  |
| `src/codegen/emitters/integration.test.ts`                    | 194 | Dynamic-import emitted `.ts` modules via vitest's Vite transform; asserts `devstackDappKitConfig` parses + exports correctly, asserts `accounts.ts` / `services.ts` / `extras.ts` / `captured.ts` / `packages.ts` all import and export their named values. Emits into `__integration_emitted__/<pid>-<rand>/`. |
| `src/codegen/emitters/stack-handle.test.ts` (already counted) |     |                                                                                                                                                                                                                                                                                                                 |
| `src/services/codegen.test.ts`                                | 222 | `Codegen` shape composability (Package + KnownPackage mixed list at type-check time), `defineEmitter` smoke tests, `.gitignore` write + user-customized preservation, atomic-emit happy path + failure rollback.                                                                                                |

Test LOC: **1389** (357 + 192 + 185 + 163 + 298 + 194 + 222 — and `__integration_emitted__/` is
empty in-repo, holds runtime output).

**Totals:** src **1650 LOC** (engine 1323 + service 327); test **1389 LOC**. Combined **3039 LOC** —
close to the 2712 quoted in the assignment (the assignment quoted before I included
`services/codegen.{ts,test.ts}`; with the service factory added the actual scope is ~3039).

## Configuration

`Codegen` accepts a single options struct (`CodegenOptions`, `services/codegen.ts:97-134`). All
knobs:

| Knob       | Type                                         | Default                                                                                                                      | Where read                                                                                                                                                           | Notes                                                                                                                                                                                                                                                                                                     |
| ---------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `output`   | `string`                                     | `'./src/generated'` (`DEFAULT_CODEGEN_OUTPUT`, `services/codegen.ts:95`)                                                     | `services/codegen.ts:175,179`                                                                                                                                        | Resolved relative to `process.cwd()` if not absolute (`:179`). Surfaces as the `outputDir` every emitter writes under. Also baked into the LayeredTag's `watch` array as a `!`-negation so the atomic-rename swap each cycle doesn't loop the supervisor's file watcher (`:316`).                         |
| `packages` | `ReadonlyArray<LayeredTag<any,any,any,any>>` | `[]` (`services/codegen.ts:168`)                                                                                             | Iterated at `:191-200`; each ref is yielded to read its `Package` / `LocalPackage` value, deduped by `name`, projected via `toCodegenPackage` into `CodegenPackage`. | Type is loose because `LayeredTag`'s shape param is invariant. Refs with `__codegenExclude === true` (i.e. `Package(..., { codegen: false })`) are filtered out at `:195`. Lifted into `upstreamKeys` at `:324` so the topo scheduler places `Codegen` strictly after every referenced package's publish. |
| `emitters` | `ReadonlyArray<Emitter>`                     | `[BindingsEmitter(), StackHandleEmitter(), DappKitConfigEmitter(), DeepbookConfigEmitter()]` (`services/codegen.ts:169-174`) | Iterated serially under `stageAndSwap` at `:251-271`. Name uniqueness enforced at `:210-225`.                                                                        | Override to add custom emitters or per-emitter options (e.g. `BindingsEmitter({ importExtension: '.js' })`).                                                                                                                                                                                              |
| `name`     | `string`                                     | `'codegen'` (`services/codegen.ts:167`)                                                                                      | Used to compose the tag key `codegen/${name}` at `:177` and the span/displayTitle at `:297, :301`.                                                                   | Override to coexist with another `Codegen(...)` in the same stack (would need distinct `output` to avoid file collisions).                                                                                                                                                                                |

Per-emitter knobs:

- `BindingsEmitterOptions.importExtension`: `'.ts' | '.js' | ''`, default `'.ts'`
  (`emitters/bindings.ts:32-35`, default applied at `:334`). Threaded into
  `generateFromPackageSummary`'s `importExtension`.
- `DappKitConfigEmitterOptions.enableBurnerWallet`: `boolean`, default `true`
  (`emitters/dapp-kit-config.ts:36-41`; resolved at `:171-173`). When `false`, the emitted module
  uses `const walletInitializers: Array<never> = []` and omits all `@mysten-incubation/dev-wallet`
  imports (`:118`).

Per-`Package(...)` codegen knob:

- `PackageOptions.codegen`: `boolean | { emitters?: ReadonlyArray<unknown> }`, default `true`
  (`services/package.ts:167-172`). `false` stamps `__codegenExclude: true` onto the LayeredTag
  (`services/package.ts:211-215`) which `Codegen` filters at `services/codegen.ts:195`. The
  `{ emitters: [...] }` per-package override is declared in the type but not implemented in
  `services/codegen.ts` (the iteration at `:195` only checks the boolean form). **OPEN QUESTION:**
  is the object form a planned feature or dead surface? No call site uses it; no test exercises it.

No CLI flags, env vars, or `defineDevstack` config keys affect codegen directly. The supervisor's
`DEFAULT_WATCH_EXCLUDES` (`engine/supervisor.ts:749-786`) hard-codes `'**/generated/**'` so the
conventional output basename is excluded for free from any file watcher — covers
`output: './src/generated'` without the negation pattern Codegen also emits.

## Capabilities CONSUMED

Exhaustive list.

### Other devstack services / components

- **PackageRegistry** (`engine/registries.ts:236-239`) — `StackHandleEmitter`
  (`emitters/stack-handle.ts:36, 172`), `DappKitConfigEmitter` (`emitters/dapp-kit-config.ts:179`),
  `DeepbookConfigEmitter` (`emitters/deepbook-config.ts:196,215`) read via `gatherManifest`.
  Provides per-package `id`, `upgradeCapId`, `mvrPlaceholder`, `captured`.
- **EndpointRegistry** (`engine/registries.ts:241-244`) — same emitters; `gatherManifest` reads
  endpoints to build `services.*` projections (SUI_RPC, WALLET_APP, WALRUS_AGGREGATOR, …).
- **AccountRegistry** (`engine/registries.ts:246-249`) — `StackHandleEmitter` reads via
  `gatherManifest`; emits `accounts.ts`.
- **CoinRegistry** (`engine/registries.ts:251-253`) — `StackHandleEmitter` (`coins.ts`),
  `DeepbookConfigEmitter` (`emitters/deepbook-config.ts:300-317`) iterate registered coins.
- **SuiStateRegistry / SealStateRegistry / WalrusStateRegistry / DeepbookStateRegistry /
  PythStateRegistry / PostgresStateRegistry / DeepbookIndexerStateRegistry /
  DeepbookServerStateRegistry / DeepbookMarginStateRegistry** — all read transitively through
  `gatherManifest` (`runtime/service.ts:237-261`). Codegen requires every registry's Live layer or
  `gatherManifest` fails with `Service not found` (see `engine/supervisor.ts:355-363`).
- **Identity** (`engine/identity.ts`) — `gatherManifest` reads `identity.network`, `identity.stack`,
  `identity.app` (`runtime/service.ts:253, 284, 343`); the dapp-kit emitter uses `identity.network`
  for fork stripping (`emitters/dapp-kit-config.ts:204`).
- **Extras / ExtrasResolved** (`engine/extras.ts`) — every manifest-reading emitter resolves user
  extras: `StackHandleEmitter` (`emitters/stack-handle.ts:35,171`), `DappKitConfigEmitter`
  (`emitters/dapp-kit-config.ts:30,178`), `DeepbookConfigEmitter`
  (`emitters/deepbook-config.ts:42,195`). Double-yield pattern (`yield* yield* ExtrasResolved`)
  extracts the memoized inner Effect's resolved value.
- **SuiBuildContainer** (`engine/sui-build-container.ts`) — `BindingsEmitter` calls
  `Effect.serviceOption(SuiBuildContainer)` (`emitters/bindings.ts:135`), prefers
  `buildContainerOpt.value.runSummary(sourcePath)` (`:155`) when `canExec(sourcePath)` (`:153`),
  falls back to a host `sui move summary` via `ChildProcessSpawner` otherwise (`:167-180`). The
  build container guarantees pinned-version parity with `@mysten/codegen`'s expected schema.
- **Package LayeredTag (per-ref)** — `Codegen` yields each ref in `packages`
  (`services/codegen.ts:196`) to acquire its `Package` or `LocalPackage` value. The ordering
  invariant is enforced via `upstreamKeys: packageRefs` at `:324`.

### Engine resources

- **state-store** — not read by codegen. (Confirmed via `state-store-keys.ts` grep — no codegen
  keys.)
- **paths** — codegen writes `outputDir` (default `./src/generated/`), `outputDir/.gitignore`, plus
  sibling staging/backup dirs (`<outputDir>.staging-<pid>-<rand>/`,
  `<outputDir>.backup-<pid>-<rand>/` during the swap). Each emitter writes a sub-tree under
  `outputDir` (`bindings/`, `accounts.ts`, …). Per-file atomic writes use sibling tmp files
  `.${basename}.tmp.<hex>` (`engine/atomic-write.ts:28-31`).
- **file-watcher** — not invoked directly. `Codegen`'s tag declares `watch: ['!${output}/**']`
  (`services/codegen.ts:316`) so the supervisor's watcher excludes the output dir from triggering
  hot-restarts. The negation is necessary on top of `DEFAULT_WATCH_EXCLUDES` only when the user
  overrides `output` to a non-`generated` basename.
- **port-allocator / leasing / file-lock / cache** — none.

### Runtime resources

- **container runtime** — only indirectly: `BindingsEmitter` calls into `SuiBuildContainer` which
  manages a long-lived `sui` worker container.
- **host process** — `BindingsEmitter` shells out to host `sui move summary` via
  `ChildProcessSpawner` when the build container isn't reachable for that path
  (`emitters/bindings.ts:167-181`).
- **fs** — `node:fs/promises` used for: `readdir` + `stat` (mtime walk in `maxSourceMtime`,
  `emitters/bindings.ts:296-313`), `access` (post-codegen probe at `:209-214`; `targetExists` check
  in stage-and-swap), `mkdir`, `writeFile`, `rename`, `rm`, `unlink`, `chmod` (in `writeIfChanged`
  post-write at `helpers.ts:57`), `readFile` (existing-content read in `writeFileAtomicIfChanged`,
  existing `.gitignore` snapshot at `services/codegen.ts:63-67`), `cp` (cross-fs fallback in
  stage-and-swap when `atomic:false`).
- **`node:crypto`** — `crypto.randomBytes` for sibling-tmp suffix in `atomic-write.ts:29` and
  stage-and-swap suffix in `stage-and-swap.ts:84`; `createHash('sha256')` in `content-hash.ts`
  (consumed by the bindings fingerprint).

### Surfaces

- **TUI** — `Codegen` registers as
  `{ kind: 'app', plugin: 'codegen', displayTitle: 'codegen.${name}' }`
  (`services/codegen.ts:299-301`). `setPhase` calls inside the Effect body update the entry's status
  text: `'resolving packages'` (`:188`) and `'emit: ${emitter.name}'` per emitter (`:252`).
  `display(s)` returns title + `displayPath(s.outputDir)` primary + `'${n} emitter(s)'` extra
  (`:302-306`).
- **log sink** — `Effect.logWarning` (cache-disabled in bindings `:116`, duplicate package name in
  bindings `:57`, missing-mtime per target in bindings `:277`, no-sui in dapp-kit `:186`,
  no-deepbook-state in deepbook `:227`, captured-id-missing in deepbook `:227`, malformed pool in
  deepbook `:333`, malformed margin pool in deepbook `:355`), `Effect.logInfo`
  (`sui move summary -> ${name}` in bindings `:150`, no-deepbook info in deepbook `:203`). Span
  annotations via `Effect.annotateCurrentSpan` (`services/codegen.ts:227-231`,
  `emitters/bindings.ts:86-91, 103-107, 123-126, 149`).
- **event bus / command queue** — none.

### External

- **HTTP / RPC** — none. `gatherManifest` is a pure registry read, no RPC.
- **System binaries** — `sui` (host fallback in `BindingsEmitter`, `emitters/bindings.ts:167-181`).
- **Ports / sockets** — none.

### Effect / Layer / Context machinery

- `Effect.gen`, `Effect.tryPromise`, `Effect.promise`, `Effect.fail`, `Effect.succeed`,
  `Effect.void`, `Effect.forEach`, `Effect.acquireUseRelease` (inside `stageAndSwap`),
  `Effect.serviceOption`, `Effect.annotateCurrentSpan`, `Effect.withSpan`, `Effect.mapError`,
  `Effect.catchTag`, `Effect.logWarning`, `Effect.logInfo`, `Effect.logError` (none in scope, but
  the helpers stay open to it).
- `Schema.TaggedErrorClass`, `Schema.Literals`, `Schema.String`, `Schema.Defect`, `Schema.optional`
  (`codegen/errors.ts`).
- `Layer.build`, `Layer.mergeAll`, `Layer.succeed` (in tests).
- `Context.Service` (consumed transitively via the registry tag classes).
- `tag(...)`, `setPhase(...)`, `LayeredTag` (`advanced/tag.ts`).

### Imports from other workspace packages

- `@mysten/codegen` — `generateFromPackageSummary` (`emitters/bindings.ts:23,189-198`). Reads
  `sui move summary` output, writes per-module `.ts` bindings under `outputDir/<packageName>/`.
- `@mysten/dapp-kit-react` / `@mysten/dapp-kit-core` — **not** imported by the emitter; mentioned in
  the emitted file's user-facing comment block (`emitters/dapp-kit-config.ts:4-12`). The emitted
  module imports `SuiGrpcClient` from `@mysten/sui/grpc` only.
- `@mysten-incubation/dev-wallet` — referenced in emitted code (`emitters/dapp-kit-config.ts:92-93`)
  when `enableBurnerWallet: true`: `devWalletInitializer`, `DevWalletInitializerConfig`,
  `createDevstackAdapterFromManifest`. NOT a runtime import in the emitter itself.
- `@mysten/deepbook-v3` — referenced only in the emitted file's doc comment
  (`emitters/deepbook-config.ts:9-11, 160-169`). The emitted module is bare data (no imports).
- `effect`, `effect/unstable/process` — runtime.

### npm dependencies

- `node:fs/promises`, `node:path`, `node:crypto`, `node:os` (tests), `node:url` (integration test).

## Capabilities PRODUCED

What `Codegen` and its emitters expose to others.

### Endpoints / URLs / state-store entries

None. Codegen is read-only with respect to engine state — it consumes registries and writes files;
it does not register endpoints or publish state-store entries.

### Files written

All paths are relative to `outputDir` (default `./src/generated/`, resolved against
`process.cwd()`).

| Path                         | Emitter                           | Mode                          | Content type                                                                                                                                                               | Sensitivity                                                                                                                                    |
| ---------------------------- | --------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `bindings/<packageName>/...` | BindingsEmitter                   | 0o644 (via `@mysten/codegen`) | TypeScript modules generated by `@mysten/codegen` from `sui move summary` output                                                                                           | Public — checked in by consumers if they want pre-built bindings, otherwise regenerated.                                                       |
| `accounts.ts`                | StackHandleEmitter                | 0o644                         | `export const accounts = { <name>: '<address>', … } as const; export type AccountName = …`                                                                                 | Public                                                                                                                                         |
| `services.ts`                | StackHandleEmitter                | 0o644                         | `export const services = { sui: {...}, walrus: {...}, … } as const; export type Services = …`                                                                              | Public — endpoint URLs are local-only addresses (`http://*.localhost:*`)                                                                       |
| `extras.ts`                  | StackHandleEmitter                | **0o600**                     | `export const extras = {...} as const; export type Extras = …`                                                                                                             | **Sensitive** — user-supplied `app.extras` can carry secrets                                                                                   |
| `captured.ts`                | StackHandleEmitter                | 0o644                         | `export const captured = { <pkg>: { <key>: '<id>', … }, … } as const`                                                                                                      | Public — chain object ids                                                                                                                      |
| `packages.ts`                | StackHandleEmitter                | 0o644                         | `export const packages = { <pkg>: { id, upgradeCapId?, mvr? }, … } as const; export type PackageName = …`                                                                  | Public                                                                                                                                         |
| `coins.ts`                   | StackHandleEmitter                | 0o644                         | `export const coins = { <SYM>: { type, decimals, sdkCoin, treasuryCapId?, … }, … } as const; export type CoinName = …`                                                     | Public                                                                                                                                         |
| `dapp-kit-config.ts`         | DappKitConfigEmitter              | **0o600**                     | `export const devstackDappKitConfig = {...}; export const devstackNetwork; export const runtime; export const devstackWalletInitializer(...)` (when burner wallet enabled) | **Sensitive** — `app.wallet.pairUrl` carries a wallet bearer token                                                                             |
| `deepbook-config.ts`         | DeepbookConfigEmitter             | 0o644                         | `export const deepbookConfig = {...} as const; export type DeepbookConfig = …`                                                                                             | Public — chain ids                                                                                                                             |
| `.gitignore`                 | `services/codegen.ts` (post-swap) | 0o644 (implicit)              | `# generated by …\ndapp-kit-config.ts\nextras.ts\n`                                                                                                                        | Default body covers the two sensitive files. Preserved verbatim if the user has hand-edited it (`services/codegen.ts:61-68, 78-85, 186, 294`). |

Each file carries a generated-header banner (`stack-handle.ts:41-44`, `dapp-kit-config.ts:51`,
`deepbook-config.ts:47-50`); the two sensitive files carry a "DO NOT COMMIT" banner above the
standard header.

### TypeScript exports consumed elsewhere

From `src/index.ts` (public barrel, `:39-77`):

- `Codegen` (the factory function), `CodegenOptions` (the options interface),
  `DEFAULT_CODEGEN_OUTPUT` (the string constant).
- `CodegenError` (re-exported from `codegen/errors.ts` at `index.ts:165`).

From `src/advanced/index.ts` (plugin-author barrel, `:121-131`):

- `defineEmitter`, `Emitter`, `CodegenContext`, `CodegenPackage` from `codegen/define-emitter.ts`.
- `BindingsEmitter`, `DappKitConfigEmitter`, `DeepbookConfigEmitter`, `StackHandleEmitter` (so users
  can re-order or pass per-emitter options).
- `CodegenError`.

### Events emitted / CLI commands / routes registered / container images / volumes

None — codegen has no surface beyond the LayeredTag and the on-disk files.

## Lifecycle

### Startup

`Codegen` is a LayeredTag — its lifecycle runs at Layer-build time inside `Codegen`'s scope, which
the supervisor schedules according to its `upstreamKeys` (every `Package(...)` ref it explicitly
references plus, post-composition, every other sibling that doesn't already depend on `Codegen` —
see `compose/devstack.ts:228-258`).

Ordered sequence inside the body (`services/codegen.ts:178-296`):

1. Resolve `outputDir` (`:179`). Compute absolute path from `process.cwd()` if relative.
2. Snapshot any pre-existing `.gitignore` at `outputDir` (`:186` → `readExistingGitignore` at
   `:61-68`). Best-effort read; missing file → `undefined`.
3. `setPhase('resolving packages')` (`:188`). Phase string surfaces in TUI.
4. For each `packageRefs` entry: if `__codegenExclude`, skip; otherwise `yield* ref` to acquire the
   package value; dedupe by name; project to `CodegenPackage` (`:189-200`).
5. Emitter-name collision check: fail with `CodegenError({ phase: 'generate' })` if two emitters
   share a name (`:210-225`).
6. Annotate span with output dir, package list, emitter list (`:227-231`).
7. `stageAndSwap({ target: outputDir, stage })` (`:246-273`). Inside the `stage(stagingDir)`
   callback:
   1. Build `CodegenContext = { packages: resolved, outputDir: stagingDir }` (`:250`).
   2. For each emitter, **serially** (concurrency 1, `:251-271`):
      - `setPhase('emit: ${emitter.name}')` (`:252`).
      - `yield* emitter.emit(ctx)` with `mapError` wrapping any non-`CodegenError` into a
        `CodegenError({ phase: 'generate' })` while preserving an emitter-thrown `CodegenError`'s
        own phase (`:253-270`).
8. `catchTag('StageAndSwapError')` (`:274-283`) re-wraps stage-and-swap failures into
   `CodegenError({ phase: 'write' })`.
9. `writeGitignore(outputDir, existingGitignore)` (`:294`). Written **after** the atomic swap so the
   `.gitignore` lives at the final path (not inside the staging tree).
10. Return `{ outputDir, emitters: [name, …] }` (`:296`). This is the resolved tag value.

What blocks what:

- Within Codegen's body: every emitter is sequential. (Code comment at `:242-245` calls this out:
  "Serial emit (concurrency: 1). Per-emitter locking is on the long-tail wishlist; until then,
  serial avoids the `~/.move` and bind-mount races between concurrent `sui move {build,summary}`
  invocations.")
- Within `BindingsEmitter.runEmit`: targets are iterated `{ concurrency: 'unbounded' }`
  (`emitters/bindings.ts:227`). Concurrent `sui move summary` calls per target are safe because each
  call is scoped to its own `cwd`/source path. **NB:** this is inside the serial outer loop —
  concurrency is only across multiple Local packages within one emit cycle.

What runs in parallel: only the per-target `sui move summary` calls inside `BindingsEmitter`.
Otherwise everything inside `Codegen` is serial.

### Ready criteria

`Codegen`'s tag is "ready" when its scoped Layer-build Effect completes successfully and returns its
`{ outputDir, emitters }` value. There is no separate ready probe — Layer-build completion IS
readiness.

Downstream consumers (e.g. a `Dev(...)` that lists `Codegen()` in its `needs`) acquire `Codegen` as
a Layer prereq; the supervisor's scheduler ensures their build doesn't start until Codegen returned
(`compose/devstack.ts:239-243` documents the cycle guard: Dev depends on Codegen, NOT the other way
around).

### Restart behavior

Codegen is **idempotent on rerun**:

- `BindingsEmitter` has a closure-scoped fingerprint cache (`emitters/bindings.ts:335`). A re-emit
  with identical source-tree mtimes hits the cache, skips both `sui move summary` AND the dir swap,
  and leaves `bindings/` mtime untouched (`bindings.test.ts:217-243`).
- The other three emitters use `writeIfChanged` (`helpers.ts:43-60`), which reads existing content
  and short-circuits if identical, so re-emits with no manifest change don't touch file mtimes
  (`stack-handle.test.ts:164-183`).
- The pre-write `.gitignore` snapshot + post-write replay
  (`services/codegen.ts:61-68, 78-85, 186, 294`) preserves user customizations across the atomic
  swap.

What needs cleanup: nothing in process. Across processes: if a previous run crashed mid-swap, the
sibling `<outputDir>.staging-<…>` or `<outputDir>.backup-<…>` could remain. `stageAndSwap`
pre-clears the suffix-collision path defensively (`stage-and-swap.ts:112`), but a leaked sibling
with a different suffix is debris and may need manual removal. The atomic test
(`services/codegen.test.ts:155-167`) sweeps such siblings between runs to keep CI clean.

### Teardown

No explicit teardown — `Codegen`'s scope closes when the surrounding stack scope closes. The
fingerprint cache (`emitters/bindings.ts:335`) is a `Map` held by the BindingsEmitter closure; it
dies with the emitter instance. No release/finalizer registered.

Grace windows: none. Codegen is pure compute + filesystem; nothing to drain.

What survives: every file written under `outputDir`. The user's app code keeps consuming the last
emitted snapshot until the next supervisor cycle re-emits.

## Hard requirements / invariants

Load-bearing constraints, with file:line + test coverage.

1. **`outputDir` MUST be an importable source path, not the `.devstack/` dot-dir**
   (`services/codegen.ts:91-95, 105-108`). The comment is explicit: `.devstack/` is reserved for
   non-importable runtime state (account keys, wallet tokens). Codegen output must be picked up by
   `tsconfig.include` / Vite's resolve graph.

2. **Each emitter writes under `<outputDir>/<emitter.name>/` (or files with names tied to the
   emitter)**; two emitters with the same name would clobber each other
   (`services/codegen.ts:204-225`). The collision check raises a `CodegenError` at acquire time so
   the conflict surfaces with the user's `Codegen(...)` stack frame, NOT as a downstream
   missing-file error. **No direct test** — but the check is unconditional.

3. **The swap MUST be atomic — a watching Vite dev server MUST NEVER observe a half-emitted tree.**
   Enforced by `stageAndSwap` (`engine/stage-and-swap.ts`, full pipeline `:74-243`). Tests:
   `services/codegen.test.ts:174-189` (no staging sibling after happy path), `:191-221`
   (pre-existing content preserved on failure), `bindings.test.ts:164-186` (pre-existing tree
   replaced atomically).

4. **On any emitter failure, the pre-existing `outputDir` MUST stay intact.** Two layers: (a)
   `Codegen` runs every emitter inside `stage(stagingDir)`, so partial output stays in the staging
   dir and never lands at `outputDir`; (b) `stageAndSwap`'s `acquireUseRelease` drops the staging
   dir on failure (`stage-and-swap.ts:124-136`). Test: `services/codegen.test.ts:191-221`.

5. **Sensitive files MUST chmod to 0o600**: `extras.ts` (`emitters/stack-handle.ts:187`),
   `dapp-kit-config.ts` (`emitters/dapp-kit-config.ts:223`). Test: `stack-handle.test.ts:133-136`
   asserts both 0o600 for sensitive and 0o644 for siblings; `dapp-kit-config.test.ts:127-142`
   asserts re-emit RE-tightens mode if a prior run/manual chmod left it at 0o644 (the explicit
   `fs.chmod` after `writeFileAtomicIfChanged` at `helpers.ts:57` is load-bearing here —
   `fs.writeFile`'s `mode` option only applies when creating).

6. **`.gitignore` MUST cover both sensitive files AND MUST preserve user customizations.** Default
   body at `services/codegen.ts:51-55` lists `dapp-kit-config.ts` + `extras.ts`. Snapshot-and-replay
   at `:61-68, 186, 294`. Tests: `services/codegen.test.ts:90-100` (default content), `:102-115`
   (user content preserved verbatim).

7. **Re-emit with identical inputs MUST NOT touch file mtimes** — otherwise Vite HMR fires
   unnecessarily, causing visible UI flicker every supervisor cycle. Three independent layers:
   - `writeIfChanged` short-circuits the per-file write (`engine/atomic-write.ts:46-60`, wrapped at
     `helpers.ts:43-60`).
   - `BindingsEmitter`'s fingerprint short-circuit skips the entire `sui move summary` + atomic dir
     swap (`emitters/bindings.ts:101-108`).
   - Tests: `stack-handle.test.ts:164-183` (per-file mtime stable), `bindings.test.ts:217-243`
     (bindings dir mtime stable), `bindings.test.ts:246-268` (source mtime change DOES invalidate).

8. **`BindingsEmitter`'s fingerprint cache MUST be per-instance, not module-global.** Each
   `BindingsEmitter()` call gets its own `Map` (`emitters/bindings.ts:325-335`). Pre-refactor a
   module-global Map leaked state across instances AND across tests (commit history). Test:
   `bindings.test.ts:270-286` pins the bug-class.

9. **Codegen MUST run AFTER every `Package(...)` it references** — otherwise `yield* ref` fails with
   `Service not found: <pkg-name>`. Enforced by lifting `packageRefs` into `upstreamKeys`
   (`services/codegen.ts:317-324`). Plus the post-composition sibling-lift in
   `compose/devstack.ts:228-258` widens `upstreamKeys` to every sibling that doesn't already depend
   on Codegen, covering the extras-references-anything case.

10. **Codegen output dir MUST be excluded from the file watcher** — otherwise the atomic-rename swap
    loops the watcher → re-emit → swap → loop. Two layers:
    - `DEFAULT_WATCH_EXCLUDES` (`engine/supervisor.ts:773`) hard-excludes `**/generated/**` (covers
      the default `output`).
    - `Codegen` declares `watch: ['!${absolute(output)}/**']` (`services/codegen.ts:316`) covering
      user-overridden output basenames.

11. **`BindingsEmitter` MUST prefer `SuiBuildContainer`'s pinned `sui` over host `sui`** —
    pinned-version parity with `@mysten/codegen`'s expected summary schema
    (`emitters/bindings.ts:128-181`). Host fallback only when `canExec(sourcePath)` returns false
    (path not in the bind-mount) or the build container service isn't provided. The fallback path's
    CodegenError message explicitly tags `(host fallback)` (`:177`) so the divergence is visible in
    error reports.

12. **`generateFromPackageSummary` MUST produce output — silent no-op = error.** Post-call probe at
    `emitters/bindings.ts:208-225` `fs.access(<staging>/<package-name>)`; on miss, fail with a
    CodegenError that names the common cause (missing `[addresses]` block in `Move.toml`). Without
    this, the build lands a half-empty tree and downstream import errors point at the consumer site
    rather than the codegen layer.

13. **Duplicate `Package` names MUST be deduped at emit time (first wins, second warned).** Without
    this the second package silently dropped, the fingerprint walk later mismatched the on-disk
    tree, and every supervisor cycle re-emitted bindings (HMR storm) — see the comment block at
    `emitters/bindings.ts:49-65`. Test: `bindings.test.ts:321-356`.

14. **Skip-emit paths MUST be explicit, MUST log, MUST NOT write a file that would fail at
    runtime.** Three known skip-emit branches: DappKitConfigEmitter when no SUI_RPC endpoint
    (`emitters/dapp-kit-config.ts:182-191`), DeepbookConfigEmitter when no `services.deepbook`
    (`emitters/deepbook-config.ts:198-206`), DeepbookConfigEmitter when `services.deepbook` exists
    but `captured.deepTreasuryId` missing (`emitters/deepbook-config.ts:222-232`). All three log
    (warning or info) so the supervisor trail shows why no file appeared. Tests:
    `dapp-kit-config.test.ts:177-184`, `deepbook-config.test.ts:256-268`, `:274-297`.

15. **Fork-network translation MUST emit the stripped network to dapp-kit AND retain the unstripped
    form alongside.** `getChainIdentifier` validation in dapp-kit rejects `'mainnet-fork'` because
    the wrapped chain reports the real mainnet chainId; the emitted file uses `network = 'mainnet'`
    for dapp-kit, `devstackNetwork = 'mainnet-fork'` for fork-aware consumers, `runtime = 'forked'`
    as the structured signal (`emitters/dapp-kit-config.ts:204-209`). Tests: full matrix in
    `dapp-kit-config.fork.test.ts:90-162`.

16. **Codegen output is byte-stable for the same registry snapshot.** The deterministic-ordering
    invariant is enforced by sort-then-render in every emitter
    (`stack-handle.ts:51-53, 96, 115, 136`; `dapp-kit-config.ts:193-194` sorts MVR overrides;
    `deepbook-config.ts` iterates `Object.entries(...)` which is insertion-ordered — but
    per-coin-type / per-pool ordering comes from registry insertion which is itself deterministic).
    Empirically: `bindings.ts:72` sorts targets by name. The byte-stability is what makes the
    re-emit-no-op invariant achievable.

17. **`Codegen` is NOT in `fillDefaults` — users MUST opt in.** Confirmed by grep over
    `compose/defaults.ts`: no `Codegen` mention. Users who want a typed app kit must add `Codegen()`
    (or one of the per-emitter combinations) to their stack array explicitly.

## Failure modes

For each failure mode: trigger, current behavior, recovery path.

| Trigger                                                                             | Current behavior                                                                                                                                                                                                                                                                                                                                               | Recovery                                                                                                                                             |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Emitter throws non-`CodegenError` (any defect)                                      | `Codegen` wraps it via `mapError` at `services/codegen.ts:253-269` into a `CodegenError({ emitter, phase: 'generate', message: 'emitter ${name} failed', cause })`. The stage tree is dropped.                                                                                                                                                                 | User fixes the emitter (custom-emitter case) or files a bug (built-in emitter case).                                                                 |
| Emitter throws `CodegenError` directly                                              | Original `phase` preserved (the `if (cause instanceof CodegenError) return cause;` branch at `:255-262`); error propagates up through `stageAndSwap` (its `Effect.acquireUseRelease` drops the staging dir on non-success exit, `stage-and-swap.ts:124-136`). Pre-existing `outputDir` untouched.                                                              | User reads the phase + emitter name + message to localize the issue.                                                                                 |
| `stageAndSwap`'s rename fails (e.g. cross-FS target, permissions on parent)         | `StageAndSwapError({ op: 'rename-aside'                                                                                                                                                                                                                                                                                                                        | 'rename-promote'                                                                                                                                     | 'mkdir' | 'cleanup' })`raised;`Codegen.catchTag`re-wraps to`CodegenError({ phase: 'write' })` (`services/codegen.ts:274-283`). On `rename-promote`failure with`atomic:true`, rollback rename of backup→target attempted (`stage-and-swap.ts:185-200`); on rollback failure the original error surfaces and `outputDir` is missing (best-effort). | Fix the filesystem condition; rerun. Manual cleanup of `.staging-<…>` / `.backup-<…>` siblings if rollback partially failed. |
| Pre-existing `outputDir` contains a file with same name as a staging entry          | `rename(2)` overwrite on directories at POSIX: targets directory (which is what we want). Atomic-promote replaces the entire tree.                                                                                                                                                                                                                             | Not actually a failure mode in current impl.                                                                                                         |
| `Package(...)` ref yielded before its publish completes                             | `yield* ref` fails with `Service not found: <pkg-name>` from Effect's Context lookup.                                                                                                                                                                                                                                                                          | Fixed by `upstreamKeys: packageRefs` (`services/codegen.ts:324`) — should not occur unless a custom Codegen-like factory is built without this lift. |
| Duplicate emitter names in `emitters` array                                         | `CodegenError({ phase: 'generate', message: "duplicate emitter name '${name}'", emitter: <name> })` at `:212-222`.                                                                                                                                                                                                                                             | Rename one emitter (custom emitters take a `name:` field).                                                                                           |
| `BindingsEmitter`: source-tree unreadable (missing dir, perms)                      | `maxSourceMtime` rejects → `FingerprintResult({ _tag: 'err' })` → fingerprint returns `undefined` → cache disabled, warning logged at `:116-121`. Subsequent `sui move summary` then fails because `cwd: t.sourcePath` is unreadable; that wraps into `CodegenError({ phase: 'generate', message: '${name}: sui move summary (host fallback) failed: ...' })`. | Fix perms or path; rerun.                                                                                                                            |
| `BindingsEmitter`: `generateFromPackageSummary` silently writes nothing             | Post-call probe (`:209-225`) fails the cycle with a CodegenError naming the common cause (Move.toml missing `[addresses]` block).                                                                                                                                                                                                                              | User adds the `[addresses]` block matching the package's summary subdir.                                                                             |
| `BindingsEmitter`: duplicate package names in `ctx.packages`                        | First wins; warning at `:57-62` names both source paths and instructs the user to rename. Bindings still emit for the first only. Test `bindings.test.ts:321-356`.                                                                                                                                                                                             | Rename one of the colliding packages.                                                                                                                |
| `DappKitConfigEmitter`: no SUI_RPC endpoint                                         | Log warning ("skipping emit … will retry on next codegen cycle"); skip-emit (`:184-191`). No file written.                                                                                                                                                                                                                                                     | Next supervisor cycle (after sui-localnet acquires) re-emits successfully.                                                                           |
| `DeepbookConfigEmitter`: no `services.deepbook`                                     | Log info; skip-emit (`:198-206`).                                                                                                                                                                                                                                                                                                                              | Non-deepbook stacks never get a file — expected steady state.                                                                                        |
| `DeepbookConfigEmitter`: deepbook in manifest but `captured.deepTreasuryId` missing | Log warning; skip-emit (`:222-232`).                                                                                                                                                                                                                                                                                                                           | Next cycle after local-deploy captures the cap re-emits.                                                                                             |
| `DeepbookConfigEmitter`: pool whose base/quote type isn't in the coin map           | Log warning naming the pool; skip just that pool, continue (`:329-344`).                                                                                                                                                                                                                                                                                       | Fix the coin registry projection so the type is registered.                                                                                          |
| `DeepbookConfigEmitter`: margin pool whose asset type isn't in the coin map         | Log warning; skip just that margin pool, continue (`:351-366`).                                                                                                                                                                                                                                                                                                | Same as above.                                                                                                                                       |
| `writeIfChanged`: post-write `chmod` fails                                          | Wrapped as `CodegenError({ phase: 'write' })` via `fsOp`.                                                                                                                                                                                                                                                                                                      | Fix perms.                                                                                                                                           |
| `.gitignore` write fails                                                            | `CodegenError({ emitter: 'codegen', phase: 'write' })` at `services/codegen.ts:83-85`.                                                                                                                                                                                                                                                                         | The atomic swap has already promoted output, so the user's app sees fresh codegen but no `.gitignore`. Rerun to retry.                               |
| User-customized `.gitignore` exists but is unreadable mid-cycle (perms, deleted)    | `readExistingGitignore` swallows errors and returns `undefined` (`:61-68`), causing the default body to be written. **Silently loses user customizations** if a transient read error coincides with the snapshot pass. **OPEN QUESTION:** should this be a hard fail?                                                                                          |
| Supervisor restart mid-cycle                                                        | `acquireUseRelease` in `stageAndSwap` removes the staging dir on interrupt (`stage-and-swap.ts:124-136`). Pre-existing `outputDir` untouched.                                                                                                                                                                                                                  | None needed.                                                                                                                                         |

## Persistence model

- **Survives restart (across supervisor cycles, same process / new process):**
  - Every file under `outputDir`. Specifically: `bindings/**`, `accounts.ts`, `services.ts`,
    `extras.ts`, `captured.ts`, `packages.ts`, `coins.ts`, `dapp-kit-config.ts`,
    `deepbook-config.ts`, `.gitignore`.
  - These are the "kit" the user's app imports; they're the durable output of codegen.
- **Survives snapshot (`devstack snapshot save`):** the codegen-emitted files live under
  `src/generated/` (default), which is part of the user's repo, NOT under `.devstack/`. Snapshot
  only captures `.devstack/` runtime state. So technically the emitted files survive snapshot in the
  same way any user repo file survives a `devstack snapshot save` — they're not in the snapshot's
  scope.
- **Wiped on `devstack wipe`:** **OPEN QUESTION** — the assignment context says state-store-keys has
  no codegen entry; `wipe` only touches `.devstack/`. The emitted `src/generated/` tree is NOT wiped
  by `devstack wipe`. Worth confirming whether the supervisor or CLI has a separate clean-codegen
  path.
- **Process-local only:**
  - `BindingsEmitter`'s fingerprint cache (the closure-scoped `Map<string,string>` at
    `emitters/bindings.ts:335`). Dies with the emitter instance; the comment at `:325-330` makes it
    explicit ("doesn't survive across processes — that's intentional: cold start always re-emits,
    and the source-mtime probe is the authoritative invalidation signal").

## Modes & variants

Codegen has effectively one mode at the Codegen-factory level (run all configured emitters once per
Layer-build acquisition). Per-emitter variants exist, plus a fingerprint-cache fast-path inside the
bindings emitter. Tabling those for clarity:

| Dimension             | Codegen factory (one mode)                                                                                                                                            | BindingsEmitter — cold                                                                                                                          | BindingsEmitter — warm (fingerprint hit)                                             | StackHandleEmitter                                                                                                  | DappKitConfigEmitter                                                                                         | DeepbookConfigEmitter                                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Container**         | none                                                                                                                                                                  | `SuiBuildContainer` (when reachable) for `sui move summary`; host `sui` otherwise                                                               | none (skipped)                                                                       | none                                                                                                                | none                                                                                                         | none                                                                                                                                                              |
| **Startup sequence**  | resolve → setPhase('resolving packages') → emitter-collision check → stageAndSwap{ serial emit each emitter } → catchTag → writeGitignore                             | collectTargets → computeFingerprint → cache miss → stageAndSwap{ per-target sui move summary + generateFromPackageSummary } → cache fingerprint | collectTargets → computeFingerprint → cache hit → annotate span 'cache:hit' → return | resolve ExtrasResolved → gatherManifest → 6× writeIfChanged                                                         | resolve ExtrasResolved → gatherManifest → check sui present → if absent log+return → render → writeIfChanged | resolve ExtrasResolved → gatherManifest → check deepbook + deepTreasuryId → if absent log+return → project coins/pools/marginPools/pyth → render → writeIfChanged |
| **Ready criteria**    | Layer-build Effect resolves with `{ outputDir, emitters: [...] }`                                                                                                     | Bindings dir promoted via `rename(2)` and fingerprint cached                                                                                    | Annotation only; no fs work                                                          | Each writeIfChanged returns (whether or not actual write occurred)                                                  | dapp-kit-config.ts written, or skip-emit log emitted                                                         | deepbook-config.ts written, or skip-emit log emitted                                                                                                              |
| **Persistence**       | Files under `outputDir` survive process exit                                                                                                                          | `bindings/<pkg>/...` files                                                                                                                      | None (no writes)                                                                     | `accounts.ts`/`services.ts`/`extras.ts`/`captured.ts`/`packages.ts`/`coins.ts`                                      | `dapp-kit-config.ts` (0o600)                                                                                 | `deepbook-config.ts`                                                                                                                                              |
| **Teardown**          | None (no finalizers)                                                                                                                                                  | None                                                                                                                                            | None                                                                                 | None                                                                                                                | None                                                                                                         | None                                                                                                                                                              |
| **Failure modes**     | StageAndSwapError → CodegenError({phase:'write'}); emitter error → CodegenError({phase}) preserved or wrapped to 'generate'; emitter-name collision → fail at acquire | sui move summary failure, generateFromPackageSummary silent no-op, source-tree unreadable                                                       | None (read-only fingerprint compute)                                                 | fsOp wraps any fs failure                                                                                           | `services.sui` absent → skip+warn; otherwise fsOp wraps                                                      | `services.deepbook` absent → skip+info; `captured.deepTreasuryId` absent → skip+warn; otherwise fsOp wraps                                                        |
| **Dependencies**      | All registries, Identity, ExtrasResolved, SuiBuildContainer (via bindings), ChildProcessSpawner (via bindings), each Package ref                                      | ChildProcessSpawner, SuiBuildContainer, `@mysten/codegen`                                                                                       | None beyond source-tree fs.stat                                                      | PackageRegistry, EndpointRegistry, AccountRegistry, CoinRegistry, ExtrasResolved, Identity (all via gatherManifest) | Same as StackHandle + SuiStateRegistry + EndpointRegistry projection                                         | Same as StackHandle + every Deepbook\* state registry + PythStateRegistry                                                                                         |
| **Hard requirements** | Atomic outputDir swap, sensitive 0o600, gitignore preserve, emitter serial                                                                                            | Fingerprint per-instance, prefer build container, post-codegen probe, dedupe duplicates                                                         | Source-mtime authoritative invalidation                                              | Byte-stable output, 0o600 for extras.ts                                                                             | 0o600 for dapp-kit-config.ts, fork stripping                                                                 | `as const` invariant, packageIds packages ids verbatim                                                                                                            |

(No CLI/network/streaming/batch mode distinction. Codegen is a single-pass emit per Layer
acquisition.)

## Test coverage

Test files in scope (every `describe`/`it`):

### `src/services/codegen.test.ts` (222 LOC)

- `describe('Codegen shape')`
  - `it('accepts a Package | KnownPackage mixed list at compose time')` (`:21`) — Pure
    type-discipline check: passing a `LocalPackage` LayeredTag alongside a `KnownPackage(...)`
    LayeredTag through `Codegen({ packages: [...] })` compiles; the resulting tag key is
    `'codegen/codegen'`.
- `describe('defineEmitter')`
  - `it('returns an emitter with the supplied name + emit')` (`:46`) — Sanity:
    `defineEmitter({ name: 'noop', emit: () => Effect.void }).name === 'noop'`.
  - `it("packages without sourcePath survive but don't crash the emitter")` (`:54`) —
    Type-discipline: an emitter whose body filters `ctx.packages` by `sourcePath !== undefined`
    compiles even with no entries carrying one.
- `describe('Codegen .gitignore')`
  - `it.effect('drops a .gitignore covering dapp-kit-config.ts and extras.ts')` (`:90`) — Asserts
    the default body contains both sensitive filenames + the devstack attribution comment.
  - `it.effect('leaves an existing user-customized .gitignore alone')` (`:102`) — Pre-seeds a
    hand-edited `.gitignore`; asserts byte-equal preservation after codegen runs (no append, no
    overwrite).
- `describe('Codegen atomic emit')`
  - `it.effect('happy path: staging dir is removed after a successful run')` (`:174`) — After a
    one-emitter run that writes `hello.txt`, no `.staging-*` / `.backup-*` sibling remains under the
    parent dir.
  - `it.effect('failure path: pre-existing outputDir content is preserved when an emitter fails')`
    (`:191`) — Pre-seeds `previous-run.txt`; runs a 2-emitter stack [writingEmitter,
    failingEmitter]; asserts the failure flips the result, the pre-existing file is intact, the
    would-be promoted `a.txt` is absent, and no staging/backup sibling leaked.

### `src/codegen/emitters/bindings.test.ts` (357 LOC)

Mocks `@mysten/codegen` (`vi.mock` at `:35-53`) so `generateFromPackageSummary` writes a
deterministic stub at `<outputDir>/<packageName>/index.ts`. Stubs `ChildProcessSpawner` via
`makeStubSpawner` that records calls and returns a no-op handle (`:62-87`).

- `describe('BindingsEmitter — happy path')`
  - `it.effect('emits a bindings dir containing the codegen output for the local package')` (`:126`)
    — One local package → bindings dir landed at `<outputDir>/bindings/demo/index.ts` with mocked
    content; `sui move summary` ran exactly once.
  - `it.effect('staging dir is removed after a successful run')` (`:145`) — No `bindings.staging-*`
    / `bindings.discarding-*` sibling remains after a clean run.
  - `it.effect('atomic swap replaces a pre-existing bindings/ tree with the new contents')` (`:164`)
    — Pre-seeds `bindings/stale.ts`; after re-emit, new mocked output present, stale file gone
    (whole-dir replacement, not merge).
- `describe('BindingsEmitter — fingerprint short-circuit')`
  - `it.live('second emit with identical inputs skips spawn AND leaves bindings/ mtime untouched')`
    (`:217`) — Single emitter instance, two emits. After first, capture `bindings/` mtime; sleep
    50ms (real clock via `it.live`); re-emit; assert spawn count unchanged at 1 AND mtime unchanged.
  - `it.effect('editing a .move file invalidates the fingerprint (re-spawns + re-swaps)')` (`:246`)
    — Touch `sources/demo.move` mtime forward via `fs.utimesSync` → second emit re-spawns (spawn
    count goes to 2).
  - `it.live('two BindingsEmitter() instances do not share fingerprint state')` (`:270`) —
    Per-instance cache: fresh emitter on second emit re-spawns; pins the bug-class fix.
- `describe('BindingsEmitter — package filtering')`
  - `it.effect('skips packages without a sourcePath (KnownPackage entries)')` (`:305`) — Single
    known-package ctx → no spawn, no `bindings/` dir.
  - `it.effect('duplicate package names: first wins, duplicate is skipped (no HMR storm)')` (`:321`)
    — Two `demo` entries with different sourcePaths → only one spawn.

### `src/codegen/emitters/stack-handle.test.ts` (192 LOC)

Wires real `RegistriesLive` + `Identity` + `ExtrasLive` (`:37-57`). Seeds two packages
(`connect_four` with mvr+captured, `arena` without), two accounts.

- `describe('StackHandleEmitter')`
  - `it.effect('emits accounts.ts, services.ts, extras.ts, captured.ts, packages.ts')` (`:88`) —
    One-shot full emit; asserts each file has the generated-header banner, accounts has both rows +
    `as const` + `AccountName` type, packages.ts conditionally emits `mvr:` field only when present,
    captured.ts contains `connect_four`'s `treasuryCap`+`metadataId` and OMITS `arena` (which has no
    captured), extras.ts starts with DO-NOT-COMMIT banner, `extras.ts` is 0o600 while siblings are
    0o644.
  - `it.effect('propagates the resolved Extras blob into extras.ts (literal-typed)')` (`:140`) —
    Pins commit 1daec503 regression: extras values arrive at the emitted file (`openLobbyId`,
    `matchmaker`) with `as const` + the `Extras` type alias.
  - `it.live('re-emit with identical inputs leaves file mtime untouched (no-op write)')` (`:164`) —
    Pin the no-Vite-HMR-storm invariant: first emit, capture `accounts.ts` mtime, sleep 50ms,
    re-emit, assert mtime unchanged.
  - `it.effect('renders an empty accounts.ts when no accounts are registered')` (`:185`) —
    `export const accounts = {} as const` body when registry empty.

(Note: this test asserts 5 files, not 6 — `coins.ts` isn't covered here. **Open question /
opportunity.**)

### `src/codegen/emitters/dapp-kit-config.test.ts` (185 LOC)

Wires real `RegistriesLive` + `Identity` (network: `'localnet'`) + `ExtrasLive`. Seeds SUI_RPC + two
packages + (optionally) WALLET_APP.

- `describe('DappKitConfigEmitter')`
  - `it.effect('emits dapp-kit-config.ts with network, rpcUrl, and sorted mvrOverrides')` (`:100`) —
    Body contains banner, `network = "localnet" as const`, `rpcUrl = "..."`, MVR overrides
    alphabetically sorted (`@local/arena` before `@local/connect_four`), `devstackDappKitConfig`
    export, DO-NOT-COMMIT banner first line, mode 0o600.
  - `it.effect('re-emit tightens mode when the prior file was 0o644 on disk')` (`:127`) — First emit
    lands 0o600; manual `chmodSync(filePath, 0o644)`; second emit RE-tightens to 0o600 (validates
    the explicit `fs.chmod` after `writeFileAtomicIfChanged` at `helpers.ts:57`).
  - `it.effect('embeds the wallet manifest when a wallet-app endpoint is registered')` (`:144`) —
    With WALLET_APP endpoint, body contains the URL, `createDevstackAdapterFromManifest` import,
    `devstackWalletInitializer` export; theme-3d invariant — body must NOT import
    `DevstackAdapterManifest` or anything from `@mysten-incubation/devstack`.
  - `it.effect('with enableBurnerWallet=false, emits an empty walletInitializers array')` (`:164`) —
    Body contains `const walletInitializers: Array<never> = []` AND has NO
    `@mysten-incubation/dev-wallet` import (so apps with their own wallets aren't pulled into that
    dep tree).
  - `it.effect('skips emit when no sui-rpc endpoint is registered yet (cold-boot path)')` (`:177`) —
    Without SUI_RPC, emitter logs and skips; `dapp-kit-config.ts` does NOT exist on disk.

### `src/codegen/emitters/dapp-kit-config.fork.test.ts` (163 LOC)

Pins the D1 contract (`notes/sui-fork-integration.md`) — dapp-kit must see the stripped network so
`getChainIdentifier` validation passes against the upstream chainId. Same scaffold as the base
dapp-kit test, plus `IdentityFor(network)` helper.

- `describe('Phase 3 P3.T8 — DappKitConfigEmitter fork-network translation')`
  - `it.effect('emits stripped network for mainnet-fork and bakes runtime: "forked"')` (`:90`) —
    Body contains `network = "mainnet"`, `devstackNetwork = "mainnet-fork"`, `runtime = "forked"`,
    `networks: [network] as [typeof network]`.
  - `it.effect('emits stripped network for testnet-fork')` (`:117`).
  - `it.effect('emits stripped network for devnet-fork')` (`:133`).
  - `it.effect('passes non-fork networks through unchanged with runtime: "normal"')` (`:149`) —
    `mainnet` → `network = "mainnet"`, `devstackNetwork = "mainnet"`, `runtime = "normal"`.

### `src/codegen/emitters/deepbook-config.test.ts` (298 LOC)

Wires real `RegistriesLive` + `Identity` + `ExtrasLive`. Seeds SUI_RPC + SuiStateRegistry +
DeepbookStateRegistry + a MUSDC coin + a SUI-MUSDC pool; optional Pyth + Margin seeds.

- `describe('DeepbookConfigEmitter')`
  - `it.effect('emits deepbook-config.ts with packageIds, coins, pools, marginPools (minimal)')`
    (`:170`) — Golden: body contains banner, `export const deepbookConfig = {`,
    `export type DeepbookConfig`, the three required `packageIds` fields (DEEPBOOK_PACKAGE_ID,
    REGISTRY_ID, DEEP_TREASURY_ID), `"SUI"` / `"DEEP"` / `"MUSDC"` coin keys, DEEP address equals
    deepbook package id, one alias-keyed pool with `baseCoin: "SUI"` / `quoteCoin: "MUSDC"`, NO
    margin block, NO Pyth block, `marginPools: {}` present, ends with `} as const;`.
  - `it.effect('emits margin + Pyth blocks when DeepbookMarginStateRegistry + PythStateRegistry seeded')`
    (`:217`) — Margin package ids fold into packageIds (MARGIN_PACKAGE_ID, MARGIN_REGISTRY_ID,
    LIQUIDATION_PACKAGE_ID); SUI + DEEP coins gain `feed` + `priceInfoObjectId` from Pyth; margin
    pool projection emits a symbol-keyed entry; Pyth block at bottom with pythStateId +
    wormholeStateId.
  - `it.effect('skips emit when services.deepbook is absent')` (`:256`) — Cold boot path: only SUI
    seeded → no `deepbook-config.ts` written.
  - `it.effect('skips emit when deepbook package is missing captured.deepTreasuryId')` (`:274`) —
    Defensive: deepbook in manifest but no captured TreasuryCap → skip-emit rather than land a file
    that breaks at runtime.

### `src/codegen/emitters/integration.test.ts` (194 LOC)

Catches "emitted code doesn't parse" / "missing export" regressions that unit tests (which inspect
body strings) would miss. Emits into `src/codegen/emitters/__integration_emitted__/it-<pid>-<rand>/`
so vitest's Vite transform handles `.ts` → ESM for dynamic `import()`. (Code comment at `:1-14`
covers the alternatives considered.)

- `describe('codegen emitters — generated code imports cleanly')`
  - `it.effect('emits dapp-kit-config.ts that imports cleanly and exports the expected config')`
    (`:112`) — `enableBurnerWallet: false`; dynamically imports the emitted file; asserts
    `devstackDappKitConfig.defaultNetwork === 'localnet'`, `networks === ['localnet']`,
    `createClient` is a function, `walletInitializers` is an empty array.
  - `it.effect('emits stack-handle files that import cleanly and export the expected symbols')`
    (`:143`) — Dynamically imports each of `accounts.ts`, `services.ts`, `extras.ts`, `captured.ts`,
    `packages.ts`; asserts each runtime value (types erase). Specific:
    `accounts.accounts === { alice: '0x1' }`, `services.services.sui.rpc.url` round-trips,
    `extras.extras === {}`, `captured.captured === { hello: { treasuryCap: '0xcafe' } }`,
    `packages.packages === { hello: { id: '0xabc', mvr: '@local/hello' } }`. (Notable absence:
    `coins.ts` is not exercised here.)

## Pain points today

1. **`OPEN QUESTION` / dead surface — `PackageOptions.codegen` accepts an object form
   `{ emitters: ReadonlyArray<unknown> }` (`services/package.ts:172`) but `Codegen` only honors the
   boolean form** (`services/codegen.ts:195` checks `=== true` only). The object form has no
   implementation, no test, no call site. Either remove the type or implement the override.

2. **`R` defaults to `any` on `Emitter` and `defineEmitter`** (`codegen/define-emitter.ts:78, 91`)
   with eslint-disables for `@typescript-eslint/no-explicit-any`. The justification is in the
   comments: most emitters touch many registries + the user's `Extras` Effect (whose R is `any` by
   construction), so the loose default avoids forcing `as Effect<…, any>` at the boundary. This is a
   pragmatic compromise but leaves `Codegen`'s `emitters: ReadonlyArray<Emitter>` iteration site
   with no R-channel enforcement. The runtime always provides every R any built-in could need, but a
   user emitter that needs a non-default service has no compile-time check at the array site.

3. **`StackHandleEmitter` reads `gatherManifest()` while `BindingsEmitter` reads `ctx.packages`
   directly** (`emitters/bindings.ts:13-15` calls this out as a "manifest-contract exception"). The
   split is correct (sourcePath is source-tree data, not registry state) but the two paths drift: a
   registry-published package without a passed-in `Package` ref is invisible to bindings but visible
   to the manifest emitters. Document or formalize.

4. **`gatherManifest` is called THREE times per codegen cycle** — once by StackHandleEmitter, once
   by DappKitConfigEmitter, once by DeepbookConfigEmitter (`emitters/stack-handle.ts:172`,
   `dapp-kit-config.ts:179`, `deepbook-config.ts:196`). Each call reads every registry's snapshot.
   The work is cheap (Refs in memory) but the pattern is wasteful and serializes more than
   necessary. Could be lifted to a single `gatherManifest` at the start of the emit cycle with the
   result threaded into `CodegenContext`.

5. **`ExtrasResolved` is resolved THREE times per cycle** — once per manifest-reading emitter
   (`stack-handle.ts:171`, `dapp-kit-config.ts:178`, `deepbook-config.ts:195`). The double-yield
   (`yield* yield* ExtrasResolved`) does hit a memoized inner Effect, so subsequent yields are
   cheap, but the duplication is friction.

6. **The `JSON.stringify(value, jsonBigintReplacer, '\t')` literal-render approach has subtle
   gotchas.** `renderServices` (`stack-handle.ts:65-76`) emits via raw `JSON.stringify`;
   identifier-safe key check is implicit (assumes registry keys are valid JS identifiers).
   `renderAccounts`, `renderCaptured`, `renderPackages`, `renderCoins`, `renderConfig`,
   `renderCoin`, `renderPool`, `renderMarginPool`, `renderPackageIds` are each hand-rolled with
   subtle differences in JSON-string sort + comma placement. No shared "render an as-const TS object
   literal" helper. Easy to drift; only golden tests catch divergence.

7. **DeepbookConfigEmitter is the most coupled emitter** (`emitters/deepbook-config.ts`, 386 LOC —
   the largest emitter): hard-codes SUI's coin type (`SUI_COIN_TYPE`, `:75`), seeds SUI + DEEP into
   the coin map manually (`:267-293`), reverse-maps margin-pool asset types through the coin map
   (`:351-366`), and embeds Pyth feed/PIO merging logic that's specific to Deepbook's CoinMap shape.
   The "non-deepbook stacks just emit nothing" escape hatch (`:198-206`) keeps the default emitter
   list safe, but the emitter is doing a lot for a "config render" plug-in.

8. **`writeIfChanged`'s post-write chmod is load-bearing but not obvious.** `helpers.ts:51-58`
   documents why (no-op writes still need correct perms); the test `dapp-kit-config.test.ts:127-142`
   is the only thing catching a regression. Easy to "optimize" the chmod away by accident.

9. **`Codegen` emits a `.gitignore` AFTER the atomic swap** (`services/codegen.ts:286-294`). That's
   correct (the snapshot-and-replay covers user customizations) but it means the `.gitignore` itself
   is NOT part of the atomically-promoted tree. A consumer reading `.gitignore` during the brief
   window between the swap and the `.gitignore` write sees the old or no file. Not currently a
   correctness issue (only humans/git read it) but the asymmetry is worth noting.

10. **The integration test's `__integration_emitted__/` scratch dir lives inside `src/`**
    (`emitters/integration.test.ts:47-48`), which is unusual (test scratch usually goes under
    tmpdir). Comment at `:9-14` explains the choice (vitest's Vite transform only handles `.ts`
    inside the project root); accepted but odd.

11. **`bindings.ts` and `services/codegen.ts` both call `stageAndSwap` independently.** Codegen
    wraps the entire multi-emitter run in one swap; BindingsEmitter wraps its
    `<outputDir>/bindings/` subtree in a nested swap. So a successful bindings emit followed by a
    failing later emitter still rolls back the OUTER swap (bindings output lands in staging, then
    gets rolled back when stage-and-swap drops the staging tree). The inner swap is therefore
    redundant in the multi-emitter path — but useful in the standalone-emitter case (unit tests,
    custom orchestrations). The comment at `stage-and-swap.ts:22-27` documents that the primitive
    was extracted from two divergent implementations; the bindings inner swap is the older one that
    stayed.

12. **Codegen has no way to declare "emit only files X, Y" or "regenerate only this emitter".**
    Every emit cycle runs every emitter, even when nothing the emitter consumes changed. Selective
    per-emitter invalidation is mentioned at `emitters/bindings.ts:323-330` ("doesn't survive across
    processes — that's intentional") but absent. Currently the bindings fingerprint short-circuit IS
    the per-emitter invalidation for that one emitter; the others rely on `writeIfChanged`'s no-op
    write to suppress HMR storms.

13. **The `JSON.stringify`-based `extras.ts` render embeds bigints via `jsonBigintReplacer`
    (`stack-handle.ts:46`).** That converts bigints to strings — fine for the immediate use but
    consumers reading `extras.someBigint` get a `string`, not a `bigint`. **OPEN QUESTION:** is this
    the intended behavior, or should the render preserve bigint typing via a custom serializer?

## Open questions

1. **What does `devstack wipe` do with `src/generated/`?** State-store-keys grep shows no codegen
   entry, but the assignment mentions "What gets wiped on `devstack wipe`" as a persistence
   dimension. Need to confirm whether the CLI has a clean-codegen path separate from the engine.

2. **Is `PackageOptions.codegen: { emitters: ReadonlyArray<unknown> }` planned or dead?** No call
   site uses it; no test exercises it; `Codegen` doesn't read it.

3. **Should `coins.ts` be covered by the unit tests for StackHandleEmitter?** The emit code at
   `stack-handle.ts:199-203` writes the file, but `stack-handle.test.ts` doesn't seed `CoinRegistry`
   and asserts only the other 5 files at `:88`. The integration test (`integration.test.ts`) doesn't
   import `coins.ts` either. Effectively untested directly.

4. **The `enableBurnerWallet` knob branches the EMITTED imports — does it match how downstream `Dev`
   / Vite handle dead imports?** A user who flips between values mid-stack-lifetime gets a
   hot-restart that swaps the import block of `dapp-kit-config.ts`; Vite picks that up via HMR. But
   the type signature of `walletInitializers` flips from `Array<never>` to a non-empty derived type
   — depending on consumer code that union-types these, this could be a TS-only mid-cycle break.

5. **What's the watch model for "registry changed without source file change"?** Bindings
   invalidates via source-mtime walk. The other three emitters depend on `gatherManifest()` — but
   `gatherManifest` reads Refs that are populated by sibling Layers. A registry-only change (e.g. a
   new endpoint published by a sibling) triggers a `Codegen` re-acquire only if the watch/restart
   loop fires for the sibling. The flow is end-to-end correct (sibling republish → bindings recache
   miss possible → cycle re-emits) but the trigger chain is implicit.

6. **`renderServices`'s key safety.** `JSON.stringify` of the services object produces a TS object
   literal whose keys come from `services.sui`, `services.walrus`, etc. — currently all
   JS-identifier-safe. If a future service has a non-identifier key, the emitted `as const` will
   need additional quoting (works) but the `keyof typeof services` users derive will surface
   awkwardly. No test pins this.

7. **`OPEN QUESTION` from Pain Point 9:** is the `.gitignore` write being outside the atomic swap a
   tracked compromise, or has it not come up?

8. **Skip-emit branches don't remove a stale prior emit.** If the FIRST cycle emits
   `dapp-kit-config.ts` and the SECOND cycle skips (e.g. sui briefly disappears from the manifest),
   the stale file stays. The body of the first emit will likely still work (the URL is still valid)
   but it's not actually fresh. Currently no test covers this transition.

9. **`extras.ts` is mode 0o600 + DO-NOT-COMMIT banner + gitignored** — three layers of "keep this
   off other workstations". But `extras` content is also baked into the manifest
   (`runtime/service.ts:340`) which is written to `.devstack/manifest.json`. The manifest's
   protection model lives elsewhere; codegen's three layers may be redundant if the manifest already
   enforces.

10. **The fingerprint walk skips hidden dirs and `build`/`node_modules`**
    (`emitters/bindings.ts:298-299`). Symmetric with `hashMoveSources` in `publishMove`. Any other
    dir name that should be excluded (e.g. a custom `.move-modules/` cache)? No test covers the
    edge.

11. **The integration test's dynamic-import strategy relies on vitest's Vite transform.** If vitest
    config changes or the project root moves, the test fails in a non-obvious way. No CI smoke test
    would catch a misconfiguration upfront.

## Opportunities noticed

1. **Hoist `gatherManifest()` + `ExtrasResolved` resolution to a single call per codegen cycle** and
   thread the result into `CodegenContext`. Eliminates the 3× duplication (Pain Point 4–5) and
   removes the double-yield pattern from emitter bodies.

2. **Implement OR remove `PackageOptions.codegen: { emitters: [...] }`** (Pain Point 1 / Open
   Question 2). If the per-package emitter override is wanted, it needs a clear semantic ("union
   with stack emitters? replace?"). If not, drop the type.

3. **Extract a small "render TS object literal" helper** to absorb the 8+ hand-rolled
   `JSON.stringify`+sort+tab+comma patterns across the four emitters (Pain Point 6). Would also be
   where the bigint-handling decision (Open Question 3 / Open Question 11) lives in one place.

4. **Cover `coins.ts` in a unit test** (Open Question 3). Trivially seed `CoinRegistry` and assert
   the file contents in `stack-handle.test.ts`.

5. **Consider lifting the `.gitignore` write into the staging tree before the swap** (Pain Point 9).
   Trade-off: lose the "preserve user customizations" trivially (the snapshot-replay pattern would
   still work but become more involved). Probably not worth doing.

6. **Collapse the nested `stageAndSwap` in `BindingsEmitter`** (Pain Point 11). Since the outer
   `Codegen` swap already provides atomicity, the inner swap is redundant in the canonical path.
   Keep `BindingsEmitter` callable in isolation (for unit tests) but skip the nested swap when run
   under a `Codegen` context.

7. **Lift the deepbook emitter's coin-map seeding (SUI + DEEP) into the registry** rather than
   hard-coding it in the render path (Pain Point 7). Localdeploy already captures DEEP's TreasuryCap
   and emits `deepbook` package state; folding the SUI built-in into `CoinRegistry` at supervisor
   boot would let DeepbookConfigEmitter read everything uniformly.

8. **Add a CI smoke test for the integration test's vitest-transform assumption** (Open Question
   11). A 5-line guard that asserts vitest's Vite transform handles `__integration_emitted__/*.ts`
   would catch a future config regression.

9. **The CodegenError phase set is `'read' | 'generate' | 'write'`** (`engine/phases.ts:163`), but
   the actual throw sites use `'generate'` for emitter-collision (an acquire-time issue, NOT
   generation), `'write'` for stage-and-swap errors, and `'generate'` for `sui move summary` (a
   binary-shell-out, not pure generation). A `'compose'` or `'acquire'` phase for collision plus a
   `'shell'` phase for the binary call would reflect the actual taxonomy.

10. **The `StackHandleEmitter` and `DappKitConfigEmitter` both emit network info into different
    files** (`services.ts` carries `services.sui.network`, `dapp-kit-config.ts` carries `network` +
    `devstackNetwork` + `runtime`). Three constants for one concept. If `services.ts` had `network`
    / `devstackNetwork` / `runtime` directly, dapp-kit-config wouldn't need to duplicate the
    fork-stripping logic.

11. **`DEFAULT_WATCH_EXCLUDES` hard-codes `'**/generated/**'`** (`engine/supervisor.ts:773`). This
    makes the `output: './src/generated'` default magic — overriding `output:` to e.g.
    `./src/codegen-out/` requires the negation in `Codegen`'s own watch (`services/codegen.ts:316`)
    to kick in. Consider documenting the dual mechanism or unifying via a "codegen-output-roots"
    registry the supervisor reads.

12. **The `gatherManifest()` snapshot's `network` field carries the unstripped form, but the
    `services.sui.network` field does too** — so DappKitConfigEmitter strips locally
    (`emitters/dapp-kit-config.ts:204-209`). If `gatherManifest` projected a `runtime` +
    `dappKitNetwork` directly, the fork-translation logic could live in one place. (Could co-locate
    with Opportunity 10.)

13. **The double-yield `yield* yield* ExtrasResolved`** in three emitters is a known Effect-v4 idiom
    for memoized-Effect access, but it's an awkward read for newcomers. A thin helper
    `getExtras: Effect<Record<string, unknown>, never, ExtrasResolved>` in `engine/extras.ts` would
    absorb the pattern.

14. **Codegen is NOT in `fillDefaults`** (`compose/defaults.ts` confirmed via grep). The user must
    remember to add `Codegen()` to get a typed app kit. Worth considering whether
    `devstack({ ..., codegen: true })` (or similar) should auto-add it for app-mode stacks.

15. **The `DeepbookServerStateRegistry` is registered, projected into the manifest, but
    DeepbookConfigEmitter does NOT consume it** (`emitters/deepbook-config.ts` reads
    `services.deepbook` which includes `deepbook.server` via `gatherManifest`, but the renderer
    doesn't surface any server URL into `deepbookConfig`). Either the registry's relevance to
    codegen is implicit (consumer reads it from the manifest elsewhere) or it's a future hookup
    point. Worth checking against the deepbook docs in the parallel batch.

16. **No selective per-emitter invalidation.** Pain Point 12. Today every cycle runs every emitter;
    the bindings fingerprint short-circuits internally; the other three rely on writeIfChanged's
    no-op write. A first cut at per-emitter cache keys (e.g. hash of the registry snapshots each
    emitter touched) would let an emitter skip its body entirely on no-change.
