# Token Studio

Single managed coin example: one Move package exports a coin with a
`TreasuryCap`, the stack publishes the package, and the UI exercises
mint and transfer flows gated by the cap.

```
token-studio/
├── devstack.config.ts    # sui-localnet + managed-coin publish + wallet + vite
├── move/                 # Move package: coin module + TreasuryCap-gated entry fns
├── e2e/                  # Playwright: mint, transfer flow
└── src/                  # React UI: cap-gated mint/transfer
```

## Run

```
pnpm dev          # devstack up (vite on 5173, router on 5175)
pnpm test:e2e     # Playwright: mint → transfer
```

## See also

- [examples/README.md](../README.md) — every runnable example.
- [Coins and funding](https://ts-sdks-incubation.vercel.app/devstack/features/coins-and-funding) —
  managed-coin and funding-spec guidance the stack relies on.
