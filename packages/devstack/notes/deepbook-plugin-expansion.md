# deepbook plugin expansion plan

Living design doc + progress tracker. **This file is self-contained** — a fresh Claude/dev session should be able to pick up work by reading from the top and finding the first unchecked task in the current phase.

**Status:** Phase 0 not started. Last touched: 2026-05-18.

**Owner:** unassigned.

---

## How to resume in a clean session

1. Read § "Background" and § "Critical landmines" so you have the constraints.
2. Read § "Phase status" to find the current phase.
3. Inside that phase, find the first `- [ ]` (unchecked) item — that's your next task.
4. When a task completes, change `- [ ]` → `- [x]` in the same edit as the code change. Add a one-line `<!-- done YYYY-MM-DD by … -->` comment if useful.
5. A phase is complete when its **test gate** at the bottom of the phase section is fully green (all rows checked).
6. When all gate rows are checked, advance § "Phase status" to the next phase.

**Don't skip the test gates** — they prevent silent regressions. Every new primitive ships with at least one real-Docker e2e test, per the user-mandated constraint that every feature is fully tested e2e with Docker.

**Audit findings preserved in this document.** Four subagent surveys were run on 2026-05-18 covering the existing devstack deepbook surface, the deepbook-sandbox repo, devstack's Docker + test infrastructure, and codegen + manifest emission. Their findings are folded into the per-phase task lists below — you don't need to re-run them.

---

## Phase status

- [ ] **Phase 0** — DX foundations (bps grid, perPool BM, mintFromTreasury, vendorDeepbook)
- [ ] **Phase 1** — Pyth oracle + pusher fiber + `pythMid` Ref helper
- [ ] **Phase 2** — Postgres primitive + DeepBook indexer container
- [ ] **Phase 3** — DeepBook server container (REST API)
- [ ] **Phase 4** — Margin primitive (publish + pools + seed)
- [ ] **Phase 5** — Codegen `deepbookConfig` emitter + `examples/deepbook-full/` reference app

Phases are gated. Don't start phase N+1 until phase N's test gate is green. Phase 1 and Phase 2 can be executed in parallel by separate contributors after Phase 0.

---

## Background

### What the deepbook plugin is today

Three Effect-layer factories under `packages/devstack/src/services/deepbook/`:

- `deepbookLocalDeploy(opts)` (`local-deploy.ts`) — publishes a vendored deepbook-v3 Move package + creates whitelisted pools. Provides `DeepbookCoreTag`, `DeepbookAdminTag`, `DeepbookMarketMakerTag`. State-store cached at `deepbook/pools/v1/<chainId>/<packageId>/<poolsHash>` with on-chain `objectType` verification on resume.
- `deepbookKnownPackage(opts)` (`known-package.ts`) — wraps a canonical testnet/mainnet deployment; provides `DeepbookCoreTag` only (no admin cap).
- `deepbookMarketMaker(opts)` (`market-maker.ts`) — long-running grid maker as an in-process Effect fiber. Caches BalanceManager id at `deepbook/market-maker/balance-manager/v1/<chainId>/<packageId>/<signer.address>` and re-resolves dynamic mid/size each tick.

Sole consumer: `examples/wallet/devstack.config.ts:135` declares two pools (SUI/USDC, SUI/WETH) using mock coins and a hardcoded mid price. Tests at `packages/devstack/src/services/deepbook.test.ts` cover known-package resolution and the create-pools cache (in-memory, no docker).

### What the deepbook-sandbox is

A separate Mysten repo at `~/code/deepbook-sandbox` (and `https://github.com/MystenLabs/deepbook-sandbox`). A one-command Docker stack covering the full DeepBook V3 protocol surface:

- **6 Move packages** published in order: `token` → `deepbook` → `{pyth, usdc}` → `deepbook_margin` → `margin_liquidation`. 4 come from a `external/deepbook/` submodule; `pyth` + `usdc` are sandbox-owned.
- **Pyth oracle**: `setupPythOracles` creates 3 `PriceInfoObject`s for SUI/DEEP/USDC; a 10s-cadence pusher fetches historical-24h prices from `benchmarks.pyth.network` and calls `update_single_price_feed`. Dedicated keypair to avoid gas-coin contention.
- **Margin pools**: per-asset MarginPools with ~17 risk parameters each, oracle wired via `new_pyth_config + add_config`, seeded liquidity via `mint_supplier_cap + supply`.
- **Indexer** (`deepbook-indexer` Rust binary): reads checkpoints from sui-localnet's shared volume, writes events to Postgres.
- **Server** (`deepbook-server` Rust binary): REST API on `:9008` reading from Postgres.
- **Faucet API** (`deepbook-sandbox-api` Hono service): SUI proxy + signed DEEP/USDC transfers.
- **Dashboard** (React/nginx): Health, Market Maker, Trading, Faucet, Deployment pages.
- **Per-service keypairs**: separate Ed25519 signers for deployer, oracle, market-maker, so gas-coin selection doesn't race.

### What devstack does that sandbox doesn't (preserve these)

- **Resume across `pnpm dev` restarts** via state-store caches with on-chain verify. Sandbox always `FORCE_REGENESIS=true`.
- **Type-safe pool lookup**: `DeepbookCoreTag.findPool({ base, quote })` and `pools[name]` are statically narrowed.
- **Coin-tag composition**: pool `base`/`quote` accept tags from `registerCoin`, resolved at layer build.
- **Network polymorphism**: `Deepbook(opts)` picks local-deploy on localnet, known-package on testnet/mainnet — same callsite.
- **Declarative layer graph + tag-driven dependencies**.
- **Snapshot/restore**: full stack `docker commit` + `state.json` capture.

### Critical landmines (risk register)

Behaviors non-obvious from a casual read that shape the design. Each has a mitigation tracked in the relevant phase.

