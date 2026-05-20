# pyth

## Purpose

The `pyth` component is devstack's Pyth-Network price-feed integration. Pyth is the on-chain oracle that publishes off-chain market prices into Sui Move objects (`PriceInfoObject`s); downstream consumers (Deepbook's margin/liquidation Move modules in particular) read those objects when valuing positions. This devstack component does three things, depending on the active Sui network:

- **localnet**: publishes a *vendored* Pyth Move package onto the local Sui chain, calls `pyth::create_price_feeds` once per requested feed to materialise on-chain `PriceInfoObject`s, then optionally runs a long-lived in-process *pusher* fiber that fetches historical prices from `benchmarks.pyth.network` and calls `pyth::update_single_price_feed` on a 10s cadence so on-chain prices stay non-stale (services/pyth.ts:1-91; services/pyth/local-deploy.ts:1-417; services/pyth/pusher.ts:1-450).
- **testnet/mainnet/<network>-fork**: wraps the canonical mainnet/testnet Pyth deployment by reading `packageId` + `pythStateId` + `wormholeStateId` + per-feed `priceInfoObjectId`s from the static `knownDeployments.deepbook.<network>.pyth` and `.coins[].priceInfoObjectId` blocks. No publish, no pusher — chain already carries the real Pyth (services/pyth.ts:62-80; services/pyth/known-deployment.ts:1-89; engine/known-deployments.ts:284-287, 384-387).
- **devnet/devnet-fork**: no canonical deployment is registered, so `Pyth()` without `local:` config raises (services/pyth.ts:72-77; engine/known-deployments.ts:60-65).

The component is a **pure in-process host service** — there is no Pyth container, no Docker image, no host binary. The local-deploy path runs a Move publish as Sui transactions through the configured signer; the pusher runs as an `Effect.forkScoped` fiber inside the supervisor; the known-package path is a literal-data projection (services/pyth/known-deployment.ts:33-88). The primary consumer is **deepbook margin** (typecheck-required), which dereferences `findPriceInfo(feed)` per asset to build its `oracle::new_pyth_config` Move call (services/deepbook/margin.ts:173, 323-330, 405-415).

## Current implementation

### Public service entrypoint (src LOC: 91)

- `services/pyth.ts` (91 LOC) — Canonical `Pyth(opts)` factory. Reads `DEVSTACK_NETWORK` via `resolveNetwork()` (services/pyth.ts:62), then on localnet delegates to `pythLocalDeploy` (services/pyth.ts:86-90), on testnet/mainnet/<fork> delegates to `pythKnownPackage` (services/pyth.ts:71-79). Throws synchronously on devnet (services/pyth.ts:72-77) or on localnet when `local:` config is missing (services/pyth.ts:81-85). Re-exports the entire `./pyth/*` surface (services/pyth.ts:17-40).

### `services/pyth/` directory (src LOC: 1162, test LOC: 178)

- `services/pyth/index.ts` (33 LOC) — Re-export barrel. Surfaces `PythTag`, `pythLocalDeploy`, `pythKnownPackage`, `PythPusher`, `pythMid`, the feed-id constants, and every `Pyth*` type.
- `services/pyth/tag.ts` (29 LOC) — `PythTag` (the `Context.Service` tag with identifier `'@devstack/PythTag'`) and the `Pyth` + `PythPriceInfo` interfaces every Pyth producer must satisfy. Pyth = `{packageId, pythStateId?, wormholeStateId?, priceInfos[], findPriceInfo(feed), findPriceInfoByLabel(label)}` (services/pyth/tag.ts:13-27).
- `services/pyth/shared.ts` (110 LOC) — Mainnet feed-id constants (`SUI_PRICE_FEED_ID`, `DEEP_PRICE_FEED_ID`, `USDC_PRICE_FEED_ID` — services/pyth/shared.ts:17-22), the `PythPriceInfoSpec` shape (services/pyth/shared.ts:28-39), the `addPriceInfo` Move-call builder for `pyth::create_price_feeds` (services/pyth/shared.ts:49-78), a hex→bytes helper, and the cadence/lookback/API-URL defaults (`DEFAULT_PUSHER_REFRESH_MS=10_000`, `DEFAULT_HISTORICAL_HOURS=24`, `DEFAULT_PYTH_API_URL='https://benchmarks.pyth.network'` — services/pyth/shared.ts:104-110).
- `services/pyth/local-deploy.ts` (416 LOC) — `pythLocalDeploy(opts)`. Composes a `publishMove` (via `services/package/internal.ts`) for the vendored Pyth source, then wraps it in `onChainArtifact(...)` whose `produce` body submits one batched `create_price_feeds` tx with one Move call per feed (services/pyth/local-deploy.ts:254-298). Persists via `publishPackage` + `publishPythState` in `register` so the `PackageRegistry` and `PythStateRegistry` are populated on every supervisor cycle (services/pyth/local-deploy.ts:338-383). Layers a `PythTag` projection on top of the per-name composite tag so downstream consumers can `yield* PythTag` (services/pyth/local-deploy.ts:386-413).
- `services/pyth/known-deployment.ts` (88 LOC) — `pythKnownPackage(opts)`. Reads `packageId`/`pythStateId`/`wormholeStateId` from `knownDeployments.deepbook.<network>.pyth`, derives per-feed PriceInfoObjects from `knownDeployments.deepbook.<network>.coins[].{feed, priceInfoObjectId}` (services/pyth/known-deployment.ts:47-55), and provides `PythTag` directly via `provide(PythTag, …)` (services/pyth/known-deployment.ts:57-87). Also writes to `PythStateRegistry` so codegen consumers see a uniform shape (services/pyth/known-deployment.ts:64-71).
- `services/pyth/pusher.ts` (449 LOC) — `PythPusher(opts)`. Long-running fiber that:
  - Fetches updates from `benchmarks.pyth.network/v1/updates/price/<ts>?ids[]=…` (default) or a fixture function (services/pyth/pusher.ts:65-76, 109-159, 202-220).
  - Builds a single batched tx with one `pyth::update_single_price_feed` call per fed feed and signs it with the configured signer (services/pyth/pusher.ts:226-271).
  - First-tick gates: probes one cache entry per feed via the `withCache` substrate, fires the boot tick synchronously only when at least one feed cache miss / verify-fail is observed (services/pyth/pusher.ts:343-405).
  - Steady-state loop: `Effect.repeat(Schedule.spaced(refreshMs))`, swallows transient errors as log warnings (services/pyth/pusher.ts:411-417).
- `services/pyth/mid.ts` (226 LOC) — `pythMid(opts)`. A `Ref<bigint>` helper that polls a `PriceInfoObject` via `sui.client.core.getObject(objectId)` and exposes `read(): bigint` + `readEffect: Effect<bigint>` (services/pyth/mid.ts:79-225). Supports cross-rate via `quote:` feed (`base / quote`) and a `PythMidScale` for decimals (services/pyth/mid.ts:21-29, 173-188). Re-exported from `/advanced` (advanced/index.ts:149-155) — **not** consumed by the in-tree `DeepbookMarketMaker` example today. (See "Pain points" for the mismatched code comment).

### Tests in scope (test LOC: 178)

- `services/pyth/local-deploy.test.ts` (135 LOC) — Tx-builder shape + state-store-key shape + factory mutual-exclusion / required-arg behaviour. No chain hit.
- `services/pyth/known-deployment.test.ts` (43 LOC) — `@effect/vitest` test that exercises `pythKnownPackage` against `testnet` known deployment + asserts the projected `Pyth` shape.

(There is no in-tree pusher / mid unit test file. Pusher behaviour is covered indirectly by `services/deepbook/codegen.docker.test.ts` and by docker tests that bring up the full deepbook-margin stack — these are scoped to the deepbook component, not pyth.)

### Test fixtures (not test source — used by Pyth and Deepbook tests)

- `test-setup/fixtures/pyth/feeds.ts` (13 LOC) — `PYTH_FEED_IDS = {SUI, DEEP, USDC}` re-exporting the mainnet hex ids (test-setup/fixtures/pyth/feeds.ts:6-10).
- `test-setup/fixtures/pyth/{sui,deep,usdc}.json` — Captured `parsed[]` payloads from the Pyth Benchmarks API. Used by `bump-timestamp.ts`.
- `test-setup/fixtures/pyth/bump-timestamp.ts` (72 LOC) — `bumpedFixtureUpdates(labels, secOffset)`: builds deterministic `PythPriceUpdate[]` for `PythPusherSource.kind === 'fixture'`. Used by docker tests that pin on-chain price + advance the timestamp by re-pushes (test-setup/fixtures/pyth/bump-timestamp.ts:45-71).

