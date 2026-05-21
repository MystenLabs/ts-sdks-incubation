# coin

## Purpose

The **coin** component is the user-facing primitive family for _addressing_ custom Move coin types
in a devstack composition. It does NOT publish Move modules itself — coin Move packages are
published by the **package** component (`services/package.ts`'s `Package(...)` factory), which runs
a _coin auto-discovery_ pass over every publish receipt and folds the results into the in-process
`CoinRegistry`. The `Coin(...)` factory family exposed by `services/coin.ts` is a set of small
`LayeredTag` factories that look the discovered records up by symbol, by package + witness, or by
bare on-chain coin type, plus one `mintFromTreasury` action primitive that wraps
`0x2::coin::mint_and_transfer<T>` with an idempotent state-store cache.

In short: the coin component is the \*registry-projection + name-resolution

- generic-mint layer\* over the publish machinery owned by **package**, with no separate Move source
  of its own.

Project-specific terminology used throughout this doc:

- **LayeredTag** — devstack's custom yieldable handle. A typed `(name, Effect, options)` triple
  constructed via `advanced/tag.ts::tag`. Carries dependency-edge metadata (`upstreamKeys`) the
  topological scheduler uses to order acquisition.
- **CoinRegistry** — a `Context.Service` (Effect-TS DI tag) whose value is an append-only
  `Ref<ReadonlyArray<CoinRecord>>` plus `{register, snapshot}` methods. Built by
  `defineRegistry<CoinRegistry, CoinRecord>(CoinRegistry)` in `engine/registries.ts`.
- **CoinRecord** — the value-shape stored in the registry; see `engine/registries.ts:166-225`.
- **CoinValue** — the value-shape every `Coin(...)` ref yields. Superset of `Package`'s `Coin` shape
  with all the discovery-populated fields.
- **PublishedCoin** — the runtime shape every entry of `pkg.coins[<key>]` satisfies inside the
  `Package(...)` resolved value (defined in `services/package/internal.ts:116-154`).
- **TreasuryCap** — `0x2::coin::TreasuryCap<T>`, the Move mint capability emitted by
  `coin::create_currency<W>` calls at publish time.
- **witness** — the empty Move struct passed to `coin::create_currency<W>(witness, decimals, …)`
  whose type name is baked into `T` (e.g. `MOCK_USDC`).

## Current implementation

| File (absolute)                                                                                | LOC | Summary                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/Users/michaelhayes/code/ts-sdks-incubation/packages/devstack/src/services/coin.ts`           | 613 | `Coin(...)` factory family (`coinByIdentifier` / `Coin.fromPackage` / `Coin.builtin`), `CoinValue` shape, `CoinNotFoundError` / `CoinAmbiguousError` error classes, `BUILTIN_COINS.sui` constant, `mintFromTreasury` action primitive + its `MintFromTreasuryOptions` / `MintFromTreasuryResult` / `TreasuryCapRef` / `CoinTypeRef` types, plus the `STATE_KEY_COIN_MINT_PREFIX` constant. |
| `/Users/michaelhayes/code/ts-sdks-incubation/packages/devstack/src/services/coin/discovery.ts` | 148 | Pure projection `discoverCoinsFromPublish(changes, publisherAddress) → ReadonlyArray<DiscoveredCoin>` over a publish receipt's `objectChanges`, returning `(coinType, witnessName, moduleName, treasuryCapId?, treasuryCapOwner?, metadataId?, publisherOwnsCap)` per coin. Pure — no Effect, no RPC.                                                                                      |
| `/Users/michaelhayes/code/ts-sdks-incubation/packages/devstack/src/services/coin/loader.ts`    | 207 | `CoinMetadataLoader` `Context.Service` for the gRPC `getCoinMetadata` RPC with process-lifetime cache, plus pure helpers `fetchCoinMetadataOnce` / `fetchCoinMetadataMany` (caller-supplied client). Defines `OnchainCoinMetadata`, the 5s timeout, the one-retry-at-250ms schedule, the `CoinMetadataLoaderLive` layer.                                                                   |

**Subtotal source LOC: 968** (613 + 148 + 207).

Test files in scope:

| File                                                                                                       | LOC | Summary                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/Users/michaelhayes/code/ts-sdks-incubation/packages/devstack/src/services/coin.test.ts`                  | 53  | L1 unit test for `mintFromTreasury`'s `Transaction` shape (1 `it`).                                                                                                                        |
| `/Users/michaelhayes/code/ts-sdks-incubation/packages/devstack/src/services/coin/discovery.test.ts`        | 159 | Unit coverage for `discoverCoinsFromPublish` against synthesized `SuiObjectChange[]` fixtures (8 `it`s).                                                                                   |
| `/Users/michaelhayes/code/ts-sdks-incubation/packages/devstack/src/services/coin/discovery.docker.test.ts` | 176 | Docker-gated L3 integration test booting `examples/wallet` and asserting the apply-time manifest's `coins.mUSDC` / `coins.mWETH` records carry the correct `symbol` + `decimals` (1 `it`). |

**Subtotal test LOC: 388** (53 + 159 + 176).

Coin-specific portions of adjacent files (in scope per the assignment):

| File                         | Lines   | Notes                                                                                                                                                                           |
| ---------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine/registries.ts`       | 166-225 | `CoinRecord` interface (the registry's value-shape — see [Capabilities PRODUCED](#capabilities-produced)).                                                                      |
| `engine/registries.ts`       | 251-253 | `CoinRegistry` `Context.Service` tag class (`'@devstack/CoinRegistry'`).                                                                                                        |
| `engine/registries.ts`       | 329-333 | `defineRegistry<CoinRegistry, CoinRecord>` destructure — exposes `CoinRegistryLive` / `publishCoin` / `requireCoinRegistry`.                                                    |
| `engine/registries.ts`       | 391     | `CoinRegistryLive` rolled into `RegistriesLive` via `Layer.mergeAll`.                                                                                                           |
| `engine/state-store-keys.ts` | 30-41   | `StateStoreKeys.coinMint({chainId, treasuryCapId, recipient, amount})` typed key builder. **NOT currently used by `services/coin.ts`** — see [Pain points](#pain-points-today). |

## Configuration

The coin component has **no first-class configuration knobs** in `defineDevstack` / CLI flags / env
vars. Everything is controlled by arguments to the user-facing factories:

| Knob                                                                                          | Where read                   | Default                                                                                              | Accepted values                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Coin(identifier)` — the identifier argument                                                  | `services/coin.ts:203`       | n/a (positional)                                                                                     | Three accepted forms: a CoinMetadata symbol or registry name (`'mUSDC'`, case-insensitive), a witness type name (also case-insensitive), or a bare on-chain coin type `'0xHEX::module::Witness'` detected via `isBareCoinType` (`services/coin.ts:130-131`). |
| `Coin.fromPackage(pkg, witness)` — `witness`                                                  | `services/coin.ts:300-303`   | n/a (positional)                                                                                     | A coin's registry key, symbol, or witness type name (case-insensitive match against any of those three on the resolved package's `coins.<key>` map).                                                                                                         |
| `Coin.builtin(name)` — `name`                                                                 | `services/coin.ts:366`       | n/a (positional)                                                                                     | Currently only `'sui'` (`BUILTIN_COINS` is `{sui: …}` at `services/coin.ts:139-149`). The `BuiltinCoinName` type narrows to `keyof typeof BUILTIN_COINS`.                                                                                                    |
| `mintFromTreasury({name, signer, treasuryCap, coinType, to, amount, gasBudget?, dependsOn?})` | `services/coin.ts:413-431`   | `gasBudget` defaults to `100_000_000n` (`services/coin.ts:545`); `dependsOn` defaults to `[]`.       | `treasuryCap` is `TreasuryCapRef` (string or `{fromPackage, capturedField}`); `coinType` is `CoinTypeRef` (string or `{fromPackage, module, type}`); `amount` is `bigint`; `to` is a `0x`-prefixed address.                                                  |
| `GET_COIN_METADATA_TIMEOUT_MS`                                                                | `services/coin/loader.ts:65` | `5_000` (5 seconds)                                                                                  | **Not user-configurable** — hardcoded module constant.                                                                                                                                                                                                       |
| `RETRY_SCHEDULE`                                                                              | `services/coin/loader.ts:77` | One retry at 250ms backoff (`Schedule.spaced('250 millis').pipe(Schedule.both(Schedule.recurs(1)))`) | **Not user-configurable**.                                                                                                                                                                                                                                   |

