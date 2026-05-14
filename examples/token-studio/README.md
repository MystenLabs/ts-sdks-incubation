# Token studio

A single managed coin with TreasuryCap-gated minting. Alice doubles as
publisher (holds the TreasuryCap so the UI's "TreasuryCap holder" badge
resolves) and the publish registers the coin into the devstack
manifest's coin namespace automatically.

```
token-studio/
├── devstack.config.ts       # sui-localnet + publish managed_coin + wallet-app + vite
├── move/managed_coin/       # Move package: one-time-witness coin + mint entry
├── e2e/create-coin.spec.ts  # alice mints STUDIO to bob; digest surfaces in UI
└── src/                     # React UI: mint card, balances, digest readout
```

## Prerequisites

- Docker (for sui-localnet)
- Sui CLI (`sui` on `PATH`) for Move compilation
- Node >= 24, pnpm

## Run

```
pnpm dev          # devstack up: localnet + publish + wallet-app + vite (port 5173)
pnpm test:e2e     # full Playwright run against a fresh test stack
pnpm test:watch   # vitest in watch mode
```

The `e2e/create-coin.spec.ts` spec is the happy-path: alice (TreasuryCap
holder) mints STUDIO to bob and the resulting digest appears in the UI.
No mocks — real Vite, real localnet, real wallet-standard adapter.
