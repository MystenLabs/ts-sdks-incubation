# Deepbook plugin

A first-class `deepbook()` plugin replacing the current `imports({ packages: [{ name:
'deepbook', ... }] })` indirection in `examples/wallet`. Adds market-maker scaffolding so test
stacks have continuous liquidity rather than a static one-shot seeding.

## Context

What `examples/wallet` does today:

- Uses the **generic** `imports()` plugin to publish `MystenLabs/deepbookv3@v7.0.0` (with
  `--with-unpublished-dependencies` inlining the `token` sub-package). Captures
  `registry.adminCapId` + `registryId` into the manifest.
- Hand-rolls three `seed()` actions in its `setup:` field:
  - `seedTokens` — mint mock USDC + WETH supply per a hardcoded distribution.
  - `seedPools` — `init_balance_manager_map` + `create_pool_admin` for SUI/mUSDC + SUI/mWETH
    (whitelisted, no DEEP fees).
  - `seedOrders` — alice creates a BalanceManager + posts 6 static limit orders per pool (3
    asks + 3 bids around a fixed mid).
- The frontend's `buildDeepbookSwapTx` (in `examples/wallet/src/lib/transactions.ts`) builds
  swap txs against those pools.
- `swap.spec.ts` does one e2e swap against alice's resting bids.

Three things the user asked for:

1. **First-class `deepbook()` plugin** — declarative pool spec; no `imports()` boilerplate.
2. **Market makers** — like `MystenLabs/deepbook-sandbox` does: long-running grid rebalancer
   that places POST_ONLY orders around a mid-price every 10 seconds, so the orderbook stays
   full as tests trade against it.
3. **E2E that exercises deepbook trades** — already partially there; should also assert the
   market maker is providing continuous liquidity (orders refresh between checks).

## Reference: deepbook-sandbox shape

deepbook-sandbox is a one-command localnet for DeepBook V3. Its setup:

1. Bootstraps environment + keypairs, launches sui localnet + Postgres + indexer.
2. Publishes the **full protocol**: token, deepbook, pyth, usdc, margin, liquidation.
3. Initializes Pyth-style oracle PriceInfoObjects for SUI/DEEP/USDC.
4. Creates DEEP/SUI and SUI/USDC pools.
5. Runs a market-maker process that places POST_ONLY grid orders around the oracle mid-price,
   rebalancing every 10s.

What we **don't** need to copy:

- Pyth integration. Wallet doesn't use it; users who want oracle-driven mids can pass a
  function for the mid-price (see Design below).
- The full margin/liquidation/usdc stack. The wallet example's mock USDC + WETH is closer to
  what most users want for a swap-flow demo.
- A separate Postgres/indexer service. devstack's reconciler already serves as the
  orchestration layer.

What we **do** want:

- Continuous liquidity via a grid rebalancer.
- One-shot pool creation per declarative spec.
- Clean swap helper exported from the plugin so apps don't reinvent it.

## Design

### Plugin shape

```ts
deepbook({
	// upstream
	rev?: string,            // git rev — default 'v7.0.0'
	admin?: string,          // signer for publish + pool admin — default 'publisher'

	// pools to create on first up
	pools?: Array<{
		name: string,        // unique within plugin
		base: string,        // 'sui' | '@reg/<token>' | full move type
		quote: string,
		tickSize: bigint,
		lotSize: bigint,
		minSize: bigint,
		whitelisted?: boolean,  // default true (no DEEP fees)
	}>,

	// market makers — array because pools may want different makers / mids
	marketMakers?: Array<{
		name: string,        // e.g. 'mm-alice'
		signer: string,      // account name; gets its own BalanceManager
		pools: string[],     // names of pools this maker quotes
		// Mid prices. Object form for static; function form for oracle integration.
		midPrices: Record<string, bigint>
			| ((ctx: ActionRunContext) => Promise<Record<string, bigint>>),
		levels?: number,         // depth on each side; default 3
		tickSpacing?: number,    // ticks between levels; default 1
		sizePerLevel: bigint
			| Record<string, bigint>,  // base units per order, per pool
		refreshIntervalMs?: number,    // default 10000
		// Optional: how much the maker pre-deposits per pool. Default 100x sizePerLevel.
		preDeposit?: Record<string, { base: bigint; quote: bigint }>,
	}>,
})
```

