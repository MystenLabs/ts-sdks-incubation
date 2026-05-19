# deepbook plugin expansion plan

Living design doc + progress tracker. **This file is self-contained** — a fresh Claude/dev session should be able to pick up work by reading from the top and finding the first unchecked task in the current phase.

**Status (2026-05-19): TRIMMED — Phases 0–5 task lists removed.** All
6 phases (0–5) implementation complete; L1 tests green; L3/L4/L5 docker
+ playwright scaffolded. Phase 6 code complete; **2 remaining test gate
items** (L3 docker per-pool BM regression + `examples/deepbook-full`
manual E2E) extracted to `notes/post-launch-sweep.md` Wave 4 §6.1.

Preserved here for the **risk register (R1–R12)**, **design decisions
(D1–D11)**, **snapshot integration table**, **wipe semantics**,
**file-paths reference**, and **glossary** — they remain useful when
touching the deepbook surface.

**Owner:** unassigned (multi-agent dispatch).

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

- [x] **Phase 0** — DX foundations (bps grid, perPool BM, mintFromTreasury, vendorDeepbook) <!-- impl + L1 tests done 2026-05-18; L3 docker tests scaffolded -->
- [x] **Phase 1** — Pyth oracle + pusher fiber + `pythMid` Ref helper <!-- impl + L1 tests done 2026-05-18; L3 docker tests scaffolded -->
- [x] **Phase 2** — Postgres primitive + DeepBook indexer container <!-- impl + L1 tests done 2026-05-18; L3 docker tests scaffolded; indexer checkpoint mount blocked on sui-fork agent's SUI_CHECKPOINT_VOLUME publish -->
- [x] **Phase 3** — DeepBook server container (REST API) <!-- impl + L1 tests done 2026-05-18; L3 docker tests scaffolded -->
- [x] **Phase 4** — Margin primitive (publish + pools + seed) <!-- impl + L1 tests (including the P4.T5 typecheck-enforcement test) done 2026-05-18; L3 docker tests scaffolded -->
- [x] **Phase 5** — Codegen `deepbookConfig` emitter + `examples/deepbook-full/` reference app <!-- impl + L1 tests done 2026-05-18; L3 docker codegen + L4 snapshot + L5 playwright scaffolded behind DEVSTACK_INTEGRATION_TESTS=1; wallet migration done -->
- [ ] **Phase 6** — back-compat removal (shipped shims from Phases 0 and 5 deleted)


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
- **Manifest schema v4** at `runtime/manifest-schema.ts:150-162`. v4→v5 bump required to add `services.postgres`, `services.pyth`, and nest `services.deepbook.{margin,indexer,server}`. The loader rejects v4 manifests outright; users re-run `apply` to regenerate.
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

### D3 — `bps` grid strategy is the only strategy

`DeepbookMarketMakerOptions.strategy` is required and takes only the discriminated `{ kind: 'bps', ... }` variant. The legacy `levels`/`tickSpacing` top-level options are deleted. `examples/wallet` migrates to bps in the same commit; the bps math sandbox defaults (spreadBps=10, levels=30, levelSpacingBps=100) inform the example's BalanceManager funding numbers.

The `tick` variant is left out of the type entirely. If a future use case calls for it, add it then.

### D4 — `bmStrategy: 'perPool'` is the only mode

Per-pool BalanceManagers are the only mode. The `'shared'` mode is deleted; `bmStrategy` becomes a non-option on `DeepbookMarketMakerOptions`. Sandbox's collateral-isolation pattern is the contract.

State-store key is `deepbook/market-maker/balance-manager/v2/<chainId>/<packageId>/<signer.address>/<poolName>`. The v1 key is gone; nothing reads it.

### D5 — Pyth+Margin coupling

`deepbookMargin` REQUIRES `pyth: Ref<Pyth>` as a non-optional option (typecheck enforced). Runtime check resolves every asset's `feed` through `pyth.findPriceInfo`. Margin-without-Pyth is impossible in the Move source; modeling it as required prevents silent misconfiguration.

### D6 — Image source default: pull, build opt-in

