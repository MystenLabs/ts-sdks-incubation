# Deepbook Trader

Localnet DeepBook market-maker example. Publishes DeepBook-v3 from
vendored sources, mints a DEEP managed coin, seeds a DEEP/SUI pool with
configurable depth, and ships a React UI that swaps SUI for DEEP through
the live pool. Pyth is wired in as a DeepBook implementation detail
(price-feed integration).

```
deepbook-trader/
├── devstack.config.ts        # sui-localnet + deepbook publish + pool seeding + wallet + vite
├── move/                     # local managed-coin glue
├── e2e/market-console.spec.ts # Playwright: connect wallet, swap, assert pool moved
└── src/                      # React UI: live pool depth + swap form
```

## Run

```
pnpm dev          # devstack up (vite on 5182, router on 5175)
pnpm test:e2e     # Playwright swap flow
```

## See also

- [examples/README.md](../README.md) — every runnable example.
- [DeepBook service docs](https://ts-sdks-incubation.vercel.app/devstack/features/services/deepbook) —
  DeepBook + Pyth plugin coverage.
