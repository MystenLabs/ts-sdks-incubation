# deepbook

## Purpose

DeepBook is Mysten Labs's on-chain central-limit order book (CLOB) protocol for the Sui blockchain.
The `deepbook` component in devstack wraps every facet of running a complete DeepBook v3 stack in a
developer environment — publishing the Move package(s), creating whitelisted trading pools,
optionally publishing the margin/liquidation extension, running the Rust indexer that streams
checkpoints into Postgres, running the Rust REST server that surfaces the indexed data, minting test
tokens (DEEP, USDC), and running a long-lived grid market-maker that keeps the books non-empty.
Unlike Sui, Walrus, or Seal, DeepBook is **not** a network primitive: it lives entirely as a set of
Move packages plus two sidecar Rust containers. The devstack `deepbook` component is therefore a
_compound_ — multiple Move publications, multiple Docker services, and several state registries, all
of which need to be wired together and to outside services (Sui, Postgres, Pyth) such that local-dev
workflows can `pnpm dev → snapshot → wipe → restore` without losing on-chain identity or REST state.
It is the largest non-Sui component in devstack and the second-most-complex overall.

## Current implementation

### Public entry & shared interface tags

| File                            | LOC | Summary                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/deepbook.ts`          | 336 | Top-level `Deepbook(opts)` factory + `DeepbookCoreTag`/`DeepbookAdminTag`/`DeepbookMarketMakerTag` Context.Service tags; routes to local-deploy on localnet, known-package on testnet/mainnet/forks; re-exports `DeepbookMarketMaker`/`DeepbookMintDEEP`/`DeepbookMintUSDC`/`VendorDeepbook`/`DeepbookIndexer`/`DeepbookServer`/`DeepbookMargin(.seed)` action factories. |
| `services/deepbook/index.ts`    | 80  | Barrel: re-exports every implementation module's typed public surface.                                                                                                                                                                                                                                                                                                    |
| `services/deepbook/internal.ts` | 267 | Shared constants (clock id, coin-registry id, type-name suffixes, post-only constants, predeposit multiplier), `DeepbookCoinRef`/`AnyCoinTag`/`DeepbookPoolSpec`/`DeepbookPool` types, `resolveCoinRef`/`makeFindPool`/`alignToTickSize`/`alignToLotSize`/`calculateGridLevels`/`depositPreDeposits` helpers.                                                             |

### Core deployment factories

| File                                    | LOC | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/deepbook/local-deploy.ts`     | 866 | `deepbookLocalDeploy(opts)` — publishes vendored deepbook-v3 Move package via `publishMove`, runs batched `init_balance_manager_map` + N `pool::create_pool_admin` create-pools tx, caches result via `onChainArtifact` substrate (cache key `deepbook/pools/<chainId>/<contentHash({packageId,signer,poolsHash})>`), verifies cached pool object ids on resume via `ChainProbe.objectsMatchTypes`, mints lazy BalanceManager for `DeepbookMarketMakerTag` consumers, registers into `PackageRegistry` + `DeepbookStateRegistry`. Provides all three interface tags. |
| `services/deepbook/known-deployment.ts` | 116 | `deepbookKnownPackage(opts)` — points `DeepbookCoreTag` at a canonical testnet/mainnet (or explicit `packageId`/`registryId`) without owning the admin cap. Reads from `knownDeployments.deepbook[network]`. Does not provide `DeepbookAdminTag` or `DeepbookMarketMakerTag`.                                                                                                                                                                                                                                                                                        |
| `services/deepbook/vendor.ts`           | 308 | `vendorDeepbook(opts?)` — clones `MystenLabs/deepbookv3` + `MystenLabs/deepbook-sandbox` via `gitFetch` siblings, materialises six packages (`token`, `deepbook`, `deepbook_margin`, `margin_liquidation`, `pyth`, `usdc`) into `.devstack/vendor/deepbook/<ref>/<pkg>/`, patches each `Move.toml` to rewrite git deps to local sibling paths.                                                                                                                                                                                                                       |
| `services/deepbook/images.ts`           | 65  | `DEEPBOOK_IMAGES` arch-keyed (`amd64`/`arm64`) image-pair table (one indexer image, one server image per Move version) + `getDeepbookImages(moveVersion, arch)` + `DEFAULT_DEEPBOOK_MOVE_VERSION = 'v7.0.0'`.                                                                                                                                                                                                                                                                                                                                                        |

### Containerised sidecars

| File                           | LOC | Summary                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------ | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/deepbook/indexer.ts` | 264 | `DeepbookIndexer(opts)` — Rust container reading Sui checkpoints, writing DeepBook events to Postgres. Joins Postgres container network for `DATABASE_URL`. Exposes Prometheus `/metrics` via traefik (`deepbook-indexer-metrics` entrypoint, port 9184 in-container). `DeepbookIndexerTag` Context.Service. Registers into `DeepbookIndexerStateRegistry`.                     |
| `services/deepbook/server.ts`  | 316 | `DeepbookServer(opts)` — Rust container serving DeepBook REST API on `:9008` + Prometheus `/metrics` on `:9184` in-container. Reads from same Postgres the indexer writes to + chain RPC via `host.docker.internal:9000`. Two traefik routes (`deepbook-server`, `deepbook-server-metrics`). `DeepbookServerTag` Context.Service. Registers into `DeepbookServerStateRegistry`. |

### Margin extension

| File                               | LOC | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/deepbook/margin.ts`      | 569 | `deepbookMargin(opts)` — publishes `deepbook_margin` + `margin_liquidation` Move packages, mints `MaintainerCap`, creates one `MarginPool<T>` per configured asset (USDC/SUI/etc.), registers each existing DeepBook pool against `MarginRegistry` via `register_deepbook_pool` + `enable_deepbook_pool`. Pyth is non-optional in the option type (D5 — type-level enforcement of Pyth+margin coupling). Caches result via `onChainArtifact` at `deepbook/margin-pools/...`. Provides `DeepbookMarginTag`. |
| `services/deepbook/margin-seed.ts` | 187 | `deepbookMarginSeed(opts)` — mints `SupplierCap` and supplies seed liquidity to each margin pool. Cached at `deepbook/margin-seed/...`. Verify probe checks SupplierCap still exists AND objectType endsWith `::margin_pool::SupplierCap`.                                                                                                                                                                                                                                                                 |

### Sugar / action factories

| File                                | LOC | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/deepbook/mint.ts`         | 104 | `DeepbookMintDEEP(opts)` reads `captured.deepTreasuryId` off the deepbook tag, derives `<packageId>::deep::DEEP` coin type, calls `mintFromTreasury`. `DeepbookMintUSDC(opts)` wraps `mintFromTreasury` with a caller-supplied USDC TreasuryCap.                                                                                                                                                                                                                                                                                                                    |
| `services/deepbook/market-maker.ts` | 604 | `deepbookMarketMaker(opts)` — long-running grid maker (`bps` strategy) that forks an `Effect.repeat(Schedule.spaced)` fiber. Consumes `DeepbookCoreTag` (so it composes against either local-deploy or known-package). Per-pool BalanceManager id cached at `deepbook/market-maker/balance-manager/<chainId>/<packageId>/<signer>/<poolName>` with `ChainProbe.getObject`-based verify (existence + `owner.address === signer.address`). Split cancel-then-place transactions per tick. Recovers from `EBalanceManagerBalanceTooLow` abort code 3 by recreating BM. |

### Tests in scope

| File                                           | LOC | Summary                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/deepbook.test.ts`                    | 723 | L1 unit + StateStore-touching cache tests for `deepbookKnownPackage` (provides core, not admin) and `deepbookLocalDeploy` (cache-hit skips publish + create-pools; stale-pool verification invalidates cache). Also pins SDK-shape type compat for `DeepbookCore['packageIds']` and exports `computeDeepbookPoolsInputsHash` for sibling test fixtures. |
| `services/deepbook.fork-known.docker.test.ts`  | 28  | Phase-3 P3.T2 docker test scaffold: `Deepbook()` on testnet-fork composes to `deepbookKnownPackage(testnet)`. Body pending.                                                                                                                                                                                                                             |
| `services/deepbook/codegen.docker.test.ts`     | 35  | L3 scaffold for `DeepbookConfigEmitter`; folded into Phase-5 integration sweep.                                                                                                                                                                                                                                                                         |
| `services/deepbook/margin-seed.docker.test.ts` | 19  | L3 scaffold for `deepbookMarginSeed`.                                                                                                                                                                                                                                                                                                                   |
| `services/deepbook/margin-typecheck.test.ts`   | 90  | Spawns dedicated `tsc --noEmit` against `test-setup/fixtures/margin/no-pyth.fixture.ts`; asserts the typechecker rejects margin configs that omit `pyth`.                                                                                                                                                                                               |
| `services/deepbook/margin.docker.test.ts`      | 48  | L3 scaffold for margin docker behaviour (publish, per-asset pools, seed, idempotent re-apply, snapshot/restore, indexer pickup).                                                                                                                                                                                                                        |
| `services/deepbook/margin.test.ts`             | 150 | L1 unit tests for `deepbookMargin` and `deepbookMarginSeed` factory shape, mutual-exclusion validation, duplicate-label validation, default constants.                                                                                                                                                                                                  |
| `services/deepbook/market-maker.test.ts`       | 469 | L1 unit tests for `calculateGridLevels` bps math, state-store key shape, **Bug A** regression (split cancel/place), and **place-tx BalanceTooLow** recreate path.                                                                                                                                                                                       |
| `services/deepbook/server.docker.test.ts`      | 42  | L3 scaffolds for REST `/ticker`, snapshot/restore stability, concurrent-stack port allocation.                                                                                                                                                                                                                                                          |
| `services/deepbook/server.test.ts`             | 58  | L1 unit tests for `DeepbookServer` factory shape, default `name`, optional margin Ref.                                                                                                                                                                                                                                                                  |
| `services/deepbook/vendor.docker.test.ts`      | 101 | L3 docker test (gated `DEVSTACK_INTEGRATION_TESTS=1` + `DOCKER_OK`): clones both repos, materialises all six packages, asserts `Move.toml` rewrites for `deepbook_margin` declare `local = "../token"`, `local = "../deepbook"`, `local = "../pyth"`.                                                                                                   |
| `engine/snapshot-deepbook.docker.test.ts`      | 50  | L4 scaffold for full deepbook+snapshot regression (Phase 5 integration sweep). All `it.todo`.                                                                                                                                                                                                                                                           |

### Cross-component pieces consumed (NOT exhaustively redocumented; cited here so the reader has a map)

- `engine/registries.ts:77-164,270-298,350-378` — the four state-record interfaces
  (`DeepbookStateRecord`, `DeepbookIndexerStateRecord`, `DeepbookServerStateRecord`,
  `DeepbookMarginStateRecord`) plus their `Context.Service` tags and `defineRegistry` publish/Live
  triples.
- `engine/known-deployments.ts:67-124,166-391` — `DeepbookCoinEntry` / `DeepbookPoolEntry` /
  `DeepbookMarginPoolEntry` / `DeepbookPythConfig` / `DeepbookDeployment` types and the inlined
  testnet/mainnet snapshots.
- `engine/errors.ts:343-360,388-412` — `DeepbookError` (margin-aware fields
  `pool`/`marginAsset`/`feed`), `DeepbookIndexerError`, `DeepbookServerError`.
- `engine/phases.ts:93-105,126-146` — `DeepbookPhases`, `DeepbookIndexerPhases`,
  `DeepbookServerPhases` literal sets.
- `engine/docker/router.ts:197-207` — three traefik entrypoints registered at module load:
  `deepbook-indexer-metrics` (9184), `deepbook-server` (9008), `deepbook-server-metrics` (9186).

### LOC totals

- Src (deepbook-specific files only, excluding tests): **3,532** lines across 14 files.
- Tests (in scope, including snapshot-deepbook): **1,813** lines across 11 files.
- **Engine slices consumed by deepbook** (not counted above): registry slice ~70 LOC,
  known-deployments slice ~200 LOC, errors slice ~50 LOC, phases slice ~25 LOC, router slice ~10
  LOC.

## Configuration

### `Deepbook(opts)` (top-level facade — `services/deepbook.ts:241-259`)

| Knob    | Type                                            | Default      | Read at                        | Notes                                                                                                                                                                                                                                                                                      |
| ------- | ----------------------------------------------- | ------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `local` | `Record<string, unknown>` (opaque pass-through) | `undefined`  | `services/deepbook.ts:255`     | Only consumed on localnet. Spread as the options bag into `deepbookLocalDeploy`. Plugin authors who need a private known-package deployment must reach for `deepbookKnownPackage` from `/advanced` directly — the canonical `Deepbook()` facade has no `override:` surface (Wave-3 §10.3). |
| `name`  | `string`                                        | `'deepbook'` | `services/deepbook.ts:254-256` | Override tag name. Forwarded into both `deepbookLocalDeploy` and (effectively) the cached state's identity.                                                                                                                                                                                |

The network choice itself comes from `resolveNetwork()` (`services/deepbook.ts:242`, reading
`DEVSTACK_NETWORK` env var / CLI flag). `resolveDeploymentNetwork(network)` collapses `*-fork`
variants to the wrapped upstream (`services/deepbook.ts:249`, `engine/known-deployments.ts:58-65`).

### `deepbookLocalDeploy(opts)` (`services/deepbook/local-deploy.ts:129-149`)

