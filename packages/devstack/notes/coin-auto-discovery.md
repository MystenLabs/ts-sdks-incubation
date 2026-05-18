# coin auto-discovery + faucet implicit-wire plan

Living design doc + progress tracker. **This file is self-contained** — a fresh Claude/dev session should be able to pick up work by reading from the top and finding the first unchecked task in the current phase.

**Status:** Phase 0 not started. Last touched: 2026-05-18.

**Owner:** unassigned.

**Supersedes:** Themes 14 + 16 in `~/.claude/plans/crispy-noodling-kernighan.md`. Those themes were cosmetic (faucet file reshuffle, dropping unread manifest fields); this redesign attacks the actual user pain.

---

## How to resume in a clean session

1. Read § "Background" and § "Critical landmines" so you have the constraints.
2. Read § "Phase status" to find the current phase.
3. Inside that phase, find the first `- [ ]` (unchecked) item — that's your next task.
4. When a task completes, change `- [ ]` → `- [x]` in the same edit as the code change. Add a one-line `<!-- done YYYY-MM-DD by … -->` comment if useful.
5. A phase is complete when its **test gate** at the bottom of the phase section is fully green (all rows checked).
6. When all gate rows are checked, advance § "Phase status" to the next phase.

**Don't skip the test gates** — every coin/faucet change has a real-Docker e2e covering publish → discovery → faucet mint, plus a manifest snapshot covering the wider `CoinEntry` shape.

---

## Phase status

- [ ] **Phase 0** — discovery primitives (no behavior change)
- [ ] **Phase 1** — wider `CoinRecord` + `CoinEntry`; auto-populate alongside user-spec'd path
- [ ] **Phase 2** — `publishMove` uses discovery instead of `options.coins`
- [ ] **Phase 3** — `Coin()` factory family replaces `registerCoin`
- [ ] **Phase 4** — drop `options.coins` + `options.capture` from `PackageOptions`; capture moves to `/advanced`
- [ ] **Phase 5** — `Faucet` moves to `/advanced`; implicit auto-mount in `compose/defaults.ts`; codegen emits richer coin record

Phases are gated. Don't start phase N+1 until phase N's test gate is green. Phase 0 and Phase 1 land in sequence; Phases 3-5 each gate on the previous phase's e2e being green.

---

## Background

After a `Package(...)` publishes, `result.objectChanges` already contains every `0x2::coin::TreasuryCap<T>` and `0x2::coin::CoinMetadata<T>` created during `init`. The publish-receipt is structured data — you can parse `T` directly out of `objectType`. One `client.getCoinMetadata({ coinType })` RPC call returns symbol / decimals / name / iconUrl / description. Every field the user types in `coins: [{ name, module, type, decimals }]` and `capture: { treasuryCapId: '::coin::TreasuryCap<', metadataId: '::coin::CoinMetadata<' }` is derivable.

The pain isn't theoretical — `examples/wallet/devstack.config.ts:54-90` has the user typing `mock_usdc` / `MOCK_USDC` / `6` (and the matching `mweth` triple) **three times each**: in the Move source, in `Package({ coins: ... })`, and again in `registerCoin({ name, package, module, type, decimals })`. The `registerCoin` call is pure typed-data duplication of the `Package({ coins })` entry — it just produces a yieldable LayeredTag from the same fields.

The current architecture-review plan (`crispy-noodling-kernighan.md`) addresses this with:
- **Theme 14** (faucet consolidation): file-layout reshuffle. No API change.
- **Theme 16**: "drop `coin.type` + `coin.decimals` from `CoinEntry`, keep `sdkCoin`." Net effect: callers read `coin.sdkCoin.type` instead of `coin.type`. Same fields, different path. The hand-typed `decimals: 6` in `devstack.config.ts` survives untouched.

Neither theme touches the duplication. This plan does.

### Target user-facing shape

Before (today, wallet example):

```ts
const COIN_CAPTURE = {
  treasuryCapId: '::coin::TreasuryCap<',
  metadataId:    '::coin::CoinMetadata<',
  upgradeCapId:  '0x2::package::UpgradeCap',
} as const;

const usdc = Package('mock_usdc', USDC_DIR, {
  signer: publisher,
  capture: COIN_CAPTURE,
  coins: [{ name: 'musdc', module: 'mock_usdc', type: 'MOCK_USDC', decimals: 6 }],
});

const musdc = registerCoin({
  name: 'musdc',
  package: usdc,
  module: 'mock_usdc',
  type: 'MOCK_USDC',
  decimals: 6,
});
```

