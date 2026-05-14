# Wallet

Multi-coin wallet UI plus a DeepBook v3 swap. Publishes two mock coins
(mUSDC + mWETH), seeds balances to alice/bob/carol, deploys DeepBook v3
from the vendored `.devstack/imports/...` source, and runs a continuous
in-process maker so swap cards see real on-chain liquidity.

```
wallet/
├── devstack.config.ts       # localnet + 2x mock coin publish + deepbook + market-maker + wallet-app + vite
├── move/mock_usdc + mock_weth/  # Move packages: managed coins with mint entry
├── e2e/
│   ├── panels.spec.ts       # dev-wallet drawer: faucet panel mints custom token
│   ├── send-sui.spec.ts     # alice sends SUI and mUSDC to bob; balances move
│   └── swap.spec.ts         # DeepBook v3 swap exercise against the live maker
└── src/                     # React UI: balances, send, swap cards
```

## Prerequisites

- Docker (for sui-localnet)
- Sui CLI (`sui` on `PATH`) for Move compilation
- Node >= 24, pnpm

## Run

```
pnpm dev          # devstack up: localnet + publishes + deepbook + maker + wallet-app + vite (port 5174)
pnpm test:e2e     # full Playwright run against a fresh test stack
pnpm test:watch   # vitest in watch mode
```

The three e2e specs run serially and exercise the dev-wallet panels,
native + non-SUI sends, and DeepBook swaps against alice's continuous
market-maker — all with no mocks.
