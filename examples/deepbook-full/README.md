# deepbook-full

Reference example exercising the entire deepbook stack:

- Vendored DeepBook V3 + margin + liquidation + pyth + usdc Move sources via `vendorDeepbook({ref:'v7.0.0'})`.
- `Postgres()` long-lived container backing the indexer + server.
- `Pyth({local: {feeds: [SUI, DEEP, USDC]}})` — local-deploy publishes the Pyth Move + creates three `PriceInfoObject`s.
- `PythPusher({signer: pythPusherAccount})` — in-process Effect fiber pushing benchmarks-API updates to the `PriceInfoObject`s every 10s.
- `Deepbook({local: {vendor, pools: [DEEP_SUI, SUI_USDC]}})` — local-deploy of the deepbook package + whitelisted pool creation.
- `DeepbookMargin({pyth, deepbook, assets: [USDC, SUI], pools: [{pool:'sui_usdc'}]})` + `DeepbookMargin.seed({amounts: [USDC, SUI]})` — publishes margin + liquidation, mints per-asset MarginPools, registers the deepbook pool, and seeds the SupplierCap with starter liquidity.
- `DeepbookIndexer({postgres, sui, deepbook, margin})` + `DeepbookServer({postgres, sui, deepbook, margin})` — Rust containers reading checkpoints from sui-localnet's shared volume and serving the REST API on `:9008`.
- `DeepbookMarketMaker({strategy:{kind:'bps',spreadBps:10,levelSpacingBps:100,levels:30}, bmStrategy:'perPool'})` — bps-grid maker against both pools, one BalanceManager per pool.

The UI consumes the codegen-emitted `deepbookConfig` from `src/generated/deepbook-config.ts`:

```ts
import { deepbook } from '@mysten/deepbook-v3';
import { deepbookConfig } from './generated/deepbook-config.js';

const client = new SuiGrpcClient({ ... }).$extend(deepbook({ ...deepbookConfig, address: sender }));
```

Pages:

- **Health** — oracle status + indexer cursor + server REST status.
- **Trading** — limit buy against the margin-enabled pool.
- **Mint** — `Mint 100 DEEP` / `Mint 1 USDC` buttons (publishers' TreasuryCap).
- **Ticker** — calls `services.deepbook.server.rest.url + '/ticker'` and renders per-pool best bid/ask/last.

Run with:

```
pnpm --filter @mysten-incubation/deepbook-full dev
```

Phase 5 of the deepbook plugin expansion (see `packages/devstack/notes/deepbook-plugin-expansion.md`) introduces this example. The wallet example was migrated alongside this one to consume `deepbookConfig` directly instead of the hand-projected `extras.deepbookPools`.