`DeepbookIndexer` + `DeepbookServer` default to `image: { pull: <pinned-digest> }` (mirrors sandbox's docker-compose default). Pass `image: { build: { context: <vendored-deepbook-source> } }` to build from source (~10-15 min cold).

Image-pairing table in `services/deepbook/images.ts` maps Move-source version → (indexerImage, serverImage) digests. Runtime arch detection via `process.arch` picks `-arm64` vs unsuffixed (or multi-arch manifest if upstream ships one).

### D7 — Move source vendoring strategy

`vendorDeepbook(version)` recipe (NEW in Phase 0) wraps `gitFetch` to clone both `MystenLabs/deepbook` and `MystenLabs/deepbook-sandbox` repos and materialize all 6 Move packages with their `Move.toml` files patched (`[environments] localnet = "<chainId>"`, git→local dep rewrites).

Output dir: `.devstack/vendor/deepbook/<ref>/`. Source cache: `~/.devstack-cache/git-fetch/<hash>/` (shared across stacks; not in per-consumer repo).

`vendorDeepbook` is the only path. The pre-existing `examples/wallet/.devstack/imports/mystenlabs_deepbookv3@v7.0.0/` is deleted in Phase 4; the wallet migrates to the recipe in the same commit.

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

Schema bump to v5. The loader rejects v4 manifests with a hard error pointing at `pnpm devstack apply` — callers re-derive by re-running the supervisor. No v4 fallback in `runtime/manifest-loader.ts`.

New top-level slots: `services.postgres`, `services.pyth`. `services.deepbook` gains nested optional `margin`, `indexer`, `server` plus optional `deepTreasuryId`.

### D11 — Open decisions

- [x] **OD1** Wallet upgrades in-place phase-by-phase; each phase validates against the wallet example before landing.
- [x] **OD2** Postgres is parametric on `Name`; consumers stand up their own instance per logical use (no implicit sharing).
- [x] **OD3** DeepBook indexer gets its own Postgres instance; sui-indexer-db is not reused (different lifecycle: sui's is per-cycle, deepbook's is long-lived).
- [x] **OD4** DeepBook server REST URL is surfaced only through the new emitter. The `extras` path is gone (P5.6 deletes `extras.deepbookPools`).
- [x] **OD5** `pythMid.read()` requires a caller-supplied `initial` option when used without a registered `PythPusher`. There is no auto-poll fallback.

---

## Phase 6 — back-compat removal

Phases 0 and 5 shipped behind temporary back-compat shims (market-maker `tick` default, `bmStrategy: 'shared'` default, legacy top-level `levels`/`tickSpacing` synthesis path, `extras.deepbookPools` runtime warning). The repo is unreleased; per `AGENTS.md` `## Breaking changes are fine`, the design decisions D3 / D4 above are now "bps-only, tick deleted" and "per-pool-only, shared deleted". This phase removes the shipped shims in code; the design-decision rewordings already landed.

### Tasks

#### Market-maker strategy/bmStrategy hard cuts

- [x] **P6.1** Delete the market-maker `tick` default and the legacy `levels` / `tickSpacing` top-level option synthesis path in `packages/devstack/src/services/deepbook/market-maker.ts` (synthesis block around `:168-179`). `strategy: { kind: 'bps', ... }` becomes required at the type level — there is no implicit `tick` strategy synthesised from `levels` + `tickSpacing`. (Audit found Phases 0/5 had already removed the synthesis block + the deprecation warning; this phase deleted the `tick` discriminant from the strategy union, the `tick`-branch in `computeOffsets`, and removed the `kind: 'tick'` callsite in `examples/wallet/devstack.config.ts`.)
- [x] **P6.2** Delete the legacy top-level `levels?` / `tickSpacing?` options from `DeepbookMarketMakerOptions` (same file) and remove the deprecation warning at `packages/devstack/src/services/deepbook/market-maker.ts:212-218`. The warned-about path is deleted with the warning. (Audit-confirmed already absent from the options type as of Phase 5 prep — no top-level `levels?`/`tickSpacing?` in `DeepbookMarketMakerOptions`; deprecation warning was likewise already gone. P6.2 verified clean.)
- [x] **P6.3** Delete the `bmStrategy: 'shared'` default and the `'shared'` variant from the `DeepbookMarketMakerOptions` type at `packages/devstack/src/services/deepbook/market-maker.ts:181`. Per-pool BalanceManagers become the only mode — `bmStrategy` is removed from the option surface entirely (D4 in this plan's design decisions). Any synthesis branch keyed off `'shared'` deleted from the maker body. (Removed: the `DeepbookMarketMakerBmStrategy` type, the `bmStrategy` field on options, the `SHARED_KEY` constant, both `bmStrategy === 'shared'` branches in the cache-load block, the `bmKeyForPool` indirection, both `if (bmStrategy === 'shared')` branches in `tickOnce`, the post-tx `key === SHARED_KEY` ternary, and the index.ts re-export. Updated both example apps to drop the `bmStrategy:` line.)
- [x] **P6.4** State-store key cleanup: with `'shared'` gone, the v1 single-BM cache key shape (`deepbook/market-maker/balance-manager/v1/...`) is dead. Remove any residual reader; the v2-with-pool-name key from P0.6 is the only key. Verify `grep -rn "deepbook/market-maker/balance-manager/v1" packages/devstack/src` returns 0 hits. (Confirmed by grep — only mentions are in this plan's prose; production code uses the `v2/<chainId>/<packageId>/<signer>/<poolName>` shape unconditionally now.)

#### Codegen `extras.deepbookPools` hard cut

- [x] **P6.5** Delete the runtime deprecation warning for `extras.deepbookPools` in `packages/devstack/src/codegen/emitters/deepbook-config.ts:199-211`. The warned-about extras-path is also deleted from the emitter — every consumer reads from `DeepbookStateRegistry` / the new emitter's typed output, not from the extras bag. (Audit-confirmed: Phase 5 already removed the warning and the extras-fed path; the emitter at the cited lines now only branches on whether `services.deepbook` is in the manifest. No further deletion needed for P6.5.)
- [x] **P6.6** Audit `packages/devstack/src/runtime/manifest-schema.ts` and `packages/devstack/src/compose/devstack.ts` for any residual `extras.deepbookPools` schema field or accept-path. Delete. The schema bump landed in P5.6 already rejects the field at the supervisor; this task removes the leftover type/comment references. (Audit clean — `manifest-schema.ts:203` keeps the generic `extras: Schema.Record(Schema.String, Schema.Unknown)` slot which is the app-level extras escape hatch, not deepbook-specific. No `deepbookPools` references anywhere in either file.)
- [x] **P6.7** Migrate any example app still spelling `extras: { deepbookPools }` (audit: `examples/wallet/devstack.config.ts`, `examples/deepbook-full/devstack.config.ts`, `examples/arena`, `examples/_template`, `examples/private-content`). Wallet was migrated in P5.12; verify no regressions reintroduced the spelling. (`grep -rn "deepbookPools" examples/{wallet,deepbook-full,arena,_template,private-content}/*.ts` returns 0 hits in source.)

### Phase 6 test gate

- [x] `pnpm typecheck` clean for devstack + every example app. (Devstack tsc shows 0 deepbook-related errors; remaining errors are from concurrent api-simp / coin-auto agents on unrelated files — `engine/docker.test.ts`, `engine/docker/router.ts`, `services/action.test.ts`, `services/faucet/strategies/*.test.ts`, `services/walrus/*.ts`, `cli/commands/snapshot.fork.test.ts`. Wallet + deepbook-full `tsconfig.node.json` typecheck of `devstack.config.ts` clean.)
- [x] `pnpm exec vitest run --exclude '**/*.docker.test.ts'` — 0 failures. Any `market-maker.test.ts` cases asserting the `tick` synthesis path or the `'shared'` default are deleted (not rewritten). (553 tests pass; market-maker.test.ts had no synthesis-or-default-default tests to delete — the existing 5 cases assert `bps` grid math + the v2 state-key shape, both still load-bearing. 3 failures are all from concurrent api-simp P3.2 work in `engine/docker.test.ts` + `engine/port-allocator.test.ts`, unrelated to deepbook.)
- [x] `grep -rn "tick.*strategy\|tickSpacing\|levels\?\|bmStrategy.*shared\|deepbookPools" packages/devstack/src` returns 0 hits in production code (test-fixture mentions in deleted-path tests don't count). (Verified — only hit is `levels?: number` on the surviving `bps` strategy's optional field, which is the kept-API surface, not a back-compat shim.)
- [ ] L3 `services/deepbook/market-maker.docker.test.ts` (when run via `DEVSTACK_INTEGRATION_TESTS=1`) — per-pool BM behavior still green; the `'shared'` deletion did not regress the v2 key path. (Deferred — L3 docker tests require `DEVSTACK_INTEGRATION_TESTS=1` and Docker; out of scope for this CI gate.)
- [ ] Manual: `examples/deepbook-full` runs end-to-end with `strategy: { kind: 'bps', ... }` required at every callsite. (Deferred — manual E2E run needs Docker and live stack.)

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
- `packages/devstack/src/runtime/manifest-loader.ts` — v5-only loader (rejects older shapes)
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