### Coin-type resolution

`base` / `quote` accept three forms:

- `'sui'` — shorthand for `'0x2::sui::SUI'`.
- `'@reg/<name>'` — resolved via `registry.tokens.find(name).type` at run time. Lets users
  publish their mock coins via `publishMove({ onPublished: registry.tokens.register({...}) })`
  earlier in the graph and reference them by name here.
- Anything else — passed through as a fully-qualified Move type
  (`'0x2::sui::SUI'`, `'0xabcd...::usdc::USDC'`).

Implemented in `coin-spec.ts:resolveCoinType(registry, spec)` — already written.

### Actions

| Action                              | Type        | Purpose                                                                                                                                  |
| ----------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `deepbook.source`                   | Build       | Fetch + build the DeepBook source image via BuildKit git context. Idempotent on `imageExists`.                                           |
| `deepbook.publish`                  | Publish     | `importMovePackage` against `MystenLabs/deepbookv3@<rev>` with `--with-unpublished-dependencies`. Captures `registryId` + `adminCapId`. |
| `deepbook.pools`                    | Seed        | `init_balance_manager_map` + `create_pool_admin` for each declared pool. Skips if all pools already on chain.                            |
| `deepbook.market-maker.<name>`      | HostProcess | Per-maker grid rebalancer. Spawns a setInterval loop that cancels + replaces the maker's grid orders every `refreshIntervalMs`.          |

The `HostProcess` type means market makers are skipped by `applyTestSetupFilter` (Playwright
globalSetup) — the supervisor that spawns `pnpm dev`'s long-running process owns them, just
like the existing wallet-server.serve action.

### Market-maker mechanics

Per refresh tick, for each pool the maker quotes:

1. **Ensure BalanceManager exists** (one-time on first tick). Create via
   `balance_manager::new`, deposit pre-deposit amounts of base + quote, transfer to signer.
   Cache the BalanceManager objectId in the plugin's namespace
   (`registry.ns('deepbook').balanceManagers`).
2. **Cancel all open orders** held by the maker on this pool —
   `pool::cancel_all_orders(pool, bm, proof, clock)`. No-op on first tick.
3. **Place fresh grid** — for `i in 1..=levels`, place an ask at `mid + i*tickSpacing*tickSize`
   and a bid at `mid - i*tickSpacing*tickSize`, each `sizePerLevel` base units, POST_ONLY,
   `pay_with_deep: false`.

All in one tx per refresh per maker (so 1 cancel-all + 2*levels place-orders, 7 calls for
default `levels: 3`). Cheap enough to do every 10s without choking the chain.

If a refresh fails (e.g., chain hiccup), log + skip — the next tick retries from clean state
(orders left from the failed tx eventually expire on `expireMs`).

### State + idempotence

- Pools live on chain; `deepbook.pools.getStatus` checks each declared pool's
  `Pool<Base, Quote>` object exists. Snapshot restore preserves them (sui's container layer
  captures the chain state including the pools).
- BalanceManagers (one per market-maker) live in `registry.ns('deepbook').balanceManagers`.
  The first market-maker tick creates and caches; subsequent ticks reuse.
- Open orders refresh every tick; not idempotent by design — that IS the point.

### Files

```
NEW
  packages/devstack/src/plugins/deepbook/index.ts          # plugin factory + types
  packages/devstack/src/plugins/deepbook/source.ts         # BuildKit git-context image
  packages/devstack/src/plugins/deepbook/publish.ts        # Publish action body
  packages/devstack/src/plugins/deepbook/pools.ts          # Seed action: pool creation
  packages/devstack/src/plugins/deepbook/market-maker.ts   # HostProcess action: grid rebalancer
  packages/devstack/src/plugins/deepbook/swap.ts           # buildDeepbookSwapTx (already drafted)
  packages/devstack/src/plugins/deepbook/coin-spec.ts      # resolveCoinType helper (already drafted)

MODIFY
  packages/devstack/src/index.ts                           # re-export deepbook + swap helper + types
  examples/wallet/devstack.config.ts                       # drop imports() + seedPools/seedOrders, add deepbook()
  examples/wallet/src/lib/transactions.ts                  # delete buildDeepbookSwapTx (use plugin export)
  packages/docs/content/devstack/plugins/deepbook.mdx      # NEW reference page
  packages/docs/content/devstack/meta.json                 # add plugins/deepbook to nav
  packages/docs/content/devstack/plugins/imports.mdx       # note "for non-deepbook upstream packages"
  packages/docs/content/devstack/examples/wallet.mdx       # mention the deepbook setup
```