After:

```ts
const usdc = Package('mock_usdc', USDC_DIR, { signer: publisher });
const musdc = Coin('MUSDC');                        // symbol from CoinMetadata
// or: Coin.fromPackage(usdc, 'MOCK_USDC')          // collision-disambiguating
// or: Coin('0xdee9cc...::deep::DEEP')              // bare on-chain coin type
// or: Coin.builtin('sui')                          // 0x2::sui::SUI
```

Faucet wiring becomes implicit — supervised by `Devstack(...)`, no explicit `Faucet({ strategies })` call in user config. `Account({ funding: [...] })` takes a `coin: Coin | string` field that resolves at request time.

---

## Critical landmines

- **`pickCreatedByType*` helpers (`engine/sui-helpers.ts:20-58`) return the first match only.** A coin-discovery pass needs an *enumerating* variant. Add `pickAllCreatedByTypePrefix` alongside; do not refactor the existing pickers (other callers like `upgradeCapId` at `internal.ts:469` want first-match semantics).

- **`publishMove` caches the resolved `Package<TCaptured, CoinsRecord<TCoins>>` keyed by `(name, sourceHash, chainId)` (`internal.ts:303-305`).** The cached payload's `coins` field will gain `treasuryCapId` / `metadataId` / `symbol` / `name` / `iconUrl` / `decimals`. Cache entries written before the widening lack these fields; backfill defensively on cache hit (`internal.ts:323-330` already shows the precedent — `sdkCoin` is backfilled the same way after a prior widening).

- **`CoinMetadata` may not exist** if a coin module bypasses `coin::create_currency` (rare but legal). Discovery must not crash — coins without metadata are recorded with `decimals: undefined` + a warning span; faucet auto-registration skips them; `Coin('SYMBOL')` skips them. Plugin authors needing such coins go through `/advanced`.

- **`TreasuryCap` may be transferred at publish time** (DAO/shared-object patterns). The `'created'` entry's `c.owner.AddressOwner` reflects post-init ownership. Caps not owned by `signer.address` are recorded (so `Coin(...)` resolves them for read paths) but skipped for mint-strategy registration. Document as the "non-mintable coin" case.

- **Symbol collisions across packages.** Two packages both publishing `USDC`-symbol coins is legal. The default symbol-keyed registry stores both under fully-qualified `${packageId.slice(0,6)}.${witness}` keys; `Coin('USDC')` throws `CoinAmbiguousError` listing candidates; `Coin.fromPackage(pkg, 'USDC')` disambiguates.

- **RPC timing.** `getCoinMetadata` runs on publish's critical path. ~50-100ms per coin per publish for typical packages. Cached per process (consistent with `CoinRegistry`); doesn't survive across `runOneShot` boundaries.

- **`registerCoin` is publicly exported** at `index.ts:98-102` and used in every example app's `devstack.config.ts`. Removing it is a hard break. Repo is unreleased — per the existing plan's "no shims" stance, do the rename in one commit and update all consumers, no overlap period.

- **`metadataId` is captured today but not RPC-queried.** `examples/wallet/devstack.config.ts:54-58`'s `COIN_CAPTURE.metadataId` puts the object id on `pkg.captured.metadataId` for the dev-wallet UI's reference, but nothing in the codebase ever calls `client.getObject(metadataId)` or `client.getCoinMetadata(...)`. Confirmed: `grep -r "getCoinMetadata" packages/devstack/` returns zero hits today. This is brand-new RPC integration, not a refactor.

- **dev-wallet has its own `getCoinMetadata` call** (`packages/dev-wallet/src/ui/dev-wallet-signing.ts`, per the survey). After Phase 5 emits coin metadata into generated TS, the dev-wallet should read from the generated record and skip the per-coin RPC at UI boot. Mark as a follow-up; don't gate Phase 5 on it.