| Knob              | Type                                | Default      | Read at                       | Notes                                                                                                                      |
| ----------------- | ----------------------------------- | ------------ | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `name`            | `string` (const)                    | `'deepbook'` | `local-deploy.ts:239`         | Used as the tag name + registry name + cache-display title.                                                                |
| `signer`          | `LayeredTag<…, Account>`            | required     | `local-deploy.ts:134`         | Account that publishes the package and creates pools.                                                                      |
| `movePackagePath` | `string`                            | `undefined`  | `local-deploy.ts:143-149`     | Literal filesystem path to vendored deepbook-v3 source. Mutually exclusive with `vendor`.                                  |
| `vendor`          | `LayeredTag<…, {deepbook: string}>` | `undefined`  | `local-deploy.ts:146`         | Tag yielded inside the publish path Effect; its `.deepbook` field provides the path. Typically from `vendorDeepbook(...)`. |
| `pools`           | `ReadonlyArray<DeepbookPoolSpec>`   | `[]`         | `local-deploy.ts:147,240`     | Each spec: `{name, base, quote, tickSize, lotSize, minSize, whitelisted?, stable?}`.                                       |
| `dependsOn`       | `ReadonlyArray<LayeredTag>`         | `[]`         | `local-deploy.ts:148,345-348` | Each lifted into upstream record as `dep_<i>` keys.                                                                        |

Validation at factory time (throws `TypeError`):

- `movePackagePath` and `vendor` mutually exclusive (`local-deploy.ts:242-246`).
- Pool `name` must be non-empty (`local-deploy.ts:258-260`).
- Pool `name` must be unique across array (`local-deploy.ts:261-265`).
- `tickSize > 0`, `lotSize > 0`, `minSize >= lotSize` (`local-deploy.ts:267-281`).

Pool-spec defaults inside body: `whitelisted ?? true` (`local-deploy.ts:441,547`), `stable ?? false`
(`local-deploy.ts:442,548`).

### `deepbookKnownPackage(opts)` (`services/deepbook/known-deployment.ts:17-27`)

