# Connect Four

On-chain Connect Four lobby, join, and move flow over sui-localnet.
Demonstrates managed accounts, a published Move package, an
`action(...)` member that opens the lobby after publish, and dev-wallet
signing for two players (alice + bob).

```
connect-four/
├── devstack.config.ts    # sui-localnet + connect_four package + openLobby action + wallet + vite
├── move/connect_four/    # Move package: game, lobby, and move logic
├── e2e/                  # Playwright: two-account match
└── src/                  # React UI: lobby + game board
```

## Run

```
pnpm dev          # devstack up (vite on port 5176, router on 5175)
pnpm test:e2e     # Playwright: open lobby, two players, complete a game
```

## See also

- [examples/README.md](../README.md) — every runnable example.
- [Actions feature page](https://ts-sdks-incubation.vercel.app/devstack/features/actions) —
  background on the post-publish action wired into this stack.