### Engine-side glue (PythError, PythStateRegistry, PythStateRecord)

- `engine/registries.ts:90-99` — `PythStateRecord` shape: `{name, packageId, pythStateId?, wormholeStateId?, priceInfoObjectIds: Record<feedId, objectId>, feeds: Record<label, feedId>}`.
- `engine/registries.ts:275-278` — `PythStateRegistry` Context.Service tag (`'@devstack/PythStateRegistry'`).
- `engine/registries.ts:355-358` — `PythStateRegistryLive` + `publishPythState` produced by `defineRegistry`.
- `engine/registries.ts:396` — wired into the registries roll-up layer.
- `engine/supervisor.ts:83, 359` — `PythStateRegistryLive` merged into the supervisor's base registries layer.
- `engine/errors.ts:362-372` — `PythError` schema-tagged error with optional `phase` (PythPhase) + optional `feed` (mainnet hex id).
- `engine/phases.ts:107-114` — `PythPhases = ['publish', 'create-feeds', 'pusher-fetch', 'pusher-update', 'pyth']` (closed set).
- `engine/known-deployments.ts:94-99` — `DeepbookPythConfig` interface (`pythStateId`, `wormholeStateId`).
- `engine/known-deployments.ts:122` — `pyth?: DeepbookPythConfig` optional field on `DeepbookDeployment`.
- `engine/known-deployments.ts:284-287` (testnet pyth state ids) + 384-387 (mainnet pyth state ids).
- Pyth feed + priceInfoObjectId per coin entry on testnet/mainnet (engine/known-deployments.ts:186-227, 299-338). DEVNET has no entry (engine/known-deployments.ts:389+).
- `engine/state-store-keys.ts:130-134` — `pythPackage(input) → 'pyth/package/<chainId>/<packageId>/<feedsHash>'` (NB: the actual on-disk key shape used by `onChainArtifact` is `pyth/package/<chainId>/<contentHash(inputs)>`; see Pain points).
- `engine/state-store-keys.ts:140-144` — `pythPusher(input) → 'pyth/pusher/<chainId>/<packageId>/<signerAddress>'`.

### Runtime/codegen consumption

- `runtime/manifest-schema.ts:119-128` — `PythManifest` Schema struct surfaced into the on-disk `manifest.json`.
- `runtime/service.ts:130-143` — `pythProjection` (the `PythStateRegistry → PythManifest` projector).
- `codegen/emitters/deepbook-config.ts:152-154, 260-265, 368-379` — emits the `pyth:` block of the generated `deepbook-config.ts` plus folds per-coin `feed` + `priceInfoObjectId` into each coin entry.