- **Wallet example's `seedTokens` action reaches `pkg.captured.treasuryCapId`** (`examples/wallet/devstack.config.ts:112-114`) to do `mint_and_transfer`. After Phase 4, this becomes `pkg.coins.MUSDC.treasuryCapId`. The change is one line per coin per action.

- **Live-net targets don't publish.** Discovery only runs on localnet inside `publishMove`. For live-net runs, `Coin('0x...::T')` (bare-string form) falls back to a direct `getCoinMetadata` lookup at first resolution. `Coin('MUSDC')` against a live target with no local manifest can't resolve — error message must point users at the bare-string form.

---

## Phase 0 — discovery primitives (no behavior change)

Adds new helpers + an Effect service. No existing code path changes.

- [ ] **0.1** Add `parseCoinTypeFromGeneric(objectType: string, wrapper: '0x2::coin::TreasuryCap' | '0x2::coin::CoinMetadata'): string | undefined` to `src/engine/sui-helpers.ts`. Strips wrapper prefix + angle brackets; validates inner type is `0xHEX::module::Witness`. Unit-test with table-driven cases (well-formed, malformed, wrong wrapper, nested generics, address with leading zeros).
- [ ] **0.2** Add `pickAllCreatedByTypePrefix(changes, prefix): ReadonlyArray<{ objectId, objectType, owner }>` to `src/engine/sui-helpers.ts` next to the existing single-result pickers. Returns full entries (not just object id) so callers can inspect `owner`. Unit-test against a synthetic objectChanges array.
- [ ] **0.3** Add `src/services/coin/discovery.ts` with `discoverCoinsFromPublish(changes, publisherAddress): ReadonlyArray<DiscoveredCoin>`. Pure function. Output shape: `{ coinType, witnessName, moduleName, treasuryCapId?, treasuryCapOwner, metadataId, publisherOwnsCap }`. Cross-references caps ↔ metadata by parsed coin type. Unit-test against a fixture publish receipt (real one captured from `examples/wallet` localnet).
- [ ] **0.4** Add `src/services/coin/loader.ts` with `CoinMetadataLoader` Effect.Service. Methods: `get(coinType)`, `getMany(coinTypes)`. Backed by `SuiTag.client.getCoinMetadata`. Cached in an `Effect.Ref<Map>`. Retry once on transient RPC failure (250ms backoff). Returns `Option<OnchainCoinMetadata>` — `None` for coins without `create_currency`.
- [ ] **0.5** Add real-Docker integration test `src/services/coin/discovery.docker.test.ts`. Publishes a two-coin package (existing `examples/wallet/move/mock_usdc` is the natural fixture). Asserts `discoverCoinsFromPublish` finds both coins with correct treasuryCapId. Asserts `CoinMetadataLoader.getMany` returns symbol `MUSDC` + decimals `6`.

### Phase 0 test gate

- [ ] `pnpm typecheck` clean.
- [ ] `pnpm exec vitest run --exclude '**/*.docker.test.ts'` — 0 failures (new unit tests pass; nothing else changed).
- [ ] `pnpm exec vitest run src/services/coin/discovery.docker.test.ts` — passes against real localnet.

---

## Phase 1 — wider `CoinRecord` + `CoinEntry`; populate alongside existing path

Widens schemas. Auto-discovery runs alongside the user-spec'd loop; data is additive.