### Phased rollout (3 PRs)

| PR  | Scope                                                                            | Lines |
| --- | -------------------------------------------------------------------------------- | ----- |
| 13  | Plugin core: source + publish + pools. Migrate wallet to use it; verify cold up. | ~500  |
| 14  | Market maker: HostProcess + grid rebalancer. Add to wallet config.                | ~300  |
| 15  | Docs: deepbook.mdx reference; update wallet.mdx; cross-links.                    | ~150  |

PRs 13 + 14 land before docs (PR 15) so the doc reflects the final API.

## Verification

End-to-end sequence on `examples/wallet`:

1. Cold up: `pnpm devstack apply` succeeds. Manifest contains:
   - `packages.deepbook` with `registryId` + `adminCapId` captured.
   - `deepbook.pools[]` — 2 pools, each with `poolId` + `objectType`.
2. Market maker liveness:
   - After ~12 s of `pnpm devstack up` (one refresh tick + buffer), `pool::get_book_state(pool)`
     RPC call returns ≥6 ask orders + ≥6 bid orders (3 levels × 2 sides × 1 maker).
   - Wait another 10 s; same call returns a fresh set of orders (different `clientOrderId`
     range — proves rebalancing fired).
3. E2E `swap.spec.ts`:
   - bob swaps 1 SUI for mUSDC against the maker's resting bids. Balances update; tx digest
     surfaces.
   - Add a second test: bob swaps in the opposite direction (1 USDC for SUI) against the
     maker's resting asks, to confirm both sides of the book are populated.
4. Snapshot round-trip:
   - `pnpm devstack snapshot save baseline` — captures sui state including the pools.
   - `pnpm devstack stack drop main --yes --force` + `pnpm devstack snapshot restore baseline`
     + `pnpm devstack up` — pools come back; market maker reattaches to its existing
     BalanceManager (cached in registry); orderbook re-populates within one tick.

## Open questions / non-goals

| Question / non-goal                                                                                    | Resolution                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pyth oracle integration?                                                                               | Out of scope. The function-form `midPrices` callback lets users plug in oracle reads themselves; we don't need to ship a pre-baked Pyth integration. |
| Margin trading / liquidation packages?                                                                 | Out of scope. The example apps don't need them. Re-evaluate if a friction journal entry asks.                                                        |
| Multi-maker per pool?                                                                                  | Already supported — `marketMakers: [{...}, {...}]` with overlapping `pools:` lists. Each maker has its own BalanceManager, signs its own txs.        |
| Should pools be created with `whitelisted: false` (DEEP fees)?                                         | Defaults to `true` (whitelisted, no DEEP fees) since that's the friction-free default for tests. Users override per pool.                            |
| Should the swap helper handle non-whitelisted pools?                                                   | The current helper passes `coin::zero<DEEP>()`, which breaks on non-whitelisted pools. If a friction entry surfaces, extend it.                      |
| Should the plugin support running deepbook against testnet/mainnet?                                    | Out of scope. The plugin is localnet-only (mirrors `walrus()`, `seal()`). For testnet/mainnet, apps use deepbook's curated package addresses.        |
| Should we expose `cancelOrder` / `placeOrder` helpers separately?                                      | The market-maker uses them internally. If a user needs them outside, we can extract — but the swap helper covers the common case.                    |

## Architectural notes

- Same model as `walrus()`/`seal()`: localnet-only, container-layer state, plugin sets
  `containerService.snapshot` so snapshots roundtrip cleanly. Pools live in sui's chain,
  captured via sui's `docker commit`. Market-maker state (BalanceManager + open orders) lives
  on chain too — same capture path.
- Setup actions (`pools`) are framework-internal seeds, not user `setup:` actions. They run
  on every cold up; idempotent skip-predicate.
- The market-maker's HostProcess type is the canonical place for "long-running async loop the
  supervisor owns" — same shape as wallet-server.serve.