| Knob         | Type                                                 | Default     | Read at                        | Notes                                                                                                 |
| ------------ | ---------------------------------------------------- | ----------- | ------------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------ | -------------------------------------------- |
| `network`    | `KnownNetwork` (`'testnet'                           | 'mainnet'   | 'devnet'`)                     | `undefined`                                                                                           | `known-deployment.ts:38` | Lookup key into `knownDeployments.deepbook`. |
| `packageId`  | `string`                                             | `undefined` | `known-deployment.ts:39`       | Explicit override; bypasses registry lookup.                                                          |
| `registryId` | `string`                                             | `undefined` | `known-deployment.ts:40`       | Explicit override.                                                                                    |
| `pools`      | `ReadonlyArray<{name, poolId, baseType, quoteType}>` | `[]`        | `known-deployment.ts:21-26,63` | Caller-supplied pool table (registry's `pools` map is _not_ used; consumer is expected to enumerate). |

Throws at factory time if no `packageId`/`registryId` can be resolved (`known-deployment.ts:42-48`).

### `vendorDeepbook(opts?)` (`services/deepbook/vendor.ts:68-89`)

| Knob           | Type                        | Default                                                       | Read at             | Notes                                                                  |
| -------------- | --------------------------- | ------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------- |
| `name`         | `string`                    | `'vendorDeepbook'`                                            | `vendor.ts:168`     | Tag name prefix; siblings get `${name}.deepbook` / `${name}.sandbox`.  |
| `ref`          | `string`                    | `'main'`                                                      | `vendor.ts:169`     | Git ref for the deepbook repo.                                         |
| `sandboxRef`   | `string`                    | `'main'`                                                      | `vendor.ts:170`     | Independent — sandbox is on `v0.x` while deepbookv3 is on `v7.x+`.     |
| `deepbookRepo` | `string`                    | `'https://github.com/MystenLabs/deepbookv3'`                  | `vendor.ts:52,171`  | Upstream renamed from `MystenLabs/deepbook` → `MystenLabs/deepbookv3`. |
| `sandboxRepo`  | `string`                    | `'https://github.com/MystenLabs/deepbook-sandbox'`            | `vendor.ts:53,172`  |                                                                        |
| `outDir`       | `string`                    | `${DEVSTACK_STATE_DIR ?? '.devstack'}/vendor/deepbook/<ref>/` | `vendor.ts:199-200` |                                                                        |
| `dependsOn`    | `ReadonlyArray<LayeredTag>` | `[]`                                                          | `vendor.ts:88`      |                                                                        |

Env: `DEVSTACK_STATE_DIR` (`vendor.ts:199`) — falls back to `.devstack`.

### `DeepbookIndexer(opts)` (`services/deepbook/indexer.ts:50-75`)

| Knob                   | Type                            | Default                                      | Read at               | Notes                                                                                                                  |
| ---------------------- | ------------------------------- | -------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `name`                 | `string` (const)                | `'deepbook-indexer'`                         | `indexer.ts:82`       |                                                                                                                        |
| `postgres`             | `LayeredTag<…, Postgres>`       | required                                     | `indexer.ts:52`       | Indexer joins this container's network for `DATABASE_URL`.                                                             |
| `sui`                  | `LayeredTag<…, Sui>`            | required                                     | `indexer.ts:53`       | Held only for layer-build edge ordering today; checkpoint volume not yet wired (see comments at `indexer.ts:117-123`). |
| `deepbook`             | `LayeredTag<…, DeepbookCore>`   | required                                     | `indexer.ts:54`       | Provides `packageId` for `DEEPBOOK_PACKAGE_ID` env.                                                                    |
| `margin`               | `LayeredTag<…, DeepbookMargin>` | `undefined`                                  | `indexer.ts:60`       | When set: `MARGIN_PACKAGES=<packageId>,<liquidationPackageId>` env (`indexer.ts:131-133`).                             |
| `moveVersion`          | `string`                        | `'v7.0.0'` (`DEFAULT_DEEPBOOK_MOVE_VERSION`) | `indexer.ts:62-63,83` | Resolves to image pair via `getDeepbookImages`.                                                                        |
| `image`                | `string`                        | `getDeepbookImages(moveVersion).indexer`     | `indexer.ts:65,86`    | Manual override.                                                                                                       |
| `firstCheckpoint`      | `number`                        | `0`                                          | `indexer.ts:66,113`   | `FIRST_CHECKPOINT` env.                                                                                                |
| `databaseName`         | `string`                        | `'deepbook'`                                 | `indexer.ts:67,84`    | Logical DB inside Postgres; passed to `postgres.url(databaseName)`.                                                    |
| `dbConnectionPoolSize` | `number`                        | `10`                                         | `indexer.ts:70,115`   | `DB_CONNECTION_POOL_SIZE` env.                                                                                         |
| `rustLog`              | `string`                        | `'info'`                                     | `indexer.ts:72,114`   | `RUST_LOG` env.                                                                                                        |
| `dependsOn`            | `ReadonlyArray<LayeredTag>`     | `[]`                                         | `indexer.ts:74,91-93` |                                                                                                                        |

### `DeepbookServer(opts)` (`services/deepbook/server.ts:77-100`)

| Knob                   | Type                            | Default                                 | Read at                | Notes                                                                                             |
| ---------------------- | ------------------------------- | --------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------- |
| `name`                 | `string` (const)                | `'deepbook-server'`                     | `server.ts:107`        |                                                                                                   |
| `postgres`             | `LayeredTag<…, Postgres>`       | required                                | `server.ts:79`         |                                                                                                   |
| `sui`                  | `LayeredTag<…, Sui>`            | required                                | `server.ts:80`         | Held for layer ordering only; server reads RPC via `host.docker.internal:9000` (`server.ts:144`). |
| `deepbook`             | `LayeredTag<…, DeepbookCore>`   | required                                | `server.ts:81`         | Supplies `DEEPBOOK_PACKAGE_ID`, `DEEP_TREASURY_ID`, `DEEP_TOKEN_PACKAGE_ID`.                      |
| `margin`               | `LayeredTag<…, MarginRefShape>` | `undefined`                             | `server.ts:85`         | When set: `MARGIN_PACKAGE_ID` env (`server.ts:159-161`).                                          |
| `moveVersion`          | `string`                        | `'v7.0.0'`                              | `server.ts:88,108`     |                                                                                                   |
| `image`                | `string`                        | `getDeepbookImages(moveVersion).server` | `server.ts:90,112`     |                                                                                                   |
| `dbStatementTimeoutMs` | `number`                        | `60_000`                                | `server.ts:49,92,110`  | `--db-statement-timeout-ms` CLI arg.                                                              |
| `databaseName`         | `string`                        | `'deepbook'`                            | `server.ts:96,109`     | Must match indexer's.                                                                             |
| `rustLog`              | `string`                        | `'info'`                                | `server.ts:98,148`     | `RUST_LOG` env.                                                                                   |
| `dependsOn`            | `ReadonlyArray<LayeredTag>`     | `[]`                                    | `server.ts:99,117-119` |                                                                                                   |

### `deepbookMargin(opts)` (`services/deepbook/margin.ts:162-179`)

| Knob                          | Type                                            | Default                                 | Read at                 | Notes                                                                                                                                                                                                                                                                                                                           |
| ----------------------------- | ----------------------------------------------- | --------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                        | `string` (const)                                | `'deepbook-margin'`                     | `margin.ts:187`         |                                                                                                                                                                                                                                                                                                                                 |
| `signer`                      | `LayeredTag<…, Account>`                        | required                                | `margin.ts:164`         |                                                                                                                                                                                                                                                                                                                                 |
| `margin.movePackagePath`      | `string`                                        | `undefined`                             | `margin.ts:166,189-191` | Mutually exclusive with `margin.vendor`. **At least one is required** (factory-time check; `inputs` body re-asserts at acquire time, `margin.ts:254-261`).                                                                                                                                                                      |
| `margin.vendor`               | `LayeredTag<…, {deepbook_margin: string}>`      | `undefined`                             | `margin.ts:167,189`     | OPEN QUESTION: comment at `margin.ts:258` says "vendor-runtime flow is deferred" — the code references the field but the `inputs` body still fails when `marginPublish === undefined`. So `margin.vendor` currently only takes effect via the `publishMove` path; the `inputs` failure path is reached if neither was supplied. |
| `liquidation.movePackagePath` | `string`                                        | `undefined`                             | `margin.ts:170,192-194` | Mutually exclusive with `liquidation.vendor`. **Required for actual publish** (`margin.ts:294-302`).                                                                                                                                                                                                                            |
| `liquidation.vendor`          | `LayeredTag<…, {margin_liquidation: string}>`   | `undefined`                             | `margin.ts:171,192`     |                                                                                                                                                                                                                                                                                                                                 |
| `pyth`                        | `LayeredTag<…, Pyth>`                           | required (D5 — type-level non-optional) | `margin.ts:173`         | Enforced by typechecker — see `margin-typecheck.test.ts`.                                                                                                                                                                                                                                                                       |
| `deepbook`                    | `LayeredTag<…, DeepbookCore>`                   | required                                | `margin.ts:174`         |                                                                                                                                                                                                                                                                                                                                 |
| `assets`                      | `ReadonlyArray<DeepbookMarginAssetConfig>`      | required                                | `margin.ts:175`         | One entry per margin asset; duplicate `label` rejected (`margin.ts:195-201`).                                                                                                                                                                                                                                                   |
| `pools`                       | `ReadonlyArray<DeepbookMarginPoolRegistration>` | required (may be `[]`)                  | `margin.ts:176`         | DeepBook pool names to register against margin.                                                                                                                                                                                                                                                                                 |
| `maxAgeSeconds`               | `bigint`                                        | `70n` (`DEFAULT_MAX_AGE_SECONDS`)       | `margin.ts:53,177,188`  | Maximum age for Pyth price observations.                                                                                                                                                                                                                                                                                        |
| `dependsOn`                   | `ReadonlyArray<LayeredTag>`                     | `[]`                                    | `margin.ts:178,227,230` |                                                                                                                                                                                                                                                                                                                                 |

`DeepbookMarginAssetConfig` is the heavy struct (`margin.ts:55-73`): `label`, `coinType` (string or
tag), `scalar` (e.g. 1_000_000 for 6dp coins), `feed` (Pyth feed id hex), `maxConfBps`,
`maxEwmaDifferenceBps`, `supplyCap`, `maxUtilizationRate`, `referralSpread`, `minBorrow`,
`rateLimitCapacity`, `rateLimitRefillRatePerMs`, `rateLimitEnabled`, `baseRate`, `baseSlope`,
`optimalUtilization`, `excessSlope`. The exported `USDC_MARGIN_DEFAULTS` (`margin.ts:80-97`) and
`SUI_MARGIN_DEFAULTS` (`margin.ts:99-116`) provide all fields except `coinType`.

`DeepbookMarginPoolRegistration` (`margin.ts:136-139`):
`{pool: string, risk?: DeepbookMarginPoolRiskConfig}`. The default risk config
(`DEFAULT_POOL_RISK_CONFIG`, `margin.ts:127-134`) is
`{minWithdrawRiskRatio: 2, minBorrowRiskRatio: 1.2499, liquidationRiskRatio: 1.1, targetLiquidationRiskRatio: 1.25, userLiquidationReward: 0.02, poolLiquidationReward: 0.03}`.

### `deepbookMarginSeed(opts)` (`services/deepbook/margin-seed.ts:38-44`)

| Knob        | Type                                     | Default                  | Read at                   | Notes                                                                                                 |
| ----------- | ---------------------------------------- | ------------------------ | ------------------------- | ----------------------------------------------------------------------------------------------------- |
| `name`      | `string` (const)                         | `'deepbook-margin-seed'` | `margin-seed.ts:55`       |                                                                                                       |
| `signer`    | `LayeredTag<…, Account>`                 | required                 | `margin-seed.ts:40`       |                                                                                                       |
| `margin`    | `LayeredTag<…, DeepbookMargin>`          | required                 | `margin-seed.ts:41`       |                                                                                                       |
| `amounts`   | `ReadonlyArray<{label, amount: bigint}>` | required                 | `margin-seed.ts:42`       | Duplicate `label` rejected (`margin-seed.ts:56-61`); `amount > 0n` enforced (`margin-seed.ts:62-65`). |
| `dependsOn` | `ReadonlyArray<LayeredTag>`              | `[]`                     | `margin-seed.ts:43,66-68` |                                                                                                       |

### `deepbookMarketMaker(opts)` (`services/deepbook/market-maker.ts:111-121`)

| Knob        | Type                                                                                   | Default               | Read at                         | Notes                                                                                   |
| ----------- | -------------------------------------------------------------------------------------- | --------------------- | ------------------------------- | --------------------------------------------------------------------------------------- |
| `name`      | `string` (const)                                                                       | required (no default) | `market-maker.ts:112`           |                                                                                         |
| `signer`    | `LayeredTag<…, Account>`                                                               | required              | `market-maker.ts:113`           |                                                                                         |
| `pools`     | `ReadonlyArray<DeepbookMarketMakerPoolSpec>`                                           | required, non-empty   | `market-maker.ts:114,145-152`   |                                                                                         |
| `strategy`  | `DeepbookMarketMakerStrategy` (`{kind: 'bps', levels?, spreadBps?, levelSpacingBps?}`) | required              | `market-maker.ts:62-70,117,142` | Default `levels=30`, `spreadBps=10`, `levelSpacingBps=100` (`market-maker.ts:249-251`). |
| `refreshMs` | `number`                                                                               | `10_000`              | `market-maker.ts:119,143`       |                                                                                         |
| `dependsOn` | `ReadonlyArray<LayeredTag>`                                                            | `[]`                  | `market-maker.ts:120,134-136`   |                                                                                         |

`DeepbookMarketMakerPoolSpec` (`market-maker.ts:72-102`):
`{name, base, quote, tickSize, midPrice: bigint|()=>bigint, sizePerLevel: bigint|()=>bigint, preDeposit?, lotSize?}`.
Function-form `midPrice`/`sizePerLevel` are re-evaluated each tick; `lotSize` defaults to `1n`
inside body.

### Routing entrypoints (registered at module load, `engine/docker/router.ts:197-207`)

| Entrypoint name            | Host port | Notes                                                                          |
| -------------------------- | --------- | ------------------------------------------------------------------------------ |
| `deepbook-indexer-metrics` | 9184      | Prometheus scrape for the indexer container.                                   |
| `deepbook-server`          | 9008      | REST API (`/`, `/ticker`, etc.).                                               |
| `deepbook-server-metrics`  | 9186      | Prometheus scrape for the server. Picked 9186 because 9185 is owned by walrus. |

### Env vars (project-level)

- `DEVSTACK_NETWORK` — drives `resolveNetwork()` (`services/deepbook.ts:242`).
- `DEVSTACK_STATE_DIR` — drives `vendorDeepbook` output dir (`services/deepbook/vendor.ts:199`).
- `DEVSTACK_INTEGRATION_TESTS` + `DOCKER_OK` — gate the L3 + L4 docker tests
  (`services/deepbook/*.docker.test.ts`, `engine/snapshot-deepbook.docker.test.ts`).
- `RUN_FORK_DOCKER_TESTS=1` — gates `services/deepbook.fork-known.docker.test.ts:18`.

## Capabilities CONSUMED

### Other devstack services (by capability, not name)

- **Signer / Account** (`Account` from `engine/shared.ts`) — local-deploy (`local-deploy.ts:134`),
  margin (`margin.ts:164`), margin-seed (`margin-seed.ts:40`), market-maker (`market-maker.ts:113`),
  indexer & server inherit through their `deepbook` ref. Used for `signAndExecute`, owning
  balance/maintainer/supplier caps, transferring objects. Devstack accounts come from the
  wallet/accounts component.
- **Sui RPC + chainId** (`SuiTag`, `services/sui.ts`) — local-deploy reads `chainId` via the
  `onChainArtifact` substrate (`local-deploy.ts:60-66`); market-maker yields `SuiTag` directly to
  derive the cache base key (`market-maker.ts:137,183`); server uses `host.docker.internal:9000` to
  dial the localnet RPC from inside its container (`server.ts:144`); indexer holds the `sui` Ref
  purely for the layer-build dep edge today but expects a future checkpoint-volume wiring
  (`indexer.ts:135-136`, comment at 117-123).
- **Postgres** (`Postgres`, `services/postgres.ts`) — both indexer and server consume
  `postgres.url(databaseName)` for `DATABASE_URL` (`indexer.ts:103,109`, `server.ts:129,143`) and
  join `postgres.containerNetworks[0]` so they can resolve the alias without a host port
  (`indexer.ts:107`, `server.ts:133`). The default database name is `'deepbook'`.
- **Pyth** (`Pyth`, `services/pyth/index.ts`) — margin extension consumes the Pyth ref
  non-optionally (`margin.ts:173`), uses `pyth.findPriceInfo(feedId)` to validate each margin
  asset's feed is known to the configured Pyth deployment (`margin.ts:323-333`), and reads each
  asset's feed config to construct the on-chain `PythConfig` Move object. **Pyth+margin coupling is
  type-enforced (D5).**
- **DeepbookCore** (the interface tag the local-deploy / known-package factories produce) — consumed
  by margin (`margin.ts:174`), market-maker (`market-maker.ts:139`), indexer (`indexer.ts:54`),
  server (`server.ts:81`). Drives package ids, registry id, pool lookups.
- **`DeepbookMargin` interface** — consumed by margin-seed (`margin-seed.ts:41`), optionally by
  indexer for `MARGIN_PACKAGES` env (`indexer.ts:60,131-133`) and by server for `MARGIN_PACKAGE_ID`
  env (`server.ts:85,159-161`).

### Engine resources

- **State-store** (`StateStore`, `engine/state-store.ts`) — local-deploy via `onChainArtifact`
  namespace `deepbook/pools` (`local-deploy.ts:66`); margin via namespace `deepbook/margin-pools`
  (`margin.ts:250`); margin-seed via namespace `deepbook/margin-seed` (`margin-seed.ts:81`);
  market-maker via prefix `deepbook/market-maker/balance-manager` directly (`market-maker.ts:52`).
- **`onChainArtifact` substrate** (`engine/on-chain-artifact.ts`) — local-deploy, margin,
  margin-seed all use it. Provides cache-key derivation (`chainId` + `inputsHash` folded into the
  namespace), `inputs`/`verify`/`produce`/`register` lifecycle, automatic ChainProbe wiring
  (`local-deploy.ts:31,366`, `margin.ts:36,232`, `margin-seed.ts:25,70`).
- **`ChainProbe`** (`engine/chain-probe.ts`) — typed Schema-validated SDK accessor used by verify
  probes (`local-deploy.ts:469-478`, `margin.ts:282-291`, `margin-seed.ts:92-99`,
  `market-maker.ts:196-201`). Replaced the pre-Phase-C
  `client.core.getObject … as unknown as { objectType? }` cast pattern that silently masked SDK
  shape drift (B1/B3/B5).
- **`Identity`** (`engine/identity.ts`) — indexer (`indexer.ts:94`) and server (`server.ts:120`)
  read it for `identity.stack` (slug source) and the routing hostname.
- **`publishPackage`** publish helper (`engine/registries.ts:309`) — local-deploy's `register` step
  calls it twice with name and captured shape (`local-deploy.ts:664-675`); margin calls it for both
  margin and liquidation packages (`margin.ts:535-546`).
- **`publishDeepbookState`** (`engine/registries.ts:350-353`) — local-deploy + known-deployment both
  publish (`local-deploy.ts:677-687`, `known-deployment.ts:90-100`).
- **`publishDeepbookIndexerState`** / **`publishDeepbookServerState`** /
  **`publishDeepbookMarginState`** — used by their respective factories (`indexer.ts:201-207`,
  `server.ts:249-256`, `margin.ts:547-556`).
- **`runDockerContainer`** (`advanced/plugin-author/docker-container.ts`) — used by both sidecars
  (`indexer.ts:158`, `server.ts:191`).
- **`gitFetch`** (`advanced/plugin-author/git-fetch.ts`) — vendor (`vendor.ts:178-187`); fetched
  siblings are lifted via `__extraMembers` so the topo scheduler treats them as parallel-buildable
  leaves.
- **`routerEntrypoint`** + **`routerHostname`** (`engine/docker/router.ts`,
  `engine/router-hostname.ts`) — both sidecars derive their public URLs through traefik.
- **`publishMove`** (`services/package/internal.ts`) — local-deploy + margin both use it; the
  `capture` callback extracts captured object ids from the publish receipt via `pickCreatedByType`
  (`local-deploy.ts:308-336`, `margin.ts:205-215`).
- **`makeService`** (`advanced/make-service.ts`) — wraps each top-level facade in
  `services/deepbook.ts:252,258,265-303,310-319`.
- **`tag`** / **`provide`** (`advanced/tag.ts`) — interface layer wiring everywhere.

### Sui-specific helpers

- **`pickCreatedByType`** / **`moveTypeEquals`** / **`moveTypeStartsWith`**
  (`engine/sui-helpers.ts`) — extracting object ids from objectChanges by Move type matching
  (`local-deploy.ts:29,313-333`, `margin.ts:34,210-211,488-503`, `margin-seed.ts:23,161`,
  `market-maker.ts:27,443`).
- **Move call constants** — `SUI_CLOCK_OBJECT_ID = '0x6'` (`internal.ts:19`),
  `COIN_REGISTRY_OBJECT_ID = '0xc'` (`internal.ts:25` — used by margin to call
  `new_coin_type_data_from_currency` via the well-known shared `0x2::coin_registry` object).
- **Move type suffix constants** for objectType matching:
  `DEEPBOOK_REGISTRY_TYPE_SUFFIX = '::registry::Registry'`,
  `DEEPBOOK_ADMIN_CAP_TYPE_SUFFIX = '::registry::DeepbookAdminCap'`,
  `MARGIN_REGISTRY_TYPE_SUFFIX = '::margin_registry::MarginRegistry'`,
  `MARGIN_ADMIN_CAP_TYPE_SUFFIX = '::margin_registry::MarginAdminCap'`,
  `MARGIN_MAINTAINER_CAP_TYPE_SUFFIX = '::margin_registry::MaintainerCap'`,
  `MARGIN_POOL_TYPE_PREFIX = '::margin_pool::MarginPool'`,
  `MARGIN_SUPPLIER_CAP_TYPE_SUFFIX = '::margin_pool::SupplierCap'` (`internal.ts:27-37`).

### External resources

- **GitHub HTTPS** — `vendor.ts` clones `MystenLabs/deepbookv3` and `MystenLabs/deepbook-sandbox`
  via `gitFetch`.
- **Docker registry** — `mysten/deepbookv3-sandbox-indexer:46d846e5` and
  `mysten/deepbookv3-sandbox-server:46d846e5` (amd64 + `-arm64` variants) at the default `'v7.0.0'`
  Move version (`images.ts:31-42`).
- **Sui localnet RPC** (`host.docker.internal:9000`) — server only (`server.ts:144`). On Docker
  Desktop this resolves automatically; on Linux `--add-host host.docker.internal:host-gateway` is
  set explicitly (`server.ts:204`).
- **`@mysten/sui/transactions` + `/utils` + `/bcs`** — Move-call construction throughout. `fromHex`
  decodes Pyth feed hex strings to byte vectors (`margin.ts:31`).
- **Filesystem** — `vendor.ts` uses `node:fs/promises` to copy six package dirs and patch
  `Move.toml` files in-process (`vendor.ts:36-38,153-165,167-308`).

### npm dependencies

- `effect` (`Context`, `Effect`, `Layer`, `Option`, `Schedule`, `Schema`) — pervasive.
- `@mysten/sui/transactions` — `Transaction`, `TransactionObjectArgument`.
- `@mysten/sui/utils` — `fromHex` (margin only).
- `@mysten/sui/bcs` — `bcs.option(bcs.Address)` for `Option<address>` referral arg (margin-seed
  only, `margin-seed.ts:21,147`).
- `node:crypto` — `createHash('sha256')` for `hashPoolSpecs` (`local-deploy.ts:24,101-127`).
- `node:fs`, `node:fs/promises`, `node:path` — vendor only.
- (Type-compat reference only:) `@mysten/deepbook-v3`'s `DeepbookPackageIds` / `DeepBookOptions`
  shapes — deepbook's `packageIds` view is structurally compatible (`services/deepbook.ts:107-121`,
  `deepbook.test.ts:44-57`). The package is treated as an optional peer dep — devstack does NOT
  import it directly anywhere in this component.

### Effect / Layer / Context machinery

- `Context.Service<T, V>()('@devstack/<Tag>')` — `DeepbookCoreTag`, `DeepbookAdminTag`,
  `DeepbookMarketMakerTag` (`services/deepbook.ts:129,149,181`); `DeepbookIndexerTag`
  (`indexer.ts:46`); `DeepbookServerTag` (`server.ts:64`); `DeepbookMarginTag` (`margin.ts:158`).