- [ ] **1.1** Widen `CoinRecord` in `src/engine/registries.ts:82-97` to add `symbol?`, `name?`, `iconUrl?`, `treasuryCapId?`, `metadataId?`, `packageId?`. All optional in this phase (backwards compatible).
- [ ] **1.2** Widen `CoinEntry` in `src/runtime/manifest-schema.ts:113-118` with the same fields via `Schema.optional`. Update `Manifest` derived type accordingly.
- [ ] **1.3** Inside `publishMove` (`src/services/package/internal.ts:494-513`), after the user-spec coin loop finishes, run `discoverCoinsFromPublish(result.objectChanges, signer.address)`. Cross-reference with user-spec'd coins (match by full coin type). For each user-spec'd coin, augment its `CoinRecord` with the discovered `treasuryCapId` (already present) + `metadataId` + ownership. For discovered coins NOT in `options.coins`, log a warning but don't add to the registry yet (Phase 2 changes the loop).
- [ ] **1.4** Inside `publishMove`, after `publishPackage(...)`, call `CoinMetadataLoader.getMany(coinTypes)`. Fold symbol/decimals/name/iconUrl into each `CoinRecord` before `publishCoin(...)`. Compare RPC `decimals` against user-supplied `CoinSpec.decimals`; warn (don't fail) on mismatch.
- [ ] **1.5** `gatherManifest` (`src/runtime/service.ts:235-242`) widens its projection. Emit all fields present on the `CoinRecord`. Add an inline comment pointing to this plan.
- [ ] **1.6** Update `dapp-kit-config.ts` + `bindings.ts` emitters if they touch coins (per the survey, neither currently reads coin shape — confirm again before changing).
- [ ] **1.7** Backfill the publishMove cache rehydration (`internal.ts:323-330` precedent) for the new optional fields so existing on-disk caches survive the widening without forced wipe.

### Phase 1 test gate

- [ ] `pnpm typecheck` clean across devstack + dev-wallet + all examples.
- [ ] `pnpm exec vitest run --exclude '**/*.docker.test.ts'` — 0 failures (existing tests still pass; manifest-schema test may need fixture updates for new optional fields).
- [ ] `cd examples/wallet && pnpm dev` (manual) — boot, observe wallet status panel, confirm publish completes, check `.devstack/manifest.json` now contains `symbol`, `metadataId`, `iconUrl` on each coin entry.
- [ ] `cd packages/devstack && pnpm exec vitest run src/services/coin/discovery.docker.test.ts` — still green.

---

## Phase 2 — `publishMove` uses discovery instead of `options.coins`

The user-spec'd loop becomes the *override* path; discovery is authoritative.

- [ ] **2.1** Replace the spec loop in `src/services/package/internal.ts:473-513` with: iterate the discovered set; for each `DiscoveredCoin`, build a `PublishedCoin` directly from publish-receipt + CoinMetadata data. Skip TreasuryCaps not owned by `signer.address` for *mint registration only* (still record the coin).
- [ ] **2.2** Treat `options.coins` (if still present this phase) as overrides: a user-spec'd entry with the same coin type overrides the discovered `name` / `decimals`. Warn on override-without-match.
- [ ] **2.3** `registerMintStrategies` (`internal.ts:235-253`) drives off the discovered set. Already does the right thing; just change the input.
- [ ] **2.4** `Package` factory's `CoinsRecord<TCoins>` return type becomes `Record<symbol-or-witness-fallback, DiscoveredCoin>`. Update `internal.ts:136-147` `Package<TCaptured, ...>` shape.
- [ ] **2.5** Wallet example's `seedTokens` action (`examples/wallet/devstack.config.ts:108-131`) keeps working because `pkg.captured.treasuryCapId` still resolves via `capture:`. Defer the capture removal to Phase 4.

### Phase 2 test gate

- [ ] `pnpm typecheck` clean.
- [ ] `pnpm exec vitest run --exclude '**/*.docker.test.ts'` — 0 failures.
- [ ] All four example apps' playwright suites green: `_template`, `arena`, `private-content`, `wallet`. (The `effect-app` and any others if applicable.)
- [ ] `cd packages/devstack && pnpm test snapshot.docker.test.ts` — passes (snapshot subsystem unaffected by coin shape).
- [ ] Manual: wallet example's faucet panel still mints MUSDC/MWETH; balances format correctly.

---

## Phase 3 — `Coin()` factory family replaces `registerCoin`

The public API change. Single commit, every example migrated, `registerCoin` removed.

- [ ] **3.1** New `src/services/coin.ts` exports `Coin` with overloads: `Coin(symbol: string)`, `Coin(bareCoinType: string)` (auto-detected by `0x` prefix), `Coin.fromPackage(pkg, witness)`, `Coin.builtin('sui')`. Each returns a `LayeredTag<...>` resolving to `CoinValue`.
- [ ] **3.2** `Coin('symbol')` body: read `CoinRegistry` snapshot; find by symbol (case-insensitive); fail with `CoinAmbiguousError` on multiple matches; fail with `CoinNotFoundError` listing candidates on no match.
- [ ] **3.3** `Coin('0x...::T')` body: detect bare type form; call `CoinMetadataLoader.get(coinType)` directly; build `CoinValue` without consulting registry. Works on live-net targets where no local publish occurred.
- [ ] **3.4** `Coin.fromPackage(pkg, witness)` body: yield `pkg`, look up `pkg.coins[witness]` (witness-keyed access on the resolved Package shape).
- [ ] **3.5** `Coin.builtin('sui')` body: static record for `0x2::sui::SUI` + decimals 9 + symbol `SUI`. No registry roundtrip. (Other builtins like `WAL` if defensible.)
- [ ] **3.6** Update `src/index.ts:98-102` — remove `registerCoin`, `RegisterCoinOptions`, `RegisterCoinResult` exports. Add `Coin`, `CoinValue`, `CoinNotFoundError`, `CoinAmbiguousError`.
- [ ] **3.7** Update `index.test.ts` PUBLIC_EXPORTS pin.
- [ ] **3.8** Update every example app: replace `registerCoin(...)` calls with `Coin('SYMBOL')` or `Coin.fromPackage(...)`. Audit: `examples/wallet/devstack.config.ts:76-90` (2 calls), grep across `examples/`.
- [ ] **3.9** Update `examples/wallet/src/lib/deployment.ts:46-57` — drop the hardcoded `CoinSpec[]`; consume from the generated coin record (relies on Phase 1's wider manifest emission).

### Phase 3 test gate

- [ ] `pnpm typecheck` clean across devstack + dev-wallet + all examples.
- [ ] `pnpm exec vitest run --exclude '**/*.docker.test.ts'` — 0 failures.
- [ ] `grep -rn "registerCoin" packages/devstack/src/ examples/` returns 0 hits.
- [ ] All example apps' playwright suites green.
- [ ] Manual: `Coin('musdc')` (lowercase) and `Coin('MUSDC')` (uppercase) both resolve.
- [ ] Manual: `Coin('0xdee9cc...::deep::DEEP')` against testnet resolves via direct RPC (write a one-off harness; doesn't need a permanent test).

---

## Phase 4 — drop `options.coins` + `options.capture` from `PackageOptions`

Removes the redundant user-facing fields. `capture` moves to `/advanced`.

- [ ] **4.1** Remove `coins?: TCoins` and `capture?: CaptureSpec<...>` from `PackageOptions` in `src/services/package.ts:165-181`. Update `Package<TCaptured, CoinsRecord<TCoins>>` generic to `Package<DiscoveredCoinsRecord>` (single generic, derived from discovery).
- [ ] **4.2** Remove `CoinSpec` type from public surface. Move to internal-only in `internal.ts`.
- [ ] **4.3** New `/advanced` export: `PackageWithCapture(name, path, { signer, capture })` for plugin authors needing post-publish object extraction beyond coins. Underlying impl shares `publishMove`; capture is opt-in via this factory.
- [ ] **4.4** Wallet example's `seedTokens` (`examples/wallet/devstack.config.ts:108-131`) — replace `pkg.captured.treasuryCapId` with `pkg.coins.MUSDC.treasuryCapId` (and same for `mweth`/`MWETH`). Drop the `COIN_CAPTURE` constant entirely.
- [ ] **4.5** `examples/wallet/devstack.config.ts` final shape — confirm no `decimals` / `module` / `MOCK_USDC` / `capture` / `COIN_CAPTURE` mentions remain. (`grep -E "decimals|MOCK_USDC|MOCK_WETH|capture" examples/wallet/devstack.config.ts` → 0 hits.)
- [ ] **4.6** Audit every other example app: `_template`, `arena`, `private-content`, `effect-app`. Drop `capture:` and `coins:` from all `Package(...)` call sites.
- [ ] **4.7** Update `AGENTS.md` `Package(...)` section — document the auto-discovery contract + the `PackageWithCapture` escape hatch.

### Phase 4 test gate

- [ ] `pnpm typecheck` clean.
- [ ] `pnpm exec vitest run --exclude '**/*.docker.test.ts'` — 0 failures.
- [ ] All example apps' playwright suites green.
- [ ] `grep -rn "capture:" examples/` returns hits only inside `/advanced` plugin code or `PackageWithCapture` opt-ins.
- [ ] Manual: wallet example's faucet UI still mints; `seedTokens` still seeds alice/bob/carol via `pkg.coins.MUSDC.treasuryCapId`.

---

## Phase 5 — `Faucet` moves to `/advanced`; implicit auto-mount; richer codegen

The faucet stops being user surface; codegen emits the coin record into generated TS.

- [ ] **5.1** Remove `Faucet` from `src/index.ts` public exports. Add to `src/advanced/index.ts`. Update `index.test.ts` PUBLIC_EXPORTS pin.
- [ ] **5.2** `compose/defaults.ts` — auto-mount the implicit Faucet whenever any of: `SuiTag` is present (HTTP strategy from sui.faucet endpoint), `WalrusTag` is present (WAL exchange), any `Package` action exists (per-coin treasuryCapMintStrategy via `registerMintStrategies`).
- [ ] **5.3** No example app calls `Faucet(...)` directly today (already verified). Confirm and remove any lingering re-exports.
- [ ] **5.4** Codegen `dapp-kit-config.ts` (or a new sibling emitter `coins.ts`) — emit a typed record of every coin from the manifest: `{ MUSDC: { type, symbol, decimals, iconUrl, packageId, ... }, ... }`. Imported by the dev-wallet UI + example apps.
- [ ] **5.5** Update `packages/dev-wallet/src/ui/dev-wallet-balances.ts` and `dev-wallet-signing.ts` — read from the generated coin record at module load; skip per-coin `client.getCoinMetadata` calls at UI boot.
- [ ] **5.6** `Account({ funding })` shape — accept `coin: Coin | string | LayeredTag` in funding entries. Internally resolve to a coin type before passing to `faucet.requestCoin(coinType, address, amount)`.
- [ ] **5.7** Document the implicit-faucet contract in `AGENTS.md` — when it auto-mounts, what strategies it auto-registers, how plugin authors override via `/advanced`.

### Phase 5 test gate

- [ ] `pnpm typecheck` clean.
- [ ] `pnpm exec vitest run --exclude '**/*.docker.test.ts'` — 0 failures.
- [ ] Full real-Docker run: `pnpm exec vitest run` — passes including snapshot + integration suites.
- [ ] All example apps' playwright suites green.
- [ ] Manual: dev-wallet UI loads without per-coin RPC waterfall; symbols/decimals visible immediately after page paint.
- [ ] `grep -rn "Faucet(" examples/` returns 0 hits.
- [ ] `examples/wallet/devstack.config.ts` final LOC ≤ 160 (currently 238) and contains zero mentions of `decimals`, `MOCK_USDC`, `MOCK_WETH`, `capture`, `Faucet`.

---

## Open design decisions (defaults baked in)

1. **Symbol-keyed registry, case-insensitive lookup.** Storage uses the canonical CoinMetadata symbol (uppercase by Sui convention). `Coin('musdc')` and `Coin('MUSDC')` resolve identically. Fallback for collision: `${packageId.slice(0,6)}.${witness}`.

2. **`getCoinMetadata` on critical path.** One RPC per coin per publish. Cached for the process lifetime. Retry once on transient failure (250ms). Acceptable cost for the simplification.

3. **Coins without `create_currency`** (no CoinMetadata): recorded as caps-only; symbol resolution skips them; faucet skips them. Plugin authors with non-standard coins use `/advanced`.

4. **Live-net coin handles** route through bare-string form `Coin('0x...::T')`. `Coin('SYMBOL')` against live targets requires a local manifest snapshot (codegen output) or fails with a pointer at the bare-string form. Document.

5. **`Faucet()` retained on `/advanced`** for plugin authors registering custom strategies. The factory itself doesn't change shape; just its visibility.

6. **No shims.** Per the existing plan's stance, `registerCoin` is removed in one commit (Phase 3); every consumer migrates simultaneously. The repo is unreleased.

---

## Reused helpers (do not reinvent)

- `src/engine/sui-helpers.ts:20-58` — `pickCreatedByTypeSuffix`, `pickCreatedByTypeIncludes`. Add `pickAllCreatedByTypePrefix` alongside (Phase 0).
- `src/runtime/sdk-coin.ts:14-31` — `toSdkCoin`. Unchanged; still derives `sdkCoin` from `(fullCoinType, decimals)`.
- `src/engine/registries.ts:119-121,167-171` — `CoinRegistry` + `publishCoin`. Schema widens; mechanism unchanged.
- `src/services/package/internal.ts:235-253` — `registerMintStrategies`. Input set changes; logic unchanged.
- `src/services/package/internal.ts:469` — `pickCreatedByTypeSuffix(result.objectChanges, UPGRADE_CAP_TYPE_SUFFIX)` — already auto-captures the UpgradeCap. After Phase 4 this is the *only* auto-capture; everything else (TreasuryCap, CoinMetadata) flows through coin discovery.

---

## Composition with other plans

- **`crispy-noodling-kernighan.md` Themes 14 + 16**: superseded. Skip both.
- **`forking-from-mainnet-...md` Workstream D** (recursive Move imports): once D lands, the same discovery pass runs on synthetic publish receipts produced for transitively-imported packages. Upstream coins like DeepBook's `DEEP` get a `Coin('DEEP')` handle for free. The wallet example's hand-rolled DeepBook import block collapses fully. **No coupling**: D and this plan can land independently; their integration is implicit.
- **`forking-from-mainnet-...md` Workstream A** (accounts-as-signers): auto-faucet uses `ctx.accounts.get(publisherName)` to identify whose caps to register. Independent landing; no coupling.
- **`sui-fork-integration.md`**: fork mode unaffected. Forked-from-mainnet coins are addressed via `Coin('0x...::T')` bare-string form; no publish receipt to discover from.
- **`deepbook-plugin-expansion.md`**: deepbook's `mintFromTreasury` primitive (Phase 0 there) consumes coin handles; switching its API to take `Coin` LayeredTags instead of `(packageId, module, type)` triples is a natural composition. Land independently; integrate when both touch the same call site.

---

## Risks

- **`getCoinMetadata` flakiness.** RPC hiccup at publish leaves coins with `decimals: undefined`. Mitigation: 250ms backoff retry, then degrade gracefully (coin recorded, faucet skipped, warning logged). User can re-run `pnpm dev` to refresh.

- **Symbol collisions** (e.g. user's mock USDC + DeepBook's USDC). `CoinAmbiguousError` lists candidates; `Coin.fromPackage(pkg, ...)` disambiguates. Document the failure mode in the error message.

- **TreasuryCap transferred at publish** (DAO pattern, custom init). Coin still appears in registry without `treasuryCapId`; faucet skips. UI surfaces "read-only coin" state.

- **External plugin authors using `registerCoin`.** Repo is unreleased; no external consumers exist yet. If this assumption changes before Phase 3, add a one-release deprecation overlap.

- **Move source/`getCoinMetadata` decimals mismatch.** Phase 1.4 warns; doesn't fail. The RPC value is authoritative (it's what the chain sees); a user-supplied `decimals: 6` while the Move source uses `8` is a bug regardless. Loud warning is correct.

---

## Verification — end-to-end (definition of done)

After Phase 5:

```bash
# Wallet example boots cleanly with auto-discovered coins.
cd examples/wallet
pnpm stack new coin-fresh && pnpm stack use coin-fresh
pnpm dev   # vite + supervisor; status panel shows mock_usdc/mock_weth publish + auto-coin discovery
pnpm test:e2e

# Faucet manual smoke from dev-wallet UI:
#   - "Get MUSDC" → 1_000_000_000 lands in alice's balance, formatted with 6 decimals
#   - "Get MWETH" → likewise with 8 decimals
#   - "Get SUI"   → SUI HTTP faucet hits, 5 SUI lands

# Manifest snapshot:
cat .devstack/manifest.json | jq '.coins'
# Each entry has: type, symbol, name, decimals, iconUrl?, treasuryCapId?, metadataId, packageId, sdkCoin.

# Generated coin record (Phase 5):
cat examples/wallet/src/generated/coins.ts
# Typed record consumed by dev-wallet UI + example app components.

# Codegen + bindings unaffected:
cd packages/devstack && pnpm test snapshot.docker.test.ts

# Public API surface check:
grep -rn "registerCoin\|RegisterCoinOptions\|CoinSpec" packages/devstack/src/ examples/
# Expected: zero hits in public consumer code.

# Full unit suite:
pnpm test
```

A clean run of all of the above is the definition of done.