### Totals
- **src LOC:** 1253 (services/pyth.ts + services/pyth/*.ts)
- **test LOC:** 178 (services/pyth/*.test.ts)
- (Engine glue, codegen emit, and test fixtures excluded from these totals — they're owned by other components / agents.)

## Configuration

### `defineDevstack` config (component-facing)

The Pyth component accepts its config through the `Pyth(opts)` factory in stack files (no `defineDevstack` top-level Pyth key). Every knob below is a field on the factory's `opts` argument or on its delegates (`pythLocalDeploy`, `pythKnownPackage`, `PythPusher`, `pythMid`).

`Pyth(opts: PythOptions)` (services/pyth.ts:42-48, 61-91):

| Field | Type | Default | Notes |
|---|---|---|---|
| `name` | `string` | `'pyth'` | Composite tag name; flows into PackageRegistry / PythStateRegistry record names (services/pyth.ts:87; services/pyth/local-deploy.ts:96). |
| `local` | `Omit<PythLocalDeployOptions<string>, 'name'>` | — | **Required on localnet** (services/pyth.ts:81-85). Ignored on testnet/mainnet/<fork>. |

`PythLocalDeployOptions<Name>` (services/pyth/local-deploy.ts:72-84):

| Field | Type | Default | Notes |
|---|---|---|---|
| `name` | `Name extends string` | `'pyth'` | Cache-key + registry-key namespace. |
| `signer` | `LayeredTag<…, Account, …>` | — | **Required.** Account that signs the publish + create-feeds txs. |
| `movePackagePath` | `string` | — | Literal filesystem path to a vendored Pyth Move package. Mutually exclusive with `vendor`. |
| `vendor` | `LayeredTag<…, {pyth: string}, …>` | — | Source the path from a `VendorDeepbook(...)` Ref's `.pyth` subpath. Mutually exclusive with `movePackagePath`. |
| `feeds` | `ReadonlyArray<PythLocalDeployFeedSpec>` | — | **Required, non-empty** (services/pyth/local-deploy.ts:103-105). One PriceInfoObject is created per element. |
| `dependsOn` | `ReadonlyArray<LayeredTag<…>>` | `[]` | Extra topo-scheduler deps; flattened into the `upstream` record (services/pyth/local-deploy.ts:145-148, 165-170). |

`PythLocalDeployFeedSpec` (services/pyth/local-deploy.ts:64-70):

| Field | Type | Notes |
|---|---|---|
| `label` | `string` | Friendly key (`'SUI'`, `'DEEP'`, …). Registry + cache lookup key. |
| `feedId` | `PythPriceFeedId` | Mainnet hex id (32 bytes, `0x`-prefixed or unprefixed). |
| `initial` | `PythPriceInfoSpec` | The seed price for `create_price_feeds` (services/pyth/shared.ts:28-39). |

`PythKnownPackageOptions` (services/pyth/known-deployment.ts:15-31):

| Field | Type | Default | Notes |
|---|---|---|---|
| `network` | `KnownNetwork` | — | Required. One of `'mainnet' | 'testnet' | 'devnet'` (engine/network.ts via `KnownNetwork` re-export). |
| `packageId` | `string` | `''` (with note) | Pin a private fork. The `knownDeployments` snapshot DOES NOT carry the Pyth package id today — only state ids — so callers should always pass this explicitly for any real testnet/mainnet use (services/pyth/known-deployment.ts:38-44, see also Pain points). |
| `pythStateId` | `string` | from `knownDeployments.deepbook.<network>.pyth.pythStateId` | Override. |
| `wormholeStateId` | `string` | from `knownDeployments.deepbook.<network>.pyth.wormholeStateId` | Override. |
| `priceInfoObjects` | `ReadonlyArray<{label, feedId, priceInfoObjectId}>` | derived from `knownDeployments.deepbook.<network>.coins` | When unset, every coin entry with both `feed` AND `priceInfoObjectId` is folded in. |

`PythPusherOptions<Name>` (services/pyth/pusher.ts:93-107):

| Field | Type | Default | Notes |
|---|---|---|---|
| `name` | `Name extends string` | — | **Required.** Tag name + cache label segment. |
| `signer` | `LayeredTag<…, Account, …>` | — | **Required.** **Must differ from any maker's signer** (R8 — convention-enforced, no runtime check; services/pyth/pusher.ts:96-97). |
| `pyth` | `LayeredTag<…, Pyth, …>` | — | **Required.** The provider of `PriceInfoObject`s the pusher updates. |
| `refreshMs` | `number` | `10_000` (services/pyth/shared.ts:104) | Steady-state loop cadence. |
| `source` | `PythPusherSource` | `{kind: 'benchmarks'}` | One of `{kind: 'benchmarks', url?, historicalHours?}` or `{kind: 'fixture', fetch}` (services/pyth/pusher.ts:65-76). |
| `gasBudget` | `bigint` | `200_000_000n` (services/pyth/pusher.ts:191) | Per-update-tx budget. |
| `dependsOn` | `ReadonlyArray<LayeredTag<…>>` | `[]` | Extra topo deps. |

`PythPusherSource['benchmarks']` sub-knobs:

| Field | Type | Default | Notes |
|---|---|---|---|
| `url` | `string` | `'https://benchmarks.pyth.network'` (services/pyth/shared.ts:110) | API base URL. |
| `historicalHours` | `number` | `24` (services/pyth/shared.ts:107) | Lookback for the `/v1/updates/price/<ts>` request; sandbox parity. |

`PythMidOptions<Name>` (services/pyth/mid.ts:31-49):

| Field | Type | Default | Notes |
|---|---|---|---|
| `name` | `string` | `'pythMid'` | Tag name. |
| `pyth` | `LayeredTag<…, Pyth, …>` | — | Required. |
| `feed` | `PythPriceFeedId` | — | Required. Base feed. |
| `quote` | `PythPriceFeedId` | — | Optional. Enables `base / quote` cross-rate. |
| `scale` | `PythMidScale` | — | Required. `{priceDecimals, baseDecimals?, quoteDecimals?}`. |
| `refreshMs` | `number` | `5_000` (services/pyth/mid.ts:81) | Steady-state cadence. |
| `initial` | `bigint` | — | Required (OD5 — no auto-poll fallback). |
| `dependsOn` | `ReadonlyArray<LayeredTag<…>>` | `[]` | — |

### CLI flags

There is no Pyth-specific CLI flag in the devstack CLI. Pyth's behaviour is driven entirely by `Pyth(opts)` in the stack file plus the global `DEVSTACK_NETWORK` env var (resolved via `resolveNetwork()` at factory-construction time — services/pyth.ts:62).

### Environment variables

- `DEVSTACK_NETWORK` (read indirectly through `resolveNetwork()` — services/pyth.ts:62; engine/network.ts) — determines whether `Pyth()` returns the local-deploy or the known-package variant. Accepted values: `'localnet'`, `'testnet'`, `'mainnet'`, `'devnet'`, `'testnet-fork'`, `'mainnet-fork'`, `'devnet-fork'` (engine/known-deployments.ts:56-65).

Pyth does NOT read any of its own dedicated env vars — no `PYTH_API_URL`, no `PYTH_PUSHER_REFRESH_MS`, etc. All knobs are TypeScript-level on the factory `opts`.

## Capabilities CONSUMED

### Other services / components

- **Sui (SuiTag → ChainProbe, `sui.client`, `sui.chainId`)** — Required by every Pyth code path.
  - `pythLocalDeploy` requires it transitively via the `publishMove(signer, …)` sibling (services/pyth/local-deploy.ts:18, 125-137). The substrate's `onChainArtifact` itself reads `chain` (ChainProbe) for the verify step (services/pyth/local-deploy.ts:209-220).
  - `pythKnownPackage` consumes nothing chain-side at runtime (it's pure data projection) but is still produced under the supervisor's Sui-providing layer in practice.
  - `PythPusher` directly yields `SuiTag` (services/pyth/pusher.ts:184) and `ChainProbe` (services/pyth/pusher.ts:29, 187) for `sui.chainId`, the signer's `signAndExecute`, and the per-feed `chain.getObject(priceInfoObjectId)` verify probe (services/pyth/pusher.ts:308-315).
  - `pythMid` directly yields `SuiTag` (services/pyth/mid.ts:89) for `sui.client.core.getObject` (services/pyth/mid.ts:127).
- **Account signer (any `LayeredTag<…, Account, …>` upstream)** — Both `pythLocalDeploy.signer` and `PythPusher.signer` consume the signer's `signAndExecute(tx)` (services/pyth/local-deploy.ts:259-268; services/pyth/pusher.ts:260-269) and read `.address` for the cache key (services/pyth/pusher.ts:305). The signer is typically the `Account('publisher')` tag, but for the pusher it must be a **different** account from the publisher and any maker (R8).
- **`vendor` Ref (VendorDeepbook)** — When `pythLocalDeploy` is configured with `vendor:` (the canonical example pattern), it yields the vendor tag inside an Effect-typed path resolver, reads `.pyth` subpath (services/pyth/local-deploy.ts:113-121). `VendorDeepbook` itself fetches `MystenLabs/deepbook-sandbox`'s `sandbox/packages/pyth` source tree (services/deepbook/vendor.ts:131, 264).
- **`publishMove` (`services/package/internal.ts`)** — Sibling primitive that `pythLocalDeploy` composes into its `upstream` record (services/pyth/local-deploy.ts:17, 123-137). The publish-side cache + chain-verify discipline lives in `publishMove`; `pythLocalDeploy` only captures `pythStateId` + `wormholeStateId` from the publish's objectChanges (services/pyth/local-deploy.ts:129-135).

### Engine resources

- **`onChainArtifact` substrate** (engine/on-chain-artifact.js) — `pythLocalDeploy` wraps its entire body in `onChainArtifact({namespace: 'pyth/package', …})`. This provides: cache-key derivation (canonical-JSON hash of inputs + chainId), the verify→produce→register pipeline, atomic state-store IO (services/pyth/local-deploy.ts:17, 150-384).
- **`withCache` substrate** (engine/cache.js) — `PythPusher` uses `withCache` directly per feed (services/pyth/pusher.ts:31, 298-315, 375-398) — outside `onChainArtifact` because the boot-tick must batch multiple per-feed entries into one tx.
- **`ChainProbe`** (engine/chain-probe.js) — Used for both verify probes:
  - Local-deploy verify: `chain.objectsMatchTypes([{objectId, expectedType}], moveTypeEquals)` over the cached PriceInfoObject ids (services/pyth/local-deploy.ts:209-220).
  - Pusher verify: `chain.getObject(cached.priceInfoObjectId)` (services/pyth/pusher.ts:311-313).
- **`StateStore`** (engine/state-store.js) — Indirectly via `withCache` (services/pyth/pusher.ts:32, 297).
- **`PackageRegistry`** (engine/registries.ts) — `pythLocalDeploy.register` calls `publishPackage({name, packageId, captured: {pythStateId, wormholeStateId}, …})` so a stack file using `name: 'pyth'` resolves to the published packageId (services/pyth/local-deploy.ts:19, 364-372).
- **`PythStateRegistry`** (engine/registries.ts:275-278) — Both local-deploy + known-package write to it via `publishPythState` (services/pyth/local-deploy.ts:373-383; services/pyth/known-deployment.ts:64-71). Downstream consumers (runtime/service.ts, codegen/emitters/deepbook-config.ts) read it to project the manifest + generated config.
- **`PythError`** (engine/errors.ts:362-372) — Component's own error type. Five phases (`'publish'`, `'create-feeds'`, `'pusher-fetch'`, `'pusher-update'`, `'pyth'` — engine/phases.ts:107-113). Carries optional `feed` (mainnet hex id) for feed-scoped failures.
- **Topo scheduler (via `__upstreamKeys`)** — `pythLocalDeploy.upstream`, `PythPusher.upstreamKeys` (services/pyth/pusher.ts:445), and `pythMid.upstreamKeys` (services/pyth/mid.ts:223) lift all consumed tags so the supervisor schedules dependencies first.

### Runtime resources

- **`fetch` (Node.js global)** + `AbortSignal.timeout(15_000)` — Pusher's benchmarks HTTP client (services/pyth/pusher.ts:124-132). Hard-coded 15s timeout per request.
- **`node:crypto`** — SHA-256 over feed specs for the cache key feedsHash (services/pyth/local-deploy.ts:12, 44-56).
- **`Transaction` from `@mysten/sui/transactions`** — Tx-builder for both `create_price_feeds` (services/pyth/local-deploy.ts:254-258) and `update_single_price_feed` (services/pyth/pusher.ts:230-258).

### Surfaces

- **Tracing** — `Effect.withSpan` named `PythKnownPackage`, `PythPusher(${name})`, `PythPusher.tick`, `PythMid(${name})` and `Effect.annotateCurrentSpan({'pyth.packageId', 'pyth.feedCount', 'pyth.pusher.lastDigest', 'pyth.pusher.feedCount', 'pyth.pusher.boot'})` (services/pyth/known-deployment.ts:60-63, 80; services/pyth/pusher.ts:332-335, 353, 401, 421, 444; services/pyth/mid.ts:210).
- **Logging** — `Effect.logWarning` for transient pusher failures + dropped-feed warnings (services/pyth/pusher.ts:236, 325, 413), `Effect.logInfo` for cache-hit boot (services/pyth/pusher.ts:402-404).
- **No TUI updates, no event bus, no command queue from Pyth directly.** The supervisor's standard service-status TUI consumes `PythStateRegistry` records via the manifest projection, but Pyth doesn't push to a TUI surface itself.

### External

- **`https://benchmarks.pyth.network/v1/updates/price/<unix-ts>?ids[]=…&encoding=hex&parsed=true`** — Default pusher source (services/pyth/pusher.ts:115-132). 15s per-request timeout.
- **Sui RPC / gRPC** (indirect, via `sui.client.core.getObject` from `pythMid` and via the signer's `signAndExecute` everywhere).
- **No system binaries.** No `sui` CLI invocation, no `docker`, no host process spawn.
- **No ports/sockets owned by Pyth.** All chain comms go through whatever ports SuiTag owns; Pyth does not bind, lease, or allocate any port.

### Effect / Layer / Context machinery

- `Context.Service` (effect) — `PythTag` class (services/pyth/tag.ts:29) + `PythStateRegistry` class (engine/registries.ts:275-278).
- `Effect.gen`, `Effect.tryPromise`, `Effect.mapError`, `Effect.fail`, `Effect.repeat`, `Effect.forkScoped`, `Effect.annotateCurrentSpan`, `Effect.withSpan`, `Effect.catchTag`, `Effect.catch`, `Effect.logInfo`, `Effect.logWarning` — used throughout.
- `Ref.make` + `Ref.get`/`Ref.set` — `pythMid` for the polled-price latch (services/pyth/mid.ts:92, 191-192, 206-208).
- `Option.isNone`, `Option.some`, `Option.none` (services/pyth/pusher.ts:25, 296-315, 345-350) — Per-feed cache probe return.
- `Schedule.spaced(refreshMs)` — `PythPusher` and `pythMid` loop schedules (services/pyth/pusher.ts:417; services/pyth/mid.ts:203).
- `Layer.provide` (effect/Layer) — Test glue (services/pyth/known-deployment.test.ts:13, 27).
- `Schema.TaggedErrorClass`, `Schema.Literals`, `Schema.optional`, `Schema.String`, `Schema.Defect` — `PythError` (engine/errors.ts:362-372).
- `Schema.Struct`, `Schema.Record` — `PythManifest` schema (runtime/manifest-schema.ts:119-128).

### Imports from other workspace packages

- `@mysten/sui/transactions` — `Transaction`, `TransactionResult` (services/pyth/shared.ts:9; services/pyth/local-deploy.ts:14; services/pyth/pusher.ts:26).
- `effect` (`Context`, `Effect`, `Schedule`, `Ref`, `Option`) — Throughout.

### npm dependencies

The Pyth-direct npm dependencies are `effect`, `@mysten/sui` (transactions module), and Node's standard `node:crypto`. Pyth does NOT add any Pyth-network npm SDK dependency to devstack — it talks to the Benchmarks REST API directly and builds the Move calls by hand.

## Capabilities PRODUCED

### Tags exposed (Effect.Context)

- **`PythTag`** (services/pyth/tag.ts:29; `'@devstack/PythTag'`) — Read-side projection over a `Pyth`-typed value (`{packageId, pythStateId?, wormholeStateId?, priceInfos[], findPriceInfo(feed), findPriceInfoByLabel(label)}`). Provided by:
  - `pythLocalDeploy` via a `provide(PythTag, …)` layer added to `__layers` (services/pyth/local-deploy.ts:386-413).
  - `pythKnownPackage` via `provide(PythTag, …)` directly (services/pyth/known-deployment.ts:57-87).
- **`PythPusher(name)` per-name service tag** (anonymous; identified by the `tag(name, …)` call site at services/pyth/pusher.ts:178). Resolves to `PythPusherHandle = {pid: 0}` (services/pyth/pusher.ts:61-63, 419).
- **`pythMid(name)` per-name service tag** (services/pyth/mid.ts:83-211). Resolves to `PythMid = {read(): bigint, readEffect: Effect<bigint>}`.

### State-store entries

- **Key `pyth/package/<chainId>/<contentHash(packageId, feedsHash)>`** — `pythLocalDeploy`'s `onChainArtifact` cache. Value is the resolved `Pyth` shape minus the lookup methods (which are re-attached in `register` — services/pyth/local-deploy.ts:307-318, 338-348). The "canonical builder" `StateStoreKeys.pythPackage` in `engine/state-store-keys.ts:130-134` records the *intent* but the actual key folds `packageId+feedsHash` through `onChainArtifact`'s `contentHash()` (see Pain points).
- **Key `pyth/pusher/<chainId>/<contentHash(packageId, signer, feedId, priceInfoObjectId)>` (one per feed)** — `PythPusher`'s `withCache` per-feed entry. Value is `{lastDigest, lastUpdatedMs, priceInfoObjectId}` (services/pyth/pusher.ts:55-59, 296-315, 375-398).

### Registry entries

- **`PackageRegistry[name]`** — Written by `pythLocalDeploy.register` (services/pyth/local-deploy.ts:364-372). Shape: `{name, packageId, upgradeCapId: undefined, captured: {pythStateId?, wormholeStateId?}}`.
- **`PythStateRegistry[name]`** — Written by both producers:
  - `pythLocalDeploy` (services/pyth/local-deploy.ts:373-383): `{name, packageId, pythStateId?, wormholeStateId?, priceInfoObjectIds: Record<feedId, objectId>, feeds: Record<label, feedId>}`.
  - `pythKnownPackage` (services/pyth/known-deployment.ts:64-71): same shape, name is `pyth.<network>`.

### Events emitted

None. Pyth doesn't publish to an event bus.

### Files written

None directly on disk by Pyth — all persistence rides the `StateStore` substrate.

### CLI commands registered

None.

### Routes registered

None. Pyth doesn't surface an HTTP server or any external endpoint.

### TypeScript exports consumed elsewhere

From `services/pyth.ts` (re-exported up to `src/index.ts` and `src/services/index.ts`):

- `Pyth(opts: PythOptions)` — the canonical factory.
- `PythTag`, `pythMid`, `PythPusher`, `SUI_PRICE_FEED_ID`, `DEEP_PRICE_FEED_ID`, `USDC_PRICE_FEED_ID` (services/pyth.ts:17-24).
- Types: `PythShape (Pyth)`, `PythPriceInfo`, `PythMid`, `PythMidOptions`, `PythMidScale`, `PythPusherHandle`, `PythPusherOptions`, `PythPusherSource`, `PythPriceFeedId`, `PythPriceInfoSpec`, `PythPriceUpdate`, `PythLocalDeployOptions`, `PythLocalDeployFeedSpec`, `PythKnownPackageOptions` (services/pyth.ts:25-40).

From `src/advanced/index.ts`:
- `pythMid` (advanced/index.ts:149-155).

Active consumers (non-test, non-pyth):
- `services/deepbook/margin.ts:42, 173, 244, 292, 323-330, 405-415` — `DeepbookMargin.opts.pyth` is `LayeredTag<…, Pyth, …>`, `pyth.findPriceInfo(cfg.feed)` is called per asset; the margin Move `oracle::new_pyth_config` call consumes `pyth.pythStateId` + `pythConfig` Move object.
- `services/deepbook/vendor.ts:131, 264` — Vendors the Pyth Move source under the deepbook vendor tree at `pyth: {repoKey: 'sandbox', subdir: 'sandbox/packages/pyth'}`. `deepbook_margin` declares Move-level deps on `pyth` (services/deepbook/vendor.ts:148).
- `runtime/service.ts:130-143` — `pythProjection` reads `PythStateRegistry` to build the manifest's `services.pyth` block.
- `codegen/emitters/deepbook-config.ts:152-154, 260-265, 368-379` — emits feed/priceInfoObjectId per coin and a `pyth: {pythStateId, wormholeStateId}` block at the bottom of the generated deepbook-config.

### Container images / volumes produced

**None.** Pyth is a pure host-process component on devstack's side.

## Lifecycle

### Startup (localnet path)

Ordered by the topo scheduler, which derives the order from upstream-key relationships:

1. **Vendor fetch** (if `vendor:` configured) — `VendorDeepbook` materialises the sandbox checkout into `.devstack/vendor/deepbook/<ref>/` (services/deepbook/vendor.ts; out of scope here). Folded as `upstream.vendor` (services/pyth/local-deploy.ts:165-170).
2. **`publishMove` (the Pyth Move package)** — The `publish` sibling primitive runs first. Publishes the vendored Pyth Move source via the configured signer; captures `pythStateId` + `wormholeStateId` from objectChanges (services/pyth/local-deploy.ts:123-137). `publishMove` has its own `onChainArtifact` cache, so this becomes a chain-verified cache hit on warm starts.
3. **`onChainArtifact` (the Pyth composite — services/pyth/local-deploy.ts:150-384)** —
   - `inputs` builds `{packageId, feedsHash}` (services/pyth/local-deploy.ts:184-200). Fails with `PythError({phase: 'publish'})` if neither `movePackagePath` nor `vendor` was set.
   - Look up cache key `pyth/package/<chainId>/<contentHash>`.
   - **Cache hit**: run `verify({cached, chain})` (services/pyth/local-deploy.ts:209-220) — every cached `priceInfoObjectId` must resolve on chain AND its type must `moveTypeEquals('<packageId>::price_info::PriceInfoObject')`. On hit, skip `produce`; on miss, fall through to produce.
   - **Cache miss / verify-fail**: run `produce` (services/pyth/local-deploy.ts:226-320). Builds one batched tx with one `pyth::create_price_feeds` call per `feeds[]`. Gas budget `500_000_000n` (services/pyth/local-deploy.ts:255). Signs + executes via the signer's `signAndExecute`. Maps any tx error to `PythError({phase: 'create-feeds'})` (services/pyth/local-deploy.ts:260-268). Picks PriceInfoObject ids out of `objectChanges` by type-suffix match, expecting one per feed (services/pyth/local-deploy.ts:274-292). Fails with `PythError({phase: 'create-feeds'})` if fewer ids than feeds are observed.
   - `register({value})` runs on EVERY cycle (hit AND miss) after the value resolves but before downstream consumers see it (services/pyth/local-deploy.ts:338-383). Mutates `value` to re-attach `findPriceInfo` + `findPriceInfoByLabel`, then writes to `PackageRegistry` + `PythStateRegistry`.
4. **`PythTag` projection layer** — `provide(PythTag, …)` is added to `__layers` so downstream consumers can `yield* PythTag` instead of the per-name composite tag (services/pyth/local-deploy.ts:386-413).
5. **`PythPusher` (when used in the stack)** — Boots after the Pyth composite and the signer resolve (its upstreams; services/pyth/pusher.ts:445). On boot it probes each feed's cache; if any is missing/stale it fires the first tick synchronously (services/pyth/pusher.ts:343-405). The steady-state loop runs as a scoped fiber (`Effect.forkScoped`) on `Schedule.spaced(refreshMs)` (services/pyth/pusher.ts:417).
6. **`pythMid` instances (when used)** — Boot after Pyth + Sui resolve. Best-effort first tick (services/pyth/mid.ts:202); scoped fiber repeats `tickOnce` on `Schedule.spaced(refreshMs)` (services/pyth/mid.ts:203).

### Startup (testnet/mainnet/<fork> path)

1. **`Pyth()` factory chooses `pythKnownPackage`** at construction time (services/pyth.ts:71-79).
2. **`pythKnownPackage` runs once** at acquire time (services/pyth/known-deployment.ts:57-87): reads `knownDeployments`, derives PriceInfoObjects from the coin map (or uses `opts.priceInfoObjects` override), writes a `PythStateRegistry` record, returns the `Pyth` shape.
3. **No publish, no chain tx, no pusher** (downstream tests / examples typically don't compose `PythPusher` on testnet/mainnet because the canonical Pyth is already self-updating).

### Ready criteria

- **Local-deploy `Pyth`**: ready when `onChainArtifact`'s acquire completes — i.e. `inputs` produced, cache hit verified OR `produce` ran successfully, `register` wrote to the registries. There is no explicit external readiness probe; the substrate's "resolve returned" is the gate.
- **`PythPusher`**: ready when the boot-tick decision completes (services/pyth/pusher.ts:343-405). On `anyNeedsRefresh = true`, ready = after the first synchronous batched update tx succeeded + every per-feed cache entry was written. On cache-hit boot, ready = immediately after the probe loop completes (zero tx).
- **`pythMid`**: ready when the first `tickOnce` returns (errors swallowed as log warnings — services/pyth/mid.ts:193-202). Returns the caller-supplied `initial` until the first successful poll updates the Ref.

### Restart behavior

- **All Pyth surfaces are idempotent on warm restart** by design:
  - `pythLocalDeploy`: `onChainArtifact` cache hit + chain verify → no re-publish, no re-create. Cache miss / verify-fail → re-runs `produce` (which is itself idempotent only if the chain has been reset; on a still-alive chain with valid PriceInfoObjects, the verify will pass on the cached entry and the produce will not run).
  - `PythPusher`: per-feed cache + `chain.getObject` verify means a warm boot with intact PriceInfoObjects is a zero-tx no-op (services/pyth/pusher.ts:400-405).
  - `pythKnownPackage`: stateless — pure projection; idempotent by construction.
- **`register` runs on every cycle** (services/pyth/local-deploy.ts:322-383) regardless of cache hit/miss, so `PythStateRegistry` and `PackageRegistry` are always re-populated for the consumer-facing manifest projection.

### Teardown

- **Pusher loop fiber**: `Effect.forkScoped` means the fiber is bound to the scope of its `PythPusher` tag's acquire. On supervisor scope close, the fiber is interrupted (services/pyth/pusher.ts:417). No grace window — the next in-flight `fetchUpdates` is interrupted; an in-flight `signAndExecute` is interrupted (no explicit retry/finalisation).
- **`pythMid` loop fiber**: same — `Effect.forkScoped` bound to the tag's scope (services/pyth/mid.ts:203).
- **No async cleanup** — no temp files, no network sockets to close, no container to stop. Cache entries in `StateStore` persist.
- **What survives**: the `StateStore` `pyth/package/*` and `pyth/pusher/*` keys persist on disk under the configured `StateStoreConfig.path`. The PackageRegistry / PythStateRegistry are in-memory only and are rebuilt next cycle from the cached `Pyth` shape + the `register` step.

## Hard requirements / invariants

### Cross-component invariants (cited to in-tree comments)

- **R8 — Pusher signer must differ from any maker's signer** (services/pyth/pusher.ts:11, 96-97). Convention-enforced (no runtime check). Rationale: shared gas-coin contention would drop pusher updates.
- **D5 — Pyth is typecheck-required by DeepbookMargin** (services/deepbook/margin.ts:12-18, 173 — `pyth: LayeredTag<...PythTag...>` non-optional). Asserted by `services/deepbook/margin-typecheck.test.ts` which spawns `tsc` against a fixture omitting `pyth` and expects a diagnostic.
- **OD5 — `pythMid` requires an explicit `initial: bigint`** (services/pyth/mid.ts:46-47, 49). No auto-poll fallback; the maker pool sees a sane value before the first successful read.
- **RS2 — Verify probes use stable identifiers, never synthesised shapes** (services/pyth/local-deploy.ts:202-208; services/pyth/pusher.ts:51-54). `chain.objectsMatchTypes` and `chain.getObject` operate on the cached objectIds.

### Local-deploy invariants

- **`feeds` must be non-empty** (services/pyth/local-deploy.ts:103-105). Throws synchronously at factory construction.
- **`movePackagePath` and `vendor` are mutually exclusive** (services/pyth/local-deploy.ts:98-102). Throws synchronously at factory construction.
- **At least one of `movePackagePath` / `vendor` must be present** — enforced LAZILY (the factory body constructs successfully even without either, but `onChainArtifact.inputs` fails with `PythError({phase: 'publish'})` at acquire — services/pyth/local-deploy.ts:184-200). The test `pythLocalDeploy vendor option (Bug B regression)` documents this contract (services/pyth/local-deploy.test.ts:124-134).
- **Each `create_price_feeds` Move call expects `(state, i64 price, i32 expo, i64 emaPrice, i32 emaExpo? — actually i64 conf, i64 emaConf, u64 publishTime, vector<u8> feedId, &Clock)`** — encoded as `i64`/`i32` (`magnitude` u64 + `negative` bool) per Move source. The `addPriceInfo` helper in `services/pyth/shared.ts:49-78` encodes this exactly.
- **PriceInfoObject id is matched by Move-type suffix `::price_info::PriceInfoObject`** (services/pyth/shared.ts:101; services/pyth/local-deploy.ts:24-25, 211, 274). The publish + create-feeds tx must create exactly `feeds.length` objects of that type.
- **Cache key includes `feedsHash`** so a different set of requested feeds invalidates the cache (services/pyth/local-deploy.ts:44-56, 184-200).
- **`register` MUST run on every cycle** (services/pyth/local-deploy.ts:322-337). The cached shape is JSON-roundtripped data (no methods); `register` re-attaches the `findPriceInfo` / `findPriceInfoByLabel` closures by mutating `value` in place AND re-publishes to registries.

### Pusher invariants

- **`PriceInfoObject`s must be non-empty** (services/pyth/pusher.ts:193-200). Fails with `PythError({phase: 'pyth'})` at acquire if the Pyth tag carries zero `priceInfos`.
- **First tick is synchronous on cache miss / verify-fail** (services/pyth/pusher.ts:343-405). A bad feed id / unreachable benchmarks URL surfaces as a startup failure rather than a silent loop.
- **First tick is skipped (zero tx) on full cache hit** (services/pyth/pusher.ts:344-350, 400-405). Logged as `'pyth.pusher.boot': 'cache-hit'`.
- **Per-feed cache key folds `(packageId, signer, feedId, priceInfoObjectId)`** so chain regenesis, signer rotation, or PriceInfoObject re-creation invalidates each entry cleanly (services/pyth/pusher.ts:15-21, 296-315).
- **Per-tick batched tx**: every fed feed is updated in ONE `signAndExecute` (services/pyth/pusher.ts:226-271). The "one batched tx" semantic is preserved even across the per-feed cache writes (services/pyth/pusher.ts:285-294 comment).
- **15s `AbortSignal.timeout` per benchmarks fetch** (services/pyth/pusher.ts:128). Hard-coded.
- **Default gas budget 200_000_000n per update tx**, default refresh 10_000ms (services/pyth/pusher.ts:189-191; services/pyth/shared.ts:104).
- **Steady-state loop swallows transient errors** as `Effect.logWarning` (services/pyth/pusher.ts:411-415). The schedule keeps ticking; the per-feed cache is only consulted at supervisor-cycle boot, never per-tick.

### Known-package invariants

- **`packageId` is NOT pinned in `knownDeployments`** (services/pyth/known-deployment.ts:38-44; engine/known-deployments.ts:284-287, 384-387). Only `pythStateId` + `wormholeStateId` are snapshotted. Falls back to `''` when not provided. Treated as `'OPEN QUESTION'` for any meaningful testnet/mainnet use; see Open questions.
- **Per-feed PriceInfoObjects derived from `knownDeployments.deepbook.<network>.coins`** when `priceInfoObjects` is not explicitly passed (services/pyth/known-deployment.ts:46-55). Each coin entry with BOTH `feed: string` AND `priceInfoObjectId: string` is folded in; entries lacking either are silently filtered out.
- **Network must be `'mainnet' | 'testnet'` for any usable derivation** — `devnet` has no coin entries with Pyth fields in the snapshot.

## Failure modes

### Local-deploy failures

| Trigger | Surface | Current behaviour | Recovery |
|---|---|---|---|
| `feeds.length === 0` | `pythLocalDeploy` body | Synchronous `TypeError` at factory construction (services/pyth/local-deploy.ts:103-105). | Caller fixes config. |
| `movePackagePath` + `vendor` both set | `pythLocalDeploy` body | Synchronous `TypeError` (services/pyth/local-deploy.ts:98-102). | Caller fixes config. |
| Neither `movePackagePath` nor `vendor` | `onChainArtifact.inputs` (services/pyth/local-deploy.ts:184-200) | `PythError({phase: 'publish'})` at acquire. | Caller adds one of the two. |
| `publish` sibling fails | upstream resolution | The publish's own error surface (PublishError / `PackageError`). The Pyth composite never reaches `produce`. | Per the publishMove failure path (out of scope here). |
| `pythStateId` not captured from publish | `produce` body | `PythError({phase: 'publish'})` (services/pyth/local-deploy.ts:242-252). | Vendored Pyth Move source must initialize the state object on publish. |
| `signAndExecute` (create-feeds) fails | `produce` body | `PythError({phase: 'create-feeds', cause})` (services/pyth/local-deploy.ts:259-268). | Loop on next supervisor cycle; cache stays empty. |
| `objectChanges` doesn't carry `feeds.length` PriceInfoObjects | `produce` body | `PythError({phase: 'create-feeds'})` (services/pyth/local-deploy.ts:284-293). | Indicates a Move-source / encoding bug; caller investigates. |
| Verify probe fails (cached PriceInfoObject not on chain) | `onChainArtifact.verify` | Returns `undefined`; cache invalidates; `produce` re-runs (services/pyth/local-deploy.ts:209-220). | Automatic re-publish + re-create. |

### Pusher failures

| Trigger | Surface | Current behaviour | Recovery |
|---|---|---|---|
| Zero PriceInfoObjects (`pyth.priceInfos.length === 0`) | `PythPusher` body | `PythError({phase: 'pyth'})` (services/pyth/pusher.ts:193-200). | Caller ensures Pyth tag has feeds. |
| Benchmarks fetch HTTP error (non-2xx) | `fetchBenchmarks` | Wrapped `PythError({phase: 'pusher-fetch'})` (services/pyth/pusher.ts:128-140). | Boot: surfaces as startup failure. Steady-state: logged as warning, retry on next tick. |
| Benchmarks fetch timeout (15s) | `fetchBenchmarks` | Same as above — caught by `AbortSignal.timeout`. | Same. |
| Fixture source error | `fetchUpdates` | Wrapped `PythError({phase: 'pusher-fetch'})` (services/pyth/pusher.ts:210-219). | Same. |
| `signAndExecute` (update) fails | `runUpdateTx` | `PythError({phase: 'pusher-update', cause})` (services/pyth/pusher.ts:260-269). | Boot: startup failure. Steady-state: logged warning, next tick retries. |
| Update for unknown feedId (no PriceInfoObject for that feed) | `runUpdateTx` | `Effect.logWarning` + skip (services/pyth/pusher.ts:233-238). | Manual investigation. |
| No updates returned for any feed | `tickOnceWithDigest` | `Effect.logWarning` + return `undefined` (services/pyth/pusher.ts:325-329). | Retry on next tick. |

### Known-package failures

| Trigger | Surface | Current behaviour | Recovery |
|---|---|---|---|
| `Pyth()` called on `devnet` (or any non-localnet/testnet/mainnet/<fork>) without a known deployment | `Pyth` factory | Synchronous `Error` at construction (services/pyth.ts:72-77). | Caller switches network OR uses `pythKnownPackage({…})` directly. |
| Localnet without `local:` config | `Pyth` factory | Synchronous `Error` (services/pyth.ts:81-85). | Caller adds `local:` block. |
| `knownDeployments.deepbook.<network>` is `undefined` (e.g. devnet) | `pythKnownPackage` body | `pythStateId` / `wormholeStateId` resolve to `undefined`; derived feeds array is empty (services/pyth/known-deployment.ts:34-55). No error. | Will surface downstream as "PythPusher: no PriceInfoObjects to update" or as a deepbook-margin lookup failure. |
| `pythKnownPackage.opts.packageId` not provided | `pythKnownPackage` body | Silently falls back to empty string `''` (services/pyth/known-deployment.ts:44). | See Open questions — this is a real footgun today. |

## Persistence model

### What survives restart (devstack resume)

- **`StateStore: pyth/package/<chainId>/<contentHash>`** — Cached `Pyth` shape minus methods. JSON-roundtrips cleanly (no closures); `register` re-attaches the lookup methods on reload (services/pyth/local-deploy.ts:307-318, 338-348).
- **`StateStore: pyth/pusher/<chainId>/<contentHash>` (one per feed)** — `{lastDigest, lastUpdatedMs, priceInfoObjectId}` (services/pyth/pusher.ts:55-59).
- **No on-disk-paths owned by Pyth** beyond the StateStore.

### What survives snapshot

The snapshot path (`devstack snapshot` / `devstack resume`) packages the full `StateStore` directory plus the Sui chain DB. Both `pyth/package/*` and `pyth/pusher/*` ride along — they're under the same StateStore root.

### What gets wiped on `devstack wipe`

The entire StateStore is wiped. All `pyth/package/*` and `pyth/pusher/*` entries gone. PackageRegistry + PythStateRegistry are in-memory only and rebuild on next cycle from a fresh publish.

### Process-local only

- The `Pyth` value's `findPriceInfo` + `findPriceInfoByLabel` closures.
- The `PythPusher` fiber identity.
- The `pythMid` `Ref<bigint>`.

## Modes & variants

Pyth has TWO modes (driven by `DEVSTACK_NETWORK`), with `pythKnownPackage` being the same code path for `testnet`, `mainnet`, `testnet-fork`, and `mainnet-fork` (forks resolve to their upstream via `resolveDeploymentNetwork()`):

| Lifecycle dimension | localnet (`pythLocalDeploy`) | testnet / mainnet / <network>-fork (`pythKnownPackage`) |
|---|---|---|
| Container | None — host in-process. | None — host in-process. |
| Chain action at startup | Publish vendored Pyth Move package + batched `create_price_feeds` tx (on cache miss / verify-fail). | None. Pure data projection from `knownDeployments`. |
| Pusher | Optional. When composed (e.g. `examples/deepbook-full/devstack.config.ts:126-130`), runs in-process fiber on 10s default cadence. | Not used in tree (canonical Pyth already self-updates on the live chain). Composing one against a real Pyth deployment would still work but is uncommon. |
| Startup sequence | (1) vendor fetch (if `vendor:` set), (2) `publishMove`, (3) `onChainArtifact` produce/verify, (4) `register` → registries, (5) `PythTag` projection. | (1) Read `knownDeployments.deepbook.<network>`, (2) derive feeds from coin entries (or use override), (3) write to `PythStateRegistry`, (4) `provide(PythTag, …)` resolves. |
| Ready criteria | `onChainArtifact.acquire` returned (cache hit verified or produce ran). | `provide(PythTag, …)` resolved (synchronous after construction). |
| Persistence | `pyth/package/<chainId>/<contentHash>` + `pyth/pusher/<chainId>/<contentHash>` per feed in StateStore. PackageRegistry + PythStateRegistry in memory. | `PythStateRegistry` in memory (record name `pyth.<network>`). No StateStore entry. |
| Teardown | Pusher fiber interrupted by scope close. Cache stays on disk. | No teardown — no fibers, no chain state. |
| Failure modes | Publish fail / create-feeds fail / chain regenesis / RPC flake / benchmarks API flake (pusher only). | Misconfigured network / missing `packageId` fallback to `''` / missing `knownDeployments` block silently produces empty feed array. |
| Dependencies | Signer Account + SuiTag + ChainProbe + StateStore + (optional) VendorDeepbook Ref + PackageRegistry + PythStateRegistry. | PythStateRegistry only. (No chain calls; no signer.) |
| Hard requirements | Pusher signer ≠ any maker signer (R8); `feeds` non-empty; `movePackagePath` XOR `vendor`; ad-hoc D5 (deepbook margin typecheck-couples Pyth); verify probes use stable ids (RS2). | Caller must pass `packageId` explicitly for real testnet/mainnet use (fallback to `''` is a footgun); chosen network must be a known one. |

## Test coverage

### `services/pyth/local-deploy.test.ts` (135 LOC)

`describe('pythLocalDeploy tx-builder shape (P1.T1)')`
- `it('builds a single batched tx with N create_price_feeds calls for N feed specs')` (services/pyth/local-deploy.test.ts:13-70) — Asserts that for 3 input specs, the built `Transaction` has 3 `MoveCall` commands, each with `module: 'pyth'` and `function: 'create_price_feeds'`. Uses `t.getData().commands` introspection.

`describe('pythLocalDeploy state-store key shape')`
- `it('uses pyth/package prefix folded with chainId + packageId + feedsHash')` (services/pyth/local-deploy.test.ts:73-77) — Locks the `STATE_KEY_PYTH_PREFIX_INTERNAL` constant at `'pyth/package'`. Regression guard against accidental rename.

`describe('pythLocalDeploy vendor option (Bug B regression)')`
- `it('throws on movePackagePath + vendor mutual exclusion')` (services/pyth/local-deploy.test.ts:97-106) — Synchronous factory-time throw on `/mutually exclusive/`.
- `it('accepts vendor alone (no movePackagePath) without throwing')` (services/pyth/local-deploy.test.ts:108-122) — Vendor-only construction returns a LayeredTag with both `__layer` and `__layers` populated (smoke-checks publish + composite + projection are all present, ≥ 2 layers).
- `it('throws when neither movePackagePath nor vendor is supplied (delegated to runtime)')` (services/pyth/local-deploy.test.ts:124-134) — Locks the "factory constructs successfully, acquire fails" contract — pre-fix this throw was synchronous; post-fix it surfaces from acquire.

### `services/pyth/known-deployment.test.ts` (43 LOC)

`describe('pythKnownPackage (P1.T8)')`
- `it.effect('resolves packageId + per-feed PriceInfoObjects from known testnet deployment')` (services/pyth/known-deployment.test.ts:16-42) — Constructs a `pythKnownPackage({network: 'testnet', packageId: '0xabc', pythStateId: '0xstate', wormholeStateId: '0xwormhole'})`, provides the `EngineLive + NodeFileSystem + PythStateRegistryLive` layer, yields `PythTag`. Asserts: `packageId === '0xabc'`, `pythStateId === '0xstate'`, `wormholeStateId === '0xwormhole'`, `priceInfos.length > 0`, `findPriceInfoByLabel('SUI')` resolves to a `{feedId.startsWith('0x'), priceInfoObjectId.startsWith('0x')}`.

### Adjacent test coverage (not pyth-owned but exercises Pyth surfaces)

- `services/deepbook/margin-typecheck.test.ts` — Spawns `tsc` on `test-setup/fixtures/margin/no-pyth.fixture.ts`; expects the diagnostic to mention pyth or "missing.*propert" / "not assignable" / "argument". Encodes D5 (Pyth typecheck-coupled to DeepbookMargin).
- `services/deepbook/codegen.docker.test.ts:8` — Brings up a stack with Postgres + Sui + Deepbook + Pyth + Indexer + tests the generated codegen against the running stack.
- `services/deepbook/vendor.docker.test.ts:69-87` — Asserts the vendored deepbook Move tree contains a `pyth` subdir + `deepbook_margin/Move.toml` carries `local = "../pyth"` dep.
- `codegen/emitters/deepbook-config.test.ts:128-249` — Seeds PythStateRegistry directly (no factory) and asserts the codegen emits feed/priceInfoObjectId per coin + the `pyth:` block at the bottom of `deepbook-config.ts`.
- `runtime/manifest-emit.test.ts`, `runtime/service.test.ts`, `runtime/extras-consistency.test.ts`, `codegen/emitters/{stack-handle, dapp-kit-config, dapp-kit-config.fork, integration}.test.ts` — All import `PythStateRegistryLive` for layer wiring. These don't write Pyth-specific assertions but they DO require the `PythStateRegistry` to be in the layer roll-up.

(There is no in-tree dedicated unit test for `PythPusher` or `pythMid`. The pusher's behaviour is covered indirectly by the deepbook-margin docker tests + by the fixture loader in `test-setup/fixtures/pyth/bump-timestamp.ts` consumed by those.)

## Pain points today

- **`PythPusher.opts.pyth: any` cast at call sites** — `services/pyth.ts:25-40` re-exports both `pythLocalDeploy` and `pythKnownPackage`; both surface as discriminated-union return types. The downstream `PythPusher.opts.pyth: LayeredTag<…, Pyth, …>` can't narrow against this union, so the canonical example does `pyth: pyth as any` (examples/deepbook-full/devstack.config.ts:124-130). Same shape appears in `services/pyth.ts:88-91`'s `as Parameters<…>[0]` cast. **This is a known artifact** of the discriminated-union approach to localnet-vs-known-package dispatch.
- **`knownDeployments` doesn't carry the Pyth package id** — Only `pythStateId` + `wormholeStateId` are snapshotted (engine/known-deployments.ts:96-99, 284-287, 384-387). `pythKnownPackage` falls back to `packageId: ''` (services/pyth/known-deployment.ts:38-44) which silently propagates an empty string into the `Pyth` value. Callers MUST supply `packageId` explicitly for real testnet/mainnet use — but there's no compile-time enforcement.
- **`StateStoreKeys.pythPackage(input)` doesn't match the actual on-disk key** — `engine/state-store-keys.ts:130-134` defines `pyth/package/<chainId>/<packageId>/<feedsHash>`, but `onChainArtifact` actually folds inputs through `contentHash()` producing `pyth/package/<chainId>/<contentHash(packageId, feedsHash)>` (services/pyth/local-deploy.ts:35-37 comment). The "canonical builder" is dead/stale — likely never called.
- **`PythPusher` per-feed cache via `withCache` directly + ad-hoc `state.put` after batched tx** — The pusher can't use `onChainArtifact`'s "one cache per primitive" because it needs one batched tx across N feeds (services/pyth/pusher.ts:273-294 comment). The current design uses `withCache` with `verify: () => Effect.succeed(undefined)` + `produce: Effect.succeed({…})` to force a re-put after the batched tx — which is functional but reads as a workaround rather than a first-class substrate API.
- **`local-deploy.ts:344-348` in-place mutation of `value` to re-attach lookup methods** — `register` mutates the cached/produced `Pyth` shape via `as unknown as { findPriceInfo: typeof findPriceInfo }`. Documented as matching publishMove's host-local-field-mutation pattern, but it's a clear "we don't have closure-aware persistence" workaround.
- **`pythMid` `Effect.runSync` inside `read()`** — `services/pyth/mid.ts:206-208` runs `Ref.get` synchronously to expose the bigint-returning `read()` callable for `DeepbookMarketMakerPoolSpec.midPrice`. Works because `Ref.get` is pure-ish, but it's a deliberate sync escape hatch.
- **`pythMid.opts.dependsOn`, `PythPusher.opts.dependsOn`, `pythLocalDeploy.opts.dependsOn`** — Three different primitives implement `dependsOn` slightly differently. local-deploy folds via the `upstream` record (services/pyth/local-deploy.ts:145-148); pusher iterates `for (const dep of opts.dependsOn ?? []) yield* dep` (services/pyth/pusher.ts:181-183); pythMid does the same (services/pyth/mid.ts:86-88). The three patterns coexist; no obvious reason for the local-deploy difference beyond "onChainArtifact needs upstreams as a record".
- **`pythMid` is exported from `/advanced` but the in-tree market maker doesn't appear to use it** — The doc-comment in `advanced/index.ts:149-155` says `DeepbookMarketMaker` composes `pythMid` internally for the pyth-mid maker. We didn't find a `pythMid(...)` call site in `services/deepbook/`; the closest is `services/deepbook/margin.ts` consuming `findPriceInfo` directly. (See Open questions.)
- **Pusher's "first-tick is synchronous" boot is gated by a sequential `for` loop over feeds** — One `probeFeedCache` call per feed in `services/pyth/pusher.ts:344-350`. For a stack with many feeds this is serialised; not a hot path today (the canonical stack has 3 feeds) but the pattern doesn't scale.
- **Pusher's `Effect.catch` (services/pyth/pusher.ts:412-414, 422-432) for transient + final error mapping** — Two layers of catch with similar semantics; reads slightly redundant. The outer mapping into `PythError({phase: 'pyth'})` at services/pyth/pusher.ts:423-432 only fires for non-PythError causes; the inner `catchTag('PythError', Effect.fail)` rethrows PythErrors verbatim.

## Open questions

- **OPEN QUESTION**: Is `pythMid` actively consumed anywhere in the codebase? The doc-comment at `advanced/index.ts:149-155` says "the top-level `DeepbookMarketMaker` (which composes `pythMid` internally for the pyth-mid maker)", but grep finds no `pythMid(…)` call site under `services/deepbook/`. If unused, the entire 226-LOC `services/pyth/mid.ts` file may be dead code. (Possible callers in examples? `examples/deepbook-full/devstack.config.ts` was scanned; no `pythMid` usage there.)
- **OPEN QUESTION**: What is the Pyth package id on testnet/mainnet in practice? `knownDeployments` doesn't snapshot it (engine/known-deployments.ts:284-287, 384-387). Production users of `pythKnownPackage` must supply it via `opts.packageId`. Should it be added to the snapshot? It's a known canonical address per network.
- **OPEN QUESTION**: Why are the pusher's `pyth.pythStateId ?? '0x0'` fallbacks in `services/pyth/pusher.ts:244` tolerated? If `pythStateId` is undefined the Move call will fail at chain — better to fail fast at boot. Likely a defensive default that never fires in practice (local-deploy always captures `pythStateId`, known-package always reads it from `knownDeployments`).
- **OPEN QUESTION**: Are the captured testnet/mainnet `priceInfoObjectId` per coin (engine/known-deployments.ts:185-227, 299-338) trustworthy long-term? They're snapshotted on a date; the comment says "verified 2026-05-13 against the sibling ts-sdks checkout". If the upstream Pyth deployment ever re-creates these objects, the snapshot goes stale and `pythKnownPackage` returns stale ids. There's no chain-verify on the known-package path.
- **OPEN QUESTION**: Does the pusher boot's "any-needs-refresh" gate (services/pyth/pusher.ts:343-350) correctly handle the cache-state interface during a `devstack snapshot/resume`? The fiber's `withCache` calls during boot might race with a stale chain state if the snapshot restored a Sui chain that's missing the PriceInfoObjects. Verify should catch this (returns `undefined` if `getObject` doesn't find the id), but it's worth a regression test.
- **OPEN QUESTION**: Should `Pyth()` accept an `override:` knob for plugin authors who want a custom packageId on testnet? The comment at `services/pyth.ts:50-56` explicitly says "the canonical-only `Pyth()` factory intentionally exposes no `override:` surface" and points plugin authors at `pythKnownPackage({…})` on `/advanced`. This is by design but worth re-affirming in the v2 spec.
- **OPEN QUESTION**: Is the `PythPusherSource.kind === 'fixture'` path used outside `test-setup/fixtures/pyth/bump-timestamp.ts` consumers? The fixture path enables hermetic CI — should it be considered a stable API or test-only? The pusher's PythPusherSource type union currently surfaces it as a public option (services/pyth/pusher.ts:65-76).
- **OPEN QUESTION**: Are the `services/pyth/mid.ts` consumers documented at `mid.ts:1-9` ("compatible with `DeepbookMarketMakerPoolSpec.midPrice`") still valid? That maker type may have evolved.

## Opportunities noticed

- **Dead constant `STATE_KEY_PUSHER_PREFIX_INTERNAL`** — Exported at `services/pyth/pusher.ts:449` but no callers found. Same pattern as `STATE_KEY_PYTH_PREFIX_INTERNAL` (which IS used by one test at `services/pyth/local-deploy.test.ts:10, 75`). The pusher's internal-prefix export looks like a copy-paste from local-deploy that no test consumes. Candidate for deletion.
- **Stale `StateStoreKeys.pythPackage` / `pythPusher` builders** — `engine/state-store-keys.ts:130-144` defines key builders whose shapes don't match the actual `onChainArtifact` / `withCache` content-hash-folded keys. If no callers exist (grep shows none directly invoking `StateStoreKeys.pythPackage(...)` or `.pythPusher(...)`), both functions are dead code.
- **`pythMid.ts` (226 LOC) potentially dead** — See Open questions. If `DeepbookMarketMaker` doesn't actually compose `pythMid`, the entire file is candidate for either deletion or for migration to an example-only helper.
- **Three different `dependsOn` patterns** across local-deploy/pusher/mid — Could be unified into one helper that wraps the iteration / upstream-record-folding. The substrate-level `onChainArtifact` already takes `upstream` as a record; pusher/mid could either both adopt the substrate or both stay on the manual `yield*` loop pattern.
- **Pyth feed-id constants duplicated** — `services/pyth/shared.ts:17-22` defines the three canonical feed-ids. `test-setup/fixtures/pyth/feeds.ts:6-10` re-declares them (same values, different export shape). Pick one source of truth and have the other re-export.
- **Pusher comment at services/pyth/pusher.ts:1-21** says "Migrated to the canonical cache substrate per `notes/integration-contract-redesign.md`". If that note is now shipped + fully integrated, the historical-context comment block (21 lines) could shrink to one line.
- **`local-deploy.ts:386-413` PythTag projection layer + 4 lines of `Object.assign(composite, {__layers})`** — The need to manually concat `__layers` and re-export the composite suggests the substrate could grow a "tag-projection layer" helper that automates this. The exact same shape would presumably appear in seal/walrus/sui's tag-projection layers.
- **`pythKnownPackage.opts.packageId ?? ''` fallback** — Should at least log a warning when this happens, not silently return an empty packageId. Possibly should error.
- **`pythLocalDeploy` doesn't surface `pythStateId` / `wormholeStateId` as Pyth-specific captures into the PythError on the "publish didn't capture state" path** — The error message reads "vendored Pyth Move package may not initialize the state object on publish" (services/pyth/local-deploy.ts:246-252). A typed `feed?: undefined, phase: 'publish', expectedType: '<packageId>::state::State'` payload would let the TUI render this more clearly than a string blob.
- **`services/pyth/local-deploy.ts:412` `__layers: [...composite.__layers, tagLayer]`** — Reaches into a private-by-convention `.__layers` field on the substrate's return. Locks the substrate's contract; would benefit from a `composite.withTagProjection(tagLayer)` API.
- **No in-tree pusher test** — `PythPusher` is 449 LOC and exercised only by docker tests. A hermetic unit test against `PythPusherSource.kind === 'fixture'` + a mocked signer would lift the per-feed cache-discipline assertions into the fast tier.
- **`engine/state-store-keys.ts` could be source-of-truth for cache namespaces** — Today the namespace string `'pyth/package'` is duplicated as `STATE_KEY_PYTH_PREFIX` (services/pyth/local-deploy.ts:37) and would be in `state-store-keys.ts` if the builders weren't stale. Migrate the producers to use the central builder constants.
- **No metrics surface** — Pusher's `pyth.pusher.lastDigest` annotation is in span attributes but not lifted to a TUI/observability surface. A "last update Δt" gauge per feed would help operators spot a stuck pusher.