- `Layer.effect` (via `provide`) — interface-tag binding layers (`local-deploy.ts:703-837`,
  `known-deployment.ts:82-115`, `indexer.ts:251-256`, `server.ts:303-308`, `margin.ts:560-565`).
- `Effect.forkScoped` — market-maker spawns its refresh loop into the surrounding scope
  (`market-maker.ts:557`).
- `Effect.withSpan` / `Effect.annotateCurrentSpan` — observability throughout.
- `Schema.TaggedErrorClass` — `DeepbookError`/`DeepbookIndexerError`/`DeepbookServerError`
  definitions.

## Capabilities PRODUCED

### Public exports

From `services/deepbook.ts` (re-exported as part of the top-level devstack public API):

- `Deepbook(opts)` — top-level facade factory; returns a `LayeredTag` of
  `DeepbookCore | DeepbookLocalDeployShape` depending on network branch.
- `DeepbookMarketMaker(opts)`, `DeepbookMintDEEP(opts)`, `DeepbookMintUSDC(opts)`,
  `VendorDeepbook(opts?)`, `DeepbookIndexer(opts)`, `DeepbookServer(opts)`, `DeepbookMargin(opts)`
  (with `.seed` namespace).
- Types: `DeepbookCore`, `DeepbookPoolRef`, `DeepbookPoolRefSchema`, `DeepbookOptions`,
  `DeepbookAdmin`, `DeepbookMarketMaker`.
- Tags: `DeepbookCoreTag`, `DeepbookAdminTag`, `DeepbookMarketMakerTag`, `DeepbookIndexerTag`,
  `DeepbookServerTag`, `DeepbookMarginTag`.
- Constants: `USDC_MARGIN_DEFAULTS`, `SUI_MARGIN_DEFAULTS`, `DEFAULT_POOL_RISK_CONFIG`.

From `services/deepbook/index.ts` (`/advanced` surface):

- Lower-level factories: `deepbookLocalDeploy`, `deepbookKnownPackage`, `deepbookMarketMaker`
  (lowercase), `deepbookMargin`, `deepbookMarginSeed`, `vendorDeepbook`.
- Image constants: `DEEPBOOK_IMAGES`, `DEFAULT_DEEPBOOK_MOVE_VERSION`, `getDeepbookImages`.
- Types: `DeepbookLocalDeployOptions/Shape`, `DeepbookKnownPackageOptions`,
  `DeepbookMarketMakerOptions/Handle/PoolSpec/Strategy`, `DeepbookCoinRef`, `DeepbookPoolSpec`,
  `DeepbookPool`, `DeepbookIndexerOptions/Shape`, `DeepbookServerOptions/Shape`,
  `DeepbookMarginOptions/Shape/AssetConfig/PoolRegistration/PoolRiskConfig/Pool`,
  `DeepbookMarginSeedOptions/Amount/Result`, `VendorDeepbookOptions`, `VendoredDeepbookSources`,
  `DeepbookImagePair`.
- From `internal.ts`: `calculateGridLevels` + helpers (also exported through `index.ts`).

### State-store entries

- `deepbook/pools/<chainId>/<contentHash({packageId, signer, poolsHash})>` (`local-deploy.ts:60-66`)
  — `CachedDeepbookPools` (`local-deploy.ts:87-93`):
  `{packageId, registryId, adminCapId, deepTreasuryId?, pools: CachedDeepbookPool[]}`.
  `CachedDeepbookPool`: `{name, poolId, base, quote, tickSize, lotSize, minSize}`
  (`local-deploy.ts:74-82`).
- `deepbook/margin-pools/<chainId>/<inputsHash>` (`margin.ts:250`) — the substrate's caching of the
  resolved `DeepbookMargin` value (`margin.ts:147-156`).
- `deepbook/margin-seed/<chainId>/<inputsHash>` (`margin-seed.ts:81`) — `DeepbookMarginSeedResult`
  (`margin-seed.ts:46-50`): `{digest, supplierCapId, seededAmounts}`.
- `deepbook/market-maker/balance-manager/<chainId>/<packageId>/<signerAddress>/<poolName>`
  (`market-maker.ts:52,186`) — `CachedBalanceManager` (`market-maker.ts:54-56`):
  `{balanceManagerId}`.
- `publishMove/<name>/<chainId>/<inputsHash>` for `deepbook.publish` (and `deepbook-margin.publish`,
  `deepbook-margin.liquidation.publish`) — the `publishMove` substrate's own cache slot; populated
  by deepbook indirectly.

### Per-service state-registry entries (the FOUR registries)

- **`DeepbookStateRegistry`** — `DeepbookStateRecord` (`engine/registries.ts:83-88`):
  `{name, packageId, registryId?, pools: Record<string, DeepbookPoolStateEntry>}`. Pool entry:
  `{poolId, baseType, quoteType}` (`engine/registries.ts:77-81`). Published by
  `deepbookLocalDeploy.register` (`local-deploy.ts:677-687`) AND `deepbookKnownPackage`
  (`known-deployment.ts:90-100`).
- **`DeepbookIndexerStateRegistry`** — `DeepbookIndexerStateRecord`
  (`engine/registries.ts:120-126`):
  `{name, metricsUrl, databaseUrl, containerNetwork, networkAlias}`. Published by indexer
  (`indexer.ts:201-207`).
- **`DeepbookServerStateRegistry`** — `DeepbookServerStateRecord` (`engine/registries.ts:134-141`):
  `{name, restUrl, metricsUrl, databaseUrl, containerNetwork, networkAlias}`. Published by server
  (`server.ts:249-256`). Carries both REST and metrics URLs because the server is two routes on one
  container.
- **`DeepbookMarginStateRegistry`** — `DeepbookMarginStateRecord` (`engine/registries.ts:155-164`):
  `{name, packageId, liquidationPackageId, registryId, adminCapId, maintainerCapId?, marginPools: DeepbookMarginPoolStateEntry[], registeredPools: string[]}`.
  Pool entry: `{label, assetType, marginPoolId}` (`engine/registries.ts:149-153`). Published by
  margin (`margin.ts:547-556`).