| # | Behavior | Source | Mitigation phase |
|---|---|---|---|
| R1 | Upstream deepbook v3 Move API churn (renames, arg shape changes) → every `moveCall` aborts | `external/deepbook` upstream | Phase 0 (image pairing table); 2/3 (build-from-source escape hatch) |
| R2 | Pyth feed identifier rotation → on-chain PriceInfoObjects don't match registry | `sandbox/scripts/oracle-service/constants.ts:13-26` | Phase 1 (surface feeds in manifest, source-of-truth in `known-deployments.ts`) |
| R3 | Rust binary CPU arch — sandbox uses `-arm64` suffix; CI is x86 → silent image-pull failure | `sandbox/docker-compose.yml:106,152,196` | Phase 2 (runtime arch detection via `process.arch`) |
| R4 | State-store key migrations expensive on first-restart | `engine/state-store.ts` | Phase 0/4 (versioned keys; new artifacts = new keys, not migrations) |
| R5 | Snapshot capture of Postgres requires writable-layer storage at `/pgdata` (override upstream's `/var/lib/postgresql/data` VOLUME). Named volumes are NOT captured by `docker commit`. | `engine/snapshot.ts`; sui-image pattern at `services/sui.ts:469-484` | Phase 2 (override PGDATA in Postgres image) |
| R6 | Concurrent `pnpm dev` (`DEVSTACK_STACK=a` + `b`) must not cross-contaminate 8 new containers' state | `engine/identity.ts:78-83` (label stamping); `engine/port-allocator.ts:65-83` (file lock) | Phase 2 (regression test); existing labels handle the rest |
| R7 | Move source vendor size: 6 packages × ~5MB → ~30MB per consumer if naively checked in | sandbox uses submodule | Phase 0 (`vendorDeepbook` recipe → `~/.devstack-cache/git-fetch/<hash>/` shared across stacks) |
| R8 | Pyth pusher gas-coin contention with deployer/maker if shared signer used | sandbox uses dedicated keypair (`deploy-all.ts:179`) | Phase 1 (dedicated signer is required option) |
| R9 | `init_balance_manager_map` is admin-gated; must run before any user creates a BM — otherwise `register_balance_manager` aborts on `dynamic_field::borrow_mut` | sandbox `pool.ts:182-185` (idempotent `if !exists`) | Existing `deepbookLocalDeploy` already does this; verify on margin path |
| R10 | gRPC normalizes type strings (`0x0000...0002::sui::SUI`) differently from JSON-RPC; pool matching needs `normalizeStructTag` | sandbox `pool.ts:264-272` | Phase 0 (audit existing `pickCreatedByTypeSuffix` usage) |
| R11 | USDC `Currency` finalization must run before margin pool creation; sandbox uses `finalizeCurrencyRegistration` for new coins and `migrateLegacyMetadata` for SUI | sandbox `pool.ts:328-334` | Phase 4 (port both flows) |
| R12 | Indexer + server image-version-to-Move-version pairing is the hidden invariant; bumping one without the other silently corrupts indexed data | sandbox uses both pinned in `docker-compose.yml:106,152,196` | Phase 2 (`services/deepbook/images.ts` pairing table) |

### Audit findings (preserved for resume sessions)

The four 2026-05-18 surveys established:

- **Plugin-author primitives** (`packages/devstack/src/advanced/plugin-author/{docker-image,docker-one-shot,host-script}.ts`): `dockerImage({ name, pull | build })` for content-addressed image artifacts; `dockerOneShot({ name, image, args, env, mounts, network, dependsOn })` for cached one-shots; `hostScript({ name, command, args, env })` for host subprocesses. Long-lived containers go through engine-internal `Docker.run` (pattern: `services/sui.ts:459`, walrus, seal).
- **Lifecycle classification** (`packages/devstack/AGENTS.md:95-111`): `'per-cycle'` (default, torn down on `r` hot-restart) for actions, package publishes, dev processes. `'long-lived'` for container-backed network services with on-disk state.
- **StackMember contract** (`engine/supervisor.ts:99-138`): `__layer`, optional `__layers`, `__kind`, `__displayTitle`, `display: (shape) => TuiDisplay`.
- **Registries pattern** (`engine/registries.ts:147-203`): 8 `publishX` helpers today (`publishPackage`, `publishEndpoint`, `publishAccount`, `publishCoin`, `publishSuiState`, `publishSealState`, `publishWalrusState`, `publishDeepbookState`). New ones follow the same Record + Context.Service + helper + Live layer + grouper-in-`runtime/service.ts` pattern.
- **Manifest schema v4** at `runtime/manifest-schema.ts:150-162`. v4→v5 bump required to add `services.postgres`, `services.pyth`, and nest `services.deepbook.{margin,indexer,server}`. v4 manifests load via fallback in `runtime/manifest-loader.ts`.
- **State-store keys** (`AGENTS.md:152-164`): format `<service>/<artifact>/v<N>/<chainId>/...`. Version segment mandatory. New keys = new artifacts (no migration); existing key version bumps invalidate silently.
- **Test infrastructure**: `vitest.config.ts:11` pins `pool: 'forks'` with `test-setup/isolate-port-locks.ts` setting `DEVSTACK_PORT_LOCK_DIR` per worker. Sole real-Docker test today is `engine/snapshot.docker.test.ts` (~300s, `describe.skipIf(!DOCKER_OK)`, plain vitest + `runCli` shell-out). Playwright e2e in `examples/*/e2e/` reads `.devstack/manifest.json` written by `pnpm dev`. CI at `.github/workflows/devstack-e2e.yml` does two-stage matrix (seed apply+snapshot → e2e restore+playwright).
- **Codegen emitters** (`codegen/emitters/{bindings,dapp-kit-config,stack-handle}.ts`): each implements `Emitter<R>.emit(ctx: CodegenContext): Effect<void, CodegenError>`. New emitter for deepbook follows `dapp-kit-config.ts:90-115` pattern (golden-file tests + `writeIfChanged` helper).

---

## Design decisions

### D1 — Module layout

Generic primitives (Postgres, Pyth) live at top-level `services/<name>.ts`; deepbook-specific code stays under `services/deepbook/`.

```
packages/devstack/src/services/
  postgres.ts                # NEW — generic Postgres service
  postgres/internal.ts       # NEW
  pyth.ts                    # NEW — Pyth facade
  pyth/{index,internal,local-deploy,known-package,pusher,mid}.ts  # NEW
  coin.ts                    # EXTEND — add mintFromTreasury
  deepbook.ts                # EXTEND — DEEP/USDC mint sugar + bps strategy types
  deepbook/{indexer,server,margin,margin-seed,mint,vendor,images}.ts  # NEW
codegen/emitters/
  deepbook-config.ts         # NEW — typed deepbookConfig emitter
```

Rationale: Postgres has a future life with any indexer-shaped consumer; Pyth has a future life with any oracle consumer. Margin / indexer / server are inseparable from deepbook semantics.

### D2 — Pyth pusher: fiber, not container

The sandbox runs the pusher as a Docker container (`scripts/oracle-service/`). We run it as an in-process Effect fiber, mirroring our existing `deepbookMarketMaker` pattern.

Why fiber:
- No image build, no startup latency.
- Devstack already has a Node runtime; replicating the sandbox's container adds ceremony.
- Snapshots cleanly (no writable layer to preserve).
- 10s cadence is well within Effect-fiber territory.

A future `PythPusherContainer(opts)` can be added if a no-Node deployment story emerges.

### D3 — `bps` vs `tick` grid strategy default

Ship `bps` as an opt-in via a discriminated `strategy` option. **Keep `tick` as the default** through these phases. Legacy `levels`/`tickSpacing` top-level options stay working with a deprecation warning, removed in a later minor version.

Why not flip the default now: `examples/wallet` would break silently; bps math at sandbox defaults (spreadBps=10, levels=30, levelSpacingBps=100) requires more BalanceManager funding than tick's defaults.

### D4 — `bmStrategy: 'shared' | 'perPool'`

Ship per-pool BalanceManagers as opt-in. **Keep shared as default**. Sandbox uses per-pool for collateral isolation; not all consumers want that.

State-store key bumps `deepbook/market-maker/balance-manager/v1` → `v2` to add an optional pool-name dimension. v1 silently invalidates; next supervisor cycle re-mints (acceptable cost).

### D5 — Pyth+Margin coupling

`deepbookMargin` REQUIRES `pyth: Ref<Pyth>` as a non-optional option (typecheck enforced). Runtime check resolves every asset's `feed` through `pyth.findPriceInfo`. Margin-without-Pyth is impossible in the Move source; modeling it as required prevents silent misconfiguration.

### D6 — Image source default: pull, build opt-in

`DeepbookIndexer` + `DeepbookServer` default to `image: { pull: <pinned-digest> }` (mirrors sandbox's docker-compose default). Pass `image: { build: { context: <vendored-deepbook-source> } }` to build from source (~10-15 min cold).

Image-pairing table in `services/deepbook/images.ts` maps Move-source version → (indexerImage, serverImage) digests. Runtime arch detection via `process.arch` picks `-arm64` vs unsuffixed (or multi-arch manifest if upstream ships one).

### D7 — Move source vendoring strategy

`vendorDeepbook(version)` recipe (NEW in Phase 0) wraps `gitFetch` to clone both `MystenLabs/deepbook` and `MystenLabs/deepbook-sandbox` repos and materialize all 6 Move packages with their `Move.toml` files patched (`[environments] localnet = "<chainId>"`, git→local dep rewrites).

Output dir: `.devstack/vendor/deepbook/<ref>/`. Source cache: `~/.devstack-cache/git-fetch/<hash>/` (shared across stacks; not in per-consumer repo).

Existing `examples/wallet/.devstack/imports/mystenlabs_deepbookv3@v7.0.0/` keeps working — `vendor` is purely additive. Wallet migrates to the recipe in Phase 4 (when it needs 6 packages, not 1).

### D8 — Reference example app

NEW `examples/deepbook-full/` exercising the entire stack. Do not extend `examples/wallet` or `examples/arena`. Rationale: test isolation; a UI tweak in wallet shouldn't break a margin assertion in arena.

### D9 — Codegen emitter: `deepbookConfig`

NEW `codegen/emitters/deepbook-config.ts` produces a typed `<outputDir>/deepbook-config.ts` mirroring `@mysten/deepbook-v3`'s `testnetCoins` / `testnetPools` / `testnetMarginPools` / `testnetPythConfigs` shapes (already replicated in `known-deployments.ts:140-260` for known networks). Consumers:

```ts
import { deepbookConfig } from './generated/deepbook-config.js';
import { deepbook } from '@mysten/deepbook-v3';
const client = new SuiGrpcClient({ url: '...' }).$extend(deepbook(deepbookConfig));
```

Replaces ~70 lines of manual projection at `examples/wallet/src/lib/transactions.ts:51-117`.

### D10 — Manifest schema v4 → v5

Schema bump to v5. v4→v5 is additive (every new field optional); loader keeps a v4 fallback in `runtime/manifest-loader.ts`. v4 manifests load cleanly; first `pnpm dev` cycle rewrites in v5.

New top-level slots: `services.postgres`, `services.pyth`. `services.deepbook` gains nested optional `margin`, `indexer`, `server` plus optional `deepTreasuryId`.

### D11 — Open decisions

- [ ] **OD1** Should the wallet upgrade in-place phase-by-phase, or stay frozen until Phase 5? **Lean: upgrade in-place** (validates each phase as it lands).
- [ ] **OD2** Does Postgres ship one instance per consumer (e.g., one for deepbook-indexer) or shared? **Lean: parametric `Name`**, consumer chooses.
- [ ] **OD3** Reuse sui-indexer-db's Postgres for the deepbook indexer's data, or stand up a separate one? **Lean: separate** (different lifecycle expectations; sui's is per-cycle, deepbook's is long-lived).
- [ ] **OD4** Surface deepbook server REST URL through the same `extras` path the wallet already uses, or only through the new emitter? **Lean: emitter only** (clean break).
- [ ] **OD5** When `PythPusher` is omitted but `pythMid` is used, what does `read()` return on its first call? **Lean: caller-supplied `initial` option** (no auto-poll fallback).

---

## Phase 0 — DX foundations

**Goal:** Ship pure-code improvements that open the door for later phases. No new containers, no new chain primitives, no new Move sources.

**Why first:** every later phase plugs into this surface. Per-pool BM is required before margin (margin manager works per BalanceManager). `bps` grid is the user-visible parity win. `vendorDeepbook` lands now (nobody uses it yet) so Phase 1/4 can adopt without churn.

### Tasks

#### Market-maker extensions

- [ ] **P0.1** Add `DeepbookMarketMakerStrategy` discriminated union in `services/deepbook/market-maker.ts`. Two variants: `{ kind: 'tick', levels?, tickSpacing? }` (existing default) and `{ kind: 'bps', levels?, spreadBps?, levelSpacingBps? }`. Add `strategy?: DeepbookMarketMakerStrategy` to `DeepbookMarketMakerOptions`.
- [ ] **P0.2** Keep legacy top-level `levels` / `tickSpacing` options working; when present and `strategy` is absent, synthesize `{ kind: 'tick', levels, tickSpacing }` and emit a one-time deprecation warning at first tick.
- [ ] **P0.3** Add `bps` grid math helpers (`alignToTickSize`, `alignToLotSize`, `calculateGridLevels`) in `services/deepbook/internal.ts`. Port from `~/code/deepbook-sandbox/sandbox/scripts/market-maker/grid-strategy.ts:46-153`.
- [ ] **P0.4** Add `bmStrategy?: 'shared' | 'perPool'` to `DeepbookMarketMakerOptions`. Default `'shared'`.
- [ ] **P0.5** Refactor the maker's closure `balanceManagerId: string | undefined` to `balanceManagerIds: Map<string, string>` keyed by pool name when `bmStrategy === 'perPool'`.
- [ ] **P0.6** Bump state-store key `deepbook/market-maker/balance-manager/v1` → `v2`. Add optional pool-name segment. Document in the key comment.
- [ ] **P0.7** Per-pool deposit math: when `perPool`, `depositPreDeposits` fires per BM (single tx still, but multiple `balance_manager::new` calls inside).
- [ ] **P0.8** Cancel-all loop fans out per BM ref when `perPool`.

#### Generic mint primitive

- [ ] **P0.9** Add `mintFromTreasury` to `services/coin.ts`. Signature in design doc (D-section). Accepts `treasuryCap: string | { fromPackage, capturedField }` and `coinType: string | { fromPackage, module, type }`.
- [ ] **P0.10** State-store key `coin/mint/v1/<chainId>/<treasuryCapId>/<recipient>/<amount>` caches digest + mintedCoinId. Verify `mintedCoinId` exists + is owned by recipient on resume; mismatch → re-mint.
- [ ] **P0.11** Add `DeepbookMintDEEP` sugar in `services/deepbook/mint.ts` (reads `pkg.captured.deepTreasuryId` from local-deploy result, calls `mintFromTreasury`).
- [ ] **P0.12** Add `DeepbookMintUSDC` sugar (same pattern but for caller-supplied USDC TreasuryCap).
- [ ] **P0.13** Re-export both from `services/deepbook.ts` so the public surface reads `DeepbookMintDEEP({ deepbook, signer, to, amount })`.

#### Move source vendoring helper

- [ ] **P0.14** Create `services/deepbook/vendor.ts`. Export `vendorDeepbook(opts?)` returning a Ref to `VendoredDeepbookSources { token, deepbook, pyth, usdc, deepbook_margin, margin_liquidation }`. Default `ref: 'main'`.
- [ ] **P0.15** Internally: two `gitFetch` calls (deepbook repo + deepbook-sandbox repo) + a `dockerOneShot` (or `hostScript`) that patches each `Move.toml` (`[environments] localnet = "<chainId>"`, git→local dep rewrites). Mirror `~/code/deepbook-sandbox/sandbox/scripts/utils/deployer.ts:321-383`.
- [ ] **P0.16** Add `vendor?: Ref<VendoredDeepbookSources>` option to `DeepbookLocalDeployOptions`. When present, body reads `(yield* vendor).deepbook` instead of `movePackagePath`. Both options mutually exclusive (typecheck if possible; runtime error otherwise).
- [ ] **P0.17** Same `vendor` option for `pythLocalDeploy` and `deepbookMargin.{margin,liquidation}` (defined in later phases; thread the option through).

#### Registries / errors

- [ ] **P0.18** No new registries in Phase 0. Existing `publishCoin` covers `mintFromTreasury` outputs (they register a synthetic coin entry for the minted balance).
- [ ] **P0.19** No new error types in Phase 0. `DeepbookError` (already exists) covers maker strategy errors; `CoinError` (verify exists) covers mint errors.

### Test gate (Phase 0)

Test infrastructure prereqs:
- [ ] **P0.T0a** Extract `runCli` helper from `engine/snapshot.docker.test.ts:70-93` to `test-setup/docker/cli.ts` (`runCli(cwd, env, args, opts?) → CliResult`).
- [ ] **P0.T0b** Extract `DOCKER_OK` + `requireDocker` to `test-setup/docker/probe.ts` (mirror the existing skip-if pattern).
- [ ] **P0.T0c** Add `test-setup/docker/fork-stack.ts` exporting `forkDevstackStack(prefix) → StackHandle { stack, env, wipe }` for per-test stack isolation.

Test cases:
- [ ] **P0.T1** `services/deepbook/market-maker.test.ts` — L1 unit: `calculateGridLevels({spreadBps:20, levelSpacingBps:5, levels:3}, mid)` returns 6 orders at expected tick-aligned prices. <1s.
- [ ] **P0.T2** `services/deepbook/market-maker.test.ts` — L1 unit: state-store key shape for `perPool` includes pool name. <1s.
- [ ] **P0.T3** `services/coin.test.ts` — L1 unit: `mintFromTreasury` tx-builder produces expected moveCall (`treasury::mint_and_transfer`) with correct args. <1s.
- [ ] **P0.T4** `services/deepbook/bps-grid.docker.test.ts` — L3: full stack with `DeepbookMarketMaker({strategy:{kind:'bps',spreadBps:20,levelSpacingBps:5,levels:3}, midPrice:1_000_000n})`; apply, wait 15s; assert 6 orders placed at expected tick-aligned prices via `pool.iter_orders` devInspect. ~6 min.
- [ ] **P0.T5** `services/deepbook/market-maker.docker.test.ts` — L3: full stack with two pools and `bmStrategy:'perPool'`; apply, wait for first tick; assert state.json has two distinct entries under `deepbook/market-maker/balance-manager/v2/...`; each placed order's `balance_manager` arg matches the right pool's BM. ~6 min.
- [ ] **P0.T6** `services/deepbook/mint.docker.test.ts` — L3 (DEEP): minimal stack + `DeepbookMintDEEP({deepbook, signer:publisher, to:alice, amount:1_000_000_000n})`; apply; `suix_getBalance({owner:alice.address, coinType:deepType}).totalBalance ≥ 1_000_000_000n`. ~5 min.
- [ ] **P0.T7** `services/deepbook/mint.docker.test.ts` — L3 (USDC): same with USDC TreasuryCap; assert bob's USDC balance ≥ 500_000_000. ~5 min.
- [ ] **P0.T8** `services/deepbook/vendor.docker.test.ts` — L3: `vendorDeepbook({ref:'main'})` materializes 6 packages under `.devstack/vendor/deepbook/main/`; all 6 `Move.toml` files are patched with `[environments] localnet = "<chainId>"`; `sui move build` succeeds in each. ~6 min.

**Phase 0 done when:** all 17 task boxes + 3 test-prereq boxes + 8 test-case boxes checked.

---

## Phase 1 — Pyth oracle primitive

**Goal:** Ship `Pyth(opts)`, `PythPusher(opts)`, and `pythMid(opts)`. Unlocks oracle-driven mid for the market-maker. Self-contained — only chain-side dependency is sui-localnet + a vendored Pyth Move package.

**Why now:** smallest external-feed primitive we can land. Validates against `examples/deepbook-full` as soon as it ships. Required by Phase 4 (margin needs Pyth `PriceInfoObject`s).

### Tasks

#### Pyth factory

- [ ] **P1.1** Create `services/pyth.ts` exporting `Pyth(opts)`, `PythTag`, `Pyth` interface (from D-section), `PythPriceFeedId` type. Network-conditional facade: localnet → `pythLocalDeploy`; testnet/mainnet → `pythKnownPackage`.
- [ ] **P1.2** Create `services/pyth/internal.ts` with `SUI_PRICE_FEED_ID` / `DEEP_PRICE_FEED_ID` / `USDC_PRICE_FEED_ID` consts (hex strings from `~/code/deepbook-sandbox/sandbox/scripts/oracle-service/constants.ts:13-26`), and `addPriceInfo(tx, feedSpec) → TransactionResult` helper.
- [ ] **P1.3** Create `services/pyth/local-deploy.ts`. Body publishes vendored Pyth Move via `publishMove`, then a single batched tx creates `N` `PriceInfoObject`s via `pyth::create_price_feeds(vector<PriceInfo>)`. Mirrors `~/code/deepbook-sandbox/sandbox/scripts/utils/oracle.ts:61-156`. State-store cache at `pyth/package/v1/<chainId>/<pythPackageId>/<feedsHash>`.
- [ ] **P1.4** On cache hit: verify each `priceInfoObjectId` exists on chain via `client.core.getObject` and `objectType` matches `<pythPackageId>::price_info::PriceInfoObject`. Mismatch → invalidate + re-create.
- [ ] **P1.5** Create `services/pyth/known-package.ts` wrapping testnet/mainnet via `knownDeployments.<network>.pyth` (extend `known-deployments.ts` shape if needed).

#### Pyth pusher fiber

- [ ] **P1.6** Create `services/pyth/pusher.ts` exporting `PythPusher(opts)`. Mirrors `deepbookMarketMaker` fiber structure (Schedule.spaced, forkScoped).
- [ ] **P1.7** Required option: `signer: Account` — must differ from any maker's signer. No runtime check (consumer-mandated); rely on convention.
- [ ] **P1.8** Default `refreshMs: 10_000`, `historicalDataHours: 24`, `pythApiUrl: 'https://benchmarks.pyth.network'`. Match sandbox parity.
- [ ] **P1.9** Pusher body per tick: fetch from `${pythApiUrl}/v1/updates/price/<timestamp>?ids=...&encoding=hex&parsed=true`; for each feed, build PriceInfo via `addPriceInfo` helper; call `pyth::update_single_price_feed`. Set gas budget 200_000_000.
- [ ] **P1.10** Best-effort state-store at `pyth/pusher/v1/<chainId>/<pythPackageId>/<signer.address>` recording `lastDigest`, `lastUpdatedMs`. Informational only; doesn't gate behavior.

#### `pythMid` Ref helper

- [ ] **P1.11** Create `services/pyth/mid.ts` exporting `pythMid({pyth, feed, quote?, scale, initial?}) → Ref<PythMid {read, readEffect}>`. Inside: a Ref + a polling fiber reading `priceInfoObject.price_feed.price` via JSON-RPC `getObject` at `refreshMs` cadence.
- [ ] **P1.12** Scale conversion: pyth delivers `(priceMag, expoMag)`; helper scales to caller's `priceDecimals`/`quoteDecimals` bigint domain.
- [ ] **P1.13** Cross-rate support: when `quote` is set, the function yields `base_price / quote_price` (post-scaling) instead of raw USD.
- [ ] **P1.14** Plug into `DeepbookMarketMaker.pools[].midPrice`: the existing `bigint | () => bigint` slot accepts `pythMid({...}).read` directly. No API change to the maker.

#### Registries / errors / manifest

- [ ] **P1.15** Add `PythStateRegistry` + `PythStateRecord { name, packageId, pythStateId?, wormholeStateId?, priceInfoObjectIds: Record<feedId, objectId>, feeds: Record<label, feedId> }` to `engine/registries.ts`.
- [ ] **P1.16** Add `publishPythState` helper and `PythStateRegistryLive` layer folded into `RegistriesLive`.
- [ ] **P1.17** Add `groupPyth` grouper in `runtime/service.ts` (mirror `groupSui`).
- [ ] **P1.18** Add `PythManifest` Schema struct in `runtime/manifest-schema.ts`. Extend `ServicesManifest` with `pyth?: PythManifest`. Bump manifest version to v5 (additive only; v4 fallback in loader).
- [ ] **P1.19** Add `PythError` tagged error class in `engine/errors.ts` with optional `feed` field.
- [ ] **P1.20** Resolve TODO at `engine/known-deployments.ts:144` (verify against canonical Mysten registry) — needed for `pythKnownPackage` on testnet.

### Test gate (Phase 1)

Test infrastructure prereqs:
- [ ] **P1.T0a** Create `test-setup/fixtures/pyth/feeds.ts` exporting `PYTH_FEED_IDS = { SUI, DEEP, USDC }` (mainnet hex strings).
- [ ] **P1.T0b** Create `test-setup/fixtures/pyth/{sui,deep,usdc}.json` — captured fixtures of the Pyth API response shape, hand-curated.
- [ ] **P1.T0c** Create `test-setup/fixtures/pyth/bump-timestamp.ts` — wrapper that bumps the fixture's embedded timestamp +1s per tick so pushers' on-chain `priceInfo.timestamp` advances visibly in tests.

Test cases:
- [ ] **P1.T1** `services/pyth/local-deploy.test.ts` — L1: PythLocalDeploy tx-builder shape: 3 feed specs → 3 PriceInfoObjects, single batched tx with `pyth::create_price_feeds` move call. <1s.
- [ ] **P1.T2** `services/pyth/local-deploy.test.ts` — L2: state-store cache hit + cache-stale invalidation (mirror existing `deepbookLocalDeploy` cache tests). <5s.
- [ ] **P1.T3** `services/pyth/pyth.docker.test.ts` — L3: Pyth publish creates 3 PriceInfoObjects; for each, `sui client object <id>` returns a type containing `::price_info::PriceInfoObject`. ~5 min cold.
- [ ] **P1.T4** `services/pyth/pyth.docker.test.ts` — L3: Pyth publish is idempotent: apply × 2; state.json packageId unchanged; second apply shows `cache hit`. ~5 min + 30s.
- [ ] **P1.T5** `services/pyth/pyth-pusher.docker.test.ts` — L3: `PythPusher({source:'fixture'})` publishes ≥1 update within 15s. Poll `sui_getObject(<SUI-priceInfoObject>).priceInfo.price.timestamp` every 1s for 15s; assert timestamp advances ≥ 3 times. ~5 min cold + 15s.
- [ ] **P1.T6** `services/pyth/pyth-pusher.docker.test.ts` — L3: pusher halts cleanly on SIGTERM. Send SIGTERM; assert exit 0, no orphan publish_price processes, no `Pusher errored` line. ~5 min + 30s.
- [ ] **P1.T7** `services/pyth/pythmid-maker.docker.test.ts` — L3: full stack with `Pyth.local + DeepbookMarketMaker({strategy:{kind:'tick'}, midPrice:pythMid({...}).read})`, pusher disabled and feed pinned to $3.50; apply, wait for first tick; assert best bid ≤ 3_499_000n and best ask ≥ 3_501_000n (within 1 tick). ~5 min + 30s.
- [ ] **P1.T8** `services/pyth/known-package.test.ts` — L1: `pythKnownPackage({network:'testnet'})` resolves with packageId, pythStateId, etc. from `knownDeployments`. <1s.

**Phase 1 done when:** all 20 task boxes + 3 test-prereq boxes + 8 test-case boxes checked.

---

## Phase 2 — Postgres + DeepBook indexer

**Goal:** Ship `Postgres(opts)` (generic long-lived container) and `DeepbookIndexer(opts)` (Rust container reading sui checkpoints, writing Postgres). Lays the data plane.

**Why now:** indexer needs Postgres + sui checkpoint volume + DEEPBOOK_PACKAGE_ID. Splitting from server (Phase 3) so the indexer's data shape stabilizes before downstream readers attach.

### Tasks

#### Postgres primitive

- [ ] **P2.1** Create `services/postgres.ts` exporting `Postgres(opts)`, `PostgresTag` (parametric on Name), `Postgres` interface ({user, password, databases, endpoint, url(db), containerNetworks, networkAlias}).
- [ ] **P2.2** Default `version: '16-alpine'`, `user: 'devstack'`, `password: <stack-id derived>`, `databases: ['devstack']`. Optional `hostPort?` (unset by default — internal routing only).
- [ ] **P2.3** Image: override base Postgres to relocate `PGDATA` from `/var/lib/postgresql/data` to `/pgdata` (escapes the inherited VOLUME declaration so the writable layer captures rows). Mirror `services/sui.ts:469-484` pattern: `services/postgres/internal.ts` with a Dockerfile.
- [ ] **P2.4** Wire via engine-internal `Docker.run` (not the plugin-author `dockerOneShot`). Long-lived. Healthcheck via `pg_isready -U <user> -d <firstDb>`. 30s ready timeout.
- [ ] **P2.5** Idempotent `CREATE DATABASE` per requested database name. State-store cache at `postgres/databases/v1/<chainId>/<name>/<dbHash>` records which DBs we've ensured.
- [ ] **P2.6** Publish via `publishEndpoint(EndpointName.POSTGRES, ...)` (kind `'internal'` for routed-only; `'rpc'` if `hostPort` set).
- [ ] **P2.7** Add `PostgresStateRegistry` + `PostgresStateRecord` to `engine/registries.ts`. Note: `password` field intentionally NOT serialized to manifest (groupPostgres strips it).
- [ ] **P2.8** Add `PostgresManifest` Schema struct in `runtime/manifest-schema.ts`. Extend `ServicesManifest.postgres?`.
- [ ] **P2.9** Add `PostgresError` tagged error in `engine/errors.ts`.
- [ ] **P2.10** Add `Postgres` snapshot participation block (top-of-file comment per AGENTS.md:233): persists `/pgdata` writable layer; re-derives nothing; intentionally loses WAL position relative to chain.

#### DeepBook indexer container

- [ ] **P2.11** Create `services/deepbook/indexer.ts` exporting `DeepbookIndexer(opts)`, `DeepbookIndexerTag`, `DeepbookIndexer` interface ({metrics, databaseUrl, containerNetwork, networkAlias}).
- [ ] **P2.12** Required options: `postgres: Ref<Postgres>`, `sui: Ref<Sui>`, `deepbook: Ref<DeepbookCore>`. Optional: `margin?: Ref<DeepbookMargin>` (Phase 4 thread-through), `image?: {pull} | {build}`, `firstCheckpoint?`, `localCheckpointsDir?`, `dbConnectionPoolSize?`.
- [ ] **P2.13** Create `services/deepbook/images.ts` with the image-pairing table: `Record<MoveVersion, {indexer, server}>`. Initial entry for `'v7.0.0'` mapping to `mysten/deepbookv3-sandbox-indexer:46d846e5...` digests (arch-suffixed). Runtime `process.arch` detection picks `-arm64` vs unsuffixed.
- [ ] **P2.14** Long-lived container via `Docker.run`. Joins Postgres `containerNetwork` AND sui-localnet's network (for `--local-ingestion-path /checkpoints`).
- [ ] **P2.15** Env contract (mirror `~/code/deepbook-sandbox/sandbox/docker-compose.yml:151-188`): `DATABASE_URL`, `NETWORK=localnet`, `LOCAL_CHECKPOINTS_DIR=/checkpoints`, `MARGIN_PACKAGES` (when margin ref present), `DEEPBOOK_PACKAGE_ID`, `FIRST_CHECKPOINT`, `RUST_LOG`.
- [ ] **P2.16** Surface sui's checkpoint volume name: extend `services/sui.ts` to publish `EndpointName.SUI_CHECKPOINT_VOLUME` (kind `'internal'`) carrying the per-stack volume name. Indexer reads this and adds a mount.
- [ ] **P2.17** Healthcheck via `curl -sf http://localhost:9184/metrics || exit 1`. 120s ready timeout (sandbox parity for Rust binary cold start).
- [ ] **P2.18** Publish endpoint `DEEPBOOK_INDEXER_METRICS` via traefik router on a new entrypoint (port 9184). Add to `engine/docker/router.ts` entrypoints list.
- [ ] **P2.19** Add `DeepbookIndexerStateRegistry` + `DeepbookIndexerStateRecord` + `publishDeepbookIndexerState`.
- [ ] **P2.20** Extend `DeepbookManifest` with optional `indexer?: DeepbookIndexerManifest { metrics: EndpointEntry }`.
- [ ] **P2.21** Add `Indexer` snapshot participation block: persists nothing in own writable layer beyond runtime files; re-derives indexer cursor from Postgres on restart; intentionally loses in-memory event buffers.
- [ ] **P2.22** Add `EndpointName.POSTGRES`, `EndpointName.DEEPBOOK_INDEXER_METRICS`, `EndpointName.SUI_CHECKPOINT_VOLUME` constants to `runtime/endpoint-names.ts`. Wire to conventional-routes per AGENTS.md endpoint cookbook.

### Test gate (Phase 2)

Test infrastructure prereqs:
- [ ] **P2.T0a** Create `test-setup/helpers/pg.ts` exporting `connectPostgres(url) → PgClient {query, end}`.
- [ ] **P2.T0b** Create `test-setup/helpers/wait.ts` exporting `waitForPostgresQuery(client, sql, predicate, opts?)` and `waitForEndpoint(url, opts?)`.
- [ ] **P2.T0c** Pre-pull `postgres:16-alpine` + indexer image at CI workflow start to amortize cold-start cost across tests.

Test cases:
- [ ] **P2.T1** `services/postgres.test.ts` — L1: Postgres factory shape (tag, layer, idempotent CREATE DATABASE list). <1s.
- [ ] **P2.T2** `services/postgres.docker.test.ts` — L3: `Postgres({name:'pg',databases:['deepbook','app']})` boots; `SELECT 1` returns `1` within 30s; both databases exist; second apply is idempotent (no CREATE DATABASE re-run). ~3 min.
- [ ] **P2.T3** `services/postgres.docker.test.ts` — L3: snapshot/restore roundtrip preserves rows. Insert a row, snapshot, wipe, restore, SELECT — row present. ~6 min.
- [ ] **P2.T4** `services/deepbook/indexer.docker.test.ts` — L3: full stack (sui + Deepbook + pool + Postgres + DeepbookIndexer); place `place_limit_order` from alice; poll `SELECT count(*) FROM trades` every 1s for 30s; assert count 0 → ≥ 1. ~7 min.
- [ ] **P2.T5** `services/deepbook/indexer.docker.test.ts` — L3: indexer is resilient to restart. After a fill is indexed, stop the indexer container, restart, verify no double-count (cursor preserved). ~6 min.
- [ ] **P2.T6** `services/sui.test.ts` — L1: checkpoint volume endpoint is published with correct name format `devstack-<app>-<stack>-checkpoints`. <1s.
- [ ] **P2.T7** Multi-stack regression: run two `pnpm devstack apply` instances with `DEVSTACK_STACK=a` and `DEVSTACK_STACK=b`, both with indexers + pools; place orders on each; verify `stack=a`'s Postgres has 0 rows from `stack=b`'s chain (`engine/identity.ts` labels handle this; this test asserts it). ~10 min. L3.
- [ ] **P2.T8** `engine/snapshot-deepbook.docker.test.ts` — L4: NEW test file mirroring `snapshot.docker.test.ts` structure. Boots `examples/deepbook-full` with Postgres + indexer; apply; place orders; snapshot save; wipe; restore; verify Postgres rows preserved + indexer cursor preserved. Single `it()` block, ~10 min budget.

**Phase 2 done when:** all 22 task boxes + 3 test-prereq boxes + 8 test-case boxes checked.

---

## Phase 3 — DeepBook server

**Goal:** Ship `DeepbookServer(opts)` long-lived container providing REST API on `:9008` reading from the Postgres started in Phase 2.

**Why now:** same Postgres + checkpoint dependency cluster as the indexer. Split from Phase 2 to give the indexer's data shape a stable validation window before downstream readers attach.

### Tasks

- [ ] **P3.1** Create `services/deepbook/server.ts` exporting `DeepbookServer(opts)`, `DeepbookServerTag`, `DeepbookServer` interface ({rest, metrics, containerNetwork, networkAlias}).
- [ ] **P3.2** Required options: `postgres: Ref<Postgres>`, `sui: Ref<Sui>`, `deepbook: Ref<DeepbookCore>`. Optional: `margin?: Ref<DeepbookMargin>`, `image?: {pull} | {build}`, `dbStatementTimeoutMs?`.
- [ ] **P3.3** Env contract (mirror `~/code/deepbook-sandbox/sandbox/docker-compose.yml:195-228`): `DATABASE_URL`, `RPC_URL=http://host.docker.internal:9000`, `DEEPBOOK_PACKAGE_ID`, `DEEP_TOKEN_PACKAGE_ID`, `DEEP_TREASURY_ID`, `MARGIN_PACKAGE_ID`, `RUST_LOG`. Hardcoded `--db-statement-timeout-ms 60000`.
- [ ] **P3.4** Long-lived container via `Docker.run`. Joins Postgres `containerNetwork`. Healthcheck `curl -sf http://localhost:9008/ || exit 1`. 60s ready timeout.
- [ ] **P3.5** Add image entries for the server in `services/deepbook/images.ts` pairing table (same version key as indexer).
- [ ] **P3.6** Publish endpoint `DEEPBOOK_SERVER_REST` via traefik on entrypoint port 9008 (host-mapped). Add `DEEPBOOK_SERVER_METRICS` on a separate entrypoint (port 9185 to avoid collision with indexer's 9184). Add both to `runtime/endpoint-names.ts`.
- [ ] **P3.7** Add `DeepbookServerStateRegistry` + `DeepbookServerStateRecord` + `publishDeepbookServerState`.
- [ ] **P3.8** Extend `DeepbookManifest` with optional `server?: DeepbookServerManifest { rest: EndpointEntry, metrics: EndpointEntry }`.
- [ ] **P3.9** Snapshot participation block: stateless service; persists nothing; re-derives nothing on restore.
- [ ] **P3.10** Router updates in `engine/docker/router.ts`: add `'deepbook-server'` + `'deepbook-server-metrics'` entrypoints (alongside the existing `'deepbook-indexer-metrics'` from Phase 2).

### Test gate (Phase 3)

Test infrastructure prereqs:
- [ ] **P3.T0a** Create `test-setup/helpers/server.ts` exporting `connectDeepbookServer(url) → DeepbookServerClient { ticker, trades }`.

Test cases:
- [ ] **P3.T1** `services/deepbook/server.docker.test.ts` — L3: full stack + DeepbookServer; place 3 orders + 1 fill; `curl ${server.rest}/ticker`; assert 200 + JSON body with `sui_usdc` entry containing numeric `lastPrice` + `bestBid` + `bestAsk`. ~7 min.
- [ ] **P3.T2** `services/deepbook/server.docker.test.ts` — L3: snapshot/restore roundtrip stability. Record `/ticker` response pre-snapshot, snapshot save, wipe, restore, re-fetch `/ticker`; assert per-pool `lastPrice` unchanged. ~10 min.
- [ ] **P3.T3** Extend `engine/snapshot-deepbook.docker.test.ts` to include server container in the fixture. Assert server is reachable after restore + responds with consistent data. (Folds into the existing Phase-2 L4 test rather than a new test file.) ~10 min.
- [ ] **P3.T4** Multi-stack regression: two concurrent stacks each with their own DeepbookServer; verify ports allocate cleanly (no `EADDRINUSE`); each server queries its own Postgres. ~10 min. L3.

**Phase 3 done when:** all 10 task boxes + 1 test-prereq box + 4 test-case boxes checked.

---

## Phase 4 — Margin primitive

**Goal:** Ship `deepbookMargin(opts)` (publish `deepbook_margin` + `margin_liquidation` + per-asset margin pools + register deepbook pools) and `deepbookMarginSeed(opts)` (mint SupplierCap + supply per asset).

**Why now:** margin needs Pyth (Phase 1) AND the deepbook publish (always). Lands AFTER observability primitives (Phase 2-3) so indexer/server data shapes stabilize first, then chain features layer in.

### Tasks

#### Move publish + margin pool creation

- [ ] **P4.1** Create `services/deepbook/margin.ts` exporting `deepbookMargin(opts)`, `DeepbookMarginTag`, `DeepbookMargin` interface ({packageId, liquidationPackageId, registryId, adminCapId, marginPools, registeredPools}).
- [ ] **P4.2** Required options: `signer: Account`, `margin: {movePackagePath? | vendor?}`, `liquidation: {movePackagePath? | vendor?}`, `pyth: Ref<Pyth>` (NON-OPTIONAL — typecheck enforced), `deepbook: Ref<DeepbookCore>`, `assets`, `pools`. Optional `maxAgeSeconds?` (default 70).
- [ ] **P4.3** Typed `DeepbookMarginAssetConfig` with named export `USDC_MARGIN_DEFAULTS` / `SUI_MARGIN_DEFAULTS` mirroring `~/code/deepbook-sandbox/sandbox/scripts/utils/pool.ts:36-72`. Consumers override single fields by spread.
- [ ] **P4.4** Typed `DeepbookMarginPoolRegistration` with named export `DEFAULT_POOL_RISK_CONFIG` mirroring `pool.ts:75-82`.
- [ ] **P4.5** Publish `deepbook_margin` Move via `publishMove`, capture `MarginRegistry` + `MarginAdminCap`. Then publish `margin_liquidation` (no captures).
- [ ] **P4.6** USDC currency finalization: if any asset references a non-system coin's `Currency` object, call `finalizeCurrencyRegistration` first. SUI uses `migrateLegacyMetadata`. Mirror `pool.ts:328-334`.
- [ ] **P4.7** Single batched tx for margin setup (mirror `pool.ts:346-407`):
  - `mint_maintainer_cap`
  - per-asset `new_coin_type_data_from_currency`
  - `new_pyth_config` + `add_config`
  - per-asset `create_margin_pool`
  - per-pool `new_pool_config` + `register_deepbook_pool` + `enable_deepbook_pool`
  - transfer `MaintainerCap` to signer
- [ ] **P4.8** Verify each asset's `feed` resolves via `pyth.findPriceInfo(feed)` before tx submit; fail with `DeepbookError({phase:'publish', marginAsset, message})` on unknown feed.
- [ ] **P4.9** State-store cache at `deepbook/margin-pools/v1/<chainId>/<marginPackageId>/<configHash>`. Verify each `MarginPool<T>` objectType matches expected on resume; mismatch → invalidate + re-create.
- [ ] **P4.10** Populate `DeepbookCore.packageIds.{MARGIN_PACKAGE_ID, MARGIN_REGISTRY_ID, LIQUIDATION_PACKAGE_ID}` in local-deploy's resolved shape when margin is composed in (currently `undefined`).

#### Margin seed action

- [ ] **P4.11** Create `services/deepbook/margin-seed.ts` exporting `deepbookMarginSeed(opts)` action. Required: `signer: Account`, `margin: Ref<DeepbookMargin>`, `amounts: [{label, amount}]`.
- [ ] **P4.12** Body (mirror `pool.ts:459-584`): `mint_supplier_cap`, merge/split coins for each asset, `margin_pool::supply` per asset, transfer `SupplierCap` to signer.
- [ ] **P4.13** State-store cache at `deepbook/margin-seed/v1/<chainId>/<marginPackageId>/<signer.address>/<amountsHash>` records digest + supplierCapId + seededAmounts.
- [ ] **P4.14** Re-export `deepbookMarginSeed` from `services/deepbook.ts` as `DeepbookMargin.seed` via `Object.assign`-pattern for the public surface.

#### Indexer + manifest extensions

- [ ] **P4.15** Add optional `margin?: Ref<DeepbookMargin>` to `DeepbookIndexerOptions`. When present, read `margin.packageId` + `margin.liquidationPackageId` and thread to `MARGIN_PACKAGES` env var (comma-separated). Mirror sandbox.
- [ ] **P4.16** Add `DeepbookMarginStateRegistry` + `DeepbookMarginStateRecord` + `publishDeepbookMarginState` to `engine/registries.ts`.
- [ ] **P4.17** Add `DeepbookMarginManifest` Schema struct in `runtime/manifest-schema.ts`. Extend `DeepbookManifest` with optional `margin?: DeepbookMarginManifest`.
- [ ] **P4.18** Add `MARGIN_*` type-suffix constants to `services/deepbook/internal.ts` (mirror existing `DEEPBOOK_REGISTRY_TYPE_SUFFIX` etc).
- [ ] **P4.19** Extend `DeepbookError` with optional `marginAsset` and `feed` fields.
- [ ] **P4.20** Snapshot participation block: per-cycle action; caches only; no own filesystem state. Cache verified on resume.

### Test gate (Phase 4)

Test cases:
- [ ] **P4.T1** `services/deepbook/margin.test.ts` — L1: margin tx-builder shape: per-asset config produces correct moveCalls (mint_maintainer_cap, new_coin_type_data_from_currency, etc.). <1s.
- [ ] **P4.T2** `services/deepbook/margin.test.ts` — L2: margin pool state-store cache hit + cache-stale invalidation. <5s.
- [ ] **P4.T3** `services/deepbook/margin.docker.test.ts` — L3: margin publish captures registry + admin cap; state.json `publishMove/margin.publish` has `captured.registryId` + `captured.adminCapId`, both 0x-prefixed and on-chain. ~7 min.
- [ ] **P4.T4** `services/deepbook/margin.docker.test.ts` — L3: margin pools created per asset; state.json has two `margin/margin-pools/v1/...` entries; each pool object's type contains `::margin_pool::MarginPool<...>` with correct generic. ~7 min.
- [ ] **P4.T5** `services/deepbook/margin.docker.test.ts` — L3: typecheck-required `pyth: Ref<Pyth>` — config omitting pyth fails TypeScript compilation. (L1 test fixture via `pnpm tsc --noEmit` on a deliberately-broken config; expect non-zero exit.) <30s.
- [ ] **P4.T6** `services/deepbook/margin-seed.docker.test.ts` — L3: margin seed supply tx lands; decode the captured `MarginPool` object's `total_supply` via `sui_getObject` + bcs decoder; assert ≥ seed amount (after scalar). ~7 min.
- [ ] **P4.T7** `services/deepbook/margin.docker.test.ts` — L3: idempotent re-apply: state.json packageId + marginPools unchanged; second apply shows `cache hit`. ~7 min + 30s.
- [ ] **P4.T8** Extend `engine/snapshot-deepbook.docker.test.ts` to include margin in the fixture. Assert margin pool ids identical pre/post snapshot. ~10 min.
- [ ] **P4.T9** Indexer pickup: with margin in the stack, indexer's `MARGIN_PACKAGES` env reflects the deployed packageId; place a margin-related event; verify it lands in Postgres. ~7 min. L3.

**Phase 4 done when:** all 20 task boxes + 9 test-case boxes checked.

---

## Phase 5 — Codegen `deepbookConfig` + reference example

**Goal:** Ship `DeepbookConfigEmitter` producing typed `deepbookConfig` consumers spread into `client.$extend(deepbook(...))`. Create `examples/deepbook-full/` reference app exercising every phase's primitives.

**Why last:** codegen output shape is downstream of every state shape phases 0-4 produced. Reversing means re-emitting a partial shape, then a fuller shape, every later phase — churn on every consumer.

### Tasks

#### Codegen emitter

- [ ] **P5.1** Create `codegen/emitters/deepbook-config.ts` implementing `Emitter<R>.emit(ctx)`. Reads from `DeepbookStateRegistry`, `CoinRegistry`, `PythStateRegistry`, `DeepbookMarginStateRegistry`, `DeepbookIndexerStateRegistry`, `DeepbookServerStateRegistry`.
- [ ] **P5.2** Output shape mirrors `@mysten/deepbook-v3`'s `testnetCoins` / `testnetPools` / `testnetMarginPools` / `testnetPythConfigs`. Reference: shapes already replicated in `engine/known-deployments.ts:140-260` for known networks.
- [ ] **P5.3** Short-circuit when `services.deepbook` is absent (emit nothing; log info). Stacks without deepbook don't get a `deepbook-config.ts` file.
- [ ] **P5.4** Use `writeIfChanged` helper for output. File mode 0o644 (no secrets). Not gitignored (safe-to-commit generated code).
- [ ] **P5.5** Add `DeepbookConfigEmitter()` to default emitter list in `services/codegen.ts`. Follows the existing pattern of `BindingsEmitter()`, `StackHandleEmitter()`, `DappKitConfigEmitter()`.
- [ ] **P5.6** Deprecation warning on `extras.deepbookPools` — logged at supervisor start when the key is set. Pointer to migration note + removed-in-vNext schedule.

#### Reference example app

- [ ] **P5.7** Create `examples/deepbook-full/` directory: `package.json`, `tsconfig.json`, `playwright.config.ts`, `src/`, `e2e/`, `public/`. Clone structure from `examples/wallet/`.
- [ ] **P5.8** `examples/deepbook-full/devstack.config.ts` declaring: `vendorDeepbook({ref:'v7.0.0'})`, `Postgres()`, `Pyth({local: {feeds: [SUI, DEEP, USDC]}})`, `PythPusher({signer: pythPusherAccount, source:'fixture'})`, `Deepbook({local: {vendor, pools: [DEEP_SUI, SUI_USDC]}})`, `DeepbookMargin({pyth, deepbook, assets: [USDC_MARGIN_DEFAULTS, SUI_MARGIN_DEFAULTS], pools: [{pool:'sui_usdc'}]})`, `DeepbookMargin.seed({amounts: [{label:'USDC', amount:10_000n}, {label:'SUI', amount:100n}]})`, `DeepbookIndexer({postgres, sui, deepbook, margin})`, `DeepbookServer({postgres, sui, deepbook, margin})`, `DeepbookMarketMaker({strategy: {kind:'bps', spreadBps:10, levelSpacingBps:100, levels:30}, bmStrategy:'perPool', pools: [...]})`.
- [ ] **P5.9** Dedicated signers per service: `publisher`, `pythPusherAccount`, `marketMaker`, `alice`, `bob`. `alice` and `bob` reserved for user-facing UI.
- [ ] **P5.10** UI shell: minimal React app with pages — Health (shows oracle status + indexer cursor + server REST status), Trading (place limit order against margin-enabled pool), Mint (DEEP + USDC buttons), Ticker (calls `services.deepbook.server.rest.url + '/ticker'`).
- [ ] **P5.11** Generated bindings consumed via `import { deepbookConfig } from './generated/deepbook-config.js'; client.$extend(deepbook(deepbookConfig))`.

#### Wallet migration

- [ ] **P5.12** `examples/wallet/devstack.config.ts:221-235` — delete the `extras: Effect.gen` block that projects `deepbookPools`. Replace with reliance on the new emitter.
- [ ] **P5.13** `examples/wallet/src/lib/deployment.ts:46-94` — delete manual coin/pool projection.
- [ ] **P5.14** `examples/wallet/src/lib/transactions.ts:51-117` — replace manual `coins/pools/packageIds` projection with one-liner: `import { deepbookConfig } from '../../generated/deepbook-config.js'; new DeepBookClient({ ...deepbookConfig, client, address })`.
- [ ] **P5.15** Run wallet's existing Playwright suite — must pass unchanged. UI behavior identical pre/post migration.

#### CI workflow extension

- [ ] **P5.16** Extend `.github/workflows/devstack-e2e.yml` adding `deepbook-full` to the seed + e2e example matrices. Mirror `arena` / `private-content` rows.
- [ ] **P5.17** Add a new `docker-integration` job sharded 4-way on `ubuntu-latest-large` running `pnpm vitest run --testNamePattern docker --shard <N>/4`. Per-shard 30-min timeout. Pre-pull `postgres:16-alpine` + indexer/server images at start.
- [ ] **P5.18** Failure-artifact upload: `docker ps -a`, per-container `docker logs`, all reachable `manifest.json` + `state.json` files. 7-day retention. Mirror sandbox's `integration-tests.yml` pattern.

### Test gate (Phase 5)

Test infrastructure prereqs:
- [ ] **P5.T0a** Create `test-setup/helpers/sui.ts` exporting `getObject`, `getBalance` JSON-RPC helpers used by L3 tests.
- [ ] **P5.T0b** Document `examples/deepbook-full/e2e/` playwright config in `test-setup/snapshot-smoke/README.md` (Runbook D becomes "DeepBook full stack").

Test cases:
- [ ] **P5.T1** `codegen/emitters/deepbook-config.test.ts` — L1 golden: seeded registries → emitted file body matches expected string. <5s.
- [ ] **P5.T2** `codegen/emitters/deepbook-config.test.ts` — L2: emit against fully-seeded registries; assert output `deepbookConfig.packageIds.DEEPBOOK_PACKAGE_ID` matches the seed; output is `as const`. <5s.
- [ ] **P5.T3** `codegen/emitters/deepbook-config.test.ts` — L2: emit when `services.deepbook` absent → no file written, no error. <1s.
- [ ] **P5.T4** `services/deepbook/codegen.docker.test.ts` — L3: full stack + `Codegen()` running; read `src/devstack/deepbook-config.ts`; spawn `pnpm tsc --noEmit` against the consumer config import; assert exit 0 + on-chain `packageId` matches the file's `DEEPBOOK_PACKAGE_ID`. ~7 min.
- [ ] **P5.T5** `examples/deepbook-full/e2e/oracle-mid.spec.ts` — L5: best bid/ask within 2% of displayed oracle price; passes against `pnpm dev`. ~3 min post-warm.
- [ ] **P5.T6** `examples/deepbook-full/e2e/mint.spec.ts` — L5: clicking "Mint 100 DEEP" updates `[data-testid="balance-alice-deep"]` with correct delta. ~2 min post-warm.
- [ ] **P5.T7** `examples/deepbook-full/e2e/margin-order.spec.ts` — L5: limit buy against margin-enabled pool shows on book at expected price; verify via `place_limit_order` digest + read book via UI. ~3 min post-warm.
- [ ] **P5.T8** `examples/deepbook-full/e2e/ticker-fetch.spec.ts` — L5: `/ticker` page renders per-pool rows with numeric `lastPrice` + `bestBid` + `bestAsk`. ~2 min post-warm.
- [ ] **P5.T9** `examples/wallet/e2e/swap.spec.ts` — L5 regression: existing wallet swap suite still green after Phase 5 migration. ~5 min.
- [ ] **P5.T10** End-to-end snapshot regression: `pnpm devstack apply` on `examples/deepbook-full`; place orders; snapshot save baseline; wipe; restore; verify `deepbook-config.ts` regenerated identical content; verify all on-chain ids unchanged. ~12 min. L4.

**Phase 5 done when:** all 18 task boxes + 2 test-prereq boxes + 10 test-case boxes checked.

---

## Snapshot integration

Every new long-lived container ships with a `Snapshot participation:` block in its file header per `AGENTS.md:233-246`. Documented in each phase's task list; reproduced here for cross-reference.

| Service | Persists | Re-derives on restore | Intentionally lost |
|---|---|---|---|
| `Postgres` | All tables in writable layer `/pgdata` (override of upstream `/var/lib/postgresql/data` VOLUME). State-store key `postgres/databases/v1/...` tracks ensured logical DBs. | Nothing | In-flight connections; WAL position relative to chain |
| `Pyth` (local-deploy) | State-store key `pyth/package/v1/...` (priceInfoObjectIds for resume idempotency) | Pyth package + PriceInfoObjects live in Sui chain volume (captured by sui-localnet snapshot). Cache verified against `objectType`; mismatch triggers re-publish | None |
| `PythPusher` (fiber) | State-store key `pyth/pusher/v1/...` (lastDigest, lastUpdatedMs — informational) | Fiber restarts; first refresh reads current Pyth prices and pushes them on-chain | In-memory historical-price cache |
| `DeepbookIndexer` | Writable layer (in-flight per-checkpoint state); cursor in Postgres bookkeeping tables | Indexer resumes from last-indexed checkpoint recorded in Postgres | Indexer in-memory caches |
| `DeepbookServer` | Nothing | Reads from restored Postgres + chain RPC | In-memory query caches |
| `deepbookMargin` (action) | State-store key `deepbook/margin-pools/v1/...` | Cache verified against `MarginPool<T>` objectType; mismatch triggers re-publish + re-create | Nothing |

L4 regression test (`engine/snapshot-deepbook.docker.test.ts`) covers the full save→wipe→restore cycle with all containers running.

---

## Cleanup / `wipe` semantics

Existing `pnpm devstack wipe` already handles new state cleanly via label-based pruning:

- **Named-volume cleanup** for Postgres + sui checkpoint mount: works via existing label filter (`docker volume ls -q --filter label=devstack.app=<app> --filter label=devstack.stack=<stack>`).
- **Port-lock cleanup** for indexer/server endpoints: works automatically via `state.json` removal.
- **State-store cache removal** for Pyth / margin / indexer cursors: works via existing `removeStateOnDisk` deleting `<stackDir>/state.json`.

**One new addition**: `pnpm devstack wipe-cache` subcommand for the `vendorDeepbook` gitFetch cache at `~/.devstack-cache/git-fetch/<hash>/`. NOT bundled with `wipe` because users on slow networks don't want stack teardown to invalidate a 30s clone. Document as separate optional cleanup. **Defer to Phase 0 only if the cache grows large enough to matter**; otherwise leave it as a P-5+ follow-up.

---

## AGENTS.md updates per phase

| Phase | Sections updated in `packages/devstack/AGENTS.md` |
|---|---|
| 0 | "Shared helpers" — add bps grid math helper, mintFromTreasury |
| 1 | "Registries section" — add `PythStateRegistry`; "Tag-key naming" — `PythTag`; "Snapshot participation" — note Pyth pusher fiber exemption |
| 2 | "Registries section" — `PostgresStateRegistry`, `DeepbookIndexerStateRegistry`; "Tag-key naming" — `PostgresTag`, `DeepbookIndexerTag`; "The manifest is the wire format" — `DEEPBOOK_INDEXER_METRICS`; "Snapshot participation table" — Postgres + Indexer rows; "State-store keys" — example for indexer cursor |
| 3 | "Tag-key naming" — `DeepbookServerTag`; "Snapshot participation" — DeepbookServer row |
| 4 | "Registries section" — `DeepbookMarginStateRegistry`; "Tag-key naming" — `DeepbookMarginTag`; "Lifecycle examples" — margin local-deploy per-cycle |
| 5 | "Codegen contract" — add `DeepbookConfigEmitter` to default emitters list |

After Phase 4 lands, the `services/deepbook/` subdir grows to ~10 files. Create `packages/devstack/src/services/deepbook/AGENTS.md` documenting the per-file split.

---

## Glossary

- **DeepBook V3** — Mysten's on-chain CLOB on Sui. `~/code/deepbook-sandbox/external/deepbook` is the upstream source.
- **deepbook-sandbox** — one-command Docker stack at `github.com/MystenLabs/deepbook-sandbox` covering the full protocol surface. Our reference for feature parity.
- **Pool** — DeepBook orderbook for a (base, quote) pair. Created via `pool::create_pool_admin`.
- **BalanceManager** — DeepBook shared object holding a user's funds. Trades against pools settle through BMs.
- **MarginPool** — Lending pool for a single asset, registered in `MarginRegistry`. Backs leveraged trading.
- **PriceInfoObject** — Pyth on-chain object holding the latest price + EMA for a single feed. Created via `pyth::create_price_feeds`; updated via `pyth::update_single_price_feed`.
- **Feed id** — Pyth's cross-chain price feed identifier (32-byte hex). Identifies an asset; same value across all chains.
- **VAA** — Verifiable Action Attestation. Pyth's price update proof. On localnet we generate synthetic prices, not VAAs.
- **`init_balance_manager_map`** — Admin-gated one-time setup call on the deepbook registry. Without it, `register_balance_manager` aborts. Bundled into `createDeepbookPools` (idempotent).
- **Snapshot participation** — Per-service contract documenting what survives `docker commit` + restore. See AGENTS.md:233-246.
- **Per-pool BalanceManager** — Sandbox-style isolation: one BM per pool. Devstack ships shared default + perPool opt-in.
- **bps** — basis points (1 bp = 0.01%). Sandbox's grid spacing is bps-driven.

---

## File paths quick reference

### Existing deepbook surface (Phase 0+ extends)

- `packages/devstack/src/services/deepbook.ts` — `DeepbookCoreTag`, `DeepbookAdminTag`, `DeepbookMarketMakerTag`, `Deepbook()` facade
- `packages/devstack/src/services/deepbook/local-deploy.ts` — publish + create-pools
- `packages/devstack/src/services/deepbook/known-package.ts` — testnet/mainnet wrapper
- `packages/devstack/src/services/deepbook/market-maker.ts` — fiber grid maker (Phase 0 adds strategy + bmStrategy)
- `packages/devstack/src/services/deepbook/internal.ts` — shared helpers (Phase 0 adds bps grid math)
- `packages/devstack/src/services/deepbook.test.ts` — existing unit tests

### Engine seams (Phases 0-5 touch)

- `packages/devstack/src/engine/registries.ts` — `publishX` helpers, registry classes (every phase adds ≥1)
- `packages/devstack/src/engine/state-store.ts:138` — state-store path layout (no changes; new keys folder cleanly)
- `packages/devstack/src/engine/errors.ts` — tagged error classes (Phase 1 + 4 add new types)
- `packages/devstack/src/engine/known-deployments.ts:144` — TODO (Phase 1 resolves)
- `packages/devstack/src/engine/snapshot.ts:88` — `SnapshotMeta` (no schema changes; new containers picked up by label)
- `packages/devstack/src/engine/docker/router.ts` — Traefik entrypoints (Phase 2 + 3 add new ones)
- `packages/devstack/src/engine/identity.ts:78-83` — label stamping (no changes)
- `packages/devstack/src/engine/port-allocator.ts:65-83` — port locks (no changes)

### Runtime + manifest (Phases 1-5 extend)

- `packages/devstack/src/runtime/manifest-schema.ts:150-162` — v4 schema (every phase adds optional fields; Phase 1 bumps to v5)
- `packages/devstack/src/runtime/manifest-loader.ts` — v4 → v5 fallback
- `packages/devstack/src/runtime/service.ts:159-255` — `gatherManifest` groupers (every phase adds one)
- `packages/devstack/src/runtime/endpoint-names.ts` — endpoint name constants (Phase 2 + 3 add new ones)
- `packages/devstack/src/runtime/conventional-routes.ts` — endpoint route mappings (AGENTS.md endpoint cookbook step 4)

### Plugin-author surface (Phases 2 + 3 use heavily)

- `packages/devstack/src/advanced/plugin-author/docker-image.ts` — `dockerImage({pull|build})`
- `packages/devstack/src/advanced/plugin-author/docker-one-shot.ts` — `dockerOneShot({...})`
- `packages/devstack/src/advanced/plugin-author/host-script.ts` — `hostScript({...})`
- `packages/devstack/src/services/sui.ts:459-484` — reference image-build pattern (replicate for Postgres-override)
- `packages/devstack/src/services/walrus/local-cluster.ts:124-157` — reference long-lived container pattern

### Codegen (Phase 5)

- `packages/devstack/src/codegen/emitters/dapp-kit-config.ts` — reference emitter pattern
- `packages/devstack/src/codegen/emitters/dapp-kit-config.test.ts` — reference golden-test pattern
- `packages/devstack/src/codegen/helpers.ts:10-38` — `writeIfChanged`
- `packages/devstack/src/codegen/errors.ts:9-14` — `CodegenError`
- `packages/devstack/src/codegen/define-emitter.ts:1-92` — `Emitter<R>` interface
- `packages/devstack/src/services/codegen.ts:269-289` — default emitter list (Phase 5 adds one)

### Test infrastructure

- `packages/devstack/vitest.config.ts:11` — `pool: 'forks'` (pinned)
- `packages/devstack/test-setup/isolate-port-locks.ts` — existing test-setup
- `packages/devstack/test-setup/docker/{probe,cli,fork-stack}.ts` — NEW Phase 0
- `packages/devstack/test-setup/helpers/{wait,pg,server,sui}.ts` — NEW Phases 2 + 3 + 5
- `packages/devstack/test-setup/fixtures/pyth/{feeds,sui,deep,usdc,bump-timestamp}.ts` — NEW Phase 1
- `packages/devstack/src/engine/snapshot.docker.test.ts` — existing real-Docker precedent (skip pattern, runCli, ~300s)
- `packages/devstack/src/engine/snapshot-deepbook.docker.test.ts` — NEW Phases 2-5 (extended over phases)
- `.github/workflows/devstack-e2e.yml` — CI workflow (Phase 5 adds `docker-integration` job + `deepbook-full` example)

### Consumer

- `examples/wallet/devstack.config.ts:135-186` — current sole consumer (Phase 1 + 5 modify)
- `examples/wallet/src/lib/{deployment.ts:46-94, transactions.ts:51-117}` — manual deepbook projection (Phase 5 deletes)
- `examples/deepbook-full/` — NEW Phase 5 reference example

### Sandbox reference (read-only, for porting)

- `~/code/deepbook-sandbox/sandbox/scripts/utils/{deployer,pool,oracle}.ts` — sandbox's deploy + pool + oracle setup
- `~/code/deepbook-sandbox/sandbox/scripts/market-maker/{grid-strategy,market-maker}.ts` — bps grid + per-pool BM
- `~/code/deepbook-sandbox/sandbox/scripts/oracle-service/{index,pyth-client,oracle-updater}.ts` — Pyth pusher
- `~/code/deepbook-sandbox/sandbox/docker-compose.yml` — env var contract for indexer/server/etc
- `~/code/deepbook-sandbox/external/deepbook` (submodule) — upstream Move source + Rust binaries

---

## Change log

- 2026-05-18 — Initial plan written. Four 2026-05-18 surveys (existing deepbook surface, sandbox repo, docker + test infra, codegen + manifest) folded into background + landmines. Three Plan-agent designs (architecture + sequencing/risk + testing) reconciled into 6 phases. No code yet.