`STATE_KEY_COIN_MINT_PREFIX` (`services/coin.ts:388`) is a literal `'coin/mint'` constant — also not
user-configurable.

OPEN QUESTION: there is no `Coin({symbol, decimals, …})` style declaration factory. The `Coin`
factory only _consumes_ the registry; the registry is populated by `Package(...)` (and only by
`Package(...)` — see [Capabilities PRODUCED](#capabilities-produced) for the lone external producer
entry). The user-facing primitive for _declaring a new custom coin_ is to put a Move module
containing `coin::create_currency<W>(...)` into the package they pass to
`Package(name, path, {signer})` and let coin auto-discovery do the rest.

## Capabilities CONSUMED

### Other services / components

- **`SuiTag`** (`services/sui.ts`) — yielded by:
  - `coinByIdentifier`'s bare-coin-type branch (`services/coin.ts:210`) to get `sui.client` for the
    inline `fetchCoinMetadataOnce(sui.client, identifier)` call.
  - `coinByIdentifier`'s `upstreamKeys: [SuiTag.key]` (`services/coin.ts:287`) — the edge declared
    even when the symbol-path branch runs, so the topological scheduler doesn't race the
    registry-snapshot read ahead of Sui.
  - `mintFromTreasury` (`services/coin.ts:465`) for `sui.client.core.getObject` (cache verify) and
    `sui.chainId` (cache key prefix).
  - `CoinMetadataLoaderLive` (`services/coin/loader.ts:168`) for `sui.client`.
- **`StateStore`** (`engine/state-store.ts`) — yielded by `mintFromTreasury`
  (`services/coin.ts:467`) for the `state.get<CachedMint>(cacheKey)` / `state.put(cacheKey, …)` /
  `state.remove(cacheKey)` cache lifecycle (`services/coin.ts:517, 538, 585`).
- **`CoinRegistry`** — yielded by `coinByIdentifier`'s symbol-path branch (`services/coin.ts:238`)
  for the `registry.snapshot` read. The registry is itself populated externally by
  `services/package/internal.ts:638-649`'s `publishCoin(…)` calls inside the publish `register`
  hook.
- **Account signer** — `mintFromTreasury` yields `opts.signer` (`services/coin.ts:466`) and calls
  `signer.signAndExecute(t)` (`services/coin.ts:552`).
- **The publishing package tag** — `Coin.fromPackage(pkg, witness)` yields `pkg`
  (`services/coin.ts:307`) to force the dependency edge before reading `pkg.coins[witness]`.
  `mintFromTreasury` also yields the `fromPackage`-shaped `treasuryCapOpt.fromPackage` /
  `coinTypeOpt.fromPackage` refs (`services/coin.ts:478, 501`) when those option fields are the ref
  form rather than literal strings.

### Engine resources

- **`StateStore`** — see above. Cache key shape:
  `coin/mint/<chainId>/<treasuryCapId>/<recipient>/<amountStr>` (`services/coin.ts:512`). Built
  locally in `coin.ts` rather than via `StateStoreKeys.coinMint` (`engine/state-store-keys.ts:35`) —
  duplicate literal; see [Pain points](#pain-points-today).
- **No locks, no ports, no leases, no file-watcher, no paths** — coin has no host-process resources
  of its own.
- **Identity** — not directly consumed (`Sui` already exposes `chainId`).
- **Observability span attributes** — written to the current span via `Effect.annotateCurrentSpan`
  at `services/coin.ts:229-233, 272-276, 349-353, 505-510, 528, 537, 540` and
  `services/coin/loader.ts:131`. Span name `'CoinMetadataLoader.fetch'`
  (`services/coin/loader.ts:131`).

### Runtime resources

- **Container runtime / host fs**: none directly. Coin reads from in-process state. Indirectly,
  `mintFromTreasury` reaches the chain via `sui.client` (a `SuiGrpcClient`) which carries its own
  connection.

### Surfaces (TUI / log sink / event bus / command queue)

- **TUI display** — each `tag(...)` call passes a `display(s)` function
  (`services/coin.ts:282, 358, 370, 604-608`) the TUI uses to render the resolved value. Also
  `setPhase('resolving')` (`services/coin.ts:241`) and `setPhase('minting')`
  (`services/coin.ts:543`) push phase strings into the per-tag status surface.
- **Log warnings** — `services/coin/loader.ts:123` emits `Effect.logWarning` when an RPC degrades to
  `Option.none()`. No other log statements in the component.

### External (HTTP / RPC / system binaries / ports / sockets)

- **`getCoinMetadata` gRPC** against the Sui fullnode — fetched via
  `sui.client.core.getCoinMetadata({coinType})` in `services/coin/loader.ts:95`. Per-attempt timeout
  5s, one retry at 250ms. Hit by:
  - `coinByIdentifier`'s bare-coin-type branch (inline call via `fetchCoinMetadataOnce`),
  - The `CoinMetadataLoader.get` / `getMany` service path (used by the publish-discovery pass in
    `services/package/internal.ts:425-429`).
- **`getObject` gRPC** against the Sui fullnode — `sui.client.core.getObject({objectId})` in
  `services/coin.ts:521` for the mint-cache verify probe.

### Effect / Layer / Context machinery

- `Effect.gen`, `Effect.tryPromise`, `Effect.map`, `Effect.orElseSucceed`, `Effect.fail`,
  `Effect.timeoutOrElse`, `Effect.retry`, `Effect.catch`, `Effect.withSpan`,
  `Effect.annotateCurrentSpan`, `Effect.serviceOption`, `Effect.logWarning`, `Effect.forEach`,
  `Effect.ignore`, `Effect.mapError`.
- `Option.isSome` / `Option.some` / `Option.none`.
- `Schema.TaggedErrorClass`, `Schema.String`, `Schema.Array`, `Schema.optional`, `Schema.Defect`.
- `Schedule.spaced` / `Schedule.both` / `Schedule.recurs`.
- `Context.Service` (for `CoinMetadataLoader`).
- `Layer.effect` / `Layer.Layer` (for `CoinMetadataLoaderLive`).
- `Ref` (re-exported as `Ref as EffectRef`) for the loader cache map.
- Custom devstack substrate: `tag(...)` from `advanced/tag.ts` (the `LayeredTag` constructor),
  `setPhase` from same.

### Imports from other workspace packages

- `@mysten/sui/transactions::Transaction` — `services/coin.ts:28`, `services/coin.test.ts:10` (the
  `mintFromTreasury` Move call builder).
- `@mysten/sui/grpc::SuiGrpcClient` — `services/coin/loader.ts:23` (type parameter for the loader
  helpers and the live layer).

### npm dependencies

- `effect` — `Effect`, `Option`, `Schema`, `Context`, `Layer`, `Schedule`, `Ref` (via
  `Ref as EffectRef`).

### Internal devstack imports

- `../advanced/tag.js` — `tag`, `setPhase`, `LayeredTag` type (`services/coin.ts:29`).
- `../engine/registries.js` — `CoinRegistry`, `CoinRecord` type (`services/coin.ts:30`).
- `../engine/state-store.js` — `StateStore` (`services/coin.ts:31`).
- `../engine/errors.js` — `PublishError` (`services/coin.ts:32`). Coin re-uses `PublishError` rather
  than introducing a `MintError` — `mintFromTreasury`'s `phase` field is set to `'publish-tx'` on
  sign-execute failure / created-coin-not-found (`services/coin.ts:556, 573`) or `'publish-tx'` on
  captured-field-missing (`services/coin.ts:483`).
- `../engine/sui-helpers.js` — `pickCreatedByType` (`services/coin.ts:33`, used at
  `services/coin.ts:567-569` to find the minted `Coin<T>` object by type substring);
  `parseCoinTypeFromGeneric` + `pickCreatedByType` (`services/coin/discovery.ts:23`).
- `../engine/shared.js` — `Account`, `SuiObjectChange` types (`services/coin.ts:37`,
  `services/coin/discovery.ts:24`).
- `./sui.js` — `SuiTag` (`services/coin.ts:34`, `services/coin/loader.ts:24`).
- `../runtime/sdk-coin.js` — `toSdkCoin` (`services/coin.ts:35`).
- `./coin/loader.js` — `fetchCoinMetadataOnce` (`services/coin.ts:36`).
- `./package.js` — type-only `Coin as CoinShape` (`services/coin.ts:38`).
- `../../engine/stringify-cause.js` — `stringifyCause` (`services/coin/loader.ts:25`).

## Capabilities PRODUCED

### TypeScript exports consumed elsewhere

Exported from `services/coin.ts`:

- `Coin: CoinFactory` (`services/coin.ts:376-379`) — the factory family (re-exported as `Coin` from
  `src/index.ts:133`).
- `CoinFactory` (type) — `services/coin.ts:189-198`. Public surface: `(identifier) → LayeredTag<…>`,
  `fromPackage(pkg, witness) → LayeredTag<…>`, `builtin(name) → LayeredTag<…>`.
- `CoinValue` (interface) — `services/coin.ts:94-101`. Re-exported from `src/index.ts:135`.
- `BuiltinCoinName` (type) — `services/coin.ts:151`. Re-exported from `src/index.ts:136`.
- `CoinNotFoundError` (class) — `services/coin.ts:49-62`. Re-exported from `src/index.ts:137`.
- `CoinAmbiguousError` (class) — `services/coin.ts:68-78`. Re-exported from `src/index.ts:138`.
- `mintFromTreasury` (function) — `services/coin.ts:458-610`. **NOT re-exported from `src/index.ts`
  or `advanced/index.ts`** — only `services/deepbook/mint.ts:11` imports it via the relative path.
  See [Pain points](#pain-points-today).
- `MintFromTreasuryOptions` (interface) — `services/coin.ts:413-431`.
- `MintFromTreasuryResult` (interface) — `services/coin.ts:440-446`.
- `TreasuryCapRef` (type) — `services/coin.ts:393-403`.
- `CoinTypeRef` (type) — `services/coin.ts:405-411`.
- `STATE_KEY_COIN_MINT_PREFIX_INTERNAL` (string) — `services/coin.ts:613`. Test-only export (per the
  comment); no production consumer.

Exported from `services/coin/discovery.ts`:

- `DiscoveredCoin` (interface) — `services/coin/discovery.ts:57-65`.
- `discoverCoinsFromPublish` (function) — `services/coin/discovery.ts:95-147`. Consumed only by
  `services/package/internal.ts:422` (via the `./coin/discovery.js` import at
  `services/package/internal.ts:28`).

Exported from `services/coin/loader.ts`:

- `OnchainCoinMetadata` (interface) — `services/coin/loader.ts:33-40`.
- `CoinMetadataLoaderShape` (interface) — `services/coin/loader.ts:47-52`.
- `CoinMetadataLoader` (Context.Service tag) — `services/coin/loader.ts:54-57`. Tag key
  `'@devstack/CoinMetadataLoader'`.
- `fetchCoinMetadataOnce` (function) — `services/coin/loader.ts:90-133`. Imported by both
  `services/coin.ts:36` and `services/package/internal.ts:29` (via `fetchCoinMetadataMany`).
- `fetchCoinMetadataMany` (function) — `services/coin/loader.ts:140-158`. Imported by
  `services/package/internal.ts:29` for the publish-discovery pass.
- `CoinMetadataLoaderLive` (Layer) — `services/coin/loader.ts:165-206`. **NOT currently composed
  into `services/runtime/service.ts`'s default layer** — see [Open questions](#open-questions).

### State-store entries

| Key shape                                                     | Value shape                                                                                                           | Producer                                                                                                                                                                                                  |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `coin/mint/<chainId>/<treasuryCapId>/<recipient>/<amountStr>` | `CachedMint = {digest: string, mintedCoinId: string, recipient: string, amount: string}` (`services/coin.ts:433-438`) | `mintFromTreasury` (`services/coin.ts:584-591`). Cached after a successful `0x2::coin::mint_and_transfer` tx; cleared via `state.remove` on cache hit + missing on-chain object (`services/coin.ts:538`). |

Note: `engine/state-store-keys.ts:35-41` defines `StateStoreKeys.coinMint(...)` with the IDENTICAL
key shape; `services/coin.ts` uses the literal local prefix
`STATE_KEY_COIN_MINT_PREFIX = 'coin/mint'` (`services/coin.ts:388`) plus inline template
interpolation (`services/coin.ts:512`) rather than calling the typed builder. The
`engine/state-store-keys.test.ts:23-42` test asserts both produce the same string. See
[Pain points](#pain-points-today).

### Registry entries

`CoinRegistry` (declared in `engine/registries.ts:251-253`) stores `CoinRecord` entries:

```ts
// engine/registries.ts:166-225
interface CoinRecord {
	readonly name: string; // registry key — discovered symbol, or witness fallback
	readonly type: string; // 0xPKG::module::Witness
	readonly decimals: number; // from on-chain CoinMetadata; 0 fallback
	readonly sdkCoin?: { address; type; scalar }; // SDK-aligned projection
	readonly symbol?: string; // CoinMetadata.symbol
	readonly displayName?: string; // CoinMetadata.name
	readonly iconUrl?: string; // CoinMetadata.iconUrl
	readonly treasuryCapId?: string;
	readonly metadataId?: string;
	readonly packageId?: string;
}
```

The coin component itself only READS the registry (in `coinByIdentifier`'s symbol-path branch,
`services/coin.ts:238-239`). The only producer is `services/package/internal.ts:638-649` which calls
`publishCoin({…})` inside the publish `register` hook (runs on every cache-hit AND cache-miss
publish — `services/package/internal.ts:613-617`).

### Files written

None directly by `services/coin.ts` or its subdirectory.

The discovery-populated `CoinRecord`s flow through `gatherManifest()` (`runtime/service.ts:325-338`)
into `manifest.coins.<name>` per the `CoinEntry` schema (`runtime/manifest-schema.ts:182-193`):

```ts
// runtime/manifest-schema.ts:182-193
CoinEntry = {
  type: string;
  decimals: number;
  sdkCoin: { address, type, scalar };
  symbol?: string;
  displayName?: string;
  iconUrl?: string;
  treasuryCapId?: string;
  metadataId?: string;
  packageId?: string;
}
```

The manifest is written to `<appDir>/.devstack/stacks/<stack>/manifest.json` by
`runtime/manifest-emit.ts`. Codegen emitter `codegen/emitters/stack-handle.ts:114-131, 199-203`
projects `manifest.coins` into a generated `<outputDir>/coins.ts`:

```ts
export const coins = { mUSDC: { type, decimals, sdkCoin, ... } } as const;
export type CoinName = keyof typeof coins;
```

The `deepbook-config` emitter (`codegen/emitters/deepbook-config.ts:300-317`) also projects
`manifest.coins` into the SDK-aligned `CoinMap` it emits for DeepBook SDK consumers.

### Endpoints / Events / CLI commands / Routes / Containers

- **None.** Coin produces no HTTP endpoints, emits no event-bus events, registers no CLI commands,
  registers no routes, builds no container images or volumes. It is entirely an in-process API
  surface plus state-store cache plus registry projection.

### Side-effects on other components

- **Faucet** (`services/faucet/index.ts`) — `services/package/internal.ts:256-280` registers a
  `treasuryCapMintStrategy` for every discovered coin where `publisherOwnsCap === true`.
  Implementation in `services/faucet/strategies/treasury-cap-mint.ts` directly mirrors
  `mintFromTreasury` but without the state-store cache. This is the cross-cut that lets
  `Account({funding: {SUI: …, '0xpkg::usdc::USDC': 1_000_000n}})` mint custom coins through the
  unified faucet abstraction. Side-effect of the publish, not of the coin component directly —
  included here for completeness.

## Lifecycle

### Startup

The coin component has **no layer-side startup**. The factories construct LayeredTags at
config-evaluation time, but no Effect runs until a downstream ref _yields_ the tag during the
engine's parallel layer build.

Per-resolution startup paths:

1. **`Coin('SYMBOL')` (symbol path)** —
   - Yields `CoinRegistry` (`services/coin.ts:238`).
   - Calls `registry.snapshot` (`services/coin.ts:239`).
   - Runs `resolveBySymbol` (`services/coin.ts:240`) on the in-memory snapshot.
   - Returns a `CoinValue` (`services/coin.ts:277`) or fails with `CoinNotFoundError` /
     `CoinAmbiguousError` (`services/coin.ts:246, 261`).
2. **`Coin('0x…::T')` (bare-coin-type path)** —
   - Yields `SuiTag` (`services/coin.ts:210`).
   - Runs `fetchCoinMetadataOnce(sui.client, identifier)` (`services/coin.ts:211`) — 5s timeout, one
     250ms retry.
   - Returns a `CoinValue` (`services/coin.ts:234`) — degrades to `decimals: 0` and no
     symbol/displayName/iconUrl when RPC returns `Option.none()`.
3. **`Coin.fromPackage(pkg, witness)`** —
   - Yields `pkg` (`services/coin.ts:307`).
   - Reads `resolved.coins[witness]` with case-insensitive fallback across three keyings
     (`services/coin.ts:312-335`).
   - Returns the `CoinValue` (`services/coin.ts:353`) or fails with `CoinNotFoundError` listing the
     package's `coins` keys (`services/coin.ts:340`).
4. **`Coin.builtin('sui')`** —
   - No yield. Returns `BUILTIN_COINS.sui` synchronously (`services/coin.ts:367`).
5. **`mintFromTreasury({…})`** —
   - Yields each `dependsOn` entry sequentially (`services/coin.ts:462-464`).
   - Yields `SuiTag`, `signer`, `StateStore` (`services/coin.ts:465-467`).
   - Resolves `treasuryCapId` — either the literal string, or yields `treasuryCapOpt.fromPackage`
     and reads `captured[capturedField]` (`services/coin.ts:473-493`).
   - Resolves `fullCoinType` — either the literal string, or yields `coinTypeOpt.fromPackage` and
     builds `${pkg.packageId}::${module}::${type}` (`services/coin.ts:496-503`).
   - Computes cache key `coin/mint/<chainId>/<treasuryCapId>/<to>/<amount>`
     (`services/coin.ts:512`).
   - `state.get<CachedMint>(cacheKey)`:
     - On `Some` — runs `sui.client.core.getObject({objectId: mintedCoinId})`
       (`services/coin.ts:521`). If the object still exists, returns the cached result
       (`services/coin.ts:528-536`). Otherwise removes the stale cache entry and falls through
       (`services/coin.ts:537-539`).
   - Sets phase `'minting'` (`services/coin.ts:543`).
   - Builds + signs + executes `0x2::coin::mint_and_transfer<T>` (`services/coin.ts:544-561`).
   - `pickCreatedByType(result.objectChanges, {includes: '0x2::coin::Coin<…>'})` finds the minted
     coin id (`services/coin.ts:567-569`). Fails with `PublishError` if not found.
   - Writes the cache entry (`state.put(cacheKey, …)`, best-effort `Effect.ignore` — see invariants)
     (`services/coin.ts:584-591`).
   - Returns `MintFromTreasuryResult`.

### Ready criteria

Each ref's `ready` is "the returned value has been yielded once". There is no per-component
readiness signal. Indirect readiness:

- `Coin('SYMBOL')` is "ready" when the upstream `Package(...)` that publishes the coin has resolved
  — the user is responsible for including the publishing `Package(...)` in `needs:` or in the
  `devstack(...)` composition before the consumer (`services/coin.ts:15-20`).
- `Coin.fromPackage(pkg, …)` yields `pkg` first, so the dep edge is forced automatically.
- `Coin.builtin('sui')` is always ready (no upstream).

### Restart behavior

- **`Coin(...)` refs** — idempotent. Each acquisition re-reads the registry snapshot / re-runs the
  RPC. No per-cycle state.
- **`CoinRegistry`** — in-memory per supervisor cycle (the `Ref` is created fresh inside
  `CoinRegistryLive` per `Layer.effect`, `engine/define-registry.ts:32-39`). Restart means the
  registry is empty and must be repopulated by the publish pass.
- **`mintFromTreasury`** — cache-keyed in `StateStore`. A restart that preserves `chainId` and the
  treasury-cap id (typical for hot-restart and for resume) reuses the cached mint. A regenesis (new
  `chainId`) misses the cache and re-mints. A republish under a new TreasuryCap (different
  `treasuryCapId`) also misses. On cache hit, the verify probe (`getObject(mintedCoinId)`) ensures
  the minted coin still exists; if it doesn't, the cache entry is removed and the mint re-runs
  (`services/coin.ts:518-541`).
- **`CoinMetadataLoaderLive` cache** — in-process per layer invocation
  (`services/coin/loader.ts:169`). Restart wipes it; the publish pass re-fetches at most one RPC per
  coin per cycle.

### Teardown

- **No finalizers.** `services/coin.ts` does not register any `Effect.addFinalizer` / `Scope`
  resource. The factories construct pure `LayeredTag` values; the state-store cache writes persist
  across the layer-scope close.
- **CoinMetadataLoaderLive** — no finalizer either. The `Ref`-backed cache dies with the layer's
  scope per Effect-v4 semantics.

## Hard requirements / invariants

The coin component is small and has few load-bearing invariants of its own; most live in the
_package_ component (the producer side). The ones that DO live in coin:

1. **Cache-hit verify probe must run before returning** — `services/coin.ts:518-541`. The
   `mintFromTreasury` cache hit verifies the minted coin object still exists on chain; a cache hit
   pointing at a vanished coin (chain wipe, manual deletion, etc.) MUST re-mint, not return stale
   data. Without the verify probe, the cached digest would be used to claim a balance that no longer
   exists.

2. **Cache write is best-effort (`Effect.ignore`)** — `services/coin.ts:585-591`. Per the comment at
   `services/coin.ts:582-583`: "The mint already settled on chain; a state-store IO defect just
   means the next supervisor cycle re-mints (acceptable cost)." Don't let a StateStore failure roll
   back the mint.

3. **Bare-coin-type heuristic** —
   `isBareCoinType(s) = s.startsWith('0x') && s.includes('::') && s.split('::').length === 3`
   (`services/coin.ts:130-131`). This MUST agree with what `getCoinMetadata` accepts as a coin-type
   argument — otherwise the bare-string branch either misclassifies symbols as types (and the RPC
   throws) or vice versa. Tested transitively by the docker test
   (`services/coin/discovery.docker.test.ts:151-154`) and the discovery test for the embedded coin
   type regex (`services/coin/discovery.test.ts:142-148`).

4. **Builtin SUI shape** — `BUILTIN_COINS.sui` MUST always be `'0x2::sui::SUI'` with `decimals: 9`
   (`services/coin.ts:140-148`). These are protocol-defined; any divergence breaks every consumer
   that compares `coin.fullCoinType` against the canonical SUI string (e.g. the deepbook-config
   emitter SUI guard at `codegen/emitters/deepbook-config.ts:270-272`).

5. **Symbol resolution is case-insensitive but exact** — `services/coin.ts:169-174` lowers both
   sides and compares against both `symbol` and `name` fields. The "two records pointing at the same
   coin type" branch (`services/coin.ts:181-182`) treats multi-key hits as a single match — without
   this, the registry's "register-once-per-key-shape" pattern (where the same coin can be indexed by
   both its symbol and its name) would surface as `CoinAmbiguousError`.

6. **Discovery returns deterministic order** — `discoverCoinsFromPublish` sorts ascending by coin
   type (`services/coin/discovery.ts:145`). The `services/package/internal.ts:466-473` collision
   guard ("each coin's CoinMetadata symbol should be unique within a package") relies on this
   determinism so the same coin always wins on collision across re-runs. Asserted by
   `services/coin/discovery.test.ts:67-69`.

7. **Discovery refuses nested generics** — `services/coin/discovery.ts:113-114` and
   `engine/sui-helpers.ts:311-314`. A `TreasuryCap<A<B>>` returns `undefined` and the coin is
   skipped, NOT guessed at. Asserted by `services/coin/discovery.test.ts:142-148`.

8. **`getCoinMetadata` failures degrade, do not throw** — `services/coin/loader.ts:121-129`. A
   timeout or RPC error after one retry returns `Option.none()` (logged as a warning); the discovery
   pipeline keeps going. Per the comment at `services/coin/loader.ts:64-71`, a flaky publish-time
   RPC blip shouldn't fail the whole supervisor cycle — the next cycle picks it up.

9. **`mintFromTreasury` minted-coin lookup matches on the inner generic** —
   `pickCreatedByType(result.objectChanges, {includes: '0x2::coin::Coin<${fullCoinType}>'})`
   (`services/coin.ts:567-569`). Per the comment: the inner generic carries the full coin type so
   the includes-substring is unambiguous. The 53-line L1 test (`services/coin.test.ts`) pins this
   Move-call shape directly.

10. **`coinByIdentifier`'s `upstreamKeys: [SuiTag.key]`** — `services/coin.ts:287`. Per the
    PGR-comment at `services/coin.ts:283-287`: the symbol-path branch reads `CoinRegistry` (a
    `Context.Service`, not a stack-graph node, so it's invisible to the topo scheduler). Declaring
    `SuiTag` is enough to pin the edge — the same dependency chain that produced Sui also produced
    every `Package(...)` whose publish folds into the registry.

## Failure modes

| Trigger                                                                   | Current behavior                                                                                                                                                                                               | Recovery path                                                                                                                               |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `Coin('FOO')` where no record matches                                     | Fails with `CoinNotFoundError` (`services/coin.ts:246-258`). Error message lists every registered symbol/name and points at `needs:` / `devstack(...)` ordering or the bare-on-chain / builtin escape hatches. | User adds the publishing `Package(...)` to `needs:` (or fixes the symbol).                                                                  |
| `Coin('FOO')` matching multiple distinct coin types                       | Fails with `CoinAmbiguousError` (`services/coin.ts:261-270`). Error message lists candidate full types and points at `Coin.fromPackage(pkg, witness)`.                                                         | User disambiguates via `Coin.fromPackage`.                                                                                                  |
| `Coin('0x…::T')` against an unknown bare coin type                        | `fetchCoinMetadataOnce` returns `Option.none()` after one retry + warning log. Returns a degraded `CoinValue` with `decimals: 0` and no symbol/displayName/iconUrl (`services/coin.ts:213-228`).               | Downstream consumers that need metadata see degraded fields; no error path.                                                                 |
| `Coin('0x…::T')` against an RPC timing out                                | After the 5s + 250ms retry, degrades to `Option.none()` as above.                                                                                                                                              | Implicit — next acquisition retries.                                                                                                        |
| `Coin.fromPackage(pkg, 'WIT')` with witness not in `pkg.coins`            | Fails with `CoinNotFoundError` listing available keys (`services/coin.ts:338-348`).                                                                                                                            | User fixes the witness name.                                                                                                                |
| `mintFromTreasury` — `treasuryCap.fromPackage.captured` missing the field | Fails with `PublishError({phase: 'publish-tx', message: "package did not capture treasury cap under field '…'"})` (`services/coin.ts:482-491`).                                                                | User fixes the `capturedField` name in the `PackageWithCapture` lambda or directly supplies `treasuryCap` as a string id.                   |
| `mintFromTreasury` — `signAndExecute` failure                             | Fails with `PublishError({phase: 'publish-tx', message: "sign+execute failed: <cause.message>"})` (`services/coin.ts:553-561`).                                                                                | Caller's responsibility; typically a chain-side issue (insufficient gas, cap not held, etc.).                                               |
| `mintFromTreasury` — minted `Coin<T>` not found in `objectChanges`        | Fails with `PublishError({phase: 'publish-tx', message: "minted Coin<…> not found in objectChanges (digest=…)"})` (`services/coin.ts:570-578`).                                                                | Indicates either a chain bug or a Move-source mismatch (a custom `mint_and_transfer` that doesn't emit `Coin<T>`). Caller's responsibility. |
| `mintFromTreasury` — cache hit, but on-chain object vanished              | Removes cache entry (`services/coin.ts:538`) and falls through to a fresh mint.                                                                                                                                | Automatic.                                                                                                                                  |
| `mintFromTreasury` — cache write fails                                    | `Effect.ignore` (`services/coin.ts:591`); the mint return value is still produced and the next cycle re-mints.                                                                                                 | Acceptable cost.                                                                                                                            |
| Discovery — `TreasuryCap<A<B>>` nested generic                            | `parseCoinTypeFromGeneric` returns `undefined`; the cap is skipped. Coin doesn't surface in `coins`.                                                                                                           | None — by design (refuses to guess).                                                                                                        |
| Discovery — coin with only a TreasuryCap, no CoinMetadata                 | Coin surfaces with `metadataId: undefined`, `decimals: 0`, no symbol/displayName/iconUrl (`services/package/internal.ts:439-443`). `treasuryCapId` IS populated.                                               | Downstream consumers degrade (faucet skips coins without `publisherOwnsCap`; balance UI shows undefined symbol).                            |
| Discovery — coin with only a CoinMetadata, no cap                         | Coin surfaces with `treasuryCapId: undefined`, `publisherOwnsCap: false` (`services/coin/discovery.ts:127, 131`).                                                                                              | Mint via faucet is gated off (`services/package/internal.ts:271`); reads still work.                                                        |
| Discovery — two coins in one package emit the same CoinMetadata symbol    | Collision-guard at `services/package/internal.ts:466-473` logs a warning and keeps the first occurrence (deterministic by coin-type sort).                                                                     | Move source author should make CoinMetadata symbols unique within a package.                                                                |

## Persistence model

- **What survives restart (state-store entries, on-disk paths):**
  - `coin/mint/<chainId>/<treasuryCapId>/<recipient>/<amount>` cache entries in the JSON state
    store. Survive process restart (state store is disk-backed under `<appDir>/.devstack/state.json`
    per `engine/state-store.ts`). The mint is short-circuited on next cycle as long as the verify
    probe finds the minted coin still on chain.
- **What survives snapshot:** OPEN QUESTION: I did not trace through the snapshot machinery in this
  audit. The state-store keys ARE part of the state-store, which is included in snapshot bundles per
  the snapshot docs; assume yes — but the chainId-keyed coin-mint entries become inert on
  snapshot-restore against a different chainId (cache miss is the safe outcome).
- **What gets wiped on `devstack wipe`:** the whole state store, so coin/mint entries are wiped. The
  `CoinRegistry` is purely in-process so it has nothing to wipe.
- **What is process-local only:**
  - `CoinRegistry`'s `Ref<ReadonlyArray<CoinRecord>>` — fully in-memory. Repopulated by the
    publish-discovery pass on every supervisor cycle (the publish itself caches across restarts via
    `publishMove`'s own `(sourceHash, chainId)` cache).
  - `CoinMetadataLoaderLive`'s `Ref<Map<string, OnchainCoinMetadata>>` — fully in-memory
    (`services/coin/loader.ts:169`). Per the comment at `services/coin/loader.ts:11-15`: "Why
    per-process (not in-StateStore): the metadata is keyed by full coin type, which already folds
    the packageId. A fresh chain (new genesis) means new packageIds, which means the cache misses
    naturally. Persisting across `runOneShot` boundaries is unnecessary — both ends of the boundary
    re-derive from a fresh publish receipt."

## Modes & variants

The coin component is mode-aware only indirectly — it has no configuration that flips behavior based
on network. The `Coin(...)` factory family resolves the same way regardless of network; differences
arise from what the registry contains, which is itself a function of which `Package(...)` refs are
in the stack (and whether the chain supports publishes at all).

| Dimension                                                       | local (`network: 'localnet'`, bundled sui-localnet)                                                                                                                      | fork (`network: 'mainnet-fork'` / `'testnet-fork'`, sui-fork container)                                                                                                                                                                                                                                                                                                                                                                        | live (`network: 'mainnet'` / `'testnet'`, external RPC only)                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Move package publish (the producer of CoinRegistry entries)** | Fully supported. `Package(...)` builds + publishes via `sui` CLI through `buildMove` + `signer.signAndExecute`. Coin auto-discovery runs over the fresh publish receipt. | Supported in principle (publish is a regular tx the fork container accepts), but the fork's pre-existing on-chain coins are NOT introspected — only newly-published coins surface in `CoinRegistry`. OPEN QUESTION: confirmed via `services/sui.ts` fork-mode shape; no explicit test fixture for coin discovery on fork.                                                                                                                      | Publish does run against the live RPC and the publisher does hold the resulting `TreasuryCap`, per `services/faucet/strategies/treasury-cap-mint.ts:8-13` comment, but the comment also says "auto-faucet for live networks isn't a thing devstack tries to do" — `Account({funding})` against a live coin is the user's responsibility.                       |
| **`Coin('SYMBOL')` resolution**                                 | Symbol-keyed lookup against the in-memory `CoinRegistry` snapshot. Same in every mode.                                                                                   | Same as local — the registry contains whatever was published in THIS supervisor cycle. Mainnet/testnet coins inherited by the fork are NOT in the registry; user must reach for `Coin('0x…::T')`.                                                                                                                                                                                                                                              | Same as fork — registry only contains user-published coins. For live-net coins like mainnet DEEP, user reaches for `Coin('0x…::deep::DEEP')`.                                                                                                                                                                                                                  |
| **`Coin('0x…::T')` resolution**                                 | Live `getCoinMetadata` against the localnet RPC. Works for coins published in this stack; fails (degraded) for not-yet-published types.                                  | Live `getCoinMetadata` against the fork's gRPC. Works for both inherited mainnet coins AND newly-published ones — the fork answers `getCoinMetadata` for all of them.                                                                                                                                                                                                                                                                          | Live `getCoinMetadata` against the configured external RPC. Per `services/coin.ts:22-25`: "Live-net coin handles route through the bare-string form `Coin('0x…::T')` — it calls `getCoinMetadata` directly against the resolved `SuiTag`, bypassing the registry. Use when the coin exists on the target chain but no local publish runs (e.g. mainnet DEEP)." |
| **`Coin.builtin('sui')`**                                       | Pure constant; no upstream. Same in every mode.                                                                                                                          | Same.                                                                                                                                                                                                                                                                                                                                                                                                                                          | Same.                                                                                                                                                                                                                                                                                                                                                          |
| **`mintFromTreasury`**                                          | Works against the bundled sui-localnet. Signer must hold the cap.                                                                                                        | Works against the fork. Signer must hold the cap (cap origin must be a publish in this stack, since fork inherits mainnet caps but `Account` impersonation only signs txs whose `sender` you control — separate domain).                                                                                                                                                                                                                       | Works against external RPC. Same cap-ownership constraint as fork.                                                                                                                                                                                                                                                                                             |
| **CoinMetadataLoader gRPC dispatch**                            | `sui.client` → bundled localnet gRPC. 5s timeout.                                                                                                                        | `sui.client` → fork-container gRPC. 5s timeout.                                                                                                                                                                                                                                                                                                                                                                                                | `sui.client` → external gRPC (mainnet/testnet fullnode). 5s timeout may be tight on a slow network; one retry.                                                                                                                                                                                                                                                 |
| **State-store cache key**                                       | `coin/mint/<localnet-chainId>/...`. New chainId every regenesis.                                                                                                         | `coin/mint/<fork-chainId>/...`. Fork uses a stable chainId per upstream + checkpoint.                                                                                                                                                                                                                                                                                                                                                          | `coin/mint/<mainnet-or-testnet-chainId>/...`. Stable.                                                                                                                                                                                                                                                                                                          |
| **Inherited coins on fork**                                     | N/A (clean chain).                                                                                                                                                       | Per the assignment's "Out of scope" prompt, the user expects fork mode to inherit mainnet/testnet coins. From my read: fork mode does NOT auto-register inherited coins into `CoinRegistry`. The registry is populated only by `publishCoin` calls (`services/package/internal.ts:638-649`) inside this stack's publish pass. To address an inherited coin the user passes `Coin('0xmainnet…::T')`. **NO** test exercises this. OPEN QUESTION. | N/A — `Coin('0x…::T')` against the live RPC is the documented path.                                                                                                                                                                                                                                                                                            |
| **Persistence**                                                 | `StateStore` persists mint receipts; `CoinRegistry` is process-local.                                                                                                    | Same. Mint receipts keyed by fork chainId.                                                                                                                                                                                                                                                                                                                                                                                                     | Same. Mint receipts keyed by live chainId — survive restarts within the same network.                                                                                                                                                                                                                                                                          |
| **Teardown**                                                    | No coin-specific finalizers in any mode. The state-store cache survives by design (state-store has its own snapshot/wipe lifecycle).                                     | Same.                                                                                                                                                                                                                                                                                                                                                                                                                                          | Same.                                                                                                                                                                                                                                                                                                                                                          |
| **Failure modes**                                               | See [Failure modes](#failure-modes). All paths exercised in mode = local.                                                                                                | Same paths. The RPC degradation path is more likely on fork (cold-start fork containers can be slow).                                                                                                                                                                                                                                                                                                                                          | Same paths. The RPC degradation path is most likely live (network-dependent).                                                                                                                                                                                                                                                                                  |
| **Dependencies**                                                | `SuiTag`, `StateStore`, `CoinRegistry`, `Account` (signer).                                                                                                              | Same.                                                                                                                                                                                                                                                                                                                                                                                                                                          | Same.                                                                                                                                                                                                                                                                                                                                                          |
| **Hard requirements**                                           | All requirements 1-10 from [Hard requirements / invariants](#hard-requirements--invariants).                                                                             | Same.                                                                                                                                                                                                                                                                                                                                                                                                                                          | Same.                                                                                                                                                                                                                                                                                                                                                          |

The "mode" here is really _Sui mode_ — the coin component itself is mode-blind. See `13-sui.md` (sui
doc) for the underlying network discriminator.

## Test coverage

### `services/coin.test.ts`

L1 unit test for the `mintFromTreasury` Move-call builder. Total: 1 `describe`, 1 `it`.

- `describe('mintFromTreasury tx-builder shape')` (`coin.test.ts:12`)
  - `it('produces 0x2::coin::mint_and_transfer<T> with (cap, amount, recipient) args')`
    (`coin.test.ts:13-52`) — Constructs a `Transaction` directly, invokes the same
    `moveCall({target, typeArguments, arguments})` shape as `services/coin.ts:546-550`, then
    inspects `t.getData().commands` and asserts: `commands.length === 1`; the command is a
    `MoveCall` (`$kind === 'MoveCall'`); the package is `0x0000…0002` (sui framework); the module is
    `coin`; the function is `mint_and_transfer`; `typeArguments` is `[fullCoinType]`;
    `arguments.length === 3`.

**Coverage gap:** the full `mintFromTreasury` flow (cache, sign+execute, state-store interactions,
`pickCreatedByType` minted-coin lookup) is NOT covered by an L1 test. The header comment at
`coin.test.ts:1-7` states "the full mint + state-store cache flow is covered by the L3 docker tests"
— OPEN QUESTION: I did not find an L3 docker test that targets `mintFromTreasury` specifically. The
deepbook-full example does exercise `DeepbookMintDEEP` / `DeepbookMintUSDC` which both wrap
`mintFromTreasury`, so the docker coverage exists but it's downstream of deepbook.

### `services/coin/discovery.test.ts`

Unit coverage for `discoverCoinsFromPublish`. Total: 1 `describe`, 8 `it`s.

- `describe('discoverCoinsFromPublish')` (`discovery.test.ts:35`)
  - `it('finds a single coin from a publish receipt with TreasuryCap + CoinMetadata')` (`:36-54`) —
    Given a `published` change + `UpgradeCap` + `TreasuryCap<MOCK_USDC>` +
    `CoinMetadata<MOCK_USDC>`, returns exactly one `DiscoveredCoin` with all fields populated and
    `publisherOwnsCap: true`.
  - `it('finds two coins from a single publish (multi-currency module)')` (`:56-73`) — Multi-coin
    publish (USDC + WETH) returns both, stable-sorted by `coinType`, both with
    `publisherOwnsCap: true`.
  - `it('flags publisherOwnsCap=false when the cap was transferred to another owner')` (`:75-85`) —
    Cap with `owner: OTHER_OWNER` ≠ publisher returns `publisherOwnsCap: false`,
    `treasuryCapOwner: OTHER_OWNER`.
  - `it('flags publisherOwnsCap=false when the cap has no address-owner (shared/object owner)')`
    (`:87-100`) — Cap with no `owner` field (devstack projection drops non-AddressOwner) returns
    `publisherOwnsCap: false`, `treasuryCapOwner: undefined`, `treasuryCapId` still populated.
  - `it('surfaces a coin with only a TreasuryCap (custom init, no CoinMetadata)')` (`:102-117`) —
    Only-cap case surfaces with `metadataId: undefined`, `publisherOwnsCap: true`.
  - `it('surfaces a coin with only a CoinMetadata (very unusual, but valid)')` (`:119-130`) —
    Only-metadata case surfaces with `treasuryCapId: undefined`, `publisherOwnsCap: false`.
  - `it('ignores non-coin objects (UpgradeCap, generic mutated changes)')` (`:132-140`) — Random
    non-`TreasuryCap`/`CoinMetadata` changes return `[]`.
  - `it('ignores TreasuryCap with nested generics (refuses to guess)')` (`:142-149`) —
    `TreasuryCap<A<B>>` is dropped; returns `[]`.
  - `it('returns empty for a publish that created no coins')` (`:151-157`) — Publish with only an
    `UpgradeCap` returns `[]`.

### `services/coin/discovery.docker.test.ts`

Docker-gated L3 integration. Auto-skips when Docker isn't reachable (`:47-53, 56`) and when
`examples/wallet/.devstack/imports/mystenlabs_deepbookv3@v7.0.0` vendor is missing (`:62-65`).
Total: 1 `describe.skipIf`, 1 `it`.

- `describe.skipIf(!SHOULD_RUN)('coin discovery against real Docker (examples/wallet)')` (`:120`)
  - `it('CoinMetadataLoader returns symbol + decimals matching the Move source')` (`:128-160`) —
    Runs `apply` against `examples/wallet` (publishes `mock_usdc` + `mock_weth`). Reads
    `manifest.json` and asserts `manifest.packages.{mock_usdc, mock_weth}.id` are truthy, then
    asserts `manifest.coins.{mUSDC, mWETH}.symbol` equals `'mUSDC'` / `'mWETH'` and `decimals`
    equals `6` / `8`. Per the comment (`:142-150`): the manifest record is the durable proof that
    the upstream `getCoinMetadata` + the loader projection produced the right shape.

**NOTE on scope** (`:18-30`): Phase 0's `discoverCoinsFromPublish` is NOT re-tested here — the unit
test at `discovery.test.ts` covers the pure function against synthesized `objectChanges`. The docker
test exercises only the loader half of the pipeline.

## Pain points today

1. **Cache key duplication.** `services/coin.ts:388, 512` builds the `coin/mint/...` key inline via
   `STATE_KEY_COIN_MINT_PREFIX` + template interpolation, while `engine/state-store-keys.ts:35-41`
   has a typed `StateStoreKeys.coinMint({...})` builder for the IDENTICAL key shape. The
   state-store-keys.test.ts test pins the equivalence. The pattern per the state-store-keys
   doc-comment is "New keys land here, never at the callsite" (`engine/state-store-keys.ts:9`) —
   `mintFromTreasury` predates / sidesteps that convention. Consolidating would also let
   `STATE_KEY_COIN_MINT_PREFIX_INTERNAL` (`services/coin.ts:613`, a test-only export) be deleted.

2. **`mintFromTreasury` is not exported from the public barrel.** `src/index.ts:132-139` exports
   `Coin`, `CoinFactory`, `CoinValue`, `BuiltinCoinName`, `CoinNotFoundError`, `CoinAmbiguousError`
   — but NOT `mintFromTreasury`. The only consumer is `services/deepbook/mint.ts:11` (via relative
   import). Either:
   - `mintFromTreasury` is intended to be internal-only, in which case `MintFromTreasuryOptions` /
     `MintFromTreasuryResult` / `TreasuryCapRef` / `CoinTypeRef` shouldn't be exported either, or
   - it should be promoted to `src/index.ts` (it's a useful generic primitive for non-deepbook mint
     flows).

3. **`PublishError` reused for mint errors.** `mintFromTreasury` raises
   `PublishError({phase: 'publish-tx', ...})` on multiple distinct failures
   (`services/coin.ts:482, 553, 570`). A `MintError` would semantically separate "the publish
   failed" from "the mint failed". This matters most for downstream `catchTag` callers — they
   currently can't distinguish "package didn't publish" from "package published fine but the
   post-publish mint barfed".

4. **`Coin('SYMBOL')` does NOT auto-derive a dependency edge on the publisher.** Per the header
   comment at `services/coin.ts:15-20`: "`Coin('SYMBOL')` reads the live `CoinRegistry` snapshot at
   acquire time — it does NOT auto-derive a dependency edge on the publisher. Consumers that need
   the coin available BEFORE acquisition must include the publishing `Package(...)` in their
   `needs:` list (or in the `devstack(...)` composition before the consumer)." This is a footgun:
   the registry IS a `Context.Service` so the type system can't see the producer→consumer edge.
   `Coin.fromPackage` forces the edge explicitly, but a user who reaches for `Coin('SYMBOL')`
   because it's the "obvious" API may race and get `CoinNotFoundError`.

5. **`CoinMetadataLoaderLive` is not wired into the runtime layer.** It's exported from
   `services/coin/loader.ts:165-206` but I found no `Layer.mergeAll` reference to it in the runtime
   composition path. The `publishMove` path uses the _pure helper_ `fetchCoinMetadataMany` directly
   with its own client (`services/package/internal.ts:29, 425-429`), and `coinByIdentifier`'s
   bare-coin-type branch uses `fetchCoinMetadataOnce` directly (`services/coin.ts:36, 211`). Per the
   loader header comment (`:1-9, 11-15`): the cache is "process-lifetime" and the publish-discovery
   pass is the main consumer. But since the publish pass bypasses the cached service shape and goes
   straight to the pure helper, **the cache effectively never warms** — every discovery batch is a
   cold cache. The `CoinMetadataLoader` `Context.Service` tag exists but has no in-production
   consumers. See [Open questions](#open-questions).

6. **Three accepted forms for `Coin.fromPackage(pkg, witness)` keying.** `services/coin.ts:312-335`
   tries: literal `coins[witness]`, then case-insensitive against `key`, against `entry.symbol`,
   against `entry.type` (the Move struct name). Per the comment (`services/coin.ts:291-299`): "The
   trifecta covers users who pass the symbol ('mUSDC'), the witness ('MOCK_USDC'), or the registry
   key ('musdc') interchangeably." This is convenient but means the same `witness` argument can
   resolve to different coins depending on collision shape. Documenting the precedence (literal >
   key > symbol > type) in user-facing docs would prevent surprises.

7. **`STATE_KEY_COIN_MINT_PREFIX_INTERNAL` (test-only export).** `services/coin.ts:613` exports the
   literal `'coin/mint'` so tests can assert the key shape. No production consumer. Pure leakage —
   the test should test the _typed builder_ in `engine/state-store-keys.ts` instead, which already
   has equivalent coverage at `engine/state-store-keys.test.ts:23-42`.

8. **No CoinError tag at all.** `CoinNotFoundError` / `CoinAmbiguousError` are tagged errors via
   `Schema.TaggedErrorClass`, but they're scoped to the _factory_, not the mint flow. Mint errors
   are folded into `PublishError`. A `CoinError` discriminated union (with `NotFound`, `Ambiguous`,
   `MintFailed`, `CapMissing`) would unify the error surface.

## Open questions

1. **Fork mode and inherited coins.** Does fork mode auto-register mainnet/testnet coins into
   `CoinRegistry`? My read says no — the only producer is `publishCoin` inside the publish pass, and
   there's no fork-mode "scan and register every known coin on the upstream" bootstrapping. The
   assignment's "Fork mode" prompt implies this is expected behavior. Confirm via fork-mode docker
   test: does `Coin('0xmainnet…::T')` succeed against a `'mainnet-fork'` Sui by going through the
   bare-string + RPC branch (yes, almost certainly) AND does `Coin('USDC')` against an inherited
   mainnet USDC fail with `CoinNotFoundError` because nothing published USDC into THIS stack (yes,
   almost certainly)? No existing test covers either path.

2. **Is `CoinMetadataLoader`'s cache reachable in production?** Per
   [Pain point #5](#pain-points-today), the live layer is exported but no consumer yields the tag.
   `publishMove` uses the pure helper directly to avoid layer-plumbing per the loader header comment
   (`services/coin/loader.ts:81-87`). Is `CoinMetadataLoader` the `Context.Service` shape dead code
   today, kept against future consumers? Confirm by grepping for `yield* CoinMetadataLoader` in
   production paths (I found none).

3. **What does "Coin works in fork mode" mean operationally?** The `notes/coin-auto-discovery.md`
   file referenced in the source header comments (`services/coin.ts:3-4, services/package.ts:5`) is
   NOT present in `packages/devstack/notes/` based on my listing. The referenced design doc was
   likely deleted as a completed-plan per the memory entry
   `feedback_completed_plans_should_be_deleted`. Without it, the canonical answer to "how should
   fork mode behave WRT inherited coins" lives only in the source comments.

4. **Snapshot interaction.** Per the snapshot prompt: do the coin/mint state-store entries survive
   snapshot? They're in the state-store, so yes — but they're keyed by chainId, so a
   snapshot-restore against a different chainId (or after a regenesis) makes them inert. I did NOT
   trace this through `engine/snapshot.ts` / `engine/snapshot-restore.ts` to confirm; assume yes per
   state-store behavior.

5. **Where do the `services/sui.ts` system-`CoinRegistry` (object id `0xc`,
   `services/deepbook/internal.ts:21-25`) and `services/coin.ts`'s `CoinRegistry` interact?** They
   share the name "CoinRegistry" but are completely different things:
   - `services/coin.ts`'s `CoinRegistry` is a devstack-internal Effect `Context.Service` for
     tracking discovered coins per cycle.
   - `services/deepbook/internal.ts:COIN_REGISTRY_OBJECT_ID = '0xc'` is the on-chain Sui framework
     shared object holding `0x2::coin_registry` state, used by deepbook's margin path for
     `finalize_registration` / `migrate_legacy_metadata`. These don't interact at all — but the name
     collision is a footgun for anyone reading the code. Worth a rename of the devstack-internal one
     (`PublishedCoinRegistry`?).

6. **`SuiTag.key` vs `SuiTag` in `upstreamKeys`.** `services/coin.ts:287` uses `SuiTag.key` (the
   Context.Service `.key` accessor) — other primitives use the bare tag. OPEN QUESTION: are these
   equivalent? The `upstreamKeys` array accepts both per the comment at `services/coin.ts:283-287`,
   but the typing isn't fully clear from this file alone. (Not blocking — the test fixtures pass.)

## Opportunities noticed

1. **Consolidate the `coin/mint/*` state-store key path.** Use `StateStoreKeys.coinMint(...)` from
   `engine/state-store-keys.ts:35-41` instead of the local `STATE_KEY_COIN_MINT_PREFIX` constant.
   Drop the `STATE_KEY_COIN_MINT_PREFIX_INTERNAL` test-only export and migrate
   `state-store-keys.test.ts` if anything still asserts the prefix shape via `services/coin`.

2. **Promote `mintFromTreasury` to the public barrel.** Or, if it's intentionally internal, hide its
   types alongside it. The current state (mint function NOT in `src/index.ts` but its option types
   ARE exported via the relative `services/deepbook/mint.ts` consumer chain) is inconsistent.

3. **Either wire `CoinMetadataLoader` into the runtime layer (and have `publishMove`'s discovery
   pass yield it) OR delete the `CoinMetadataLoaderLive` layer entirely.** As-is, the cache never
   warms in production because the publish-discovery pass uses the pure helper. If the answer is
   "delete," the file shrinks ~40 lines.

4. **Introduce a `CoinError` tagged-class union.** Replace `CoinNotFoundError` /
   `CoinAmbiguousError` / the `PublishError`-with- coin-message overload pattern with a
   discriminated union that `catchTags(['CoinError'])` can handle uniformly. Mint failures should
   not surface as `PublishError`.

5. **Rename the devstack-internal `CoinRegistry`** (currently `engine/registries.ts:251`, tag key
   `'@devstack/CoinRegistry'`) to something like `PublishedCoinRegistry` or `LocalCoinRegistry` to
   avoid colliding semantically with Sui's on-chain `0x2::coin_registry::CoinRegistry` system object
   (used by deepbook margin at `services/deepbook/internal.ts:21-25`).

6. **Document the `Coin.fromPackage` keying precedence** in the JSDoc block at
   `services/coin.ts:291-299` more prominently — including the collision behavior when both a
   `coins['MOCK_USDC']` entry AND a `coins['musdc']` entry exist with different `.symbol` values.

7. **`isBareCoinType`** (`services/coin.ts:130-131`) duplicates responsibility with `COIN_TYPE_RE`
   in `engine/sui-helpers.ts` (the regex `parseCoinTypeFromGeneric` uses at line 315). The local
   helper could call `COIN_TYPE_RE.test(s)` for the structural check instead of the loose
   `startsWith('0x') && includes('::')` heuristic — the regex also enforces the hex-only address
   slot which the heuristic does not.

8. **The `coinByIdentifier` tag's `upstreamKeys: [SuiTag.key]` (`services/coin.ts:287`) is correct
   but only by virtue of "Sui is always upstream of every Package(...) publish that populates the
   registry."** If a future composition published into `CoinRegistry` from a non-Sui-rooted path,
   the symbol-resolve branch would race. A more direct edge would be `[publishingPackageTag]` — but
   that's exactly what `Coin.fromPackage` already does, and the user calling `Coin('SYMBOL')`
   accepts the looser ordering as a UX trade. Worth capturing in the design doc.

9. **`coin/loader.ts:67-71` says "5s is generous for a healthy localnet (typically <100ms)"** — but
   the fork and live modes can be much slower, especially on a cold-start fork container. Consider
   per-mode timeouts (e.g. 5s localnet, 15s fork/live) or making `GET_COIN_METADATA_TIMEOUT_MS`
   configurable.

10. **The `services/coin/discovery.docker.test.ts` test's manifest assertion is the SOLE end-to-end
    verification of the coin metadata pipeline.** And its only assertions are on `symbol` and
    `decimals` of two specific fixtures. The other fields populated by `gatherManifest()` into
    `manifest.coins` (`displayName`, `iconUrl`, `treasuryCapId`, `metadataId`, `packageId`,
    `sdkCoin`) are NOT asserted. A second `it` block in that file (or a new docker test elsewhere)
    should pin those — they're load-bearing for the dev-wallet UI and for `Coin.fromPackage`
    precedence.

11. **`BUILTIN_COINS` has only `sui`.** If `WAL` (or any other "always present in our test stacks"
    coin) starts getting hardcoded in multiple emitters (cf. the SUI/DEEP seeding in
    `codegen/emitters/deepbook-config.ts:267-294`), the `BUILTIN_COINS` record is the natural home —
    but right now it's a one-entry constant. Either keep it that way deliberately or move DEEP/WAL
    constants there.