**Why four?** The four state shapes correspond to four logically-independent on-chain artifacts
whose lifecycles are NOT coupled: the core protocol package + pools is one thing; the indexer (a
sidecar container observing chain) is another; the server (a sidecar reading the indexer's Postgres)
is a third; the margin extension (a separate Move package set, MarginRegistry shared object,
separate set of `MarginPool<T>` objects, separate set of `register_deepbook_pool` calls) is a
fourth. Each can be present or absent independently in a stack. `runtime/service.ts:164-204` reads
all four and composes them into a single `DeepbookManifest` only when state is present. Comment at
`runtime/service.ts:164-168`: "Deepbook reads four state registries (state, indexer, server, margin)
so it doesn't fit the single-registry `defineServiceProjection` shape. It stays as a free function
until a multi-registry projection variant lands (or the integration-contract redesign collapses
deepbook's four registries into one)."

### Package-registry entries

- `name` (from `deepbookLocalDeploy.opts.name`, default `'deepbook'`):
  `{packageId, upgradeCapId, captured: {registryId, adminCapId, deepTreasuryId?}}`
  (`local-deploy.ts:664-675`).
- `${name}.publish` (default `'deepbook.publish'`): the underlying `publishMove` sibling registers
  under this name with the FULL captured shape.
- `${name}` from margin (default `'deepbook-margin'`):
  `{packageId, upgradeCapId, captured: {registryId, adminCapId}}` (`margin.ts:535-540`).
- `${name}.liquidation` from margin (default `'deepbook-margin.liquidation'`):
  `{packageId, upgradeCapId, captured: {}}` (`margin.ts:541-546`).

### Manifest output (`runtime/manifest-schema.ts:102-110`)

`services.deepbook`:

```
{
  packageId: string,
  registryId?: string,
  pools: Record<string, {poolId, baseType, quoteType}>,
  indexer?: { metrics: EndpointEntry },
  server?:  { rest: EndpointEntry, metrics: EndpointEntry },
  margin?: {
    packageId, liquidationPackageId, registryId, adminCapId,
    maintainerCapId?,
    marginPools: [{label, assetType, marginPoolId}],
    registeredPools: string[],
  },
}
```

### Endpoints

The indexer, server, and metrics URLs are NOT published into the flat `EndpointRegistry` (see
comment at `indexer.ts:194-199` and `server.ts:242-247`: "URL ownership: the indexer's metrics URL
is published only into the per-service state registry below … no flat-endpoint declaration exists
(Wave-2 dual-write fix)"). They are surfaced exclusively through
`services.deepbook.{indexer,server}.{rest,metrics}` in the manifest after `groupDeepbook`
projection.

### Codegen output

`DeepbookConfigEmitter` (`codegen/emitters/deepbook-config.ts:192-…`) reads `data.services.deepbook`
(skips emit when absent) and `data.packages.deepbook.captured.deepTreasuryId` to produce
`<output>/deepbook-config.ts` that exports a
`deepbookConfig: {packageIds, coins?, pools?, marginPools?, pyth?}` object the consumer spreads into
`@mysten/deepbook-v3`'s `deepbook({...})` plugin (`codegen/emitters/deepbook-config.ts:1-15`).

### Container images / volumes

- Two sidecar containers per stack with deepbook+indexer+server:
  `mysten/deepbookv3-sandbox-indexer:46d846e5` and `mysten/deepbookv3-sandbox-server:46d846e5`
  (arm64 suffix where applicable).
- No managed volumes — both containers are stateless against the writable layer (they hold cursor
  state inside Postgres bookkeeping tables, not in their own writable layer; see `indexer.ts:12-15`
  and `server.ts:11-15`).

### CLI commands / routes

- No CLI commands registered by deepbook itself.
- Three router entrypoints (see Configuration → Routing entrypoints).

## Lifecycle

### Startup — full local stack (most complex case)

Driven by the topo scheduler off `__upstreamKeys`. Approximate dependency order (subgraph):

1. **Vendor** (optional, parallel with sui boot) — `vendorDeepbook(...)` forks two `gitFetch`
   siblings (`vendor.ts:178-187`) which are lifted to top-level via `__extraMembers`
   (`vendor.ts:303-307`); the composite waits on both, then materialises six package dirs + patches
   every `Move.toml` (`vendor.ts:189-273`).
2. **Sui localnet** is brought up by the sui component (out of scope here).
3. **Postgres** is brought up (out of scope here).
4. **`deepbookLocalDeploy.publish`** — `publishMove` runs against the vendored or supplied path.
   Captures `registryId`, `adminCapId`, `deepTreasuryId` from objectChanges
   (`local-deploy.ts:308-336`). Caches via `publishMove`'s own substrate.
5. **`deepbookLocalDeploy` composite** — `onChainArtifact` reads cache; verify probe checks each
   cached pool object's type matches `<packageId>::pool::Pool<base, quote>` via
   `ChainProbe.objectsMatchTypes` (`local-deploy.ts:469-478`); on hit/skip-create-pools, on miss
   runs the batched `init_balance_manager_map` + N `create_pool_admin` tx
   (`local-deploy.ts:486-600`). `register` reattaches rich-shape fields (`poolsRecord`, `poolIds`,
   `findPool`, `packageIds`) AND publishes to `PackageRegistry` + `DeepbookStateRegistry`
   (`local-deploy.ts:618-688`).
6. **Interface layers** — `coreLayer` provides `DeepbookCoreTag` (read-side view); `adminLayer`
   provides `DeepbookAdminTag` (empty contract today); `marketMakerLayer` mints a BalanceManager
   up-front and provides `DeepbookMarketMakerTag` (`local-deploy.ts:725-837`).
7. **Pyth** is brought up in parallel with steps 1-6 (out of scope here).
8. **`deepbookMargin`** — depends on signer + pyth + deepbook + the two publish siblings + any coin
   tags. `inputs` validates margin publish was supplied; `verify` probes each `MarginPool<T>`
   objectType; `produce` runs a single batched setup tx that mints the maintainer cap, calls
   `new_coin_type_data_from_currency` per asset, creates `PythConfig`, adds it to `MarginRegistry`,
   creates one `MarginPool<T>` per asset with full protocol_config + interest_config, then per pool
   registers + enables it against the margin registry. `register` rebuilds `findMarginPool` +
   publishes to `PackageRegistry` (two entries) + `DeepbookMarginStateRegistry`
   (`margin.ts:530-557`).
9. **`deepbookMarginSeed`** (optional) — depends on margin. Mints `SupplierCap`, supplies seed
   liquidity per asset, transfers cap to signer.
10. **`DeepbookIndexer`** — depends on postgres + sui + deepbook + (optional) margin. Resolves
    `routerEntrypoint('deepbook-indexer-metrics')`, derives `metricsHostname`, builds env
    (`DATABASE_URL`, `NETWORK=localnet`, `DEEPBOOK_PACKAGE_ID`, `FIRST_CHECKPOINT`, `RUST_LOG`,
    `DB_CONNECTION_POOL_SIZE`, optional `MARGIN_PACKAGES`), runs container via `runDockerContainer`
    joining the Postgres network (`indexer.ts:90-207`).
11. **`DeepbookServer`** — same dep set as indexer (postgres + sui + deepbook + optional margin).
    Resolves two router entrypoints (`deepbook-server`, `deepbook-server-metrics`), runs container
    with `--db-statement-timeout-ms` CLI arg, env (`DATABASE_URL`,
    `RPC_URL=http://host.docker.internal:9000`, `DEEPBOOK_PACKAGE_ID`, `DEEP_TOKEN_PACKAGE_ID`,
    `DEEP_TREASURY_ID`, `RUST_LOG`, optional `MARGIN_PACKAGE_ID`),
    `--add-host host.docker.internal:host-gateway` (`server.ts:114-256`).
12. **`deepbookMarketMaker`** (optional) — depends on signer + `DeepbookCoreTag` (interface, not
    stack-member key) + any coin tags inside pool specs. Yields each pool's coin tags up-front
    (`market-maker.ts:155-169`), pre-loads cached BMs from state-store (`market-maker.ts:204-228`),
    runs **first tick synchronously inside the producer** (`market-maker.ts:546-555`) — startup gate
    so misconfig fails loudly — then forks `Effect.repeat(Schedule.spaced(refreshMs))` into scope
    (`market-maker.ts:557`).

### Ready criteria

- **Local-deploy / known-package** — ready when `composite` resolves (cache hit or successful
  publish + create-pools).
- **Margin** — ready when batched setup tx returns and all expected `MarginPool<T>` ids are present
  in objectChanges.
- **Margin-seed** — ready when supply tx returns and `SupplierCap` id is captured.
- **Indexer** — `runDockerContainer` ready probe (likely a `/metrics` HTTP probe; default is the
  container's own healthcheck, but `routing[].name` does not declare an explicit probe in deepbook's
  call — OPEN QUESTION: what's the default ready criterion? `indexer.ts:181-189` only catches
  `ReadyProbeError` after the fact).
- **Server** — same `runDockerContainer` semantics; routed via both `deepbook-server` and
  `deepbook-server-metrics`. OPEN QUESTION: which entrypoint's probe gates "ready"?
- **Market-maker** — ready after the first synchronous tick completes (so an unsatisfiable config
  surfaces as a startup failure, not a silent loop, `market-maker.ts:543-555`).

### Restart behavior

- **Local-deploy** is _correctness-fragile on resume_: without the `deepbook/pools/...` cache,
  `pool::create_pool_admin` aborts in `registry::register_pool` because `(base, quote)` was already
  registered (comment at `local-deploy.ts:62-65`). Cache + verify probe make resume idempotent.
  Pre-Phase-C the verify probe read `.objectType` off the SDK response root which is `undefined` at
  runtime — every cache check fell through to "objects missing" and re-fired create-pools on every
  resume (comment at `local-deploy.ts:462-467`).
- **Margin** has the same shape: `verify` probes each `MarginPool<T>` objectType; on cache hit, no
  tx fires.
- **Margin-seed** verify checks `SupplierCap` still exists AND its type suffix is
  `::margin_pool::SupplierCap`.
- **Indexer + server** are stateless against their writable layers: indexer re-derives its
  checkpoint cursor from Postgres bookkeeping tables on restart and intentionally loses in-memory
  event buffers (comment at `indexer.ts:11-14`); server is fully stateless — every response is
  rendered on demand from Postgres + chain RPC (comment at `server.ts:11-15`).
- **Market-maker** — fragile resume edge: a cached BalanceManager from a previous boot may carry
  stale cancellable orders. The per-tick **split-cancel-then-place** transaction structure
  (`market-maker.ts:254-301,303-473,475-528`) makes the resume cancel best-effort; if
  `cancel_all_orders` aborts with `EBalanceManagerBalanceTooLow` (Move abort code 3 in
  `balance_manager::withdraw_with_proof`, `market-maker.ts:492-497`) the place tx still proceeds. If
  the _place_ tx then aborts with the same error, the maker invalidates the cached BMs and remints
  (`market-maker.ts:499-528`).

### Teardown

- **Indexer + server** containers are torn down by the supervisor when the surrounding scope closes;
  no explicit shutdown sequence.
- **Market-maker** fiber is interrupted with the surrounding scope (`Effect.forkScoped`).
- No grace-period coordination between containers and the in-process maker — the maker may submit
  one final tx mid-shutdown if a tick fires just as the scope closes; tx errors are caught as
  warnings (`market-maker.ts:535-541`).

## Hard requirements / invariants

- **R1 — Pool create idempotency on resume.** `deepbookLocalDeploy` MUST cache
  `(packageId, poolsHash, pools[].poolId)` and verify object types on resume, or
  `pool::create_pool_admin` aborts in `registry::register_pool` and the supervisor errors out.
  Asserted by `services/deepbook.test.ts:404-576` ("cache hit skips both publish and create-pools
  txs") and `services/deepbook.test.ts:578-722` ("stale pool object invalidates and rebuilds").
  Cited: `local-deploy.ts:60-66,469-478`.
- **R2 — Verify probe uses typed Schema-validated SDK accessor.** All verify probes route through
  `ChainProbe.objectsMatchTypes` / `ChainProbe.getObject` (Schema-validated), not
  `client.core.getObject … as { objectType? }`. This closes B1/B3/B5 bug classes structurally
  (comment at `local-deploy.ts:462-468`; `margin.ts:18-26`; `margin-seed.ts:11-15`;
  `market-maker.ts:8-16`).
- **R3 — Arch-specific image selection.** `getDeepbookImages(moveVersion, arch)` MUST pick
  arm64-suffixed image tags on arm64 hosts (`images.ts:20,38-40,59`) — Rust binaries are not
  cross-compiled in the registry.
- **R4 — `EBalanceManagerBalanceTooLow` resume recovery.** Market-maker tick MUST split cancel +
  place into two transactions. Asserted by `market-maker.test.ts:194-309` (Bug A regression). Tick
  MUST detect `abort code: 3 in '<pkg>::balance_manager::withdraw_with_proof'` and recreate BMs
  (`market-maker.ts:492-528`; `market-maker.test.ts:312-468`).
- **R5 — BalanceManager verify checks owner address.** Cached BalanceManager id is trusted only if
  `ChainProbe.getObject` returns existence AND `owner.address === signer.address` (comment at
  `market-maker.ts:188-200`).
- **R6 — Indexer + server share a database name.** `DeepbookServer.databaseName` MUST match the
  indexer's setting (default `'deepbook'`); the server reads from the same database the indexer
  writes to. Comment at `server.ts:95-96`. There is no runtime guard — both default to `'deepbook'`
  so misconfig is unlikely but possible.
- **R7 — Indexer + server traefik ports must be free.** Router entries must be registered at module
  load (`engine/docker/router.ts:197-207`); a router-table-out-of-sync state surfaces as
  `routerEntrypoint(...) is undefined` and a typed `DeepbookIndexerError({phase: 'port-alloc'})` /
  `DeepbookServerError({phase: 'port-alloc'})` (`indexer.ts:140-147`, `server.ts:165-181`).
- **R8 — Indexer joins Postgres network.** The indexer container joins the _same_ Docker network as
  Postgres so it can dial via `networkAlias` without a host port mapping (`indexer.ts:106-107,161`).
  Same for the server (`server.ts:131-133,200`).
- **R9 — Server `host.docker.internal` resolution.** The server reads chain RPC from
  `host.docker.internal:9000`; on Linux this requires `--add-host host.docker.internal:host-gateway`
  (`server.ts:152-156,204`) — Docker Desktop sets it by default, CI Linux runners do not.
- **R10 — Pyth+margin coupling enforced at typecheck time (D5).** `DeepbookMarginOptions.pyth` is
  non-optional (`margin.ts:173`). Asserted by `margin-typecheck.test.ts` which spawns a dedicated
  `tsc --noEmit` against a fixture that omits `pyth`.
- **R11 — Margin uses the well-known `0x2::coin_registry` (object id `0xc`).** Pinned in
  `internal.ts:25`; consumed by `new_coin_type_data_from_currency` in margin's batched setup tx
  (`margin.ts:397`). Stable across networks.
- **R12 — Indexer + server image versions MUST match the Move source version.** The indexer/server
  image table is keyed by Move version; bumping one without the others silently corrupts indexed
  data (comment at `images.ts:4-7`).
- **R13 — DEEP TreasuryCap capture is best-effort.** The local-deploy `capture` callback matches
  `0x2::coin::TreasuryCap<{pkg}::deep::DEEP>` heuristically (substring start + substring end around
  the unknown package id, `local-deploy.ts:319-333`). Falls back to `''` if missing — consumers that
  depend on DEEP minting (e.g. `DeepbookMintDEEP`) must check.
- **R14 — Deepbook is a "composite primitive" with inner-tag lifting.** The local-deploy composite,
  the vendor composite, and the margin composite all build inner tags at factory time and yield them
  inside their own body; the comment at `supervisor.ts:115-121` explicitly calls out "Composite
  primitives (seal, deepbook, walrus) build inner tags at factory time". Vendor lifts its two
  `gitFetch` siblings via `__extraMembers` (`vendor.ts:303-307`); the substrate auto-flattens
  upstream records into `__upstreamKeys` so the topo scheduler places composites strictly after
  their providers (`local-deploy.ts:371-393`).
- **R15 — Cache key hash algorithm pinned by tests.** The pool-spec hash (`hashPoolSpecs`) is
  mirrored by `computePoolsHash` in `deepbook.test.ts:197-227`; the substrate inputs-hash mirror is
  exported as `computeDeepbookPoolsInputsHash` (`deepbook.test.ts:240-249`) so sibling test fixtures
  don't re-derive the algorithm. A regression in either reads as a hash-mismatch in the test, not a
  silent cache miss.

## Failure modes

| Failure                                                          | Trigger                                                                  | Current behavior                                                                                                                               | Recovery                                                                         |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Publish required, no source                                      | `deepbookLocalDeploy` called with neither `movePackagePath` nor `vendor` | `DeepbookError({phase: 'publish'})` from `inputs` body (`local-deploy.ts:418-428`)                                                             | Caller adds source.                                                              |
| `movePackagePath` AND `vendor` both supplied                     | Factory-time invariant                                                   | `TypeError` at construction (`local-deploy.ts:242-246`)                                                                                        | Caller picks one.                                                                |
| Pool spec validation                                             | Empty name, dup name, non-positive tick/lot, `minSize < lotSize`         | `TypeError` at construction (`local-deploy.ts:256-282`)                                                                                        | Caller fixes spec.                                                               |
| Publish receipt missing `registryId`/`adminCapId`                | Vendored Move source dropped or renamed `Registry` / `DeepbookAdminCap`  | `DeepbookError({phase: 'publish'})` from `produce` (`local-deploy.ts:500-509`)                                                                 | Re-vendor or pin a known-good ref.                                               |
| Create-pools tx fails                                            | Insufficient gas, Move abort                                             | `DeepbookError({phase: 'create-pools'})` wrapping the cause (`local-deploy.ts:556-563`)                                                        | Fix funding / package.                                                           |
| Pool missing from objectChanges                                  | Tx succeeded but didn't create expected pool                             | `DeepbookError({phase: 'create-pools'})` with expected type in message (`local-deploy.ts:569-579`)                                             | Source regression — re-vendor or report.                                         |
| Cache hit but pool object missing on chain                       | Externally wiped, snapshot mismatch                                      | Verify returns `undefined`, substrate invalidates entry, `produce` re-runs (`local-deploy.ts:469-478`, asserted by `deepbook.test.ts:578-722`) | Automatic.                                                                       |
| Known-package can't resolve ids                                  | No `network` + no explicit `packageId`/`registryId`                      | Throws at factory time (`known-deployment.ts:42-48`)                                                                                           | Caller supplies.                                                                 |
| Indexer router entrypoint missing                                | `routerEntrypoint('deepbook-indexer-metrics')` returns undefined         | `DeepbookIndexerError({phase: 'port-alloc'})` (`indexer.ts:140-147`)                                                                           | Module-load registration should make this unreachable; investigate router table. |
| Indexer container fails to start                                 | `DockerError` from `runDockerContainer`                                  | `DeepbookIndexerError({phase: 'container'})` wrapping the cause (`indexer.ts:172-180`)                                                         | Inspect Docker logs.                                                             |
| Indexer ready probe fails                                        | `ReadyProbeError` from `runDockerContainer`                              | `DeepbookIndexerError({phase: 'container'})` wrapping the cause (`indexer.ts:181-189`)                                                         | Investigate / extend timeout / inspect Postgres connectivity.                    |
| Server REST entrypoint missing                                   | Router table out of sync                                                 | `DeepbookServerError({phase: 'port-alloc'})` (`server.ts:165-172`)                                                                             | Same as indexer.                                                                 |
| Server metrics entrypoint missing                                | Router table out of sync                                                 | Same shape (`server.ts:173-181`)                                                                                                               | Same.                                                                            |
| Server container fails / probe fails                             | Docker-side                                                              | `DeepbookServerError({phase: 'container'})` (`server.ts:217-236`)                                                                              | Inspect Docker logs.                                                             |
| Margin publish receipt missing `MarginRegistry`/`MarginAdminCap` | Vendored margin source dropped types                                     | `DeepbookError({phase: 'margin-publish'})` (`margin.ts:307-314`)                                                                               | Re-vendor or pin good ref.                                                       |
| Margin asset's Pyth feed unknown                                 | Asset declares feed not in Pyth ref                                      | `DeepbookError({phase: 'margin-setup', marginAsset, feed})` (`margin.ts:324-333`)                                                              | Add feed to Pyth config.                                                         |
| Margin's deepbook pool not declared                              | `pools[].pool` doesn't exist in `DeepbookCore.poolIds`                   | `DeepbookError({phase: 'margin-setup', pool})` (`margin.ts:346-355`)                                                                           | Declare pool.                                                                    |
| Margin's deepbook pool object can't be fetched                   | Chain wiped or stale                                                     | `DeepbookError({phase: 'margin-setup', pool})` (`margin.ts:356-364`)                                                                           | Cache reset.                                                                     |
| Margin's deepbook pool type doesn't match regex                  | Pool type changed                                                        | `DeepbookError({phase: 'margin-setup', pool})` (`margin.ts:367-374`)                                                                           | DeepBook upstream regression.                                                    |
| Margin batched setup tx fails                                    | Sui-side abort or gas                                                    | `DeepbookError({phase: 'margin-pools'})` wrapping (`margin.ts:478-484`)                                                                        | Inspect.                                                                         |
| MarginPool missing from objectChanges                            | Tx succeeded but didn't create expected pool                             | `DeepbookError({phase: 'margin-pools', marginAsset})` (`margin.ts:489-498`)                                                                    | Source regression.                                                               |
| Margin-seed amount validation                                    | Dup label, non-positive amount                                           | `TypeError` at construction (`margin-seed.ts:56-65`)                                                                                           | Caller fixes.                                                                    |
| Margin-seed pool not declared                                    | Amount's `label` not in `margin.findMarginPool`                          | `DeepbookError({phase: 'margin-seed', marginAsset})` (`margin-seed.ts:112-121`)                                                                | Caller adds asset to margin.                                                     |
| Margin-seed tx fails                                             | Sui-side abort                                                           | `DeepbookError({phase: 'margin-seed'})` (`margin-seed.ts:154-161`)                                                                             | Inspect.                                                                         |
| SupplierCap missing from objectChanges                           | Tx succeeded but didn't capture                                          | `DeepbookError({phase: 'margin-seed'})` (`margin-seed.ts:163-170`)                                                                             | Source regression.                                                               |
| Market-maker no pools                                            | Empty `pools` array                                                      | `DeepbookError({phase: 'market-maker-tick'})` at startup (`market-maker.ts:144-152`)                                                           | Caller adds pool.                                                                |
| Market-maker pool ref unknown                                    | `findPool({base, quote})` no match                                       | `DeepbookError({phase: 'market-maker-tick'})` from `makeFindPool` (`internal.ts:132-141`)                                                      | Declare pool.                                                                    |
| Market-maker initial tick fails                                  | Any cause                                                                | `DeepbookError({phase: 'market-maker-tick'})` at startup gate (`market-maker.ts:546-555`)                                                      | Inspect; surfaces as supervisor abort.                                           |
| Market-maker steady-state tick fails                             | Transient RPC / single bad tx                                            | Logged as warning, loop continues (`market-maker.ts:535-541`)                                                                                  | Automatic on next tick.                                                          |
| Market-maker cancel aborts on resume                             | `EBalanceManagerBalanceTooLow`                                           | Logged warning, place tx still attempted (`market-maker.ts:294-300`)                                                                           | Place tx posts new orders at same grid offsets.                                  |
| Market-maker place aborts on resume                              | Same `EBalanceManagerBalanceTooLow` after cancel succeeded               | BMs dropped from cache, `recreateBalanceManagers` fires, place retried with fresh BMs + pre-deposits (`market-maker.ts:499-528`)               | Automatic; assertion in `market-maker.test.ts:312-468`.                          |
| Vendor source dir not found                                      | `gitFetch` succeeded but expected subdir missing                         | Error thrown inside `Effect.tryPromise` and surfaces as `DeepbookError({phase: 'deepbook'})` (`vendor.ts:222-228,250-259`)                     | Investigate upstream layout change.                                              |

## Persistence model

### Survives restart (`pnpm dev` interrupted and re-run, same chain)

- All four state-store cache entries (`deepbook/pools/...`, `deepbook/margin-pools/...`,
  `deepbook/margin-seed/...`, `deepbook/market-maker/balance-manager/...`). On resume the verify
  probes re-validate against chain; trusted entries skip their respective produce bodies.
- `publishMove/<name>/<chainId>/<inputsHash>` entries for `deepbook.publish`,
  `deepbook-margin.publish`, `deepbook-margin.liquidation.publish` (managed by the publishMove
  substrate).
- Postgres data the indexer wrote — survives Postgres container restart through Postgres's own
  volume.
- Indexer's checkpoint cursor — re-derived from Postgres bookkeeping tables on restart
  (intentionally NOT persisted in the indexer container's writable layer; comment at
  `indexer.ts:11-14`).
- Vendor tree at `.devstack/vendor/deepbook/<ref>/` — survives because `vendorDeepbook` writes there
  directly; cleared on every producer run (`vendor.ts:213-215`).

### Survives snapshot (subset of persisted)

Per `engine/snapshot-deepbook.docker.test.ts:1-50` (scaffold) and the comments in each module:

- `state.json` round-trips (all four state-store namespaces).
- On-chain ids unchanged after sui-localnet snapshot/restore round-trip (deepbook + pool ids;
  margin + MarginPool ids; SupplierCap; BalanceManagers).
- Pyth `PriceInfoObject`s survive (sui-localnet snapshot captures the Pyth on-chain state;
  deepbook's `deepbook-config.ts` cache hit verifies via them).
- Indexer's last-checkpoint cursor preserved in Postgres (carried by Postgres's own snapshot
  participation, not deepbook's).
- Server `/ticker` per-pool `lastPrice` unchanged (because the indexer's Postgres rows are
  unchanged).
- Margin pool ids + SupplierCap balance unchanged.

The reason `snapshot-deepbook.docker.test.ts` exists separately (rather than being subsumed by
`snapshot.docker.test.ts`) is that the FULL deepbook stack exercises:

- Multiple Move publications (deepbook + margin + liquidation) whose cache entries each have to
  survive.
- Per-instance batched create-pools / create-margin-pools txs (whose receipts are referenced from
  cache).
- Postgres rows (indexer cursor + ticker rows) that have to survive because the server reads them on
  demand.
- Multiple sidecar containers whose endpoints must come back at the same URLs.
- A market-maker BM cache whose verify probe must succeed against the restored chain state.

### Wiped on `devstack wipe`

- All state-store entries (cache namespaces above) — devstack wipe nukes `state.json`.
- Indexer + server containers torn down; Postgres volume wiped.
- Vendor tree at `.devstack/vendor/deepbook/<ref>/` — survives unless wipe targets `.devstack`
  entirely (OPEN QUESTION).
- `gitFetch` cache at `.devstack/git/...` — survives the same way (OPEN QUESTION).

### Process-local only

- `deepbookLocalDeploy`'s lazy `balanceManagerId` closure variable (`local-deploy.ts:736`) for the
  `DeepbookMarketMakerTag` interface — re-initialised every supervisor cycle. Today the up-front
  `ensureBalanceManager` call inside `marketMakerLayer` (`local-deploy.ts:831`) means a tx is fired
  every cycle for this purpose (even if the consumer never calls `tickPool`); cached idempotency on
  this path is NOT present.
- `deepbookMarketMaker`'s in-fiber `balanceManagerIds` Map (`market-maker.ts:184`) — pre-loaded from
  cache, mutated through ticks.
- `tickPool`'s in-flight transactions — no replay buffer.

## Modes & variants

DeepBook has THREE primary network-mode variants, plus optional sub-component dimensions.

### Network modes (`Deepbook(opts)` top-level dispatch, `services/deepbook.ts:241-259`)

| Dimension              | `localnet` (local-deploy)                                                                                                                                                                                                                                                                                                                                                       | `testnet` / `mainnet` (known-package, live)                                                                                                                                                                                                                                                 | `*-fork` (known-package, fork)                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Container(s) for core  | None — core deepbook is Move-only. Indexer + server (optional) add containers.                                                                                                                                                                                                                                                                                                  | None — core is on canonical chain. Indexer + server theoretically possible against live chain but not the common path.                                                                                                                                                                      | Same as live, but indexer/server can target the fork.                                                                                           |
| Startup sequence       | 1. Vendor (or `movePackagePath`) → 2. `publishMove` → 3. `onChainArtifact` cache check + verify pool object types → 4. Batched `init_balance_manager_map` + N `create_pool_admin` tx (or skip on cache hit) → 5. `register` mutates rich shape + publishes registries → 6. Three interface layers wired (core, admin, market-maker — the latter mints BalanceManager up-front). | 1. Resolve `packageId`/`registryId` from registry lookup (or explicit). 2. Build `packageIds` view from registry's snapshot. 3. Build static pool table from `opts.pools`. 4. Publish into `DeepbookStateRegistry`. **No publish, no create-pools tx.** Only `DeepbookCoreTag` is provided. | Same as live — `resolveDeploymentNetwork` collapses `'testnet-fork'` → `'testnet'`. The fork serves the upstream's real deepbook package state. |
| Ready criteria         | Composite resolves; first market-maker tick (if used) completes.                                                                                                                                                                                                                                                                                                                | Composite resolves (synchronous registry lookup).                                                                                                                                                                                                                                           | Same as live.                                                                                                                                   |
| Persistence            | `deepbook/pools/<chainId>/...` cache + all four state-store namespaces + publishMove cache + vendor tree.                                                                                                                                                                                                                                                                       | None local to deepbook (chain state survives on the upstream network independently).                                                                                                                                                                                                        | Fork's chain state lives in sui-fork's writable layer; deepbook itself persists nothing.                                                        |
| Teardown               | Supervisor closes scope; BM closure state and market-maker fiber go away. No torn-down infra (Move state lives on chain).                                                                                                                                                                                                                                                       | None.                                                                                                                                                                                                                                                                                       | None.                                                                                                                                           |
| Dependencies           | sui (localnet), optionally postgres+pyth (for indexer/server/margin).                                                                                                                                                                                                                                                                                                           | None mandatory; the registry lookup is synchronous, no chain RPC needed for the core tag itself.                                                                                                                                                                                            | sui-fork (live RPC tunnel + fork container).                                                                                                    |
| Hard requirements      | R1-R5, R10-R15 all apply.                                                                                                                                                                                                                                                                                                                                                       | R3 (image arch) and R12 (version pairing) only relevant if indexer/server are added; R10 (Pyth+margin coupling) applies if margin is.                                                                                                                                                       | Same as live.                                                                                                                                   |
| Failure modes          | Full table above.                                                                                                                                                                                                                                                                                                                                                               | Throws at factory time if ids can't be resolved (`known-deployment.ts:42-48`).                                                                                                                                                                                                              | Same as live.                                                                                                                                   |
| Snapshot contributions | All four state-store namespaces, publishMove caches, three sets of cached object ids. Sui-localnet's RocksDB snapshot also captures the on-chain ids.                                                                                                                                                                                                                           | None — known-package is just a static registry lookup wrapped in a tag.                                                                                                                                                                                                                     | The fork captures the wrapped upstream's state at the moment of fork; deepbook itself contributes nothing.                                      |

### Sub-component dimensions (independent, additive on any network mode)

Each row can be present or absent independently:

| Sub-component              | Factory                                                      | State registry                                                                          | Container?                                  | Postgres dep?                               | Pyth dep?                         | Margin dep?                                          |
| -------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------- | --------------------------------- | ---------------------------------------------------- |
| Core (publish + pools)     | `Deepbook` → `deepbookLocalDeploy` or `deepbookKnownPackage` | `DeepbookStateRegistry`                                                                 | No                                          | No                                          | No                                | No                                                   |
| Indexer (Rust container)   | `DeepbookIndexer`                                            | `DeepbookIndexerStateRegistry`                                                          | Yes (`deepbookv3-sandbox-indexer:46d846e5`) | **Yes** (joins network, writes events)      | No                                | Optional — surfaces `MARGIN_PACKAGES` env when wired |
| Server (Rust container)    | `DeepbookServer`                                             | `DeepbookServerStateRegistry`                                                           | Yes (`deepbookv3-sandbox-server:46d846e5`)  | **Yes** (reads from same db indexer writes) | No (reads Pyth state via sui RPC) | Optional — `MARGIN_PACKAGE_ID` env                   |
| Margin (publish + pools)   | `deepbookMargin` (sugar `DeepbookMargin`)                    | `DeepbookMarginStateRegistry`                                                           | No                                          | No                                          | **Yes (type-enforced D5)**        | n/a — IS the margin                                  |
| Margin-seed (cap + supply) | `deepbookMarginSeed` (sugar `DeepbookMargin.seed`)           | (none — result cached in state-store at `deepbook/margin-seed/...`)                     | No                                          | No                                          | No                                | **Yes**                                              |
| Market-maker               | `deepbookMarketMaker` / `DeepbookMarketMaker`                | None (per-pool BM cached in state-store at `deepbook/market-maker/balance-manager/...`) | No (Effect fiber)                           | No                                          | No                                | No (interacts via `DeepbookCoreTag` only)            |
| Vendor                     | `vendorDeepbook` / `VendorDeepbook`                          | None                                                                                    | No                                          | No                                          | No                                | No                                                   |
| Mint sugar                 | `DeepbookMintDEEP` / `DeepbookMintUSDC`                      | None (read via package registry)                                                        | No                                          | No                                          | No                                | No                                                   |

### Composite primitive semantics

`services/deepbook.ts` is one of the "composite primitives" the supervisor calls out
(`supervisor.ts:115-121`). The composites build inner tags at factory time, capture them in their
own body's upstream record, and yield them via the topo scheduler — _not_ through the public
`defineDevstack(...)` stack array. The user only writes:

```ts
defineDevstack({
  stack: [
    Sui(),
    Postgres(),
    Pyth({...}),
    Deepbook({ local: {signer, pools: [...]} }),
    DeepbookIndexer({ postgres, sui, deepbook }),
    DeepbookServer({ postgres, sui, deepbook }),
    DeepbookMargin({ signer, pyth, deepbook, margin: {...}, liquidation: {...}, assets, pools }),
    DeepbookMargin.seed({ signer, margin, amounts }),
    DeepbookMarketMaker({ name: 'mm', signer, strategy: {kind: 'bps'}, pools: [...] }),
  ],
});
```

…and the composite's internal `publishMove` (and `vendorDeepbook`'s two `gitFetch` siblings) become
first-class graph nodes via `__extraMembers`. The two `gitFetch` tags inside `vendorDeepbook` are
explicitly lifted (`vendor.ts:303-307`); local-deploy's own publish sibling is implicit because its
`__layer` is wired into the composite's `__layers` (`local-deploy.ts:843-849`).

## Test coverage

### `services/deepbook.test.ts` (L1 + StateStore-touching)

`describe('deepbookKnownPackage')`:

- `it.effect('provides DeepbookCoreTag from a network lookup')` — Compose
  `deepbookKnownPackage({network: 'testnet', pools: [...]})`. Assert `core.packageId` / `registryId`
  start with `0x`; `poolIds.get('sui_usdc')` matches; SDK-aligned `packageIds.DEEPBOOK_PACKAGE_ID` /
  `REGISTRY_ID` / `DEEP_TREASURY_ID` / `MARGIN_PACKAGE_ID` / `MARGIN_REGISTRY_ID` /
  `LIQUIDATION_PACKAGE_ID` are all `0x`-prefixed (i.e. canonical testnet values flow through).
  [Confirms R0: registry → SDK packageIds projection works.]
- `it.effect('does NOT provide DeepbookAdminTag')` — Yielding `DeepbookAdminTag` against a
  known-package-only layer surfaces as runtime resolution failure (`Exit.isFailure`). [Confirms D6:
  capability axis split.]
- `it.effect('explicit packageId/registryId override the network lookup')` — When caller supplies
  `{packageId: '0xCAFE', registryId: '0xBEEF', pools: []}` without `network`, optional fields fall
  back to empty string (`DEEP_TREASURY_ID`) and `undefined` (`MARGIN_*` / `LIQUIDATION_*`).

`describe('deepbookLocalDeploy — create-pools resume cache')`:

- `it.effect('cache hit skips both publish and create-pools txs')` — Pre-warm both
  `publishMove/<...>` AND `deepbook/pools/<...>` cache entries; build composite against a signer
  whose `signAndExecute` is `Effect.die`. Assert composite resolves with correct
  `packageId`/`adminCapId`/`registryId`/`poolIds` (i.e. neither tx fired). [Confirms R1.]
- `it.effect('cache hit but stale pool object invalidates and rebuilds')` — Pre-warm both caches
  with a `stalePoolId`; mock `client.core.getObject` such that the publishMove verify succeeds but
  the create-pools verify (`stalePoolId`) fails. Assert composite fails (the dying signer fires from
  create-pools re-entry) AND the deepbook cache entry was removed. [Confirms invalidation path +
  cache eviction.]

Exports `computeDeepbookPoolsInputsHash` (named export) for sibling test files
(`deepbook.test.ts:240-249`).

### `services/deepbook.fork-known.docker.test.ts`

- `it('Deepbook() on testnet-fork composes to deepbookKnownPackage(testnet); a pool read succeeds')`
  — Scaffold; pending docker wiring. Gated `RUN_FORK_DOCKER_TESTS=1`. Body asserts `SHOULD_RUN` is
  true (placeholder).

### `services/deepbook/codegen.docker.test.ts`

- `it.todo('emits deepbook-config.ts whose DEEPBOOK_PACKAGE_ID matches on-chain state')`.
- `it.todo('consumer config `import { deepbookConfig }`compiles cleanly under`pnpm tsc --noEmit`')`.

### `services/deepbook/margin-seed.docker.test.ts`

- `it.todo('mints SupplierCap + supplies per-asset seed; total_supply >= seed amount')`.

### `services/deepbook/margin-typecheck.test.ts`

`describe('deepbookMargin typecheck enforcement (P4.T5 L1)')`:

- `it('rejects a config that omits `pyth`')` — Spawns dedicated
  `node_modules/.bin/tsc --noEmit -p <generated tsconfig>` against
  `test-setup/fixtures/margin/no-pyth.fixture.ts`. Asserts non-zero exit + diagnostic mentions
  `pyth|missing.*propert|not assignable|argument`. Skips when `tsc` binary isn't hoisted. [Confirms
  R10/D5.]

### `services/deepbook/margin.docker.test.ts`

`describe('deepbookMargin — real-Docker fixture')`:

- `it.todo('publish captures MarginRegistry + MarginAdminCap as 0x-prefixed ids')` (P4.T3).
- `it.todo('creates one MarginPool<T> per asset with the correct generic in objectType')` (P4.T4).
- `it.todo('margin seed: total_supply >= seed amount after supply tx')` (P4.T6).
- `it.todo('re-apply uses cached margin pools (cache hit)')` (P4.T7).
- `it.todo('snapshot/restore preserves margin pool ids')` (P4.T8).
- `it.todo('indexer with margin Ref carries MARGIN_PACKAGES env var')` (P4.T9).

### `services/deepbook/margin.test.ts` (L1)

`describe('deepbookMargin factory shape (P4.T1 L1)')`:

- `it('returns a tag with __kind=action and a __layer when fully configured')` — Pin tag shape +
  `__layers` length ≥ 2.
- `it('throws on margin.movePackagePath + margin.vendor mutual exclusion')`.
- `it('throws on duplicate asset labels')`.
- `it('exposes named asset defaults with the sandbox-derived shape')` — Pin `USDC_MARGIN_DEFAULTS` /
  `SUI_MARGIN_DEFAULTS` field values.
- `it('exposes DEFAULT_POOL_RISK_CONFIG with the sandbox-derived shape')`.

`describe('deepbookMarginSeed factory shape (P4.T1 L1)')`:

- `it('returns a tag with __kind=action when configured')`.
- `it('throws on duplicate amount labels')`.
- `it('throws when an amount is non-positive')`.

`describe('state-store cache key shapes')`:

- `it('margin pool cache key prefix is deepbook/margin-pools')`.
- `it('margin seed cache key prefix is deepbook/margin-seed')`.

### `services/deepbook/market-maker.test.ts`

`describe('calculateGridLevels (bps strategy)')`:

- `it('produces tick-aligned prices at the expected bps offsets')` — Hand-computed expected prices
  for 3 levels at `mid=1_000_000`, `tickSize=100`, `spreadBps=20`, `levelSpacingBps=5`.
- `it('aligns sizes to lotSize')` — `sizeBase=123n, lotSize=10n` → `120n`.
- `it('drops bids that would land at or below zero')` — `spreadBps=20_000` (200%) → 0 bids, 1 ask.

`describe('state-store key shape')`:

- `it('uses deepbook/market-maker/balance-manager prefix')`.
- `it('perPool variant appends pool name as final segment')`.

`effectDescribe('deepbookMarketMaker — cancel-resilient resume (Bug A)')`:

- `effectIt.effect('splits cancel + place: cancel failure on resume does NOT kill the place tx')` —
  Pre-warm BM cache, mock signer's `signAndExecute` to fail-then-succeed; assert 2 distinct calls
  (cancel first, place second). [Confirms R4 split-tick.]
- `effectIt.effect('place-tx BalanceTooLow abort recreates BalanceManager and retries')` —
  Three-call sequence: cancel ok → place abort code 3 → place ok after recreate. Assert 3 distinct
  calls, cache invalidated and rewritten with fresh BM id. [Confirms R4 recreate path.]

### `services/deepbook/server.docker.test.ts`

- `it.todo('serves /ticker with numeric lastPrice/bestBid/bestAsk after 3 orders + 1 fill')`
  (P3.T1).
- `it.todo('survives snapshot/restore with unchanged per-pool lastPrice')` (P3.T2).
- `it.todo('two concurrent stacks expose distinct DeepbookServer hosts')` (P3.T4).

### `services/deepbook/server.test.ts`

`describe('DeepbookServer factory shape (P3.T1 L1)')`:

- `it('returns a tag-shaped value with __kind=service and a __layer')` — Pin `__kind`,
  `__layers.length >= 2`, callable as function (tag form).
- `it('defaults to `deepbook-server` for the name when omitted')` — Pin
  `__displayTitle = 'deepbook.server.deepbook-server'`.
- `it('accepts an optional margin Ref')` — Pin `__kind` survives the extra `margin` option.

### `services/deepbook/vendor.docker.test.ts`

- `it('clones + materializes all 6 packages and patches each Move.toml with local-path deps')` —
  Gated `DEVSTACK_INTEGRATION_TESTS=1` + `DOCKER_OK`. Sets `DEVSTACK_STATE_DIR` to a fresh tmpdir,
  runs `vendorDeepbook({ref: 'main'})`, asserts all six package `Move.toml` files exist, verifies
  `deepbook_margin/Move.toml` contains `local = "../token"`, `local = "../deepbook"`,
  `local = "../pyth"`. Timeout 360s (cold clone is slow).

### `engine/snapshot-deepbook.docker.test.ts`

`describe('snapshot/restore — full deepbook stack (P5.T10)')`:

- `it.todo('apply → save → wipe → restore: deepbook-config.ts regenerated identical content')`.
- `it.todo('on-chain deepbook package + pool ids unchanged after restore')`.
- `it.todo('pyth PriceInfoObject ids unchanged after restore')`.
- `it.todo('indexer last-checkpoint cursor preserved in Postgres after restore')`.
- `it.todo('server /ticker shows the same per-pool lastPrice after restore')`.
- `it.todo('margin pool ids + supplier-cap balance unchanged after restore')`.

Folds in P2.T8 (Postgres rows), P3.T3 (`/ticker` stability), P3.T4 (server container), P4.T8 (margin
pool ids).

## Pain points today

1. **Four state registries for one logical component.** `runtime/service.ts:164-168` explicitly
   notes this "doesn't fit the single-registry `defineServiceProjection` shape" and stays as a free
   function until a multi-registry projection variant lands. Adding a fifth (e.g. for
   `deepbookMarginSeed` SupplierCap) would compound the awkwardness. The four state-store namespaces
   compound this — `deepbook/pools`, `deepbook/margin-pools`, `deepbook/margin-seed`,
   `deepbook/market-maker/balance-manager` — none of which use a unifying key prefix or share a
   tombstoning mechanism.

2. **`Deepbook(opts)` doesn't expose enough surface from the facade.**
   `services/deepbook.ts:215-218` admits the canonical-only `Deepbook()` factory intentionally
   exposes no `override:` surface, but the result is that plugin authors who need a pinned private
   deployment must reach into `/advanced` for `deepbookKnownPackage({...})` directly. The interface
   is split: `Deepbook` is canonical-only sugar; everything else (Indexer, Server, Margin) is
   exposed verbatim. `services/deepbook.ts:264-336` reads as a series of
   `eslint-disable @typescript-eslint/no-explicit-any` boilerplate wrappers around the underlying
   factories with no value added beyond `makeService` tagging.

3. **`DeepbookMargin = Object.assign(deepbookMarginAction, {seed: deepbookMarginSeedAction})`**
   (`services/deepbook.ts:334-336`). The `.seed` namespace pattern mirrors the
   `DeepbookMintDEEP/MintUSDC` sugar but is unusual TypeScript-shape-wise — `Object.assign` to
   attach a `seed` field to a function. Discoverability suffers (the type signature reads as a
   function, not as a namespace; IDE go-to-definition lands inconsistently). The comment at
   `services/deepbook.ts:334` explicitly justifies it as "keeps the call sites readable without
   ballooning the top-level facade with two near-identical symbols".

4. **The market-maker is exposed twice.** `DeepbookMarketMaker` (the Context.Service tag,
   `services/deepbook.ts:181-184`) and `DeepbookMarketMaker` (the factory function,
   `services/deepbook.ts:265-267`) share the same public name. The tag is renamed
   `DeepbookMarketMakerTag` internally to make space (`services/deepbook.ts:177-184`) but the
   symmetry-breaking is awkward and the comment explicitly admits it.

5. **`DeepbookAdminTag` is empty.** `services/deepbook.ts:145-151`: "Empty contract today — kept as
   a placeholder so consumer types can already declare 'I need DeepbookAdminTag' and pick up real
   admin operations". Today's only purpose is to provide a typecheck-axis: a `deepbookKnownPackage`
   consumer can't accidentally type-depend on admin operations the layer doesn't provide. There's no
   actual capability behind it.

6. **`local-deploy.ts` is 866 lines.** Single file containing the publish dance, cache schema,
   validation, factory body, three interface layers (`coreLayer`, `adminLayer`, `marketMakerLayer`),
   AND the up-front BM mint (which fires a tx every supervisor cycle for any stack that consumes the
   `DeepbookMarketMaker` interface even once — `local-deploy.ts:826-831`). The market-maker concern
   arguably belongs separately.

7. **`vendor.ts` does runtime fs work in-process.** The six-package copy + Move.toml patch is done
   with `node:fs/promises` inside the producer (`vendor.ts:212-247`). The comment at `vendor.ts:32`
   admits "A future `dockerOneShot` variant can run inside `images/sui` if hermetic-builds are
   required." Cross-platform fragility (Move.toml regex assumes a specific git-dep format).

8. **Indexer ready probe is implicit.** `indexer.ts:158-190` only declares routing for `/metrics`;
   the ready-probe is whatever `runDockerContainer` does by default. OPEN QUESTION above. Same for
   server.

9. **`host.docker.internal:9000` is hardcoded.** `server.ts:144`. The dance with
   `--add-host host.docker.internal:host-gateway` (`server.ts:204`) papers over the Linux/Desktop
   split but the magic constant `9000` is not derived from the live Sui RPC entrypoint (which is
   theoretically reconfigurable).

10. **`local-deploy.ts:736-770` mints a BalanceManager up-front whether the consumer uses it or
    not.** The lazy `ensureBalanceManager` closure exists _and_ the comment at
    `local-deploy.ts:826-831` says "Mint up-front so consumers can read `balanceManagerId`
    synchronously from the shape." So one tx fires per supervisor cycle even when the BalanceManager
    is unused. Caching this id (mirroring `market-maker.ts`'s per-pool BM cache) is not done — the
    comment justifies the cost as "small relative to startup" but on resume the tx still fires.

11. **`DeepbookMargin.publish` flow is half-implemented.** `margin.ts:166-167` declares both
    `movePackagePath` and `vendor` options but the `inputs` body (`margin.ts:252-261`) still fails
    when `marginPublish === undefined`. Comment at line 258: "(vendor-runtime flow is deferred)" —
    the field exists in the type but isn't wired through. Consumers passing only `vendor:` get a
    runtime error.

12. **Sui-fork checkpoint volume not wired yet.** `indexer.ts:117-123`: "`LOCAL_CHECKPOINTS_DIR` is
    set when the indexer mounts the sui checkpoint volume. Sui-fork hasn't yet surfaced a volume
    name (`EndpointName.SUI_CHECKPOINT_VOLUME` is added to endpoint-names.ts but the sui factory
    hasn't published it yet). For now indexer boots without checkpoint ingestion — the Move events
    still flow through Postgres once the volume is wired in a later phase." This means the indexer
    is functionally inert on fork stacks today.

13. **`makeService('deepbook', 'action', …)` plugin string is a magic constant.** Used throughout
    `services/deepbook.ts:252-319`. No `PLUGIN_NAME` constant.

14. **Per-instance code paths use the same kind ('action' vs 'service') asymmetrically.**
    `Deepbook()` is `'service'`, `DeepbookMarketMaker()` is `'action'`
    (`services/deepbook.ts:265-267`), but the market-maker actually runs a long-lived fiber (it's
    behaviorally a service). `DeepbookIndexer`/`DeepbookServer` are `'service'`,
    `DeepbookMargin(.seed)` are `'action'`. The kind classification drives TUI grouping but doesn't
    always reflect runtime behaviour.

15. **`DeepbookCore['packageIds']` carries empty-string + undefined inconsistently.**
    `DEEP_TREASURY_ID` is `string` (with `''` fallback for missing); `MARGIN_*` / `LIQUIDATION_*`
    are `string | undefined` (with `undefined` for missing). The SDK accepts both shapes (everything
    is optional) but the inconsistency is jarring (`services/deepbook.ts:114-121`,
    `known-deployment.ts:53-61`).

16. **Codegen emitter reads through `data.packages.deepbook.captured.deepTreasuryId`.**
    `codegen/emitters/deepbook-config.ts:213-…` reaches into the package registry via the `captured`
    blob, which is published twice (once by `publishMove`'s sibling under `deepbook.publish`, once
    by local-deploy's own `register` under `deepbook`). The forwarding is explicitly documented as a
    fix at `local-deploy.ts:655-663` ("Forgetting to pass `deepTreasuryId` here was the cause of
    `DeepbookConfigEmitter: skipping emit`"). Brittle.

17. **No tombstone on cache invalidation when verify fails.** `local-deploy.ts:469-478` returns
    `undefined` from verify which the substrate maps to "miss". Other namespaces (margin,
    margin-seed, market-maker) do the same. No mechanism to distinguish "haven't tried yet" from
    "tried, was stale". Diagnostic readability suffers.

18. **`hashPoolSpecs` is hand-written sha256-with-slice.** `local-deploy.ts:101-127`. Each test file
    that wants to construct a cache fixture has to mirror it (see `deepbook.test.ts:197-227` for
    `computePoolsHash`). The comment at `deepbook.test.ts:240-249` exports
    `computeDeepbookPoolsInputsHash` "so other test files that hand-craft cache fixtures … can
    import the helper instead of re-deriving the algorithm" — but only the substrate-inputs-hash
    piece, not the `hashPoolSpecs` piece itself.

## Open questions

- **What's the default ready criterion for the indexer container?** The `runDockerContainer` call at
  `indexer.ts:158-190` declares routing but no explicit `readyProbe`. Same for the server
  (`server.ts:191-217`). OPEN QUESTION: are they HTTP probes against `/metrics` / `/`? Or just
  "container running" / "port open"? This affects R4-style snapshot/restore stability.
- **What happens on `devstack wipe` to the vendor tree and gitFetch cache?** `vendor.ts:199-200`
  puts the materialised tree under `${DEVSTACK_STATE_DIR ?? '.devstack'}/vendor/deepbook/<ref>/`.
  OPEN QUESTION: does `devstack wipe` recursively delete that directory or only state.json?
- **Is `host.docker.internal:9000` derived or hardcoded?** `server.ts:144` reads as a magic string.
  OPEN QUESTION: should this be threaded through from the Sui entrypoint config so that a
  non-default RPC port doesn't break the server?
- **Are the indexer/server images keyed correctly when running against testnet/mainnet?** The
  default `'v7.0.0'` Move version (`images.ts:65`) pairs with a specific 8-char Git SHA
  (`46d846e5`). If a user composes `Deepbook()` on testnet (which uses a chain-side package version
  that doesn't match `v7.0.0`) and _also_ runs `DeepbookIndexer/Server`, OPEN QUESTION: does the
  indexer correctly decode events from that chain's Move events?
- **Margin `vendor` flow.** `margin.ts:166-167,189` accepts `vendor:` but `inputs` body fails when
  `marginPublish === undefined`. OPEN QUESTION: should `vendor:` be removed from the type until it's
  actually wired?
- **Per-instance indexer/server multiplicity.** Both factories accept a `name:` override, suggesting
  multi-instance is intended, but the four registries are array-shaped with last-wins-by-name
  semantics (`runtime/service.ts:278-281`). OPEN QUESTION: what does "two indexers in the same
  stack" surface as in the manifest?
- **`pools` arg type asymmetry between local-deploy and known-package.** Local-deploy:
  `DeepbookPoolSpec[]` (with `tickSize`/`lotSize`/`minSize` bigints, `whitelisted?`, `stable?`).
  Known-package: `{name, poolId, baseType, quoteType}[]` (no tick/lot/min). Comment at
  `known-deployment.ts:71-77`: "Tick/lot/min not known from the registry — known-package consumers
  carry these themselves (e.g. inside `deepbookMarketMaker.pools[]`)". OPEN QUESTION: should
  known-package read from the registry's `coins`/`pools` snapshots automatically?
- **`DeepbookConfigEmitter` is in `codegen/emitters/deepbook-config.ts` — is that considered part of
  the deepbook component or part of codegen?** Per scope, codegen is owned by another doc. Mention
  here, defer to the codegen requirements doc.
- **`gatherManifest`'s last-write-wins-by-name semantics** (`runtime/service.ts:278-281`) for the
  four deepbook state registries. OPEN QUESTION: what's the expected behaviour if two
  `Deepbook(...)`'s appear in a stack — does the second silently overwrite?
- **No L1 unit tests for `Deepbook` (top-level facade) network-mode dispatch.** The unit equivalent
  of `deepbook.fork-known.docker.test.ts` lives at `engine/known-package.fork.test.ts` (P3.T1) — out
  of scope but referenced. OPEN QUESTION: should we have a non-docker test that mocks
  `resolveNetwork` to assert localnet→local-deploy and live→known-package dispatch?
- **Snapshot test scaffold has no test bodies.** `engine/snapshot-deepbook.docker.test.ts:43-50` is
  six `it.todo`. The requirements ARE encoded in the comments
  (`engine/snapshot-deepbook.docker.test.ts:6-34`) but they're not asserted in code. OPEN QUESTION:
  what's the actual blocker — fixture? sui-fork wiring? docker-image push?

## Opportunities noticed

- **Unify the four state registries.** A `DeepbookCompositeStateRegistry` keyed by sub-component (or
  a single `DeepbookStateRecord` with `indexer?`/`server?`/`margin?` slots) would let
  `runtime/service.ts::groupDeepbook` go through `defineServiceProjection` like every other service.
  The comment at `runtime/service.ts:164-168` already foreshadows this.

- **Centralise the cache key derivation.** Three different `onChainArtifact`-using factories
  (local-deploy, margin, margin-seed) AND one direct StateStore consumer (market-maker) reference
  the deepbook namespace by string literal. A
  `DeepbookCacheKeys.{pools,margin,marginSeed,marketMaker}` namespace would let tests + producers
  share a single source.

- **Extract `vendor.ts`'s `Move.toml` patching.** The regex-based git-dep rewriting at
  `vendor.ts:103-117` is general — it could move into `engine/move-toml.ts` or similar shared helper
  for the seal/pyth/etc. components that face the same problem.

- **Consider lifting `deepbookMarketMaker` to a top-level component.** It's not really "part of
  deepbook" — it consumes `DeepbookCoreTag` like any other consumer, and the BM cache + grid math
  could live independently. Today it's bundled with deepbook for convenience but the cross-cutting
  concerns (signer, refresh schedule, grid strategies) feel orthogonal.

- **The `DeepbookCore.findPool` closure is not testable in isolation.** `makeFindPool`
  (`internal.ts:117-142`) is exported but only consumed by local-deploy + known-package. A small
  typed accessor + a free-standing test would let consumers depend on it without going through a
  full layer build.

- **Reduce per-cycle BM mint cost in local-deploy's `marketMakerLayer`.** Cache the BalanceManager
  id at `deepbook/local-deploy/balance-manager/...` mirroring market-maker's per-pool cache. The
  pattern is already proven.

- **Improve discoverability of the `DeepbookMargin.seed` sugar.** The `Object.assign` pattern works
  but a separate `DeepbookMarginSeed` top-level export (alongside `DeepbookMargin`) would make
  autocomplete + go-to-definition work cleanly.

- **Eliminate the `'service'` vs `'action'` confusion for the market-maker.** It runs a forked fiber
  — it's behaviorally a service. The `kind` classification should reflect runtime behaviour, not
  setup-vs-runtime distinction.

- **Investigate sharing publishMove caches across margin+liquidation pair.** Today both
  `marginPublish` and `liquidationPublish` are independent siblings (`margin.ts:203-224`). Bundling
  them under a single `MultiPackagePublish` helper could reduce one supervisor cycle's worth of
  cache lookups.

- **The `DeepbookConfigEmitter` reads from `data.packages.deepbook.captured.deepTreasuryId` even
  though `services.deepbook.packageId` is _also_ the deepbook package id.** Both paths point to the
  same package; one of them is redundant. Reducing to a single canonical source would also remove
  the "Forgetting to pass `deepTreasuryId`" footgun documented at `local-deploy.ts:655-663`.

- **`vendorDeepbook`'s `DEEPBOOK_REPO` default uses HTTPS clone.** No auth tokens supported, no SSH
  variant. For private mirrors / offline CI, an additional `auth:` option would be useful.

- **`Deepbook(opts)`'s `local: Record<string, unknown>` is opaque**
  (`services/deepbook.ts:210-218`). Pass-through is convenient but defeats autocomplete + typecheck
  for the most common knob (`pools: [...]`). Could be typed as
  `Partial<Omit<DeepbookLocalDeployOptions, 'name'>>` without breaking compat.

- **Test fixtures cache-key derivations are duplicated.** `deepbook.test.ts:175-249` redefines
  `computePublishMoveSourceHash`, `computePublishMoveInputsHash`, `computePoolsHash`,
  `computeDeepbookPoolsInputsHash`. Sharing these between test files and the production code through
  a test-only export from `engine/cache.ts` would avoid drift.

- **The market-maker's `STATE_KEY_BALANCE_MANAGER_PREFIX_INTERNAL` export**
  (`market-maker.ts:603-604`) is the only opaque public-API-adjacent constant in the deepbook
  component — exposed "so tests can assert the key shape without re-deriving the string … Kept off
  the public API surface". A general convention for cache-key constants (e.g. all of them grouped in
  `services/deepbook/cache-keys.ts`) would be cleaner.

- **`indexer.ts:135-136` and `server.ts:155-157` both `void sui`** — Sui ref is yielded only for the
  layer-build edge. This pattern recurs across many sidecar containers in the codebase; a "depend on
  Sui purely for ordering" helper would be useful (and would make the `void sui` lines unnecessary).

- **`runtime/service.ts:164-204` builds the manifest by hand-folding four records.** Once a
  multi-registry projection shape lands, this can collapse into a single `defineServiceProjection`
  call.

- **The `DEFAULT_PREDEPOSIT_MULTIPLIER = 100n`** (`internal.ts:48`) is documented as "covers ~16
  refresh ticks of the full grid before any fills would draw the maker down" but that math is opaque
  from the constant alone — 100 _what_? A method (or a comment with the derivation) would help
  future maintainers.

- **Hard-coded `DEFAULT_DB_STATEMENT_TIMEOUT_MS = 60_000`** (`server.ts:49`) "matches sandbox's
  docker-compose `command:` arg." The single magic number reads as a generic Rust binary timeout but
  it actually drives Postgres query timeouts; a clearer name + grouping with related sidecar-binary
  constants would help.
