# Arena

On-chain Connect Four. Demonstrates matchmaking via a shared `Lobby`
object, gameplay via a shared `Game` object, and surfacing the seeded
lobby's id through the devstack manifest's `extras` slot so the
frontend can join on first boot.

```
arena/
├── devstack.config.ts        # sui-localnet + publish + seed Lobby + wallet-app + vite
├── move/connect_four/        # Move package: Lobby + Game shared objects
├── e2e/connect-four.spec.ts  # alice joins via UI; alice+bob play to a row-0 horizontal win
└── src/                      # React UI: lobby join, board, winner banner
```

## Prerequisites

- Docker (for sui-localnet)
- Sui CLI (`sui` on `PATH`) for Move compilation
- Node >= 24, pnpm

## Run

```
pnpm dev          # devstack up: localnet + publish + seed lobby + wallet-app + vite (port 5176)
pnpm test:e2e     # full Playwright run against a fresh test stack
pnpm test:watch   # vitest in watch mode
```

The `e2e/connect-four.spec.ts` spec exercises the lobby→game transition
through the UI and submits the scripted plays via the JSON-RPC SDK to
keep the run fast.
